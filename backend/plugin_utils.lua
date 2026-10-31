local m_utils = require("utils")
local fs = require("fs")
local cjson = require("json")
local paths = require("paths")
local logger = require("plugin_logger")

local utils = {}

function utils.read_text(path)
    local content = m_utils.read_file(path)
    if content ~= nil then return content end

    -- Complete an interrupted journal commit.  `.pending` was fully written
    -- and verified before the old target moved to `.backup`, so prefer it.
    for _, recovery in ipairs({ tostring(path) .. ".pending", tostring(path) .. ".backup" }) do
        local recovered = m_utils.read_file(recovery)
        if recovered ~= nil then
            local moved = type(os) == "table" and type(os.rename) == "function" and os.rename(recovery, path)
            if not moved and type(fs.copy) == "function" then
                local ok, result = pcall(fs.copy, recovery, path, true)
                moved = ok and result ~= false
                if moved then pcall(fs.remove, recovery) end
            end
            if moved then return recovered end
        end
    end
    return ""
end

function utils.write_text(path, text)
    local ok, result = pcall(m_utils.write_file, path, text)
    if not ok then return false, tostring(result) end
    local verify_ok, written = pcall(m_utils.read_file, path)
    if not verify_ok or written ~= text then
        return false, "write verification failed"
    end
    return true
end

function utils.read_json(path)
    local content = utils.read_text(path)
    if content == "" then return {} end
    local success, data = pcall(cjson.decode, content)
    if success then
        return data
    end
    local backup_path = tostring(path) .. ".backup"
    local backup = m_utils.read_file(backup_path)
    if backup and backup ~= "" then
        local backup_ok, backup_data = pcall(cjson.decode, backup)
        if backup_ok then
            pcall(fs.remove, path)
            local moved = type(os) == "table" and type(os.rename) == "function" and os.rename(backup_path, path)
            if not moved and type(fs.copy) == "function" then pcall(fs.copy, backup_path, path, true) end
            return backup_data
        end
    end
    return {}
end

function utils.decode_json(text)
    if not text or text == "" then return {} end
    local success, data = pcall(cjson.decode, text)
    if success then return data else return {} end
end

function utils.encode_json(data)
    -- If it's the api_manifest table structure, use a custom strict formatter
    if type(data) == "table" and data.api_list and type(data.api_list) == "table" then
        local lines = {}
        table.insert(lines, '{"api_list": [')
        
        for i, api in ipairs(data.api_list) do
            table.insert(lines, '        {')
            -- Ensure "name" is always first
            table.insert(lines, '            "name": ' .. cjson.encode(api.name or "") .. ',')
            table.insert(lines, '            "url": ' .. cjson.encode(api.url or ""):gsub("\\/", "/") .. ',')
            table.insert(lines, '            "success_code": ' .. tostring(api.success_code or 200) .. ',')
            table.insert(lines, '            "unavailable_code": ' .. tostring(api.unavailable_code or 404) .. ',')
            table.insert(lines, '            "enabled": ' .. tostring(api.enabled ~= false))
            
            if i == #data.api_list then
                table.insert(lines, '        }')
            else
                table.insert(lines, '        },')
            end
        end
        
        table.insert(lines, '    ]}')
        return table.concat(lines, "\n")
    end

    -- Fallback for all other normal JSON serializations
    local success, content = pcall(cjson.encode, data)
    if success then
        return content
    else 
        return "{}" 
    end
end

function utils.write_json(path, data)
    local success, content = pcall(cjson.encode, data)
    if not success then
        logger.warn("write_json failed to encode JSON for " .. tostring(path))
        return false
    end

    -- State files are used to recover interrupted downgrade jobs.  Never
    -- overwrite one in place: a Steam/plugin crash in the middle of a write
    -- would otherwise turn a recoverable job into invalid JSON.  Keep a very
    -- small journal next to the target and verify every filesystem operation.
    local pending = tostring(path) .. ".pending"
    local backup = tostring(path) .. ".backup"
    pcall(fs.remove, pending)

    local wrote, write_error = utils.write_text(pending, content)
    if not wrote then
        logger.warn("write_json failed to stage " .. tostring(path) .. ": " .. tostring(write_error))
        pcall(fs.remove, pending)
        return false
    end

    local had_target = fs.exists(path)
    if had_target then
        pcall(fs.remove, backup)
        local moved = type(os) == "table" and type(os.rename) == "function" and os.rename(path, backup)
        if not moved and type(fs.copy) == "function" then
            local copy_ok, copy_result = pcall(fs.copy, path, backup, true)
            moved = copy_ok and copy_result ~= false and fs.exists(backup)
            if moved then pcall(fs.remove, path) end
        end
        if not moved then
            logger.warn("write_json could not journal " .. tostring(path))
            pcall(fs.remove, pending)
            return false
        end
    end

    local installed = type(os) == "table" and type(os.rename) == "function" and os.rename(pending, path)
    if not installed and type(fs.copy) == "function" then
        local copy_ok, copy_result = pcall(fs.copy, pending, path, true)
        installed = copy_ok and copy_result ~= false and fs.exists(path)
        if installed then pcall(fs.remove, pending) end
    end

    local verify_ok, verify_content = pcall(m_utils.read_file, path)
    installed = installed and verify_ok and verify_content == content
    if not installed then
        pcall(fs.remove, path)
        if had_target and fs.exists(backup) then
            local restored = type(os) == "table" and type(os.rename) == "function" and os.rename(backup, path)
            if not restored and type(fs.copy) == "function" then
                pcall(fs.copy, backup, path, true)
            end
        end
        pcall(fs.remove, pending)
        logger.warn("write_json failed to commit " .. tostring(path))
        return false
    end

    pcall(fs.remove, backup)
    return true
end

function utils.count_apis(text)
    if not text or text == "" then return 0 end
    local success, data = pcall(cjson.decode, text)
    if success and type(data) == "table" and type(data.api_list) == "table" then
        local count = 0
        for _ in pairs(data.api_list) do count = count + 1 end
        return count
    end
    -- Fallback simple string match count for '"name"'
    local _, count = text:gsub('"name"', '"name"')
    return count
end

function utils.normalize_manifest_text(text)
    local content = text or ""
    -- remove whitespace
    content = content:match("^%s*(.-)%s*$")
    if content == "" then return content end

    content = content:gsub(",%s*%]", "]")
    content = content:gsub(",%s*}%s*$", "}")

    if content:sub(1, 10) == '"api_list"' or content:sub(1, 10) == "'api_list'" or content:sub(1, 8) == "api_list" then
        if content:sub(1, 1) ~= "{" then
            content = "{" .. content
        end
        if content:sub(-1) ~= "}" then
            -- remove trailing commas
            content = content:gsub(",$", "") .. "}"
        end
    end

    local success = pcall(cjson.decode, content)
    if success then
        return content
    end
    return text
end

function utils.parse_version(version)
    local parts = {}
    for part in string.gmatch(tostring(version), "%d+") do
        table.insert(parts, tonumber(part))
    end
    if #parts == 0 then return {0} end
    return parts
end

function utils.get_plugin_version()
    local plugin_json_path = fs.join(paths.get_plugin_dir(), "plugin.json")
    local data = utils.read_json(plugin_json_path)
    return tostring(data.version or "0")
end

function utils.ensure_temp_download_dir()
    local root = paths.backend_path("temp_dl")
    if not fs.exists(root) then
        fs.create_directories(root)
    end
    return root
end

return utils
