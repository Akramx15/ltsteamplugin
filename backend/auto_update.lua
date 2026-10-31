local m_utils = require("utils")
local fs = require("fs")
local http_client = require("http_client")
local config = require("config")
local logger = require("plugin_logger")
local paths = require("paths")
local utils = require("plugin_utils")
local steam_utils = require("steam_utils")

local auto_update = {}

function auto_update.check_for_updates_now()
    local cfg_path = paths.backend_path(config.UPDATE_CONFIG_FILE)
    local cfg = utils.read_json(cfg_path)
    
    local latest_version = ""
    local zip_url = ""
    
    local token = m_utils.read_file(paths.backend_path("update_token.txt")) or ""
    token = token:gsub("%s+", "")

    local gh_cfg = cfg.github
    if gh_cfg then
        local owner = gh_cfg.owner or ""
        local repo = gh_cfg.repo or ""
        local asset_name = gh_cfg.asset_name or "ltsteamplugin.zip"
        local tag = gh_cfg.tag or ""
        local tag_prefix = gh_cfg.tag_prefix or ""
        
        local endpoint = "https://api.github.com/repos/" .. owner .. "/" .. repo .. "/releases/latest"
        if tag ~= "" then
            endpoint = "https://api.github.com/repos/" .. owner .. "/" .. repo .. "/releases/tags/" .. tag
        end
        
        local headers = {
            ["Accept"] = "application/vnd.github+json",
            ["User-Agent"] = "LuaTools-Updater"
        }
        if token ~= "" then headers["Authorization"] = "Bearer " .. token end
        local resp = http_client.get(endpoint, {
            headers = headers,
            timeout = 10
        })
        if resp and resp.status == 200 and resp.body then
            local data = utils.decode_json(resp.body)
            local tag_name = data.tag_name or ""
            latest_version = tag_name or data.name or ""
            if tag_prefix ~= "" and latest_version:sub(1, #tag_prefix) == tag_prefix then
                latest_version = latest_version:sub(#tag_prefix + 1)
            end
            
            for _, asset in ipairs(data.assets or {}) do
                if asset.name == asset_name then
                    zip_url = asset.browser_download_url
                    break
                end
            end
            if zip_url == "" and tag_name ~= "" then
                -- no third-party fallback: it serves unverified zips (supply chain)
                return { success = false, error = "Release has no " .. asset_name .. " asset" }
            end
        end
    end
    
    if latest_version == "" or zip_url == "" then
        return { success = false, error = "Manifest missing version or zip_url" }
    end
    
    local current_version = utils.get_plugin_version()

    -- Compare version tables component by component (can't use <= on tables in Lua)
    local function compare_versions(a, b)
        local ta = utils.parse_version(a)
        local tb = utils.parse_version(b)
        local len = math.max(#ta, #tb)
        for i = 1, len do
            local ai = ta[i] or 0
            local bi = tb[i] or 0
            if ai < bi then return -1
            elseif ai > bi then return 1
            end
        end
        return 0
    end

    if compare_versions(latest_version, current_version) <= 0 then
        return { success = true, message = "Up-to-date (current " .. current_version .. ")" }
    end
    
    local pending_zip = paths.backend_path(config.UPDATE_PENDING_ZIP)
    local staging = paths.backend_path("update_staging")
    if not fs.exists(staging) then fs.create_directories(staging) end

    local is_windows = m_utils.getenv("OS") == "Windows_NT"
    local auth = ""
    if token ~= "" then auth = '-H "Authorization: Bearer ' .. token .. '" ' end
    local cmd
    if is_windows then
        -- Absolute bsdtar (unquoted: cmd /c mangles a leading quoted path), extract to staging then copy,
        -- so a failed extract never leaves the live plugin dir half-written.
        cmd = string.format('curl.exe -sL --max-time 180 %s-A "discord(dot)gg/luatools" "%s" -o "%s" && C:\\Windows\\System32\\tar.exe -xf "%s" -C "%s" && xcopy "%s\\*" "%s\\" /E /Y /I /Q >NUL', auth, zip_url, pending_zip, pending_zip, staging, staging, paths.get_plugin_dir())
    else
        cmd = string.format('curl -L --max-time 180 %s-o "%s" "%s" && unzip -o -q "%s" -d "%s" && cp -R "%s/." "%s/"', auth, pending_zip, zip_url, pending_zip, staging, staging, paths.get_plugin_dir())
    end

    local out, status = m_utils.exec(cmd)
    if out == nil or (tonumber(status) or 1) ~= 0 then
        return { success = false, error = "Update download/extract failed (" .. tostring(status) .. ")" }
    end
    if compare_versions(utils.get_plugin_version(), latest_version) ~= 0 then
        return { success = false, error = "Update verification failed: plugin.json is " .. tostring(utils.get_plugin_version()) }
    end
    pcall(fs.remove_all, staging)
    if fs.exists(pending_zip) then fs.remove(pending_zip) end

    local msg = "LuaTools updated to " .. latest_version .. ". Please restart Steam."
    return { success = true, message = msg }
end

function auto_update.restart_steam()
    local is_windows = m_utils.getenv("OS") == "Windows_NT"
    if is_windows then
        local script_path = paths.backend_path("restart_steam.ps1")
        if fs.exists(script_path) then
            local _, status = m_utils.exec(
                'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' .. script_path .. '"'
            )
            if status == nil then return true end
            return tonumber(status) == 0
        end
    else
        m_utils.exec("killall steam && steam &")
        return true
    end
    return false
end

function auto_update.apply_pending_update_if_any()
    return ""
end

return auto_update
