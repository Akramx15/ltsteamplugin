local script_source = debug.getinfo(1, "S").source
local script_path = script_source:sub(1, 1) == "@" and script_source:sub(2) or
    "scripts/test_install_profile.lua"
local script_directory = script_path:match("^(.*)[/\\]") or "scripts"
package.path = script_directory .. "/../backend/?.lua;" .. package.path

local install_profile = require("install_profile")

local function assert_true(value, message)
    if not value then error(message or "assert_true failed", 2) end
end

local function assert_equal(actual, expected, message)
    if actual ~= expected then
        error((message or "values differ") .. ": expected " .. tostring(expected) ..
            ", got " .. tostring(actual), 2)
    end
end

local function base_state(overrides)
    local state = {
        appid = "123",
        StateFlags = "4",
        buildid = "999",
        TargetBuildID = "999",
        LastUpdated = "1700000100",
        BytesToDownload = "100",
        BytesDownloaded = "100",
        BytesToStage = "200",
        BytesStaged = "200",
        InstalledDepots = {
            ["20"] = { manifest = "9001", size = "22" },
            ["10"] = { manifest = "9000", size = "11" },
        },
        SharedDepots = {
            ["90"] = "456",
        },
    }
    for key, value in pairs(overrides or {}) do state[key] = value end
    return state
end

do
    local parsed, problem = install_profile.from_app_state("123", base_state(), {
        installPath = "C:/Steam/steamapps/common/Game",
        libraryPath = "C:/Steam",
        manifestPath = "C:/Steam/steamapps/appmanifest_123.acf",
    })
    assert_true(parsed ~= nil, problem)
    assert_true(parsed.ready, "completed install must be ready")
    assert_equal(#parsed.readinessReasons, 0)
    assert_equal(parsed.buildId, "999")
    assert_equal(parsed.targetBuildId, "999")
    assert_equal(parsed.depots[1].depotId, "10", "depots must be numeric-string sorted")
    assert_equal(parsed.depots[1].manifestId, "9000")
    assert_equal(parsed.depots[2].depotId, "20")
    assert_equal(parsed.sharedDepots[1].depotId, "90")
    assert_equal(parsed.sharedDepots[1].appid, "456")
    assert_true(type(parsed.fingerprint) == "string" and #parsed.fingerprint > 10)

    local again = assert(install_profile.from_app_state("123", base_state()))
    assert_equal(again.fingerprint, parsed.fingerprint, "fingerprint must be deterministic")
    local changed = assert(install_profile.from_app_state("123", base_state({ LastUpdated = "1700000101" })))
    assert_true(changed.fingerprint ~= parsed.fingerprint, "manifest drift must change fingerprint")
end

do
    local parsed = assert(install_profile.from_app_state("123", base_state({
        StateFlags = "6",
        TargetBuildID = "1000",
        BytesDownloaded = "50",
        BytesStaged = "10",
    })))
    assert_true(not parsed.ready, "active update must fail readiness")
    assert_equal(table.concat(parsed.readinessReasons, ","),
        "state_flags,target_build,download_pending,staging_pending")
end

do
    local current = assert(install_profile.from_app_state("123", base_state()))
    local exact = install_profile.compatibility(current, {
        { depotId = "10", manifestId = "8000" },
        { depotId = "20", manifestId = "8001" },
    }, true)
    assert_equal(exact.status, "verified")
    assert_equal(#exact.reasons, 0)
    assert_true(not exact.topologyChanged)

    local older_topology = install_profile.compatibility(current, {
        { depotId = "10", manifestId = "7000" },
    }, true)
    assert_equal(older_topology.status, "verified",
        "a complete older snapshot may legitimately omit a current depot")
    assert_true(older_topology.topologyChanged)
    assert_equal(older_topology.missingCurrentDepots[1], "20")

    local target_only = install_profile.compatibility(current, {
        { depotId = "10", manifestId = "7000" },
        { depotId = "20", manifestId = "7001" },
        { depotId = "30", manifestId = "7002" },
    }, true)
    assert_equal(target_only.status, "force")
    assert_equal(target_only.reasons[1], "added_target_depots")
    assert_equal(target_only.addedTargetDepots[1], "30")

    local incomplete = install_profile.compatibility(current, {
        { depotId = "10", manifestId = "7000" },
        { depotId = "20", manifestId = "7001" },
    }, false)
    assert_equal(incomplete.status, "force")
    assert_equal(incomplete.reasons[1], "incomplete_snapshot")

    local duplicate = install_profile.compatibility(current, {
        { depotId = "10", manifestId = "7000" },
        { depotId = "10", manifestId = "7001" },
    }, true)
    assert_equal(duplicate.status, "force")
    assert_equal(duplicate.reasons[1], "duplicate_depot")
end

do
    local parsed, problem = install_profile.from_app_state("124", base_state())
    assert_equal(parsed, nil)
    assert_equal(problem, "appmanifest_mismatch")

    parsed, problem = install_profile.from_app_state("123", base_state({ InstalledDepots = {} }))
    assert_equal(parsed, nil)
    assert_equal(problem, "no_installed_depots")

    parsed, problem = install_profile.from_app_state("123", base_state({ buildid = "0" }))
    assert_equal(parsed, nil)
    assert_equal(problem, "build_missing")
end

print("install_profile tests passed")
