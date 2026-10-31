const MILLENNIUM_IS_CLIENT_MODULE = true;
const pluginName = "luatools";
function InitializePlugins() {
    var _a, _b;
    /**
     * This function is called n times depending on n plugin count,
     * Create the plugin list if it wasn't already created
     */
    (_a = (window.PLUGIN_LIST || (window.PLUGIN_LIST = {})))[pluginName] || (_a[pluginName] = {});
    (_b = (window.MILLENNIUM_PLUGIN_SETTINGS_STORE || (window.MILLENNIUM_PLUGIN_SETTINGS_STORE = {})))[pluginName] || (_b[pluginName] = {});
    /**
     * Accepted IPC message types from Millennium backend.
     */
    let IPCType;
    (function (IPCType) {
        IPCType[IPCType["CallServerMethod"] = 0] = "CallServerMethod";
    })(IPCType || (IPCType = {}));
    let MillenniumStore = window.MILLENNIUM_PLUGIN_SETTINGS_STORE[pluginName];
    let IPCMessageId = `Millennium.Internal.IPC.[${pluginName}]`;
    let isClientModule = MILLENNIUM_IS_CLIENT_MODULE;
    const ComponentTypeMap = {
        DropDown: ['string', 'number', 'boolean'],
        NumberTextInput: ['number'],
        StringTextInput: ['string'],
        FloatTextInput: ['number'],
        CheckBox: ['boolean'],
        NumberSlider: ['number'],
        FloatSlider: ['number'],
    };
    MillenniumStore.ignoreProxyFlag = false;
    function DelegateToBackend(pluginName, name, value) {
        console.log(`Delegating ${name} to backend`, value);
        // print stack trace
        const stack = new Error().stack?.split('\n').slice(2).join('\n');
        console.log(stack);
        return MILLENNIUM_BACKEND_IPC.postMessage(IPCType.CallServerMethod, {
            pluginName,
            methodName: '__builtins__.__update_settings_value__',
            argumentList: { name, value },
        });
    }
    async function ClientInitializeIPC() {
        /** Wait for the MainWindowBrowser to not be undefined */
        while (typeof MainWindowBrowserManager === 'undefined') {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        MainWindowBrowserManager.m_browser.on('message', (messageId, data) => {
            if (messageId !== IPCMessageId) {
                return;
            }
            const { name, value } = JSON.parse(data);
            MillenniumStore.ignoreProxyFlag = true;
            MillenniumStore.settingsStore[name] = value;
            DelegateToBackend(pluginName, name, value);
            MillenniumStore.ignoreProxyFlag = false;
        });
    }
    function WebkitInitializeIPC() {
        SteamClient.BrowserView.RegisterForMessageFromParent((messageId, data) => {
            if (messageId !== IPCMessageId) {
                return;
            }
            const payload = JSON.parse(data);
            MillenniumStore.ignoreProxyFlag = true;
            MillenniumStore.settingsStore[payload.name] = payload.value;
            MillenniumStore.ignoreProxyFlag = false;
        });
    }
    isClientModule ? ClientInitializeIPC() : WebkitInitializeIPC();
    const StartSettingPropagation = (name, value) => {
        if (MillenniumStore.ignoreProxyFlag) {
            return;
        }
        if (isClientModule) {
            DelegateToBackend(pluginName, name, value);
            /** If the browser doesn't exist yet, no use sending anything to it. */
            if (typeof MainWindowBrowserManager !== 'undefined') {
                MainWindowBrowserManager?.m_browser?.PostMessage(IPCMessageId, JSON.stringify({ name, value }));
            }
        }
        else {
            /** Send the message to the SharedJSContext */
            SteamClient.BrowserView.PostMessageToParent(IPCMessageId, JSON.stringify({ name, value }));
        }
    };
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
    const DefinePluginSetting = (obj) => {
        return new Proxy(obj, {
            set(target, property, value) {
                if (!(property in target)) {
                    throw new TypeError(`Property ${String(property)} does not exist on plugin settings`);
                }
                const settingType = ComponentTypeMap[target[property].type];
                const range = target[property]?.range;
                /** Clamp the value between the given range */
                if (settingType.includes('number') && typeof value === 'number') {
                    if (range) {
                        value = clamp(value, range[0], range[1]);
                    }
                    value || (value = 0); // Fallback to 0 if the value is undefined or null
                }
                /** Check if the value is of the proper type */
                if (!settingType.includes(typeof value)) {
                    throw new TypeError(`Expected ${settingType.join(' or ')}, got ${typeof value}`);
                }
                target[property].value = value;
                StartSettingPropagation(String(property), value);
                return true;
            },
            get(target, property) {
                if (property === '__raw_get_internals__') {
                    return target;
                }
                if (property in target) {
                    return target[property].value;
                }
                return undefined;
            },
        });
    };
    MillenniumStore.DefinePluginSetting = DefinePluginSetting;
    MillenniumStore.settingsStore = DefinePluginSetting({});
}
InitializePlugins()
const __call_server_method__ = (methodName, kwargs) => Millennium.callServerMethod(pluginName, methodName, kwargs)
const __wrapped_callable__ = (route) => MILLENNIUM_API.callable(__call_server_method__, route)
let PluginEntryPointMain = function() { var millennium_main=function(e){"use strict";return function(){const e={};try{if(process)return process.env=Object.assign({},process.env),void Object.assign(process.env,e)}catch(e){}globalThis.process={env:e}}(),e.default=async function(){},Object.defineProperty(e,"__esModule",{value:!0}),e}({});
 return millennium_main; };
function ExecutePluginModule() {
    let MillenniumStore = window.MILLENNIUM_PLUGIN_SETTINGS_STORE[pluginName];
    function OnPluginConfigChange(key, __, value) {
        if (key in MillenniumStore.settingsStore) {
            MillenniumStore.ignoreProxyFlag = true;
            MillenniumStore.settingsStore[key] = value;
            MillenniumStore.ignoreProxyFlag = false;
        }
    }
    /** Expose the OnPluginConfigChange so it can be called externally */
    MillenniumStore.OnPluginConfigChange = OnPluginConfigChange;
    MILLENNIUM_BACKEND_IPC.postMessage(0, { pluginName: pluginName, methodName: '__builtins__.__millennium_plugin_settings_parser__' }).then((response) => {
        /**
         * __millennium_plugin_settings_parser__ will return false if the plugin has no settings.
         * If the plugin has settings, it will return a base64 encoded string.
         * The string is then decoded and parsed into an object.
         */
        if (typeof response.returnValue === 'string') {
            MillenniumStore.ignoreProxyFlag = true;
            /** Initialize the settings store from the settings returned from the backend. */
            MillenniumStore.settingsStore = MillenniumStore.DefinePluginSetting(Object.fromEntries(JSON.parse(atob(response.returnValue)).map((item) => [item.functionName, item])));
            MillenniumStore.ignoreProxyFlag = false;
        }
        /** @ts-ignore: call the plugin main after the settings have been parsed. This prevent plugin settings from being undefined at top level. */
        let PluginModule = PluginEntryPointMain();
        /** Assign the plugin on plugin list. */
        Object.assign(window.PLUGIN_LIST[pluginName], {
            ...PluginModule,
            __millennium_internal_plugin_name_do_not_use_or_change__: pluginName,
        });
        /** Run the rolled up plugins default exported function */
        PluginModule.default();
        /** If the current module is a client module, post message id=1 which calls the front_end_loaded method on the backend. */
        if (MILLENNIUM_IS_CLIENT_MODULE) {
            MILLENNIUM_BACKEND_IPC.postMessage(1, { pluginName: pluginName });
        }
    });
}
ExecutePluginModule();

// Akram's local-save guard. The legacy webkit bundle runs inside store pages,
// where SteamClient is unavailable, so Cloud state is managed from this client
// module (SharedJSContext) using Steam's own per-app setting.
(() => {
    const CHECK_INTERVAL_MS = 15000;
    const DETAILS_TIMEOUT_MS = 4000;
    const processedAppIds = new Set();
    let checkInProgress = false;

    function parseBackendResponse(response) {
        if (typeof response === "string") {
            try {
                return JSON.parse(response);
            }
            catch (_) {
                return null;
            }
        }
        return response && typeof response === "object" ? response : null;
    }

    async function callBackend(methodName) {
        const response = await Millennium.callServerMethod(pluginName, methodName, {
            contentScriptQuery: "",
        });
        return parseBackendResponse(response);
    }

    async function requestAppDetails(appid) {
        if (globalThis.appDetailsStore?.RequestAppDetails) {
            try {
                return await Promise.race([
                    globalThis.appDetailsStore.RequestAppDetails(appid),
                    new Promise((resolve) => setTimeout(() => resolve(null), DETAILS_TIMEOUT_MS)),
                ]);
            }
            catch (_) {}
        }

        if (typeof SteamClient?.Apps?.RegisterForAppDetails !== "function") {
            return null;
        }

        return await new Promise((resolve) => {
            let subscription;
            let settled = false;
            const finish = (details) => {
                if (settled) return;
                settled = true;
                setTimeout(() => {
                    try {
                        subscription?.unregister?.();
                    }
                    catch (_) {}
                }, 0);
                resolve(details || null);
            };
            const timeout = setTimeout(() => finish(null), DETAILS_TIMEOUT_MS);
            try {
                subscription = SteamClient.Apps.RegisterForAppDetails(appid, (details) => {
                    clearTimeout(timeout);
                    finish(details);
                });
            }
            catch (_) {
                clearTimeout(timeout);
                finish(null);
            }
        });
    }

    async function localSavesEnabled() {
        try {
            const config = await callBackend("GetSettingsConfig");
            return config?.success === true && config?.values?.general?.localSavesOnly !== false;
        }
        catch (_) {
            return true;
        }
    }

    function waitForCloudDisabled(appid, timeoutMs = 6000) {
        return new Promise((resolve) => {
            let subscription;
            let settled = false;
            const finish = (disabled) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                setTimeout(() => {
                    try {
                        subscription?.unregister?.();
                    }
                    catch (_) {}
                }, 0);
                resolve(disabled);
            };
            const timeout = setTimeout(() => finish(false), timeoutMs);
            try {
                subscription = SteamClient.Apps.RegisterForAppDetails(appid, (details) => {
                    if (details?.bCloudEnabledForApp === false) finish(true);
                });
            }
            catch (_) {
                finish(false);
            }
        });
    }

    async function getAddedAppIds() {
        const payload = await callBackend("GetInstalledLuaScripts");
        if (!payload?.success || !Array.isArray(payload.scripts)) return [];
        return [...new Set(payload.scripts
            .filter((script) => script && script.isDisabled !== true)
            .map((script) => Number(script.appid))
            .filter((appid) => Number.isInteger(appid) && appid > 0))];
    }

    async function disableCloudForAddedGames() {
        if (checkInProgress) return;
        checkInProgress = true;
        try {
            if (!(await localSavesEnabled())) {
                processedAppIds.clear();
                return;
            }
            if (typeof SteamClient?.Apps?.ToggleAppSteamCloudEnabled !== "function") return;

            const appids = await getAddedAppIds();
            for (const appid of appids) {
                if (processedAppIds.has(appid)) continue;
                const details = await requestAppDetails(appid);
                if (!details) continue;

                if (details.bCloudAvailable !== true) {
                    // Retry later: newly added apps can report incomplete details briefly.
                    continue;
                }
                if (details.bCloudEnabledForApp !== true) {
                    processedAppIds.add(appid);
                    continue;
                }

                // This API is a toggle, not a setter. We only call it after a fresh
                // read proves that Cloud is currently enabled for this app.
                const confirmation = waitForCloudDisabled(appid);
                await Promise.resolve(SteamClient.Apps.ToggleAppSteamCloudEnabled(appid));
                let disabled = await confirmation;
                if (!disabled) {
                    const latest = await requestAppDetails(appid);
                    disabled = latest?.bCloudEnabledForApp === false;
                }
                if (disabled) {
                    processedAppIds.add(appid);
                    try {
                        await Millennium.callServerMethod(pluginName, "Logger.log", {
                            message: `Akram's: Steam Cloud confirmed disabled for added app ${appid}`,
                        });
                    }
                    catch (_) {}
                }
                await new Promise((resolve) => setTimeout(resolve, 350));
            }
        }
        catch (error) {
            console.warn("Akram's local-save guard failed", error);
        }
        finally {
            checkInProgress = false;
        }
    }

    setTimeout(disableCloudForAddedGames, 5000);
    setInterval(disableCloudForAddedGames, CHECK_INTERVAL_MS);
})();

// Open Steam's native install-location wizard after a store-page add finishes.
// The Lua backend completes as soon as the stplug-in file is written, while the
// Library model can refresh a little later, so this bridge waits for that model
// before navigating and opening the wizard.
(() => {
    "use strict";

    const BRIDGE_KEY = "__AKRAMS_POST_ADD_INSTALL_BRIDGE_V1__";
    if (globalThis[BRIDGE_KEY]?.started === true) return;

    const CHANNEL = "Akram.PostAdd.Install.v1";
    const LIBRARY_WAIT_MS = 12000;
    const LIBRARY_POLL_MS = 250;
    const RECENT_REQUEST_MS = 30000;
    const state = {
        started: true,
        inFlight: new Set(),
        recentlyHandled: new Map(),
        handleMessage: null,
    };
    globalThis[BRIDGE_KEY] = state;

    function validAppId(value) {
        const text = typeof value === "string" || typeof value === "number"
            ? String(value)
            : "";
        if (!/^[1-9][0-9]{0,9}$/.test(text)) return null;
        const numeric = Number(text);
        return Number.isSafeInteger(numeric) && numeric <= 4294967295
            ? { text, numeric }
            : null;
    }

    function delay(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    async function waitForLibraryApp(appid) {
        const deadline = Date.now() + LIBRARY_WAIT_MS;
        do {
            try {
                const overview = globalThis.appStore?.GetAppOverviewByAppID?.(appid);
                if (overview) return true;
            }
            catch (_) {}
            await delay(LIBRARY_POLL_MS);
        } while (Date.now() < deadline);
        return false;
    }

    async function executeSteamUrl(url) {
        if (typeof SteamClient?.URL?.ExecuteSteamURL !== "function") return false;
        try {
            await Promise.resolve(SteamClient.URL.ExecuteSteamURL(url));
            return true;
        }
        catch (_) {
            return false;
        }
    }

    async function openInstallWizard(appid) {
        await waitForLibraryApp(appid.numeric);

        try {
            if (typeof SteamClient?.UI?.EnsureMainWindowCreated === "function") {
                await Promise.resolve(SteamClient.UI.EnsureMainWindowCreated());
            }
        }
        catch (_) {}

        await executeSteamUrl("steam://nav/games/details/" + appid.text);
        await delay(150);

        if (typeof SteamClient?.Installs?.OpenInstallWizard === "function") {
            try {
                await Promise.resolve(
                    SteamClient.Installs.OpenInstallWizard([appid.numeric]),
                );
                return true;
            }
            catch (_) {}
        }

        return await executeSteamUrl("steam://install/" + appid.text);
    }

    async function handleMessage(messageId, rawData) {
        if (messageId !== CHANNEL) return;
        let request;
        try {
            request = JSON.parse(rawData);
        }
        catch (_) {
            return;
        }
        if (request?.type !== "open_install") return;
        const appid = validAppId(request.appid);
        if (!appid || state.inFlight.has(appid.text)) return;
        const lastHandled = state.recentlyHandled.get(appid.text) || 0;
        if (lastHandled > 0 && Date.now() - lastHandled < RECENT_REQUEST_MS) return;

        state.inFlight.add(appid.text);
        try {
            await openInstallWizard(appid);
        }
        catch (error) {
            console.warn("Akram's post-add install bridge failed", error);
        }
        finally {
            state.inFlight.delete(appid.text);
            state.recentlyHandled.set(appid.text, Date.now());
        }
    }

    (async () => {
        while (
            typeof MainWindowBrowserManager === "undefined" ||
            typeof MainWindowBrowserManager?.m_browser?.on !== "function"
        ) {
            await delay(50);
        }
        MainWindowBrowserManager.m_browser.on("message", handleMessage);
        state.handleMessage = handleMessage;
    })();
})();

// Bridge version discovery and official branch switching from Steam's
// SharedJSContext to the store/community WebKit view.  AppDetails is the same
// source used by Steam's Properties > Betas page, so only branches currently
// available to this signed-in account are exposed.
(() => {
    "use strict";

    const BRIDGE_KEY = "__AKRAMS_DOWNGRADE_VERSION_BRIDGE_V1__";
    if (globalThis[BRIDGE_KEY]?.started === true) return;

    const CHANNEL = "Akram.Downgrade.Versions.v1";
    // AppDetails can be served by either the SharedJS cache or Steam's native
    // subscription.  Start both at once: waiting for one and then the other
    // used to exceed the WebKit request deadline and silently lose valid beta
    // branches.  The WebKit side allows a little more than this total budget.
    const REQUEST_TIMEOUT_MS = 9000;
    const JOIN_TIMEOUT_MS = 4000;
    const discoveredBranches = new Map();
    const bridgeState = {
        started: true,
        discoveredBranches,
    };
    globalThis[BRIDGE_KEY] = bridgeState;

    function validRequestId(value) {
        const text = typeof value === "string" ? value : "";
        return /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : null;
    }

    function validAppId(value) {
        const text = typeof value === "string" || typeof value === "number"
            ? String(value)
            : "";
        if (!/^[1-9][0-9]{0,9}$/.test(text)) return null;
        const numeric = Number(text);
        return Number.isSafeInteger(numeric) && numeric <= 4294967295
            ? { text, numeric }
            : null;
    }

    function cleanText(value, maximumLength) {
        return String(value ?? "")
            .replace(/[\u0000-\u001F\u007F]/g, " ")
            .trim()
            .slice(0, maximumLength);
    }

    function cleanBuildId(value) {
        const text = typeof value === "number" && Number.isSafeInteger(value)
            ? String(value)
            : typeof value === "string"
                ? value.trim()
                : "";
        return /^[0-9]{1,10}$/.test(text) ? text : "";
    }

    function postToWebKit(message) {
        try {
            MainWindowBrowserManager?.m_browser?.PostMessage(
                CHANNEL,
                JSON.stringify(message),
            );
        }
        catch (_) {}
    }

    function requestCachedAppDetails(appid) {
        if (!globalThis.appDetailsStore?.RequestAppDetails) {
            return Promise.resolve(null);
        }
        return Promise.resolve()
            .then(() => globalThis.appDetailsStore.RequestAppDetails(appid))
            .then((details) => details || null)
            .catch(() => null);
    }

    function requestNativeAppDetails(appid) {
        if (typeof SteamClient?.Apps?.RegisterForAppDetails !== "function") {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            let subscription;
            let settled = false;
            const finish = (details) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                setTimeout(() => {
                    try {
                        subscription?.unregister?.();
                    }
                    catch (_) {}
                }, 0);
                resolve(details || null);
            };
            const timeout = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
            try {
                subscription = SteamClient.Apps.RegisterForAppDetails(
                    appid,
                    (details) => {
                        // Some Steam builds emit an empty warm-up callback
                        // before publishing the actual AppDetails object.
                        if (details) finish(details);
                    },
                );
            }
            catch (_) {
                finish(null);
            }
        });
    }

    async function requestAppDetails(appid) {
        const sources = [
            requestCachedAppDetails(appid),
            requestNativeAppDetails(appid),
        ];
        return await new Promise((resolve) => {
            let settled = false;
            let remaining = sources.length;
            const finish = (details) => {
                if (settled) return;
                if (details) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve(details);
                    return;
                }
                remaining -= 1;
                if (remaining <= 0) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve(null);
                }
            };
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve(null);
            }, REQUEST_TIMEOUT_MS);
            sources.forEach((source) => source.then(finish, () => finish(null)));
        });
    }

    function catalogFromDetails(appid, details) {
        const selectedName = cleanText(details?.strSelectedBeta, 128);
        const selectedBranch = selectedName.toLowerCase() === "public"
            ? ""
            : selectedName;
        const branches = [];
        const allowed = new Set();
        const rawBetas = Array.isArray(details?.vecBetas)
            ? details.vecBetas
            : [];

        for (let index = 0; index < rawBetas.length; index += 1) {
            const beta = rawBetas[index] || {};
            const rawName = cleanText(beta.strName, 128);
            const isPublic = index === 0 || rawName.toLowerCase() === "public";
            const branch = isPublic ? "" : rawName;
            if (!isPublic && !branch) continue;
            if (allowed.has(branch)) continue;
            allowed.add(branch);
            branches.push({
                branch,
                name: isPublic ? "public" : branch,
                description: cleanText(beta.strDescription, 512),
                buildId: cleanBuildId(beta.nBuildID ?? beta.unBuildID),
                updatedAt: cleanBuildId(beta.rtLastUpdated),
                selected: branch === selectedBranch,
                source: "steam_branch",
            });
        }

        // Steam normally places public first.  Keep a usable current entry on
        // clients which omit vecBetas when no opt-in beta exists.
        if (!allowed.has("")) {
            allowed.add("");
            branches.unshift({
                branch: "",
                name: "public",
                description: "",
                buildId: cleanBuildId(details?.nBuildID),
                updatedAt: "",
                selected: selectedBranch === "",
                source: "steam_branch",
            });
        }

        discoveredBranches.set(String(appid), allowed);
        return {
            success: true,
            appid: String(appid),
            currentBuildId: cleanBuildId(details?.nBuildID),
            selectedBranch,
            branches,
        };
    }

    async function discoverCatalog(appid) {
        const details = await requestAppDetails(appid.numeric);
        if (!details) {
            return {
                success: false,
                appid: appid.text,
                error: "steam_app_details_unavailable",
                branches: [],
            };
        }
        return catalogFromDetails(appid.text, details);
    }

    async function handleMessage(messageId, rawData) {
        if (messageId !== CHANNEL) return;
        let request;
        try {
            request = JSON.parse(rawData);
        }
        catch (_) {
            return;
        }
        const requestId = validRequestId(request?.requestId);
        const appid = validAppId(request?.appid);
        if (!requestId || !appid) return;

        if (request.type === "get_catalog") {
            const result = await discoverCatalog(appid);
            postToWebKit({
                type: "catalog_result",
                requestId,
                ...result,
            });
            return;
        }

        if (request.type !== "join_branch") return;
        const branch = typeof request.branch === "string"
            ? cleanText(request.branch, 128)
            : null;
        if (branch === null) return;

        let allowed = discoveredBranches.get(appid.text);
        if (!allowed) {
            const result = await discoverCatalog(appid);
            if (!result.success) {
                postToWebKit({
                    type: "join_result",
                    requestId,
                    success: false,
                    appid: appid.text,
                    error: result.error,
                });
                return;
            }
            allowed = discoveredBranches.get(appid.text);
        }
        if (!allowed?.has(branch)) {
            postToWebKit({
                type: "join_result",
                requestId,
                success: false,
                appid: appid.text,
                error: "branch_not_available",
            });
            return;
        }
        if (typeof SteamClient?.Apps?.JoinAppContentBeta !== "function") {
            postToWebKit({
                type: "join_result",
                requestId,
                success: false,
                appid: appid.text,
                error: "join_beta_unavailable",
            });
            return;
        }

        try {
            let joinTimeout = null;
            const joinResult = await Promise.race([
                Promise.resolve(
                    SteamClient.Apps.JoinAppContentBeta(appid.numeric, branch),
                ).then(() => "joined", () => "failed"),
                new Promise((resolve) => {
                    joinTimeout = setTimeout(
                        () => resolve("timeout"),
                        JOIN_TIMEOUT_MS,
                    );
                }),
            ]);
            if (joinTimeout !== null) clearTimeout(joinTimeout);
            if (joinResult !== "joined") {
                postToWebKit({
                    type: "join_result",
                    requestId,
                    success: false,
                    appid: appid.text,
                    error: joinResult === "timeout"
                        ? "join_beta_timeout"
                        : "join_beta_failed",
                });
                return;
            }
            postToWebKit({
                type: "join_result",
                requestId,
                success: true,
                appid: appid.text,
                branch,
            });
        }
        catch (_) {
            postToWebKit({
                type: "join_result",
                requestId,
                success: false,
                appid: appid.text,
                error: "join_beta_failed",
            });
        }
    }

    (async () => {
        while (
            typeof MainWindowBrowserManager === "undefined" ||
            typeof MainWindowBrowserManager?.m_browser?.on !== "function"
        ) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        MainWindowBrowserManager.m_browser.on("message", handleMessage);
        bridgeState.handleMessage = handleMessage;
    })();
})();

// SharedJSContext bridge for the downgrade backend. This stays intentionally
// small: the backend owns the queue/state machine while Steam executes the
// built-in console command in the user's already authenticated client session.
(() => {
    "use strict";

    const BRIDGE_KEY = "__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__";
    const existingBridge = globalThis[BRIDGE_KEY];
    if (existingBridge?.started === true) return;

    const POLL_INTERVAL_MS = 1200;
    const MAX_POLL_BACKOFF_MS = 15000;
    const FLUSH_INTERVAL_MS = 250;
    const MAX_BATCH_LINES = 64;
    const MAX_BUFFERED_LINES = 512;
    const MAX_REMEMBERED_ACTIONS = 256;
    const REPORT_RETRY_MIN_MS = 350;
    const REPORT_RETRY_MAX_MS = 10000;
    const BACKEND_CALL_TIMEOUT_MS = 8000;
    const UINT32_MAX = 4294967295n;
    const UINT64_MAX = 18446744073709551615n;

    const state = existingBridge && typeof existingBridge === "object"
        ? existingBridge
        : {};
    state.started = true;
    state.pollTimer = null;
    state.flushTimer = null;
    state.pollInFlight = false;
    state.pollFailures = 0;
    state.spewRegistered = false;
    state.spewSubscription = null;
    state.activeActionId = null;
    state.activeJobId = null;
    state.activeAppid = null;
    state.activeDepotId = null;
    state.activeManifestId = null;
    state.lineBuffer = [];
    state.nextConsoleBatchId = 1;
    state.reportChain = Promise.resolve();
    state.seenActionIds = new Set();
    state.seenActionOrder = [];
    globalThis[BRIDGE_KEY] = state;

    function parseBackendResponse(response) {
        let value = response;
        if (value && typeof value === "object" && "returnValue" in value) {
            value = value.returnValue;
        }
        if (typeof value === "string") {
            try {
                return JSON.parse(value);
            }
            catch (_) {
                return null;
            }
        }
        return value && typeof value === "object" ? value : null;
    }

    async function callBackend(methodName, argumentsObject) {
        if (typeof Millennium === "undefined" ||
            typeof Millennium.callServerMethod !== "function") {
            throw new Error("backend_unavailable");
        }
        let timeout = null;
        try {
            const response = await Promise.race([
                Promise.resolve().then(() => Millennium.callServerMethod(
                    pluginName,
                    methodName,
                    argumentsObject,
                )),
                new Promise((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error("backend_call_timeout")),
                        BACKEND_CALL_TIMEOUT_MS,
                    );
                }),
            ]);
            return parseBackendResponse(response);
        }
        finally {
            if (timeout !== null) clearTimeout(timeout);
        }
    }

    async function reportEvent(event) {
        return await callBackend("ReportDowngradeClientEvent", {
            contentScriptQuery: "",
            payloadJson: JSON.stringify(event),
        });
    }

    function wait(delayMs) {
        return new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    async function reportEventReliably(event) {
        let delayMs = REPORT_RETRY_MIN_MS;
        while (state.started) {
            try {
                const response = await reportEvent(event);
                if (response?.success === true) return response;
                // A structured rejection means the backend received the event
                // (for example, it became stale after an earlier terminal
                // event). Retrying it cannot improve the result.
                if (response?.success === false) return response;
            }
            catch (_) {}

            // Transport/backend restarts are temporary. Keep the event in the
            // ordered outbox so a lost terminal line cannot leave the Lua job
            // holding ACTIVE_ACTION forever.
            await wait(delayMs);
            delayMs = Math.min(delayMs * 2, REPORT_RETRY_MAX_MS);
        }
        return null;
    }

    function queueEvent(event) {
        state.reportChain = state.reportChain
            .catch(() => undefined)
            .then(() => reportEventReliably(event));
        return state.reportChain;
    }

    function getSteamConsole() {
        try {
            if (typeof SteamClient !== "undefined") {
                return SteamClient?.Console || null;
            }
        }
        catch (_) {}
        return globalThis.SteamClient?.Console || null;
    }

    function actionIdFrom(value) {
        const actionId = typeof value === "string" || typeof value === "number"
            ? String(value)
            : "";
        return /^[A-Za-z0-9_.:-]{1,128}$/.test(actionId) ? actionId : null;
    }

    function eventFor(actionId, jobId, fields) {
        return {
            actionId,
            ...(jobId ? { jobId } : {}),
            ...fields,
        };
    }

    function setActiveCorrelation(actionId, jobId, ids) {
        state.activeActionId = actionId;
        state.activeJobId = jobId;
        state.activeAppid = ids?.appid || null;
        state.activeDepotId = ids?.depotId || null;
        state.activeManifestId = ids?.manifestId || null;
    }

    function clearActiveCorrelation(actionId, jobId) {
        if (actionId !== undefined && state.activeActionId !== actionId) return;
        if (jobId !== undefined && state.activeJobId !== jobId) return;
        state.activeActionId = null;
        state.activeJobId = null;
        state.activeAppid = null;
        state.activeDepotId = null;
        state.activeManifestId = null;
    }

    function rememberAction(actionId) {
        if (state.seenActionIds.has(actionId)) return false;
        state.seenActionIds.add(actionId);
        state.seenActionOrder.push(actionId);
        while (state.seenActionOrder.length > MAX_REMEMBERED_ACTIONS) {
            state.seenActionIds.delete(state.seenActionOrder.shift());
        }
        return true;
    }

    function decimalId(value, maximum, maximumDigits) {
        let text;
        if (typeof value === "bigint") {
            text = String(value);
        }
        else if (typeof value === "number" && Number.isSafeInteger(value)) {
            text = String(value);
        }
        else if (typeof value === "string") {
            text = value.trim();
        }
        else {
            return null;
        }

        if (!/^[1-9][0-9]*$/.test(text) || text.length > maximumDigits) {
            return null;
        }
        try {
            return BigInt(text) <= maximum ? text : null;
        }
        catch (_) {
            return null;
        }
    }

    function parseDownloadCommand(command) {
        if (typeof command !== "string" || command.length > 96) return null;
        const match = command.trim().match(
            /^download_depot\s+([1-9][0-9]*)\s+([1-9][0-9]*)\s+([1-9][0-9]*)$/,
        );
        if (!match) return null;

        const appid = decimalId(match[1], UINT32_MAX, 10);
        const depotId = decimalId(match[2], UINT32_MAX, 10);
        const manifestId = decimalId(match[3], UINT64_MAX, 20);
        return appid && depotId && manifestId
            ? { appid, depotId, manifestId }
            : null;
    }

    function buildDownloadCommand(action) {
        const fieldIds = {
            appid: decimalId(action?.appid, UINT32_MAX, 10),
            depotId: decimalId(action?.depotId, UINT32_MAX, 10),
            manifestId: decimalId(action?.manifestId, UINT64_MAX, 20),
        };
        const hasAllFields = fieldIds.appid && fieldIds.depotId && fieldIds.manifestId;
        const commandIds = action?.command === undefined
            ? null
            : parseDownloadCommand(action.command);

        if (!hasAllFields && !commandIds) return null;
        if (hasAllFields && commandIds && (
            fieldIds.appid !== commandIds.appid ||
            fieldIds.depotId !== commandIds.depotId ||
            fieldIds.manifestId !== commandIds.manifestId
        )) {
            return null;
        }

        const ids = hasAllFields ? fieldIds : commandIds;
        return `download_depot ${ids.appid} ${ids.depotId} ${ids.manifestId}`;
    }

    function sanitizeConsoleLine(line) {
        return String(line)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
            .replace(
                /\b(authorization|password|passwd|access[_-]?token|refresh[_-]?token|sessionid|cookie)\s*[:=]\s*\S+/gi,
                "$1=[redacted]",
            )
            .slice(0, 4096);
    }

    function isTerminalConsoleLine(line) {
        return /\bDepot download complete\b|\bDepot download failed\b|\bFailed to download (?:depot|manifest)\b|\bError downloading (?:depot|manifest)\b|\bManifest (?:is )?not available\b|\bInvalid (?:depot|manifest)\b|\bNo subscription\b/i.test(line);
    }

    function containsDecimalMarker(text, prefix, decimalId) {
        if (!decimalId) return false;
        const lower = String(text).toLowerCase();
        const needle = `${prefix}${decimalId}`.toLowerCase();
        let from = 0;
        while (from < lower.length) {
            const start = lower.indexOf(needle, from);
            if (start < 0) return false;
            const following = lower[start + needle.length] || "";
            if (!/[0-9]/.test(following)) return true;
            from = start + needle.length;
        }
        return false;
    }

    function terminalCorrelationFor(lines, ids) {
        if (!ids?.depotId || !ids?.manifestId ||
            !lines.some(isTerminalConsoleLine)) {
            return null;
        }

        // Console spew is global to the Steam client.  Never infer that an
        // arbitrary terminal line belongs to the command currently observed.
        // Exact IDs may only be attached when this single Steam callback names
        // both the expected depot and manifest.  A completion path containing
        // depot_ID is deliberately left unstructured: Lua accepts that form
        // only after verifying the exact cached manifest on disk.
        const hasDepot = lines.some((line) =>
            containsDecimalMarker(line, "depot_", ids.depotId) ||
            containsDecimalMarker(line, "depot ", ids.depotId));
        const hasManifest = lines.some((line) =>
            containsDecimalMarker(line, "manifest ", ids.manifestId));
        if (!hasDepot || !hasManifest) return null;
        return {
            ...(ids.appid ? { appid: ids.appid } : {}),
            depotId: ids.depotId,
            manifestId: ids.manifestId,
        };
    }

    function flushConsoleLines() {
        if (state.flushTimer !== null) {
            clearTimeout(state.flushTimer);
            state.flushTimer = null;
        }

        const reportTasks = [];
        while (state.lineBuffer.length > 0) {
            const firstActionId = state.lineBuffer[0].actionId;
            const firstJobId = state.lineBuffer[0].jobId;
            const firstBatchId = state.lineBuffer[0].batchId;
            const terminalCorrelation = state.lineBuffer[0].terminalCorrelation;
            const lines = [];
            while (
                state.lineBuffer.length > 0 &&
                state.lineBuffer[0].actionId === firstActionId &&
                state.lineBuffer[0].jobId === firstJobId &&
                state.lineBuffer[0].batchId === firstBatchId &&
                lines.length < MAX_BATCH_LINES
            ) {
                lines.push(state.lineBuffer.shift().line);
            }
            const containsTerminalLine = lines.some(isTerminalConsoleLine);
            reportTasks.push(
                queueEvent(eventFor(firstActionId, firstJobId, {
                    type: "console_lines",
                    lines,
                    ...(containsTerminalLine && terminalCorrelation
                        ? terminalCorrelation
                        : {}),
                })).then((response) => ({
                    response,
                    containsTerminalLine,
                    actionId: firstActionId,
                    jobId: firstJobId,
                })),
            );
        }
        return Promise.all(reportTasks)
            .then((results) => {
                const correlations = new Map();
                for (const result of results) {
                    const key = `${result.actionId}\u0000${result.jobId || ""}`;
                    let correlation = correlations.get(key);
                    if (!correlation) {
                        correlation = {
                            actionId: result.actionId,
                            jobId: result.jobId,
                            hasFailure: false,
                            terminalAccepted: false,
                        };
                        correlations.set(key, correlation);
                    }
                    if (!result.response || result.response.success === false) {
                        correlation.hasFailure = true;
                    }
                    if (
                        result.response?.success === true &&
                        result.response?.ignored !== true &&
                        (result.containsTerminalLine ||
                            result.response?.terminalAccepted === true)
                    ) {
                        correlation.terminalAccepted = true;
                    }
                }

                let acceptedAnyTerminal = false;
                for (const correlation of correlations.values()) {
                    if (correlation.hasFailure || !correlation.terminalAccepted) continue;
                    acceptedAnyTerminal = true;
                    if (
                        state.activeActionId === correlation.actionId &&
                        state.activeJobId === correlation.jobId
                    ) {
                        clearActiveCorrelation(
                            correlation.actionId,
                            correlation.jobId,
                        );
                    }
                }
                return acceptedAnyTerminal;
            })
            .catch(() => false);
    }

    function scheduleFlush() {
        if (state.flushTimer !== null) return;
        state.flushTimer = setTimeout(flushConsoleLines, FLUSH_INTERVAL_MS);
    }

    function handleSpewOutput(output) {
        const actionId = state.activeActionId;
        const jobId = state.activeJobId;
        const appid = state.activeAppid;
        const depotId = state.activeDepotId;
        const manifestId = state.activeManifestId;
        if (!actionId) return;

        const spew = typeof output === "string"
            ? output
            : typeof output?.spew === "string"
                ? output.spew
                : "";
        if (!spew) return;

        const lines = [];
        for (const rawLine of spew.split(/[\r\n]+/)) {
            const line = sanitizeConsoleLine(rawLine);
            if (!line) continue;
            lines.push(line);
        }
        if (lines.length === 0) return;

        const terminal = lines.some(isTerminalConsoleLine);
        const batchId = terminal
            ? `terminal:${state.nextConsoleBatchId++}`
            : "general";
        const terminalCorrelation = terminalCorrelationFor(lines, {
            appid,
            depotId,
            manifestId,
        });
        for (const line of lines) {
            state.lineBuffer.push({
                actionId,
                jobId,
                batchId,
                terminalCorrelation,
                line,
            });
        }

        if (state.lineBuffer.length > MAX_BUFFERED_LINES) {
            state.lineBuffer.splice(0, state.lineBuffer.length - MAX_BUFFERED_LINES);
            queueEvent(eventFor(actionId, jobId, {
                type: "bridge_error",
                reason: "console_buffer_overflow",
            }));
        }

        if (state.lineBuffer.length >= MAX_BATCH_LINES || terminal) {
            flushConsoleLines();
        }
        else if (state.lineBuffer.length > 0) {
            scheduleFlush();
        }
    }

    function ensureSpewListener() {
        if (state.spewRegistered) return true;
        const consoleApi = getSteamConsole();
        if (typeof consoleApi?.RegisterForSpewOutput !== "function") return false;
        try {
            state.spewSubscription = consoleApi.RegisterForSpewOutput(handleSpewOutput);
            state.spewRegistered = true;
            return true;
        }
        catch (_) {
            state.spewSubscription = null;
            state.spewRegistered = false;
            return false;
        }
    }

    function containsDownloadDepotSuggestion(value, depth = 0) {
        if (depth > 4 || value === null || value === undefined) return false;
        if (typeof value === "string") {
            return /(^|\s)download_depot(?:\s|$)/i.test(value);
        }
        if (Array.isArray(value)) {
            return value.some((item) => containsDownloadDepotSuggestion(item, depth + 1));
        }
        if (typeof value === "object") {
            return Object.values(value).some(
                (item) => containsDownloadDepotSuggestion(item, depth + 1),
            );
        }
        return false;
    }

    async function handleProbe(actionId, jobId) {
        const consoleApi = getSteamConsole();
        if (typeof consoleApi?.ExecCommand !== "function" ||
            typeof consoleApi?.RegisterForSpewOutput !== "function") {
            await queueEvent(eventFor(actionId, jobId, {
                type: "probe_result",
                available: false,
                reason: "console_api_unavailable",
            }));
            return;
        }

        if (!ensureSpewListener()) {
            await queueEvent(eventFor(actionId, jobId, {
                type: "probe_result",
                available: false,
                reason: "spew_registration_failed",
            }));
            return;
        }

        if (typeof consoleApi.GetAutocompleteSuggestions !== "function") {
            await queueEvent(eventFor(actionId, jobId, {
                type: "probe_result",
                available: true,
                reason: "autocomplete_unavailable",
            }));
            return;
        }

        try {
            const suggestions = await Promise.resolve(
                consoleApi.GetAutocompleteSuggestions("download_depot"),
            );
            const available = containsDownloadDepotSuggestion(suggestions);
            await queueEvent(eventFor(actionId, jobId, {
                type: "probe_result",
                available,
                ...(available ? {} : { reason: "command_not_found" }),
            }));
        }
        catch (_) {
            await queueEvent(eventFor(actionId, jobId, {
                type: "probe_result",
                available: false,
                reason: "autocomplete_failed",
            }));
        }
    }

    async function handleExec(action, actionId, jobId) {
        const consoleApi = getSteamConsole();
        const command = buildDownloadCommand(action);
        const commandIds = command ? parseDownloadCommand(command) : null;
        if (!command) {
            await queueEvent(eventFor(actionId, jobId, {
                type: "bridge_error",
                reason: "invalid_download_command",
            }));
            return;
        }
        if (typeof consoleApi?.ExecCommand !== "function" || !ensureSpewListener()) {
            await queueEvent(eventFor(actionId, jobId, {
                type: "bridge_error",
                reason: "console_api_unavailable",
            }));
            return;
        }

        // A newly issued backend action is authoritative; any previous action was
        // already verified by the backend even if Steam emitted no terminal line.
        flushConsoleLines();
        try {
            const acknowledgement = await queueEvent(eventFor(actionId, jobId, {
                type: "command_started",
                appid: commandIds.appid,
                depotId: commandIds.depotId,
                manifestId: commandIds.manifestId,
            }));
            // A second renderer can race the original claimant during a UI
            // reload. The backend marks that duplicate claim as ignored: it
            // must neither execute Steam again nor fail the live job.
            if (acknowledgement?.success === true && acknowledgement?.ignored === true) {
                // The other renderer owns execution, so this renderer becomes
                // its observer immediately. Waiting for a repeated `observe`
                // action would be ineffective because this ID is already in
                // the local de-duplication set.
                setActiveCorrelation(actionId, jobId, commandIds);
                return;
            }
            if (acknowledgement?.success !== true) {
                await queueEvent(eventFor(actionId, jobId, {
                    type: "bridge_error",
                    reason: "command_start_not_acknowledged",
                }));
                return;
            }

            // Register the correlation context only after the backend accepts
            // command_started. This prevents a stale action from executing after
            // a backend restart and keeps every spew batch tied to its job.
            setActiveCorrelation(actionId, jobId, commandIds);
            await Promise.resolve(consoleApi.ExecCommand(command));
        }
        catch (_) {
            if (state.activeActionId === actionId && state.activeJobId === jobId) {
                clearActiveCorrelation(actionId, jobId);
            }
            await queueEvent(eventFor(actionId, jobId, {
                type: "bridge_error",
                reason: "exec_failed",
                ...(commandIds ? {
                    appid: commandIds.appid,
                    depotId: commandIds.depotId,
                    manifestId: commandIds.manifestId,
                } : {}),
            }));
        }
    }

    async function handleObserve(action, actionId, jobId) {
        // Reconnect to an exec action which the backend already acknowledged
        // before this SharedJSContext was recreated. Validate the exact same
        // allowlisted command shape, but never execute or re-acknowledge it.
        const command = buildDownloadCommand(action);
        const commandIds = command ? parseDownloadCommand(command) : null;
        if (!commandIds) {
            await queueEvent(eventFor(actionId, jobId, {
                type: "bridge_error",
                reason: "invalid_download_command",
            }));
            return;
        }
        if (!ensureSpewListener()) {
            await queueEvent(eventFor(actionId, jobId, {
                type: "bridge_error",
                reason: "console_api_unavailable",
            }));
            return;
        }

        flushConsoleLines();
        setActiveCorrelation(actionId, jobId, commandIds);
    }

    async function handleAction(action) {
        if (!action || typeof action !== "object") return;
        const actionId = actionIdFrom(action.id);
        const hasJobId = action.jobId !== undefined && action.jobId !== null;
        const jobId = hasJobId ? actionIdFrom(action.jobId) : null;
        if (!actionId) {
            await queueEvent(eventFor("bridge", jobId, {
                type: "bridge_error",
                reason: "invalid_action_id",
            }));
            return;
        }
        if (!rememberAction(actionId)) return;
        if (hasJobId && !jobId) {
            await queueEvent(eventFor(actionId, null, {
                type: "bridge_error",
                reason: "invalid_job_id",
            }));
            return;
        }

        if (action.type === "probe") {
            await handleProbe(actionId, jobId);
        }
        else if (action.type === "exec") {
            await handleExec(action, actionId, jobId);
        }
        else if (action.type === "observe") {
            await handleObserve(action, actionId, jobId);
        }
        else {
            await queueEvent(eventFor(actionId, jobId, {
                type: "bridge_error",
                reason: "unsupported_action",
            }));
        }
    }

    function schedulePoll(delayMs) {
        if (!state.started) return;
        if (state.pollTimer !== null) clearTimeout(state.pollTimer);
        state.pollTimer = setTimeout(pollBackend, delayMs);
    }

    async function pollBackend() {
        state.pollTimer = null;
        if (!state.started || state.pollInFlight) return;
        state.pollInFlight = true;
        try {
            const payload = await callBackend("GetDowngradeClientAction", {
                contentScriptQuery: "",
            });
            if (payload?.success === true && payload.action) {
                await handleAction(payload.action);
            }
            state.pollFailures = 0;
        }
        catch (_) {
            state.pollFailures = Math.min(state.pollFailures + 1, 5);
        }
        finally {
            state.pollInFlight = false;
            const delay = Math.min(
                POLL_INTERVAL_MS * (2 ** state.pollFailures),
                MAX_POLL_BACKOFF_MS,
            );
            schedulePoll(delay);
        }
    }

    state.stop = () => {
        if (!state.started) return;
        state.started = false;
        if (state.pollTimer !== null) clearTimeout(state.pollTimer);
        if (state.flushTimer !== null) clearTimeout(state.flushTimer);
        state.pollTimer = null;
        state.flushTimer = null;
        flushConsoleLines();
        try {
            state.spewSubscription?.unregister?.();
        }
        catch (_) {}
        state.spewSubscription = null;
        state.spewRegistered = false;
        clearActiveCorrelation();
    };

    // Register early when possible so no initial console output is missed, then
    // let the probe report exact capability to the backend.
    ensureSpewListener();
    schedulePoll(250);
})();
