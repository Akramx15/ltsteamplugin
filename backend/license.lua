-- Offline activation gate. A key is AK-YYYYMMDD-CCCC where CCCC is a 4-digit
-- checksum of SECRET..YYYYMMDD. No network, no machine binding: a key works
-- until its date. Generate keys with scripts/make_license.py.
local license = {}

local SECRET = "akrams-luatools-2026-v9"

local function _checksum(expiry)
    local h = 0
    local s = SECRET .. expiry
    for i = 1, #s do
        h = (h * 131 + s:byte(i)) % 2147483647
    end
    return h % 9000 + 1000
end

function license.normalise(key)
    key = tostring(key or ""):upper():gsub("%s", "")
    return key
end

-- returns ok:boolean, reason:string, expiry:string
function license.validate(key)
    key = license.normalise(key)
    if key == "" then return false, "missing", "" end
    local expiry, check = key:match("^AK%-(%d%d%d%d%d%d%d%d)%-(%d%d%d%d)$")
    if not expiry then return false, "format", "" end
    if tostring(_checksum(expiry)) ~= check then return false, "checksum", expiry end
    local today = tonumber(os.date("%Y%m%d")) or 0
    if today > tonumber(expiry) then return false, "expired", expiry end
    return true, "ok", expiry
end

function license.current_key()
    local ok, manager = pcall(require, "settings.manager")
    if not ok or not manager or not manager.get_license_key then return "" end
    return license.normalise(manager.get_license_key())
end

function license.is_active()
    return license.validate(license.current_key())
end

return license
