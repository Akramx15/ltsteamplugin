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
const marker = "// SharedJSContext bridge for the downgrade backend.";
const markerIndex = indexSource.indexOf(marker);
assert.notEqual(markerIndex, -1, "downgrade bridge marker is missing");
const bridgeSource = `(() => {\nconst pluginName = "luatools";\n${indexSource.slice(markerIndex)}\n})();`;

async function settle() {
    for (let index = 0; index < 64; index += 1) await Promise.resolve();
}

function createHarness({
    actions = [],
    reportHandler,
    execHandler,
    getActionHandler,
} = {}) {
    const timers = new Map();
    let nextTimerId = 1;
    let spewCallback = null;
    let spewRegistrations = 0;
    const executedCommands = [];
    const reports = [];
    const actionQueue = [...actions];
    let getActionCalls = 0;

    const sandbox = {
        BigInt,
        JSON,
        Math,
        Object,
        Promise,
        Set,
        String,
        console: { log() {}, warn() {}, error() {} },
        clearTimeout(id) { timers.delete(id); },
        setTimeout(callback, delay = 0) {
            const id = nextTimerId++;
            timers.set(id, { callback, delay: Number(delay) || 0 });
            return id;
        },
        Millennium: {
            async callServerMethod(plugin, method, args) {
                assert.equal(plugin, "luatools");
                if (method === "GetDowngradeClientAction") {
                    getActionCalls += 1;
                    if (getActionHandler) {
                        const handled = getActionHandler(getActionCalls);
                        if (handled !== undefined) return await handled;
                    }
                    const action = actionQueue.shift();
                    return JSON.stringify({ success: true, action: action || null });
                }
                if (method === "ReportDowngradeClientEvent") {
                    const event = JSON.parse(args.payloadJson);
                    reports.push(event);
                    const response = reportHandler
                        ? await reportHandler(event, reports)
                        : { success: true };
                    return typeof response === "string"
                        ? response
                        : JSON.stringify(response);
                }
                throw new Error(`unexpected RPC: ${method}`);
            },
        },
        SteamClient: {
            Console: {
                ExecCommand(command) {
                    executedCommands.push(command);
                    execHandler?.(command, emitSpew);
                },
                async GetAutocompleteSuggestions() { return ["download_depot"]; },
                RegisterForSpewOutput(callback) {
                    spewRegistrations += 1;
                    spewCallback = callback;
                    return { unregister() {} };
                },
            },
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    function emitSpew(spew, spewType = "info") {
        assert.equal(typeof spewCallback, "function", "spew listener is unavailable");
        spewCallback({ spew_type: spewType, spew });
    }

    function start() {
        vm.runInContext(bridgeSource, sandbox, { filename: "downgrade-bridge.js" });
    }

    function nextTimer() {
        let selected = null;
        for (const [id, timer] of timers) {
            if (!selected || timer.delay < selected.timer.delay ||
                (timer.delay === selected.timer.delay && id < selected.id)) {
                selected = { id, timer };
            }
        }
        assert.ok(selected, "expected a scheduled bridge timer");
        timers.delete(selected.id);
        return Promise.resolve().then(selected.timer.callback);
    }

    async function runNextTimer() {
        const task = nextTimer();
        await settle();
        await task;
        await settle();
    }

    function stop() {
        sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.stop();
    }

    return {
        sandbox,
        reports,
        executedCommands,
        emitSpew,
        nextTimer,
        runNextTimer,
        start,
        stop,
        get spewRegistrations() { return spewRegistrations; },
        get getActionCalls() { return getActionCalls; },
    };
}

async function testBaselineAndCommandAllowlist() {
    const harness = createHarness({
        actions: [
            { id: "probe-1", jobId: "job-1", type: "probe" },
            {
                id: "exec-1",
                jobId: "job-1",
                type: "exec",
                appid: "480",
                depotId: "481",
                manifestId: "1234567890123456789",
                command: "download_depot 480 481 1234567890123456789",
            },
            {
                id: "exec-invalid",
                jobId: "job-1",
                type: "exec",
                appid: "480",
                depotId: "481",
                manifestId: "123;quit",
                command: "download_depot 480 481 123;quit",
            },
        ],
    });
    harness.start();
    harness.start();
    assert.equal(
        harness.spewRegistrations,
        1,
        "duplicate bridge registered a second listener",
    );

    await harness.runNextTimer();
    assert.ok(harness.reports.some(
        (event) => event.type === "probe_result" && event.available,
    ));

    await harness.runNextTimer();
    assert.deepEqual(harness.executedCommands, [
        "download_depot 480 481 1234567890123456789",
    ]);
    const commandStarted = harness.reports.find(
        (event) => event.type === "command_started",
    );
    assert.ok(commandStarted);
    assert.equal(commandStarted.appid, "480");
    assert.equal(commandStarted.depotId, "481");
    assert.equal(commandStarted.manifestId, "1234567890123456789");

    harness.emitSpew(
        "Depot download complete : \"C:\\Steam\\steamapps\\content\\app_480\\depot_481\" (manifest 1234567890123456789)",
    );
    await settle();
    assert.ok(harness.reports.some(
        (event) => event.type === "console_lines" &&
            event.lines.some((line) => line.includes("Depot download complete")),
    ));
    const terminalReport = harness.reports.find(
        (event) => event.type === "console_lines" &&
            event.lines.some((line) => line.includes("Depot download complete")),
    );
    assert.equal(terminalReport.appid, "480");
    assert.equal(terminalReport.depotId, "481");
    assert.equal(terminalReport.manifestId, "1234567890123456789");

    await harness.runNextTimer();
    assert.equal(
        harness.executedCommands.length,
        1,
        "invalid command reached SteamClient.Console",
    );
    assert.ok(harness.reports.some(
        (event) => event.type === "bridge_error" &&
            event.reason === "invalid_download_command",
    ));
    harness.stop();
}

async function testLostRpcIsRetried() {
    let probeAttempts = 0;
    const harness = createHarness({
        actions: [{ id: "probe-retry", jobId: "job-retry", type: "probe" }],
        reportHandler(event) {
            if (event.type === "probe_result") {
                probeAttempts += 1;
                if (probeAttempts < 3) throw new Error("simulated lost RPC");
            }
            return { success: true };
        },
    });
    harness.start();

    // The first poll remains pending while the ordered outbox waits on its
    // bounded test simulation of two transient transport failures.
    const pendingPoll = harness.nextTimer();
    await settle();
    assert.equal(probeAttempts, 1);
    await harness.runNextTimer();
    assert.equal(probeAttempts, 2);
    await harness.runNextTimer();
    await pendingPoll;
    await settle();
    assert.equal(probeAttempts, 3);
    assert.equal(
        harness.reports.filter((event) => event.type === "probe_result").length,
        3,
    );
    harness.stop();
}

async function testIgnoredCommandStartNeverExecutes() {
    const harness = createHarness({
        actions: [{
            id: "job-stale:exec-1",
            jobId: "job-stale",
            type: "exec",
            appid: "480",
            depotId: "481",
            manifestId: "222",
        }],
        reportHandler(event) {
            if (event.type === "command_started") {
                return { success: true, ignored: true };
            }
            return { success: true };
        },
    });
    harness.start();
    await harness.runNextTimer();
    assert.deepEqual(
        harness.executedCommands,
        [],
        "stale command_started ACK reached ExecCommand",
    );
    assert.equal(
        harness.reports.filter((event) => event.type === "bridge_error").length,
        0,
        "duplicate command claim incorrectly failed the live backend job",
    );
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeActionId,
        "job-stale:exec-1",
        "duplicate claimant did not reconnect as an observer",
    );
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeJobId,
        "job-stale",
    );
    harness.stop();
}

async function testObserveReconnectNeverReexecutes() {
    const observe = {
        id: "job-observe:exec-1",
        jobId: "job-observe",
        type: "observe",
        appid: "480",
        depotId: "481",
        manifestId: "222",
        command: "download_depot 480 481 222",
    };
    const harness = createHarness({
        actions: [observe, { ...observe }],
        reportHandler(event) {
            if (event.type === "console_lines") {
                return { success: true, terminalAccepted: true };
            }
            return { success: true };
        },
    });
    harness.start();

    await harness.runNextTimer();
    assert.deepEqual(
        harness.executedCommands,
        [],
        "observe action re-executed an acknowledged Steam command",
    );
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeActionId,
        observe.id,
    );
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeJobId,
        observe.jobId,
    );
    assert.equal(
        harness.reports.some((event) => event.type === "command_started"),
        false,
        "observe action sent a second command_started event",
    );

    // A duplicate delivery of the same namespaced action is ignored by the
    // seen-action guard and still must not reach ExecCommand.
    await harness.runNextTimer();
    assert.deepEqual(harness.executedCommands, []);

    harness.emitSpew(
        "Depot download complete for depot 481 manifest 222",
    );
    await settle();
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeActionId,
        null,
        "terminalAccepted did not clear an observed action",
    );
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeJobId,
        null,
    );
    harness.stop();
}

async function testTerminalThenEvidenceAcknowledgement() {
    const harness = createHarness({
        actions: [{
            id: "job-order:exec-1",
            jobId: "job-order",
            type: "exec",
            appid: "480",
            depotId: "481",
            manifestId: "222",
        }],
        reportHandler(event) {
            if (event.type !== "console_lines") return { success: true };
            if (event.lines.some((line) => line.includes("download complete"))) {
                return { success: true, ignored: true };
            }
            if (event.lines.some((line) => line.includes("depot 481 manifest 222"))) {
                return { success: true, terminalAccepted: true };
            }
            return { success: true, ignored: true };
        },
    });
    harness.start();
    await harness.runNextTimer();
    assert.equal(harness.executedCommands.length, 1);

    harness.emitSpew("Depot download complete");
    await settle();
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeActionId,
        "job-order:exec-1",
        "ignored terminal callback cleared active correlation",
    );

    harness.emitSpew("depot 481 manifest 222");
    await harness.runNextTimer();
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeActionId,
        null,
        "later terminalAccepted evidence did not clear active correlation",
    );
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeJobId,
        null,
    );
    harness.stop();
}

async function testInterleavedDepotTerminalIsNotCorrelated() {
    const expectedDepot = "481";
    const expectedManifest = "222";
    const harness = createHarness({
        actions: [{
            id: "job-interleaved:exec-1",
            jobId: "job-interleaved",
            type: "exec",
            appid: "480",
            depotId: expectedDepot,
            manifestId: expectedManifest,
        }],
        reportHandler(event) {
            if (event.type !== "console_lines") return { success: true };
            const text = event.lines.join("\n").toLowerCase();
            const isTerminal = text.includes("depot download complete");
            const structuredMatch = event.depotId === expectedDepot &&
                event.manifestId === expectedManifest;
            const textualMatch = text.includes(`depot ${expectedDepot}`) &&
                text.includes(`manifest ${expectedManifest}`);
            return isTerminal && (structuredMatch || textualMatch)
                ? { success: true, terminalAccepted: true }
                : { success: true, ignored: true };
        },
    });
    harness.start();
    await harness.runNextTimer();

    harness.emitSpew(
        "Depot download complete : " +
        "\"C:\\Steam\\steamapps\\content\\app_999\\depot_998\" " +
        "(manifest 777)",
    );
    await settle();
    const unrelated = harness.reports.find(
        (event) => event.type === "console_lines" &&
            event.lines.some((line) => line.includes("depot_998")),
    );
    assert.ok(unrelated, "interleaved terminal spew was not reported");
    assert.equal(unrelated.appid, undefined);
    assert.equal(unrelated.depotId, undefined);
    assert.equal(unrelated.manifestId, undefined);
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeActionId,
        "job-interleaved:exec-1",
        "another depot's terminal event cleared the active command",
    );

    // Evidence from an earlier callback must never be combined with a later,
    // otherwise anonymous terminal callback.
    harness.emitSpew(`downloading depot ${expectedDepot} manifest ${expectedManifest}`);
    harness.emitSpew("Depot download complete");
    await settle();
    const genericTerminal = harness.reports.find(
        (event) => event.type === "console_lines" &&
            event.lines.length === 1 && event.lines[0] === "Depot download complete",
    );
    assert.ok(genericTerminal);
    assert.equal(genericTerminal.depotId, undefined);
    assert.equal(genericTerminal.manifestId, undefined);
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeActionId,
        "job-interleaved:exec-1",
        "correlation leaked across separate Steam spew callbacks",
    );

    harness.emitSpew(
        `Depot download complete for depot ${expectedDepot} manifest ${expectedManifest}`,
    );
    await settle();
    const expected = harness.reports.find(
        (event) => event.type === "console_lines" &&
            event.lines.some((line) => line.includes("complete for depot 481")),
    );
    assert.equal(expected.depotId, expectedDepot);
    assert.equal(expected.manifestId, expectedManifest);
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.activeActionId,
        null,
        "properly correlated completion was not accepted",
    );
    harness.stop();
}

async function testHungPollRpcTimesOutAndPollingRecovers() {
    const never = new Promise(() => {});
    const harness = createHarness({
        actions: [{ id: "probe-after-timeout", jobId: "job-timeout", type: "probe" }],
        getActionHandler(callNumber) {
            return callNumber === 1 ? never : undefined;
        },
    });
    harness.start();

    const firstPoll = harness.nextTimer();
    await settle();
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.pollInFlight,
        true,
    );

    // Fire BACKEND_CALL_TIMEOUT_MS. The pending RPC itself never settles, but
    // Promise.race must release pollInFlight and schedule a backed-off retry.
    await harness.runNextTimer();
    await firstPoll;
    await settle();
    assert.equal(
        harness.sandbox.__AKRAMS_DOWNGRADE_CONSOLE_BRIDGE_V1__.pollInFlight,
        false,
        "hung backend promise left polling permanently in flight",
    );

    await harness.runNextTimer();
    assert.equal(harness.getActionCalls, 2, "polling did not retry after RPC timeout");
    assert.ok(harness.reports.some(
        (event) => event.type === "probe_result" && event.available === true,
    ));
    harness.stop();
}

(async () => {
    await testBaselineAndCommandAllowlist();
    await testLostRpcIsRetried();
    await testIgnoredCommandStartNeverExecutes();
    await testObserveReconnectNeverReexecutes();
    await testTerminalThenEvidenceAcknowledgement();
    await testInterleavedDepotTerminalIsNotCorrelated();
    await testHungPollRpcTimesOutAndPollingRecovers();
    process.stdout.write("downgrade bridge tests passed\n");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
