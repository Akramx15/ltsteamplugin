"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const pluginRoot = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(
    path.join(pluginRoot, ".millennium", "Dist", "index.js"),
    "utf8",
);
const publicSource = fs.readFileSync(
    path.join(pluginRoot, "public", "luatools.js"),
    "utf8",
);

const versionBridgeMarker =
    "// Bridge version discovery and official branch switching";
const downgradeBridgeMarker =
    "// SharedJSContext bridge for the downgrade backend.";
const versionBridgeStart = indexSource.indexOf(versionBridgeMarker);
const versionBridgeEnd = indexSource.indexOf(
    downgradeBridgeMarker,
    versionBridgeStart,
);
assert.ok(versionBridgeStart >= 0, "version bridge marker is missing");
assert.ok(
    versionBridgeEnd > versionBridgeStart,
    "version bridge end marker is missing",
);
const versionBridgeSource = indexSource.slice(
    versionBridgeStart,
    versionBridgeEnd,
);

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function createBridgeHarness({ hangCachedDetails = false, nativeWarmup = false } = {}) {
    let messageHandler = null;
    let messageRegistrations = 0;
    let appDetailsFallbacks = 0;
    let appDetailsUnregisters = 0;
    const responses = [];
    const joins = [];

    const details = {
        unAppID: 480,
        nBuildID: 300,
        strSelectedBeta: "public",
        vecBetas: [
            {
                strName: "public",
                strDescription: "Default branch",
                nBuildID: 300,
                rtLastUpdated: 1700000000,
            },
            {
                strName: "legacy",
                strDescription: "Old release",
                nBuildID: 200,
                rtLastUpdated: 1600000000,
            },
        ],
    };

    const sandbox = {
        JSON,
        Map,
        Number,
        Promise,
        Set,
        String,
        clearTimeout,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        appDetailsStore: {
            async RequestAppDetails() {
                if (hangCachedDetails) {
                    return await new Promise(() => {});
                }
                // A missing cache result must fall through to Steam's native
                // subscription instead of making the catalog unavailable.
                return null;
            },
        },
        MainWindowBrowserManager: {
            m_browser: {
                on(name, callback) {
                    assert.equal(name, "message");
                    messageRegistrations += 1;
                    messageHandler = callback;
                },
                PostMessage(channel, data) {
                    responses.push({ channel, payload: JSON.parse(data) });
                },
            },
        },
        SteamClient: {
            Apps: {
                RegisterForAppDetails(appid, callback) {
                    assert.equal(appid, 480);
                    appDetailsFallbacks += 1;
                    if (nativeWarmup) callback(null);
                    Promise.resolve().then(() => callback(details));
                    return {
                        unregister() {
                            appDetailsUnregisters += 1;
                        },
                    };
                },
                JoinAppContentBeta(appid, branch) {
                    joins.push({ appid, branch });
                },
            },
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    return {
        sandbox,
        responses,
        joins,
        get messageHandler() { return messageHandler; },
        get messageRegistrations() { return messageRegistrations; },
        get appDetailsFallbacks() { return appDetailsFallbacks; },
        get appDetailsUnregisters() { return appDetailsUnregisters; },
    };
}

async function testCatalogAndJoinAllowlist() {
    const harness = createBridgeHarness();
    vm.runInContext(versionBridgeSource, harness.sandbox, {
        filename: "downgrade-version-bridge.js",
    });
    assert.equal(harness.messageRegistrations, 1);

    // Hot reloads must not register a second listener, which could otherwise
    // send duplicate responses and switch a branch twice.
    vm.runInContext(versionBridgeSource, harness.sandbox, {
        filename: "downgrade-version-bridge-reload.js",
    });
    assert.equal(harness.messageRegistrations, 1);

    const channel = "Akram.Downgrade.Versions.v1";
    await harness.messageHandler(channel, JSON.stringify({
        type: "get_catalog",
        requestId: "catalog-1",
        appid: "480",
    }));

    assert.equal(harness.appDetailsFallbacks, 1);
    const catalog = harness.responses.at(-1);
    assert.equal(catalog.channel, channel);
    assert.equal(catalog.payload.success, true);
    assert.equal(catalog.payload.selectedBranch, "");
    assert.deepEqual(
        plain(catalog.payload.branches.map((branch) => ({
            branch: branch.branch,
            selected: branch.selected,
            buildId: branch.buildId,
        }))),
        [
            { branch: "", selected: true, buildId: "300" },
            { branch: "legacy", selected: false, buildId: "200" },
        ],
    );

    await harness.messageHandler(channel, JSON.stringify({
        type: "join_branch",
        requestId: "join-allowed",
        appid: "480",
        branch: "legacy",
    }));
    assert.deepEqual(plain(harness.joins), [{ appid: 480, branch: "legacy" }]);
    assert.equal(harness.responses.at(-1).payload.success, true);

    await harness.messageHandler(channel, JSON.stringify({
        type: "join_branch",
        requestId: "join-hidden",
        appid: "480",
        branch: "hidden",
    }));
    assert.equal(harness.joins.length, 1);
    assert.equal(
        harness.responses.at(-1).payload.error,
        "branch_not_available",
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(harness.appDetailsUnregisters, 1);
}

async function testNativeDetailsDoNotWaitForHungCache() {
    const harness = createBridgeHarness({
        hangCachedDetails: true,
        nativeWarmup: true,
    });
    vm.runInContext(versionBridgeSource, harness.sandbox, {
        filename: "downgrade-version-bridge-concurrent.js",
    });
    await harness.messageHandler(
        "Akram.Downgrade.Versions.v1",
        JSON.stringify({
            type: "get_catalog",
            requestId: "catalog-hung-cache",
            appid: "480",
        }),
    );
    assert.equal(harness.responses.at(-1).payload.success, true);
    assert.equal(harness.appDetailsFallbacks, 1);
}

function testCurrentBranchIsFilteredFromPicker() {
    const renderMarker = "    function formatVersionDate(";
    const loadMarker = "    function loadVersionCatalog(";
    const renderStart = publicSource.indexOf(renderMarker);
    const renderEnd = publicSource.indexOf(loadMarker, renderStart);
    assert.ok(renderStart >= 0, "version catalog renderer is missing");
    assert.ok(renderEnd > renderStart, "version catalog renderer end is missing");
    const renderSource = publicSource.slice(renderStart, renderEnd);

    const sandbox = { JSON };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`
        (() => {
          let versionEntries = [];
          let selectedVersion = null;
          let versionCatalogStatus = null;
          let formLocked = false;
          let manualMode = true;
          let active = false;
          let localCatalogPayload = null;
          let steamCatalogPayload = null;
          const options = [];
          const versionSelect = {
            value: "",
            disabled: true,
            set innerHTML(value) { options.length = 0; },
            appendChild(option) { options.push(option); },
          };
          const document = { createElement() { return {}; } };
          const window = {};
          const providerStatus = { textContent: "" };
          const appliedBanner = { style: {}, textContent: "" };
          function t(key, fallback) { return fallback; }
          ${renderSource}
          globalThis.pickerHarness = {
            render(local, steam) {
              localCatalogPayload = local;
              steamCatalogPayload = steam;
              renderVersionCatalog(local, steam);
            },
            snapshot() {
              return {
                entries: versionEntries,
                selectedVersion,
                options,
                appliedBanner,
              };
            },
          };
        })();
    `, sandbox, { filename: "downgrade-version-picker.js" });

    sandbox.pickerHarness.render(
        {
            success: true,
            versions: [{
                id: "saved-100",
                buildId: "100",
                timestamp: "2025-01-01 00:00:00",
                depots: [{ depotId: "481", manifestId: "123" }],
            }],
        },
        {
            success: true,
            branches: [
                { branch: "", selected: true, buildId: "300" },
                { branch: "legacy", selected: false, buildId: "200" },
            ],
        },
    );

    const snapshot = plain(sandbox.pickerHarness.snapshot());
    assert.deepEqual(
        snapshot.entries.map((entry) => entry.kind + ":" + (entry.branch || entry.id)),
        ["steam_branch:legacy", "candidate:saved-100"],
        "the currently selected Steam branch appeared as a downgrade choice",
    );
    assert.equal(snapshot.options.length, 2);

    sandbox.pickerHarness.render(
        {
            success: true,
            candidates: [{
                candidateId: "archive-90",
                buildId: "90",
                source: "steamdb",
                depots: [{ depotId: "481", manifestId: "122" }],
                compatibility: { status: "incomplete", reasons: ["topology"] },
            }],
            providers: [{ id: "steamdb", status: "ready" }],
        },
        { success: false, branches: [] },
    );
    const candidateSnapshot = plain(sandbox.pickerHarness.snapshot());
    assert.equal(candidateSnapshot.entries.length, 1);
    assert.equal(candidateSnapshot.entries[0].candidateId, "archive-90");
    assert.equal(candidateSnapshot.entries[0].compatibilityStatus, "incomplete");

    sandbox.pickerHarness.render(
        {
            success: true,
            candidates: [],
            applied: {
                candidateId: "remembered-80",
                buildId: "80",
                timestamp: "1700000000",
                source: "cache",
                depots: [{ depotId: "481", manifestId: "121" }],
                mode: "verified",
                drifted: true,
                canReapply: true,
            },
        },
        { success: false, branches: [] },
    );
    const reapplySnapshot = plain(sandbox.pickerHarness.snapshot());
    assert.equal(reapplySnapshot.entries.length, 1);
    assert.equal(reapplySnapshot.entries[0].reapply, true);
    assert.equal(reapplySnapshot.entries[0].compatibilityStatus, "verified");
    assert.equal(reapplySnapshot.appliedBanner.style.display, "block");
}

async function testCatalogSourcesRenderIndependently() {
    const loadMarker = "    function loadVersionCatalog(";
    const nextMarker = "    function updateRowControls(";
    const loadStart = publicSource.indexOf(loadMarker);
    const loadEnd = publicSource.indexOf(nextMarker, loadStart);
    assert.ok(loadStart >= 0, "version catalog loader is missing");
    assert.ok(loadEnd > loadStart, "version catalog loader end is missing");
    const loadSource = publicSource.slice(loadStart, loadEnd);

    let resolveBackend;
    let resolveSteam;
    const backendPromise = new Promise((resolve) => { resolveBackend = resolve; });
    const steamPromise = new Promise((resolve) => { resolveSteam = resolve; });
    const renders = [];
    const sandbox = { Promise, String, setTimeout };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`
      (() => {
        const appid = "480";
        const overlay = { isConnected: true };
        let localCatalogPayload = null;
        let steamCatalogPayload = null;
        let catalogPollCount = 0;
        let catalogTimer = null;
        function callDowngradeRpc() { return globalThis.backendPromise; }
        function getSteamDowngradeBranches() { return globalThis.steamPromise; }
        function renderProviderStatus() {}
        function providerState(provider) { return provider.status || "ready"; }
        function renderVersionCatalog(local, steam) {
          globalThis.renders.push({ local, steam });
        }
        ${loadSource}
        globalThis.runLoader = loadVersionCatalog;
      })();
    `, Object.assign(sandbox, {
        backendPromise,
        steamPromise,
        renders,
    }), { filename: "downgrade-independent-catalog-loader.js" });

    sandbox.runLoader();
    resolveSteam({ success: true, branches: [{ branch: "legacy" }] });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(renders.length, 1, "Steam branches waited for the backend archive");
    assert.equal(renders[0].local, null);
    assert.equal(renders[0].steam.success, true);

    resolveBackend({ success: true, candidates: [] });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(renders.length, 2);
    assert.equal(renders[1].local.success, true);
}

function testStartContractIsBackwardCompatible() {
    assert.match(publicSource, /candidateId:\s*[\s\S]*?mode:\s*[\s\S]*?pin:\s*true/);
    assert.match(publicSource, /depots:\s*depots/);
    assert.match(publicSource, /type === "join_branch" \? 15000/);
    assert.match(publicSource, /payload\.activeJob \|\| payload\.activeState/);
    assert.match(publicSource, /GetDowngradeStatus", \{ appid: statusAppid \}/);

    const resumeMarker =
        "// Resume a live operation if the modal is reopened while the backend is busy.";
    const resumeStart = publicSource.indexOf(resumeMarker);
    const modalEnd = publicSource.indexOf(
        "function openDowngradeForCurrentGame()",
        resumeStart,
    );
    const resumeSource = publicSource.slice(resumeStart, modalEnd);
    assert.match(resumeSource, /DOWNGRADE_ACTIVE_STATUSES\.includes\(status\)/);
    assert.doesNotMatch(
        resumeSource,
        /DOWNGRADE_TERMINAL_STATUSES\.includes\(status\)[\s\S]*?renderState\(payload\)/,
        "an old completed operation still replaces the new version picker",
    );
}

function testGenericDowngradeButtonFallbackContract() {
    const ensureStart = publicSource.indexOf("function ensureDowngradeButton(");
    const fallbackStart = publicSource.indexOf(
        "function ensureStandaloneDowngradeButton()",
        ensureStart,
    );
    const resourcesStart = publicSource.indexOf(
        "function ensureAkramResourceButtons(",
        fallbackStart,
    );
    assert.ok(ensureStart >= 0, "downgrade button guard is missing");
    assert.ok(fallbackStart > ensureStart, "generic downgrade fallback is missing");
    assert.ok(resourcesStart > fallbackStart, "fallback function boundary is missing");

    const ensureSource = publicSource.slice(ensureStart, fallbackStart);
    const fallbackSource = publicSource.slice(fallbackStart, resourcesStart);
    assert.ok(
        ensureSource.indexOf("getDowngradeInstallInfo(appid, false)") <
            ensureSource.indexOf("container.appendChild(currentButton)"),
        "downgrade button can be inserted before the install check",
    );
    assert.match(ensureSource, /!installInfo\.installed/);
    assert.match(fallbackSource, /getCurrentDowngradeAppId\(\)/);
    assert.match(fallbackSource, /querySelector\("#queueBtnFollow"\)/);
    assert.match(fallbackSource, /document\.body\.appendChild\(fallback\)/);
    assert.match(fallbackSource, /ensureDowngradeButton\(fallback, null\)/);
    assert.match(
        publicSource,
        /else \{\s*ensureStandaloneDowngradeButton\(\);\s*if \(!logState\.missingOnce\)/,
        "missing resource containers do not activate the downgrade fallback",
    );
    assert.match(
        publicSource,
        /setTimeout\(addLuaToolsButton, BUTTON_CHECK_THROTTLE \+ 100\)/,
        "SPA navigation can lose the button inside the insertion throttle",
    );
    assert.match(
        publicSource,
        /setTimeout\(addLuaToolsButton, 1800\)/,
        "SPA navigation lacks a delayed DOM replacement retry",
    );
    assert.match(
        publicSource,
        /function repairMissingAppPageButtons\(\)[\s\S]*?getCurrentDowngradeAppId\(\)[\s\S]*?!button\.isConnected[\s\S]*?button\.dataset\.appid !== String\(appid\)[\s\S]*?addLuaToolsButton\(\)/,
        "app-page document replacement lacks a generic button presence repair",
    );
    assert.match(
        publicSource,
        /setInterval\(repairMissingAppPageButtons, BUTTON_PLACEMENT_WATCHDOG_MS\)/,
        "generic button presence repair is not scheduled",
    );

    const openAppStart = publicSource.indexOf("function openDowngradeForApp(");
    const openAppEnd = publicSource.indexOf(
        "function showInstalledGamePicker()",
        openAppStart,
    );
    const openAppSource = publicSource.slice(openAppStart, openAppEnd);
    assert.match(
        openAppSource,
        /getDowngradeInstallInfo\(normalizedAppid, false\)/,
        "opening the picker repeats the native install lookup instead of reusing button-gating state",
    );
    assert.doesNotMatch(openAppSource, /getDowngradeInstallInfo\(normalizedAppid, true\)/);
    const currentOpenStart = publicSource.indexOf("function openDowngradeForCurrentGame()");
    const currentOpenEnd = publicSource.indexOf(
        "const DOWNGRADE_FALLBACK_CONTAINER_ID",
        currentOpenStart,
    );
    const currentOpenSource = publicSource.slice(currentOpenStart, currentOpenEnd);
    assert.match(
        currentOpenSource,
        /openDowngradeForApp\(appid\)/,
        "the current app-page shortcut bypasses the generic app opener",
    );
    assert.match(
        publicSource,
        /if \(!forceRefresh && cached\) \{\s*return cached\.promise;/,
        "document-scoped install state is not reused",
    );
}

function testUnavailableWebkitVersionBridgeIsOptional() {
    const stateStart = publicSource.indexOf(
        "const downgradeVersionBridge =",
    );
    const ensureStart = publicSource.indexOf(
        "function ensureDowngradeVersionBridge()",
    );
    const ensureEnd = publicSource.indexOf(
        "function callDowngradeVersionBridge(",
        ensureStart,
    );
    assert.ok(ensureStart >= 0 && ensureEnd > ensureStart);
    const ensureSource = publicSource.slice(ensureStart, ensureEnd);
    assert.match(
        ensureSource,
        /try \{[\s\S]*?browserView\.RegisterForMessageFromParent\([\s\S]*?catch \(error\) \{[\s\S]*?return false;/,
        "a native Unknown method error can still abort the downgrade picker",
    );
    assert.match(
        ensureSource,
        /Steam version bridge registration unavailable/,
    );

    const messages = [];
    const sandbox = {
        SteamClient: {
            BrowserView: {
                RegisterForMessageFromParent() {
                    throw new Error("Unknown method");
                },
                PostMessageToParent() {},
            },
        },
        backendLog(message) { messages.push(String(message)); },
        clearTimeout,
        Date,
        JSON,
        Object,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    const bridgeBootstrapSource = publicSource.slice(stateStart, ensureEnd);
    vm.runInContext(
        `const DOWNGRADE_VERSION_BRIDGE_CHANNEL = "Akram.Downgrade.Versions.v1";\n` +
            bridgeBootstrapSource +
            "\nglobalThis.bridgeAvailable = ensureDowngradeVersionBridge();",
        sandbox,
        { filename: "webkit-version-bridge-unavailable.js" },
    );
    assert.equal(sandbox.bridgeAvailable, false);
    assert.match(messages.join("\n"), /Unknown method/);
}

(async () => {
    await testCatalogAndJoinAllowlist();
    await testNativeDetailsDoNotWaitForHungCache();
    testCurrentBranchIsFilteredFromPicker();
    await testCatalogSourcesRenderIndependently();
    testStartContractIsBackwardCompatible();
    testGenericDowngradeButtonFallbackContract();
    testUnavailableWebkitVersionBridgeIsOptional();
    process.stdout.write("downgrade version bridge tests passed\n");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
