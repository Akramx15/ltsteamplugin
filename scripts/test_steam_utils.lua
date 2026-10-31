local script_source = debug.getinfo(1, "S").source
local script_path = script_source:sub(1, 1) == "@" and script_source:sub(2) or
    "scripts/test_steam_utils.lua"
local script_directory = script_path:match("^(.*)[/\\]") or "scripts"
package.path = script_directory .. "/../backend/?.lua;" .. package.path

local function normalize(path)
    return tostring(path or ""):gsub("\\", "/"):gsub("/+", "/")
end

local files = {}
local directories = {}
local listings = {}
local function add_file(path, content)
    files[normalize(path)] = content
end
local function add_directory(path)
    directories[normalize(path)] = true
end
local function add_listing(path, names)
    local entries = {}
    for _, name in ipairs(names) do
        entries[#entries + 1] = { name = name, path = normalize(path .. "/" .. name) }
    end
    listings[normalize(path)] = entries
end

-- Generated fixture IDs make the test prove data-driven discovery rather than
-- accidentally documenting a production allowlist.
local fixture_seed = #normalize(script_path) * 7919
local appid_alpha = tostring(1000000 + fixture_seed)
local appid_beta = tostring(2000000 + fixture_seed)
local appid_mismatch = tostring(3000000 + fixture_seed)

add_file("C:/Steam/steamapps/libraryfolders.vdf", [[
"libraryfolders"
{
    "0" { "path" "C:\\Steam" }
    "1" { "path" "D:\\Steam Library" }
}
]])
add_file("D:/Steam Library/steamapps/appmanifest_" .. appid_beta .. ".acf", [[
"AppState"
{
    "appid" "]] .. appid_beta .. [["
    "name" "Beta \"Quoted\" Game"
    "installdir" "Lossless Scaling"
    "buildid" "987654321012345678"
}
]])
add_directory("D:/Steam Library/steamapps/common/Lossless Scaling")
add_file("C:/Steam/steamapps/appmanifest_" .. appid_alpha .. ".acf", [[
"AppState"
{
    "appid" "]] .. appid_alpha .. [["
    "name" "Alpha Game"
    "installdir" "Alpha Folder"
    "buildid" "1122334455"
}
]])
add_directory("C:/Steam/steamapps/common/Alpha Folder")
add_file("D:/Steam Library/steamapps/appmanifest_" .. appid_mismatch .. ".acf", [[
"AppState"
{
    "appid" "42"
    "name" "Must Be Ignored"
    "installdir" "Mismatch"
}
]])
add_directory("D:/Steam Library/steamapps/common/Mismatch")
add_listing("C:/Steam/steamapps", {
    "libraryfolders.vdf",
    "appmanifest_" .. appid_alpha .. ".acf",
    "appmanifest_" .. appid_alpha .. ".acf.bak",
})
add_listing("D:/Steam Library/steamapps", {
    "appmanifest_" .. appid_beta .. ".acf",
    "appmanifest_" .. appid_mismatch .. ".acf",
    "not-a-manifest.txt",
})

package.preload["utils"] = function()
    return {
        read_file = function(path) return files[normalize(path)] end,
        exec = function() return true end,
    }
end
package.preload["millennium"] = function()
    return { steam_path = function() return "C:/Steam" end }
end
package.preload["fs"] = function()
    return {
        join = function(...)
            local values = { ... }
            return normalize(table.concat(values, "/"))
        end,
        exists = function(path)
            path = normalize(path)
            return files[path] ~= nil or directories[path] == true
        end,
        is_directory = function(path)
            path = normalize(path)
            return directories[path] == true or listings[path] ~= nil
        end,
        list = function(path)
            return listings[normalize(path)] or {}
        end,
    }
end
package.preload["plugin_logger"] = function()
    return { log = function() end, warn = function() end, error = function() end }
end
package.preload["paths"] = function() return {} end

local steam_utils = require("steam_utils")
local result = steam_utils.get_game_install_path_response(appid_beta)
assert(result.success == true, tostring(result.error))
assert(normalize(result.libraryPath) == "D:/Steam Library", "wrong library selected")
assert(normalize(result.installPath) ==
    "D:/Steam Library/steamapps/common/Lossless Scaling", "wrong install path")
assert(result.gameName == 'Beta "Quoted" Game', "escaped game name was truncated")
assert(result.buildId == "987654321012345678", "build ID lost string precision")

local missing = steam_utils.get_game_install_path_response("42")
assert(missing.success == false and missing.error == "menu.error.notInstalled",
    "missing games must not be reported as installed")

local inventory = steam_utils.list_installed_games()
assert(inventory.success == true, tostring(inventory.error))
assert(inventory.count == 2, "inventory must be derived from two valid manifests")
assert(inventory.libraries == 2, "all Steam libraries must be scanned")
assert(inventory.games[1].appid == appid_alpha, "games must be sorted by name")
assert(inventory.games[1].name == "Alpha Game", "first manifest name was not parsed")
assert(inventory.games[2].appid == appid_beta, "second library game missing")
assert(inventory.games[2].name == 'Beta "Quoted" Game', "escaped name mismatch")
for _, game in ipairs(inventory.games) do
    assert(game.appid ~= appid_mismatch, "mismatched filename/AppState AppID was accepted")
    assert(game.installPath:find("steamapps/common", 1, true), "install path escaped common")
end

print("steam_utils tests passed")
