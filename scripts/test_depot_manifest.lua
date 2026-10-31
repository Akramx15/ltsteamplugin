local script_source = debug.getinfo(1, "S").source
local script_path = script_source:sub(1, 1) == "@" and script_source:sub(2) or
    "scripts/test_depot_manifest.lua"
local script_directory = script_path:match("^(.*)[/\\]") or "scripts"
package.path = script_directory .. "/../backend/?.lua;" .. package.path

local manifest = require("depot_manifest")

local function assert_true(value, message)
    if not value then error(message or "assert_true failed", 2) end
end

local function assert_equal(actual, expected, message)
    if actual ~= expected then
        error((message or "values differ") .. ": expected " .. tostring(expected) ..
            ", got " .. tostring(actual), 2)
    end
end

local function u32(value)
    return string.char(
        value % 256,
        math.floor(value / 256) % 256,
        math.floor(value / 65536) % 256,
        math.floor(value / 16777216) % 256
    )
end

local function varint(value)
    local output = {}
    repeat
        local next_byte = value % 128
        value = math.floor(value / 128)
        if value > 0 then next_byte = next_byte + 128 end
        output[#output + 1] = string.char(next_byte)
    until value == 0
    return table.concat(output)
end

local function key(field, wire) return varint(field * 8 + wire) end
local function uint_field(field, value) return key(field, 0) .. varint(value) end
local function bytes_field(field, value) return key(field, 2) .. varint(#value) .. value end

local function mapping(path, size, flags, extra)
    return bytes_field(1, path) .. uint_field(2, size or 0) ..
        uint_field(3, flags or 0) .. (extra or "")
end

local TEST_GID_VARINT = string.char(0xE9, 0x9E, 0xB5, 0xDD, 0xB0, 0xDC, 0x93, 0xDB, 0x36)

local function metadata(encrypted)
    return uint_field(1, 3003461) .. key(2, 0) .. TEST_GID_VARINT ..
        uint_field(3, 1761638272) .. uint_field(4, encrypted and 1 or 0) ..
        uint_field(5, 572753731) .. uint_field(6, 187811280) ..
        uint_field(7, 619) .. uint_field(8, 3302350271) ..
        uint_field(9, 480685871) ..
        -- Unknown fixed64 metadata field: the parser must skip it.
        key(20, 1) .. string.rep("\1", 8)
end

local function make_manifest(paths, options)
    options = options or {}
    local mappings = {}
    for _, item in ipairs(paths) do
        mappings[#mappings + 1] = bytes_field(1, mapping(
            item.path, item.size, item.flags,
            -- Unknown fixed32 mapping field and one chunk message.
            key(50, 5) .. "ABCD" .. bytes_field(6, uint_field(2, 7))
        ))
    end
    -- Unknown payload varint plus a deprecated group exercise all skip paths.
    local payload = table.concat(mappings) .. uint_field(12, 99) ..
        key(13, 3) .. uint_field(1, 5) .. key(13, 4)
    local meta = metadata(options.encrypted)
    return u32(manifest.magic.payload) .. u32(#payload) .. payload ..
        u32(manifest.magic.metadata) .. u32(#meta) .. meta ..
        u32(manifest.magic.signature) .. u32(3) .. "sig" ..
        u32(manifest.magic.finish)
end

local function wrap_payload(payload)
    local meta = metadata(false)
    return u32(manifest.magic.payload) .. u32(#payload) .. payload ..
        u32(manifest.magic.metadata) .. u32(#meta) .. meta ..
        u32(manifest.magic.signature) .. u32(0) ..
        u32(manifest.magic.finish)
end

local safe_blob = make_manifest({
    { path = "Bang Bang Barrage.exe", size = 665600, flags = 32 },
    { path = "Bang Bang Barrage_Data", size = 0, flags = 64 },
    { path = "Bang Bang Barrage_Data\\Managed\\System.Drawing.dll", size = 1234, flags = 0 },
})

do
    local parsed, problem = manifest.parse_bytes(safe_blob, {
        expectedDepotId = "3003461",
        expectedManifestGid = "3942425260869898089",
    })
    assert_true(parsed ~= nil, problem and problem.code)
    assert_equal(parsed.depotId, "3003461")
    assert_equal(parsed.manifestGid, "3942425260869898089", "uint64 must remain exact")
    assert_equal(parsed.creationTime, 1761638272)
    assert_equal(parsed.originalSize, 572753731)
    assert_equal(parsed.compressedSize, 187811280)
    assert_equal(parsed.uniqueChunks, 619)
    assert_equal(parsed.entryCount, 3)
    assert_equal(parsed.fileCount, 2)
    assert_equal(parsed.directoryCount, 1)
    assert_equal(parsed.signatureLength, 3)
    assert_equal(parsed.files[1].relativePath, "Bang Bang Barrage.exe")
    assert_equal(parsed.files[1].pathKey, "bang bang barrage.exe")
    assert_equal(parsed.files[1].chunkCount, 1)
    assert_equal(parsed.files[2].windowsPath,
        "Bang Bang Barrage_Data\\Managed\\System.Drawing.dll")
    assert_true(parsed.byPathKey["bang bang barrage_data/managed/system.drawing.dll"] ~= nil)
end

do
    local normalized = manifest.normalize_path("Data\\Textures\\FILE.dds")
    assert_equal(normalized.relativePath, "Data/Textures/FILE.dds")
    assert_equal(normalized.pathKey, "data/textures/file.dds")
end

local function expect_error(blob, expected_code, label, options)
    local parsed, problem = manifest.parse_bytes(blob, options)
    assert_equal(parsed, nil, label .. " should fail")
    assert_true(type(problem) == "table", label .. " should return structured error")
    assert_equal(problem.code, expected_code, label)
end

do
    local corrupt_magic = "BAD!" .. safe_blob:sub(5)
    expect_error(corrupt_magic, "invalid_section_magic", "bad payload magic")
    expect_error(safe_blob:sub(1, #safe_blob - 1), "truncated_manifest", "truncated end")
    expect_error(safe_blob .. "x", "trailing_manifest_data", "trailing bytes")
    expect_error(wrap_payload(key(1, 2) .. varint(100) .. "x"),
        "truncated_protobuf", "oversized mapping length")
    expect_error(wrap_payload(key(1, 6)),
        "invalid_protobuf_wire", "invalid mapping wire")
end

do
    expect_error(make_manifest({ { path = "..\\evil.dll", size = 1 } }),
        "unsafe_manifest_path", "parent traversal")
    expect_error(make_manifest({ { path = "C:\\Windows\\evil.dll", size = 1 } }),
        "unsafe_manifest_path", "drive path")
    expect_error(make_manifest({ { path = "\\\\server\\share\\evil.dll", size = 1 } }),
        "unsafe_manifest_path", "UNC path")
    expect_error(make_manifest({ { path = "safe.txt:payload", size = 1 } }),
        "unsafe_manifest_path", "alternate data stream")
end

do
    expect_error(make_manifest({
        { path = "Data\\File.bin", size = 1 },
        { path = "data/file.BIN", size = 2 },
    }), "manifest_path_collision", "case-insensitive collision")
end

do
    expect_error(make_manifest({ { path = "encrypted-name", size = 1 } }, { encrypted = true }),
        "encrypted_filenames", "encrypted names")
end

do
    expect_error(safe_blob, "depot_id_mismatch", "expected depot check", {
        expectedDepotId = "999",
    })
    expect_error(safe_blob, "manifest_entry_limit", "entry cap", { maxEntries = 2 })
    expect_error(safe_blob, "manifest_too_large", "byte cap", { maxBytes = #safe_blob - 1 })
end

-- Pass a real depotcache manifest as arg[1] (or STEAM_TEST_MANIFEST) for an
-- optional integration check. The deterministic synthetic suite above remains
-- portable and does not require Steam to be installed.
local real_path = type(arg) == "table" and arg[1] or nil
if (not real_path or real_path == "") and type(os) == "table" and type(os.getenv) == "function" then
    real_path = os.getenv("STEAM_TEST_MANIFEST")
end
if real_path and real_path ~= "" then
    local parsed, problem = manifest.parse_file(real_path)
    assert_true(parsed ~= nil, "real manifest failed: " .. tostring(problem and problem.code))
    assert_true(parsed.fileCount > 0, "real manifest should contain files")
    print("real_manifest=" .. parsed.depotId .. ":" .. parsed.manifestGid ..
        " files=" .. tostring(parsed.fileCount))
end

print("depot_manifest tests passed")
