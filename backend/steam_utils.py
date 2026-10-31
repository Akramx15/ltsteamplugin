"""Steam-related utilities used across LuaTools backend modules."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from typing import Dict, List, Optional

import Millennium  # type: ignore

from logger import logger

_STEAM_INSTALL_PATH: Optional[str] = None

if sys.platform.startswith("win"):
    try:
        import winreg  # type: ignore
    except Exception:  # pragma: no cover - registry import failure fallback
        winreg = None  # type: ignore
else:
    winreg = None  # type: ignore


def detect_steam_install_path() -> str:
    """Return the cached Steam installation path or discover it."""
    global _STEAM_INSTALL_PATH
    if _STEAM_INSTALL_PATH:
        return _STEAM_INSTALL_PATH

    path = None

    if sys.platform.startswith("win") and winreg is not None:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
                path, _ = winreg.QueryValueEx(key, "SteamPath")
        except Exception:
            path = None

    if not path:
        try:
            path = Millennium.steam_path()
        except Exception:
            path = None

    _STEAM_INSTALL_PATH = path
    logger.log(f"LuaTools: Steam install path set to {_STEAM_INSTALL_PATH}")
    return _STEAM_INSTALL_PATH or ""


def _parse_vdf_simple(content: str) -> Dict[str, any]:
    """Simple VDF parser for libraryfolders.vdf and appmanifest files."""
    result: Dict[str, any] = {}
    stack = [result]
    current_key = None

    lines = content.split("\n")
    tokens = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        parts = re.findall(r'"[^"]*"|\{|\}', line)
        tokens.extend(parts)

    i = 0
    while i < len(tokens):
        token = tokens[i].strip('"')

        if tokens[i] == "{":
            if current_key:
                new_dict = {}
                stack[-1][current_key] = new_dict
                stack.append(new_dict)
                current_key = None
        elif tokens[i] == "}":
            if len(stack) > 1:
                stack.pop()
        elif current_key is None:
            current_key = token
        else:
            stack[-1][current_key] = token
            current_key = None
        i += 1

    return result


def _find_steam_path() -> str:
    global _STEAM_INSTALL_PATH
    if _STEAM_INSTALL_PATH:
        return _STEAM_INSTALL_PATH

    if sys.platform.startswith("win") and winreg:
        try:
            try:
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam")
                steam_path = winreg.QueryValueEx(key, "SteamPath")[0]
                winreg.CloseKey(key)
                if steam_path and os.path.exists(steam_path):
                    _STEAM_INSTALL_PATH = steam_path
                    return steam_path
            except Exception:
                pass

            try:
                key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"Software\Valve\Steam")
                steam_path = winreg.QueryValueEx(key, "InstallPath")[0]
                winreg.CloseKey(key)
                if steam_path and os.path.exists(steam_path):
                    _STEAM_INSTALL_PATH = steam_path
                    return steam_path
            except Exception:
                pass
        except Exception as exc:
            logger.warn(f"LuaTools: Failed to read Steam path from registry: {exc}")

    return ""


def has_lua_for_app(appid: int) -> bool:
    try:
        base_path = detect_steam_install_path() or Millennium.steam_path()
        if not base_path:
            return False

        stplug_path = os.path.join(base_path, "config", "stplug-in")
        lua_file = os.path.join(stplug_path, f"{appid}.lua")
        disabled_file = os.path.join(stplug_path, f"{appid}.lua.disabled")
        return os.path.exists(lua_file) or os.path.exists(disabled_file)
    except Exception as exc:
        logger.error(f"LuaTools (steam_utils): Error checking Lua scripts for app {appid}: {exc}")
        return False


def _decode_vdf_scalar(value: str) -> str:
    return re.sub(
        r"\\([\\\"nt])",
        lambda match: {"\\": "\\", '"': '"', "n": "\n", "t": "\t"}.get(
            match.group(1), match.group(0)
        ),
        value,
    )


def _extract_vdf_field(content: str, field: str) -> str:
    match = re.search(
        rf'"{re.escape(field)}"\s+"((?:\\.|[^"\\])*)"',
        content or "",
    )
    return _decode_vdf_scalar(match.group(1)).strip() if match else ""


def _get_library_paths() -> List[str]:
    steam_path = detect_steam_install_path() or _find_steam_path()
    if not steam_path:
        return []
    result: List[str] = []
    seen = set()

    def add(value: str) -> None:
        value = str(value or "").strip()
        key = os.path.normcase(os.path.normpath(value)) if value else ""
        if key and key not in seen:
            seen.add(key)
            result.append(value)

    add(steam_path)
    for candidate in (
        os.path.join(steam_path, "steamapps", "libraryfolders.vdf"),
        os.path.join(steam_path, "config", "libraryfolders.vdf"),
    ):
        if not os.path.isfile(candidate):
            continue
        try:
            with open(candidate, "r", encoding="utf-8-sig") as handle:
                content = handle.read()
            for encoded in re.findall(r'"path"\s+"((?:\\.|[^"\\])*)"', content):
                add(_decode_vdf_scalar(encoded))
        except OSError as exc:
            logger.warn(f"LuaTools: Could not scan Steam library file {candidate}: {exc}")
    return result


def list_installed_games() -> Dict[str, any]:
    """Derive installed apps from live appmanifest files across every library."""
    games = []
    seen = set()
    libraries = _get_library_paths()
    for library_path in libraries:
        steamapps_path = os.path.join(library_path, "steamapps")
        if not os.path.isdir(steamapps_path):
            continue
        try:
            names = os.listdir(steamapps_path)
        except OSError as exc:
            logger.warn(f"LuaTools: Could not scan Steam library {steamapps_path}: {exc}")
            continue
        for filename in names:
            match = re.fullmatch(r"appmanifest_(\d+)\.acf", filename)
            if not match:
                continue
            appid = match.group(1).lstrip("0") or "0"
            if appid == "0" or int(appid) > 0xFFFFFFFF or appid in seen:
                continue
            manifest_path = os.path.join(steamapps_path, filename)
            try:
                with open(manifest_path, "r", encoding="utf-8-sig") as handle:
                    content = handle.read()
            except OSError:
                continue
            if (_extract_vdf_field(content, "appid").lstrip("0") or "0") != appid:
                continue
            install_dir = _extract_vdf_field(content, "installdir")
            if (
                not install_dir
                or install_dir in {".", ".."}
                or any(character in install_dir for character in "\r\n\\/:")
            ):
                continue
            install_path = os.path.join(steamapps_path, "common", install_dir)
            if not os.path.isdir(install_path):
                continue
            game_name = _extract_vdf_field(content, "name") or f"Steam App {appid}"
            seen.add(appid)
            games.append(
                {
                    "appid": appid,
                    "appId": appid,
                    "name": game_name[:512],
                    "gameName": game_name[:512],
                    "installPath": install_path,
                    "installDir": install_dir,
                    "libraryPath": library_path,
                    "manifestPath": manifest_path,
                    "buildId": _extract_vdf_field(content, "buildid"),
                    "lastUpdated": _extract_vdf_field(content, "LastUpdated"),
                    "stateFlags": _extract_vdf_field(content, "StateFlags"),
                    "installed": True,
                }
            )
    games.sort(key=lambda game: (game["name"].casefold(), len(game["appid"]), game["appid"]))
    return {
        "success": True,
        "games": games,
        "count": len(games),
        "libraries": len(libraries),
    }


def get_game_install_path_response(appid: int) -> Dict[str, any]:
    """Find the game installation path. Returns dict mirroring previous JSON output."""
    try:
        appid = int(appid)
    except Exception:
        return {"success": False, "error": "Invalid appid"}
    if appid <= 0 or appid > 0xFFFFFFFF:
        return {"success": False, "error": "Invalid appid"}
    appid_text = str(appid)
    for library_path in _get_library_paths():
        steamapps_path = os.path.join(library_path, "steamapps")
        manifest_path = os.path.join(steamapps_path, f"appmanifest_{appid_text}.acf")
        if not os.path.isfile(manifest_path):
            continue
        try:
            with open(manifest_path, "r", encoding="utf-8-sig") as handle:
                content = handle.read()
        except OSError:
            continue
        if (_extract_vdf_field(content, "appid").lstrip("0") or "0") != appid_text:
            continue
        install_dir = _extract_vdf_field(content, "installdir")
        if (
            not install_dir
            or install_dir in {".", ".."}
            or any(character in install_dir for character in "\r\n\\/:")
        ):
            continue
        install_path = os.path.join(steamapps_path, "common", install_dir)
        if not os.path.isdir(install_path):
            continue
        game_name = _extract_vdf_field(content, "name") or f"Steam App {appid_text}"
        return {
            "success": True,
            "appid": appid_text,
            "appId": appid_text,
            "gameName": game_name[:512],
            "name": game_name[:512],
            "installPath": install_path,
            "installDir": install_dir,
            "libraryPath": library_path,
            "manifestPath": manifest_path,
            "buildId": _extract_vdf_field(content, "buildid"),
            "path": install_path,
        }
    return {"success": False, "error": "menu.error.notInstalled"}


def open_game_folder(path: str) -> bool:
    """Open the game folder using the platform default file explorer."""
    try:
        if not path or not os.path.exists(path):
            return False

        if sys.platform.startswith("win"):
            subprocess.Popen(["explorer", os.path.normpath(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
        return True
    except Exception as exc:
        logger.warn(f"LuaTools: Failed to open game folder: {exc}")
        return False


__all__ = [
    "detect_steam_install_path",
    "get_game_install_path_response",
    "has_lua_for_app",
    "list_installed_games",
    "open_game_folder",
]

