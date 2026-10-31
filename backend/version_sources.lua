local cjson = require("json")
local fs = require("fs")
local http_client = require("http_client")
local paths = require("paths")
local m_utils = require("utils")

local version_sources = {}

local CACHE_SCHEMA_VERSION = 1
local UINT32_MAX = "4294967295"
local UINT64_MAX = "18446744073709551615"
local MAX_DEPOTS = 64
local MAX_CANDIDATES = 24
local MAX_CACHE_BYTES = 1024 * 1024
local FRESH_SECONDS = 24 * 60 * 60
local STALE_SECONDS = 30 * 24 * 60 * 60
local REQUEST_TIMEOUT_SECONDS = 6
local PROVIDER_BUDGET_SECONDS = 12
local GITEA_CIRCUIT_SECONDS = 30 * 60

local gitea_circuit_open_until = 0

version_sources.FRESH_SECONDS = FRESH_SECONDS
version_sources.STALE_SECONDS = STALE_SECONDS
version_sources.REQUEST_TIMEOUT_SECONDS = REQUEST_TIMEOUT_SECONDS
version_sources.PROVIDER_BUDGET_SECONDS = PROVIDER_BUDGET_SECONDS
version_sources.GITEA_CIRCUIT_SECONDS = GITEA_CIRCUIT_SECONDS

local function bounded(value, limit)
    local text = tostring(value or "unknown_error"):gsub("[%c]", " ")
    return text:sub(1, limit or 240)
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

local function decimal_compare(left, right)
    if #left ~= #right then return #left < #right and -1 or 1 end
    if left == right then return 0 end
    return left < right and -1 or 1
end

local function normalize_decimal(value, maximum, allow_zero)
    if type(value) == "number" then
        if value ~= value or value < 0 or value ~= math.floor(value) then return nil end
        value = string.format("%.0f", value)
    end
    if type(value) ~= "string" or not value:match("^%d+$") then return nil end
    value = value:gsub("^0+", "")
    if value == "" then value = "0" end
    if not allow_zero and value == "0" then return nil end
    if decimal_compare(value, maximum) == 1 then return nil end
    return value
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
    return normalize_decimal(value, UINT64_MAX, true) or normalize_iso8601(value)
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

local function copy_array(values)
    local result = {}
    for _, value in ipairs(values or {}) do result[#result + 1] = value end
    return result
end

local function copy_depots(depots)
    local result = {}
    for _, depot in ipairs(depots or {}) do
        result[#result + 1] = {
            depotId = depot.depotId,
            manifestId = depot.manifestId,
        }
    end
    return result
end

local function depot_signature(depots)
    local parts = {}
    for _, depot in ipairs(depots or {}) do
        parts[#parts + 1] = depot.depotId .. "=" .. depot.manifestId
    end
    return table.concat(parts, "|")
end

local function expected_depot_set(depot_ids)
    local result = {}
    for _, depot_id in ipairs(depot_ids) do result[depot_id] = true end
    return result
end

local function normalize_candidate_depots(raw_depots, depot_ids, allow_partial)
    local count = dense_array_length(raw_depots)
    if not count or count < 1 or count > MAX_DEPOTS then return nil end

    local result = {}
    local seen = {}
    for index = 1, count do
        local raw = raw_depots[index]
        if type(raw) ~= "table" then return nil end
        local depot_id = normalize_decimal(raw.depotId or raw.depotid, UINT32_MAX, false)
        local manifest_id = normalize_decimal(raw.manifestId or raw.manifestid, UINT64_MAX, false)
        -- Historical app topology is allowed to contain a depot which no
        -- longer exists in the current appmanifest.  It is retained as a
        -- Force-only candidate below instead of being silently discarded.
        if not depot_id or not manifest_id or seen[depot_id] then return nil end
        seen[depot_id] = true
        result[#result + 1] = { depotId = depot_id, manifestId = manifest_id }
    end
    table.sort(result, function(left, right)
        return decimal_compare(left.depotId, right.depotId) == -1
    end)
    if not allow_partial then
        if count ~= #depot_ids then return nil end
        for _, depot_id in ipairs(depot_ids) do
            if not seen[depot_id] then return nil end
        end
    end
    return result
end

local function normalize_reasons(raw)
    local result = {}
    local seen = {}
    local count = dense_array_length(raw)
    if not count then return result end
    for index = 1, math.min(count, 8) do
        local value = raw[index]
        if type(value) == "string" and value:match("^[a-z0-9_%-]+$") and #value <= 64 and not seen[value] then
            seen[value] = true
            result[#result + 1] = value
        end
    end
    return result
end

local function has_reason(reasons, wanted)
    for _, reason in ipairs(reasons) do if reason == wanted then return true end end
    return false
end

local function candidate_id(source, build_id, timestamp, depots)
    local first = depots[1]
    local token = build_id or timestamp or (first and first.manifestId) or "unknown"
    return bounded(source .. ":" .. token .. ":" .. depot_signature(depots), 220)
end

local function sanitize_candidate(raw, source, depot_ids, default_status)
    if type(raw) ~= "table" then return nil end
    local depots = normalize_candidate_depots(raw.depots, depot_ids, true)
    if not depots then return nil end

    local build_id = raw.buildId ~= nil and normalize_decimal(raw.buildId, UINT64_MAX, false) or nil
    local timestamp = raw.timestamp ~= nil and normalize_timestamp(raw.timestamp) or nil
    local branch = type(raw.branch) == "string" and bounded(raw.branch, 96) or nil
    local label = type(raw.label) == "string" and bounded(raw.label, 160) or nil
    local compatibility = type(raw.compatibility) == "table" and raw.compatibility or {}
    local status = compatibility.status
    if status ~= "verified" and status ~= "force" and status ~= "incompatible" then
        status = default_status or "force"
    end
    local reasons = normalize_reasons(compatibility.reasons)
    local complete_snapshot = raw.completeSnapshot == true
    local expected = expected_depot_set(depot_ids)
    local seen_current = {}
    local topology_mismatch = #depots ~= #depot_ids
    for _, depot in ipairs(depots) do
        if expected[depot.depotId] then
            seen_current[depot.depotId] = true
        else
            topology_mismatch = true
        end
    end
    for _, depot_id in ipairs(depot_ids) do
        if not seen_current[depot_id] then topology_mismatch = true end
    end

    if topology_mismatch then
        status = status == "incompatible" and status or "force"
        if not has_reason(reasons, "topology_mismatch") then reasons[#reasons + 1] = "topology_mismatch" end
    end
    if not complete_snapshot then
        if status == "verified" then status = "force" end
        if not has_reason(reasons, "incomplete_snapshot") then reasons[#reasons + 1] = "incomplete_snapshot" end
    end
    if not build_id then
        if status == "verified" then status = "force" end
        if not has_reason(reasons, "build_unverified") then reasons[#reasons + 1] = "build_unverified" end
    end

    local id = raw.candidateId or raw.id
    if type(id) ~= "string" or id == "" or #id > 240 or id:find("[%c]") then
        id = candidate_id(source, build_id, timestamp, depots)
    end

    return {
        candidateId = id,
        id = id,
        source = source,
        buildId = build_id,
        timestamp = timestamp,
        branch = branch,
        label = label,
        depots = depots,
        compatibility = {
            status = status,
            reasons = reasons,
        },
        completeSnapshot = complete_snapshot,
        completenessEvidence = complete_snapshot and
            bounded(raw.completenessEvidence or "explicit", 64) or nil,
        commitSha = type(raw.commitSha) == "string" and raw.commitSha or nil,
        commitDate = type(raw.commitDate) == "string" and raw.commitDate or nil,
        commitUrl = type(raw.commitUrl) == "string" and raw.commitUrl or nil,
        changeId = raw.changeId ~= nil and normalize_decimal(raw.changeId, UINT64_MAX, false) or nil,
    }
end

local function candidate_rank(candidate)
    local status = candidate.compatibility and candidate.compatibility.status
    if status == "verified" then return 3 end
    if status == "force" then return 2 end
    return 1
end

local function merge_candidate(target, candidate)
    local signature = depot_signature(candidate.depots)
    local old_index = target.bySignature[signature]
    if old_index then
        local old = target.items[old_index]
        if candidate_rank(candidate) > candidate_rank(old) then
            target.items[old_index] = candidate
            return true
        end
        return false
    end
    if #target.items >= MAX_CANDIDATES then return false end
    target.items[#target.items + 1] = candidate
    target.bySignature[signature] = #target.items
    return true
end

local function merge_raw_candidates(target, raw_values, source, depot_ids, default_status)
    local count = dense_array_length(raw_values)
    if not count then return 0 end
    local added = 0
    for index = 1, math.min(count, MAX_CANDIDATES) do
        local candidate = sanitize_candidate(raw_values[index], source, depot_ids, default_status)
        if candidate and merge_candidate(target, candidate) then added = added + 1 end
    end
    return added
end

-- A cache is a transport, not the historical source of a candidate.  Keep a
-- validated source label when replaying cached candidates so the UI can still
-- distinguish SteamDB from steam-pics results.  Untrusted/legacy labels fall
-- back to "cache" and all candidate fields are sanitized again.
local function merge_cached_candidates(target, raw_values, depot_ids)
    local count = dense_array_length(raw_values)
    if not count then return 0 end
    local added = 0
    for index = 1, math.min(count, MAX_CANDIDATES) do
        local raw = raw_values[index]
        local source = type(raw) == "table" and raw.source or nil
        if type(source) ~= "string" or #source > 48 or
            not source:match("^[a-z0-9_%-]+$") then
            source = "cache"
        end
        local candidate = sanitize_candidate(raw, source, depot_ids, "force")
        if candidate and merge_candidate(target, candidate) then added = added + 1 end
    end
    return added
end

local function provider_record(id, status, started_at, candidate_count, error, detail)
    local now = now_seconds()
    return {
        id = id,
        status = status,
        candidateCount = candidate_count or 0,
        elapsedSeconds = math.max(0, now - (started_at or now)),
        error = error,
        detail = detail and bounded(detail) or nil,
    }
end

local function cache_directory()
    return paths.backend_path("data/version_catalog")
end

local function cache_path(appid)
    return fs.join(cache_directory(), "providers_" .. appid .. ".json")
end

local function read_cache(appid, depot_ids)
    local path = cache_path(appid)
    local ok, exists = pcall(fs.exists, path)
    if not ok or not exists then return nil, ok and nil or "cache_stat_failed" end
    if type(fs.file_size) == "function" then
        local size_ok, size = pcall(fs.file_size, path)
        if not size_ok or type(size) ~= "number" or size < 0 or size > MAX_CACHE_BYTES then
            return nil, "cache_size_invalid"
        end
    end
    local read_ok, content = pcall(m_utils.read_file, path)
    if not read_ok or type(content) ~= "string" or content == "" or #content > MAX_CACHE_BYTES then
        return nil, "cache_read_failed"
    end
    local decode_ok, raw = pcall(cjson.decode, content)
    if not decode_ok or type(raw) ~= "table" or tonumber(raw.schemaVersion) ~= CACHE_SCHEMA_VERSION or
        normalize_decimal(raw.appid, UINT32_MAX, false) ~= appid or type(raw.fetchedAt) ~= "number" or
        raw.fetchedAt < 0 or raw.fetchedAt ~= math.floor(raw.fetchedAt) then
        return nil, "cache_invalid"
    end
    local cached_ids = raw.depotIds
    local count = dense_array_length(cached_ids)
    if not count or count ~= #depot_ids then return nil, "cache_query_mismatch" end
    for index = 1, count do
        if normalize_decimal(cached_ids[index], UINT32_MAX, false) ~= depot_ids[index] then
            return nil, "cache_query_mismatch"
        end
    end
    local collection = { items = {}, bySignature = {} }
    local candidate_count = dense_array_length(raw.candidates)
    if not candidate_count then return nil, "cache_invalid" end
    for index = 1, math.min(candidate_count, MAX_CANDIDATES) do
        local raw_candidate = raw.candidates[index]
        local source = type(raw_candidate) == "table" and raw_candidate.source or nil
        if type(source) ~= "string" or not source:match("^[a-z0-9_%-]+$") then source = "cache" end
        local candidate = sanitize_candidate(raw_candidate, source, depot_ids, "force")
        if candidate then merge_candidate(collection, candidate) end
    end
    if #collection.items == 0 then return nil, "cache_empty" end
    return { fetchedAt = raw.fetchedAt, candidates = collection.items }
end

local function write_cache(appid, depot_ids, candidates, fetched_at)
    local stored = {}
    for _, candidate in ipairs(candidates) do
        stored[#stored + 1] = {
            candidateId = candidate.candidateId,
            source = candidate.source,
            buildId = candidate.buildId,
            timestamp = candidate.timestamp,
            branch = candidate.branch,
            label = candidate.label,
            depots = copy_depots(candidate.depots),
            compatibility = {
                status = candidate.compatibility.status,
                reasons = copy_array(candidate.compatibility.reasons),
            },
            completeSnapshot = candidate.completeSnapshot == true,
            completenessEvidence = candidate.completenessEvidence,
            commitSha = candidate.commitSha,
            commitDate = candidate.commitDate,
            commitUrl = candidate.commitUrl,
            changeId = candidate.changeId,
        }
    end
    local encode_ok, content = pcall(cjson.encode, {
        schemaVersion = CACHE_SCHEMA_VERSION,
        appid = appid,
        depotIds = copy_array(depot_ids),
        fetchedAt = fetched_at,
        candidates = stored,
    })
    if not encode_ok or type(content) ~= "string" or #content > MAX_CACHE_BYTES then
        return false, "cache_encode_failed"
    end
    local directory = cache_directory()
    local exists_ok, exists = pcall(fs.exists, directory)
    if not exists_ok then return false, "cache_directory_stat_failed" end
    if not exists then
        local create_ok, created = pcall(fs.create_directories, directory)
        if not create_ok or created == false then return false, "cache_directory_create_failed" end
    end
    local target = cache_path(appid)
    local write_ok, wrote = pcall(m_utils.write_file, target, content)
    if not write_ok or wrote == false then return false, "cache_write_failed" end
    return true
end

local function provider_budget(seconds)
    return {
        startedAt = now_seconds(),
        seconds = seconds or PROVIDER_BUDGET_SECONDS,
        requestTimeout = REQUEST_TIMEOUT_SECONDS,
    }
end

local function remaining_budget(budget)
    return budget.seconds - math.max(0, now_seconds() - budget.startedAt)
end

local function steamdb_url(depot_id)
    return "https://steamdb.info/depot/" .. depot_id .. "/manifests/"
end

local function html_unescape(text)
    return tostring(text or "")
        :gsub("&amp;", "&")
        :gsub("&quot;", '"')
        :gsub("&#39;", "'")
        :gsub("&lt;", "<")
        :gsub("&gt;", ">")
end

local function strip_tags(text)
    return bounded(html_unescape(tostring(text or ""):gsub("<[^>]->", "")):gsub("^%s+", ""):gsub("%s+$", ""), 96)
end

local function safe_get_steamdb(url, budget)
    if type(url) ~= "string" or #url > 2048 or
        not url:match("^https://steamdb%.info/depot/%d+/manifests/$") then
        return nil, "unsafe_url"
    end
    local remaining = remaining_budget(budget)
    if remaining <= 0 then return nil, "provider_timeout" end
    local timeout = math.max(1, math.min(budget.requestTimeout, remaining))
    local ok, response, request_error = pcall(http_client.get, url, {
        timeout = timeout,
        follow_redirects = false,
        verify_ssl = true,
        headers = {
            Accept = "text/html,application/xhtml+xml",
            ["User-Agent"] = "Akrams-Steam-Plugin/8.4.0",
        },
    })
    if not ok then return nil, "network_exception:" .. bounded(response) end
    if type(response) ~= "table" then return nil, "network_unavailable:" .. bounded(request_error) end
    if tonumber(response.status) ~= 200 then return nil, "http_status_" .. tostring(response.status or "unknown") end
    local body = response.body
    if type(body) ~= "string" or body == "" then return nil, "empty_response" end
    if #body > MAX_CACHE_BYTES then return nil, "response_too_large" end
    return body
end

local function parse_steamdb_manifest_rows(html)
    local rows = {}
    local seen = {}
    local compact = tostring(html or ""):gsub("[\r\n]", " ")
    for row in compact:gmatch("<[tT][rR][^>]*>(.-)</[tT][rR]>") do
        local manifest_id = row:match("data%-manifest%-?id=[\"'](%d+)[\"']") or
            row:match("/manifest/(%d+)") or row:match(">(%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d+)<")
        manifest_id = normalize_decimal(manifest_id, UINT64_MAX, false)
        if manifest_id and not seen[manifest_id] then
            local timestamp = normalize_timestamp(row:match("datetime=[\"']([^\"']+)[\"']")) or
                normalize_timestamp(row:match("data%-time=[\"'](%d+)[\"']"))
            local branch = row:match("<[cC][oO][dD][eE][^>]*>(.-)</[cC][oO][dD][eE]>")
            rows[#rows + 1] = {
                manifestId = manifest_id,
                timestamp = timestamp,
                branch = branch and strip_tags(branch) or nil,
            }
            seen[manifest_id] = true
            if #rows >= MAX_CANDIDATES then break end
        end
    end
    return rows
end

local function build_steamdb_candidates(appid, depot_ids, histories, warnings)
    local anchor_id
    for _, depot_id in ipairs(depot_ids) do
        if histories[depot_id] then anchor_id = depot_id break end
    end
    if not anchor_id then return {}, table.concat(warnings, ",") end

    local candidates = {}
    local anchor = histories[anchor_id]
    for index = 1, math.min(#anchor, MAX_CANDIDATES) do
        local depots = {}
        local branch = anchor[index].branch
        local timestamp = anchor[index].timestamp
        for _, depot_id in ipairs(depot_ids) do
            local history = histories[depot_id]
            local item = history and history[index] or nil
            if item then
                depots[#depots + 1] = { depotId = depot_id, manifestId = item.manifestId }
                timestamp = timestamp or item.timestamp
                branch = branch or item.branch
            end
        end
        local reasons = { "build_unverified" }
        if #depot_ids > 1 then reasons[#reasons + 1] = "manifest_alignment_unverified" end
        if #depots ~= #depot_ids then reasons[#reasons + 1] = "topology_mismatch" end
        candidates[#candidates + 1] = {
            candidateId = "steamdb:" .. appid .. ":" .. anchor[index].manifestId,
            source = "steamdb",
            timestamp = timestamp,
            branch = branch,
            depots = depots,
            compatibility = { status = "force", reasons = reasons },
            completeSnapshot = false,
        }
    end
    return candidates, #warnings > 0 and table.concat(warnings, ",") or nil
end

local function count_verified(candidates)
    local count = 0
    for _, candidate in ipairs(candidates) do
        if candidate.compatibility.status == "verified" then count = count + 1 end
    end
    return count
end

local function public_versions(candidates)
    local result = {}
    for _, candidate in ipairs(candidates) do
        if candidate.compatibility.status == "verified" and candidate.buildId and candidate.timestamp then
            result[#result + 1] = {
                id = candidate.candidateId,
                candidateId = candidate.candidateId,
                source = candidate.source,
                buildId = candidate.buildId,
                timestamp = candidate.timestamp,
                branch = candidate.branch,
                label = candidate.label,
                depots = copy_depots(candidate.depots),
                compatibility = {
                    status = candidate.compatibility.status,
                    reasons = copy_array(candidate.compatibility.reasons),
                },
                completeSnapshot = candidate.completeSnapshot == true,
                completenessEvidence = candidate.completenessEvidence,
                commitSha = candidate.commitSha,
                commitDate = candidate.commitDate,
                commitUrl = candidate.commitUrl,
                changeId = candidate.changeId,
            }
        end
    end
    return result
end

local function contains_timeout(value)
    value = tostring(value or ""):lower()
    return value:find("timeout", 1, true) ~= nil or value:find("timed out", 1, true) ~= nil
end

local function should_open_circuit(result)
    if type(result) ~= "table" or result.success == true then return false end
    local error_text = tostring(result.error or "") .. ":" .. tostring(result.detail or "")
    return contains_timeout(error_text) or error_text:find("network_", 1, true) ~= nil or
        error_text:find("http_status_429", 1, true) ~= nil or
        error_text:match("http_status_5%d%d") ~= nil
end

local CATALOG_JOB_TTL_SECONDS = 5 * 60
local MAX_CATALOG_JOBS = 32
local catalog_jobs = {}
local catalog_job_order = {}
local catalog_sequence = 0

version_sources.CATALOG_JOB_TTL_SECONDS = CATALOG_JOB_TTL_SECONDS

local function clone_candidate(candidate)
    return {
        candidateId = candidate.candidateId,
        id = candidate.id,
        source = candidate.source,
        buildId = candidate.buildId,
        timestamp = candidate.timestamp,
        branch = candidate.branch,
        label = candidate.label,
        depots = copy_depots(candidate.depots),
        compatibility = {
            status = candidate.compatibility.status,
            reasons = copy_array(candidate.compatibility.reasons),
        },
        completeSnapshot = candidate.completeSnapshot == true,
        completenessEvidence = candidate.completenessEvidence,
        commitSha = candidate.commitSha,
        commitDate = candidate.commitDate,
        commitUrl = candidate.commitUrl,
        changeId = candidate.changeId,
    }
end

local function clone_candidates(candidates)
    local result = {}
    for _, candidate in ipairs(candidates or {}) do result[#result + 1] = clone_candidate(candidate) end
    return result
end

local function clone_providers(providers)
    local result = {}
    for _, provider in ipairs(providers or {}) do
        result[#result + 1] = {
            id = provider.id,
            status = provider.status,
            candidateCount = provider.candidateCount,
            elapsedSeconds = provider.elapsedSeconds,
            error = provider.error,
            detail = provider.detail,
        }
    end
    return result
end

local function warning_text(job)
    return #job.warnings > 0 and table.concat(job.warnings, ";") or nil
end

local function make_job_result(job)
    local pending = job.status == "pending" or job.status == "running"
    local candidates = clone_candidates(job.collection.items)
    local has_candidates = #candidates > 0
    local error_code = nil
    if not has_candidates and not pending then
        error_code = job.status == "cancelled" and "catalog_cancelled" or "catalog_unavailable"
    end
    local warning = warning_text(job)
    local completed_steps, total_steps
    if job.phase == "steamdb" then
        total_steps = math.min(#job.depotIds, 8)
        completed_steps = math.max(0, math.min((job.steamdbIndex or 1) - 1, total_steps))
    elseif job.phase == "steam-pics" and type(job.giteaContinuation) == "table" then
        total_steps = math.min(#(job.giteaContinuation.commits or {}), 12) + 1
        completed_steps = math.min(job.giteaContinuation.index or 1, total_steps)
    end
    return {
        success = has_candidates or pending,
        error = error_code,
        detail = error_code and warning or nil,
        appid = job.appid,
        depotIds = copy_array(job.depotIds),
        candidates = candidates,
        versions = public_versions(candidates),
        providers = clone_providers(job.providers),
        source = job.source,
        cached = job.source == "cache",
        stale = job.stale == true,
        fetchedAt = job.fetchedAt,
        warning = (has_candidates or pending) and warning or nil,
        catalogJobId = job.id,
        catalogState = job.status,
        catalogPending = pending,
        jobState = {
            status = job.status,
            nextProvider = job.phase,
            startedAt = job.startedAt,
            updatedAt = job.updatedAt,
            expiresAt = job.expiresAt,
            pollCount = job.pollCount or 0,
            completedSteps = completed_steps,
            totalSteps = total_steps,
        },
    }
end

local function remove_job(job_id)
    catalog_jobs[job_id] = nil
    for index = #catalog_job_order, 1, -1 do
        if catalog_job_order[index] == job_id then table.remove(catalog_job_order, index) end
    end
end

local function cleanup_jobs(maximum_jobs)
    local now = now_seconds()
    for index = #catalog_job_order, 1, -1 do
        local id = catalog_job_order[index]
        local job = catalog_jobs[id]
        if not job or now >= job.expiresAt then
            catalog_jobs[id] = nil
            table.remove(catalog_job_order, index)
        end
    end
    maximum_jobs = maximum_jobs or MAX_CATALOG_JOBS
    while #catalog_job_order > maximum_jobs do
        remove_job(catalog_job_order[1])
    end
end

local function next_job_id(appid)
    catalog_sequence = catalog_sequence + 1
    if catalog_sequence > 999999 then catalog_sequence = 1 end
    return "catalog-" .. appid .. "-" .. tostring(now_seconds()) .. "-" .. tostring(catalog_sequence)
end

local function add_warning(job, value)
    if value and value ~= "" then job.warnings[#job.warnings + 1] = bounded(value, 200) end
end

local function finish_job(job)
    job.phase = nil
    job.status = "complete"
    job.updatedAt = now_seconds()
    job.expiresAt = job.updatedAt + CATALOG_JOB_TTL_SECONDS
    if #job.collection.items > 0 and not job.onlyGiteaCache then
        local cache_ok, write_error = write_cache(
            job.appid,
            job.depotIds,
            job.collection.items,
            job.fetchedAt or job.updatedAt
        )
        if not cache_ok then add_warning(job, write_error) end
    end
    return make_job_result(job)
end

local function prepare_gitea(job)
    local started = now_seconds()
    if job.options.allowGitea == false then
        job.providers[4] = provider_record("steam-pics", "skipped", started, 0, "disabled")
        return finish_job(job)
    end
    if count_verified(job.collection.items) > 0 and job.options.expandSources ~= true and
        job.refreshRequired ~= true then
        job.providers[4] = provider_record("steam-pics", "skipped", started, 0,
            "verified_source_available")
        return finish_job(job)
    end
    if now_seconds() < gitea_circuit_open_until then
        job.providers[4] = provider_record("steam-pics", "circuit_open", started, 0,
            "provider_circuit_open", "retry_after=" .. tostring(gitea_circuit_open_until))
        add_warning(job, "steam-pics:provider_circuit_open")
        return finish_job(job)
    end
    if type(job.adapters.gitea) ~= "function" then
        job.providers[4] = provider_record("steam-pics", "skipped", started, 0,
            "adapter_unavailable")
        return finish_job(job)
    end
    job.phase = "steam-pics"
    job.status = "pending"
    job.providers[4] = provider_record("steam-pics", "pending", started, 0)
    job.updatedAt = now_seconds()
    return make_job_result(job)
end

local function complete_steamdb(job)
    if #job.depotIds > 8 then job.steamdbWarnings[#job.steamdbWarnings + 1] = "depot_limit" end
    local raw_candidates, error_detail = build_steamdb_candidates(
        job.appid,
        job.depotIds,
        job.steamdbHistories,
        job.steamdbWarnings
    )
    local count = merge_raw_candidates(job.collection, raw_candidates, "steamdb", job.depotIds, "force")
    job.steamdbCount = count
    local status = count > 0 and "success" or
        (contains_timeout(error_detail) and "timeout" or (error_detail and "error" or "empty"))
    job.providers[3] = provider_record("steamdb", status, job.steamdbStartedAt, count,
        count > 0 and nil or (contains_timeout(error_detail) and "provider_timeout" or "no_history"),
        error_detail)
    if error_detail then add_warning(job, "steamdb:" .. bounded(error_detail, 160)) end
    if count > 0 then
        job.source = "steamdb"
        job.fetchedAt = now_seconds()
        job.stale = false
    end
    return prepare_gitea(job)
end

local function poll_steamdb(job)
    local maximum = math.min(#job.depotIds, 8)
    if job.steamdbIndex > maximum then return complete_steamdb(job) end

    local depot_id = job.depotIds[job.steamdbIndex]
    local html, error_code = safe_get_steamdb(
        steamdb_url(depot_id),
        provider_budget(REQUEST_TIMEOUT_SECONDS)
    )
    if not html then
        job.steamdbWarnings[#job.steamdbWarnings + 1] = depot_id .. ":" .. bounded(error_code, 96)
    else
        local rows = parse_steamdb_manifest_rows(html)
        if #rows > 0 then job.steamdbHistories[depot_id] = rows
        else job.steamdbWarnings[#job.steamdbWarnings + 1] = depot_id .. ":no_history" end
    end
    job.steamdbIndex = job.steamdbIndex + 1
    job.updatedAt = now_seconds()
    job.providers[3] = provider_record("steamdb", "running", job.steamdbStartedAt, 0, nil,
        "depot=" .. tostring(math.min(job.steamdbIndex - 1, maximum)) .. "/" .. tostring(maximum))
    if job.steamdbIndex > maximum then return complete_steamdb(job) end
    job.status = "pending"
    return make_job_result(job)
end

local function poll_gitea(job)
    local started = now_seconds()
    local ok, result = pcall(job.adapters.gitea, {
        forceRefresh = job.options.forceRefresh == true,
        ttlSeconds = job.ttl,
        -- One poll gets one strict six-second request budget and the staged
        -- adapter performs at most one HTTP request.  A timeout therefore
        -- cannot cascade into another provider request in the same RPC.
        requestBudget = provider_budget(REQUEST_TIMEOUT_SECONDS),
        continuation = job.giteaContinuation,
    })
    local count = 0
    if ok and type(result) == "table" and result.pending == true then
        job.giteaContinuation = result.continuation
        job.providers[4] = provider_record("steam-pics", "running", started, 0, nil,
            bounded(result.detail or "remote_step_pending", 120))
        job.status = "pending"
        job.updatedAt = now_seconds()
        return make_job_result(job)
    end
    if ok and type(result) == "table" and result.success == true then
        local raw_values = result.candidates or result.versions
        local delivered_count = dense_array_length(raw_values) or 0
        local merged_count = merge_raw_candidates(job.collection, raw_values,
            "steam-pics", job.depotIds, "verified")
        count = math.max(merged_count, math.min(delivered_count, MAX_CANDIDATES))
        job.giteaCount = count
        job.onlyGiteaCache = result.cached == true and count > 0 and job.steamdbCount == 0 and
            job.officialCount == 0 and job.seededLocalCount == 0
        job.providers[4] = provider_record("steam-pics", count > 0 and "success" or "empty",
            started, count, nil, result.warning)
        if result.warning then add_warning(job, "steam-pics:" .. bounded(result.warning, 160)) end
        if count > 0 then
            job.source = result.cached == true and "cache" or "network"
            job.fetchedAt = result.fetchedAt or now_seconds()
            job.stale = result.stale == true
        end
        gitea_circuit_open_until = 0
    else
        local failed = ok and result or { success = false, error = "provider_exception", detail = result }
        if should_open_circuit(failed) then
            gitea_circuit_open_until = now_seconds() + GITEA_CIRCUIT_SECONDS
        end
        local detail = type(failed) == "table" and (failed.detail or failed.error) or failed
        job.providers[4] = provider_record("steam-pics",
            contains_timeout(detail) and "timeout" or "error", started, 0,
            contains_timeout(detail) and "provider_timeout" or
                (type(failed) == "table" and failed.error or "provider_exception"), detail)
        add_warning(job, "steam-pics:" .. bounded(detail, 160))
    end
    job.updatedAt = now_seconds()
    return finish_job(job)
end

-- Starts with authoritative caller-provided and persistent-cache candidates
-- only.  It never performs network I/O, so GetDowngradeVersions can return
-- immediately.  Remote providers advance through poll_discovery one provider
-- step at a time.
function version_sources.start_discovery(appid, depot_ids, options, adapters)
    options = options or {}
    adapters = adapters or {}
    -- Reserve one slot for this job without evicting a valid job merely
    -- because a caller performed a read-only status request at capacity.
    cleanup_jobs(MAX_CATALOG_JOBS - 1)

    local now = now_seconds()
    local job = {
        id = next_job_id(appid),
        appid = appid,
        depotIds = copy_array(depot_ids),
        options = {
            forceRefresh = options.forceRefresh == true,
            allowSteamDb = options.allowSteamDb,
            allowGitea = options.allowGitea,
            expandSources = options.expandSources == true,
        },
        adapters = adapters,
        ttl = math.min(options.ttlSeconds or FRESH_SECONDS, FRESH_SECONDS),
        collection = { items = {}, bySignature = {} },
        providers = {},
        warnings = {},
        source = "pending",
        stale = false,
        fetchedAt = now,
        status = "pending",
        phase = nil,
        startedAt = now,
        updatedAt = now,
        expiresAt = now + CATALOG_JOB_TTL_SECONDS,
        steamdbCount = 0,
        giteaCount = 0,
        pollCount = 0,
    }

    local official_started = now_seconds()
    job.officialCount = merge_raw_candidates(job.collection,
        options.officialVersions or options.officialCandidates,
        "steam-official", depot_ids, "verified")
    job.providers[1] = provider_record("steam-official",
        job.officialCount > 0 and "success" or "empty", official_started, job.officialCount)

    local local_started = now_seconds()
    job.seededLocalCount = merge_raw_candidates(job.collection,
        options.localVersions or options.localCandidates,
        "steam-local", depot_ids, "verified")
    local local_count = job.seededLocalCount

    -- There are two migration-compatible persistent caches: the provider
    -- aggregate owned here and the older steam-pics cache owned by
    -- version_catalog.  The latter is supplied by the adapter caller after a
    -- bounded local read.  Select fresh entries first (newest wins duplicate
    -- signatures); use stale entries only when no fresh cache exists.
    local cached, provider_cache_warning = read_cache(appid, depot_ids)
    local cache_warning_parts = {}
    if provider_cache_warning then cache_warning_parts[#cache_warning_parts + 1] = provider_cache_warning end
    if options.cachedWarning then cache_warning_parts[#cache_warning_parts + 1] = bounded(options.cachedWarning, 96) end
    local cache_warning = #cache_warning_parts > 0 and table.concat(cache_warning_parts, ",") or nil
    local cache_records = {}
    local function add_cache_record(candidates, fetched_at)
        if type(candidates) ~= "table" or type(fetched_at) ~= "number" or
            fetched_at < 0 or fetched_at ~= math.floor(fetched_at) then
            return
        end
        local age = now - fetched_at
        if age < 0 or age > STALE_SECONDS then return end
        local sanitized = { items = {}, bySignature = {} }
        local count = merge_cached_candidates(sanitized, candidates, depot_ids)
        if count < 1 then return end
        cache_records[#cache_records + 1] = {
            candidates = sanitized.items,
            fetchedAt = fetched_at,
            fresh = job.ttl > 0 and age <= job.ttl,
        }
    end
    add_cache_record(options.cachedCandidates, options.cachedFetchedAt)
    if cached then add_cache_record(cached.candidates, cached.fetchedAt) end
    table.sort(cache_records, function(left, right) return left.fetchedAt > right.fetchedAt end)

    local has_fresh_cache = false
    for _, record in ipairs(cache_records) do
        if record.fresh then has_fresh_cache = true break end
    end
    local cached_count = 0
    local cached_fetched_at = nil
    for _, record in ipairs(cache_records) do
        if record.fresh == has_fresh_cache then
            local added = merge_cached_candidates(job.collection, record.candidates, depot_ids)
            cached_count = cached_count + added
            if added > 0 and not cached_fetched_at then cached_fetched_at = record.fetchedAt end
        end
    end
    local_count = local_count + cached_count
    local cache_fresh = cached_count > 0 and has_fresh_cache
    local cache_stale_usable = cached_count > 0
    job.providers[2] = provider_record("steam-local",
        local_count > 0 and (cache_stale_usable and not cache_fresh and
            job.seededLocalCount == 0 and "stale" or "success") or "empty",
        local_started, local_count, nil, cache_warning)

    if job.officialCount > 0 then
        job.source = "steam-official"
    elseif job.seededLocalCount > 0 then
        job.source = "steam-local"
    elseif cached_count > 0 then
        job.source = "cache"
        job.fetchedAt = cached_fetched_at or now
        job.stale = not cache_fresh
    end
    job.refreshRequired = options.forceRefresh == true or (cached_count > 0 and not cache_fresh)

    local preferred = job.officialCount > 0 or job.seededLocalCount > 0 or
        (cached_count > 0 and cache_fresh)
    local expand_remote = options.expandSources == true or job.refreshRequired or not preferred
    if not expand_remote then
        job.providers[3] = provider_record("steamdb", "skipped", now, 0,
            "preferred_source_available")
        job.providers[4] = provider_record("steam-pics", "skipped", now, 0,
            "preferred_source_available")
        job.status = "complete"
        catalog_jobs[job.id] = job
        catalog_job_order[#catalog_job_order + 1] = job.id
        if job.source ~= "cache" and #job.collection.items > 0 then
            local ok, write_error = write_cache(appid, depot_ids, job.collection.items, now)
            if not ok then add_warning(job, write_error) end
        end
        return make_job_result(job)
    end

    if options.allowSteamDb == false then
        job.providers[3] = provider_record("steamdb", "skipped", now, 0, "disabled")
        job.providers[4] = provider_record("steam-pics", "pending", now, 0)
        job.phase = "steam-pics"
    else
        job.providers[3] = provider_record("steamdb", "pending", now, 0)
        job.providers[4] = provider_record("steam-pics", "pending", now, 0)
        job.phase = "steamdb"
        job.steamdbIndex = 1
        job.steamdbStartedAt = now
        job.steamdbHistories = {}
        job.steamdbWarnings = {}
    end

    catalog_jobs[job.id] = job
    catalog_job_order[#catalog_job_order + 1] = job.id
    if job.phase == "steam-pics" and (options.allowGitea == false or
        now_seconds() < gitea_circuit_open_until or type(adapters.gitea) ~= "function") then
        return prepare_gitea(job)
    end
    return make_job_result(job)
end

function version_sources.get_discovery(job_id)
    cleanup_jobs()
    local job = type(job_id) == "string" and catalog_jobs[job_id] or nil
    if not job then return { success = false, error = "catalog_job_not_found", catalogJobId = job_id } end
    return make_job_result(job)
end

function version_sources.poll_discovery(job_id)
    cleanup_jobs()
    local job = type(job_id) == "string" and catalog_jobs[job_id] or nil
    if not job then return { success = false, error = "catalog_job_not_found", catalogJobId = job_id } end
    if job.status ~= "pending" and job.status ~= "running" then return make_job_result(job) end
    job.pollCount = (job.pollCount or 0) + 1
    job.status = "running"
    job.updatedAt = now_seconds()
    if job.phase == "steamdb" then return poll_steamdb(job) end
    if job.phase == "steam-pics" then return poll_gitea(job) end
    return finish_job(job)
end

function version_sources.cancel_discovery(job_id)
    cleanup_jobs()
    local job = type(job_id) == "string" and catalog_jobs[job_id] or nil
    if not job then return { success = false, error = "catalog_job_not_found", catalogJobId = job_id } end
    if job.status == "pending" or job.status == "running" then
        job.status = "cancelled"
        job.phase = nil
        job.updatedAt = now_seconds()
        job.expiresAt = job.updatedAt + CATALOG_JOB_TTL_SECONDS
        for index = 3, 4 do
            if job.providers[index] and (job.providers[index].status == "pending" or
                job.providers[index].status == "running") then
                job.providers[index] = provider_record(job.providers[index].id, "cancelled",
                    job.updatedAt, job.providers[index].candidateCount, "catalog_cancelled")
            end
        end
    end
    return make_job_result(job)
end

-- Compatibility alias.  Discovery is intentionally non-blocking now; callers
-- that need remote results must poll the returned catalogJobId.
version_sources.discover = version_sources.start_discovery

function version_sources._reset_circuit_for_tests()
    gitea_circuit_open_until = 0
    catalog_jobs = {}
    catalog_job_order = {}
    catalog_sequence = 0
end

return version_sources
