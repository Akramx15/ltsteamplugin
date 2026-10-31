local cjson = require("json")
local fs = require("fs")
local http_client = require("http_client")
local logger = require("plugin_logger")
local paths = require("paths")
local m_utils = require("utils")
local version_sources = require("version_sources")

local version_catalog = {}

local SCHEMA_VERSION = 1
local SOURCE_NAME = "steam-pics"
local GITEA_ORIGIN = "https://gitea.com"
local REPOSITORY_API = GITEA_ORIGIN .. "/api/v1/repos/Sainan/steam-pics"
local REPOSITORY_RAW = GITEA_ORIGIN .. "/Sainan/steam-pics/raw/commit"

local UINT32_MAX = "4294967295"
local UINT64_MAX = "18446744073709551615"
local MAX_DEPOTS = 64
local MAX_COMMITS = 20
local MAX_VERSIONS = 12
local MAX_CACHE_QUERIES = 8
local MAX_COMMIT_LIST_BYTES = 512 * 1024
local MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
local MAX_CACHE_BYTES = 1024 * 1024
local DEFAULT_TTL_SECONDS = 24 * 60 * 60
local MAX_TTL_SECONDS = 30 * 24 * 60 * 60
local HTTP_TIMEOUT_SECONDS = 6

version_catalog.MAX_COMMITS = MAX_COMMITS
version_catalog.MAX_VERSIONS = MAX_VERSIONS
version_catalog.DEFAULT_TTL_SECONDS = DEFAULT_TTL_SECONDS

local function bounded_error(value)
    local text = tostring(value or "unknown_error"):gsub("[%c]", " ")
    return text:sub(1, 240)
end

local function failure(code, detail, appid, depot_ids)
    return {
        success = false,
        error = code,
        detail = detail and bounded_error(detail) or nil,
        appid = appid,
        depotIds = depot_ids or {},
        candidates = {},
        versions = {},
        providers = {},
    }
end

local function decimal_compare(left, right)
    if #left ~= #right then return #left < #right and -1 or 1 end
    if left == right then return 0 end
    return left < right and -1 or 1
end

local function normalize_decimal_string(value, maximum, allow_zero)
    if type(value) ~= "string" or not value:match("^%d+$") then return nil end
    value = value:gsub("^0+", "")
    if value == "" then value = "0" end
    if not allow_zero and value == "0" then return nil end
    if decimal_compare(value, maximum) == 1 then return nil end
    return value
end

local function normalize_input_uint32(value)
    if type(value) == "number" then
        if value ~= value or value < 1 or value ~= math.floor(value) then return nil end
        value = string.format("%.0f", value)
    end
    return normalize_decimal_string(value, UINT32_MAX, false)
end

local function dense_array_length(value)
    if type(value) ~= "table" then return nil end
    local count = 0
    for key in pairs(value) do
        if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return nil end
        count = count + 1
    end
    for index = 1, count do
        if rawget(value, index) == nil then return nil end
    end
    return count
end

local function decimal_less(left, right)
    return decimal_compare(left, right) == -1
end

local function copy_strings(values)
    local result = {}
    for _, value in ipairs(values or {}) do result[#result + 1] = value end
    return result
end

local function normalize_depot_ids(raw_ids, allow_numeric)
    local count = dense_array_length(raw_ids)
    if not count or count < 1 or count > MAX_DEPOTS then
        return nil, "depotIds must be a dense array containing 1-" .. tostring(MAX_DEPOTS) .. " IDs"
    end

    local result = {}
    local seen = {}
    for index = 1, count do
        local raw_id = raw_ids[index]
        local depot_id
        if allow_numeric then
            depot_id = normalize_input_uint32(raw_id)
        else
            depot_id = normalize_decimal_string(raw_id, UINT32_MAX, false)
        end
        if not depot_id then return nil, "depotIds contains an invalid ID" end
        if seen[depot_id] then return nil, "depotIds contains a duplicate ID" end
        seen[depot_id] = true
        result[#result + 1] = depot_id
    end
    table.sort(result, decimal_less)
    return result
end

local function depot_query_signature(depot_ids)
    return table.concat(depot_ids, ",")
end

local function same_depot_ids(left, right)
    if #left ~= #right then return false end
    for index = 1, #left do
        if left[index] ~= right[index] then return false end
    end
    return true
end

local function normalize_sha(value)
    if type(value) ~= "string" or #value ~= 40 or not value:match("^[0-9a-fA-F]+$") then
        return nil
    end
    return value:lower()
end

local function normalize_iso8601(value)
    if type(value) ~= "string" or #value < 20 or #value > 40 then return nil end
    local base = "^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d"
    if value:match(base .. "Z$") or value:match(base .. "%.%d+Z$") or
        value:match(base .. "[%+%-]%d%d:%d%d$") or
        value:match(base .. "%.%d+[%+%-]%d%d:%d%d$") then
        return value
    end
    return nil
end

local function normalize_timestamp(value)
    local numeric = normalize_decimal_string(value, UINT64_MAX, true)
    if numeric then return numeric end
    return normalize_iso8601(value)
end

local function normalize_ttl(options)
    if options == nil then return DEFAULT_TTL_SECONDS end
    if type(options) ~= "table" then return nil end
    local value = options.ttlSeconds
    if value == nil then return DEFAULT_TTL_SECONDS end
    if type(value) ~= "number" or value ~= math.floor(value) or value < 0 or value > MAX_TTL_SECONDS then
        return nil
    end
    return value
end

local function now_seconds()
    if type(m_utils.time) == "function" then
        local ok, value = pcall(m_utils.time)
        if ok and type(value) == "number" and value == value and value >= 0 then
            return math.floor(value)
        end
    end
    if type(os) == "table" and type(os.time) == "function" then
        local ok, value = pcall(os.time)
        if ok and type(value) == "number" and value >= 0 then return math.floor(value) end
    end
    return 0
end

local function is_allowed_url(url)
    return type(url) == "string" and #url <= 2048 and
        url:match("^https://gitea%.com/") ~= nil and
        url:find("[%c%s\\]") == nil
end

local function header_value(headers, wanted)
    if type(headers) ~= "table" then return nil end
    wanted = wanted:lower()
    for key, value in pairs(headers) do
        if type(key) == "string" and key:lower() == wanted then
            if type(value) == "table" then return value[1] end
            return value
        end
    end
    return nil
end

local function request_timeout(request_budget)
    if type(request_budget) ~= "table" then return HTTP_TIMEOUT_SECONDS end
    local started_at = tonumber(request_budget.startedAt)
    local seconds = tonumber(request_budget.seconds)
    local requested = tonumber(request_budget.requestTimeout) or HTTP_TIMEOUT_SECONDS
    if not started_at or not seconds then return math.min(HTTP_TIMEOUT_SECONDS, requested) end
    local remaining = seconds - math.max(0, now_seconds() - started_at)
    if remaining <= 0 then return nil end
    return math.max(1, math.min(HTTP_TIMEOUT_SECONDS, requested, remaining))
end

local function safe_get_json(url, maximum_bytes, request_budget)
    if not is_allowed_url(url) then return nil, "unsafe_url" end

    local timeout = request_timeout(request_budget)
    if not timeout then return nil, "provider_timeout" end

    local ok, response, request_error = pcall(http_client.get, url, {
        timeout = timeout,
        follow_redirects = false,
        verify_ssl = true,
        headers = {
            Accept = "application/json",
            ["User-Agent"] = "Akrams-Steam-Plugin/8.4.0",
        },
    })
    if not ok then return nil, "network_exception:" .. bounded_error(response) end
    if type(response) ~= "table" then
        return nil, "network_unavailable:" .. bounded_error(request_error)
    end
    if tonumber(response.status) ~= 200 then
        return nil, "http_status_" .. tostring(response.status or "unknown")
    end

    local declared_length = header_value(response.headers, "content-length")
    if declared_length ~= nil then
        declared_length = tostring(declared_length):match("^%s*(%d+)%s*$")
        local length_number = declared_length and tonumber(declared_length) or nil
        if not length_number or length_number > maximum_bytes then
            return nil, "response_too_large"
        end
    end

    local body = response.body
    if type(body) ~= "string" or body == "" then return nil, "empty_response" end
    if #body > maximum_bytes then return nil, "response_too_large" end

    local decoded_ok, decoded = pcall(cjson.decode, body)
    if not decoded_ok or type(decoded) ~= "table" then return nil, "invalid_json" end
    return decoded
end

local function cache_directory()
    return paths.backend_path("data/version_catalog")
end

local function cache_path(appid)
    return fs.join(cache_directory(), appid .. ".json")
end

local function clone_depots(depots)
    local result = {}
    for _, depot in ipairs(depots or {}) do
        result[#result + 1] = {
            depotId = depot.depotId,
            manifestId = depot.manifestId,
        }
    end
    return result
end

local function depot_manifest_signature(depots)
    local values = {}
    for _, depot in ipairs(depots or {}) do
        values[#values + 1] = depot.depotId .. "=" .. depot.manifestId
    end
    return table.concat(values, "|")
end

local function normalize_version_depots(raw_depots, expected_ids)
    local count = dense_array_length(raw_depots)
    if not count or count < 1 or count > MAX_DEPOTS then return nil end

    local result = {}
    local seen = {}
    for index = 1, count do
        local raw = raw_depots[index]
        if type(raw) ~= "table" then return nil end
        local depot_id = normalize_decimal_string(raw.depotId, UINT32_MAX, false)
        local manifest_id = normalize_decimal_string(raw.manifestId, UINT64_MAX, false)
        if not depot_id or not manifest_id or seen[depot_id] then return nil end
        seen[depot_id] = true
        result[#result + 1] = { depotId = depot_id, manifestId = manifest_id }
    end
    table.sort(result, function(left, right) return decimal_less(left.depotId, right.depotId) end)
    return result
end

local function build_commit_url(sha)
    return GITEA_ORIGIN .. "/Sainan/steam-pics/commit/" .. sha
end

local function sanitize_cached_version(raw, expected_ids)
    if type(raw) ~= "table" then return nil end
    local sha = normalize_sha(raw.commitSha)
    local build_id = normalize_decimal_string(raw.buildId, UINT64_MAX, false)
    local timestamp = normalize_timestamp(raw.timestamp)
    local depots = normalize_version_depots(raw.depots, expected_ids)
    if not sha or not build_id or not timestamp or not depots then return nil end

    local commit_date = nil
    if raw.commitDate ~= nil then
        commit_date = normalize_iso8601(raw.commitDate)
        if not commit_date then return nil end
    end

    local change_id = nil
    if raw.changeId ~= nil then
        change_id = normalize_decimal_string(raw.changeId, UINT64_MAX, false)
        if not change_id then return nil end
    end

    return {
        id = SOURCE_NAME .. ":" .. sha,
        source = SOURCE_NAME,
        buildId = build_id,
        timestamp = timestamp,
        commitSha = sha,
        commitDate = commit_date,
        commitUrl = build_commit_url(sha),
        changeId = change_id,
        depots = depots,
        signature = depot_manifest_signature(depots),
        completeSnapshot = raw.completeSnapshot == true,
        completenessEvidence = raw.completeSnapshot == true and
            bounded_error(raw.completenessEvidence or "cached-explicit") or nil,
    }
end

local function sanitize_cached_versions(raw_versions, expected_ids)
    local count = dense_array_length(raw_versions)
    if not count or count > MAX_VERSIONS then return nil end

    local versions = {}
    local seen = {}
    for index = 1, count do
        local version = sanitize_cached_version(raw_versions[index], expected_ids)
        if not version or seen[version.signature] then return nil end
        seen[version.signature] = true
        versions[#versions + 1] = version
    end
    return versions
end

local function serialize_version(version)
    return {
        buildId = version.buildId,
        timestamp = version.timestamp,
        commitSha = version.commitSha,
        commitDate = version.commitDate,
        changeId = version.changeId,
        depots = clone_depots(version.depots),
        completeSnapshot = version.completeSnapshot == true,
        completenessEvidence = version.completenessEvidence,
    }
end

local function clone_version(version)
    local result = serialize_version(version)
    result.id = SOURCE_NAME .. ":" .. version.commitSha
    result.source = SOURCE_NAME
    result.commitUrl = build_commit_url(version.commitSha)
    result.signature = version.signature
    return result
end

local function public_version(version)
    local result = clone_version(version)
    result.signature = nil
    return result
end

local function read_cache_document(appid)
    local path = cache_path(appid)
    local exists_ok, exists = pcall(fs.exists, path)
    if not exists_ok or not exists then return { entries = {} }, exists_ok and nil or "cache_stat_failed" end

    if type(fs.file_size) == "function" then
        local size_ok, size = pcall(fs.file_size, path)
        if not size_ok or type(size) ~= "number" or size < 0 or size > MAX_CACHE_BYTES then
            return { entries = {} }, "cache_size_invalid"
        end
    end

    local read_ok, content = pcall(m_utils.read_file, path)
    if not read_ok or type(content) ~= "string" or content == "" or #content > MAX_CACHE_BYTES then
        return { entries = {} }, "cache_read_failed"
    end

    local decode_ok, raw = pcall(cjson.decode, content)
    if not decode_ok or type(raw) ~= "table" or tonumber(raw.schemaVersion) ~= SCHEMA_VERSION or
        normalize_decimal_string(raw.appid, UINT32_MAX, false) ~= appid then
        return { entries = {} }, "cache_invalid"
    end

    local entry_count = dense_array_length(raw.entries)
    if not entry_count or entry_count > MAX_CACHE_QUERIES then
        return { entries = {} }, "cache_invalid"
    end

    local document = { entries = {} }
    local seen_queries = {}
    for index = 1, entry_count do
        local raw_entry = raw.entries[index]
        if type(raw_entry) == "table" and type(raw_entry.fetchedAt) == "number" and
            raw_entry.fetchedAt >= 0 and raw_entry.fetchedAt == math.floor(raw_entry.fetchedAt) then
            local depot_ids = normalize_depot_ids(raw_entry.depotIds, false)
            local versions = depot_ids and sanitize_cached_versions(raw_entry.versions, depot_ids) or nil
            if depot_ids and versions then
                local signature = depot_query_signature(depot_ids)
                if not seen_queries[signature] then
                    seen_queries[signature] = true
                    document.entries[#document.entries + 1] = {
                        depotIds = depot_ids,
                        fetchedAt = raw_entry.fetchedAt,
                        versions = versions,
                    }
                end
            end
        end
    end
    return document
end

local function find_cache_entry(document, depot_ids)
    for _, entry in ipairs(document.entries or {}) do
        if same_depot_ids(entry.depotIds, depot_ids) then return entry end
    end
    return nil
end

local function write_cache_entry(appid, document, entry)
    local entries = {
        {
            depotIds = copy_strings(entry.depotIds),
            fetchedAt = entry.fetchedAt,
            versions = {},
        },
    }
    for _, version in ipairs(entry.versions) do
        entries[1].versions[#entries[1].versions + 1] = serialize_version(version)
    end

    for _, old_entry in ipairs(document.entries or {}) do
        if #entries >= MAX_CACHE_QUERIES then break end
        if not same_depot_ids(old_entry.depotIds, entry.depotIds) then
            local stored = {
                depotIds = copy_strings(old_entry.depotIds),
                fetchedAt = old_entry.fetchedAt,
                versions = {},
            }
            for _, version in ipairs(old_entry.versions) do
                stored.versions[#stored.versions + 1] = serialize_version(version)
            end
            entries[#entries + 1] = stored
        end
    end

    local encode_ok, content = pcall(cjson.encode, {
        schemaVersion = SCHEMA_VERSION,
        appid = appid,
        entries = entries,
    })
    if not encode_ok or type(content) ~= "string" or #content > MAX_CACHE_BYTES then
        return false, "cache_encode_failed"
    end

    local directory = cache_directory()
    local exists_ok, exists = pcall(fs.exists, directory)
    if not exists_ok then return false, "cache_directory_stat_failed" end
    if not exists then
        local create_ok, created, create_error = pcall(fs.create_directories, directory)
        if not create_ok or created == false or not fs.exists(directory) then
            return false, "cache_directory_create_failed:" .. bounded_error(create_error or created)
        end
    end

    local target_path = cache_path(appid)
    local write_ok, wrote, write_error = pcall(m_utils.write_file, target_path, content)
    if not write_ok or wrote == false or not fs.exists(target_path) then
        return false, "cache_write_failed:" .. bounded_error(write_error or wrote)
    end
    return true
end

local function parse_change_id(message, appid)
    if type(message) ~= "string" or #message > 1024 then return nil end
    local change_id, message_appid = message:match("Change%s+(%d+)%s+%(appId=(%d+)")
    if not change_id or normalize_decimal_string(message_appid, UINT32_MAX, false) ~= appid then return nil end
    return normalize_decimal_string(change_id, UINT64_MAX, false)
end

local function parse_commits(raw, appid)
    local count = dense_array_length(raw)
    if not count then return nil, "commit_list_not_array" end

    local commits = {}
    local seen = {}
    local process_count = math.min(count, MAX_COMMITS)
    for index = 1, process_count do
        local item = raw[index]
        if type(item) ~= "table" then return nil, "invalid_commit_entry" end
        local sha = normalize_sha(item.sha)
        local nested = type(item.commit) == "table" and item.commit or {}
        local author = type(nested.author) == "table" and nested.author or {}
        local commit_date = normalize_iso8601(item.created) or normalize_iso8601(author.date)
        if not sha or not commit_date or seen[sha] then return nil, "invalid_commit_entry" end
        seen[sha] = true
        commits[#commits + 1] = {
            sha = sha,
            date = commit_date,
            changeId = parse_change_id(nested.message, appid),
        }
    end
    return commits
end

local function commit_list_url(appid)
    return REPOSITORY_API .. "/commits?path=appinfo%2F" .. appid ..
        ".json&page=1&limit=" .. tostring(MAX_COMMITS)
end

local function raw_snapshot_url(appid, sha)
    return REPOSITORY_RAW .. "/" .. sha .. "/appinfo/" .. appid .. ".json"
end

local function parse_snapshot(raw, appid, depot_ids, commit)
    if type(raw) ~= "table" or normalize_decimal_string(raw.appid, UINT32_MAX, false) ~= appid then
        return nil, "snapshot_appid_mismatch"
    end
    if type(raw.depots) ~= "table" then return nil, "snapshot_missing_depots" end

    local branches = raw.depots.branches
    local public_branch = type(branches) == "table" and branches.public or nil
    if type(public_branch) ~= "table" then return nil, "snapshot_not_actionable" end

    local build_id = normalize_decimal_string(public_branch.buildid, UINT64_MAX, false)
    if not build_id then return nil, "snapshot_invalid_build" end
    local timestamp = normalize_timestamp(public_branch.timeupdated) or
        normalize_timestamp(public_branch.timebuildupdated) or commit.date

    local depots = {}
    local seen_depots = {}
    local complete_snapshot = true
    for raw_depot_id, raw_depot in pairs(raw.depots) do
        local depot_id = normalize_decimal_string(tostring(raw_depot_id), UINT32_MAX, false)
        if depot_id then
            local manifests = type(raw_depot) == "table" and raw_depot.manifests or nil
            local public_manifest = type(manifests) == "table" and manifests.public or nil
            -- The document may be a full appinfo snapshot while still lacking
            -- an actionable public manifest for one numeric depot.  Retain the
            -- usable manifests, but never claim the resulting candidate is a
            -- complete deletion-safe topology.
            if public_manifest == nil or type(public_manifest) ~= "table" then
                complete_snapshot = false
            else
                local manifest_id = normalize_decimal_string(public_manifest.gid, UINT64_MAX, false)
                if not manifest_id or seen_depots[depot_id] then
                    complete_snapshot = false
                elseif #depots < MAX_DEPOTS then
                    seen_depots[depot_id] = true
                    depots[#depots + 1] = { depotId = depot_id, manifestId = manifest_id }
                else
                    complete_snapshot = false
                end
            end
        end
    end
    if #depots == 0 then return nil, "snapshot_not_actionable" end
    table.sort(depots, function(left, right) return decimal_less(left.depotId, right.depotId) end)

    return {
        id = SOURCE_NAME .. ":" .. commit.sha,
        source = SOURCE_NAME,
        buildId = build_id,
        timestamp = timestamp,
        commitSha = commit.sha,
        commitDate = commit.date,
        commitUrl = build_commit_url(commit.sha),
        changeId = commit.changeId,
        depots = depots,
        signature = depot_manifest_signature(depots),
        completeSnapshot = complete_snapshot,
        completenessEvidence = complete_snapshot and "steam-pics-appinfo-public" or nil,
    }
end

local function make_success(appid, depot_ids, versions, source, fetched_at, stale, warning)
    local public_versions = {}
    for _, version in ipairs(versions or {}) do
        public_versions[#public_versions + 1] = public_version(version)
    end
    return {
        success = true,
        appid = appid,
        depotIds = copy_strings(depot_ids),
        versions = public_versions,
        source = source,
        cached = source == "cache",
        stale = stale == true,
        fetchedAt = fetched_at,
        warning = warning,
    }
end

local function finish_gitea_continuation(continuation)
    local warning = #continuation.warnings > 0 and
        ("partial_snapshot_failures:" .. table.concat(continuation.warnings, ","):sub(1, 200)) or nil
    if #continuation.versions == 0 then
        if continuation.cacheStaleUsable and continuation.cachedEntry then
            return make_success(
                continuation.appid,
                continuation.depotIds,
                continuation.cachedEntry.versions,
                "cache",
                continuation.cachedEntry.fetchedAt,
                true,
                "network_refresh_failed:" .. bounded_error(warning or "no_history")
            )
        end
        return failure("catalog_unavailable", warning or "no_history",
            continuation.appid, continuation.depotIds)
    end

    local fetched_at = now_seconds()
    local new_entry = {
        depotIds = copy_strings(continuation.depotIds),
        fetchedAt = fetched_at,
        versions = continuation.versions,
    }
    local cache_ok, write_error = write_cache_entry(
        continuation.appid,
        continuation.cacheDocument,
        new_entry
    )
    if not cache_ok then
        logger.warn("VersionCatalog: could not persist staged cache for " .. continuation.appid ..
            " (" .. bounded_error(write_error) .. ")")
    end
    return make_success(
        continuation.appid,
        continuation.depotIds,
        continuation.versions,
        "network",
        fetched_at,
        false,
        warning or (cache_ok and continuation.cacheWarning or write_error)
    )
end

-- Cooperative steam-pics reader.  Each invocation performs at most one HTTP
-- request: first the commit page, then at most one snapshot per continuation
-- step.  The opaque continuation never leaves the in-memory catalog job.
local function poll_gitea_versions(appid, depot_ids, options)
    options = options or {}
    local continuation = options.continuation
    if continuation ~= nil then
        if type(continuation) ~= "table" or continuation.kind ~= "gitea-catalog-v1" or
            continuation.appid ~= appid or
            not same_depot_ids(continuation.depotIds, depot_ids) then
            return failure("catalog_continuation_invalid", nil, appid, depot_ids)
        end

        if continuation.index > #continuation.commits or
            #continuation.versions >= MAX_VERSIONS then
            return finish_gitea_continuation(continuation)
        end

        local commit = continuation.commits[continuation.index]
        local version = continuation.cachedBySha[commit.sha]
        if version then
            version = clone_version(version)
        else
            local raw_snapshot, fetch_error = safe_get_json(
                raw_snapshot_url(appid, commit.sha),
                MAX_SNAPSHOT_BYTES,
                options.requestBudget
            )
            if not raw_snapshot then
                continuation.warnings[#continuation.warnings + 1] =
                    commit.sha:sub(1, 8) .. ":" .. bounded_error(fetch_error)
            else
                local snapshot_error
                version, snapshot_error = parse_snapshot(raw_snapshot, appid, depot_ids, commit)
                if not version and snapshot_error ~= "snapshot_not_actionable" then
                    continuation.warnings[#continuation.warnings + 1] =
                        commit.sha:sub(1, 8) .. ":" .. bounded_error(snapshot_error)
                end
            end
        end

        if version and not continuation.seenSignatures[version.signature] then
            continuation.seenSignatures[version.signature] = true
            continuation.versions[#continuation.versions + 1] = version
        end
        continuation.index = continuation.index + 1
        if continuation.index > #continuation.commits or
            #continuation.versions >= MAX_VERSIONS then
            return finish_gitea_continuation(continuation)
        end
        return {
            success = true,
            pending = true,
            continuation = continuation,
            detail = "snapshot=" .. tostring(continuation.index - 1) .. "/" ..
                tostring(math.min(#continuation.commits, MAX_VERSIONS)),
        }
    end

    local ttl = normalize_ttl(options)
    if not ttl then return failure("invalid_options", nil, appid, depot_ids) end
    local cache_document, cache_warning = read_cache_document(appid)
    local cached_entry = find_cache_entry(cache_document, depot_ids)
    local now = now_seconds()
    local cache_age = cached_entry and (now - cached_entry.fetchedAt) or nil
    local cache_fresh = cached_entry ~= nil and ttl > 0 and cache_age >= 0 and cache_age <= ttl
    local cache_stale_usable = cached_entry ~= nil and cache_age >= 0 and
        cache_age <= version_sources.STALE_SECONDS
    if cached_entry and cache_fresh and options.forceRefresh ~= true then
        return make_success(appid, depot_ids, cached_entry.versions, "cache",
            cached_entry.fetchedAt, false, cache_warning)
    end

    local raw_commits, list_error = safe_get_json(
        commit_list_url(appid),
        MAX_COMMIT_LIST_BYTES,
        options.requestBudget
    )
    if not raw_commits then
        if cached_entry and cache_stale_usable then
            return make_success(appid, depot_ids, cached_entry.versions, "cache",
                cached_entry.fetchedAt, not cache_fresh,
                "network_refresh_failed:" .. bounded_error(list_error))
        end
        return failure("catalog_unavailable", list_error, appid, depot_ids)
    end
    local commits, parse_error = parse_commits(raw_commits, appid)
    if not commits then return failure("catalog_unavailable", parse_error, appid, depot_ids) end

    local cached_by_sha = {}
    for _, version in ipairs(cached_entry and cached_entry.versions or {}) do
        cached_by_sha[version.commitSha] = version
    end
    continuation = {
        kind = "gitea-catalog-v1",
        appid = appid,
        depotIds = copy_strings(depot_ids),
        commits = commits,
        index = 1,
        versions = {},
        seenSignatures = {},
        warnings = {},
        cachedBySha = cached_by_sha,
        cachedEntry = cached_entry,
        cacheDocument = cache_document,
        cacheWarning = cache_warning,
        cacheStaleUsable = cache_stale_usable,
    }
    if #commits == 0 then return finish_gitea_continuation(continuation) end
    return {
        success = true,
        pending = true,
        continuation = continuation,
        detail = "commit_list_ready",
    }
end

function version_catalog.get_versions(appid, depot_ids, options)
    local normalized_appid = normalize_input_uint32(appid)
    if not normalized_appid then return failure("invalid_appid") end

    local normalized_depots, depot_error = normalize_depot_ids(depot_ids, true)
    if not normalized_depots then
        return failure("invalid_depot_ids", depot_error, normalized_appid)
    end

    local ttl = normalize_ttl(options)
    if not ttl then
        return failure("invalid_options", "ttlSeconds must be an integer between 0 and " ..
            tostring(MAX_TTL_SECONDS), normalized_appid, normalized_depots)
    end
    options = options or {}
    local boolean_options = {
        "forceRefresh",
        "allowSteamDb",
        "allowGitea",
        "expandSources",
    }
    for _, option_name in ipairs(boolean_options) do
        if options[option_name] ~= nil and type(options[option_name]) ~= "boolean" then
            return failure("invalid_options", option_name .. " must be boolean",
                normalized_appid, normalized_depots)
        end
    end

    -- Seed the cooperative job from the legacy steam-pics cache before any
    -- provider poll.  This keeps upgrades migration-safe: an existing cache
    -- is returned by the initial RPC even when the newer aggregate provider
    -- cache has not been created yet.
    local cache_document, cache_warning = read_cache_document(normalized_appid)
    local cached_entry = find_cache_entry(cache_document, normalized_depots)
    local cached_candidates = nil
    local cached_fetched_at = nil
    if cached_entry then
        local age = now_seconds() - cached_entry.fetchedAt
        if age >= 0 and age <= version_sources.STALE_SECONDS then
            cached_candidates = {}
            for _, version in ipairs(cached_entry.versions) do
                local candidate = public_version(version)
                -- Legacy cache entries predate the compatibility envelope.
                -- They were produced only from parsed steam-pics snapshots;
                -- mark the claim verified here, then let version_sources
                -- downgrade it to Force unless completeSnapshot evidence and
                -- exact current topology are both present.
                candidate.compatibility = { status = "verified", reasons = {} }
                cached_candidates[#cached_candidates + 1] = candidate
            end
            cached_fetched_at = cached_entry.fetchedAt
        end
    end

    local source_options = {
        ttlSeconds = ttl,
        forceRefresh = options.forceRefresh,
        allowSteamDb = options.allowSteamDb,
        allowGitea = options.allowGitea,
        expandSources = options.expandSources,
        officialVersions = options.officialVersions,
        officialCandidates = options.officialCandidates,
        localVersions = options.localVersions,
        localCandidates = options.localCandidates,
        cachedCandidates = cached_candidates,
        cachedFetchedAt = cached_fetched_at,
        cachedWarning = cache_warning,
    }
    return version_sources.start_discovery(normalized_appid, normalized_depots, source_options, {
        gitea = function(provider_options)
            return poll_gitea_versions(normalized_appid, normalized_depots, provider_options)
        end,
    })
end

-- Polling advances at most one remote provider step.  SteamDB advances one
-- depot page per call; steam-pics gets one strict request-budget window.  A
-- status read never performs network I/O.
function version_catalog.poll_catalog(job_id)
    return version_sources.poll_discovery(job_id)
end

function version_catalog.get_catalog_status(job_id)
    return version_sources.get_discovery(job_id)
end

function version_catalog.cancel_catalog(job_id)
    return version_sources.cancel_discovery(job_id)
end

version_catalog.list_versions = version_catalog.get_versions

return version_catalog
