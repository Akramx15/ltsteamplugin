"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const publicSource = fs.readFileSync(path.join(root, "public", "luatools.js"), "utf8");
const steamUtilsSource = fs.readFileSync(
  path.join(root, "backend", "steam_utils.lua"),
  "utf8",
);
const mainSource = fs.readFileSync(path.join(root, "backend", "main.lua"), "utf8");

function between(start, end) {
  const startIndex = publicSource.indexOf(start);
  const endIndex = publicSource.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing ${start}`);
  assert.ok(endIndex > startIndex, `missing boundary ${end}`);
  return publicSource.slice(startIndex, endIndex);
}

const inventoryRpcSource = between(
  "function getInstalledSteamGames()",
  "function openDowngradeForApp(",
);
const openAppSource = between(
  "function openDowngradeForApp(",
  "function showInstalledGamePicker()",
);
const pickerSource = between(
  "function showInstalledGamePicker()",
  "function showDowngradeModal(",
);

assert.match(mainSource, /function GetInstalledSteamGames\(/);
assert.match(mainSource, /steam_utils\.list_installed_games/);
assert.match(steamUtilsSource, /function steam_utils\.list_installed_games\(/);
assert.match(steamUtilsSource, /fs\.list/);
assert.match(steamUtilsSource, /appmanifest_.*%d\+/);
assert.match(pickerSource, /getInstalledSteamGames\(\)/);
assert.match(pickerSource, /games = payload\.games\.slice\(\)/);
assert.match(pickerSource, /openDowngradeForApp\(String\(game\.appid \|\| game\.appId/);
assert.doesNotMatch(pickerSource, /games\s*=\s*\[\s*\{/);

for (const staleFixtureId of ["993090", "3003460", "570940", "4874400"]) {
  assert.ok(
    !inventoryRpcSource.includes(staleFixtureId) &&
      !openAppSource.includes(staleFixtureId) &&
      !pickerSource.includes(staleFixtureId) &&
      !steamUtilsSource.includes(staleFixtureId),
    `production picker contains a fixture/allowlist AppID: ${staleFixtureId}`,
  );
}

async function settle() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

async function testInventoryRpcIsDataDriven() {
  const generatedId = String(6100000 + (process.pid % 100000));
  let calledMethod = "";
  const sandbox = {
    Array,
    Error,
    JSON,
    Promise,
    callMillenniumWithTimeout(method, args) {
      calledMethod = method;
      assert.equal(args.contentScriptQuery, "");
      assert.deepEqual(Object.keys(args), ["contentScriptQuery"]);
      return Promise.resolve(
        JSON.stringify({
          success: true,
          games: [{ appid: generatedId, name: "Generated Fixture" }],
        }),
      );
    },
    parseDowngradeRpcPayload(value) {
      return typeof value === "string" ? JSON.parse(value) : value;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(inventoryRpcSource, sandbox, { filename: "inventory-rpc.js" });
  const result = await sandbox.getInstalledSteamGames();
  assert.equal(calledMethod, "GetInstalledSteamGames");
  assert.equal(result.games[0].appid, generatedId);
}

async function testSelectedAppIsForwardedUnchanged() {
  const generatedId = String(7200000 + (process.pid % 100000));
  let checkedAppid = null;
  let opened = null;
  const sandbox = {
    Error,
    Promise,
    String,
    ShowLuaToolsAlert() {
      throw new Error("unexpected alert");
    },
    backendLog() {},
    getDisplayBrand() {
      return "Akram's";
    },
    t(_key, fallback) {
      return fallback;
    },
    getDowngradeInstallInfo(appid) {
      checkedAppid = appid;
      return Promise.resolve({ installed: true, installPath: "X:/Steam/common/Game" });
    },
    showDowngradeModal(appid, installInfo) {
      opened = { appid, installInfo };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(openAppSource, sandbox, { filename: "open-selected-app.js" });
  sandbox.openDowngradeForApp(generatedId, {
    appid: generatedId,
    name: "Chosen Fixture",
    buildId: "1844674407370955161",
  });
  await settle();
  assert.equal(checkedAppid, generatedId);
  assert.equal(opened.appid, generatedId);
  assert.equal(opened.installInfo.gameName, "Chosen Fixture");
  assert.equal(opened.installInfo.buildId, "1844674407370955161");
}

Promise.resolve()
  .then(testInventoryRpcIsDataDriven)
  .then(testSelectedAppIsForwardedUnchanged)
  .then(() => console.log("installed game picker tests passed"));
