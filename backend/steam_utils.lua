local m_utils = require("utils")
local millennium = require("millennium")
local fs = require("fs")
local logger = require("plugin_logger")
local paths = require("paths")

local steam_utils = {}

local STEAM_INSTALL_PATH = nil

local function normalize_path_key(path)
    return tostring(path or ""):gsub("\\", "/"):gsub("/+", "/"):gsub("/$", ""):lower()
end

local function decimal_appid(value)
    value = tostring(value or "")
    if not value:match("^%d+$") then return nil end
    value = value:gsub("^0+", "")
    if value == "" or #value > 10 or (#value == 10 and value > "4294967295") then
        return nil
    end
    return value
end

local function trim(value)
    return tostring(value or ""):match("^%s*(.-)%s*$") or ""
end

-- Read one or every quoted KeyValues scalar without turning Steam's 64-bit
-- IDs into Lua numbers.  The scanner understands escaped quotes/backslashes,
-- so unusual game names are not truncated by a simple `[^\"]+` pattern.
local function quoted_values(text, wanted_key)
    local values = {}
    text = tostring(text or "")
    wanted_key = tostring(wanted_key or "")
    local search_from = 1
    local key_token = '"' .. wanted_key .. '"'
    while search_from <= #text do
        local key_start, key_end = text:find(key_token, search_from, true)
        if not key_start then break end
        local cursor = key_end + 1
        while cursor <= #text and text:sub(cursor, cursor):match("%s") do cursor = cursor + 1 end
        if text:sub(cursor, cursor) == '"' then
            cursor = cursor + 1
            local result = {}
            while cursor <= #text do
                local ch = text:sub(cursor, cursor)
                if ch == '"' then
                    values[#values + 1] = table.concat(result)
                    cursor = cursor + 1
                    break
                elseif ch == "\\" and cursor < #text then
                    local escaped = text:sub(cursor + 1, cursor + 1)
                    if escaped == "\\" or escaped == '"' then
                        result[#result + 1] = escaped
                        cursor = cursor + 2
                    elseif escaped == "n" then
                        result[#result + 1] = "\n"
                        cursor = cursor + 2
                    elseif escaped == "t" then
                        result[#result + 1] = "\t"
                        cursor = cursor + 2
                    else
                        result[#result + 1] = "\\"
                        cursor = cursor + 1
                    end
                else
                    result[#result + 1] = ch
                    cursor = cursor + 1
                end
            end
        end
        search_from = math.max(key_end + 1, cursor)
    end
    return values
end

local function quoted_value(text, key)
    local values = quoted_values(text, key)
    return values[1]
end

local function get_library_paths()
    local steam_path = steam_utils.detect_steam_install_path()
    if not steam_path or steam_path == "" then return {} end

    local libraries, seen = {}, {}
    local function add(path)
        path = trim(path)
        if path == "" then return end
        local key = normalize_path_key(path)
        if key == "" or seen[key] then return end
        seen[key] = true
        libraries[#libraries + 1] = path
    end

    -- The main Steam folder is a valid library even when libraryfolders.vdf is
    -- missing, temporarily unreadable, or does not repeat entry 0.
    add(steam_path)
    local candidates = {
        fs.join(steam_path, "steamapps", "libraryfolders.vdf"),
        fs.join(steam_path, "config", "libraryfolders.vdf"),
    }
    for _, candidate_path in ipairs(candidates) do
        if fs.exists(candidate_path) then
            local content = m_utils.read_file(candidate_path)
            if content then
                for _, encoded_path in ipairs(quoted_values(content, "path")) do
                    add(encoded_path)
                end
            end
        end
    end
    return libraries
end

local function directory_exists(path)
    if type(fs.is_directory) == "function" then
        local ok, result = pcall(fs.is_directory, path)
        if ok then return result == true end
    end
    return fs.exists(path)
end

local function manifest_record(library_path, appid, manifest_path, content)
    local manifest_appid = decimal_appid(quoted_value(content, "appid"))
    if manifest_appid ~= appid then return nil end
    local install_dir = trim(quoted_value(content, "installdir"))
    if install_dir == "" or install_dir == "." or install_dir == ".." or
        install_dir:find("[\r\n\\/:]") then return nil end
    local install_path = fs.join(library_path, "steamapps", "common", install_dir)
    if not directory_exists(install_path) then return nil end

    local game_name = trim(quoted_value(content, "name"))
    if game_name == "" then game_name = "Steam App " .. appid end
    if #game_name > 512 then game_name = game_name:sub(1, 512) end

    return {
        appid = appid,
        appId = appid,
        name = game_name,
        gameName = game_name,
        installPath = install_path,
        installDir = install_dir,
        libraryPath = library_path,
        manifestPath = manifest_path,
        buildId = tostring(quoted_value(content, "buildid") or ""),
        lastUpdated = tostring(quoted_value(content, "LastUpdated") or ""),
        stateFlags = tostring(quoted_value(content, "StateFlags") or ""),
        installed = true,
    }
end

function steam_utils.detect_steam_install_path()
    if STEAM_INSTALL_PATH then return STEAM_INSTALL_PATH end
    local success, path = pcall(millennium.steam_path)
    if success and path then
        STEAM_INSTALL_PATH = path
        logger.log("LuaTools: Steam install path set to " .. tostring(STEAM_INSTALL_PATH))
        return STEAM_INSTALL_PATH
    end
    return ""
end

function steam_utils.has_lua_for_app(appid)
    local base_path = steam_utils.detect_steam_install_path()
    if not base_path or base_path == "" then return false end

    local stplug_path = fs.join(base_path, "config", "stplug-in")
    local lua_file = fs.join(stplug_path, tostring(appid) .. ".lua")
    local disabled_file = fs.join(stplug_path, tostring(appid) .. ".lua.disabled")

    return fs.exists(lua_file) or fs.exists(disabled_file)
end

function steam_utils.get_game_install_path_response(appid)
    appid = decimal_appid(appid)
    if not appid then return { success = false, error = "Invalid appid" } end
    local steam_path = steam_utils.detect_steam_install_path()
    if not steam_path or steam_path == "" then
        return { success = false, error = "Could not find Steam installation path" }
    end

    for _, lib_path in ipairs(get_library_paths()) do
        local candidate = fs.join(lib_path, "steamapps", "appmanifest_" .. appid .. ".acf")
        if fs.exists(candidate) then
            local manifest_content = m_utils.read_file(candidate)
            if manifest_content then
                local record = manifest_record(lib_path, appid, candidate, manifest_content)
                if record then
                    record.success = true
                    record.path = record.installPath
                    return record
                end
            end
        end
    end
    return { success = false, error = "menu.error.notInstalled" }
end

function steam_utils.list_installed_games()
    local games, seen = {}, {}
    local libraries = get_library_paths()
    for _, library_path in ipairs(libraries) do
        local steamapps_path = fs.join(library_path, "steamapps")
        if directory_exists(steamapps_path) and type(fs.list) == "function" then
            local ok, entries = pcall(fs.list, steamapps_path)
            if ok and type(entries) == "table" then
                for _, entry in ipairs(entries) do
                    local name = tostring(entry.name or "")
                    local raw_appid = name:match("^appmanifest_(%d+)%.acf$")
                    local appid = raw_appid and decimal_appid(raw_appid) or nil
                    if appid and not seen[appid] then
                        local manifest_path = fs.join(steamapps_path, name)
                        local content = m_utils.read_file(manifest_path)
                        local record = content and
                            manifest_record(library_path, appid, manifest_path, content) or nil
                        if record then
                            seen[appid] = true
                            games[#games + 1] = record
                        end
                    end
                end
            end
        end
    end

    table.sort(games, function(left, right)
        local left_name = tostring(left.name or ""):lower()
        local right_name = tostring(right.name or ""):lower()
        if left_name ~= right_name then return left_name < right_name end
        if #left.appid ~= #right.appid then return #left.appid < #right.appid end
        return left.appid < right.appid
    end)
    return {
        success = true,
        games = games,
        count = #games,
        libraries = #libraries,
    }
end

function steam_utils.open_game_folder(path)
    if not path or path == "" or not fs.exists(path) then return false end
    
    -- In Windows, explorer accepts backslashes
    path = path:gsub("/", "\\")
    local cmd = 'explorer "' .. path .. '"'
    m_utils.exec(cmd)
    return true
end

return steam_utils
