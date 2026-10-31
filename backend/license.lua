-- Machine-bound activation gate.
-- HWID = SHA256(lower(guid):lower(uuid):lower(drive serial)) -> first 16 hex, shown XXXX-XXXX-XXXX-XXXX.
-- key  = Crockford(HMAC-SHA256(SECRET, lower(hwid16))[0..10]) -- computed and checked by license.ps1,
-- because Lua has no SHA-256. One process spawn per distinct key, cached afterwards.
local license = {}

local m_utils = require("utils")
local paths   = require("paths")

local _cache = {}

local function read_key()
    local ok, manager = pcall(require, "settings.manager")
    if not ok or not manager or not manager.get_license_key then return "" end
    return tostring(manager.get_license_key()):upper():gsub("%s", "")
end

local function run_ps(args)
    local script = paths.backend_path("license.ps1")
    local cmd = string.format('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%s" %s', script, args)
    local out = m_utils.exec(cmd)
    if type(out) ~= "string" then return nil end
    return out
end

function license.current_key()
    return read_key()
end

-- "9043-844F-B85C-3A31" for this machine, or "" when PowerShell failed.
function license.hwid()
    if _cache.hwid then return _cache.hwid end
    local out = run_ps("-PrintHwid")
    if out then
        local hw = out:match("HWID=([%w%-]+)")
        if hw then _cache.hwid = hw:upper() end
    end
    return _cache.hwid or ""
end

-- returns ok:boolean, reason:string
function license.is_active()
    local key = read_key()
    if key == "" then return false, "missing" end
    if #key < 16 then return false, "format" end
    if _cache[key] ~= nil then
        if _cache[key] then return true, "ok" end
        return false, "mismatch"
    end
    local out = run_ps(string.format('-Key "%s"', key))
    if not out then return false, "error" end
    if out:find("RESULT=OK") then _cache[key] = true; return true, "ok" end
    if out:find("RESULT=BAD") then _cache[key] = false; return false, "mismatch" end
    return false, "error"
end

return license
