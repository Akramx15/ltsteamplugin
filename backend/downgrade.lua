local cjson       = require("json")
local fs          = require("fs")
local m_utils     = require("utils")
local logger      = require("plugin_logger")
local plugin_utils = require("plugin_utils")
local steam_utils = require("steam_utils")
local version_catalog = require("version_catalog")
local install_profile = require("install_profile")
local depot_manifest = require("depot_manifest")
local file_sentinel = require("file_sentinel")

local downgrade = {}

local MAX_PAYLOAD_BYTES = 64 * 1024
local MAX_DEPOTS = 64
local MAX_VERSION_ARCHIVE_ENTRIES = 100
local VERSION_ARCHIVE_SCHEMA = 2
local UINT32_MAX = "4294967295"
local UINT64_MAX = "18446744073709551615"
local COPY_CHUNK_BYTES = 1024 * 1024
local MERGE_BYTES_PER_TICK = 64 * 1024 * 1024
local MERGE_ENTRIES_PER_TICK = 256
local MERGE_TIME_PER_TICK_MS = 100
local JOB_STATE_SCHEMA = 2
local APPLIED_STATE_SCHEMA = 2
local PROBE_TIMEOUT_MS = 45 * 1000
local QUEUE_TIMEOUT_MS = 2 * 60 * 1000
local DOWNLOAD_STALL_MS = 10 * 60 * 1000
local MAX_CANDIDATE_CACHE = 100

local JOBS = {}
local ACTION_QUEUE = {}
local ACTIVE_ACTION = nil
local ACTION_COUNTER = 0
local JOB_COUNTER = 0
local MERGE_CONTEXTS = {}
local CANDIDATES = {}
local cleanup_downloaded_depots
local run_preflight
local RECOVERY_SCANNED = false

local TERMINAL_STATUS = {
    done = true,
    failed = true,
    cancelled = true,
}

local function now_milliseconds()
    if type(m_utils.time_ms) == "function" then
        local ok, value = pcall(m_utils.time_ms)
        if ok and type(value) == "number" then return math.floor(value) end
    end
    if type(m_utils.time) == "function" then
        local ok, value = pcall(m_utils.time)
        if ok and type(value) == "number" then return math.floor(value * 1000) end
    end
    if type(os) == "table" and type(os.time) == "function" then
        local ok, value = pcall(os.time)
        if ok and type(value) == "number" then return math.floor(value * 1000) end
    end
    return 0
end

local function trim(value)
    return tostring(value or ""):match("^%s*(.-)%s*$") or ""
end

local function failure(code, message, params, extra)
    local result = {
        success = false,
        errorCode = tostring(code or "unknown_error"),
        error = tostring(message or code or "Unknown error"),
        errorParams = type(params) == "table" and params or {},
    }
    for key, value in pairs(extra or {}) do result[key] = value end
    return result
end

local function path_key(value)
    local normalized = tostring(value or ""):gsub("\\", "/"):gsub("/+", "/")
    normalized = normalized:gsub("^%./", ""):gsub("/$", "")
    return normalized:lower()
end

local function error_code_from_text(value, fallback)
    local text = tostring(value or "")
    local known = {
        "game_running", "steam_updating", "install_not_writable", "install_changed",
        "insufficient_space", "manifest_missing", "manifest_mismatch", "manifest_symlink",
        "topology_mismatch", "path_conflict", "entitlement_denied",
    }
    for _, code in ipairs(known) do
        if text:find(code .. ":", 1, true) then return code end
    end
    return fallback or "unknown_error"
end

local function normalize_decimal(value, max_value, field_name)
    if type(value) ~= "string" or not value:match("^%d+$") then
        return nil, field_name .. " must be a digits-only string"
    end

    value = value:gsub("^0+", "")
    if value == "" then value = "0" end
    if value == "0" then
        return nil, field_name .. " must be greater than zero"
    end

    if #value > #max_value or (#value == #max_value and value > max_value) then
        return nil, field_name .. " is out of range"
    end

    return value
end

local function decode_payload(payload_json)
    if type(payload_json) == "table" then return payload_json end
    if type(payload_json) ~= "string" or payload_json == "" then
        return nil, "payloadJson is required"
    end
    if #payload_json > MAX_PAYLOAD_BYTES then
        return nil, "payloadJson is too large"
    end

    local ok, payload = pcall(cjson.decode, payload_json)
    if not ok or type(payload) ~= "table" then
        return nil, "payloadJson is not valid JSON"
    end
    return payload
end

-- Minimal Valve KeyValues parser. App/depot/manifest IDs are kept as strings so
-- 64-bit manifest GIDs never pass through a floating-point Lua number.
local function tokenize_vdf(text)
    local tokens = {}
    local i = 1
    local length = #text

    if text:sub(1, 3) == "\239\187\191" then i = 4 end

    while i <= length do
        local ch = text:sub(i, i)
        if ch:match("%s") then
            i = i + 1
        elseif ch == "/" and text:sub(i + 1, i + 1) == "/" then
            local newline = text:find("\n", i + 2, true)
            i = newline and (newline + 1) or (length + 1)
        elseif ch == "{" or ch == "}" then
            tokens[#tokens + 1] = ch
            i = i + 1
        elseif ch == '"' then
            i = i + 1
            local value = {}
            while i <= length do
                ch = text:sub(i, i)
                if ch == '"' then
                    i = i + 1
                    break
                elseif ch == "\\" and i < length then
                    local escaped = text:sub(i + 1, i + 1)
                    if escaped == "\\" or escaped == '"' then
                        value[#value + 1] = escaped
                        i = i + 2
                    elseif escaped == "n" then
                        value[#value + 1] = "\n"
                        i = i + 2
                    elseif escaped == "t" then
                        value[#value + 1] = "\t"
                        i = i + 2
                    else
                        value[#value + 1] = "\\"
                        i = i + 1
                    end
                else
                    value[#value + 1] = ch
                    i = i + 1
                end
            end
            tokens[#tokens + 1] = table.concat(value)
        else
            local start = i
            while i <= length do
                ch = text:sub(i, i)
                if ch:match("%s") or ch == "{" or ch == "}" then break end
                i = i + 1
            end
            tokens[#tokens + 1] = text:sub(start, i - 1)
        end
    end

    return tokens
end

local function parse_vdf_object(tokens, position, stop_at_brace)
    local result = {}
    position = position or 1

    while position <= #tokens do
        local key = tokens[position]
        if key == "}" then
            if stop_at_brace then return result, position + 1 end
            return nil, position, "Unexpected closing brace"
        end
        if key == "{" then return nil, position, "Unexpected opening brace" end

        position = position + 1
        local value = tokens[position]
        if value == nil then return nil, position, "Missing value for " .. tostring(key) end

        if value == "{" then
            local child, next_position, err = parse_vdf_object(tokens, position + 1, true)
            if not child then return nil, next_position, err end
            result[key] = child
            position = next_position
        elseif value == "}" then
            return nil, position, "Missing value for " .. tostring(key)
        else
            result[key] = value
            position = position + 1
        end
    end

    if stop_at_brace then return nil, position, "Unclosed object" end
    return result, position
end

local function parse_vdf(text)
    local tokens = tokenize_vdf(text or "")
    local value, _, err = parse_vdf_object(tokens, 1, false)
    if not value then return nil, err end
    return value
end

local function normalize_nonnegative_decimal(value)
    if type(value) ~= "string" or not value:match("^%d+$") then return nil end
    value = value:gsub("^0+", "")
    return value ~= "" and value or "0"
end

local function compare_decimal_strings(left, right)
    left = normalize_nonnegative_decimal(left)
    right = normalize_nonnegative_decimal(right)
    if not left or not right then return nil end
    if #left ~= #right then return #left < #right and -1 or 1 end
    if left == right then return 0 end
    return left < right and -1 or 1
end

local function decimal_id_less(left, right)
    return compare_decimal_strings(left, right) == -1
end

local function clone_depots(depots)
    local copy = {}
    for _, depot in ipairs(depots or {}) do
        copy[#copy + 1] = {
            depotId = tostring(depot.depotId or ""),
            manifestId = tostring(depot.manifestId or ""),
        }
    end
    return copy
end

local function canonicalize_depots(raw_depots, expected_ids, allow_topology_change)
    if type(raw_depots) ~= "table" then return nil end

    local by_id = {}
    local count = 0
    for _, raw in ipairs(raw_depots) do
        if type(raw) ~= "table" then return nil end
        local depot_id = normalize_decimal(raw.depotId, UINT32_MAX, "depotId")
        local manifest_id = normalize_decimal(raw.manifestId, UINT64_MAX, "manifestId")
        if not depot_id or not manifest_id or by_id[depot_id] then return nil end
        by_id[depot_id] = manifest_id
        count = count + 1
    end

    local order = expected_ids
    if type(order) ~= "table" or allow_topology_change == true then
        order = {}
        for depot_id in pairs(by_id) do order[#order + 1] = depot_id end
        table.sort(order, decimal_id_less)
    end
    if count ~= #order then return nil end

    local depots = {}
    for _, depot_id in ipairs(order) do
        local manifest_id = by_id[depot_id]
        if not manifest_id then return nil end
        depots[#depots + 1] = { depotId = depot_id, manifestId = manifest_id }
    end
    return depots
end

local function depot_signature(depots)
    local parts = {}
    for _, depot in ipairs(depots or {}) do
        parts[#parts + 1] = depot.depotId .. "=" .. depot.manifestId
    end
    return table.concat(parts, "|")
end

local function stable_signature_hash(signature)
    local hash = 5381
    for index = 1, #signature do
        hash = (hash * 33 + signature:byte(index)) % 4294967296
    end
    return string.format("%08x", hash)
end

local function log_timestamp_to_unix(timestamp)
    local year, month, day, hour, minute, second = tostring(timestamp or ""):match(
        "^(%d%d%d%d)%-(%d%d)%-(%d%d) (%d%d):(%d%d):(%d%d)$"
    )
    if not year then return nil end
    if type(os) ~= "table" or type(os.time) ~= "function" then
        return year .. month .. day .. hour .. minute .. second
    end

    local ok, value = pcall(os.time, {
        year = tonumber(year),
        month = tonumber(month),
        day = tonumber(day),
        hour = tonumber(hour),
        min = tonumber(minute),
        sec = tonumber(second),
        isdst = false,
    })
    if not ok or type(value) ~= "number" or value < 0 then return nil end
    return tostring(math.floor(value))
end

local function normalize_snapshot_timestamp(value)
    local numeric = normalize_nonnegative_decimal(tostring(value or ""))
    if numeric then return numeric end
    local year, month, day, hour, minute, second = tostring(value or ""):match(
        "^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)"
    )
    if not year or type(os) ~= "table" or type(os.time) ~= "function" then return "0" end
    local ok, converted = pcall(os.time, {
        year = tonumber(year), month = tonumber(month), day = tonumber(day),
        hour = tonumber(hour), min = tonumber(minute), sec = tonumber(second), isdst = false,
    })
    return ok and type(converted) == "number" and tostring(math.max(0, math.floor(converted))) or "0"
end

local function parse_finished_update_line(line, expected_appid, expected_depot_ids)
    if type(line) ~= "string" or #line > 32768 then return nil end
    local timestamp_text, appid_raw, declared_count_raw, build_id_raw, depot_text = line:match(
        "^%[(%d%d%d%d%-%d%d%-%d%d %d%d:%d%d:%d%d)%]%s+AppID%s+(%d+)%s+finished update,%s+(%d+)%s+mounted depots%s+%(BuildID%s+(%d+)%)%s*:%s*(.-)%s*$"
    )
    if not timestamp_text then return nil end

    local appid = normalize_decimal(appid_raw, UINT32_MAX, "appid")
    local build_id = normalize_decimal(build_id_raw, UINT64_MAX, "buildId")
    local timestamp = log_timestamp_to_unix(timestamp_text)
    local declared_count = tonumber(declared_count_raw)
    if not appid or appid ~= expected_appid or not build_id or not timestamp or
        not declared_count or declared_count < 1 or declared_count > MAX_DEPOTS then
        return nil
    end

    local parsed = {}
    for depot_id, manifest_id in depot_text:gmatch("(%d+)%s*%((%d+)%)") do
        parsed[#parsed + 1] = { depotId = depot_id, manifestId = manifest_id }
    end
    if #parsed ~= declared_count then return nil end

    local residue = depot_text:gsub("%d+%s*%(%d+%)%s*,?", "")
    if trim(residue) ~= "" then return nil end

    -- A content_log entry declares a complete mounted-depot snapshot.  Keep a
    -- topology change instead of silently discarding real older builds; the
    -- compatibility layer decides whether it is verified or Force-only.
    local depots = canonicalize_depots(parsed, expected_depot_ids, true)
    if not depots then return nil end
    return {
        buildId = build_id,
        timestamp = timestamp,
        depots = depots,
        source = "steam-content-log",
        completeSnapshot = true,
    }
end

local function parse_content_log(text, appid, expected_depot_ids)
    local snapshots = {}
    if type(text) ~= "string" or text == "" then return snapshots end
    for line in text:gmatch("[^\r\n]+") do
        local snapshot = parse_finished_update_line(line, appid, expected_depot_ids)
        if snapshot then snapshots[#snapshots + 1] = snapshot end
    end
    return snapshots
end

local function load_installed_snapshot(appid)
    local install = steam_utils.get_game_install_path_response(tonumber(appid))
    if not install.success or not install.installPath or not fs.is_directory(install.installPath) then
        return nil, "The game is not installed", "not_installed"
    end

    local manifest_path = fs.join(install.libraryPath, "steamapps", "appmanifest_" .. appid .. ".acf")
    local manifest_text = m_utils.read_file(manifest_path)
    if not manifest_text then return nil, "Could not read the installed appmanifest", "appmanifest_unreadable" end

    local manifest, parse_err = parse_vdf(manifest_text)
    if not manifest then
        return nil, "Could not parse appmanifest: " .. tostring(parse_err), "appmanifest_invalid"
    end
    local app_state = manifest.AppState
    local parsed, profile_err = install_profile.from_app_state(appid, app_state, {
        installPath = fs.absolute(install.installPath),
        libraryPath = fs.absolute(install.libraryPath),
        manifestPath = fs.absolute(manifest_path),
    })
    if not parsed then
        return nil, "Installed appmanifest is not usable: " .. tostring(profile_err), profile_err
    end
    return parsed
end

local function versions_archive_path(appid)
    return fs.join(plugin_utils.ensure_temp_download_dir(), "downgrade_" .. appid .. "_versions.json")
end

local function sanitize_snapshot(raw, expected_depot_ids)
    if type(raw) ~= "table" then return nil end
    local build_id = normalize_decimal(raw.buildId, UINT64_MAX, "buildId") or "0"
    local timestamp = normalize_snapshot_timestamp(raw.timestamp)
    local depots = canonicalize_depots(raw.depots, expected_depot_ids, true)
    if not timestamp or not depots then return nil end

    local source = tostring(raw.source or "local-archive")
    if #source > 64 or not source:match("^[a-z0-9_-]+$") then source = "local-archive" end
    return {
        buildId = build_id,
        timestamp = timestamp,
        depots = depots,
        source = source,
        signature = depot_signature(depots),
        -- Completeness is an independent fact.  Never infer it merely from a
        -- cached compatibility badge/source name; stale deletion is enabled
        -- only by explicit complete-snapshot evidence or Steam's own full
        -- mounted/appmanifest records.
        completeSnapshot = raw.completeSnapshot == true or
            source == "steam-content-log" or source == "steam-appmanifest",
        buildVerified = build_id ~= "0",
    }
end

local function snapshot_is_newer(left, right)
    local timestamp_compare = compare_decimal_strings(left.timestamp, right.timestamp) or 0
    if timestamp_compare ~= 0 then return timestamp_compare == 1 end
    local build_compare = compare_decimal_strings(left.buildId, right.buildId) or 0
    if build_compare ~= 0 then return build_compare == 1 end
    return left.signature < right.signature
end

local function merge_snapshot(by_signature, raw, expected_depot_ids)
    local snapshot = sanitize_snapshot(raw, expected_depot_ids)
    if not snapshot then return end
    local previous = by_signature[snapshot.signature]
    if not previous or snapshot_is_newer(snapshot, previous) then
        by_signature[snapshot.signature] = snapshot
    end
end

local function load_version_archive(appid, expected_depot_ids)
    local path = versions_archive_path(appid)
    if not fs.exists(path) then return {} end
    local data = plugin_utils.read_json(path)
    local schema = type(data) == "table" and tonumber(data.schemaVersion) or nil
    if type(data) ~= "table" or (schema ~= 1 and schema ~= VERSION_ARCHIVE_SCHEMA) or
        type(data.entries) ~= "table" then
        return {}
    end

    local snapshots = {}
    for _, raw in ipairs(data.entries) do
        local snapshot = sanitize_snapshot(raw, expected_depot_ids)
        if snapshot then snapshots[#snapshots + 1] = snapshot end
    end
    return snapshots
end

local function save_version_archive(appid, snapshots)
    local entries = {}
    for index = 1, math.min(#snapshots, MAX_VERSION_ARCHIVE_ENTRIES) do
        local snapshot = snapshots[index]
        entries[#entries + 1] = {
            buildId = snapshot.buildId,
            timestamp = snapshot.timestamp,
            depots = clone_depots(snapshot.depots),
            source = snapshot.source,
            completeSnapshot = snapshot.completeSnapshot == true,
        }
    end
    local ok = plugin_utils.write_json(versions_archive_path(appid), {
        schemaVersion = VERSION_ARCHIVE_SCHEMA,
        entries = entries,
    })
    if not ok then logger.warn("Downgrade: failed to persist version archive for " .. appid) end
end

local function state_path(appid)
    return fs.join(plugin_utils.ensure_temp_download_dir(), "downgrade_" .. appid .. "_state.json")
end

local function applied_state_path(appid)
    return fs.join(plugin_utils.ensure_temp_download_dir(), "downgrade_" .. appid .. "_applied.json")
end

local function load_applied_state(appid, installed)
    local path = applied_state_path(appid)
    if not fs.exists(path) then return nil end
    local raw = plugin_utils.read_json(path)
    local schema_version = type(raw) == "table" and tonumber(raw.schemaVersion) or nil
    if type(raw) ~= "table" or (schema_version ~= 1 and schema_version ~= APPLIED_STATE_SCHEMA) or
        tostring(raw.appid or "") ~= appid then
        return nil
    end
    local depots = canonicalize_depots(raw.depots, nil, true)
    if not depots then return nil end
    local result = {
        schemaVersion = APPLIED_STATE_SCHEMA,
        appid = appid,
        candidateId = tostring(raw.candidateId or ""),
        buildId = normalize_decimal(raw.buildId, UINT64_MAX, "buildId"),
        timestamp = normalize_nonnegative_decimal(tostring(raw.timestamp or "0")) or "0",
        depots = depots,
        mode = raw.mode == "force" and "force" or "verified",
        remembered = raw.remembered ~= false,
        appliedAt = tonumber(raw.appliedAt) or 0,
        baselineFingerprint = tostring(raw.baselineFingerprint or ""),
        -- Schema 1 never recorded whether the archived depot set was complete.
        -- Treat it as incomplete rather than guessing and deleting files on a
        -- later Reapply operation.
        completeSnapshot = schema_version == APPLIED_STATE_SCHEMA and raw.completeSnapshot == true,
        staleCleanupApplied = schema_version == APPLIED_STATE_SCHEMA and raw.staleCleanupApplied == true,
        sentinels = schema_version == APPLIED_STATE_SCHEMA and type(raw.sentinels) == "table" and
            raw.sentinels or nil,
    }
    result.manifestDrifted = installed ~= nil and result.baselineFingerprint ~= "" and
        tostring(installed.fingerprint or "") ~= result.baselineFingerprint
    result.contentDrifted = false
    if installed ~= nil and result.sentinels ~= nil then
        local verify_ok, verification, verification_error = pcall(
            file_sentinel.verify,
            installed.installPath,
            result.sentinels
        )
        if verify_ok and type(verification) == "table" then
            result.contentDrifted = verification.matches == false
            result.sentinelFilesChecked = verification.filesChecked
            if result.contentDrifted then
                result.driftReason = verification.code
                result.driftPath = verification.relativePath
            end
        elseif not verify_ok or verification_error ~= nil then
            -- Sentinel failure is diagnostic, not proof that Steam restored
            -- files.  Never create a false Reapply prompt from an IO error.
            result.sentinelError = tostring(not verify_ok and verification or
                (type(verification_error) == "table" and verification_error.code or verification_error))
        end
    end
    result.drifted = result.manifestDrifted or result.contentDrifted
    result.canReapply = result.remembered and #depots > 0
    result.currentlyApplied = not result.drifted
    return result
end

local function save_applied_state(job)
    local installed = load_installed_snapshot(job.appid)
    local baseline = installed and installed.fingerprint or job.appManifestFingerprint
    local state = {
        schemaVersion = APPLIED_STATE_SCHEMA,
        appid = job.appid,
        candidateId = job.candidateId or "",
        buildId = job.targetBuildId,
        timestamp = job.targetTimestamp or "0",
        depots = clone_depots(job.depots),
        mode = job.mode,
        remembered = job.remembered ~= false,
        appliedAt = now_milliseconds(),
        baselineFingerprint = baseline,
        completeSnapshot = job.targetCompleteSnapshot == true,
        staleCleanupApplied = job.staleCleanupAllowed == true,
        sentinels = job.appliedSentinels,
    }
    if not plugin_utils.write_json(applied_state_path(job.appid), state) then
        return false, "Could not persist the selected downgrade version"
    end
    job.applied = state
    return true
end

local function persist_job(job)
    job.schemaVersion = JOB_STATE_SCHEMA
    job.updatedAt = now_milliseconds()
    local ok = plugin_utils.write_json(state_path(job.appid), job)
    if not ok then logger.warn("Downgrade: failed to persist state for " .. job.appid) end
end

local function load_job(appid)
    if JOBS[appid] then return JOBS[appid] end
    local path = state_path(appid)
    if not fs.exists(path) then return nil end
    local data = plugin_utils.read_json(path)
    if type(data) ~= "table" or tostring(data.appid or "") ~= appid then return nil end
    JOBS[appid] = data
    -- Client actions are process-local.  Downloads cannot be replayed safely,
    -- but applying an already downloaded depot is idempotent: rebuild the
    -- manifest-backed merge plan and copy it again from the beginning.
    if not TERMINAL_STATUS[data.status] then
        local interrupted_status = data.status
        data.interrupted = true
        if interrupted_status == "merging" or interrupted_status == "recovery_pending" then
            data.activeActionId = nil
            data.activeCommandStarted = nil
            data.status = "recovery_pending"
            data.success = false
            data.error = nil
            data.errorCode = nil
            data.message = "Resuming the interrupted in-place apply"
            data.partialApplied = true
            data.resumeMerge = true
        elseif (interrupted_status == "downloading" or interrupted_status == "stalled") and
            data.activeCommandStarted == true and type(data.currentDepot) == "table" and
            tostring(data.activeActionId or ""):match("^[A-Za-z0-9_.:-]+$") then
            local depot_id = normalize_decimal(data.currentDepot.depotId, UINT32_MAX, "depotId")
            local manifest_id = normalize_decimal(data.currentDepot.manifestId, UINT64_MAX, "manifestId")
            if depot_id and manifest_id and not ACTIVE_ACTION then
                ACTIVE_ACTION = {
                    id = tostring(data.activeActionId),
                    jobId = tostring(data.jobId or data.currentDepot.jobId or ""),
                    type = "exec",
                    commandStarted = true,
                    appid = appid,
                    depotId = depot_id,
                    manifestId = manifest_id,
                    command = "download_depot " .. appid .. " " .. depot_id .. " " .. manifest_id,
                }
                data.status = "downloading"
                data.success = false
                data.error = nil
                data.errorCode = nil
                data.attentionCode = nil
                data.message = "Reconnected to the active Steam depot download"
                data.downloadRecovery = true
                data.retryCount = (tonumber(data.retryCount) or 0) + 1
                data.lastActivityAt = now_milliseconds()
            else
                data.activeActionId = nil
                data.activeCommandStarted = nil
                data.status = "failed"
                data.success = false
                data.errorCode = "interrupted"
                data.error = "Could not recover the interrupted Steam download"
                data.message = "Downgrade interrupted before completion"
                data.downloadMayStillBeRunning = true
            end
        else
            data.activeActionId = nil
            data.activeCommandStarted = nil
            data.status = "failed"
            data.success = false
            data.errorCode = "interrupted"
            data.error = "The downgrade was interrupted by a Steam or plugin restart"
            data.message = "Downgrade interrupted before completion"
            data.partialApplied = false
            if cleanup_downloaded_depots then
                data.cleanupWarnings = cleanup_downloaded_depots(data, true)
            end
        end
        persist_job(data)
    end
    return data
end

local function recover_persisted_jobs()
    if RECOVERY_SCANNED then return end
    RECOVERY_SCANNED = true
    if type(fs.list) ~= "function" then return end

    local directory = plugin_utils.ensure_temp_download_dir()
    local ok, entries = pcall(fs.list, directory)
    if not ok or type(entries) ~= "table" then return end
    for _, entry in ipairs(entries) do
        local appid = tostring(entry.name or ""):match("^downgrade_(%d+)_state%.json$")
        appid = appid and normalize_decimal(appid, UINT32_MAX, "appid") or nil
        if appid then load_job(appid) end
    end
end

local function calculate_progress(job)
    local completed = 0
    for _, depot in ipairs(job.depots or {}) do
        if depot.status == "downloaded" or depot.status == "merged" or depot.status == "cleaned" then
            completed = completed + 1
        end
    end

    local total = #(job.depots or {})
    local percent = 0
    if job.status == "done" then
        percent = 100
    elseif job.status == "merging" then
        local bytes_total = tonumber(job.bytesTotal) or 0
        local bytes_copied = tonumber(job.bytesCopied) or 0
        percent = bytes_total > 0 and (50 + math.floor((bytes_copied / bytes_total) * 50)) or 50
    elseif total > 0 then
        percent = math.floor((completed / total) * 50)
    end
    if percent < 0 then percent = 0 end
    if percent > 100 then percent = 100 end

    job.progress = {
        completedDepots = completed,
        totalDepots = total,
        filesCopied = tonumber(job.filesCopied) or 0,
        filesTotal = tonumber(job.filesTotal) or 0,
        filesRemoved = tonumber(job.filesRemoved) or 0,
        staleFilesTotal = tonumber(job.staleFilesTotal) or 0,
        bytesCopied = tonumber(job.bytesCopied) or 0,
        bytesTotal = tonumber(job.bytesTotal) or 0,
        percent = percent,
    }
end

local function update_job(job, values)
    for key, value in pairs(values or {}) do job[key] = value end
    job.lastActivityAt = now_milliseconds()
    calculate_progress(job)
    persist_job(job)
end

local function note_correlated_activity(job)
    job.lastActivityAt = now_milliseconds()
    if job.status == "stalled" then
        job.status = "downloading"
        job.attentionCode = nil
        job.errorCode = nil
        job.message = "Steam download activity resumed"
    end
    persist_job(job)
end

local function next_action_id(job, kind)
    ACTION_COUNTER = ACTION_COUNTER + 1
    return job.jobId .. "-" .. kind .. "-" .. tostring(ACTION_COUNTER)
end

local function next_job_id(appid)
    JOB_COUNTER = JOB_COUNTER + 1
    if type(m_utils.uuid) == "function" then
        local ok, value = pcall(m_utils.uuid)
        value = ok and tostring(value or "") or ""
        if value:match("^[A-Za-z0-9-]+$") and #value >= 16 and #value <= 64 then
            return "downgrade-" .. appid .. "-" .. value
        end
    end
    return "downgrade-" .. appid .. "-" .. tostring(now_milliseconds()) .. "-" .. tostring(JOB_COUNTER)
end

local function enqueue_action(action)
    ACTION_QUEUE[#ACTION_QUEUE + 1] = action
end

local function remove_queued_actions(appid)
    local filtered = {}
    for _, action in ipairs(ACTION_QUEUE) do
        if action.appid ~= appid then filtered[#filtered + 1] = action end
    end
    ACTION_QUEUE = filtered
end

local function make_exec_action(job, depot)
    local command = "download_depot " .. job.appid .. " " .. depot.depotId .. " " .. depot.manifestId
    return {
        id = next_action_id(job, "exec"),
        jobId = job.jobId,
        type = "exec",
        commandStarted = false,
        appid = job.appid,
        depotId = depot.depotId,
        manifestId = depot.manifestId,
        command = command,
    }
end

local function queue_current_depot(job)
    local depot = job.depots[job.currentIndex]
    if not depot then return nil, "No depot remains in the queue" end

    depot.status = "queued"
    depot.consoleSawDepot = false
    depot.consoleSawManifest = false
    depot.consoleSawCompletion = false
    depot.consoleCompletionDetail = nil
    local action = make_exec_action(job, depot)
    job.currentDepot = {
        jobId = job.jobId,
        depotId = depot.depotId,
        manifestId = depot.manifestId,
        actionId = action.id,
        commandStarted = false,
    }
    job.error = nil
    job.errorCode = nil
    job.attentionCode = nil
    update_job(job, {
        status = "queued",
        message = "Waiting for Steam to download depot " .. depot.depotId,
        error = nil,
    })
    enqueue_action(action)
    return action
end

local function is_safe_relative_path(relative_path)
    if type(relative_path) ~= "string" or relative_path == "" or relative_path == "." then return false end
    local normalized = relative_path:gsub("\\", "/")
    if normalized:sub(1, 1) == "/" or normalized:match("^%a:") then return false end
    for component in normalized:gmatch("[^/]+") do
        if component == ".." or component == "." or component == "" then return false end
    end
    return true
end

local function content_depot_path(appid, depot_id)
    local steam_path = steam_utils.detect_steam_install_path()
    return fs.join(steam_path, "steamapps", "content", "app_" .. appid, "depot_" .. depot_id)
end

local function is_expected_content_path(job, depot, path)
    if path ~= content_depot_path(job.appid, depot.depotId) then return false end
    if not fs.exists(path) or not fs.is_directory(path) then return false end
    local ok, is_link = pcall(fs.is_symlink, path)
    return not (ok and is_link == true)
end

-- A depot path is relative and validated, but an already-installed game can
-- still contain a symlink/junction in the destination chain.  Refuse to copy
-- through one so a crafted local tree cannot redirect writes outside the game.
local function safe_install_target(install_root, relative_path)
    if not is_safe_relative_path(relative_path) then return nil, "Unsafe relative target path" end
    local current = install_root
    local normalized = relative_path:gsub("\\", "/")
    for component in normalized:gmatch("[^/]+") do
        current = fs.join(current, component)
        if fs.exists(current) then
            local ok, is_link = pcall(fs.is_symlink, current)
            if ok and is_link == true then
                return nil, "Destination contains a symlink or junction: " .. relative_path
            end
        end
    end
    return current
end

local function safe_depot_source(depot_root, relative_path)
    if not is_safe_relative_path(relative_path) then return nil, "Unsafe relative depot path" end
    if not fs.exists(depot_root) or not fs.is_directory(depot_root) then
        return nil, "Downloaded depot directory disappeared"
    end
    local root_ok, root_is_link = pcall(fs.is_symlink, depot_root)
    if root_ok and root_is_link == true then return nil, "Downloaded depot directory became a symlink" end

    local current = depot_root
    local normalized = relative_path:gsub("\\", "/")
    for component in normalized:gmatch("[^/]+") do
        current = fs.join(current, component)
        if fs.exists(current) then
            local ok, is_link = pcall(fs.is_symlink, current)
            if ok and is_link == true then
                return nil, "Depot source contains a symlink or junction: " .. relative_path
            end
        end
    end
    return current
end

local function resolve_target_type_conflict(job, target, wants_directory, relative_path)
    if not fs.exists(target) then return false end
    local is_directory = fs.is_directory(target)
    if wants_directory and not is_directory then
        error("path_conflict: unmanaged file blocks target directory " .. relative_path)
    elseif not wants_directory and is_directory then
        -- Never recursively remove an installed directory: it may contain a
        -- mod or save unknown to Steam.  The verified stale-file phase removes
        -- only manifest-owned children first; an empty directory can then be
        -- replaced safely.
        local removed, remove_err = fs.remove(target)
        if removed == nil or removed == false or fs.exists(target) then
            error("path_conflict: user files block target file " .. relative_path .. ": " .. tostring(remove_err))
        end
        job.typeConflictsResolved = (tonumber(job.typeConflictsResolved) or 0) + 1
        return true
    end
    return false
end

cleanup_downloaded_depots = function(job, include_incomplete)
    local warnings = {}
    for _, depot in ipairs(job.depots or {}) do
        local depot_id = normalize_decimal(depot.depotId, UINT32_MAX, "depotId")
        if not depot_id then
            warnings[#warnings + 1] = "Skipped an invalid depot path while cleaning temporary content"
        else
            local safe_depot = { depotId = depot_id }
            local source = content_depot_path(job.appid, depot_id)
            local completed = depot.status == "downloaded" or depot.status == "merged" or depot.status == "cleaned"
            if (completed or include_incomplete == true) and
                is_expected_content_path(job, safe_depot, source) then
                local removed, err = fs.remove_all(source)
                if removed == nil or removed == false or err ~= nil or
                    (type(removed) == "number" and removed < 0) then
                    warnings[#warnings + 1] = "Could not remove depot " .. depot_id .. ": " .. tostring(err)
                else
                    if completed then depot.status = "cleaned" else depot.tempCleaned = true end
                end
            end
        end
    end

    local app_root = fs.join(steam_utils.detect_steam_install_path(), "steamapps", "content", "app_" .. job.appid)
    if fs.exists(app_root) and fs.is_directory(app_root) and fs.is_empty(app_root) then
        pcall(fs.remove, app_root)
    end
    return warnings
end

local function close_merge_handles(context)
    if not context then return end
    if context.sourceHandle then pcall(function() context.sourceHandle:close() end) end
    if context.targetHandle then pcall(function() context.targetHandle:close() end) end
    context.sourceHandle = nil
    context.targetHandle = nil
    context.currentEntry = nil
    context.currentTarget = nil
    context.pendingPath = nil
    context.backupPath = nil
end

local function merge_journal_paths(job, context, target)
    local token = tostring(job.jobId or "downgrade"):gsub("[^A-Za-z0-9-]", "")
    if token == "" then token = "downgrade" end
    if #token > 48 then token = token:sub(#token - 47) end
    local basename = ".akrams-downgrade-" .. token .. "-" .. tostring(context.entryIndex)
    local parent = fs.parent_path(target)
    return fs.join(parent, basename .. ".pending"), fs.join(parent, basename .. ".backup")
end

local function remove_journal_path(path)
    if not fs.exists(path) then return true end
    local link_ok, is_link = pcall(fs.is_symlink, path)
    if link_ok and is_link == true then
        return nil, "Refusing to use a symlink as a merge journal: " .. tostring(path)
    end
    if fs.is_directory(path) and not fs.is_empty(path) then
        return nil, "Refusing to remove a non-empty merge journal directory: " .. tostring(path)
    end
    local removed, remove_error = fs.remove(path)
    if removed == nil or removed == false or fs.exists(path) then
        return nil, tostring(remove_error or "journal removal failed")
    end
    return true
end

local function rename_journal_path(source, target)
    if type(os) ~= "table" or type(os.rename) ~= "function" then
        return nil, "Atomic rename is unavailable in this Lua host"
    end
    local moved, move_error = os.rename(source, target)
    if not moved or fs.exists(source) or not fs.exists(target) then
        return nil, tostring(move_error or "atomic rename failed")
    end
    return true
end

-- A crash can happen between moving the old installed file aside and
-- installing the fully staged replacement. Restore that per-file journal
-- before retrying so an interrupted apply never leaves a truncated final file.
local function recover_merge_journal(target, pending, backup)
    for _, path in ipairs({ pending, backup }) do
        if fs.exists(path) then
            local link_ok, is_link = pcall(fs.is_symlink, path)
            if link_ok and is_link == true then
                return nil, "Refusing to recover a symlinked merge journal: " .. tostring(path)
            end
        end
    end

    if fs.exists(backup) then
        if fs.exists(target) then
            local removed, remove_error = remove_journal_path(backup)
            if not removed then return nil, "Could not clean committed merge backup: " .. tostring(remove_error) end
        else
            local restored, restore_error = rename_journal_path(backup, target)
            if not restored then return nil, "Could not restore interrupted installed file: " .. tostring(restore_error) end
        end
    end
    if fs.exists(pending) then
        local removed, remove_error = remove_journal_path(pending)
        if not removed then return nil, "Could not reset interrupted merge staging file: " .. tostring(remove_error) end
    end
    return true
end

local function commit_staged_file(job, context, entry, target)
    local pending, backup = context.pendingPath, context.backupPath
    if not pending or not backup or not fs.exists(pending) then
        error("Merge staging file disappeared before commit: " .. entry.relative)
    end
    local staged_size, staged_error = fs.file_size(pending)
    if staged_size == nil or tonumber(staged_size) ~= entry.size then
        error("Merge staging verification failed: " .. entry.relative .. " (" .. tostring(staged_error or staged_size) .. ")")
    end

    local had_target = fs.exists(target)
    if had_target and fs.is_directory(target) and not fs.is_empty(target) then
        error("path_conflict: user files block target file " .. entry.relative)
    end
    if had_target then
        local moved, move_error = rename_journal_path(target, backup)
        if not moved then error("Could not journal installed file " .. entry.relative .. ": " .. tostring(move_error)) end
        context.applyStarted = true
    end

    local installed, install_error = rename_journal_path(pending, target)
    if not installed then
        if had_target and fs.exists(backup) and not fs.exists(target) then
            local restored, restore_error = rename_journal_path(backup, target)
            if not restored then
                error("Could not commit or restore installed file " .. entry.relative .. ": " ..
                    tostring(install_error) .. "; restore: " .. tostring(restore_error))
            end
        end
        error("Could not commit installed file " .. entry.relative .. ": " .. tostring(install_error))
    end
    context.applyStarted = true

    local committed_size, committed_error = fs.file_size(target)
    if committed_size == nil or tonumber(committed_size) ~= entry.size then
        pcall(fs.remove, target)
        if had_target and fs.exists(backup) and not fs.exists(target) then
            local restored, restore_error = rename_journal_path(backup, target)
            if not restored then
                error("Committed file verification and restore failed for " .. entry.relative .. ": " ..
                    tostring(committed_error or committed_size) .. "; restore: " .. tostring(restore_error))
            end
        end
        error("Committed file verification failed for " .. entry.relative .. ": " ..
            tostring(committed_error or committed_size))
    end

    if fs.exists(backup) then
        local removed, remove_error = remove_journal_path(backup)
        if not removed then
            job.cleanupWarnings = job.cleanupWarnings or {}
            job.cleanupWarnings[#job.cleanupWarnings + 1] =
                "Could not remove merge backup for " .. entry.relative .. ": " .. tostring(remove_error)
        end
    end
    context.pendingPath = nil
    context.backupPath = nil
    context.currentTarget = nil
end

local function depot_manifest_path(depot_id, manifest_id)
    return fs.join(
        steam_utils.detect_steam_install_path(),
        "depotcache",
        tostring(depot_id) .. "_" .. tostring(manifest_id) .. ".manifest"
    )
end

local function read_depot_manifest(depot_id, manifest_id)
    local path = depot_manifest_path(depot_id, manifest_id)
    local parsed, parse_error = depot_manifest.parse_file(path, {
        expectedDepotId = tostring(depot_id),
        expectedManifestGid = tostring(manifest_id),
        includeHashes = true,
    })
    if not parsed then
        return nil, {
            code = type(parse_error) == "table" and parse_error.code or "manifest_invalid",
            detail = type(parse_error) == "table" and parse_error.detail or tostring(parse_error),
            path = path,
            depotId = tostring(depot_id),
            manifestId = tostring(manifest_id),
        }
    end
    return parsed
end

local function verify_current_inventory(installed)
    local problems = {}
    for _, depot in ipairs(installed.depots or {}) do
        local parsed, problem = read_depot_manifest(depot.depotId, depot.manifestId)
        if not parsed then problems[#problems + 1] = problem end
    end
    return #problems == 0, problems
end

local function depot_output_matches(job, depot)
    local source = content_depot_path(job.appid, depot.depotId)
    if not is_expected_content_path(job, depot, source) then return false, "output_missing" end
    local manifest, manifest_error = read_depot_manifest(depot.depotId, depot.manifestId)
    if not manifest then return false, manifest_error and manifest_error.code or "manifest_missing" end
    local expected = {}
    for _, entry in ipairs(manifest.directories or {}) do
        expected[entry.pathKey] = true
        local directory_path, path_error = safe_depot_source(source, entry.relativePath)
        if not directory_path or not fs.exists(directory_path) or not fs.is_directory(directory_path) then
            return false, path_error or "directory_missing"
        end
    end
    for _, entry in ipairs(manifest.files or {}) do
        expected[entry.pathKey] = true
        local file_path, path_error = safe_depot_source(source, entry.relativePath)
        if not file_path or not fs.exists(file_path) or fs.is_directory(file_path) then
            return false, path_error or "file_missing"
        end
        local size_ok, actual_size = pcall(fs.file_size, file_path)
        if not size_ok or tonumber(actual_size) ~= tonumber(entry.size or entry.sizeText) then
            return false, "size_mismatch"
        end
    end
    local list_ok, actual, list_error = pcall(fs.list_recursive, source)
    if not list_ok or not actual then return false, tostring(list_error or actual or "list_failed") end
    for _, entry in ipairs(actual) do
        if entry.is_file and not fs.is_symlink(entry.path) then
            local relative = fs.relative(entry.path, source)
            if not expected[path_key(relative)] then return false, "unexpected_file" end
        end
    end
    return true
end

local function path_depth(relative)
    local _, separators = tostring(relative or ""):gsub("/", "")
    return separators
end

local function compatible_duplicate(left, right)
    if left.is_directory ~= right.is_directory then return false end
    if left.is_directory then return true end
    if tostring(left.sizeText or left.size or "") ~= tostring(right.sizeText or right.size or "") then
        return false
    end
    return left.contentSha ~= nil and right.contentSha ~= nil and left.contentSha == right.contentSha
end

local function add_inventory_entry(target, entry, depot, depot_root, allow_file_overlay)
    if entry.isSymlink then
        return nil, "manifest_symlink: " .. tostring(entry.relativePath)
    end
    local key = path_key(entry.pathKey or entry.relativePath)
    local value = {
        depot = depot,
        depotRoot = depot_root,
        relative = entry.relativePath,
        pathKey = key,
        is_directory = entry.isDirectory == true,
        is_file = entry.isDirectory ~= true,
        size = tonumber(entry.size or entry.sizeText) or 0,
        sizeText = tostring(entry.sizeText or entry.size or "0"),
        contentSha = entry.contentSha,
    }
    local previous = target[key]
    if previous and not compatible_duplicate(previous, value) and not
        (allow_file_overlay == true and previous.is_file and value.is_file) then
        return nil, "topology_mismatch: conflicting depot path " .. tostring(entry.relativePath)
    end
    if not previous then target[key] = value end
    return true
end

local function enumerate_downloaded_entries(job)
    local all_entries, files_total, bytes_total = {}, 0, 0
    for _, depot in ipairs(job.depots) do
        local source = content_depot_path(job.appid, depot.depotId)
        if not is_expected_content_path(job, depot, source) then
            return nil, "Downloaded depot directory is missing: " .. depot.depotId
        end
        local entries, list_err = fs.list_recursive(source)
        if not entries then return nil, "Could not enumerate depot " .. depot.depotId .. ": " .. tostring(list_err) end
        for _, entry in ipairs(entries) do
            if not fs.is_symlink(entry.path) then
                local relative_path = fs.relative(entry.path, source)
                if not is_safe_relative_path(relative_path) then
                    return nil, "Unsafe path in depot " .. depot.depotId
                end
                local entry_size = tonumber(entry.size)
                if not entry_size and entry.is_file and type(fs.file_size) == "function" then
                    local size_ok, size_value = pcall(fs.file_size, entry.path)
                    if size_ok then entry_size = tonumber(size_value) end
                end
                entry_size = entry_size or 0
                all_entries[#all_entries + 1] = {
                    kind = "copy",
                    depot = depot,
                    depotRoot = source,
                    relative = relative_path,
                    pathKey = path_key(relative_path),
                    is_directory = entry.is_directory == true,
                    is_file = entry.is_file == true,
                    size = entry_size,
                }
                if entry.is_file then
                    files_total = files_total + 1
                    bytes_total = bytes_total + entry_size
                end
            end
        end
    end
    return all_entries, files_total, bytes_total
end

local function build_verified_merge_entries(job)
    local current, target = {}, {}
    local warnings = {}
    local current_complete, target_complete = true, true

    for _, depot in ipairs(job.originalDepots or {}) do
        local manifest, manifest_error = read_depot_manifest(depot.depotId, depot.manifestId)
        if not manifest then
            current_complete = false
            warnings[#warnings + 1] = manifest_error
        else
            for _, entry in ipairs(manifest.entries or {}) do
                -- Multiple currently mounted depots can legitimately overlay
                -- the same file.  For stale cleanup only ownership of the path
                -- matters, not which current depot supplied the winning bytes.
                local ok, add_error = add_inventory_entry(current, entry, depot, nil, true)
                if not ok then
                    if job.mode == "force" then
                        current_complete = false
                        warnings[#warnings + 1] = { code = "topology_mismatch", detail = add_error }
                        break
                    end
                    return nil, add_error
                end
            end
        end
    end

    for _, depot in ipairs(job.depots or {}) do
        local source = content_depot_path(job.appid, depot.depotId)
        if not is_expected_content_path(job, depot, source) then
            return nil, "manifest_missing: downloaded depot directory " .. depot.depotId
        end
        local manifest, manifest_error = read_depot_manifest(depot.depotId, depot.manifestId)
        if not manifest then
            target_complete = false
            warnings[#warnings + 1] = manifest_error
        else
            for _, entry in ipairs(manifest.entries or {}) do
                local ok, add_error = add_inventory_entry(target, entry, depot, source)
                if not ok then
                    if job.mode == "force" then
                        target_complete = false
                        warnings[#warnings + 1] = { code = "topology_mismatch", detail = add_error }
                        break
                    end
                    return nil, add_error
                end
            end
        end
    end

    if job.mode == "verified" and (not current_complete or not target_complete) then
        local first = warnings[1] or {}
        return nil, "manifest_missing: " .. tostring(first.code or first.detail or "inventory unavailable")
    end
    if not current_complete or not target_complete then
        local fallback, files_total, bytes_total = enumerate_downloaded_entries(job)
        if not fallback then return nil, files_total end
        return {
            entries = fallback,
            filesTotal = files_total,
            bytesTotal = bytes_total,
            verified = false,
            warnings = warnings,
            staleFiles = 0,
        }
    end

    -- Confirm the materialized depot tree matches the exact target manifest.
    for _, entry in pairs(target) do
        if entry.is_file then
            local source, source_error = safe_depot_source(entry.depotRoot, entry.relative)
            if not source or not fs.exists(source) or fs.is_directory(source) then
                return nil, "manifest_missing: " .. tostring(source_error or entry.relative)
            end
            local actual_size = fs.file_size(source)
            if tonumber(actual_size) ~= entry.size then
                return nil, "manifest_mismatch: " .. entry.relative
            end
        end
    end
    for _, depot in ipairs(job.depots or {}) do
        local root = content_depot_path(job.appid, depot.depotId)
        local actual = fs.list_recursive(root) or {}
        for _, entry in ipairs(actual) do
            if entry.is_file and not fs.is_symlink(entry.path) then
                local relative = fs.relative(entry.path, root)
                local manifest_entry = target[path_key(relative)]
                if not manifest_entry or manifest_entry.is_file ~= true then
                    return nil, "manifest_mismatch: unexpected file " .. tostring(relative)
                end
            end
        end
    end

    local merge_entries, files_total, bytes_total, stale_files, additional_bytes = {}, 0, 0, 0, 0
    local stale_dirs = {}
    -- Deleting stale Steam-managed paths is valid only when the selected
    -- candidate is a complete, verified snapshot.  Force/manual/partial
    -- candidates are overlays: even if every supplied manifest parses, an
    -- omitted depot is unknown rather than obsolete and must be preserved.
    if job.staleCleanupAllowed == true then
        for key, entry in pairs(current) do
            local target_entry = target[key]
            if entry.is_file and (not target_entry or target_entry.is_directory) then
                merge_entries[#merge_entries + 1] = {
                    kind = "delete",
                    relative = entry.relative,
                    pathKey = key,
                    is_file = true,
                    size = 0,
                }
                stale_files = stale_files + 1
            elseif entry.is_directory and not target_entry then
                stale_dirs[#stale_dirs + 1] = entry
            end
        end
    end
    table.sort(merge_entries, function(left, right)
        local ld, rd = path_depth(left.relative), path_depth(right.relative)
        if ld ~= rd then return ld > rd end
        return left.pathKey < right.pathKey
    end)

    local target_entries = {}
    for _, entry in pairs(target) do target_entries[#target_entries + 1] = entry end
    table.sort(target_entries, function(left, right)
        if left.is_directory ~= right.is_directory then return left.is_directory end
        return left.pathKey < right.pathKey
    end)
    for _, entry in ipairs(target_entries) do
        entry.kind = "copy"
        merge_entries[#merge_entries + 1] = entry
        if entry.is_file then
            files_total = files_total + 1
            bytes_total = bytes_total + entry.size
            local previous = current[entry.pathKey]
            local previous_size = previous and previous.is_file and tonumber(previous.size) or 0
            if entry.size > previous_size then additional_bytes = additional_bytes + (entry.size - previous_size) end
        end
    end

    table.sort(stale_dirs, function(left, right)
        local ld, rd = path_depth(left.relative), path_depth(right.relative)
        if ld ~= rd then return ld > rd end
        return left.pathKey < right.pathKey
    end)
    for _, entry in ipairs(stale_dirs) do
        merge_entries[#merge_entries + 1] = {
            kind = "rmdir",
            relative = entry.relative,
            pathKey = entry.pathKey,
            is_directory = true,
            size = 0,
        }
    end

    return {
        entries = merge_entries,
        filesTotal = files_total,
        bytesTotal = bytes_total,
        verified = job.staleCleanupAllowed == true,
        warnings = warnings,
        staleFiles = stale_files,
        additionalBytes = additional_bytes,
    }
end

local function available_disk_bytes(path)
    if type(m_utils.exec) ~= "function" then return nil end
    local drive = tostring(path or ""):match("^(%a):")
    if not drive then return nil end
    local command = "powershell.exe -NoProfile -NonInteractive -Command \"[System.IO.DriveInfo]::new('" ..
        drive:upper() .. "').AvailableFreeSpace\""
    local ok, output = pcall(m_utils.exec, command)
    if not ok then return nil end
    return tonumber(tostring(output or ""):match("(%d+)%s*$"))
end

local function prepare_merge(job)
    local installed, install_error = load_installed_snapshot(job.appid)
    if not installed or not fs.is_directory(installed.installPath) then
        error("Installed game directory is no longer available")
    end
    if fs.absolute(installed.installPath) ~= fs.absolute(job.installPath) then
        error("Installed game directory changed while the downgrade was running")
    end
    if tostring(installed.fingerprint or "") ~= tostring(job.appManifestFingerprint or "") then
        error("install_changed: Steam changed the appmanifest while the downgrade was running")
    end
    local preflight_ok, preflight_code, preflight_message = run_preflight(installed)
    if not preflight_ok then error(tostring(preflight_code) .. ": " .. tostring(preflight_message)) end
    if type(io) ~= "table" or type(io.open) ~= "function" or
        type(os) ~= "table" or type(os.rename) ~= "function" then
        error("Atomic chunked file I/O is unavailable in this Lua host")
    end

    local plan, plan_error = build_verified_merge_entries(job)
    if not plan then error(plan_error) end
    local free_bytes = available_disk_bytes(job.installPath)
    local required_bytes = (tonumber(plan.additionalBytes) or 0) + 64 * 1024 * 1024
    if free_bytes and free_bytes < required_bytes then
        error("insufficient_space: requires " .. tostring(required_bytes) .. " available bytes")
    end
    local all_entries = plan.entries
    local files_total = plan.filesTotal
    local bytes_total = plan.bytesTotal

    MERGE_CONTEXTS[job.jobId] = {
        entries = all_entries,
        entryIndex = 1,
        sourceHandle = nil,
        targetHandle = nil,
        currentEntry = nil,
        currentTarget = nil,
        pendingPath = nil,
        backupPath = nil,
        currentBytes = 0,
        applyStarted = false,
        inTick = false,
        inventoryVerified = plan.verified == true,
    }

    update_job(job, {
        status = "merging",
        message = "Applying downloaded depots to the installed game",
        mergePrepared = true,
        filesTotal = files_total,
        filesCopied = 0,
        bytesTotal = bytes_total,
        bytesCopied = 0,
        filesRemoved = job.partialApplied == true and (tonumber(job.filesRemoved) or 0) or 0,
        staleFilesTotal = plan.staleFiles or 0,
        inventoryVerified = plan.verified == true,
        inventoryWarnings = plan.warnings,
    })
end

local function finish_merge(job, context)
    close_merge_handles(context)
    local sentinel_paths, sentinel_seen = {}, {}
    for _, entry in ipairs(context and context.entries or {}) do
        if entry.kind == "copy" and entry.is_file == true and
            not sentinel_seen[entry.pathKey] then
            sentinel_seen[entry.pathKey] = true
            sentinel_paths[#sentinel_paths + 1] = entry.relative
        end
    end
    if #sentinel_paths > 0 then
        local captured, capture_error = file_sentinel.capture(job.installPath, sentinel_paths)
        if captured then
            job.appliedSentinels = captured
            job.sentinelCaptureError = nil
        else
            job.appliedSentinels = nil
            job.sentinelCaptureError = type(capture_error) == "table" and
                tostring(capture_error.code or capture_error.detail) or tostring(capture_error)
        end
    end
    for _, depot in ipairs(job.depots) do depot.status = "merged" end
    local cleanup_warnings = {}
    for _, warning in ipairs(job.cleanupWarnings or {}) do cleanup_warnings[#cleanup_warnings + 1] = warning end
    if job.sentinelCaptureError then
        cleanup_warnings[#cleanup_warnings + 1] = "Could not create content drift sentinel: " ..
            job.sentinelCaptureError
    end
    for _, warning in ipairs(cleanup_downloaded_depots(job)) do cleanup_warnings[#cleanup_warnings + 1] = warning end
    local applied_ok, applied_error = save_applied_state(job)
    if not applied_ok then cleanup_warnings[#cleanup_warnings + 1] = tostring(applied_error) end
    MERGE_CONTEXTS[job.jobId] = nil
    job.cleanupWarnings = cleanup_warnings
    update_job(job, {
        status = "done",
        success = true,
        message = #cleanup_warnings == 0 and
            "Downgrade files were applied successfully" or
            "Downgrade files were applied; some temporary depot folders could not be removed",
        error = nil,
        errorCode = nil,
        partialApplied = false,
        mergePrepared = false,
    })
end

local function fail_merge(job, err)
    local context = MERGE_CONTEXTS[job.jobId]
    local partial = job.partialApplied == true or
        (context and context.applyStarted == true) or (tonumber(job.filesCopied) or 0) > 0
    close_merge_handles(context)
    MERGE_CONTEXTS[job.jobId] = nil
    local error_text = tostring(err)
    local error_code = error_code_from_text(error_text, "apply_failed")
    logger.warn("Downgrade merge failed for " .. job.appid .. ": " .. error_text)
    if partial then
        -- The target may contain already committed files or a harmless staged
        -- sibling. Keep every downloaded depot so prepare_merge can rebuild the
        -- exact plan and retry idempotently on the next status tick/restart.
        update_job(job, {
            status = "recovery_pending",
            success = false,
            error = error_text,
            errorCode = error_code,
            message = "Apply paused; downloaded depots were kept for recovery",
            partialApplied = true,
            mergePrepared = false,
            resumeMerge = true,
        })
        return
    end

    job.cleanupWarnings = cleanup_downloaded_depots(job, true)
    update_job(job, {
        status = "failed",
        success = false,
        error = error_text,
        errorCode = error_code,
        message = "Failed while applying downloaded depot files",
        partialApplied = partial,
        mergePrepared = false,
        resumeMerge = false,
    })
end

local function merge_budget_reached(started_at, copied_bytes, completed_entries)
    if copied_bytes >= MERGE_BYTES_PER_TICK or completed_entries >= MERGE_ENTRIES_PER_TICK then
        return true
    end
    local current = now_milliseconds()
    return current >= started_at and (current - started_at) >= MERGE_TIME_PER_TICK_MS
end

local function advance_merge_tick(job, context)
    local started_at = now_milliseconds()
    local tick_bytes = 0
    local tick_entries = 0

    while not merge_budget_reached(started_at, tick_bytes, tick_entries) do
        if context.sourceHandle then
            local data, read_err = context.sourceHandle:read(COPY_CHUNK_BYTES)
            if data ~= nil then
                local written, write_err = context.targetHandle:write(data)
                if not written then
                    error("Could not write " .. context.currentEntry.relative .. ": " .. tostring(write_err))
                end
                local count = #data
                context.currentBytes = context.currentBytes + count
                job.bytesCopied = (tonumber(job.bytesCopied) or 0) + count
                tick_bytes = tick_bytes + count
            else
                local entry = context.currentEntry
                local target = context.currentTarget
                local source_handle = context.sourceHandle
                local target_handle = context.targetHandle
                context.sourceHandle = nil
                context.targetHandle = nil
                pcall(function() source_handle:close() end)
                local closed, close_err = target_handle:close()
                if not closed then error("Could not finish " .. entry.relative .. ": " .. tostring(close_err or read_err)) end
                if read_err ~= nil then error("Could not read " .. entry.relative .. ": " .. tostring(read_err)) end
                if context.currentBytes ~= entry.size then
                    error("Depot file changed while copying: " .. entry.relative)
                end
                commit_staged_file(job, context, entry, target)
                context.currentEntry = nil
                context.currentBytes = 0
                job.filesCopied = (tonumber(job.filesCopied) or 0) + 1
                context.entryIndex = context.entryIndex + 1
                tick_entries = tick_entries + 1
            end
        else
            local entry = context.entries[context.entryIndex]
            if not entry then
                finish_merge(job, context)
                return
            end

            if entry.kind == "delete" then
                local target, target_err = safe_install_target(job.installPath, entry.relative)
                if not target then error(target_err) end
                if fs.exists(target) then
                    if fs.is_directory(target) then
                        error("topology_mismatch: managed file became a directory " .. entry.relative)
                    end
                    local removed, remove_err = fs.remove(target)
                    if removed == nil or removed == false or fs.exists(target) then
                        error("Could not remove stale Steam file " .. entry.relative .. ": " .. tostring(remove_err))
                    end
                    context.applyStarted = true
                    job.filesRemoved = (tonumber(job.filesRemoved) or 0) + 1
                end
                context.entryIndex = context.entryIndex + 1
                tick_entries = tick_entries + 1
            elseif entry.kind == "rmdir" then
                local target, target_err = safe_install_target(job.installPath, entry.relative)
                if not target then error(target_err) end
                if fs.exists(target) and fs.is_directory(target) then
                    local removed = fs.remove(target)
                    if removed == nil or removed == false or fs.exists(target) then
                        -- The directory contains something Steam does not own;
                        -- preserve it and continue instead of deleting a mod.
                        job.userDirectoriesPreserved = (tonumber(job.userDirectoriesPreserved) or 0) + 1
                    else
                        context.applyStarted = true
                    end
                end
                context.entryIndex = context.entryIndex + 1
                tick_entries = tick_entries + 1
            else

                local source, source_err = safe_depot_source(entry.depotRoot, entry.relative)
                if not source then error(source_err) end
                local target, target_err = safe_install_target(job.installPath, entry.relative)
                if not target then error(target_err) end

                if entry.is_directory then
                    local existed_before = fs.exists(target)
                    local conflict_removed = resolve_target_type_conflict(job, target, true, entry.relative)
                    local created, create_err = fs.create_directories(target)
                    if created == nil then error("Could not create target directory: " .. tostring(create_err)) end
                    if conflict_removed or not existed_before then context.applyStarted = true end
                    context.entryIndex = context.entryIndex + 1
                    tick_entries = tick_entries + 1
                elseif entry.is_file then
                    if not fs.exists(source) then error("Depot file disappeared: " .. entry.relative) end
                    local size, size_err = fs.file_size(source)
                    if size == nil or tonumber(size) ~= entry.size then
                        error("Depot file changed before copying: " .. entry.relative .. " (" .. tostring(size_err or size) .. ")")
                    end
                    local parent = fs.parent_path(target)
                    local parent_existed = fs.exists(parent)
                    local created, create_err = fs.create_directories(parent)
                    if created == nil then error("Could not create target directory: " .. tostring(create_err)) end
                    if not parent_existed then context.applyStarted = true end
                    local source_handle, open_source_err = io.open(source, "rb")
                    if not source_handle then error("Could not open depot file: " .. tostring(open_source_err)) end
                    local pending, backup = merge_journal_paths(job, context, target)
                    local recovered, recover_error = recover_merge_journal(target, pending, backup)
                    if not recovered then
                        pcall(function() source_handle:close() end)
                        error("Could not recover merge journal for " .. entry.relative .. ": " .. tostring(recover_error))
                    end
                    local target_handle, open_target_err = io.open(pending, "wb")
                    if not target_handle then
                        pcall(function() source_handle:close() end)
                        error("Could not open merge staging file: " .. tostring(open_target_err))
                    end
                    context.sourceHandle = source_handle
                    context.targetHandle = target_handle
                    context.currentEntry = entry
                    context.currentTarget = target
                    context.pendingPath = pending
                    context.backupPath = backup
                    context.currentBytes = 0
                    -- A staged file now exists inside the game directory. Even
                    -- though the final file is intact, keep depots if staging
                    -- fails so this apply remains retryable.
                    context.applyStarted = true
                else
                    context.entryIndex = context.entryIndex + 1
                    tick_entries = tick_entries + 1
                end
            end
        end
    end

    calculate_progress(job)
    persist_job(job)
end

local function advance_merge_safely(job)
    if not job or job.status ~= "merging" then return end
    local context = MERGE_CONTEXTS[job.jobId]
    if not context then
        fail_merge(job, "Merge context is unavailable; Steam or the plugin may have restarted")
        return
    end
    if context.inTick then return end

    context.inTick = true
    local ok, err = pcall(advance_merge_tick, job, context)
    local still_active = MERGE_CONTEXTS[job.jobId]
    if still_active then still_active.inTick = false end
    if not ok then fail_merge(job, err) end
end

local function start_merge(job)
    job.error = nil
    job.errorCode = nil
    job.attentionCode = nil
    update_job(job, {
        status = "merging",
        message = "Preparing to apply downloaded depots",
        error = nil,
    })
    local ok, err = pcall(prepare_merge, job)
    if not ok then fail_merge(job, err) end
end

local function recover_download_if_complete(job)
    if not job or job.downloadRecovery ~= true or
        (job.status ~= "downloading" and job.status ~= "stalled") then return false end
    local depot = job.depots and job.depots[job.currentIndex]
    if not depot then return false end
    local complete = depot_output_matches(job, depot)
    if not complete then return false end

    if ACTIVE_ACTION and ACTIVE_ACTION.appid == job.appid then ACTIVE_ACTION = nil end
    job.activeActionId = nil
    job.activeCommandStarted = nil
    job.downloadRecovery = nil
    job.outputVerificationError = nil
    depot.status = "downloaded"
    depot.completedMessage = "Recovered a completed Steam depot download"
    if job.cancelRequested then
        job.cleanupWarnings = cleanup_downloaded_depots(job, false)
        update_job(job, {
            status = "cancelled",
            success = false,
            errorCode = "cancelled",
            error = "Cancelled by user",
            message = "Downgrade cancelled; no depot files were applied",
        })
    elseif job.currentIndex < #job.depots then
        job.currentIndex = job.currentIndex + 1
        queue_current_depot(job)
    else
        start_merge(job)
    end
    return true
end

local function validate_start_payload(payload)
    local appid, appid_err = normalize_decimal(payload.appid or payload.appId, UINT32_MAX, "appid")
    if not appid then return nil, appid_err end
    if type(payload.depots) ~= "table" or #payload.depots < 1 then
        return nil, "depots must be a non-empty array"
    end
    if #payload.depots > MAX_DEPOTS then return nil, "Too many depots requested" end

    local depots = {}
    local seen = {}
    for index, raw in ipairs(payload.depots) do
        if type(raw) ~= "table" then return nil, "depots[" .. index .. "] must be an object" end
        local depot_id, depot_err = normalize_decimal(raw.depotId, UINT32_MAX, "depotId")
        if not depot_id then return nil, "depots[" .. index .. "]: " .. depot_err end
        local manifest_id, manifest_err = normalize_decimal(raw.manifestId, UINT64_MAX, "manifestId")
        if not manifest_id then return nil, "depots[" .. index .. "]: " .. manifest_err end
        if seen[depot_id] then return nil, "Duplicate depotId " .. depot_id end
        seen[depot_id] = true
        depots[#depots + 1] = {
            depotId = depot_id,
            manifestId = manifest_id,
            status = "pending",
        }
    end

    local mode = tostring(payload.mode or "verified"):lower()
    if mode ~= "verified" and mode ~= "force" then return nil, "mode must be verified or force" end
    local candidate_id = tostring(payload.candidateId or payload.versionId or "")
    if #candidate_id > 160 or (candidate_id ~= "" and not candidate_id:match("^[A-Za-z0-9_.:-]+$")) then
        return nil, "candidateId is invalid"
    end
    local target_build_id = nil
    if payload.buildId ~= nil and tostring(payload.buildId) ~= "" and tostring(payload.buildId) ~= "0" then
        target_build_id = normalize_decimal(payload.buildId, UINT64_MAX, "buildId")
        if not target_build_id then return nil, "buildId is invalid" end
    end
    local target_timestamp = normalize_nonnegative_decimal(tostring(payload.timestamp or "0")) or "0"

    return {
        appid = appid,
        depots = depots,
        mode = mode,
        candidateId = candidate_id,
        targetBuildId = target_build_id,
        targetTimestamp = target_timestamp,
        remembered = payload.pin ~= false and payload.remember ~= false,
    }
end

local function resolve_installed_game(appid, requested_depots)
    local installed, install_err, install_code = load_installed_snapshot(appid)
    if not installed then return nil, install_err, install_code end
    for _, depot in ipairs(requested_depots) do
        local current_manifest_id = installed.depotMap[depot.depotId]
        depot.currentManifestId = current_manifest_id
        depot.contentPath = content_depot_path(appid, depot.depotId)
        if fs.exists(depot.contentPath) and fs.is_directory(depot.contentPath) and not fs.is_empty(depot.contentPath) then
            return nil, "Temporary Steam content already exists for depot " .. depot.depotId,
                "temporary_content_exists", { depotId = depot.depotId }
        end
    end
    return installed
end

local function is_game_process_running(install_path)
    if type(m_utils.exec) ~= "function" then return false end
    local normalized = tostring(install_path or ""):gsub("/", "\\")
    if not normalized:match("^%a:\\") then return false end
    local quoted = normalized:gsub("'", "''")
    local command = "powershell.exe -NoProfile -NonInteractive -Command \"$p='" .. quoted ..
        "'; @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($p,[System.StringComparison]::OrdinalIgnoreCase) }).Count\""
    local ok, output = pcall(m_utils.exec, command)
    if not ok then return false end
    local count = tonumber(tostring(output or ""):match("(%d+)%s*$"))
    return count ~= nil and count > 0
end

local function verify_install_write_access(install_path)
    if type(io) ~= "table" or type(io.open) ~= "function" then return true end
    local probe = fs.join(install_path, ".akrams-downgrade-write-test")
    if fs.exists(probe) then return false, "The write-test path already exists" end
    local handle, open_error = io.open(probe, "wb")
    if not handle then return false, tostring(open_error) end
    local closed, close_error = handle:close()
    local removed, remove_error = fs.remove(probe)
    if not closed or removed == false or removed == nil or fs.exists(probe) then
        return false, tostring(close_error or remove_error or "cleanup failed")
    end
    return true
end

run_preflight = function(installed)
    if installed.ready ~= true then
        return nil, "steam_updating", "Steam is updating or staging this game", {
            reasons = installed.readinessReasons,
            stateFlags = installed.stateFlags,
            buildId = installed.buildId,
            targetBuildId = installed.targetBuildId,
        }
    end
    if is_game_process_running(installed.installPath) then
        return nil, "game_running", "Close the game before applying an older version", {}
    end
    local writable, write_error = verify_install_write_access(installed.installPath)
    if not writable then
        return nil, "install_not_writable", "The game folder is not writable", { detail = write_error }
    end
    return true
end

local function find_nonterminal_job()
    for _, job in pairs(JOBS) do
        if not TERMINAL_STATUS[job.status] then return job end
    end
    return nil
end

local function apply_watchdog(job)
    if not job or TERMINAL_STATUS[job.status] or job.status == "merging" or
        job.status == "recovery_pending" then return end
    local now = now_milliseconds()
    local last = tonumber(job.lastActivityAt or job.updatedAt or job.createdAt) or now
    if now < last then return end
    local elapsed = now - last
    local timeout_code
    if job.status == "probing" and elapsed >= PROBE_TIMEOUT_MS then
        timeout_code = "bridge_timeout"
    elseif job.status == "queued" and elapsed >= QUEUE_TIMEOUT_MS then
        timeout_code = "bridge_timeout"
    elseif job.status == "downloading" and elapsed >= DOWNLOAD_STALL_MS then
        update_job(job, {
            status = "stalled",
            success = false,
            attentionCode = "stalled",
            errorCode = "stalled",
            message = "Steam has not reported download activity; the command is still being observed",
        })
        return
    end
    if timeout_code then
        if ACTIVE_ACTION and ACTIVE_ACTION.appid == job.appid then ACTIVE_ACTION = nil end
        remove_queued_actions(job.appid)
        job.cleanupWarnings = cleanup_downloaded_depots(job, false)
        update_job(job, {
            status = "failed",
            success = false,
            errorCode = timeout_code,
            error = "The Steam console bridge did not respond before the deadline",
            message = "Steam console bridge timed out",
            activeActionId = nil,
            activeCommandStarted = nil,
        })
    end
end

function downgrade.get_versions(payload_json)
    local payload, payload_err = decode_payload(payload_json)
    if not payload then return failure("invalid_request", payload_err) end
    local appid, appid_err = normalize_decimal(payload.appid or payload.appId, UINT32_MAX, "appid")
    if not appid then return failure("invalid_appid", appid_err) end

    local installed, install_err, install_code = load_installed_snapshot(appid)
    if not installed then return failure(install_code or "install_invalid", install_err) end
    local current_inventory_verified, inventory_problems = verify_current_inventory(installed)

    local by_signature = {}
    for _, snapshot in ipairs(load_version_archive(appid, installed.depotIds)) do
        merge_snapshot(by_signature, snapshot, installed.depotIds)
    end

    -- Resolve local Steam evidence first.  It returns immediately and is also
    -- passed into the provider pipeline so a slow public source is skipped
    -- whenever an authoritative local answer already exists.
    local local_versions = {}
    local logs_dir = fs.join(steam_utils.detect_steam_install_path(), "logs")
    local log_paths = {
        fs.join(logs_dir, "content_log.previous.txt"),
        fs.join(logs_dir, "content_log.txt"),
    }
    for _, log_path in ipairs(log_paths) do
        if fs.exists(log_path) then
            local text = m_utils.read_file(log_path)
            for _, snapshot in ipairs(parse_content_log(text, appid, installed.depotIds)) do
                local_versions[#local_versions + 1] = snapshot
                merge_snapshot(by_signature, snapshot, installed.depotIds)
            end
        end
    end

    -- Multi-source discovery has bounded per-request/provider deadlines.  A
    -- provider failure is metadata, never a reason to discard local results.
    local catalog_result
    local catalog_job_id = tostring(payload.catalogJobId or "")
    if #catalog_job_id > 160 or
        (catalog_job_id ~= "" and not catalog_job_id:match("^[A-Za-z0-9_.:-]+$")) then
        return failure("invalid_request", "catalogJobId is invalid")
    end
    local catalog_options = {
        localVersions = local_versions,
        expandSources = payload.expandSources == true,
        allowSteamDb = payload.allowSteamDb ~= false,
        allowGitea = payload.allowGitea ~= false,
    }
    local catalog_ok, catalog_value
    if catalog_job_id ~= "" then
        catalog_ok, catalog_value = pcall(version_catalog.poll_catalog, catalog_job_id)
        if catalog_ok and type(catalog_value) == "table" and
            catalog_value.error == "catalog_job_not_found" then
            -- Jobs are intentionally in-memory and expire after a bounded TTL.
            -- Restart discovery locally instead of leaving an old modal stuck.
            catalog_ok, catalog_value = pcall(
                version_catalog.get_versions,
                appid,
                installed.depotIds,
                catalog_options
            )
        end
    else
        catalog_ok, catalog_value = pcall(
            version_catalog.get_versions,
            appid,
            installed.depotIds,
            catalog_options
        )
    end
    if catalog_ok and type(catalog_value) == "table" then
        catalog_result = catalog_value
        local catalog_profile_matches = tostring(catalog_result.appid or "") == appid and
            type(catalog_result.depotIds) == "table" and
            #catalog_result.depotIds == #installed.depotIds
        if catalog_profile_matches then
            for index, expected_depot_id in ipairs(installed.depotIds) do
                local actual_depot_id = normalize_decimal(
                    catalog_result.depotIds[index], UINT32_MAX, "depotId"
                )
                if actual_depot_id ~= expected_depot_id then
                    catalog_profile_matches = false
                    break
                end
            end
        end
        if not catalog_profile_matches then
            catalog_result = {
                success = false,
                error = "catalog_job_mismatch",
                catalogJobId = catalog_job_id,
                catalogPending = false,
            }
        end
        local discovered = type(catalog_result.candidates) == "table" and
            catalog_result.candidates or catalog_result.versions
        if type(discovered) == "table" then
            for _, snapshot in ipairs(discovered) do
                merge_snapshot(by_signature, snapshot, installed.depotIds)
            end
        elseif catalog_result.error then
            logger.warn("Downgrade: archived version catalog unavailable for " .. appid ..
                " (" .. tostring(catalog_result.error) .. ")")
        end
    else
        catalog_result = {
            success = false,
            error = "catalog_exception",
        }
        logger.warn("Downgrade: archived version catalog failed for " .. appid ..
            " (" .. tostring(catalog_value) .. ")")
    end

    merge_snapshot(by_signature, {
        buildId = installed.buildId,
        timestamp = installed.timestamp,
        depots = installed.depots,
        source = "steam-appmanifest",
        completeSnapshot = true,
    }, installed.depotIds)

    local snapshots = {}
    for _, snapshot in pairs(by_signature) do snapshots[#snapshots + 1] = snapshot end
    table.sort(snapshots, snapshot_is_newer)
    while #snapshots > MAX_VERSION_ARCHIVE_ENTRIES do table.remove(snapshots) end
    save_version_archive(appid, snapshots)

    local current_signature = depot_signature(installed.depots)
    local candidates = {}
    local candidate_map = {}
    for _, snapshot in ipairs(snapshots) do
        local timestamp_compare = compare_decimal_strings(snapshot.timestamp, installed.timestamp)
        local is_older = installed.timestamp == "0" or timestamp_compare == -1
        if snapshot.signature ~= current_signature and is_older then
            local candidate_id = "version-" .. snapshot.buildId .. "-" .. snapshot.timestamp .. "-" ..
                stable_signature_hash(snapshot.signature)
            local compatibility = install_profile.compatibility(
                installed,
                snapshot.depots,
                snapshot.completeSnapshot == true
            )
            if not current_inventory_verified then
                compatibility.status = "force"
                compatibility.reasons[#compatibility.reasons + 1] = "current_manifest_unavailable"
            end
            local candidate = {
                id = candidate_id,
                candidateId = candidate_id,
                buildId = snapshot.buildVerified and snapshot.buildId or nil,
                timestamp = snapshot.timestamp,
                depots = clone_depots(snapshot.depots),
                source = snapshot.source,
                compatibility = compatibility,
                completeSnapshot = snapshot.completeSnapshot == true,
            }
            candidates[#candidates + 1] = candidate
            candidate_map[candidate_id] = candidate
        end
    end

    CANDIDATES[appid] = candidate_map
    local applied = load_applied_state(appid, installed)
    local providers = type(catalog_result.providers) == "table" and catalog_result.providers or {
        {
            id = "archive",
            status = catalog_result.success == true and "ready" or "unavailable",
            errorCode = catalog_result.error,
        },
    }

    return {
        success = true,
        current = {
            buildId = installed.buildId,
            timestamp = installed.timestamp,
            depots = clone_depots(installed.depots),
            profile = {
                ready = installed.ready,
                readinessReasons = installed.readinessReasons,
                stateFlags = installed.stateFlags,
                targetBuildId = installed.targetBuildId,
                sharedDepots = installed.sharedDepots,
                fingerprint = installed.fingerprint,
                inventoryVerified = current_inventory_verified,
                inventoryProblems = inventory_problems,
            },
        },
        candidates = candidates,
        versions = candidates,
        providers = providers,
        applied = applied,
        catalogJobId = catalog_result.catalogJobId,
        catalogPending = catalog_result.catalogPending == true,
        catalogState = catalog_result.catalogState,
        jobState = catalog_result.jobState,
        catalog = {
            source = catalog_result.source or "multi-source",
            success = catalog_result.success == true,
            cached = catalog_result.cached == true,
            stale = catalog_result.stale == true,
            fetchedAt = catalog_result.fetchedAt,
            warning = catalog_result.warning,
            error = catalog_result.error,
            jobId = catalog_result.catalogJobId,
            pending = catalog_result.catalogPending == true,
            state = catalog_result.catalogState,
        },
    }
end

function downgrade.start(payload_json)
    local payload, payload_err = decode_payload(payload_json)
    if not payload then return failure("invalid_request", payload_err) end

    local request, validation_err = validate_start_payload(payload)
    if not request then return failure("invalid_request", validation_err) end

    recover_persisted_jobs()
    -- Loading a persisted interrupted job marks it failed and removes only its
    -- validated Steam content/app_APPID/depot_DEPOTID folders before retry.
    load_job(request.appid)
    local busy = find_nonterminal_job()
    if busy then
        return failure("job_active", "Another downgrade job is already active", {}, {
            activeAppid = busy.appid,
            activeState = busy,
        })
    end
    if ACTIVE_ACTION then
        return failure("bridge_busy", "The Steam console bridge is still handling another action")
    end

    local installed, install_err, install_code, install_params =
        resolve_installed_game(request.appid, request.depots)
    if not installed then return failure(install_code or "install_invalid", install_err, install_params) end

    local preflight_ok, preflight_code, preflight_message, preflight_params = run_preflight(installed)
    if not preflight_ok then return failure(preflight_code, preflight_message, preflight_params) end

    local selected = request.candidateId ~= "" and
        CANDIDATES[request.appid] and CANDIDATES[request.appid][request.candidateId] or nil
    local applied = load_applied_state(request.appid, installed)
    local requested_signature = depot_signature(canonicalize_depots(request.depots, nil, true) or {})
    local compatibility
    local target_complete_snapshot = false
    if selected then
        if requested_signature ~= depot_signature(selected.depots) then
            return failure("candidate_changed", "The selected version changed; refresh the version list")
        end
        compatibility = selected.compatibility
        target_complete_snapshot = selected.completeSnapshot == true
        request.targetBuildId = selected.buildId
        request.targetTimestamp = selected.timestamp
    elseif applied and request.candidateId ~= "" and request.candidateId == applied.candidateId and
        requested_signature == depot_signature(applied.depots) then
        target_complete_snapshot = applied.completeSnapshot == true
        compatibility = install_profile.compatibility(installed, applied.depots, target_complete_snapshot)
        request.targetBuildId = applied.buildId
        request.targetTimestamp = applied.timestamp
    else
        compatibility = { status = "force", reasons = { "unverified_manual_ids" } }
    end
    if compatibility.status ~= "verified" and request.mode ~= "force" then
        return failure("force_required", "This version is incomplete or unverified; enable Force to continue", {
            reasons = compatibility.reasons,
        })
    end
    if request.mode == "verified" then
        local inventory_ok, inventory_problems = verify_current_inventory(installed)
        if not inventory_ok then
            return failure("force_required", "Steam's current depot inventory is unavailable; enable Force to preserve all extra files", {
                reasons = { "current_manifest_unavailable" },
                problems = inventory_problems,
            })
        end
    end
    local stale_cleanup_allowed = request.mode == "verified" and
        compatibility.status == "verified" and target_complete_snapshot == true

    remove_queued_actions(request.appid)
    local job = {
        jobId = next_job_id(request.appid),
        appid = request.appid,
        status = "probing",
        success = false,
        message = "Checking Steam console download support",
        error = nil,
        depots = request.depots,
        currentIndex = 0,
        currentDepot = nil,
        installPath = installed.installPath,
        libraryPath = installed.libraryPath,
        manifestPath = installed.manifestPath,
        originalBuildId = installed.buildId,
        originalDepots = clone_depots(installed.depots),
        originalTimestamp = installed.timestamp,
        appManifestFingerprint = installed.fingerprint,
        candidateId = request.candidateId,
        targetBuildId = request.targetBuildId,
        targetTimestamp = request.targetTimestamp,
        mode = request.mode,
        remembered = request.remembered,
        compatibility = compatibility,
        targetCompleteSnapshot = target_complete_snapshot,
        staleCleanupAllowed = stale_cleanup_allowed,
        cancelRequested = false,
        partialApplied = false,
        createdAt = now_milliseconds(),
        filesTotal = 0,
        filesCopied = 0,
        bytesTotal = 0,
        bytesCopied = 0,
        retryCount = 0,
        lastActivityAt = now_milliseconds(),
    }
    JOBS[job.appid] = job
    update_job(job, {})

    local probe = {
        id = next_action_id(job, "probe"),
        jobId = job.jobId,
        type = "probe",
        commandStarted = false,
        appid = job.appid,
        commandName = "download_depot",
    }
    enqueue_action(probe)

    return { success = true, state = job }
end

function downgrade.get_status(payload_json)
    local payload, payload_err = decode_payload(payload_json)
    if not payload then return failure("invalid_request", payload_err) end
    local appid, appid_err = normalize_decimal(payload.appid or payload.appId, UINT32_MAX, "appid")
    if not appid then return failure("invalid_appid", appid_err) end

    local job = load_job(appid)
    if not job then return { success = true, state = { appid = appid, status = "idle", progress = { percent = 0 } } } end
    if job.status == "recovery_pending" and job.resumeMerge == true then
        job.resumeMerge = false
        start_merge(job)
    end
    recover_download_if_complete(job)
    apply_watchdog(job)
    advance_merge_safely(job)
    calculate_progress(job)
    return { success = true, state = job }
end

function downgrade.get_client_action()
    recover_persisted_jobs()
    for _, job in pairs(JOBS) do
        if job.status == "recovery_pending" and job.resumeMerge == true then
            job.resumeMerge = false
            start_merge(job)
        end
        recover_download_if_complete(job)
        if job.status == "merging" then
            advance_merge_safely(job)
            break
        end
        apply_watchdog(job)
    end
    if ACTIVE_ACTION then
        if ACTIVE_ACTION.type == "probe" or
            (ACTIVE_ACTION.type == "exec" and ACTIVE_ACTION.commandStarted ~= true) then
            return { success = true, hasAction = true, action = ACTIVE_ACTION }
        end
        if ACTIVE_ACTION.type == "exec" and ACTIVE_ACTION.commandStarted == true then
            return {
                success = true,
                hasAction = true,
                action = {
                    id = ACTIVE_ACTION.id,
                    jobId = ACTIVE_ACTION.jobId,
                    type = "observe",
                    commandStarted = true,
                    appid = ACTIVE_ACTION.appid,
                    depotId = ACTIVE_ACTION.depotId,
                    manifestId = ACTIVE_ACTION.manifestId,
                },
            }
        end
        return { success = true, hasAction = false }
    end

    while #ACTION_QUEUE > 0 do
        local action = table.remove(ACTION_QUEUE, 1)
        local job = JOBS[action.appid]
        if job and not TERMINAL_STATUS[job.status] then
            ACTIVE_ACTION = action
            job.activeActionId = action.id
            job.activeCommandStarted = action.commandStarted == true
            persist_job(job)
            return { success = true, hasAction = true, action = action }
        end
    end
    return { success = true, hasAction = false }
end

local function lines_from_event(event)
    local lines = {}
    local function collect(value)
        if type(value) == "string" then
            for line in (value .. "\n"):gmatch("([^\n]*)\n") do
                if line ~= "" then lines[#lines + 1] = line end
            end
        elseif type(value) == "table" then
            if type(value.spew) == "string" then collect(value.spew) end
            for _, item in ipairs(value) do collect(item) end
        end
    end
    collect(event.lines)
    collect(event.spew)
    collect(event.output)
    return lines
end

local function contains_decimal_marker(text, prefix, decimal_id)
    local needle = prefix .. decimal_id
    local from = 1
    while true do
        local start_at, end_at = text:find(needle, from, true)
        if not start_at then return false end
        local following = text:sub(end_at + 1, end_at + 1)
        if following == "" or not following:match("%d") then return true end
        from = end_at + 1
    end
end

local function event_matches_depot_manifest(event, depot)
    local depot_id = normalize_decimal(event.depotId, UINT32_MAX, "depotId")
    local manifest_id = normalize_decimal(event.manifestId, UINT64_MAX, "manifestId")
    return depot_id == depot.depotId and manifest_id == depot.manifestId
end

local function classify_console_event(event, depot)
    if event.type == "command_complete" or event.type == "complete" or event.event == "complete" then
        if event_matches_depot_manifest(event, depot) then
            return "complete", trim(event.message or event.spew), true, true
        end
        return nil, nil, false, false
    end
    if event.type == "command_failed" or event.type == "failed" or event.event == "failed" then
        if event_matches_depot_manifest(event, depot) then
            return "failed", trim(event.message or event.spew or "Steam reported a depot download failure"), true, true
        end
        return nil, nil, false, false
    end

    local saw_depot, saw_manifest = false, false
    local completion_detail, failure_detail = nil, nil
    for _, line in ipairs(lines_from_event(event)) do
        local lower = line:lower()
        local has_depot = contains_decimal_marker(lower, "depot_", depot.depotId) or
            contains_decimal_marker(lower, "depot ", depot.depotId)
        local has_manifest = contains_decimal_marker(lower, "manifest ", depot.manifestId)
        saw_depot = saw_depot or has_depot
        saw_manifest = saw_manifest or has_manifest
        if lower:find("depot download complete", 1, true) or lower:find("download complete", 1, true) then
            completion_detail = line:sub(1, 1024)
        end
        if lower:find("depot download failed", 1, true) or
            lower:find("failed to download depot", 1, true) or
            lower:find("error downloading depot", 1, true) or
            lower:find("error downloading manifest", 1, true) or
            lower:find("manifest not available", 1, true) or
            lower:find("invalid manifest", 1, true) or
            lower:find("invalid depot", 1, true) or
            lower:find("no subscription", 1, true) then
            failure_detail = line:sub(1, 1024)
        end
    end

    -- Never combine evidence from separate console batches.  A structured
    -- event already carries exact IDs; text is accepted only when this same
    -- event names the expected depot and manifest.  Steam commonly omits the
    -- manifest GID from its final path line, so the exact cached manifest file
    -- is an equivalent second factor for that completion only.
    local event_correlated = event_matches_depot_manifest(event, depot) or (saw_depot and saw_manifest)
    local exact_manifest_cached = completion_detail ~= nil and saw_depot and
        fs.exists(depot_manifest_path(depot.depotId, depot.manifestId))
    if failure_detail and event_correlated then
        return "failed", failure_detail, true, true
    end
    if completion_detail and (event_correlated or exact_manifest_cached) then
        return "complete", completion_detail, true, true
    end
    return nil, nil, saw_depot or saw_manifest or completion_detail ~= nil or failure_detail ~= nil,
        event_correlated
end

local function finish_cancelled_download(job, include_incomplete)
    local warnings = cleanup_downloaded_depots(job, include_incomplete)
    job.cleanupWarnings = warnings
    update_job(job, {
        status = "cancelled",
        success = false,
        errorCode = "cancelled",
        message = "Downgrade cancelled; no depot files were applied",
        error = "Cancelled by user",
        downloadMayStillBeRunning = false,
    })
end

local function report_event(event, allow_missing_action_id)
    if type(event) ~= "table" then return { success = false, error = "Invalid event" } end
    if not ACTIVE_ACTION then return { success = true, ignored = true, reason = "No active client action" } end

    local action_id = tostring(event.actionId or "")
    if action_id == "" and allow_missing_action_id then action_id = ACTIVE_ACTION.id end
    if action_id ~= ACTIVE_ACTION.id then
        return { success = false, error = "Stale or mismatched client action" }
    end

    local action = ACTIVE_ACTION
    local job = JOBS[action.appid]
    if not job then
        ACTIVE_ACTION = nil
        return { success = false, error = "Downgrade job no longer exists" }
    end

    if event.jobId ~= nil and tostring(event.jobId) ~= tostring(action.jobId or job.jobId or "") then
        return { success = false, error = "Stale or mismatched downgrade job" }
    end

    if event.type == "bridge_error" then
        local bridge_reason = trim(event.error or event.reason or event.message or "Steam console bridge failed")
        if action.type == "exec" and bridge_reason == "console_buffer_overflow" then
            update_job(job, {
                status = "downloading",
                message = "Steam is still downloading; excess console output was discarded",
            })
            return { success = true, state = job }
        end
        ACTIVE_ACTION = nil
        job.activeActionId = nil
        job.activeCommandStarted = nil
        job.cleanupWarnings = cleanup_downloaded_depots(job, false)
        update_job(job, {
            status = "failed",
            success = false,
            errorCode = bridge_reason,
            error = bridge_reason,
            message = "Steam console bridge failed",
        })
        return { success = true, state = job }
    end

    if action.type == "probe" then
        if event.type ~= "probe_result" and event.type ~= "bridge_ready" then
            return { success = true, ignored = true, state = job }
        end
        ACTIVE_ACTION = nil
        job.activeActionId = nil
        job.activeCommandStarted = nil
        local available = event.type == "bridge_ready" and event.available ~= false or event.available == true
        if not available then
            update_job(job, {
                status = "failed",
                success = false,
                errorCode = trim(event.reason or "console_command_unavailable"),
                error = trim(event.reason or "Steam download_depot command is unavailable"),
                message = "Steam console does not support depot downloads",
            })
            return { success = true, state = job }
        end

        job.currentIndex = 1
        queue_current_depot(job)
        return { success = true, state = job }
    end

    local depot = job.depots[job.currentIndex]
    if not depot or depot.depotId ~= action.depotId or depot.manifestId ~= action.manifestId then
        ACTIVE_ACTION = nil
        job.activeActionId = nil
        job.activeCommandStarted = nil
        update_job(job, {
            status = "failed",
            success = false,
            errorCode = "queue_mismatch",
            error = "Client action does not match the active depot",
            message = "Downgrade queue validation failed",
        })
        return { success = true, state = job }
    end


    if event.depotId ~= nil or event.manifestId ~= nil then
        if not event_matches_depot_manifest(event, depot) then
            return { success = false, error = "Event depot or manifest does not match the active action" }
        end
    end

    if event.type == "command_started" then
        if action.commandStarted == true then
            return {
                success = true,
                ignored = true,
                reason = "Command start was already claimed",
                state = job,
            }
        end
        action.commandStarted = true
        job.activeCommandStarted = true
        if type(job.currentDepot) == "table" then job.currentDepot.commandStarted = true end
        depot.status = "downloading"
        update_job(job, {
            status = "downloading",
            message = job.cancelRequested and
                "Stopping after the current Steam depot download finishes" or
                "Steam is downloading depot " .. depot.depotId,
        })
        return { success = true, state = job }
    end

    local classification, detail, _, event_correlated = classify_console_event(event, depot)
    if not classification then
        -- The matching action id alone is not enough: the bridge observes a
        -- shared Steam console and unrelated chatter must not defeat the stall
        -- watchdog. Only exact structured IDs or both expected textual IDs in
        -- this same event count as download activity.
        if event_correlated then note_correlated_activity(job) end
        return { success = true, ignored = true, state = job }
    end

    if classification == "complete" then
        local output_matches, output_error = depot_output_matches(job, depot)
        if not output_matches then
            -- A console completion line can arrive before Steam has finished
            -- materializing/closing the depot tree. Keep observing the same
            -- action and never remove a directory Steam may still be writing.
            job.downloadRecovery = true
            job.outputVerificationError = tostring(output_error or "output_mismatch")
            depot.status = "downloading"
            update_job(job, {
                status = "downloading",
                success = false,
                message = "Steam reported completion; waiting for exact depot output verification",
            })
            return {
                success = true,
                ignored = true,
                verificationPending = true,
                reason = job.outputVerificationError,
                state = job,
            }
        end
    end

    ACTIVE_ACTION = nil
    job.activeActionId = nil
    job.activeCommandStarted = nil
    job.downloadRecovery = nil
    job.outputVerificationError = nil
    if classification == "failed" then
        depot.status = "failed"
        if job.cancelRequested then
            finish_cancelled_download(job, true)
            return { success = true, terminalAccepted = true, state = job }
        end
        job.cleanupWarnings = cleanup_downloaded_depots(job, true)
        local detail_lower = tostring(detail or ""):lower()
        local error_code = (detail_lower:find("no subscription", 1, true) or
            detail_lower:find("access denied", 1, true) or
            detail_lower:find("not licensed", 1, true)) and "entitlement_denied" or
            ((detail_lower:find("manifest", 1, true) and
                (detail_lower:find("not available", 1, true) or
                    detail_lower:find("invalid", 1, true))) and "manifest_missing" or "download_failed")
        update_job(job, {
            status = "failed",
            success = false,
            errorCode = error_code,
            errorParams = { depotId = depot.depotId, manifestId = depot.manifestId },
            error = detail ~= "" and detail or "Steam failed to download depot " .. depot.depotId,
            message = "Steam failed to download depot " .. depot.depotId,
        })
        return { success = true, terminalAccepted = true, state = job }
    end

    depot.status = "downloaded"
    depot.completedMessage = detail
    calculate_progress(job)
    persist_job(job)

    if job.cancelRequested then
        finish_cancelled_download(job)
        return { success = true, terminalAccepted = true, state = job }
    end

    if job.currentIndex < #job.depots then
        job.currentIndex = job.currentIndex + 1
        queue_current_depot(job)
        return { success = true, terminalAccepted = true, state = job }
    end

    start_merge(job)
    return { success = true, terminalAccepted = true, state = job }
end

function downgrade.report_client_event(event_json)
    local event, event_err = decode_payload(event_json)
    if not event then return { success = false, error = event_err } end
    if type(event.events) == "table" then
        local last_result = { success = true, ignored = true, reason = "Empty event batch" }
        for _, item in ipairs(event.events) do
            if type(item) ~= "table" then return { success = false, error = "Invalid event in batch" } end
            if item.actionId == nil then item.actionId = event.actionId end
            if item.jobId == nil then item.jobId = event.jobId end
            last_result = report_event(item, item.type == "bridge_ready")
            if last_result.success == false then return last_result end
        end
        return last_result
    end
    return report_event(event, event.type == "bridge_ready")
end

function downgrade.report_console(payload_json)
    local event, event_err = decode_payload(payload_json)
    if not event then return { success = false, error = event_err } end

    local appid, appid_err = normalize_decimal(event.appid or event.appId, UINT32_MAX, "appid")
    if not appid then return { success = false, error = appid_err } end
    if not ACTIVE_ACTION or ACTIVE_ACTION.appid ~= appid then
        return { success = true, ignored = true, reason = "No active console action for this app" }
    end
    event.actionId = ACTIVE_ACTION.id
    event.type = event.type or "console_lines"
    return report_event(event, true)
end

function downgrade.cancel(payload_json)
    local payload, payload_err = decode_payload(payload_json)
    if not payload then return failure("invalid_request", payload_err) end
    local appid, appid_err = normalize_decimal(payload.appid or payload.appId, UINT32_MAX, "appid")
    if not appid then return failure("invalid_appid", appid_err) end

    local job = load_job(appid)
    if not job then return { success = true, message = "Nothing to cancel" } end
    if job.status == "merging" then
        return {
            success = false,
            error = "The merge has already started and cannot be safely cancelled without a backup",
            state = job,
        }
    end
    if TERMINAL_STATUS[job.status] then return { success = true, message = "Nothing to cancel", state = job } end

    job.cancelRequested = true
    remove_queued_actions(appid)

    if ACTIVE_ACTION and ACTIVE_ACTION.appid == appid and
        ACTIVE_ACTION.type == "exec" and ACTIVE_ACTION.commandStarted == true then
        update_job(job, {
            status = "downloading",
            success = false,
            message = "Stopping after the current Steam depot download finishes",
            downloadMayStillBeRunning = true,
        })
    else
        if ACTIVE_ACTION and ACTIVE_ACTION.appid == appid then ACTIVE_ACTION = nil end
        job.activeActionId = nil
        job.activeCommandStarted = nil
        finish_cancelled_download(job)
    end

    return { success = true, state = job }
end

downgrade._test = {
    parse_vdf = parse_vdf,
    parse_finished_update_line = parse_finished_update_line,
    parse_content_log = parse_content_log,
    normalize_decimal = normalize_decimal,
    is_safe_relative_path = is_safe_relative_path,
    load_installed_snapshot = load_installed_snapshot,
    classify_console_event = classify_console_event,
    build_verified_merge_entries = build_verified_merge_entries,
    verify_current_inventory = verify_current_inventory,
    depot_manifest_path = depot_manifest_path,
}

return downgrade
