"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(
  path.join(root, ".millennium", "Dist", "index.js"),
  "utf8",
);
const publicSource = fs.readFileSync(
  path.join(root, "public", "luatools.js"),
  "utf8",
);

const bridgeStart = indexSource.indexOf(
  "// Open Steam's native install-location wizard after a store-page add finishes.",
);
const bridgeEnd = indexSource.indexOf(
  "// Bridge version discovery and official branch switching",
  bridgeStart,
);
assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart, "post-add bridge missing");
const bridgeSource = indexSource.slice(bridgeStart, bridgeEnd);

const pollingStart = publicSource.indexOf("function startPolling(appid, onFailedCallback)");
const pollingEnd = publicSource.indexOf(
  "// Also try after a delay to catch dynamically loaded content",
  pollingStart,
);
assert.ok(pollingStart >= 0 && pollingEnd > pollingStart, "polling source missing");
const pollingSource = publicSource.slice(pollingStart, pollingEnd);
assert.match(pollingSource, /let completionHandled = false;/);
assert.match(pollingSource, /if \(completionHandled\) return;/);
assert.match(pollingSource, /openSteamInstallDialog\(appid\);/);
assert.ok(
  pollingSource.indexOf("openSteamInstallDialog(appid);") >
    pollingSource.indexOf('if (st.status === "done")'),
  "install wizard must only be requested from the completed state",
);

function createHarness({ overviewAfter = 1, withWizard = true } = {}) {
  let now = 1000;
  let listener = null;
  let listenerCount = 0;
  let overviewCalls = 0;
  const calls = [];

  const sandbox = {
    JSON,
    Map,
    Number,
    Promise,
    Set,
    String,
    console: { log() {}, warn() {}, error() {} },
    Date: { now: () => now },
    setTimeout(callback, delay = 0) {
      now += Number(delay) || 0;
      Promise.resolve().then(callback);
      return now;
    },
    appStore: {
      GetAppOverviewByAppID(appid) {
        calls.push(["overview", appid]);
        overviewCalls += 1;
        return overviewCalls >= overviewAfter ? { appid } : null;
      },
    },
    MainWindowBrowserManager: {
      m_browser: {
        on(event, callback) {
          assert.equal(event, "message");
          listenerCount += 1;
          listener = callback;
        },
      },
    },
    SteamClient: {
      UI: {
        EnsureMainWindowCreated() {
          calls.push(["main-window"]);
        },
      },
      URL: {
        ExecuteSteamURL(url) {
          calls.push(["url", url]);
        },
      },
      Installs: withWizard
        ? {
            OpenInstallWizard(appids) {
              calls.push(["wizard", Array.from(appids)]);
            },
          }
        : {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  async function settle() {
    for (let index = 0; index < 64; index += 1) await Promise.resolve();
  }

  async function start() {
    vm.runInContext(bridgeSource, sandbox, { filename: "post-add-bridge.js" });
    await settle();
    assert.equal(typeof listener, "function", "message listener was not registered");
  }

  async function send(appid, type = "open_install") {
    await listener(
      "Akram.PostAdd.Install.v1",
      JSON.stringify({ type, appid }),
    );
    await settle();
  }

  return {
    calls,
    sandbox,
    send,
    start,
    get listenerCount() {
      return listenerCount;
    },
  };
}

async function testNativeWizardOrderAndDeduplication() {
  const harness = createHarness({ overviewAfter: 3 });
  await harness.start();
  await harness.send("480");

  const actions = harness.calls.filter(([name]) => name !== "overview");
  assert.deepEqual(actions, [
    ["main-window"],
    ["url", "steam://nav/games/details/480"],
    ["wizard", [480]],
  ]);
  assert.equal(
    harness.calls.filter(([name]) => name === "overview").length,
    3,
    "bridge must wait until the app appears in Steam's library model",
  );

  await harness.send("480");
  assert.equal(
    harness.calls.filter(([name]) => name === "wizard").length,
    1,
    "duplicate completion must not open a second wizard",
  );

  await harness.send("480/evil");
  assert.equal(harness.calls.filter(([name]) => name === "wizard").length, 1);

  vm.runInContext(bridgeSource, harness.sandbox, { filename: "post-add-reinject.js" });
  assert.equal(harness.listenerCount, 1, "same-document reinjection duplicated listener");
}

async function testProtocolFallback() {
  const harness = createHarness({ overviewAfter: 1, withWizard: false });
  await harness.start();
  await harness.send(570);
  assert.deepEqual(
    harness.calls.filter(([name]) => name === "url"),
    [
      ["url", "steam://nav/games/details/570"],
      ["url", "steam://install/570"],
    ],
  );
}

Promise.resolve()
  .then(testNativeWizardOrderAndDeduplication)
  .then(testProtocolFallback)
  .then(() => console.log("post-add install bridge tests passed"));
