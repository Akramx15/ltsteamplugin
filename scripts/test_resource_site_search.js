"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const publicSource = fs.readFileSync(
  path.join(root, "public", "luatools.js"),
  "utf8",
);
const start = publicSource.indexOf("function getCurrentSteamResourceAppId()");
const end = publicSource.indexOf(
  "const POST_ADD_INSTALL_CHANNEL",
  start,
);
assert.ok(start >= 0 && end > start, "resource search helpers missing");
const helperSource = publicSource.slice(start, end);

const buttonStart = publicSource.indexOf("const resources = [");
const buttonEnd = publicSource.indexOf(
  "let steamDbButton",
  buttonStart,
);
const buttonSource = publicSource.slice(buttonStart, buttonEnd);
assert.match(buttonSource, /getCurrentSteamResourceAppId\(\)/);
assert.match(buttonSource, /getCurrentSteamResourceName\(\)/);
assert.doesNotMatch(buttonSource, /openAkramResourceSite\(resource\.site,\s*0\)/);

function createHarness(officialName) {
  const calls = [];
  const alerts = [];
  const sandbox = {
    INTERNAL_PLUGIN_ID: "luatools",
    JSON,
    Number,
    Promise,
    String,
    URLSearchParams,
    parseInt,
    backendLog() {},
    getDisplayBrand() {
      return "Akram's";
    },
    ShowLuaToolsAlert(title, message) {
      alerts.push({ title, message });
    },
    fetchSteamGameName() {
      return Promise.resolve(officialName);
    },
    document: {
      querySelector(selector) {
        if (selector === ".apphub_AppName") {
          return {
            textContent: "Page Fallback",
            getAttribute() {
              return null;
            },
          };
        }
        return null;
      },
    },
    Millennium: {
      callServerMethod(plugin, method, args) {
        calls.push({ plugin, method, args });
        return Promise.resolve(JSON.stringify({ success: true }));
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.location = {
    href: "https://store.steampowered.com/app/424242/Generated_Game/",
  };
  vm.createContext(sandbox);
  vm.runInContext(helperSource, sandbox, { filename: "resource-search.js" });
  return { alerts, calls, sandbox };
}

async function testOnlineFixUsesOfficialNormalizedName() {
  const harness = createHarness("No Man's Sky ™");
  assert.equal(harness.sandbox.getCurrentSteamResourceAppId(), 424242);
  assert.equal(harness.sandbox.getCurrentSteamResourceName(), "Page Fallback");
  assert.equal(
    await harness.sandbox.openAkramResourceSite(
      "online-fix",
      424242,
      "Page Fallback",
    ),
    true,
  );
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].method, "OpenExternalUrl");
  const url = new URL(harness.calls[0].args.url);
  assert.equal(url.origin, "https://online-fix.me");
  assert.equal(url.pathname, "/index.php");
  assert.equal(url.searchParams.get("do"), "search");
  assert.equal(url.searchParams.get("subaction"), "search");
  assert.equal(url.searchParams.get("story"), "No Mans Sky");
}

async function testGame3rbEncodesUnicodeAndReservedCharacters() {
  const harness = createHarness("لعبة & Friends / 100%");
  await harness.sandbox.openAkramResourceSite("game3rb", 424242, "fallback");
  const url = new URL(harness.calls[0].args.url);
  assert.equal(url.origin, "https://game3rb.com");
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("s"), "لعبة & Friends / 100%");
  assert.ok(harness.calls[0].args.url.includes("%26"));
  assert.ok(harness.calls[0].args.url.includes("%2F"));
  assert.ok(harness.calls[0].args.url.includes("%25"));
}

async function testSteamDbKeepsStrictAppIdRoute() {
  const harness = createHarness("Ignored");
  await harness.sandbox.openAkramResourceSite("steamdb", 424242);
  assert.equal(harness.calls[0].method, "OpenResourceSite");
  assert.equal(harness.calls[0].args.appid, 424242);
  assert.equal(harness.calls[0].args.site, "steamdb");
}

Promise.resolve()
  .then(testOnlineFixUsesOfficialNormalizedName)
  .then(testGame3rbEncodesUnicodeAndReservedCharacters)
  .then(testSteamDbKeepsStrictAppIdRoute)
  .then(() => console.log("resource site search tests passed"));
