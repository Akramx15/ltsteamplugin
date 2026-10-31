-- Defensive reader for Steam depotcache *.manifest files.
--
-- Steam stores a protobuf payload and metadata in length-delimited sections.
-- This module deliberately implements only the protobuf wire format instead of
-- depending on a generated schema. Unknown fields are skipped so newer Steam
-- clients can extend the messages without breaking downgrade cleanup.

local depot_manifest = {}

local MAGIC_PAYLOAD = 0x71F617D0
local MAGIC_METADATA = 0x1F4812BE
local MAGIC_SIGNATURE = 0x1B81B817
local MAGIC_END = 0x32C415AB

local MAX_SAFE_DECIMAL = "9007199254740991"
local DEFAULT_MAX_BYTES = 512 * 1024 * 1024
local DEFAULT_MAX_ENTRIES = 2000000
local DEFAULT_MAX_PATH_BYTES = 32767
local DEFAULT_MAX_PROTO_DEPTH = 16

depot_manifest.magic = {
    payload = MAGIC_PAYLOAD,
    metadata = MAGIC_METADATA,
    signature = MAGIC_SIGNATURE,
    finish = MAGIC_END,
}

local function raise(code, detail, offset, extra)
    local problem = {
        __depot_manifest_error = true,
        code = tostring(code or "invalid_manifest"),
    }
    if detail ~= nil then problem.detail = tostring(detail) end
    if offset ~= nil then problem.offset = math.max(0, tonumber(offset) or 0) end
    if type(extra) == "table" then
        for key, value in pairs(extra) do problem[key] = value end
    end
    error(problem, 0)
end

local function read_u32_le(data, position, limit)
    limit = limit or #data
    if position < 1 or position + 3 > limit then
        raise("truncated_manifest", "uint32", position - 1)
    end
    local a, b, c, d = data:byte(position, position + 3)
    return a + b * 256 + c * 65536 + d * 16777216
end

local function decimal_multiply_add(value, multiplier, addend)
    local output = {}
    local carry = addend
    for index = #value, 1, -1 do
        local digit = value:byte(index) - 48
        local next_value = digit * multiplier + carry
        output[#output + 1] = string.char(48 + (next_value % 10))
        carry = math.floor(next_value / 10)
    end
    while carry > 0 do
        output[#output + 1] = string.char(48 + (carry % 10))
        carry = math.floor(carry / 10)
    end
    local reversed = {}
    for index = #output, 1, -1 do reversed[#reversed + 1] = output[index] end
    local result = table.concat(reversed):gsub("^0+", "")
    return result ~= "" and result or "0"
end

local function groups_to_decimal(groups, base)
    local value = "0"
    for index = #groups, 1, -1 do
        value = decimal_multiply_add(value, base, groups[index])
    end
    return value
end

local function decimal_is_safe(value)
    if #value ~= #MAX_SAFE_DECIMAL then return #value < #MAX_SAFE_DECIMAL end
    return value <= MAX_SAFE_DECIMAL
end

local function exact_unsigned(decimal)
    return {
        decimal = decimal,
        number = decimal_is_safe(decimal) and tonumber(decimal) or nil,
    }
end

local function new_reader(data, first, last, options)
    return {
        data = data,
        position = first,
        last = last,
        options = options,
    }
end

local function read_varint(reader)
    local groups = {}
    local start = reader.position
    for index = 1, 10 do
        if reader.position > reader.last then
            raise("truncated_protobuf", "varint", start - 1)
        end
        local byte = reader.data:byte(reader.position)
        reader.position = reader.position + 1
        groups[#groups + 1] = byte % 128
        if byte < 128 then
            if index == 10 and groups[index] > 1 then
                raise("protobuf_integer_overflow", "uint64", start - 1)
            end
            return exact_unsigned(groups_to_decimal(groups, 128))
        end
    end
    raise("protobuf_integer_overflow", "unterminated_varint", start - 1)
end

local function read_fixed64(reader)
    local start = reader.position
    if start + 7 > reader.last then
        raise("truncated_protobuf", "fixed64", start - 1)
    end
    local groups = { reader.data:byte(start, start + 7) }
    reader.position = start + 8
    return exact_unsigned(groups_to_decimal(groups, 256))
end

local function read_length(reader, label)
    local length_value = read_varint(reader)
    if length_value.number == nil then
        raise("protobuf_length_overflow", label or "message", reader.position - 1)
    end
    local length = length_value.number
    if length < 0 or reader.position + length - 1 > reader.last then
        raise("truncated_protobuf", label or "message", reader.position - 1)
    end
    return length
end

local function read_limited_bytes(reader, label, maximum)
    local length = read_length(reader, label)
    if length > maximum then
        raise("protobuf_field_too_large", label, reader.position - 1, {
            fieldBytes = length,
            maxBytes = maximum,
        })
    end
    local first = reader.position
    local last = first + length - 1
    reader.position = last + 1
    if length == 0 then return "" end
    return reader.data:sub(first, last)
end

local function skip_bytes(reader, label)
    local length = read_length(reader, label)
    reader.position = reader.position + length
end

local skip_value

local function read_key(reader)
    local offset = reader.position - 1
    local key_value = read_varint(reader)
    if key_value.number == nil then
        raise("invalid_protobuf_key", "key_too_large", offset)
    end
    local key = key_value.number
    local field_number = math.floor(key / 8)
    local wire_type = key % 8
    if field_number < 1 then
        raise("invalid_protobuf_key", "field_zero", offset)
    end
    return field_number, wire_type, offset
end

skip_value = function(reader, wire_type, field_number, depth)
    if wire_type == 0 then
        read_varint(reader)
        return
    end
    if wire_type == 1 then
        if reader.position + 7 > reader.last then
            raise("truncated_protobuf", "fixed64", reader.position - 1)
        end
        reader.position = reader.position + 8
        return
    end
    if wire_type == 2 then
        local length = read_length(reader, "unknown_field")
        reader.position = reader.position + length
        return
    end
    if wire_type == 3 then
        depth = (depth or 0) + 1
        if depth > reader.options.maxProtoDepth then
            raise("protobuf_depth_exceeded", "group", reader.position - 1)
        end
        while reader.position <= reader.last do
            local child_field, child_wire, child_offset = read_key(reader)
            if child_wire == 4 then
                if child_field ~= field_number then
                    raise("invalid_protobuf_group", "mismatched_end", child_offset)
                end
                return
            end
            skip_value(reader, child_wire, child_field, depth)
        end
        raise("truncated_protobuf", "unterminated_group", reader.position - 1)
    end
    if wire_type == 4 then
        raise("invalid_protobuf_group", "unexpected_end", reader.position - 1)
    end
    if wire_type == 5 then
        if reader.position + 3 > reader.last then
            raise("truncated_protobuf", "fixed32", reader.position - 1)
        end
        reader.position = reader.position + 4
        return
    end
    raise("unsupported_protobuf_wire", tostring(wire_type), reader.position - 1)
end

local function expect_wire(actual, expected, field, offset)
    if actual ~= expected then
        raise("invalid_protobuf_wire", "field_" .. tostring(field), offset, {
            expectedWire = expected,
            actualWire = actual,
        })
    end
end

local function uint_value(reader, wire_type, field, offset)
    if wire_type == 0 then return read_varint(reader) end
    if wire_type == 1 then return read_fixed64(reader) end
    raise("invalid_protobuf_wire", "field_" .. tostring(field), offset, {
        expectedWire = "0_or_1",
        actualWire = wire_type,
    })
end

local function parse_metadata(data, first, last, options)
    local reader = new_reader(data, first, last, options)
    local metadata = {
        depotId = nil,
        manifestGid = nil,
        creationTime = nil,
        creationTimeText = nil,
        filenamesEncrypted = false,
        originalSize = nil,
        originalSizeText = nil,
        compressedSize = nil,
        compressedSizeText = nil,
        uniqueChunks = nil,
        uniqueChunksText = nil,
        crcEncrypted = nil,
        crcClear = nil,
    }

    while reader.position <= reader.last do
        local field, wire, offset = read_key(reader)
        if field == 1 then
            local value = uint_value(reader, wire, field, offset)
            metadata.depotId = value.decimal
        elseif field == 2 then
            local value = uint_value(reader, wire, field, offset)
            metadata.manifestGid = value.decimal
        elseif field == 3 then
            local value = uint_value(reader, wire, field, offset)
            metadata.creationTime = value.number
            metadata.creationTimeText = value.decimal
        elseif field == 4 then
            expect_wire(wire, 0, field, offset)
            local value = read_varint(reader)
            metadata.filenamesEncrypted = value.decimal ~= "0"
        elseif field == 5 then
            local value = uint_value(reader, wire, field, offset)
            metadata.originalSize = value.number
            metadata.originalSizeText = value.decimal
        elseif field == 6 then
            local value = uint_value(reader, wire, field, offset)
            metadata.compressedSize = value.number
            metadata.compressedSizeText = value.decimal
        elseif field == 7 then
            local value = uint_value(reader, wire, field, offset)
            metadata.uniqueChunks = value.number
            metadata.uniqueChunksText = value.decimal
        elseif field == 8 then
            local value = uint_value(reader, wire, field, offset)
            metadata.crcEncrypted = value.number or value.decimal
        elseif field == 9 then
            local value = uint_value(reader, wire, field, offset)
            metadata.crcClear = value.number or value.decimal
        else
            skip_value(reader, wire, field, 0)
        end
    end

    if metadata.depotId == nil or metadata.depotId == "0" then
        raise("missing_metadata", "depot_id", first - 1)
    end
    if metadata.manifestGid == nil or metadata.manifestGid == "0" then
        raise("missing_metadata", "manifest_gid", first - 1)
    end
    return metadata
end

local WINDOWS_RESERVED = {
    CON = true, PRN = true, AUX = true, NUL = true,
    COM1 = true, COM2 = true, COM3 = true, COM4 = true, COM5 = true,
    COM6 = true, COM7 = true, COM8 = true, COM9 = true,
    LPT1 = true, LPT2 = true, LPT3 = true, LPT4 = true, LPT5 = true,
    LPT6 = true, LPT7 = true, LPT8 = true, LPT9 = true,
}

local function normalize_path_impl(raw_path, options)
    if type(raw_path) ~= "string" or raw_path == "" then
        return nil, "empty_path"
    end
    if #raw_path > options.maxPathBytes then return nil, "path_too_long" end
    if raw_path:find("%z") or raw_path:find("[%c]") then
        return nil, "control_character"
    end

    local slash_path = raw_path:gsub("\\", "/")
    if slash_path:sub(1, 1) == "/" then return nil, "absolute_path" end
    if slash_path:match("^[A-Za-z]:") then return nil, "drive_path" end
    if slash_path:sub(-1) == "/" then return nil, "trailing_separator" end

    local parts = {}
    local cursor = 1
    while cursor <= #slash_path do
        local separator = slash_path:find("/", cursor, true)
        local part
        if separator then
            part = slash_path:sub(cursor, separator - 1)
            cursor = separator + 1
        else
            part = slash_path:sub(cursor)
            cursor = #slash_path + 1
        end
        if part == "" then return nil, "empty_segment" end
        if part == "." or part == ".." then return nil, "traversal" end
        if part:find(":", 1, true) then return nil, "alternate_data_stream" end
        if part:match("[%. ]$") then return nil, "ambiguous_windows_segment" end
        local device_name = part:match("^([^%.]+)") or part
        if WINDOWS_RESERVED[string.upper(device_name)] then
            return nil, "reserved_windows_name"
        end
        parts[#parts + 1] = part
    end
    if #parts == 0 then return nil, "empty_path" end

    local normalized = table.concat(parts, "/")
    return {
        relativePath = normalized,
        windowsPath = normalized:gsub("/", "\\"),
        pathKey = string.lower(normalized),
    }
end

function depot_manifest.normalize_path(raw_path, options)
    options = options or {}
    local normalized_options = {
        maxPathBytes = tonumber(options.maxPathBytes) or DEFAULT_MAX_PATH_BYTES,
    }
    return normalize_path_impl(raw_path, normalized_options)
end

local function flag_is_set(flags, value)
    return math.floor(flags / value) % 2 == 1
end

local function to_hex(value)
    return (value:gsub(".", function(character)
        return string.format("%02x", character:byte())
    end))
end

local function parse_file_mapping(data, first, last, options, entry_index)
    local reader = new_reader(data, first, last, options)
    local raw_path
    local size = exact_unsigned("0")
    local flags = 0
    local filename_sha
    local content_sha
    local link_target
    local chunk_count = 0

    while reader.position <= reader.last do
        local field, wire, offset = read_key(reader)
        if field == 1 then
            expect_wire(wire, 2, field, offset)
            raw_path = read_limited_bytes(reader, "filename", options.maxPathBytes)
        elseif field == 2 then
            expect_wire(wire, 0, field, offset)
            size = read_varint(reader)
        elseif field == 3 then
            expect_wire(wire, 0, field, offset)
            local value = read_varint(reader)
            if value.number == nil or value.number > 4294967295 then
                raise("invalid_file_flags", value.decimal, offset)
            end
            flags = value.number
        elseif field == 4 then
            expect_wire(wire, 2, field, offset)
            if options.includeHashes then
                filename_sha = to_hex(read_limited_bytes(reader, "filename_sha", 1024))
            else
                skip_bytes(reader, "filename_sha")
            end
        elseif field == 5 then
            expect_wire(wire, 2, field, offset)
            if options.includeHashes then
                content_sha = to_hex(read_limited_bytes(reader, "content_sha", 1024))
            else
                skip_bytes(reader, "content_sha")
            end
        elseif field == 6 then
            expect_wire(wire, 2, field, offset)
            skip_bytes(reader, "chunk")
            chunk_count = chunk_count + 1
        elseif field == 7 then
            expect_wire(wire, 2, field, offset)
            link_target = read_limited_bytes(reader, "link_target", options.maxPathBytes)
        else
            skip_value(reader, wire, field, 0)
        end
    end

    if raw_path == nil then
        raise("missing_file_path", "entry_" .. tostring(entry_index), first - 1)
    end
    local normalized, path_error = normalize_path_impl(raw_path, options)
    if not normalized then
        raise("unsafe_manifest_path", path_error, first - 1, {
            entryIndex = entry_index,
            rawPath = raw_path,
        })
    end

    local is_directory = flag_is_set(flags, 64)
    local is_symlink = flag_is_set(flags, 512)
    return {
        rawPath = raw_path,
        relativePath = normalized.relativePath,
        windowsPath = normalized.windowsPath,
        pathKey = normalized.pathKey,
        size = size.number,
        sizeText = size.decimal,
        flags = flags,
        isDirectory = is_directory,
        isSymlink = is_symlink,
        chunkCount = chunk_count,
        linkTarget = link_target,
        filenameSha = filename_sha,
        contentSha = content_sha,
    }
end

local function parse_payload(data, first, last, options)
    local reader = new_reader(data, first, last, options)
    local entries = {}
    local files = {}
    local directories = {}
    local by_path_key = {}

    while reader.position <= reader.last do
        local field, wire, offset = read_key(reader)
        if field == 1 then
            expect_wire(wire, 2, field, offset)
            local length = read_length(reader, "file_mapping")
            local mapping_first = reader.position
            local mapping_last = mapping_first + length - 1
            reader.position = mapping_last + 1
            if #entries >= options.maxEntries then
                raise("manifest_entry_limit", tostring(options.maxEntries), offset)
            end
            local entry = parse_file_mapping(
                data, mapping_first, mapping_last, options, #entries + 1
            )
            local previous = by_path_key[entry.pathKey]
            if previous then
                raise("manifest_path_collision", entry.relativePath, offset, {
                    firstPath = previous.relativePath,
                    secondPath = entry.relativePath,
                })
            end
            entries[#entries + 1] = entry
            by_path_key[entry.pathKey] = entry
            if entry.isDirectory then
                directories[#directories + 1] = entry
            else
                files[#files + 1] = entry
            end
        else
            skip_value(reader, wire, field, 0)
        end
    end

    return entries, files, directories, by_path_key
end

local function normalize_options(options)
    options = options or {}
    local normalized = {
        maxBytes = tonumber(options.maxBytes) or DEFAULT_MAX_BYTES,
        maxEntries = tonumber(options.maxEntries) or DEFAULT_MAX_ENTRIES,
        maxPathBytes = tonumber(options.maxPathBytes) or DEFAULT_MAX_PATH_BYTES,
        maxProtoDepth = tonumber(options.maxProtoDepth) or DEFAULT_MAX_PROTO_DEPTH,
        includeHashes = options.includeHashes == true,
        expectedDepotId = options.expectedDepotId and tostring(options.expectedDepotId) or nil,
        expectedManifestGid = options.expectedManifestGid and tostring(options.expectedManifestGid) or nil,
    }
    if normalized.maxBytes < 1 or normalized.maxEntries < 1 or
        normalized.maxPathBytes < 1 or normalized.maxProtoDepth < 1 then
        raise("invalid_parser_options", "limits_must_be_positive")
    end
    return normalized
end

local function read_section(data, cursor, expected_magic, label)
    if cursor + 7 > #data then
        raise("truncated_manifest", label .. "_header", cursor - 1)
    end
    local magic = read_u32_le(data, cursor)
    if magic ~= expected_magic then
        raise("invalid_section_magic", label, cursor - 1, {
            expectedMagic = string.format("0x%08X", expected_magic),
            actualMagic = string.format("0x%08X", magic),
        })
    end
    local length = read_u32_le(data, cursor + 4)
    local first = cursor + 8
    local last = first + length - 1
    if last > #data then
        raise("truncated_manifest", label .. "_body", cursor - 1)
    end
    return first, last, last + 1, length
end

local function parse_bytes_impl(data, raw_options)
    if type(data) ~= "string" then raise("invalid_manifest_input", "expected_string") end
    local options = normalize_options(raw_options)
    if #data > options.maxBytes then
        raise("manifest_too_large", tostring(#data), 0, { maxBytes = options.maxBytes })
    end
    if #data < 20 then raise("truncated_manifest", "file", 0) end

    local payload_first, payload_last, cursor, payload_length =
        read_section(data, 1, MAGIC_PAYLOAD, "payload")
    local metadata_first, metadata_last, after_metadata, metadata_length =
        read_section(data, cursor, MAGIC_METADATA, "metadata")

    local metadata = parse_metadata(data, metadata_first, metadata_last, options)
    if options.expectedDepotId and metadata.depotId ~= options.expectedDepotId then
        raise("depot_id_mismatch", metadata.depotId, metadata_first - 1, {
            expectedDepotId = options.expectedDepotId,
        })
    end
    if options.expectedManifestGid and metadata.manifestGid ~= options.expectedManifestGid then
        raise("manifest_gid_mismatch", metadata.manifestGid, metadata_first - 1, {
            expectedManifestGid = options.expectedManifestGid,
        })
    end
    -- Ciphertext is not a filesystem path. Never let a force-mode caller use it
    -- as a deletion plan; decryption belongs in a separate depot-key provider.
    if metadata.filenamesEncrypted then
        raise("encrypted_filenames", "manifest_requires_depot_key", metadata_first - 1)
    end

    cursor = after_metadata
    local signature_length = 0
    if cursor + 3 <= #data and read_u32_le(data, cursor) == MAGIC_SIGNATURE then
        local _, _, after_signature, length =
            read_section(data, cursor, MAGIC_SIGNATURE, "signature")
        signature_length = length
        cursor = after_signature
    end
    if cursor + 3 > #data then raise("truncated_manifest", "end_magic", cursor - 1) end
    local end_magic = read_u32_le(data, cursor)
    if end_magic ~= MAGIC_END then
        raise("invalid_section_magic", "end", cursor - 1, {
            expectedMagic = string.format("0x%08X", MAGIC_END),
            actualMagic = string.format("0x%08X", end_magic),
        })
    end
    cursor = cursor + 4
    if cursor ~= #data + 1 then
        raise("trailing_manifest_data", tostring(#data - cursor + 1), cursor - 1)
    end

    local entries, files, directories, by_path_key =
        parse_payload(data, payload_first, payload_last, options)
    metadata.entries = entries
    metadata.files = files
    metadata.directories = directories
    metadata.byPathKey = by_path_key
    metadata.entryCount = #entries
    metadata.fileCount = #files
    metadata.directoryCount = #directories
    metadata.payloadLength = payload_length
    metadata.metadataLength = metadata_length
    metadata.signatureLength = signature_length
    return metadata
end

function depot_manifest.parse_bytes(data, options)
    local ok, result = xpcall(function()
        return parse_bytes_impl(data, options)
    end, function(problem)
        return problem
    end)
    if ok then return result end
    if type(result) == "table" and result.__depot_manifest_error then
        result.__depot_manifest_error = nil
        return nil, result
    end
    return nil, { code = "manifest_parser_exception", detail = tostring(result) }
end

depot_manifest.parse = depot_manifest.parse_bytes

local function default_read_file(path)
    local loaded_utils, runtime_utils = pcall(require, "utils")
    if loaded_utils and type(runtime_utils) == "table" and
        type(runtime_utils.read_file) == "function" then
        local ok, value = pcall(runtime_utils.read_file, path)
        if ok and type(value) == "string" then return value end
    end
    if type(io) == "table" and type(io.open) == "function" then
        local handle = io.open(path, "rb")
        if handle then
            local value = handle:read("*a")
            handle:close()
            return value
        end
    end
    return nil
end

function depot_manifest.parse_file(path, options)
    if type(path) ~= "string" or path == "" then
        return nil, { code = "invalid_manifest_path", detail = "expected_nonempty_string" }
    end
    options = options or {}
    local reader = type(options.readFile) == "function" and options.readFile or default_read_file
    local ok, data = pcall(reader, path)
    if not ok or type(data) ~= "string" then
        return nil, { code = "manifest_read_failed", detail = ok and "not_found" or tostring(data), path = path }
    end
    return depot_manifest.parse_bytes(data, options)
end

return depot_manifest
