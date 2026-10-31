local script_source = debug.getinfo(1, "S").source
local script_path = script_source:sub(1, 1) == "@" and script_source:sub(2) or
    "scripts/test_file_sentinel.lua"
local script_directory = script_path:match("^(.*)[/\\]") or "scripts"
package.path = script_directory .. "/../backend/?.lua;" .. package.path

local function canonical(path)
    local value = tostring(path):gsub("/", "\\"):gsub("\\+", "\\")
    return string.lower(value:gsub("\\$", ""))
end

local ROOT = "C:\\SteamLibrary\\steamapps\\common\\Sentinel Test"
local FILES, DIRECTORIES, LINKS = {}, {}, {}
local bytes_read = 0
DIRECTORIES[canonical(ROOT)] = true

local function join(left, right)
    return tostring(left):gsub("[\\/]$", "") .. "\\" ..
        tostring(right):gsub("^[\\/]", "")
end

local function add_directory(relative_path)
    local current = ROOT
    for segment in tostring(relative_path):gmatch("[^/\\]+") do
        current = join(current, segment)
        DIRECTORIES[canonical(current)] = true
    end
end

local function add_file(relative_path, data)
    local parent = tostring(relative_path):match("^(.*)[/\\][^/\\]+$")
    if parent then add_directory(parent) end
    FILES[canonical(join(ROOT, relative_path))] = data
end

local FS_MOCK = {
    join = join,
    absolute = function(path) return tostring(path):gsub("/", "\\") end,
    exists = function(path)
        local key = canonical(path)
        return FILES[key] ~= nil or DIRECTORIES[key] == true or LINKS[key] == true
    end,
    is_directory = function(path) return DIRECTORIES[canonical(path)] == true end,
    is_symlink = function(path) return LINKS[canonical(path)] == true end,
}
package.preload["fs"] = function() return FS_MOCK end

local function open_file(path, mode)
    assert(mode == "rb", "sentinel attempted a non-read open")
    local data = FILES[canonical(path)]
    if data == nil then return nil, "missing" end
    local position = 0
    local handle = {}
    function handle:seek(whence, offset)
        offset = offset or 0
        if whence == "set" then position = offset
        elseif whence == "cur" then position = position + offset
        elseif whence == "end" then position = #data + offset
        else return nil, "bad whence" end
        if position < 0 or position > #data then return nil, "bad offset" end
        return position
    end
    function handle:read(length)
        local result = data:sub(position + 1, position + length)
        position = position + #result
        bytes_read = bytes_read + #result
        if #result == 0 and length > 0 then return nil end
        return result
    end
    function handle:close() return true end
    return handle
end

local sentinel = require("file_sentinel")

local function assert_true(value, message)
    if not value then error(message or "assert_true failed", 2) end
end

local function assert_equal(actual, expected, message)
    if actual ~= expected then
        error((message or "values differ") .. ": expected " .. tostring(expected) ..
            ", got " .. tostring(actual), 2)
    end
end

local function capture(paths, options)
    options = options or {}
    options.openFile = open_file
    return sentinel.capture(ROOT, paths, options)
end

local function verify(snapshot)
    return sentinel.verify(ROOT, snapshot, { openFile = open_file })
end

assert_equal(sentinel.limits.maxFiles, 12)
assert_equal(sentinel.limits.maxBytesPerFile, 128 * 1024)

add_file("small.txt", "hello")
add_file("bin/large.dat", string.rep("A", 40) .. string.rep("M", 40) .. string.rep("Z", 40))

local baseline, baseline_error = capture({ "small.txt", "bin/large.dat" }, {
    maxBytesPerFile = 16,
})
assert_true(baseline ~= nil, baseline_error and baseline_error.code)
assert_equal(baseline.fileCount, 2)
assert_equal(baseline.candidateCount, 2)
for _, item in ipairs(baseline.files) do
    assert_true(type(item.quickHash) == "string" and item.quickHash:match("^quick%-v1:"))
    assert_true(item.sampledBytes <= 16, "per-file read budget exceeded")
    if item.relativePath == "small.txt" then
        assert_equal(item.size, 5)
        assert_equal(item.sampledBytes, 5)
    elseif item.relativePath == "bin/large.dat" then
        assert_equal(item.size, 120)
        assert_equal(item.firstBytes, 8)
        assert_equal(item.lastBytes, 8)
    end
end
local unchanged = assert(verify(baseline))
assert_true(unchanged.matches)
assert_equal(unchanged.filesChecked, 2)

local large_key = canonical(join(ROOT, "bin/large.dat"))
local original_large = FILES[large_key]
FILES[large_key] = "Q" .. original_large:sub(2)
local first_changed = assert(verify(baseline))
assert_true(not first_changed.matches)
assert_equal(first_changed.code, "quick_hash_changed")
FILES[large_key] = original_large

FILES[large_key] = original_large:sub(1, -2) .. "Q"
local last_changed = assert(verify(baseline))
assert_true(not last_changed.matches)
assert_equal(last_changed.code, "quick_hash_changed")
FILES[large_key] = original_large

-- A middle-only edit is intentionally outside this lightweight sampling
-- model. This assertion documents that the implementation never reads whole
-- large files while still detecting first/last drift.
FILES[large_key] = original_large:sub(1, 59) .. "Q" .. original_large:sub(61)
assert_true(assert(verify(baseline)).matches, "middle-only sample unexpectedly changed")
FILES[large_key] = original_large

FILES[large_key] = original_large .. "extra"
local size_changed = assert(verify(baseline))
assert_true(not size_changed.matches)
assert_equal(size_changed.code, "size_changed")
FILES[large_key] = original_large

local small_key = canonical(join(ROOT, "small.txt"))
local original_small = FILES[small_key]
FILES[small_key] = nil
local missing = assert(verify(baseline))
assert_true(not missing.matches)
assert_equal(missing.code, "file_missing")
assert_equal(missing.relativePath, "small.txt")
FILES[small_key] = original_small

local unsafe, unsafe_error = capture({ "../outside.dat" })
assert_equal(unsafe, nil)
assert_equal(unsafe_error.code, "unsafe_path")
assert_equal(unsafe_error.detail, "traversal")

local absolute, absolute_error = capture({ "D:\\outside.dat" })
assert_equal(absolute, nil)
assert_equal(absolute_error.code, "unsafe_path")
assert_equal(absolute_error.detail, "drive_path")

add_file("bin/link.dat", "linked")
LINKS[canonical(join(ROOT, "bin/link.dat"))] = true
local linked, linked_error = capture({ "bin/link.dat" })
assert_equal(linked, nil)
assert_equal(linked_error.code, "path_is_symlink")
LINKS[canonical(join(ROOT, "bin/link.dat"))] = nil

local candidates = {}
for index = 1, 13 do
    local name = string.format("many/file-%02d.bin", index)
    add_file(name, "data-" .. tostring(index))
    candidates[index] = name
end
bytes_read = 0
local bounded = assert(capture(candidates, { maxBytesPerFile = 16 }))
assert_equal(bounded.candidateCount, 13)
assert_equal(bounded.fileCount, 12)
assert_true(bytes_read <= 12 * 16, "global sentinel read bound exceeded")

local selected_a = assert(sentinel.select_paths(candidates))
local reversed = {}
for index = #candidates, 1, -1 do reversed[#reversed + 1] = candidates[index] end
local selected_b = assert(sentinel.select_paths(reversed))
assert_equal(table.concat(selected_a, "\n"), table.concat(selected_b, "\n"),
    "selection depends on input order")

print("file_sentinel tests passed")
