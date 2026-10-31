local state = {
    now = 1000,
    online = true,
    requests = {},
    files = {},
    fixtures = {},
    encoded = {},
    encode_counter = 0,
    request_handler = nil,
}

local function deep_copy(value, seen)
    if type(value) ~= "table" then return value end
    seen = seen or {}
    if seen[value] then return seen[value] end
    local copy = {}
    seen[value] = copy
    for key, item in pairs(value) do copy[deep_copy(key, seen)] = deep_copy(item, seen) end
    return copy
end

package.preload["json"] = function()
    return {
        decode = function(text)
            local fixture = state.fixtures[text] or state.encoded[text]
            if fixture == nil then error("mock JSON rejected: " .. tostring(text):sub(1, 40)) end
            return deep_copy(fixture)
        end,
        encode = function(value)
            state.encode_counter = state.encode_counter + 1
            local marker = "ENCODED_CACHE_" .. tostring(state.encode_counter)
            state.encoded[marker] = deep_copy(value)
            return marker
        end,
    }
end

package.preload["fs"] = function()
    local fs = {}
    function fs.join(...)
        local values = {...}
        return table.concat(values, "/"):gsub("/+", "/")
    end
    function fs.exists(path)
        return state.files[path] ~= nil or path == "/mock/backend/data/version_catalog"
    end
    function fs.file_size(path)
        local value = state.files[path]
        return value and #value or nil
    end
    function fs.create_directories(_) return true end
    return fs
end

package.preload["paths"] = function()
    return {
        backend_path = function(name) return "/mock/backend/" .. name end,
    }
end

package.preload["utils"] = function()
    return {
        time = function() return state.now end,
        read_file = function(path) return state.files[path] end,
        write_file = function(path, value)
            state.files[path] = value
            return true
        end,
    }
end

package.preload["plugin_logger"] = function()
    return { log = function() end, warn = function() end, error = function() end }
end

local function sha(character)
    return string.rep(character, 40)
end

local function commit_item(commit_sha, date, change_id, appid)
    return {
        sha = commit_sha,
        created = date,
        commit = {
            author = { date = date },
            message = "Change " .. tostring(change_id) .. " (appId=" .. tostring(appid) .. ", missingToken=false)\n",
        },
    }
end

local function snapshot(appid, build_id, timestamp, manifests)
    local depots = {
        branches = {
            public = {
                buildid = tostring(build_id),
                timebuildupdated = tostring(timestamp),
            },
        },
    }
    for depot_id, manifest_id in pairs(manifests) do
        depots[tostring(depot_id)] = {
            manifests = { public = { gid = tostring(manifest_id) } },
        }
    end
    return { appid = tostring(appid), depots = depots }
end

local APPID = "3003460"
local DEPOTS = { "3003462", "3003461" }
local COMMITS_URL = "https://gitea.com/api/v1/repos/Sainan/steam-pics/commits?path=appinfo%2F" ..
    APPID .. ".json&page=1&limit=20"

local first_sha = sha("a")
local duplicate_sha = sha("b")
local old_sha = sha("c")
state.fixtures.COMMITS = {
    commit_item(first_sha, "2026-03-24T19:38:14-07:00", "34633543", APPID),
    commit_item(duplicate_sha, "2026-03-20T00:00:00Z", "34550000", APPID),
    commit_item(old_sha, "2026-03-19T19:12:03-07:00", "34543815", APPID),
}
state.fixtures.SNAPSHOT_A = snapshot(APPID, "22481440", "1774359808", {
    ["3003461"] = "1436883181299494714",
    ["3003462"] = "963698552309478841",
})
state.fixtures.SNAPSHOT_DUPLICATE = snapshot(APPID, "22480000", "1774200000", {
    ["3003461"] = "1436883181299494714",
    ["3003462"] = "963698552309478841",
})
state.fixtures.SNAPSHOT_OLD = snapshot(APPID, "22000000", "1770000000", {
    ["3003461"] = "1111111111111111111",
    ["3003462"] = "2222222222222222222",
})

local function raw_url(commit_sha, appid)
    return "https://gitea.com/Sainan/steam-pics/raw/commit/" .. commit_sha ..
        "/appinfo/" .. appid .. ".json"
end

local routes = {
    [COMMITS_URL] = "COMMITS",
    [raw_url(first_sha, APPID)] = "SNAPSHOT_A",
    [raw_url(duplicate_sha, APPID)] = "SNAPSHOT_DUPLICATE",
    [raw_url(old_sha, APPID)] = "SNAPSHOT_OLD",
}

package.preload["http_client"] = function()
    return {
        get = function(url, options)
            state.requests[#state.requests + 1] = { url = url, options = deep_copy(options) }
            if state.request_handler then
                local response, response_error = state.request_handler(url, options)
                if response ~= nil or response_error ~= nil then return response, response_error end
            end
            if not state.online then return nil, "offline" end
            local body = routes[url]
            if not body then return { status = 404, body = "missing", headers = {} } end
            return {
                status = 200,
                body = body,
                headers = { ["Content-Length"] = tostring(#body) },
            }
        end,
    }
end

local script_source = debug.getinfo(1, "S").source
local script_path = script_source:sub(1, 1) == "@" and script_source:sub(2) or "scripts/test_version_catalog.lua"
local script_directory = script_path:match("^(.*)[/\\]") or "scripts"
package.path = script_directory .. "/../backend/?.lua;" .. package.path

local function assert_true(value, message)
    if not value then error(message or "assert_true failed", 2) end
end

local function assert_equal(actual, expected, message)
    if actual ~= expected then
        error((message or "values differ") .. ": expected " .. tostring(expected) ..
            ", got " .. tostring(actual), 2)
    end
end

local function reset_module()
    package.loaded["version_catalog"] = nil
    return require("version_catalog")
end

local catalog = reset_module()

local function drain_catalog(result, maximum_polls)
    local polls = 0
    local job_id = result.catalogJobId
    while result.catalogPending == true do
        polls = polls + 1
        assert_true(polls <= (maximum_polls or 64), "catalog job did not terminate")
        local before_status = #state.requests
        local status = catalog.get_catalog_status(job_id)
        assert_equal(status.catalogJobId, job_id)
        assert_equal(#state.requests, before_status, "status reads must never perform HTTP")
        local before_poll = #state.requests
        result = catalog.poll_catalog(job_id)
        assert_true(#state.requests - before_poll <= 1,
            "one catalog poll must perform at most one bounded HTTP request")
    end
    return result, polls
end

do
    local before = #state.requests
    local bad_app = catalog.get_versions("../3003460", DEPOTS)
    assert_equal(bad_app.success, false, "unsafe appid must fail")
    assert_equal(bad_app.error, "invalid_appid")

    local bad_depot = catalog.get_versions(APPID, { "3003461", "https://evil.invalid" })
    assert_equal(bad_depot.success, false, "unsafe depot ID must fail")
    assert_equal(bad_depot.error, "invalid_depot_ids")
    assert_equal(#state.requests, before, "invalid IDs must not reach HTTP")
end

do
    local before_start = #state.requests
    local result = catalog.get_versions(APPID, DEPOTS, { ttlSeconds = 60, allowSteamDb = false })
    assert_true(result.catalogPending, "remote catalog should start as a real pending job")
    assert_equal(result.catalogState, "pending")
    assert_equal(result.jobState.nextProvider, "steam-pics")
    assert_equal(result.jobState.pollCount, 0)
    assert_equal(result.providers[4].status, "pending")
    assert_equal(#state.requests, before_start, "initial catalog RPC must not perform HTTP")
    local first_job_id = result.catalogJobId
    result = drain_catalog(result)
    assert_true(result.success, "network catalog should succeed")
    assert_equal(result.catalogJobId, first_job_id, "polling must preserve the job ID")
    assert_equal(result.catalogState, "complete")
    assert_equal(result.catalogPending, false)
    assert_true(result.jobState.pollCount >= 1)
    assert_equal(result.source, "network")
    assert_equal(result.appid, APPID)
    assert_equal(result.depotIds[1], "3003461", "depot IDs should be canonical")
    assert_equal(#result.versions, 2, "duplicate manifest sets should collapse")
    assert_equal(result.versions[1].buildId, "22481440")
    assert_equal(result.versions[1].timestamp, "1774359808")
    assert_equal(result.versions[1].source, "steam-pics")
    assert_equal(result.versions[1].changeId, "34633543")
    assert_equal(result.versions[1].depots[1].manifestId, "1436883181299494714")
    assert_equal(#result.candidates, 2, "new candidate contract should mirror verified versions")
    assert_equal(result.candidates[1].compatibility.status, "verified")
    assert_equal(result.providers[1].id, "steam-official")
    assert_equal(result.providers[2].id, "steam-local")
    assert_equal(result.providers[3].id, "steamdb")
    assert_equal(result.providers[4].id, "steam-pics")
    assert_equal(state.requests[1].url, COMMITS_URL)
    for _, request in ipairs(state.requests) do
        assert_true(request.url:match("^https://gitea%.com/") ~= nil, "all requests must use allowed HTTPS")
        assert_equal(request.options.follow_redirects, false)
        assert_equal(request.options.verify_ssl, true)
    end
end

do
    local request_count = #state.requests
    state.online = false
    state.now = 1030
    -- Simulate an upgrade from the legacy catalog: only <appid>.json exists,
    -- not the newer providers_<appid>.json aggregate.
    state.files["/mock/backend/data/version_catalog/providers_" .. APPID .. ".json"] = nil
    catalog = reset_module()
    local result = catalog.list_versions(APPID, { "3003461", "3003462" }, {
        ttlSeconds = 60,
        allowSteamDb = false,
    })
    assert_true(result.success, "fresh persistent cache should succeed")
    assert_equal(result.source, "cache")
    assert_equal(result.stale, false)
    assert_equal(result.candidates[1].source, "steam-pics",
        "cache transport must preserve the historical provider identity")
    assert_equal(#state.requests, request_count, "fresh cache must avoid HTTP")
end

do
    state.now = 2000
    local before = #state.requests
    local result = catalog.get_versions(APPID, DEPOTS, { ttlSeconds = 60, allowSteamDb = false })
    assert_true(result.catalogPending, "stale cache should be returned while refresh is pending")
    assert_equal(#state.requests, before, "stale cache lookup must return before network refresh")
    assert_equal(result.source, "cache")
    assert_equal(result.stale, true)
    assert_equal(#result.versions, 2)
    result = drain_catalog(result)
    assert_true(result.success, "expired cache should survive network failure")
    assert_equal(result.source, "cache")
    assert_equal(result.stale, true)
    assert_true(result.warning:match("network_refresh_failed") ~= nil)
    assert_equal(#result.versions, 2)
end

do
    state.online = true
    state.now = 2100
    local before = #state.requests
    local result = catalog.get_versions(APPID, DEPOTS, { forceRefresh = true, allowSteamDb = false })
    assert_equal(#state.requests, before, "forced refresh must also start without network I/O")
    assert_true(result.catalogPending)
    result = drain_catalog(result)
    assert_true(result.success, "cached commit snapshots should refresh")
    assert_equal(result.source, "network")
    assert_equal(#state.requests - before, 2,
        "refresh should reuse retained SHAs and fetch only an omitted duplicate SHA")
end

do
    state.now = 3000
    state.fixtures.OVERSIZED = {}
    local large_appid = "400"
    local large_url = "https://gitea.com/api/v1/repos/Sainan/steam-pics/commits?path=appinfo%2F400.json&page=1&limit=20"
    routes[large_url] = string.rep("x", 512 * 1024 + 1)
    local result = catalog.get_versions(large_appid, { "401" }, {
        forceRefresh = true,
        allowSteamDb = false,
    })
    assert_true(result.catalogPending)
    result = drain_catalog(result)
    assert_equal(result.success, false, "oversized JSON must fail closed")
    assert_equal(result.error, "catalog_unavailable")
    assert_true(result.detail:match("response_too_large") ~= nil)
end

do
    local limit_appid = "500"
    local limit_commits = {}
    local limit_routes = {}
    local limit_url = "https://gitea.com/api/v1/repos/Sainan/steam-pics/commits?path=appinfo%2F500.json&page=1&limit=20"
    for index = 1, 20 do
        local commit_sha = string.rep("0", 38) .. string.format("%02x", index)
        limit_commits[#limit_commits + 1] = commit_item(
            commit_sha,
            string.format("2026-04-%02dT00:00:00Z", math.min(index, 28)),
            tostring(35000000 + index),
            limit_appid
        )
        local marker = "LIMIT_SNAPSHOT_" .. tostring(index)
        state.fixtures[marker] = snapshot(limit_appid, tostring(23000000 + index),
            tostring(1775000000 + index), {
                ["501"] = "9000000000000000" .. string.format("%03d", index),
            })
        limit_routes[raw_url(commit_sha:lower(), limit_appid)] = marker
    end
    state.fixtures.LIMIT_COMMITS = limit_commits
    routes[limit_url] = "LIMIT_COMMITS"
    for url, marker in pairs(limit_routes) do routes[url] = marker end

    local before = #state.requests
    local result = catalog.get_versions(limit_appid, { "501" }, {
        forceRefresh = true,
        allowSteamDb = false,
    })
    assert_equal(#state.requests, before, "large catalog must start without requests")
    local polls
    result, polls = drain_catalog(result)
    assert_true(result.success, "limited catalog should succeed: " ..
        tostring(result.error) .. "/" .. tostring(result.detail))
    assert_equal(#result.versions, 12, "catalog must cap versions at 12")
    assert_equal(#state.requests - before, 13, "catalog must fetch one list plus at most 12 snapshots")
    assert_true(polls >= 13, "large history must be split across bounded polls")
end

do
    local seeded_appid = "610"
    local before = #state.requests
    state.now = 4000
    state.online = false
    local result = catalog.get_versions(seeded_appid, { "611" }, {
        officialVersions = {
            {
                id = "branch:legacy",
                branch = "legacy",
                buildId = "123456",
                timestamp = "3990",
                depots = { { depotId = "611", manifestId = "8000000000000000001" } },
                completeSnapshot = true,
                completenessEvidence = "steam-appdetails",
            },
        },
    })
    assert_true(result.success, "official candidates should return without network")
    assert_equal(result.source, "steam-official")
    assert_equal(#result.versions, 1)
    assert_equal(result.candidates[1].candidateId, "branch:legacy")
    assert_equal(result.candidates[1].compatibility.status, "verified")
    assert_equal(result.providers[3].status, "skipped")
    assert_equal(#state.requests, before, "preferred official source must avoid fallback requests")

    state.now = 4000 + (23 * 60 * 60)
    catalog = reset_module()
    local cached = catalog.get_versions(seeded_appid, { "611" })
    assert_true(cached.success, "default 24 hour cache should be fresh")
    assert_equal(cached.source, "cache")
    assert_equal(cached.stale, false)
    assert_equal(cached.candidates[1].source, "steam-official",
        "aggregate cache must preserve the original provider identity")
    assert_equal(#state.requests, before, "fresh provider cache must avoid HTTP")

    state.now = 4000 + (25 * 60 * 60)
    local stale = catalog.get_versions(seeded_appid, { "611" }, { allowSteamDb = false })
    assert_true(stale.success, "cache should remain usable stale for 30 days")
    assert_equal(stale.source, "cache")
    assert_equal(stale.stale, true)
    assert_true(stale.catalogPending, "stale data should be returned before its refresh")

    state.now = 4000 + (31 * 24 * 60 * 60)
    require("version_sources")._reset_circuit_for_tests()
    local expired = catalog.get_versions(seeded_appid, { "611" }, { allowSteamDb = false })
    expired = drain_catalog(expired)
    assert_equal(expired.success, false, "cache older than 30 days must not be used")
end

do
    require("version_sources")._reset_circuit_for_tests()
    state.now = 5000
    state.online = true
    local steamdb_appid = "620"
    local steamdb_url = "https://steamdb.info/depot/621/manifests/"
    routes[steamdb_url] = [[
        <html><table>
        <tr><td><time datetime="2026-08-20T10:00:00Z"></time></td><td>7000000000000000001</td></tr>
        <tr><td><time data-time="1700000000"></time></td><td data-manifest-id="7000000000000000002"></td></tr>
        </table></html>
    ]]
    local result = catalog.get_versions(steamdb_appid, { "621" }, {
        forceRefresh = true,
        allowGitea = false,
    })
    local before_poll = #state.requests
    assert_true(result.catalogPending)
    assert_equal(#state.requests, before_poll, "SteamDB must not run in the initial RPC")
    result = drain_catalog(result)
    assert_true(result.success, "SteamDB fallback should expose candidate history")
    assert_equal(result.source, "steamdb")
    assert_equal(#result.candidates, 2)
    assert_equal(#result.versions, 0, "unverified SteamDB entries must not enter verified legacy versions")
    assert_equal(result.candidates[1].source, "steamdb")
    assert_equal(result.candidates[1].compatibility.status, "force")
    assert_equal(result.candidates[1].compatibility.reasons[1], "build_unverified")
    assert_true(state.requests[#state.requests].options.timeout <= 6,
        "provider requests must use the six-second request deadline")
end

do
    require("version_sources")._reset_circuit_for_tests()
    state.now = 5500
    state.online = true
    routes["https://steamdb.info/depot/731/manifests/"] = [[
        <table><tr><td data-manifest-id="7310000000000000001"></td></tr></table>
    ]]
    routes["https://steamdb.info/depot/732/manifests/"] = [[
        <table><tr><td data-manifest-id="7320000000000000001"></td></tr></table>
    ]]
    local before = #state.requests
    local pending = catalog.get_versions("730", { "731", "732" }, {
        forceRefresh = true,
        allowGitea = false,
    })
    assert_equal(#state.requests, before)
    local first = catalog.poll_catalog(pending.catalogJobId)
    assert_true(first.catalogPending, "multi-depot SteamDB should remain cooperative")
    assert_equal(first.providers[3].status, "running")
    assert_equal(#state.requests - before, 1, "first poll may fetch only one depot page")
    local complete = catalog.poll_catalog(pending.catalogJobId)
    assert_equal(complete.catalogPending, false)
    assert_equal(#state.requests - before, 2, "second poll fetches the second depot page")
    assert_equal(complete.candidates[1].compatibility.status, "force")
end

do
    require("version_sources")._reset_circuit_for_tests()
    state.now = 6000
    state.online = true
    state.request_handler = function(url, options)
        if url:match("^https://gitea%.com/") then
            assert_true(options.timeout <= 6, "Gitea request timeout must be bounded")
            state.now = state.now + options.timeout
            return nil, "timed out"
        end
        return nil, nil
    end
    local before = #state.requests
    local failed = catalog.get_versions("630", { "631" }, {
        forceRefresh = true,
        allowSteamDb = false,
    })
    assert_true(failed.catalogPending)
    assert_equal(#state.requests, before, "timed provider must not run in the initial RPC")
    failed = drain_catalog(failed)
    assert_equal(failed.success, false)
    assert_equal(failed.providers[4].status, "timeout")
    assert_equal(#state.requests - before, 1, "a timed-out Gitea request must stop within its provider budget")

    local after_failure = #state.requests
    state.request_handler = nil
    local circuit = catalog.get_versions("632", { "633" }, {
        forceRefresh = true,
        allowSteamDb = false,
    })
    assert_equal(circuit.success, false)
    assert_equal(circuit.providers[4].status, "circuit_open")
    assert_equal(#state.requests, after_failure, "open circuit must prevent another Gitea request")
    require("version_sources")._reset_circuit_for_tests()
end

do
    state.now = 7000
    state.online = true
    local topology_appid = "700"
    local topology_sha = sha("d")
    local topology_commits_url =
        "https://gitea.com/api/v1/repos/Sainan/steam-pics/commits?path=appinfo%2F700.json&page=1&limit=20"
    state.fixtures.TOPOLOGY_COMMITS = {
        commit_item(topology_sha, "2025-01-01T00:00:00Z", "36000000", topology_appid),
    }
    state.fixtures.TOPOLOGY_SNAPSHOT = snapshot(topology_appid, "1000", "1700000000", {
        ["701"] = "7100000000000000001",
        ["799"] = "7900000000000000001",
    })
    routes[topology_commits_url] = "TOPOLOGY_COMMITS"
    routes[raw_url(topology_sha, topology_appid)] = "TOPOLOGY_SNAPSHOT"

    local result = catalog.get_versions(topology_appid, { "701" }, {
        forceRefresh = true,
        allowSteamDb = false,
    })
    result = drain_catalog(result)
    assert_true(result.success, "historical extra depots must remain selectable")
    assert_equal(#result.candidates, 1)
    assert_equal(#result.candidates[1].depots, 2, "old topology depot was discarded")
    assert_equal(result.candidates[1].compatibility.status, "force")
    assert_equal(result.candidates[1].compatibility.reasons[1], "topology_mismatch")
    assert_equal(result.candidates[1].completeSnapshot, true,
        "full steam-pics snapshot should carry explicit completeness evidence")
    assert_equal(#result.versions, 0, "topology mismatch must never be exposed as verified")

    local before_cache = #state.requests
    state.online = false
    catalog = reset_module()
    local cached = catalog.get_versions(topology_appid, { "701" }, {
        ttlSeconds = 60,
        allowSteamDb = false,
    })
    assert_equal(#state.requests, before_cache,
        "historical topology must be replayed from cache without HTTP")
    assert_equal(cached.catalogPending, false)
    assert_equal(#cached.candidates, 1)
    assert_equal(#cached.candidates[1].depots, 2)
    assert_equal(cached.candidates[1].source, "steam-pics")
    assert_equal(cached.candidates[1].compatibility.status, "force")
    assert_equal(#cached.versions, 0)
    state.online = true
end

do
    require("version_sources")._reset_circuit_for_tests()
    state.now = 7050
    state.online = true
    local appid = "705"
    local commit_sha = sha("e")
    local commits_url =
        "https://gitea.com/api/v1/repos/Sainan/steam-pics/commits?path=appinfo%2F705.json&page=1&limit=20"
    state.fixtures.INCOMPLETE_DEPOT_COMMITS = {
        commit_item(commit_sha, "2025-02-01T00:00:00Z", "36000001", appid),
    }
    local raw_snapshot = snapshot(appid, "1001", "1700000100", {
        ["706"] = "7600000000000000001",
    })
    raw_snapshot.depots["799"] = { name = "metadata exists but public manifest is unavailable" }
    state.fixtures.INCOMPLETE_DEPOT_SNAPSHOT = raw_snapshot
    routes[commits_url] = "INCOMPLETE_DEPOT_COMMITS"
    routes[raw_url(commit_sha, appid)] = "INCOMPLETE_DEPOT_SNAPSHOT"

    local result = catalog.get_versions(appid, { "706" }, {
        forceRefresh = true,
        allowSteamDb = false,
    })
    result = drain_catalog(result)
    assert_true(result.success, "usable manifests should survive incomplete snapshot metadata")
    assert_equal(#result.candidates, 1)
    assert_equal(result.candidates[1].completeSnapshot, false)
    assert_equal(result.candidates[1].compatibility.status, "force")
    assert_equal(result.candidates[1].compatibility.reasons[1], "incomplete_snapshot")
    assert_equal(#result.versions, 0,
        "a snapshot with an unaccounted numeric depot cannot enter verified versions")
end

do
    local incomplete = catalog.get_versions("710", { "711" }, {
        officialVersions = {
            {
                id = "legacy-without-evidence",
                buildId = "900",
                timestamp = "1600000000",
                depots = { { depotId = "711", manifestId = "7110000000000000001" } },
                compatibility = { status = "verified", reasons = {} },
            },
        },
    })
    assert_equal(incomplete.catalogPending, false)
    assert_equal(incomplete.candidates[1].compatibility.status, "force",
        "a candidate without completeness evidence cannot stay verified")
    assert_equal(incomplete.candidates[1].compatibility.reasons[1], "incomplete_snapshot")
    assert_equal(#incomplete.versions, 0)
end

do
    local before = #state.requests
    local pending = catalog.get_versions("720", { "721" }, {
        forceRefresh = true,
        allowSteamDb = false,
    })
    assert_true(pending.catalogPending)
    local cancelled = catalog.cancel_catalog(pending.catalogJobId)
    assert_equal(cancelled.catalogState, "cancelled")
    assert_equal(cancelled.catalogPending, false)
    assert_equal(#state.requests, before, "cancelling a queued catalog must not perform HTTP")
    local missing = catalog.poll_catalog("catalog-does-not-exist")
    assert_equal(missing.success, false)
    assert_equal(missing.error, "catalog_job_not_found")
end

do
    require("version_sources")._reset_circuit_for_tests()
    state.now = 8000
    local jobs = {}
    for index = 1, 32 do
        local appid = tostring(8000 + index)
        local depot_id = tostring(9000 + index)
        local result = catalog.get_versions(appid, { depot_id }, {
            officialVersions = {
                {
                    id = "capacity:" .. tostring(index),
                    buildId = tostring(10000 + index),
                    timestamp = tostring(state.now),
                    depots = {
                        { depotId = depot_id, manifestId = "800000000000000" .. tostring(index) },
                    },
                    completeSnapshot = true,
                    completenessEvidence = "test-full-snapshot",
                },
            },
        })
        jobs[#jobs + 1] = result.catalogJobId
    end
    assert_true(catalog.get_catalog_status(jobs[1]).success,
        "read-only status must not evict the oldest valid job at capacity")

    local overflow = catalog.get_versions("8999", { "9999" }, {
        officialVersions = {
            {
                id = "capacity:overflow",
                buildId = "19999",
                timestamp = tostring(state.now),
                depots = { { depotId = "9999", manifestId = "8999999999999999999" } },
                completeSnapshot = true,
                completenessEvidence = "test-full-snapshot",
            },
        },
    })
    assert_true(overflow.success)
    assert_equal(catalog.get_catalog_status(jobs[1]).error, "catalog_job_not_found",
        "creating job 33 must evict only the oldest job")
    assert_true(catalog.get_catalog_status(jobs[2]).success)

    local expiring = catalog.get_versions("9900", { "9901" }, {
        forceRefresh = true,
        allowSteamDb = false,
    })
    local expiring_id = expiring.catalogJobId
    state.now = state.now + require("version_sources").CATALOG_JOB_TTL_SECONDS
    assert_equal(catalog.get_catalog_status(expiring_id).error, "catalog_job_not_found",
        "catalog jobs must expire at their advertised deadline")
end

print("version_catalog tests passed")
