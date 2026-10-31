-- Lightweight, deterministic file sentinels for detecting content drift when
-- Steam keeps the same build ID (for example, after Verify Installed Files).
--
-- This is deliberately not a cryptographic integrity checker.  It samples a
-- bounded prefix and suffix from a small deterministic subset of caller-owned
-- candidate paths.  No subprocess is started and no whole large file is read.

local fs = require("fs")
local depot_manifest = require("depot_manifest")

local file_sentinel = {}

local SCHEMA_VERSION = 1
local ALGORITHM = "quick-first-last-poly32x2-v1"
local HARD_MAX_FILES = 12
local HARD_MAX_CANDIDATES = 200000
local HARD_MAX_BYTES_PER_FILE = 128 * 1024
local DEFAULT_MAX_FILES = HARD_MAX_FILES
local DEFAULT_MAX_BYTES_PER_FILE = HARD_MAX_BYTES_PER_FILE
local MAX_SAFE_FILE_SIZE = 9007199254740991
local HASH_MOD_1 = 4294967291
local HASH_MOD_2 = 4294967279

local function is_callable(value)
    -- Lupa and some Millennium bindings expose native callables as userdata.
    return type(value) == "function" or type(value) == "userdata"
end

file_sentinel.schemaVersion = SCHEMA_VERSION
file_sentinel.algorithm = ALGORITHM
file_sentinel.limits = {
    maxFiles = HARD_MAX_FILES,
    maxCandidates = HARD_MAX_CANDIDATES,
    maxBytesPerFile = HARD_MAX_BYTES_PER_FILE,
}

local function problem(code, detail, relative_path, extra)
    local result = { code = tostring(code or "sentinel_error") }
    if detail ~= nil then result.detail = tostring(detail) end
    if relative_path ~= nil then result.relativePath = tostring(relative_path) end
    if type(extra) == "table" then
        for key, value in pairs(extra) do result[key] = value end
    end
    return result
end

local function positive_integer(value, fallback, maximum)
    if value == nil then return fallback end
    local numeric = tonumber(value)
    if not numeric or numeric ~= math.floor(numeric) or
        numeric < 1 or numeric > maximum then
        return nil
    end
    return numeric
end

local function normalize_options(options)
    options = options or {}
    if type(options) ~= "table" then
        return nil, problem("invalid_options", "expected_table")
    end
    local max_files = positive_integer(
        options.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES
    )
    local max_bytes = positive_integer(
        options.maxBytesPerFile,
        DEFAULT_MAX_BYTES_PER_FILE,
        HARD_MAX_BYTES_PER_FILE
    )
    -- A large file needs at least one byte from each end.
    if not max_files or not max_bytes or max_bytes < 2 then
        return nil, problem("invalid_options", "limits_out_of_range")
    end
    if options.openFile ~= nil and not is_callable(options.openFile) then
        return nil, problem("invalid_options", "openFile_must_be_function")
    end
    return {
        maxFiles = max_files,
        maxBytesPerFile = max_bytes,
        openFile = options.openFile or function(path, mode) return io.open(path, mode) end,
    }
end

local function strict_array_length(value)
    if type(value) ~= "table" then return nil end
    local count, maximum = 0, 0
    for key in pairs(value) do
        if type(key) ~= "number" or key ~= math.floor(key) or key < 1 then
            return nil
        end
        count = count + 1
        if key > maximum then maximum = key end
        if count > HARD_MAX_CANDIDATES or maximum > HARD_MAX_CANDIDATES then
            return nil, "too_many_candidates"
        end
    end
    if count ~= maximum then return nil end
    return count
end

local function hash_update(first, second, text)
    for index = 1, #text do
        local byte = text:byte(index)
        -- Both products remain well below 2^53, so this is deterministic in
        -- LuaJIT's double-number mode as well as integer-capable Lua builds.
        first = (first * 655 + byte + 17) % HASH_MOD_1
        second = (second * 257 + byte + 97) % HASH_MOD_2
    end
    return first, second
end

local function hash_parts(parts)
    local first, second = 2166136261, 1315423911
    for index, part in ipairs(parts) do
        local value = tostring(part or "")
        first, second = hash_update(first, second, tostring(#value) .. ":")
        first, second = hash_update(first, second, value)
        first, second = hash_update(first, second, "\0" .. tostring(index) .. "\0")
    end
    return string.format("%08x%08x", math.floor(first), math.floor(second))
end

local function normalize_candidates(relative_paths)
    local count, length_error = strict_array_length(relative_paths)
    if not count then
        return nil, problem(
            length_error or "invalid_paths",
            length_error and tostring(HARD_MAX_CANDIDATES) or "expected_dense_array"
        )
    end
    if count == 0 then return nil, problem("no_files", "empty_candidate_list") end

    local normalized = {}
    local seen = {}
    for index = 1, count do
        local raw_path = relative_paths[index]
        local item, path_error = depot_manifest.normalize_path(raw_path)
        if not item then
            return nil, problem("unsafe_path", path_error, raw_path, {
                candidateIndex = index,
            })
        end
        if seen[item.pathKey] then
            return nil, problem("duplicate_path", "case_insensitive_collision", item.relativePath)
        end
        seen[item.pathKey] = true
        item.rank = hash_parts({ "path-rank-v1", item.pathKey })
        normalized[#normalized + 1] = item
    end
    return normalized
end

local function choose_candidates(normalized, maximum)
    table.sort(normalized, function(left, right)
        if left.rank ~= right.rank then return left.rank < right.rank end
        return left.pathKey < right.pathKey
    end)
    while #normalized > maximum do normalized[#normalized] = nil end
    table.sort(normalized, function(left, right) return left.pathKey < right.pathKey end)
    return normalized
end

function file_sentinel.select_paths(relative_paths, options)
    local normalized_options, options_error = normalize_options(options)
    if not normalized_options then return nil, options_error end
    local normalized, normalize_error = normalize_candidates(relative_paths)
    if not normalized then return nil, normalize_error end
    choose_candidates(normalized, normalized_options.maxFiles)
    local selected = {}
    for index, item in ipairs(normalized) do selected[index] = item.relativePath end
    return selected
end

local function safe_call_boolean(name, path)
    local callable = fs[name]
    if not is_callable(callable) then
        return nil, problem("filesystem_api_unavailable", name, path)
    end
    local ok, result = pcall(callable, path)
    if not ok then return nil, problem("filesystem_error", tostring(result), path) end
    return result == true
end

local function absolute_path(path)
    if not is_callable(fs.absolute) then
        return nil, problem("filesystem_api_unavailable", "absolute", path)
    end
    local ok, value = pcall(fs.absolute, path)
    if not ok or type(value) ~= "string" or value == "" then
        return nil, problem("filesystem_error", ok and "invalid_absolute_path" or value, path)
    end
    return value
end

local function path_key(path)
    local key = tostring(path):gsub("/", "\\")
    while #key > 3 and key:sub(-1) == "\\" do key = key:sub(1, -2) end
    return string.lower(key)
end

local function prepare_root(install_root)
    if type(install_root) ~= "string" or install_root == "" or
        install_root:find("%z") or install_root:find("[\r\n]") then
        return nil, problem("invalid_install_root", "expected_nonempty_path")
    end
    local root, absolute_error = absolute_path(install_root)
    if not root then return nil, absolute_error end
    local exists, exists_error = safe_call_boolean("exists", root)
    if exists == nil then return nil, exists_error end
    if not exists then return nil, problem("install_root_missing", nil, root) end
    local is_directory, directory_error = safe_call_boolean("is_directory", root)
    if is_directory == nil then return nil, directory_error end
    if not is_directory then return nil, problem("invalid_install_root", "not_directory", root) end
    local is_link, link_error = safe_call_boolean("is_symlink", root)
    if is_link == nil then return nil, link_error end
    if is_link then return nil, problem("install_root_is_symlink", nil, root) end
    return { path = root, key = path_key(root) }
end

local function resolve_regular_file(root, normalized)
    if not is_callable(fs.join) then
        return nil, problem("filesystem_api_unavailable", "join", normalized.relativePath)
    end
    local current = root.path
    local segment_index = 0
    local segments = {}
    for segment in normalized.relativePath:gmatch("[^/]+") do
        segment_index = segment_index + 1
        segments[segment_index] = segment
    end

    for index, segment in ipairs(segments) do
        local ok, joined = pcall(fs.join, current, segment)
        if not ok or type(joined) ~= "string" or joined == "" then
            return nil, problem("filesystem_error", ok and "invalid_join" or joined,
                normalized.relativePath)
        end
        current = joined
        local absolute, absolute_error = absolute_path(current)
        if not absolute then return nil, absolute_error end
        local candidate_key = path_key(absolute)
        if candidate_key:sub(1, #root.key + 1) ~= root.key .. "\\" then
            return nil, problem("path_outside_install_root", nil, normalized.relativePath)
        end
        current = absolute

        local is_link, link_error = safe_call_boolean("is_symlink", current)
        if is_link == nil then return nil, link_error end
        if is_link then
            return nil, problem("path_is_symlink", nil, normalized.relativePath, {
                segmentIndex = index,
            })
        end
        local exists, exists_error = safe_call_boolean("exists", current)
        if exists == nil then return nil, exists_error end
        if not exists then return nil, problem("file_missing", nil, normalized.relativePath) end
        local is_directory, directory_error = safe_call_boolean("is_directory", current)
        if is_directory == nil then return nil, directory_error end
        if index < #segments and not is_directory then
            return nil, problem("invalid_path_component", "not_directory",
                normalized.relativePath, { segmentIndex = index })
        end
        if index == #segments and is_directory then
            return nil, problem("not_regular_file", "is_directory", normalized.relativePath)
        end
    end
    return current
end

local function close_quietly(handle)
    if handle and type(handle.close) == "function" then pcall(handle.close, handle) end
end

local function seek(handle, whence, offset, relative_path)
    if type(handle.seek) ~= "function" then
        return nil, problem("file_seek_failed", "seek_unavailable", relative_path)
    end
    local ok, value = pcall(handle.seek, handle, whence, offset)
    if not ok or type(value) ~= "number" then
        return nil, problem("file_seek_failed", ok and "invalid_offset" or value, relative_path)
    end
    return value
end

local function read_exact(handle, length, relative_path)
    if length == 0 then return "" end
    if type(handle.read) ~= "function" then
        return nil, problem("file_read_failed", "read_unavailable", relative_path)
    end
    local ok, value = pcall(handle.read, handle, length)
    if not ok or type(value) ~= "string" or #value ~= length then
        return nil, problem("file_read_failed", ok and "short_read" or value,
            relative_path, { expectedBytes = length, actualBytes = type(value) == "string" and #value or 0 })
    end
    return value
end

local function fingerprint_file(path, relative_path, maximum_bytes, open_file)
    local open_ok, handle, open_error = pcall(open_file, path, "rb")
    if not open_ok or not handle then
        return nil, problem("file_open_failed", open_ok and open_error or handle, relative_path)
    end

    local size, size_error = seek(handle, "end", 0, relative_path)
    if not size then close_quietly(handle); return nil, size_error end
    if size < 0 or size ~= math.floor(size) or size > MAX_SAFE_FILE_SIZE then
        close_quietly(handle)
        return nil, problem("unsupported_file_size", tostring(size), relative_path)
    end

    local first_budget = math.floor((maximum_bytes + 1) / 2)
    local first_length = math.min(size, first_budget)
    local tail_length = math.min(size - first_length, maximum_bytes - first_length)
    local _, first_seek_error = seek(handle, "set", 0, relative_path)
    if first_seek_error then close_quietly(handle); return nil, first_seek_error end
    local first, first_error = read_exact(handle, first_length, relative_path)
    if not first then close_quietly(handle); return nil, first_error end

    local tail = ""
    if tail_length > 0 then
        local _, tail_seek_error = seek(handle, "set", size - tail_length, relative_path)
        if tail_seek_error then close_quietly(handle); return nil, tail_seek_error end
        tail, tail_seek_error = read_exact(handle, tail_length, relative_path)
        if not tail then close_quietly(handle); return nil, tail_seek_error end
    end

    local final_size, final_size_error = seek(handle, "end", 0, relative_path)
    close_quietly(handle)
    if not final_size then return nil, final_size_error end
    if final_size ~= size then
        return nil, problem("file_changed_while_reading", nil, relative_path)
    end

    local size_text = string.format("%.0f", size)
    local digest = hash_parts({
        ALGORITHM,
        size_text,
        tostring(first_length),
        first,
        tostring(tail_length),
        tail,
    })
    return {
        relativePath = relative_path,
        pathKey = string.lower(relative_path),
        size = size,
        sizeText = size_text,
        quickHash = "quick-v1:" .. digest,
        sampledBytes = first_length + tail_length,
        firstBytes = first_length,
        lastBytes = tail_length,
    }
end

function file_sentinel.capture(install_root, relative_paths, options)
    local normalized_options, options_error = normalize_options(options)
    if not normalized_options then return nil, options_error end
    local normalized, normalize_error = normalize_candidates(relative_paths)
    if not normalized then return nil, normalize_error end
    local candidate_count = #normalized
    choose_candidates(normalized, normalized_options.maxFiles)

    local root, root_error = prepare_root(install_root)
    if not root then return nil, root_error end
    local files = {}
    for index, item in ipairs(normalized) do
        local path, path_error = resolve_regular_file(root, item)
        if not path then return nil, path_error end
        local is_link, link_error = safe_call_boolean("is_symlink", path)
        if is_link == nil then return nil, link_error end
        if is_link then return nil, problem("path_is_symlink", nil, item.relativePath) end
        local fingerprint, fingerprint_error = fingerprint_file(
            path,
            item.relativePath,
            normalized_options.maxBytesPerFile,
            normalized_options.openFile
        )
        if not fingerprint then return nil, fingerprint_error end
        -- Recheck after IO so a swapped symlink is never persisted as trusted.
        is_link, link_error = safe_call_boolean("is_symlink", path)
        if is_link == nil then return nil, link_error end
        if is_link then return nil, problem("path_is_symlink", nil, item.relativePath) end
        files[index] = fingerprint
    end

    return {
        schemaVersion = SCHEMA_VERSION,
        algorithm = ALGORITHM,
        maxBytesPerFile = normalized_options.maxBytesPerFile,
        candidateCount = candidate_count,
        fileCount = #files,
        files = files,
    }
end

local function validate_snapshot(snapshot)
    if type(snapshot) ~= "table" or snapshot.schemaVersion ~= SCHEMA_VERSION or
        snapshot.algorithm ~= ALGORITHM then
        return nil, problem("invalid_snapshot", "schema_or_algorithm")
    end
    local maximum_bytes = positive_integer(
        snapshot.maxBytesPerFile, nil, HARD_MAX_BYTES_PER_FILE
    )
    if not maximum_bytes or maximum_bytes < 2 then
        return nil, problem("invalid_snapshot", "maxBytesPerFile")
    end
    local count = strict_array_length(snapshot.files)
    if not count or count < 1 or count > HARD_MAX_FILES then
        return nil, problem("invalid_snapshot", "files")
    end

    local paths, expected, seen = {}, {}, {}
    for index = 1, count do
        local entry = snapshot.files[index]
        if type(entry) ~= "table" then
            return nil, problem("invalid_snapshot", "file_entry")
        end
        local normalized, path_error = depot_manifest.normalize_path(entry.relativePath)
        if not normalized then
            return nil, problem("invalid_snapshot", path_error, entry.relativePath)
        end
        if seen[normalized.pathKey] then
            return nil, problem("invalid_snapshot", "duplicate_path", entry.relativePath)
        end
        seen[normalized.pathKey] = true
        local size = tonumber(entry.size)
        if not size or size < 0 or size ~= math.floor(size) or size > MAX_SAFE_FILE_SIZE or
            type(entry.quickHash) ~= "string" or
            not entry.quickHash:match("^quick%-v1:[0-9a-f][0-9a-f]+$") then
            return nil, problem("invalid_snapshot", "file_fingerprint", entry.relativePath)
        end
        paths[index] = normalized.relativePath
        expected[normalized.pathKey] = {
            relativePath = normalized.relativePath,
            size = size,
            quickHash = entry.quickHash,
        }
    end
    return {
        maximumBytes = maximum_bytes,
        paths = paths,
        expected = expected,
        count = count,
    }
end

function file_sentinel.verify(install_root, snapshot, options)
    local validated, validation_error = validate_snapshot(snapshot)
    if not validated then return nil, validation_error end
    options = options or {}
    if type(options) ~= "table" then
        return nil, problem("invalid_options", "expected_table")
    end
    local current, capture_error = file_sentinel.capture(install_root, validated.paths, {
        maxFiles = validated.count,
        maxBytesPerFile = validated.maximumBytes,
        openFile = options.openFile,
    })
    if not current then
        if capture_error and capture_error.relativePath then
            return {
                matches = false,
                code = capture_error.code,
                relativePath = capture_error.relativePath,
                filesChecked = 0,
            }
        end
        return nil, capture_error
    end

    local checked = 0
    for _, actual in ipairs(current.files) do
        local expected = validated.expected[actual.pathKey]
        if not expected then
            return nil, problem("invalid_snapshot", "selection_changed", actual.relativePath)
        end
        if actual.size ~= expected.size then
            return {
                matches = false,
                code = "size_changed",
                relativePath = actual.relativePath,
                expectedSize = expected.size,
                actualSize = actual.size,
                filesChecked = checked,
            }
        end
        if actual.quickHash ~= expected.quickHash then
            return {
                matches = false,
                code = "quick_hash_changed",
                relativePath = actual.relativePath,
                filesChecked = checked,
            }
        end
        checked = checked + 1
    end
    return { matches = true, code = "match", filesChecked = checked }
end

file_sentinel.create = file_sentinel.capture
file_sentinel.check = file_sentinel.verify

return file_sentinel
