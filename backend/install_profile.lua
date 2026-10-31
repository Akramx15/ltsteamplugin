local profile = {}

local UINT32_MAX = "4294967295"
local UINT64_MAX = "18446744073709551615"

local function decimal(value, maximum, allow_zero)
    value = tostring(value or "")
    if not value:match("^%d+$") then return nil end
    value = value:gsub("^0+", "")
    if value == "" then value = "0" end
    if not allow_zero and value == "0" then return nil end
    if #value > #maximum or (#value == #maximum and value > maximum) then return nil end
    return value
end

local function decimal_less(left, right)
    if #left ~= #right then return #left < #right end
    return left < right
end

local function collect_depots(raw)
    local result, seen = {}, {}
    if type(raw) ~= "table" then return result end
    for raw_id, value in pairs(raw) do
        local depot_id = decimal(raw_id, UINT32_MAX, false)
        local manifest_id = type(value) == "table" and
            decimal(value.manifest or value.Manifest, UINT64_MAX, false) or nil
        if depot_id and manifest_id and not seen[depot_id] then
            seen[depot_id] = true
            result[#result + 1] = {
                depotId = depot_id,
                manifestId = manifest_id,
                size = decimal(type(value) == "table" and value.size or nil, UINT64_MAX, true),
            }
        end
    end
    table.sort(result, function(left, right) return decimal_less(left.depotId, right.depotId) end)
    return result
end

local function collect_shared_depots(raw)
    local result, seen = {}, {}
    if type(raw) ~= "table" then return result end
    for raw_id, raw_appid in pairs(raw) do
        local depot_id = decimal(raw_id, UINT32_MAX, false)
        local appid = decimal(raw_appid, UINT32_MAX, false)
        if depot_id and appid and not seen[depot_id] then
            seen[depot_id] = true
            result[#result + 1] = { depotId = depot_id, appid = appid }
        end
    end
    table.sort(result, function(left, right) return decimal_less(left.depotId, right.depotId) end)
    return result
end

local function fingerprint(parts)
    -- Two small integer accumulators are deterministic in every Lua runtime
    -- used by Millennium and avoid converting Steam's 64-bit IDs to numbers.
    local first, second = 2166136261, 5381
    local text = table.concat(parts, "|")
    for index = 1, #text do
        local byte = text:byte(index)
        -- Multipliers stay below IEEE-754's exact-integer boundary even when
        -- this module runs on Lua builds that represent numbers as doubles.
        first = (first * 655 + byte) % 4294967291
        second = (second * 33 + byte) % 4294967279
    end
    return string.format("%08x%08x-%d", first, second, #text)
end

function profile.from_app_state(appid, app_state, paths)
    if type(app_state) ~= "table" then return nil, "appmanifest_invalid" end
    local parsed_appid = decimal(app_state.appid, UINT32_MAX, false)
    if parsed_appid ~= tostring(appid) then return nil, "appmanifest_mismatch" end

    local depots = collect_depots(app_state.InstalledDepots)
    if #depots == 0 then return nil, "no_installed_depots" end
    local depot_map, depot_ids = {}, {}
    for _, depot in ipairs(depots) do
        depot_map[depot.depotId] = depot.manifestId
        depot_ids[#depot_ids + 1] = depot.depotId
    end

    local build_id = decimal(app_state.buildid, UINT64_MAX, false)
    if not build_id then return nil, "build_missing" end
    local target_build_id = decimal(app_state.TargetBuildID, UINT64_MAX, true) or build_id
    local state_flags = decimal(app_state.StateFlags, UINT64_MAX, true) or "0"
    local last_updated = decimal(app_state.LastUpdated, UINT64_MAX, true) or "0"
    local bytes_to_download = decimal(app_state.BytesToDownload, UINT64_MAX, true) or "0"
    local bytes_downloaded = decimal(app_state.BytesDownloaded, UINT64_MAX, true) or "0"
    local bytes_to_stage = decimal(app_state.BytesToStage, UINT64_MAX, true) or "0"
    local bytes_staged = decimal(app_state.BytesStaged, UINT64_MAX, true) or "0"

    local readiness_reasons = {}
    if state_flags ~= "4" then readiness_reasons[#readiness_reasons + 1] = "state_flags" end
    if target_build_id ~= "0" and target_build_id ~= build_id then
        readiness_reasons[#readiness_reasons + 1] = "target_build"
    end
    if bytes_to_download ~= "0" and bytes_downloaded ~= bytes_to_download then
        readiness_reasons[#readiness_reasons + 1] = "download_pending"
    end
    if bytes_to_stage ~= "0" and bytes_staged ~= bytes_to_stage then
        readiness_reasons[#readiness_reasons + 1] = "staging_pending"
    end

    local fp_parts = {
        tostring(appid), build_id, target_build_id, state_flags, last_updated,
        bytes_to_download, bytes_downloaded, bytes_to_stage, bytes_staged,
    }
    for _, depot in ipairs(depots) do
        fp_parts[#fp_parts + 1] = depot.depotId .. "=" .. depot.manifestId
    end

    return {
        appid = tostring(appid),
        installPath = paths and paths.installPath or nil,
        libraryPath = paths and paths.libraryPath or nil,
        manifestPath = paths and paths.manifestPath or nil,
        buildId = build_id,
        targetBuildId = target_build_id,
        timestamp = last_updated,
        stateFlags = state_flags,
        bytesToDownload = bytes_to_download,
        bytesDownloaded = bytes_downloaded,
        bytesToStage = bytes_to_stage,
        bytesStaged = bytes_staged,
        depots = depots,
        depotIds = depot_ids,
        depotMap = depot_map,
        sharedDepots = collect_shared_depots(app_state.SharedDepots),
        ready = #readiness_reasons == 0,
        readinessReasons = readiness_reasons,
        fingerprint = fingerprint(fp_parts),
    }
end

function profile.compatibility(current, target_depots, complete_snapshot)
    local reasons, target_map = {}, {}
    for _, depot in ipairs(target_depots or {}) do
        if target_map[depot.depotId] then reasons[#reasons + 1] = "duplicate_depot" end
        target_map[depot.depotId] = depot.manifestId
    end
    if #target_depots == 0 then reasons[#reasons + 1] = "no_target_depots" end

    local missing, added = {}, {}
    for _, depot_id in ipairs(current.depotIds or {}) do
        if not target_map[depot_id] then missing[#missing + 1] = depot_id end
    end
    for depot_id in pairs(target_map) do
        if not current.depotMap[depot_id] then added[#added + 1] = depot_id end
    end
    table.sort(missing, decimal_less)
    table.sort(added, decimal_less)

    if not complete_snapshot then reasons[#reasons + 1] = "incomplete_snapshot" end
    -- An older complete snapshot may legitimately omit a depot that exists in
    -- the current build; its current manifest gives us an exact safe deletion
    -- set.  A target-only depot is different: without PICS depot metadata we
    -- cannot know whether it belongs in this install root (language/DLC/shared
    -- content), so keep that case behind the explicit Force switch.
    if #added > 0 then reasons[#reasons + 1] = "added_target_depots" end
    local status = (#reasons == 0 and complete_snapshot) and "verified" or "force"
    return {
        status = status,
        reasons = reasons,
        missingCurrentDepots = missing,
        addedTargetDepots = added,
        topologyChanged = #missing > 0 or #added > 0,
    }
end

profile._test = { decimal = decimal, fingerprint = fingerprint }

return profile
