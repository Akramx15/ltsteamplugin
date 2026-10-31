"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const webkitPath = path.join(root, ".millennium", "Dist", "webkit.js");
const publicPath = path.join(root, "public", "luatools.js");
const source = fs.readFileSync(webkitPath, "utf8");
const publicSource = fs.readFileSync(publicPath, "utf8").replace(/[\r\n]+$/, "");
const marker = "/* Embedded standalone LuaTools UI. */";
const wrapper = "(() => {";

function count(haystack, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    total += 1;
    offset += needle.length;
  }
  return total;
}

assert.strictEqual(count(source, marker), 1, "standalone marker must occur once");
assert.strictEqual(
  count(source, publicSource),
  1,
  "the exact public UI source must occur once",
);

const markerIndex = source.indexOf(marker);
const wrapperIndex = source.indexOf(wrapper, markerIndex + marker.length);
assert(markerIndex >= 0 && wrapperIndex > markerIndex, "standalone wrapper missing");

const prefix = source.slice(0, wrapperIndex);
for (const token of [
  "steam-db",
  "RegisterForMessageFromParent",
  "ExecutePluginModule",
]) {
  assert(!prefix.includes(token), `foreign executable prefix contains ${token}`);
}

function runFreshDocumentProbe() {
  const probe =
    'globalThis.__luatoolsBootProbe = (globalThis.__luatoolsBootProbe || 0) + 1; throw new Error("__LUATOOLS_BOOT_PROBE__");';
  const insertionPoint = wrapperIndex + wrapper.length;
  const instrumented =
    source.slice(0, insertionPoint) + probe + source.slice(insertionPoint);
  const context = {
    console: { log() {}, warn() {}, error() {} },
    Millennium: { callServerMethod: () => Promise.resolve({ returnValue: false }) },
    MILLENNIUM_API: { callable: () => () => undefined },
    MILLENNIUM_BACKEND_IPC: {
      postMessage: () => Promise.resolve({ returnValue: false }),
    },
    SteamClient: {
      BrowserView: {
        RegisterForMessageFromParent() {
          throw new Error("Unknown method");
        },
        PostMessageToParent() {},
      },
    },
  };
  context.window = context;

  assert.throws(
    () => vm.runInNewContext(instrumented, context),
    /__LUATOOLS_BOOT_PROBE__/,
    "LuaTools must start before any foreign bridge can abort the document",
  );
  assert.strictEqual(context.__luatoolsBootProbe, 1);
}

// Steam destroys the old JavaScript realm on a full app-page navigation.  Test
// two independent documents so the regression cannot be hidden by SPA timers.
runFreshDocumentProbe();
runFreshDocumentProbe();

console.log("webkit standalone bootstrap: PASS (2 fresh documents)");
