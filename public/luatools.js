// LuaTools button injection (standalone plugin)

// ============================================
// GAMEPAD NAVIGATION SYSTEM - Inline Version
// ============================================
(function () {
  "use strict";

  // Inject gamepad navigation CSS
  const gamepadCSS = document.createElement("style");
  gamepadCSS.id = "gamepad-navigation-styles";
  gamepadCSS.textContent = `
        .active-focus {
            outline: 3px solid #66c0f4 !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 0 4px rgba(102, 192, 244, 0.3),
                        0 0 12px rgba(102, 192, 244, 0.5) !important;
            position: relative !important;
            z-index: 9999 !important;
            transition: outline 0.15s ease, box-shadow 0.15s ease !important;
        }

        @keyframes gamepad-focus-pulse {
            0%, 100% {
                box-shadow: 0 0 0 4px rgba(102, 192, 244, 0.3),
                            0 0 12px rgba(102, 192, 244, 0.5);
            }
            50% {
                box-shadow: 0 0 0 4px rgba(102, 192, 244, 0.5),
                            0 0 16px rgba(102, 192, 244, 0.7);
            }
        }

        @keyframes luatools-downgrade-indeterminate {
            0% {
                transform: translateX(-140%);
            }
            100% {
                transform: translateX(460%);
            }
        }

        .active-focus {
            animation: gamepad-focus-pulse 1.5s ease-in-out infinite;
        }

        button.active-focus,
        a.active-focus {
            background-color: rgba(102, 192, 244, 0.15) !important;
            transform: scale(1.02);
        }

        .BasicUI .active-focus,
        .touch .active-focus {
            outline-width: 4px !important;
            outline-offset: 3px !important;
        }

        input.active-focus,
        select.active-focus,
        textarea.active-focus {
            border-color: #66c0f4 !important;
            background-color: rgba(102, 192, 244, 0.1) !important;
        }

        .active-focus:focus {
            outline: 3px solid #66c0f4 !important;
        }

        button,
        a,
        input,
        select,
        textarea,
        .focusable {
            transition: transform 0.15s ease, background-color 0.15s ease !important;
        }

        .luatools-button.active-focus,
        .luatools-restart-button.active-focus {
            transform: scale(1.05) !important;
            background: linear-gradient(135deg, rgba(102, 192, 244, 0.3), rgba(102, 192, 244, 0.2)) !important;
        }

        .btnv6_blue_hoverfade.active-focus {
            background: linear-gradient(to right, #47bfff 5%, #1a9fff 95%) !important;
        }

        .active-focus {
            scroll-margin: 20px;
        }
    `;
  document.head.appendChild(gamepadCSS);

  // Gamepad Navigation System
  // ALL LuaTools overlays that should block Steam navigation
  const OVERLAY_SELECTORS = [
    ".luatools-overlay",
    ".luatools-settings-overlay",
    ".luatools-fixes-results-overlay",
    ".luatools-loading-fixes-overlay",
    ".luatools-unfix-overlay",
    ".luatools-settings-manager-overlay",
    ".luatools-alert-overlay",
    ".luatools-confirm-overlay",
    ".luatools-downgrade-overlay",
    ".luatools-loadedapps-overlay",
  ];
  const OVERLAY_SELECTOR_STRING = OVERLAY_SELECTORS.join(", ");

  const CONFIG = {
    deadzone: 0.4, // Increased from 0.3 to prevent unwanted drift
    debounceTime: 200,
    pollRate: 16,
    stickThreshold: 0.7, // Increased threshold for stick navigation
    buttonMap: {
      A: 0,
      B: 1,
      X: 2,
      Y: 3,
      LB: 4,
      RB: 5,
      LT: 6,
      RT: 7,
      SELECT: 8,
      START: 9,
      L3: 10,
      R3: 11,
      DPAD_UP: 12,
      DPAD_DOWN: 13,
      DPAD_LEFT: 14,
      DPAD_RIGHT: 15,
    },
    axesMap: {
      LEFT_STICK_X: 0,
      LEFT_STICK_Y: 1,
      RIGHT_STICK_X: 2,
      RIGHT_STICK_Y: 3,
    },
  };

  const state = {
    gamepadConnected: false,
    gamepadIndex: null,
    focusableElements: [],
    currentFocusIndex: 0,
    lastNavigationTime: 0,
    lastAxisValues: {
      x: 0,
      y: 0,
    },
    buttonStates: {},
    animationFrameId: null,
  };

  // duplicated from main code thing for reliability
  function isBigPictureMode() {
    if (typeof window.__LUATOOLS_IS_BIG_PICTURE__ !== "undefined") {
      return window.__LUATOOLS_IS_BIG_PICTURE__;
    }
    const htmlClasses = document.documentElement.className;
    const userAgent = navigator.userAgent;
    let score = 0;
    if (htmlClasses.includes("BasicUI")) score += 3;
    if (htmlClasses.includes("DesktopUI")) score -= 3;
    if (userAgent.includes("Valve Steam Gamepad")) score += 2;
    if (userAgent.includes("Valve Steam Client")) score -= 2;
    if (htmlClasses.includes("touch")) score += 1;
    return score > 0;
  }

  // B button handler removed - users should use the modal buttons directly
  // This prevents conflicts with Steam's back navigation
  let onBackHandler = function () {
    console.log(
      "[Gamepad] B button pressed - ignoring (use modal buttons instead)",
    );
    // Do nothing - let users navigate with D-pad/stick and press A on Cancel/Back buttons
  };

  function onGamepadConnected(event) {
    console.log("[Gamepad] Gamepad conectado en Millennium:", event.gamepad.id);
    state.gamepadConnected = true;
    state.gamepadIndex = event.gamepad.index;
    if (!state.animationFrameId) {
      pollGamepad();
    }
    // Don't scan immediately - only scan when an overlay is opened
    // scanFocusableElements() will be called by the overlay's setTimeout
  }

  function onGamepadDisconnected(event) {
    console.log("[Gamepad] Gamepad disconnected:", event.gamepad.id);
    if (state.gamepadIndex === event.gamepad.index) {
      state.gamepadConnected = false;
      state.gamepadIndex = null;
      if (state.animationFrameId) {
        cancelAnimationFrame(state.animationFrameId);
        state.animationFrameId = null;
      }
    }
  }

  function scanFocusableElements() {
    if (!isBigPictureMode()) return;

    // Only scan if there's a LuaTools overlay active
    const activeOverlay = document.querySelector(OVERLAY_SELECTOR_STRING);

    if (!activeOverlay) {
      console.log("[Gamepad] No LuaTools overlay active, skipping scan");
      state.focusableElements = [];
      state.currentFocusIndex = 0;
      return;
    }

    // Only scan elements INSIDE the active overlay
    const selectors = [
      "button:not([disabled])",
      "a[href]:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex="0"]',
      '[tabindex]:not([tabindex="-1"])',
      ".focusable:not([disabled])",
    ].join(", ");

    // Use querySelectorAll on the overlay, not the whole document
    const elements = Array.from(activeOverlay.querySelectorAll(selectors));
    state.focusableElements = elements.filter(function (el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    });

    console.log(
      "[Gamepad] Scanned " +
        state.focusableElements.length +
        " focusable elements inside overlay",
    );

    if (state.focusableElements.length > 0) {
      focusElement(0);
    }
  }

  function focusElement(index) {
    const prevElement = state.focusableElements[state.currentFocusIndex];
    if (prevElement) {
      prevElement.blur();
      prevElement.classList.remove("active-focus");
    }

    if (index < 0) index = 0;
    if (index >= state.focusableElements.length)
      index = state.focusableElements.length - 1;

    state.currentFocusIndex = index;

    const element = state.focusableElements[index];
    if (element) {
      element.focus();
      element.classList.add("active-focus");
      element.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
      console.log("[Gamepad] Focused element " + index + ":", element);
    }
  }

  function navigate(direction) {
    const now = Date.now();
    if (now - state.lastNavigationTime < CONFIG.debounceTime) {
      return;
    }
    state.lastNavigationTime = now;

    if (state.focusableElements.length === 0) {
      scanFocusableElements();
      return;
    }

    let newIndex = state.currentFocusIndex;

    switch (direction) {
      case "up":
        newIndex--;
        break;
      case "down":
        newIndex++;
        break;
      case "left":
        newIndex = findElementInDirection("left");
        break;
      case "right":
        newIndex = findElementInDirection("right");
        break;
    }

    if (newIndex < 0) newIndex = state.focusableElements.length - 1;
    if (newIndex >= state.focusableElements.length) newIndex = 0;

    focusElement(newIndex);
  }

  function findElementInDirection(direction) {
    const currentElement = state.focusableElements[state.currentFocusIndex];
    if (!currentElement) return state.currentFocusIndex;

    const currentRect = currentElement.getBoundingClientRect();
    let closestIndex = state.currentFocusIndex;
    let closestDistance = Infinity;

    state.focusableElements.forEach(function (el, index) {
      if (index === state.currentFocusIndex) return;

      const rect = el.getBoundingClientRect();
      let isInDirection = false;
      let distance = 0;

      if (direction === "left") {
        isInDirection = rect.right <= currentRect.left;
        distance = currentRect.left - rect.right;
      } else if (direction === "right") {
        isInDirection = rect.left >= currentRect.right;
        distance = rect.left - currentRect.right;
      }

      if (isInDirection && distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });

    return closestIndex;
  }

  function handleButtonPress(buttonIndex) {
    const element = state.focusableElements[state.currentFocusIndex];

    switch (buttonIndex) {
      case CONFIG.buttonMap.A:
        if (element) {
          console.log("[Gamepad] A button: clicking element", element);
          element.click();
          setTimeout(scanFocusableElements, 100);
        }
        break;

      case CONFIG.buttonMap.B:
        // B button disabled - users should use modal buttons
        console.log("[Gamepad] B button pressed - ignoring");
        break;

      case CONFIG.buttonMap.DPAD_UP:
        navigate("up");
        break;

      case CONFIG.buttonMap.DPAD_DOWN:
        navigate("down");
        break;

      case CONFIG.buttonMap.DPAD_LEFT:
        navigate("left");
        break;

      case CONFIG.buttonMap.DPAD_RIGHT:
        navigate("right");
        break;
    }
  }

  function pollGamepad() {
    if (!state.gamepadConnected) {
      state.animationFrameId = null;
      return;
    }

    // Check if there's an active LuaTools overlay
    const hasActiveOverlay = document.querySelector(OVERLAY_SELECTOR_STRING);

    // If no overlay is active, skip input processing but keep polling
    if (!hasActiveOverlay) {
      state.animationFrameId = requestAnimationFrame(pollGamepad);
      return;
    }

    const gamepads = navigator.getGamepads();
    const gamepad = gamepads[state.gamepadIndex];

    if (!gamepad) {
      state.animationFrameId = requestAnimationFrame(pollGamepad);
      return;
    }

    // Buttons
    gamepad.buttons.forEach(function (button, index) {
      const wasPressed = state.buttonStates[index] || false;
      const isPressed = button.pressed;

      if (isPressed && !wasPressed) {
        handleButtonPress(index);
      }

      state.buttonStates[index] = isPressed;
    });

    // Left stick
    const axisX = gamepad.axes[CONFIG.axesMap.LEFT_STICK_X] || 0;
    const axisY = gamepad.axes[CONFIG.axesMap.LEFT_STICK_Y] || 0;

    const x = Math.abs(axisX) > CONFIG.deadzone ? axisX : 0;
    const y = Math.abs(axisY) > CONFIG.deadzone ? axisY : 0;

    const now = Date.now();
    const threshold = CONFIG.stickThreshold; // Use higher threshold (0.7)
    if (now - state.lastNavigationTime >= CONFIG.debounceTime) {
      if (y < -threshold && state.lastAxisValues.y >= -threshold) {
        navigate("up");
      } else if (y > threshold && state.lastAxisValues.y <= threshold) {
        navigate("down");
      } else if (x < -threshold && state.lastAxisValues.x >= -threshold) {
        navigate("left");
      } else if (x > threshold && state.lastAxisValues.x <= threshold) {
        navigate("right");
      }
    }

    state.lastAxisValues.x = x;
    state.lastAxisValues.y = y;

    state.animationFrameId = requestAnimationFrame(pollGamepad);
  }

  // Disabled: MutationObserver was causing unwanted auto-scanning
  // Only manual scanElements() calls from overlay setTimeout will trigger scans
  /*
    const observer = new MutationObserver(function(mutations) {
        clearTimeout(observer.rescanTimeout);
        observer.rescanTimeout = setTimeout(function() {
            if (state.gamepadConnected) {
                scanFocusableElements();
            }
        }, 300);
    });
    */

  // Block Steam's gamepad navigation when overlay is active
  function blockSteamNavigation(event) {
    const hasActiveOverlay = document.querySelector(OVERLAY_SELECTOR_STRING);

    if (hasActiveOverlay && state.gamepadConnected) {
      // Block arrow keys, Enter, Escape, Backspace and other navigation keys
      // Note: Steam may translate gamepad B button to Escape or Backspace
      const navKeys = [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Enter",
        "Escape",
        "Backspace",
        " ",
        "Tab",
      ];
      if (navKeys.includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        console.log("[Gamepad] Blocked Steam navigation key:", event.key);
        return false;
      }
    }
  }

  // Block clicks on Steam UI when overlay is active
  function blockSteamClicks(event) {
    const hasActiveOverlay = document.querySelector(OVERLAY_SELECTOR_STRING);

    if (hasActiveOverlay && state.gamepadConnected) {
      // Only allow clicks inside the overlay
      const clickedInsideOverlay = event.target.closest(
        OVERLAY_SELECTOR_STRING,
      );

      if (!clickedInsideOverlay) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        console.log("[Gamepad] Blocked click outside overlay");
        return false;
      }
    }
  }

  // Block browser history navigation when overlay is active
  function blockHistoryNavigation(event) {
    const hasActiveOverlay = document.querySelector(OVERLAY_SELECTOR_STRING);
    if (hasActiveOverlay && state.gamepadConnected) {
      console.log("[Gamepad] Blocked history navigation (popstate)");
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      // Push the current state back to prevent navigation
      window.history.pushState(null, "", window.location.href);
      return false;
    }
  }

  function init() {
    if (!isBigPictureMode()) {
      console.log("[Gamepad] Not in Big Picture Mode, skipping initialization");
      return;
    }

    console.log("[Gamepad] Initializing Gamepad Navigation System...");

    window.addEventListener("gamepadconnected", onGamepadConnected);
    window.addEventListener("gamepaddisconnected", onGamepadDisconnected);

    // Block Steam's keyboard navigation when overlay is active
    document.addEventListener("keydown", blockSteamNavigation, true);
    document.addEventListener("keyup", blockSteamNavigation, true);

    // Block clicks outside overlay when gamepad is active
    document.addEventListener("click", blockSteamClicks, true);
    document.addEventListener("mousedown", blockSteamClicks, true);

    // Block browser history navigation (back button)
    window.addEventListener("popstate", blockHistoryNavigation, true);

    const gamepads = navigator.getGamepads();
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i]) {
        onGamepadConnected({
          gamepad: gamepads[i],
        });
        break;
      }
    }

    // Disabled: MutationObserver auto-scanning
    /*
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        */

    // Don't scan on init - only scan when overlays are opened
    // scanFocusableElements();

    console.log("[Gamepad] Initialization complete");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.GamepadNav = {
    scanElements: scanFocusableElements,
    setBackHandler: function (fn) {
      if (typeof fn === "function") {
        onBackHandler = fn;
      }
    },
    focusElement: focusElement,
    getCurrentIndex: function () {
      return state.currentFocusIndex;
    },
    getElements: function () {
      return state.focusableElements;
    },
    isConnected: function () {
      return state.gamepadConnected;
    },
  };
})();

// ============================================
// LUATOOLS MAIN CODE
// ============================================
(function () {
  "use strict";

  // Display-only local rebrand. Keep the legacy name and internal ID for compatibility.
  const INTERNAL_PLUGIN_ID = "luatools";
  const LEGACY_BRAND = "LuaTools";
  const DEFAULT_DISPLAY_BRAND = "Akram's";

  function getDisplayBrand() {
    try {
      const configured =
        window.__LuaToolsSettings &&
        window.__LuaToolsSettings.values &&
        window.__LuaToolsSettings.values.general &&
        window.__LuaToolsSettings.values.general.displayName;
      if (typeof configured === "string") {
        const cleaned = configured.replace(/[\u0000-\u001f\u007f]/g, "").trim();
        if (cleaned) return cleaned.slice(0, 32);
      }
    } catch (_) {}
    return DEFAULT_DISPLAY_BRAND;
  }

  function displayBrandText(value) {
    if (typeof value !== "string") return value;
    const displayBrand = getDisplayBrand();
    return value
      .split(LEGACY_BRAND)
      .join(displayBrand)
      .split(DEFAULT_DISPLAY_BRAND)
      .join(displayBrand);
  }

  let cachedSteamAvatarUrl = "";

  function isAllowedSteamAvatarUrl(source) {
    return (
      typeof source === "string" &&
      /^https:\/\/avatars\.(?:(?:fastly|akamai)\.)?steamstatic\.com\//i.test(
        source,
      )
    );
  }

  function getSteamAvatarUrl() {
    if (isAllowedSteamAvatarUrl(cachedSteamAvatarUrl)) {
      return cachedSteamAvatarUrl;
    }
    const selectors = [
      '#global_actions .user_avatar img',
      '#global_actions [class*="avatar"] img',
      '[data-featuretarget="accountmenu"] img[src*="avatars."]',
    ];
    for (let i = 0; i < selectors.length; i++) {
      const image = document.querySelector(selectors[i]);
      const source = image && (image.currentSrc || image.src);
      if (isAllowedSteamAvatarUrl(source)) {
        cachedSteamAvatarUrl = source;
        return source;
      }
    }
    return "";
  }

  async function fetchSteamAvatarUrl() {
    const existing = getSteamAvatarUrl();
    if (existing) return existing;
    try {
      const accountId = Number(window.g_AccountID);
      if (!Number.isInteger(accountId) || accountId <= 0) return "";
      const response = await fetch(
        `https://steamcommunity.com/miniprofile/${accountId}/json`,
        { credentials: "include" },
      );
      if (!response.ok) return "";
      const profile = await response.json();
      const source = profile && profile.avatar_url;
      if (!isAllowedSteamAvatarUrl(source)) return "";
      cachedSteamAvatarUrl = source;
      return source;
    } catch (_) {
      return "";
    }
  }

  function applySteamAvatar(image, fallbackUrl) {
    if (!image) return;
    image.alt = getDisplayBrand();
    image.style.objectFit = "cover";
    image.style.borderRadius = "50%";
    const update = async function () {
      const avatarUrl = getSteamAvatarUrl();
      if (avatarUrl) {
        image.src = avatarUrl;
        image.dataset.steamAvatar = "1";
        return true;
      }
      if (!image.src && fallbackUrl) image.src = fallbackUrl;
      const fetchedAvatarUrl = await fetchSteamAvatarUrl();
      if (fetchedAvatarUrl && image.isConnected) {
        image.src = fetchedAvatarUrl;
        image.dataset.steamAvatar = "1";
        return true;
      }
      return false;
    };
    void update();
  }

  // Big Picture Mode Detector - Multi-method system for maximum reliability
  function isBigPictureMode() {
    const htmlClasses = document.documentElement.className;
    const userAgent = navigator.userAgent;

    // METHOD 1: HTML Classes
    // Big Picture: 'BasicUI' + 'touch'
    // Normal Mode: 'DesktopUI' (without 'touch')
    const hasBigPictureClass = htmlClasses.includes("BasicUI");
    const hasDesktopClass = htmlClasses.includes("DesktopUI");
    const hasTouchClass = htmlClasses.includes("touch");

    // METHOD 2: User Agent
    // Big Picture: 'Valve Steam Gamepad'
    // Normal Mode: 'Valve Steam Client'
    const isGamepadUA = userAgent.includes("Valve Steam Gamepad");
    const isClientUA = userAgent.includes("Valve Steam Client");

    // Scoring system: each indicator adds points
    let bigPictureScore = 0;

    // BasicUI/DesktopUI class (weight: 3 points - highly reliable)
    if (hasBigPictureClass) bigPictureScore += 3;
    if (hasDesktopClass) bigPictureScore -= 3;

    // User Agent (weight: 2 points - reliable)
    if (isGamepadUA) bigPictureScore += 2;
    if (isClientUA) bigPictureScore -= 2;

    // Touch class (weight: 1 point - additional indicator)
    if (hasTouchClass) bigPictureScore += 1;

    // Positive score = Big Picture, negative/zero = Normal
    const isBigPicture = bigPictureScore > 0;

    return isBigPicture;
  }

  // Detect and save mode at startup
  window.__LUATOOLS_IS_BIG_PICTURE__ = isBigPictureMode();

  // Forward logs to Millennium backend so they appear in the dev console
  function backendLog(message) {
    try {
      if (
        typeof Millennium !== "undefined" &&
        typeof Millennium.callServerMethod === "function"
      ) {
        Millennium.callServerMethod("luatools", "Logger.log", {
          message: String(message),
        });
      }
    } catch (err) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[LuaTools] backendLog failed", err);
      }
    }
  }

  backendLog("LuaTools script loaded");
  backendLog(
    "Mode Detection: " +
      (window.__LUATOOLS_IS_BIG_PICTURE__ ? "BIG PICTURE MODE" : "NORMAL MODE"),
  );
  // anti-spam state
  const logState = {
    missingOnce: false,
    existsOnce: false,
  };
  // click/run debounce state
  const runState = {
    inProgress: false,
    appid: null,
  };

  // Games Database - backend handles caching
  function fetchGamesDatabase() {
    if (
      typeof Millennium === "undefined" ||
      typeof Millennium.callServerMethod !== "function"
    ) {
      return Promise.resolve({});
    }
    return Millennium.callServerMethod("luatools", "GetGamesDatabase", {
      contentScriptQuery: "",
    })
      .then(function (res) {
        var payload = (res && (res.result || res.value)) || res;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch (e) {}
        }
        return payload || {};
      })
      .catch(function (err) {
        console.warn("[LuaTools] Failed to fetch games database", err);
        return {};
      });
  }

  // Fixes - backend handles caching
  function fetchFixes(appid) {
    if (
      typeof Millennium === "undefined" ||
      typeof Millennium.callServerMethod !== "function"
    ) {
      return Promise.resolve(null);
    }
    return Millennium.callServerMethod("luatools", "CheckForFixes", {
      appid: appid,
      contentScriptQuery: "",
    })
      .then(function (res) {
        const payload = typeof res === "string" ? JSON.parse(res) : res;
        return payload && payload.success ? payload : null;
      })
      .catch(function (err) {
        console.warn("[LuaTools] Failed to fetch fixes", err);
        return null;
      });
  }

  // Cache for game names fetched from Steam API
  const steamGameNameCache = {};
  // Track in-flight promises so we don't fire duplicate requests for the same appid
  const steamGameNameInFlight = {};
  // Throttle: max 2 concurrent fetch calls to avoid overwhelming Millennium's network interceptor
  let _steamFetchActive = 0;
  const _steamFetchQueue = [];
  const _STEAM_FETCH_CONCURRENCY = 2;

  function _runSteamFetchQueue() {
    if (_steamFetchActive >= _STEAM_FETCH_CONCURRENCY || _steamFetchQueue.length === 0) return;
    const { appid, resolve, reject } = _steamFetchQueue.shift();
    _steamFetchActive++;
    fetch(
      "https://store.steampowered.com/api/appdetails?appids=" + appid + "&filters=basic"
    )
      .then(function(res) { return res.json(); })
      .then(function(data) {
        let name = null;
        if (data && data[appid] && data[appid].success && data[appid].data && data[appid].data.name) {
          name = data[appid].data.name;
          steamGameNameCache[appid] = name;
        }
        resolve(name);
      })
      .catch(function(err) {
        resolve(null);
      })
      .finally(function() {
        _steamFetchActive--;
        delete steamGameNameInFlight[appid];
        _runSteamFetchQueue();
      });
  }

  /**
   * get game name separately without cached full appid
   * @param {number|string} appid
   * @returns {Promise<string|null>}
   */
  function fetchSteamGameName(appid) {
    if (!appid) return Promise.resolve(null);
    if (steamGameNameCache[appid]) return Promise.resolve(steamGameNameCache[appid]);
    // Deduplicate: return the same promise if already in-flight
    if (steamGameNameInFlight[appid]) return steamGameNameInFlight[appid];

    const promise = new Promise(function(resolve, reject) {
      _steamFetchQueue.push({ appid: appid, resolve: resolve, reject: reject });
      _runSteamFetchQueue();
    });
    steamGameNameInFlight[appid] = promise;
    return promise;
  }

  const TRANSLATION_PLACEHOLDER = "translation missing";

  function applyTranslationBundle(bundle) {
    if (!bundle || typeof bundle !== "object") return;
    const stored = window.__LuaToolsI18n || {};
    if (bundle.language) {
      stored.language = String(bundle.language);
    } else if (!stored.language) {
      stored.language = "en";
    }
    if (bundle.strings && typeof bundle.strings === "object") {
      stored.strings = bundle.strings;
    } else if (!stored.strings) {
      stored.strings = {};
    }
    if (Array.isArray(bundle.locales)) {
      stored.locales = bundle.locales;
    } else if (!Array.isArray(stored.locales)) {
      stored.locales = [];
    }
    stored.ready = true;
    stored.lastFetched = Date.now();
    window.__LuaToolsI18n = stored;
  }

  // Theme definitions (pulled from themes.json; inline only used as fallback)
  const DEFAULT_THEMES = {
    original: {
      name: "Original",
      bgPrimary: "#1b2838",
      bgSecondary: "#2a475e",
      bgTertiary: "rgba(44, 79, 112, 0.86)",
      bgHover: "rgba(68, 112, 153, 0.86)",
      bgContainer: "rgba(40, 74, 102, 0.6)",
      bgContainerGradient: "rgba(40, 74, 102, 0.85), #0b141e",
      accent: "#66c0f4",
      accentLight: "#a4d7f5",
      accentDark: "#4a9ece",
      border: "rgba(102,192,244,0.3)",
      borderHover: "rgba(102,192,244,0.8)",
      text: "#fff",
      textSecondary: "#c7d5e0",
      gradient: "linear-gradient(135deg, #66c0f4 0%, #a4d7f5 100%)",
      gradientLight: "linear-gradient(135deg, #a4d7f5 0%, #7dd4ff 100%)",
      shadow: "rgba(102,192,244,0.4)",
      shadowHover: "rgba(102,192,244,0.6)",
    },
  };

  // Runtime THEMES map - start with fallback, then hydrate from themes.json/backend.
  let THEMES = DEFAULT_THEMES;
  let themesLoaded = false;

  function normalizeThemesPayload(input) {
    try {
      let payload = input;
      if (typeof payload === "string") payload = JSON.parse(payload);
      if (payload && typeof payload === "object") {
        if (Array.isArray(payload.themes)) return payload.themes;
        if (Array.isArray(payload.result)) return payload.result;
        if (payload.result && Array.isArray(payload.result.themes))
          return payload.result.themes;
        if (Array.isArray(payload.value)) return payload.value;
      }
      if (Array.isArray(payload)) return payload;
    } catch (_) {
      /* ignore */
    }
    return [];
  }

  function _applyBackendThemes(themesArray) {
    try {
      const themes = normalizeThemesPayload(themesArray);
      if (!Array.isArray(themes) || themes.length === 0) return;
      const map = {};
      themes.forEach(function (t) {
        if (!t || (!t.value && !t.key)) return;
        const key = t.value || t.key;
        map[key] = Object.assign({}, t, {
          value: key,
          name: t.name || key,
        });
      });
      if (Object.keys(map).length === 0) return;
      // Merge into existing THEMES if themes have been loaded, otherwise start from DEFAULT_THEMES
      THEMES = Object.assign({}, themesLoaded ? THEMES : DEFAULT_THEMES, map);
      themesLoaded = true;
      try {
        ensureLuaToolsStyles();
      } catch (_) {}
    } catch (e) {
      console.warn("Failed to apply backend themes", e);
    }
  }

  function loadThemesFromFile() {
    try {
      return fetch("themes/themes.json", {
        cache: "no-store",
      })
        .then(function (res) {
          if (!res || !res.ok) return null;
          return res.json();
        })
        .then(function (json) {
          if (!json) return null;
          _applyBackendThemes(json);
          return json;
        })
        .catch(function () {
          return null;
        });
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function loadThemesFromBackend() {
    if (
      typeof Millennium === "undefined" ||
      typeof Millennium.callServerMethod !== "function"
    ) {
      return Promise.resolve(null);
    }
    return Millennium.callServerMethod("luatools", "GetThemes", {
      contentScriptQuery: "",
    })
      .then(function (res) {
        try {
          const payload = typeof res === "string" ? JSON.parse(res) : res;
          if (payload && payload.success && payload.themes) {
            _applyBackendThemes(payload.themes);
            return payload.themes;
          }
        } catch (_) {}
        return null;
      })
      .catch(function () {
        return null;
      });
  }

  function loadThemes() {
    return Promise.all([loadThemesFromFile(), loadThemesFromBackend()]).catch(
      function () {
        /* ignore */
      },
    );
  }

  // Trigger load (non-blocking). Keeps DEFAULT_THEMES as a safe fallback.
  const themeLoadPromise = loadThemes();

  function getCurrentThemeKey() {
    try {
      const settings = window.__LuaToolsSettings || {};
      const themeKey = (settings.values || {}).general || {};
      return themeKey.theme || "original";
    } catch (e) {
      return "original";
    }
  }

  function getCurrentTheme() {
    try {
      const themeName = getCurrentThemeKey();
      const theme = THEMES[themeName] || THEMES.original;
      if (!THEMES[themeName]) {
        try {
          backendLog(
            "LuaTools: Theme " +
              themeName +
              " not found in THEMES, using original. Available: " +
              Object.keys(THEMES).join(", "),
          );
        } catch (_) {}
      }
      return theme;
    } catch (e) {
      return THEMES.original;
    }
  }

  function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? [
          parseInt(result[1], 16),
          parseInt(result[2], 16),
          parseInt(result[3], 16),
        ]
      : [102, 192, 244];
  }

  function getThemeColors() {
    const theme = getCurrentTheme();
    const rgb = hexToRgb(theme.accent);
    return {
      modalBg: `linear-gradient(135deg, ${theme.bgPrimary} 0%, ${theme.bgSecondary} 100%)`,
      border: theme.accent,
      borderRgba: theme.border,
      text: theme.text,
      textSecondary: theme.textSecondary,
      accent: theme.accent,
      accentLight: theme.accentLight,
      gradient: theme.gradient,
      gradientLight: theme.gradientLight,
      shadow: theme.shadow,
      shadowHover: theme.shadowHover,
      shadowRgba: theme.shadow.replace("0.4", "0.3"),
      bgContainer: theme.bgContainer,
      bgTertiary: theme.bgTertiary,
      bgHover: theme.bgHover,
      rgbString: rgb.join(","),
    };
  }

  function generateThemeStyles(theme) {
    return `
            /* Force overlay backdrops to follow the active theme (overrides inline styles) */
            .luatools-settings-overlay,
            .luatools-overlay,
            .luatools-fixes-results-overlay,
            .luatools-loading-fixes-overlay,
            .luatools-unfix-overlay,
            .luatools-settings-manager-overlay,
            .luatools-loadedapps-overlay {
                background: rgba(${theme.rgbString}, 0.12) !important;
                backdrop-filter: blur(8px) !important;
            }

            /* Prefer overlay-scoped select rules to override theme CSS files */
            .luatools-settings-overlay select,
            .luatools-settings-manager-overlay select,
            .luatools-overlay select,
            .luatools-fixes-results-overlay select,
            .luatools-loadedapps-overlay select {
                background-color: ${theme.bgTertiary} !important;
                color: ${theme.text} !important;
                border: 1px solid ${theme.border} !important;
                border-radius: 3px !important;
                padding: 6px 8px !important;
                font-size: 14px !important;
            }
            .luatools-settings-overlay select option,
            .luatools-settings-manager-overlay select option,
            .luatools-overlay select option,
            .luatools-fixes-results-overlay select option,
            .luatools-loadedapps-overlay select option {
                background-color: ${theme.bgPrimary} !important;
                color: ${theme.text} !important;
            }
            .luatools-settings-overlay select option:checked,
            .luatools-settings-manager-overlay select option:checked,
            .luatools-overlay select option:checked,
            .luatools-fixes-results-overlay select option:checked,
            .luatools-loadedapps-overlay select option:checked {
                background: ${theme.accent} !important;
                color: ${theme.text} !important;
            }
            .luatools-settings-overlay select:hover,
            .luatools-settings-manager-overlay select:hover,
            .luatools-overlay select:hover,
            .luatools-fixes-results-overlay select:hover,
            .luatools-loadedapps-overlay select:hover {
                border-color: ${theme.borderHover} !important;
            }
            .luatools-settings-overlay select:focus,
            .luatools-settings-manager-overlay select:focus,
            .luatools-overlay select:focus,
            .luatools-fixes-results-overlay select:focus,
            .luatools-loadedapps-overlay select:focus {
                outline: none !important;
                border-color: ${theme.accent} !important;
                box-shadow: 0 0 0 2px ${theme.shadow} !important;
            }
            .luatools-btn {
                padding: 12px 24px;
                background: ${theme.bgSecondary};
                border: 2px solid ${theme.border.replace("0.3", "0.5")};
                border-radius: 12px;
                color: ${theme.text};
                font-size: 15px;
                font-weight: 600;
                text-decoration: none;
                transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                cursor: pointer;
                box-shadow: 0 2px 8px ${theme.shadow};
                letter-spacing: 0.3px;
            }
            .luatools-btn:hover:not([data-disabled="1"]) {
                background: ${theme.bgHover};
                transform: translateY(-2px);
                box-shadow: 0 6px 20px ${theme.shadowHover};
                border-color: ${theme.borderHover};
            }
            .luatools-btn.primary {
                background: ${theme.gradient};
                border-color: ${theme.borderHover.replace("0.8", "0.8")};
                color: ${theme.text};
                font-weight: 700;
                box-shadow: 0 4px 15px ${theme.shadow}, inset 0 1px 0 rgba(255,255,255,0.3);
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            .luatools-btn.primary:hover:not([data-disabled="1"]) {
                background: ${theme.gradientLight};
                transform: translateY(-3px) scale(1.03);
                box-shadow: 0 8px 25px rgba(26, 159, 255, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.4);
            }

            /* Modern Toggle Switch */
            .luatools-toggle-container {
                display: flex;
                align-items: center;
                justify-content: space-between;
                width: 100%;
            }
            .luatools-toggle-label-wrap {
                display: flex;
                flex-direction: column;
                gap: 4px;
                flex: 1;
                margin-right: 20px;
            }
            .luatools-toggle {
                position: relative;
                display: inline-block;
                width: 50px;
                height: 26px;
                flex-shrink: 0;
            }
            .luatools-toggle input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .luatools-slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: rgba(255, 255, 255, 0.1);
                transition: .4s;
                border-radius: 34px;
                border: 1px solid rgba(255, 255, 255, 0.2);
            }
            .luatools-slider:before {
                position: absolute;
                content: "";
                height: 18px;
                width: 18px;
                left: 3px;
                bottom: 3px;
                background-color: #ffffff;
                transition: .4s;
                border-radius: 50%;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
            }
            input:checked + .luatools-slider {
                background-color: #1a9fff;
                border-color: #1a9fff;
            }
            input:checked + .luatools-slider:before {
                transform: translateX(24px);
            }
            .luatools-slider:hover {
                border-color: #1a9fff;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes slideUp {
                from {
                    opacity: 0;
                    transform: scale(0.9);
                }
                to {
                    opacity: 1;
                    transform: scale(1);
                }
            }
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.7; }
            }

            /* Store header button - LuaTools themed icon button */
            button.luatools-header-button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                align-self: center;
                width: 36px;
                height: 36px;
                padding: 0;
                border: 2px solid ${theme.border.replace("0.3", "0.5")};
                border-radius: 4px;
                background: ${theme.bgSecondary};
                color: ${theme.text};
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
                box-shadow: 0 2px 8px ${theme.shadow};
                margin-left: 12px;
            }
            button.luatools-header-button:hover {
                background: ${theme.bgHover};
                transform: translateY(-1px);
                box-shadow: 0 4px 12px ${theme.shadowHover};
                border-color: ${theme.borderHover};
            }
            button.luatools-header-button:focus-visible {
                outline: 2px solid ${theme.accent};
                outline-offset: 2px;
            }
            button.luatools-header-button img,
            button.luatools-header-button svg {
                height: 16px;
                width: 16px;
            }
        `;
  }

  function ensureThemeStylesheet(themeKey) {
    const id = "luatools-theme-css";
    const href = "themes/" + themeKey + ".css";
    const link = document.getElementById(id);
    if (link) {
      const currentTheme = link.getAttribute("data-theme");
      if (currentTheme === themeKey) return;
      link.href = href;
      link.setAttribute("data-theme", themeKey);
      return;
    }
    try {
      const el = document.createElement("link");
      el.id = id;
      el.rel = "stylesheet";
      el.href = href;
      el.setAttribute("data-theme", themeKey);
      document.head.appendChild(el);
    } catch (err) {
      backendLog("LuaTools: Theme CSS injection failed: " + err);
    }
  }

  function ensureLuaToolsStyles() {
    const styleEl = document.getElementById("luatools-styles");
    const themeKey = getCurrentThemeKey();
    const theme = getCurrentTheme();
    const styles =
      generateThemeStyles(theme) +
      `
        .apphub_OtherSiteInfo,
        .steamdb-buttons,
        [data-steamdb-buttons] {
          display: flex !important;
          flex-direction: row !important;
          direction: ltr !important;
          flex-wrap: wrap !important;
          gap: 4px !important;
        }
        #luatools-fixes-link { order: 10 !important; }
        .luatools-button { order: 20 !important; }
        #luatools-downgrade-link { order: 30 !important; }
        #luatools-online-fix-link { order: 40 !important; }
        #luatools-game3rb-link { order: 50 !important; }
        #luatools-steamdb-link {
          order: 60 !important;
        }
        .apphub_OtherSiteInfo a[href*="pcgamingwiki.com"],
        .steamdb-buttons a[href*="pcgamingwiki.com"],
        [data-steamdb-buttons] a[href*="pcgamingwiki.com"],
        .apphub_OtherSiteInfo a[href*="steamdb.info/app/"],
        .steamdb-buttons a[href*="steamdb.info/app/"],
        [data-steamdb-buttons] a[href*="steamdb.info/app/"],
        .apphub_OtherSiteInfo a[href*="steamcommunity.com/app/"],
        .steamdb-buttons a[href*="steamcommunity.com/app/"],
        [data-steamdb-buttons] a[href*="steamcommunity.com/app/"] {
          display: none !important;
        }
      `;

    try {
      ensureThemeStylesheet(themeKey);
    } catch (_) {}

    if (styleEl) {
      styleEl.textContent = styles;
    } else {
      try {
        const style = document.createElement("style");
        style.id = "luatools-styles";
        style.textContent = styles;
        document.head.appendChild(style);
      } catch (err) {
        backendLog("LuaTools: Styles injection failed: " + err);
      }
    }
  }

  function ensureFontAwesome() {
    if (document.getElementById("luatools-fontawesome")) return;
    try {
      const link = document.createElement("link");
      link.id = "luatools-fontawesome";
      link.rel = "stylesheet";
      link.href =
        "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css";
      link.integrity =
        "sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA==";
      link.crossOrigin = "anonymous";
      link.referrerPolicy = "no-referrer";
      document.head.appendChild(link);
    } catch (err) {
      backendLog("LuaTools: Font Awesome injection failed: " + err);
    }
  }

  function showCustomApiModal(onSuccess) {
    try {
      const old = document.querySelector(".luatools-custom-api-overlay");
      if (old) old.remove();
    } catch (_) {}

    ensureLuaToolsStyles();
    ensureFontAwesome();

    const overlay = document.createElement("div");
    overlay.className = "luatools-custom-api-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const colors = getThemeColors();
    modal.style.cssText = `background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:500px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const title = document.createElement("div");
    title.style.cssText = `font-size:22px;font-weight:600;margin-bottom:8px;color:${colors.text};`;
    title.textContent = lt("Add Custom API");

    const desc = document.createElement("div");
    desc.style.cssText = `font-size:14px;color:${colors.textSecondary};margin-bottom:20px;line-height:1.5;`;
    desc.innerHTML = lt(
      "Enter the custom API details below. You MUST include <code>&lt;appid&gt;</code> in the URL where the Game ID goes, and optionally <code>&lt;apikey&gt;</code> if an API key is required.",
    );

    const body = document.createElement("div");
    body.style.cssText =
      "display:flex;flex-direction:column;gap:16px;margin-bottom:24px;";

    function createInputGroup(labelText, placeholder, type = "text") {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";
      const lbl = document.createElement("label");
      lbl.style.cssText = `font-size:13px;font-weight:600;color:${colors.text};`;
      lbl.textContent = labelText;
      const input = document.createElement("input");
      input.type = type;
      input.placeholder = placeholder;
      input.style.cssText = `width:100%;padding:10px 12px;background:rgba(0,0,0,0.2);border:1px solid ${colors.borderRgba};border-radius:8px;color:${colors.text};font-size:14px;outline:none;transition:border-color 0.2s;box-sizing:border-box;`;
      input.onfocus = () => (input.style.borderColor = colors.accent);
      input.onblur = () => (input.style.borderColor = colors.borderRgba);
      wrap.appendChild(lbl);
      wrap.appendChild(input);
      return { wrap, input };
    }

    const nameField = createInputGroup("API Name", "My Custom API");
    const urlField = createInputGroup(
      "API URL",
      "https://example.com/download?id=<appid>&key=<apikey>",
    );

    body.appendChild(nameField.wrap);
    body.appendChild(urlField.wrap);

    const toggleWrap = document.createElement("div");
    toggleWrap.style.cssText =
      "display:flex;align-items:center;gap:10px;margin-top:8px;cursor:pointer;";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.style.cssText = `width:16px;height:16px;accent-color:${colors.accent};cursor:pointer;`;

    const toggleLabel = document.createElement("span");
    toggleLabel.style.cssText = `font-size:14px;color:${colors.text};`;
    toggleLabel.textContent = lt("Require API Key");

    toggleWrap.appendChild(checkbox);
    toggleWrap.appendChild(toggleLabel);

    const apiKeyField = createInputGroup("API Key", "Enter your API key here");
    apiKeyField.wrap.style.display = "none";

    toggleWrap.onclick = function (e) {
      if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
      apiKeyField.wrap.style.display = checkbox.checked ? "flex" : "none";
    };

    body.appendChild(toggleWrap);
    body.appendChild(apiKeyField.wrap);

    const btnRow = document.createElement("div");
    btnRow.style.cssText =
      "display:flex;justify-content:flex-end;gap:12px;margin-top:24px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = lt("Cancel");
    cancelBtn.style.cssText = `padding:8px 16px;background:transparent;border:1px solid ${colors.borderRgba};border-radius:8px;color:${colors.text};font-size:14px;font-weight:500;cursor:pointer;transition:all 0.2s ease;`;
    cancelBtn.onmouseover = () =>
      (cancelBtn.style.background = `rgba(255,255,255,0.1)`);
    cancelBtn.onmouseout = () => (cancelBtn.style.background = "transparent");
    cancelBtn.onclick = () => overlay.remove();

    const saveBtn = document.createElement("button");
    saveBtn.textContent = lt("Save API");
    saveBtn.style.cssText = `padding:8px 24px;background:${colors.accent};border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:transform 0.1s, filter 0.2s;`;
    saveBtn.onmouseover = () => (saveBtn.style.filter = "brightness(1.1)");
    saveBtn.onmouseout = () => (saveBtn.style.filter = "none");
    saveBtn.onmousedown = () => (saveBtn.style.transform = "scale(0.96)");
    saveBtn.onmouseup = () => (saveBtn.style.transform = "scale(1)");

    saveBtn.onclick = function () {
      const name = nameField.input.value.trim();
      const url = urlField.input.value.trim();
      const needsKey = checkbox.checked;
      const apiKey = apiKeyField.input.value.trim();

      if (!name || !url) {
        ShowLuaToolsAlert("Error", lt("Name and URL are required."));
        return;
      }

      try {
        const dummyUrl = url
          .replace("<appid>", "123")
          .replace("<apikey>", "abc");
        const parsedUrl = new URL(dummyUrl);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          ShowLuaToolsAlert(
            "Error",
            lt("URL must start with http:// or https://"),
          );
          return;
        }
      } catch (e) {
        ShowLuaToolsAlert("Error", lt("Please enter a valid URL."));
        return;
      }

      if (!url.includes("<appid>")) {
        ShowLuaToolsAlert("Error", lt("URL must contain <appid> placeholder."));
        return;
      }
      if (needsKey && !url.includes("<apikey>")) {
        ShowLuaToolsAlert(
          "Error",
          lt("URL must contain <apikey> when Require API Key is checked."),
        );
        return;
      }
      if (needsKey && !apiKey) {
        ShowLuaToolsAlert("Error", lt("Please enter an API Key."));
        return;
      }

      saveBtn.textContent = lt("Saving...");
      saveBtn.disabled = true;
      saveBtn.style.opacity = "0.7";

      Millennium.callServerMethod("luatools", "AddCustomApi", {
        name: name,
        url: url,
        api_key: needsKey ? apiKey : "",
        contentScriptQuery: "",
      }).then(function (res) {
        try {
          const payload = typeof res === "string" ? JSON.parse(res) : res;
          if (payload && payload.success) {
            overlay.remove();
            if (typeof onSuccess === "function") {
              onSuccess();
            } else {
              ShowLuaToolsAlert("Success", lt("Custom API added successfully!"));
            }
          } else {
            saveBtn.textContent = lt("Save API");
            saveBtn.disabled = false;
            saveBtn.style.opacity = "1";
            ShowLuaToolsAlert("Error", payload.error || "Failed to save API.");
          }
        } catch (e) {
          saveBtn.textContent = lt("Save API");
          saveBtn.disabled = false;
          saveBtn.style.opacity = "1";
          ShowLuaToolsAlert("Error", e.toString());
        }
      });
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);

    modal.appendChild(title);
    modal.appendChild(desc);
    modal.appendChild(body);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function showSettingsPopup() {
    if (
      document.querySelector(".luatools-settings-overlay") ||
      settingsMenuPending
    )
      return;
    settingsMenuPending = true;
    ensureTranslationsLoaded(false)
      .catch(function () {
        return null;
      })
      .finally(function () {
        settingsMenuPending = false;
        if (document.querySelector(".luatools-settings-overlay")) return;

        try {
          const d = document.querySelector(".luatools-overlay");
          if (d) d.remove();
        } catch (_) {}
        ensureLuaToolsStyles();
        ensureFontAwesome();

        const overlay = document.createElement("div");
        overlay.className = "luatools-settings-overlay";
        overlay.style.cssText =
          "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;";

        const modal = document.createElement("div");
        const colors = getThemeColors();
        modal.style.cssText = `position:relative;background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:460px;padding:20px 24px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

        const header = document.createElement("div");
        header.style.cssText = `display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid ${colors.borderRgba};`;

        const title = document.createElement("div");
        title.style.cssText = `display:flex;align-items:center;gap:10px;font-size:22px;color:${colors.text};font-weight:600;`;
        const titleIcon = document.createElement("img");
        titleIcon.style.cssText =
          "width:24px;height:24px;border-radius:50%;object-fit:cover;";
        applySteamAvatar(titleIcon, "LuaTools/luatools-icon.png");
        titleIcon.onerror = function () {
          this.style.display = "none";
        };
        const titleText = document.createElement("span");
        titleText.textContent = t("menu.title", "LuaTools · Menu");
        title.appendChild(titleIcon);
        title.appendChild(titleText);

        const iconButtons = document.createElement("div");
        iconButtons.style.cssText = "display:flex;gap:12px;";

        function createIconButton(id, iconClass, titleKey, titleFallback) {
          const btn = document.createElement("a");
          btn.id = id;
          btn.href = "#";
          const btnColors = getThemeColors();
          btn.style.cssText = `display:flex;align-items:center;justify-content:center;width:40px;height:40px;background:rgba(${btnColors.rgbString},0.1);border:1px solid ${btnColors.borderRgba};border-radius:10px;color:${btnColors.accent};font-size:18px;text-decoration:none;transition:all 0.3s ease;cursor:pointer;`;
          btn.innerHTML = '<i class="fa-solid ' + iconClass + '"></i>';
          btn.title = t(titleKey, titleFallback);
          btn.onmouseover = function () {
            this.style.background = `rgba(${btnColors.rgbString},0.25)`;
            this.style.transform = "translateY(-2px) scale(1.05)";
            this.style.boxShadow = `0 8px 16px ${btnColors.shadowRgba}`;
            this.style.borderColor = btnColors.accent;
          };
          btn.onmouseout = function () {
            this.style.background = `rgba(${btnColors.rgbString},0.1)`;
            this.style.transform = "translateY(0) scale(1)";
            this.style.boxShadow = "none";
            this.style.borderColor = btnColors.borderRgba;
          };
          iconButtons.appendChild(btn);
          return btn;
        }

        const body = document.createElement("div");
        body.style.cssText =
          "font-size:14px;line-height:1.6;margin-bottom:12px;";

        // Add mouse mode tip for Big Picture
        if (window.__LUATOOLS_IS_BIG_PICTURE__) {
          const tip = document.createElement("div");
          tip.style.cssText =
            "background:rgba(102,192,244,0.15);border-left:3px solid #66c0f4;padding:12px 16px;border-radius:6px;font-size:13px;color:#c7d5e0;margin-bottom:16px;line-height:1.5;";
          tip.innerHTML =
            '<i class="fa-solid fa-info-circle" style="margin-right:8px;color:#66c0f4;"></i>' +
            t(
              "bigpicture.mouseTip",
              "To use mouse mode in Steam: Guide Button + Right Joystick, click with RB",
            );
          body.appendChild(tip);
        }

        const container = document.createElement("div");
        container.style.cssText =
          "margin-top:16px;display:flex;flex-direction:column;gap:12px;align-items:stretch;";

        function createCardButton(id, key, fallback, iconClass) {
          const btn = document.createElement("a");
          btn.id = id;
          btn.href = "#";
          const btnColors = getThemeColors();
          btn.style.cssText = `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;flex:1;background:rgba(${btnColors.rgbString},0.06);border:1px solid ${btnColors.borderRgba};border-radius:12px;color:${btnColors.text};font-size:11px;font-weight:500;text-decoration:none;transition:all 0.2s ease;cursor:pointer;text-align:center;padding:14px 6px;min-width:0;`;
          const iconHtml = iconClass
            ? '<i class="fa-solid ' +
              iconClass +
              '" style="font-size:22px;color:' +
              btnColors.accent +
              ';"></i>'
            : "";
          const textSpan =
            '<span style="text-align:center;line-height:1.3;">' +
            t(key, fallback) +
            "</span>";
          btn.innerHTML = iconHtml + textSpan;
          btn.onmouseover = function () {
            const c = getThemeColors();
            this.style.background = `rgba(${c.rgbString},0.15)`;
            this.style.transform = "translateY(-2px)";
            this.style.boxShadow = `0 8px 20px ${c.shadow.replace("0.4", "0.15")}`;
            this.style.borderColor = c.accent;
          };
          btn.onmouseout = function () {
            const c = getThemeColors();
            this.style.background = `rgba(${c.rgbString},0.06)`;
            this.style.transform = "translateY(0)";
            this.style.boxShadow = "none";
            this.style.borderColor = c.borderRgba;
          };
          return btn;
        }

        const settingsManagerBtn = createIconButton(
          "lt-settings-open-manager",
          "fa-gear",
          "menu.settings",
          "Settings",
        );
        const closeBtn = createIconButton(
          "lt-settings-close",
          "fa-xmark",
          "settings.close",
          "Close",
        );

        // Check if we are on a game page
        const isGamePage = window.location.href.includes("/app/");

        const removeBtn = document.createElement("a");
        removeBtn.id = "lt-settings-remove-lua";
        removeBtn.href = "#";
        const removeBtnColors = getThemeColors();
        removeBtn.style.cssText = `display:none;align-items:center;justify-content:center;gap:8px;padding:10px 16px;background:rgba(${removeBtnColors.rgbString},0.06);border:1px solid ${removeBtnColors.borderRgba};border-radius:10px;color:${removeBtnColors.textSecondary};font-size:13px;font-weight:500;text-decoration:none;transition:all 0.2s ease;cursor:pointer;text-align:center;`;
        removeBtn.innerHTML =
          '<i class="fa-solid fa-trash-can" style="font-size:13px;"></i><span>' +
          t("menu.removeLuaTools", "Remove via LuaTools") +
          "</span>";
        removeBtn.onmouseover = function () {
          const c = getThemeColors();
          this.style.background = `rgba(${c.rgbString},0.15)`;
          this.style.borderColor = c.accent;
        };
        removeBtn.onmouseout = function () {
          const c = getThemeColors();
          this.style.background = `rgba(${c.rgbString},0.06)`;
          this.style.borderColor = c.borderRgba;
        };
        container.appendChild(removeBtn);

        // Card button grid
        const cardGrid = document.createElement("div");
        cardGrid.style.cssText =
          "display:flex;gap:10px;justify-content:center;";

        // The online-fix action is shown directly on game pages now.
        const fixesMenuBtn = null;

        body.appendChild(container);

        header.appendChild(title);
        header.appendChild(iconButtons);
        modal.appendChild(header);
        modal.appendChild(body);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Re-scan elements for gamepad navigation
        setTimeout(function () {
          if (window.GamepadNav) {
            window.GamepadNav.scanElements();
          }
        }, 150);

        if (closeBtn) {
          closeBtn.addEventListener("click", function (e) {
            e.preventDefault();
            overlay.remove();
          });
        }

        if (settingsManagerBtn) {
          // This is the icon button now
          settingsManagerBtn.addEventListener("click", function (e) {
            e.preventDefault();
            try {
              overlay.remove();
            } catch (_) {}
            showSettingsManagerPopup(false, showSettingsPopup);
          });
        }

        if (fixesMenuBtn) {
          fixesMenuBtn.addEventListener("click", function (e) {
            e.preventDefault();
            try {
              const match =
                window.location.href.match(
                  /https:\/\/store\.steampowered\.com\/app\/(\d+)/,
                ) ||
                window.location.href.match(
                  /https:\/\/steamcommunity\.com\/app\/(\d+)/,
                );
              const appid = match
                ? parseInt(match[1], 10)
                : window.__LuaToolsCurrentAppId || NaN;
              if (isNaN(appid)) {
                try {
                  overlay.remove();
                } catch (_) {}
                const errText = t(
                  "menu.error.noAppId",
                  "Could not determine game AppID",
                );
                ShowLuaToolsAlert("LuaTools", errText);
                return;
              }

              Millennium.callServerMethod("luatools", "GetGameInstallPath", {
                appid,
                contentScriptQuery: "",
              })
                .then(function (pathRes) {
                  try {
                    let isGameInstalled = false;
                    const pathPayload =
                      typeof pathRes === "string"
                        ? JSON.parse(pathRes)
                        : pathRes;
                    if (
                      pathPayload &&
                      pathPayload.success &&
                      pathPayload.installPath
                    ) {
                      isGameInstalled = true;
                      window.__LuaToolsGameInstallPath =
                        pathPayload.installPath;
                    }
                    window.__LuaToolsGameIsInstalled = isGameInstalled;
                    try {
                      overlay.remove();
                    } catch (_) {}
                    showFixesLoadingPopupAndCheck(appid);
                  } catch (err) {
                    backendLog("LuaTools: GetGameInstallPath error: " + err);
                    try {
                      overlay.remove();
                    } catch (_) {}
                  }
                })
                .catch(function () {
                  try {
                    overlay.remove();
                  } catch (_) {}
                  const errorText = t(
                    "menu.error.getPath",
                    "Error getting game path",
                  );
                  ShowLuaToolsAlert("LuaTools", errorText);
                });
            } catch (err) {
              backendLog("LuaTools: Fixes Menu button error: " + err);
            }
          });
        }

        try {
          const match =
            window.location.href.match(
              /https:\/\/store\.steampowered\.com\/app\/(\d+)/,
            ) ||
            window.location.href.match(
              /https:\/\/steamcommunity\.com\/app\/(\d+)/,
            );
          const appid = match
            ? parseInt(match[1], 10)
            : window.__LuaToolsCurrentAppId || NaN;
          if (
            !isNaN(appid) &&
            typeof Millennium !== "undefined" &&
            typeof Millennium.callServerMethod === "function"
          ) {
            Millennium.callServerMethod("luatools", "HasLuaToolsForApp", {
              appid,
              contentScriptQuery: "",
            }).then(function (res) {
              try {
                const payload = typeof res === "string" ? JSON.parse(res) : res;
                const exists = !!(
                  payload &&
                  payload.success &&
                  payload.exists === true
                );
                if (exists) {
                  const doDelete = function () {
                    try {
                      Millennium.callServerMethod(
                        "luatools",
                        "DeleteLuaToolsForApp",
                        {
                          appid,
                          contentScriptQuery: "",
                        },
                      )
                        .then(function () {
                          try {
                            window.__LuaToolsButtonInserted = false;
                            window.__LuaToolsPresenceCheckInFlight = false;
                            window.__LuaToolsPresenceCheckAppId = undefined;
                            addLuaToolsButton();
                            const successText = t(
                              "menu.remove.success",
                              "LuaTools removed for this app.",
                            );
                            ShowLuaToolsAlert("LuaTools", successText);
                          } catch (err) {
                            backendLog(
                              "LuaTools: post-delete cleanup failed: " + err,
                            );
                          }
                        })
                        .catch(function (err) {
                          const failureText = t(
                            "menu.remove.failure",
                            "Failed to remove LuaTools.",
                          );
                          const errMsg =
                            err && err.message ? err.message : failureText;
                          ShowLuaToolsAlert("LuaTools", errMsg);
                        });
                    } catch (err) {
                      backendLog("LuaTools: doDelete failed: " + err);
                    }
                  };

                  removeBtn.style.display = "flex";
                  removeBtn.onclick = function (e) {
                    e.preventDefault();
                    try {
                      overlay.remove();
                    } catch (_) {}
                    const confirmMessage = t(
                      "menu.remove.confirm",
                      "Remove via LuaTools for this game?",
                    );
                    showLuaToolsConfirm(
                      "LuaTools",
                      confirmMessage,
                      function () {
                        doDelete();
                      },
                      function () {
                        try {
                          showSettingsPopup();
                        } catch (_) {}
                      },
                    );
                  };
                } else {
                  removeBtn.style.display = "none";
                }
              } catch (_) {}
            });
          }
        } catch (_) {}
      });
  }

  function ensureTranslationsLoaded(forceRefresh, preferredLanguage) {
    try {
      if (
        !forceRefresh &&
        window.__LuaToolsI18n &&
        window.__LuaToolsI18n.ready
      ) {
        return Promise.resolve(window.__LuaToolsI18n);
      }
      if (
        typeof Millennium === "undefined" ||
        typeof Millennium.callServerMethod !== "function"
      ) {
        window.__LuaToolsI18n = window.__LuaToolsI18n || {
          language: "ar",
          locales: [],
          strings: {},
          ready: false,
        };
        return Promise.resolve(window.__LuaToolsI18n);
      }
      const settingsVals =
        ((window.__LuaToolsSettings || {}).values || {}).general || {};
      let targetLanguage =
        typeof preferredLanguage === "string" && preferredLanguage
          ? preferredLanguage
          : "";
      if (!targetLanguage) {
        targetLanguage =
          settingsVals.language ||
          (window.__LuaToolsI18n && window.__LuaToolsI18n.language) ||
          "ar";
      }
      return Millennium.callServerMethod("luatools", "GetTranslations", {
        language: targetLanguage,
        contentScriptQuery: "",
      })
        .then(function (res) {
          const payload = typeof res === "string" ? JSON.parse(res) : res;
          if (!payload || payload.success !== true || !payload.strings) {
            throw new Error("Invalid translation payload");
          }
          applyTranslationBundle(payload);
          // Update button text after translations are loaded
          updateButtonTranslations();
          return window.__LuaToolsI18n;
        })
        .catch(function (err) {
          backendLog("LuaTools: translation load failed: " + err);
          window.__LuaToolsI18n = window.__LuaToolsI18n || {
            language: "ar",
            locales: [],
            strings: {},
            ready: false,
          };
          return window.__LuaToolsI18n;
        });
    } catch (err) {
      backendLog("LuaTools: ensureTranslationsLoaded error: " + err);
      window.__LuaToolsI18n = window.__LuaToolsI18n || {
        language: "ar",
        locales: [],
        strings: {},
        ready: false,
      };
      return Promise.resolve(window.__LuaToolsI18n);
    }
  }

  function translateText(key, fallback) {
    if (!key) {
      return displayBrandText(
        typeof fallback !== "undefined" ? fallback : "",
      );
    }
    try {
      const store = window.__LuaToolsI18n;
      if (
        store &&
        store.strings &&
        Object.prototype.hasOwnProperty.call(store.strings, key)
      ) {
        const value = store.strings[key];
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed && trimmed.toLowerCase() !== TRANSLATION_PLACEHOLDER) {
            return displayBrandText(value);
          }
        }
      }
    } catch (_) {}
    return displayBrandText(
      typeof fallback !== "undefined" ? fallback : key,
    );
  }

  function t(key, fallback) {
    return translateText(key, fallback);
  }

  function lt(text) {
    return t(text, text);
  }

  // Translations are loaded by fetchSettingsConfig() in onFrontendReady — no separate preload needed.

  function askRestartConfirmation() {
    showLuaToolsConfirm(
      getDisplayBrand(),
      lt("Restart Steam now?"),
      function () {
        try {
          Millennium.callServerMethod("luatools", "RestartSteam", {
            contentScriptQuery: "",
          })
            .then(function (res) {
              const payload = typeof res === "string" ? JSON.parse(res) : res;
              if (!payload || payload.success !== true) {
                ShowLuaToolsAlert(
                  getDisplayBrand(),
                  lt("Could not start the Steam restart helper."),
                );
              }
            })
            .catch(function () {
              ShowLuaToolsAlert(
                getDisplayBrand(),
                lt("Could not start the Steam restart helper."),
              );
            });
        } catch (_) {
          ShowLuaToolsAlert(
            getDisplayBrand(),
            lt("Could not start the Steam restart helper."),
          );
        }
      },
      function () {
        /* Cancel - do nothing */
      },
    );
  }

  let settingsMenuPending = false;

  // Helper: show a Steam-style popup with a 10s loading bar (custom UI)
  function showTestPopup() {
    // Avoid duplicates
    if (document.querySelector(".luatools-overlay")) return;
    // Close settings popup if open so modals don't overlap
    try {
      const s = document.querySelector(".luatools-settings-overlay");
      if (s) s.remove();
    } catch (_) {}

    ensureLuaToolsStyles();
    ensureFontAwesome();
    const overlay = document.createElement("div");
    overlay.className = "luatools-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const colors = getThemeColors();
    modal.style.cssText = `background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:520px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const title = document.createElement("div");
    const titleColors = getThemeColors();
    title.style.cssText = `display:flex;align-items:center;gap:10px;font-size:20px;color:${titleColors.text};margin-bottom:16px;font-weight:600;`;
    title.className = "luatools-title";
    const dlTitleIcon = document.createElement("i");
    dlTitleIcon.className = "fa-solid fa-cloud-arrow-down";
    dlTitleIcon.style.cssText = `color:${titleColors.accent};font-size:20px;`;
    title.appendChild(dlTitleIcon);
    const dlTitleText = document.createElement("span");
    dlTitleText.textContent = lt("Select Download Source");
    title.appendChild(dlTitleText);

    // API list container
    const apiListContainer = document.createElement("div");
    apiListContainer.className = "luatools-api-list";
    apiListContainer.style.cssText = "margin-bottom:16px;";

    // Placeholder while loading APIs
    const loadingItem = document.createElement("div");
    loadingItem.style.cssText = `text-align:center;padding:10px;color:${colors.textSecondary};font-size:13px;`;
    loadingItem.textContent = lt("Loading APIs...");
    apiListContainer.appendChild(loadingItem);

    // Load APIs dynamically from backend
    if (
      typeof Millennium !== "undefined" &&
      typeof Millennium.callServerMethod === "function"
    ) {
      Millennium.callServerMethod("luatools", "GetApiList", {
        contentScriptQuery: "",
      })
        .then(function (res) {
          try {
            const payload = typeof res === "string" ? JSON.parse(res) : res;
            if (
              payload &&
              payload.success &&
              payload.apis &&
              Array.isArray(payload.apis)
            ) {
              // Clear loading message
              apiListContainer.innerHTML = "";

              // Create API items
              payload.apis.forEach((api, index) => {
                const apiItem = document.createElement("div");
                apiItem.className = `luatools-api-item luatools-api-${index}`;
                apiItem.setAttribute("data-api-name", api.name);
                apiItem.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin-bottom:8px;background:rgba(${colors.rgbString},0.1);border:1px solid ${colors.borderRgba};border-radius:6px;transition:all 0.2s;`;

                const apiName = document.createElement("div");
                apiName.className = "luatools-api-name";
                apiName.style.cssText = `font-size:14px;color:${colors.textSecondary};font-weight:500;`;
                apiName.textContent = api.name;

                const apiStatus = document.createElement("div");
                apiStatus.className = "luatools-api-status";
                apiStatus.style.cssText = `font-size:14px;color:${colors.textSecondary};display:flex;align-items:center;gap:6px;`;
                apiStatus.innerHTML =
                  "<span>" +
                  lt("Waiting…") +
                  "</span>" +
                  '<i class="fa-solid fa-spinner" style="animation: spin 1.5s linear infinite;"></i>';

                apiItem.appendChild(apiName);
                apiItem.appendChild(apiStatus);
                apiListContainer.appendChild(apiItem);
              });
            }
          } catch (err) {
            backendLog("Failed to parse API list: " + err);
          }
        })
        .catch(function (err) {
          backendLog("Failed to load API list: " + err);
        });
    }

    const body = document.createElement("div");
    body.style.cssText = `display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;line-height:1.4;margin-bottom:12px;color:${colors.textSecondary};`;
    body.className = "luatools-status";
    body.innerHTML =
      '<i class="fa-solid fa-spinner" style="font-size:14px;animation: spin 1.5s linear infinite;"></i><span>' +
      lt("Checking availability…") +
      "</span>";

    const progressWrap = document.createElement("div");
    progressWrap.style.cssText = `background:rgba(0,0,0,0.3);height:20px;border-radius:4px;overflow:hidden;position:relative;display:none;border:1px solid ${colors.border};margin-top:12px;`;
    progressWrap.className = "luatools-progress-wrap";
    const progressBar = document.createElement("div");
    progressBar.style.cssText = `height:100%;width:0%;background:${colors.gradient};transition:width 0.3s ease;box-shadow:0 0 10px ${colors.shadow};`;
    progressBar.className = "luatools-progress-bar";
    progressWrap.appendChild(progressBar);

    const progressInfo = document.createElement("div");
    progressInfo.style.cssText = `display:none;margin-top:8px;font-size:12px;color:${colors.textSecondary};`;
    progressInfo.className = "luatools-progress-info";

    const percent = document.createElement("span");
    percent.className = "luatools-percent";
    percent.textContent = "0%";

    const downloadSize = document.createElement("span");
    downloadSize.className = "luatools-download-size";
    downloadSize.style.cssText = "margin-left:12px;";
    downloadSize.textContent = "";

    progressInfo.appendChild(percent);
    progressInfo.appendChild(downloadSize);

    const btnRow = document.createElement("div");
    btnRow.style.cssText =
      "margin-top:20px;display:flex;gap:8px;justify-content:center;";
    const cancelBtn = document.createElement("a");
    cancelBtn.className = "luatools-btn luatools-cancel-btn";
    cancelBtn.style.cssText =
      "display:none;align-items:center;justify-content:center;text-align:center;";
    cancelBtn.innerHTML = `<span>${lt("Cancel")}</span>`;
    cancelBtn.href = "#";
    cancelBtn.onclick = function (e) {
      e.preventDefault();
      cancelOperation();
    };
    const hideBtn = document.createElement("a");
    hideBtn.className = "luatools-btn luatools-hide-btn";
    hideBtn.style.cssText =
      "display:flex;align-items:center;justify-content:center;text-align:center;";
    hideBtn.innerHTML = `<span>${lt("Hide")}</span>`;
    hideBtn.href = "#";
    hideBtn.onclick = function (e) {
      e.preventDefault();
      cleanup();
    };
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(hideBtn);

    modal.appendChild(title);
    modal.appendChild(apiListContainer);
    modal.appendChild(body);
    modal.appendChild(progressWrap);
    modal.appendChild(progressInfo);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);

    function cleanup() {
      overlay.remove();
    }

    function cancelOperation() {
      // Call backend to cancel the operation
      try {
        const match =
          window.location.href.match(
            /https:\/\/store\.steampowered\.com\/app\/(\d+)/,
          ) ||
          window.location.href.match(
            /https:\/\/steamcommunity\.com\/app\/(\d+)/,
          );
        const appid = match
          ? parseInt(match[1], 10)
          : window.__LuaToolsCurrentAppId || NaN;
        if (
          !isNaN(appid) &&
          typeof Millennium !== "undefined" &&
          typeof Millennium.callServerMethod === "function"
        ) {
          Millennium.callServerMethod("luatools", "CancelAddViaLuaTools", {
            appid,
            contentScriptQuery: "",
          });
        }
      } catch (_) {}
      // Update UI to show cancelled
      const status = overlay.querySelector(".luatools-status");
      if (status) status.textContent = lt("Cancelled");
      const cancelBtn = overlay.querySelector(".luatools-cancel-btn");
      if (cancelBtn) cancelBtn.style.display = "none";
      const hideBtn = overlay.querySelector(".luatools-hide-btn");
      if (hideBtn) hideBtn.innerHTML = `<span>${lt("Close")}</span>`;
      // Hide progress UI
      const wrap = overlay.querySelector(".luatools-progress-wrap");
      const progressInfo = overlay.querySelector(".luatools-progress-info");
      if (wrap) wrap.style.display = "none";
      if (progressInfo) progressInfo.style.display = "none";
      // Reset run state
      runState.inProgress = false;
      runState.appid = null;
    }
  }

  // Fixes Results popup
  function showFixesResultsPopup(data, isGameInstalled) {
    if (document.querySelector(".luatools-fixes-results-overlay")) return;
    // Close other popups
    try {
      const d = document.querySelector(".luatools-overlay");
      if (d) d.remove();
    } catch (_) {}
    try {
      const s = document.querySelector(".luatools-settings-overlay");
      if (s) s.remove();
    } catch (_) {}
    try {
      const f = document.querySelector(".luatools-fixes-results-overlay");
      if (f) f.remove();
    } catch (_) {}
    try {
      const l = document.querySelector(".luatools-loading-fixes-overlay");
      if (l) l.remove();
    } catch (_) {}

    ensureLuaToolsStyles();
    ensureFontAwesome();
    const overlay = document.createElement("div");
    overlay.className = "luatools-fixes-results-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const colors = getThemeColors();
    modal.style.cssText = `position:relative;background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:640px;max-height:80vh;display:flex;flex-direction:column;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const header = document.createElement("div");
    header.style.cssText = `flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid ${colors.borderRgba};`;

    const title = document.createElement("div");
    title.style.cssText = `display:flex;align-items:center;gap:10px;font-size:22px;color:${colors.text};font-weight:600;`;
    const titleIcon = document.createElement("i");
    titleIcon.className = "fa-solid fa-wrench";
    titleIcon.style.cssText = `color:${colors.accent};font-size:20px;`;
    const titleText = document.createElement("span");
    titleText.textContent = lt("LuaTools · Fixes Menu");
    title.appendChild(titleIcon);
    title.appendChild(titleText);

    const iconButtons = document.createElement("div");
    iconButtons.style.cssText = "display:flex;gap:12px;";

    function createIconButton(id, iconClass, titleKey, titleFallback) {
      const btn = document.createElement("a");
      btn.id = id;
      btn.href = "#";
      const btnColors = getThemeColors();
      btn.style.cssText = `display:flex;align-items:center;justify-content:center;width:40px;height:40px;background:rgba(${btnColors.rgbString},0.1);border:1px solid ${btnColors.borderRgba};border-radius:10px;color:${btnColors.accent};font-size:18px;text-decoration:none;transition:all 0.3s ease;cursor:pointer;`;
      btn.innerHTML = '<i class="fa-solid ' + iconClass + '"></i>';
      btn.title = t(titleKey, titleFallback);
      btn.onmouseover = function () {
        this.style.background = `rgba(${btnColors.rgbString},0.25)`;
        this.style.transform = "translateY(-2px) scale(1.05)";
        this.style.boxShadow = `0 8px 16px ${btnColors.shadowRgba}`;
        this.style.borderColor = btnColors.accent;
      };
      btn.onmouseout = function () {
        this.style.background = `rgba(${btnColors.rgbString},0.1)`;
        this.style.transform = "translateY(0) scale(1)";
        this.style.boxShadow = "none";
        this.style.borderColor = btnColors.borderRgba;
      };
      iconButtons.appendChild(btn);
      return btn;
    }

    const settingsBtn = createIconButton(
      "lt-fixes-settings",
      "fa-gear",
      "menu.settings",
      "Settings",
    );
    const closeIconBtn = createIconButton(
      "lt-fixes-close",
      "fa-xmark",
      "settings.close",
      "Close",
    );

    const body = document.createElement("div");
    const bodyColors = getThemeColors();
    body.style.cssText = `flex:1 1 auto;overflow-y:auto;padding:20px;border:1px solid ${bodyColors.border};border-radius:12px;background:${bodyColors.bgContainer};`;

    try {
      const bannerImg = document.querySelector(".game_header_image_full");
      if (bannerImg && bannerImg.src) {
        body.style.background = `linear-gradient(to bottom, rgba(15, 15, 15, 0.85), #0f0f0f 70%), url('${bannerImg.src}') no-repeat top center`;
        body.style.backgroundSize = "cover";
      }
    } catch (_) {}

    // Add mouse mode tip for Big Picture
    if (window.__LUATOOLS_IS_BIG_PICTURE__) {
      const tip = document.createElement("div");
      tip.style.cssText =
        "background:rgba(102,192,244,0.15);border-left:3px solid #66c0f4;padding:12px 16px;border-radius:6px;font-size:13px;color:#c7d5e0;margin-bottom:16px;line-height:1.5;";
      tip.innerHTML =
        '<i class="fa-solid fa-info-circle" style="margin-right:8px;color:#66c0f4;"></i>' +
        t(
          "bigpicture.mouseTip",
          "To use mouse mode in Steam: Guide Button + Right Joystick, click with RB",
        );
      body.appendChild(tip);
    }

    const gameHeader = document.createElement("div");
    gameHeader.style.cssText =
      "display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:16px;";

    const gameIcon = document.createElement("img");
    gameIcon.style.cssText =
      "width:32px;height:32px;border-radius:4px;object-fit:cover;display:none;";
    try {
      const iconImg = document.querySelector(".apphub_AppIcon img");
      if (iconImg && iconImg.src) {
        gameIcon.src = iconImg.src;
        gameIcon.style.display = "block";
      }
    } catch (_) {}

    const gameName = document.createElement("div");
    gameName.style.cssText =
      "font-size:22px;color:#fff;font-weight:600;text-align:center;";
    gameName.textContent = data.gameName || lt("Unknown Game");

    if (
      !data.gameName ||
      data.gameName === "Unknown Game" ||
      data.gameName === lt("Unknown Game") ||
      data.gameName.startsWith("Unknown Game")
    ) {
      fetchSteamGameName(data.appid).then(function (name) {
        if (name) {
          data.gameName = name;
          gameName.textContent = name;
        }
      });
    }

    const contentContainer = document.createElement("div");
    contentContainer.style.position = "relative";
    contentContainer.style.zIndex = "1";

    const columnsContainer = document.createElement("div");
    columnsContainer.style.cssText =
      "display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:16px;";

    function createFixButton(label, text, icon, isSuccess, onClick) {
      const btn = document.createElement("a");
      btn.href = "#";
      const btnColors = getThemeColors();
      btn.style.cssText = `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;flex:1 1 calc(50% - 10px);min-width:140px;box-sizing:border-box;padding:14px 6px;background:rgba(${btnColors.rgbString},0.06);border:1px solid ${btnColors.borderRgba};border-radius:12px;color:${btnColors.text};text-decoration:none;transition:all 0.2s ease;cursor:pointer;text-align:center;`;

      const iconHtml =
        '<i class="fa-solid ' + icon + '" style="font-size:22px;"></i>';
      const labelHtml =
        '<span style="font-weight:600;font-size:13px;line-height:1.2;">' +
        label +
        "</span>";
      const textHtml =
        '<span style="font-size:11px;opacity:0.8;line-height:1.2;">' +
        text +
        "</span>";
      btn.innerHTML = iconHtml + labelHtml + textHtml;

      // If the active theme is light, make certain fix action texts/icons white for readability.
      try {
        const currentThemeKey =
          (((window.__LuaToolsSettings || {}).values || {}).general || {})
            .theme || "original";
        // Use localized labels so this works in other languages
        const applyLabel = lt("Apply");
        const onlineUnsteamLabel = lt("Online Fix (Unsteam)");
        const noOnlineLabel = lt("No online-fix");
        const unfixLabel = lt("Un-Fix (verify game)");
        const noGenericLabel = lt("No generic fix");
        const whiteTexts = new Set([
          applyLabel,
          onlineUnsteamLabel,
          noOnlineLabel,
          unfixLabel,
          noGenericLabel,
        ]);
        if (currentThemeKey === "light" && whiteTexts.has(String(text))) {
          btn
            .querySelectorAll("span, i")
            .forEach((el) => (el.style.color = "#ffffff"));
        }
      } catch (_) {}

      if (isSuccess) {
        btn.style.background =
          "linear-gradient(135deg, rgba(92,156,62,0.4) 0%, rgba(92,156,62,0.2) 100%)";
        btn.style.borderColor = "rgba(92,156,62,0.6)";
        btn.onmouseover = function () {
          this.style.background =
            "linear-gradient(135deg, rgba(92,156,62,0.6) 0%, rgba(92,156,62,0.3) 100%)";
          this.style.transform = "translateY(-2px)";
          this.style.boxShadow = "0 8px 20px rgba(92,156,62,0.3)";
          this.style.borderColor = "#79c754";
        };
        btn.onmouseout = function () {
          this.style.background =
            "linear-gradient(135deg, rgba(92,156,62,0.4) 0%, rgba(92,156,62,0.2) 100%)";
          this.style.transform = "translateY(0)";
          this.style.boxShadow = "none";
          this.style.borderColor = "rgba(92,156,62,0.6)";
        };
      } else if (isSuccess === false) {
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
      } else {
        const mutableColors = getThemeColors();
        btn.onmouseover = function () {
          const c = getThemeColors();
          this.style.background = `linear-gradient(135deg, rgba(${c.rgbString},0.3) 0%, rgba(${c.rgbString},0.15) 100%)`;
          this.style.transform = "translateY(-2px)";
          this.style.boxShadow = `0 8px 20px rgba(${c.rgbString},0.25)`;
          this.style.borderColor = c.accent;
        };
        btn.onmouseout = function () {
          const c = getThemeColors();
          this.style.background = `linear-gradient(135deg, rgba(${c.rgbString},0.15) 0%, rgba(${c.rgbString},0.05) 100%)`;
          this.style.transform = "translateY(0)";
          this.style.boxShadow = "none";
          this.style.borderColor = c.border;
        };
      }

      btn.onclick = onClick;
      return btn;
    }

    // left thing in fixes modal
    const genericStatus = data.genericFix.status;
    const genericSection = createFixButton(
      lt("Generic Fix"),
      genericStatus === 200 ? lt("Apply") : lt("No generic fix"),
      genericStatus === 200 ? "fa-check" : "fa-circle-xmark",
      genericStatus === 200 ? true : false,
      function (e) {
        e.preventDefault();
        if (genericStatus === 200 && isGameInstalled) {
          const genericUrl =
            "https://files.luatools.work/GameBypasses/" + data.appid + ".zip";
          applyFix(
            data.appid,
            genericUrl,
            lt("Generic Fix"),
            data.gameName,
            overlay,
          );
        }
      },
    );
    columnsContainer.appendChild(genericSection);

    if (!isGameInstalled) {
      genericSection.style.opacity = "0.5";
      genericSection.style.cursor = "not-allowed";
    }

    const onlineStatus = data.onlineFix.status;
    const onlineSection = createFixButton(
      lt("Online Fix"),
      onlineStatus === 200 ? lt("Apply") : lt("No online-fix"),
      onlineStatus === 200 ? "fa-check" : "fa-circle-xmark",
      onlineStatus === 200 ? true : false,
      function (e) {
        e.preventDefault();
        if (onlineStatus === 200 && isGameInstalled) {
          const onlineUrl =
            data.onlineFix.url ||
            "https://files.luatools.work/OnlineFix1/" + data.appid + ".zip";
          applyFix(
            data.appid,
            onlineUrl,
            lt("Online Fix"),
            data.gameName,
            overlay,
          );
        }
      },
    );
    columnsContainer.appendChild(onlineSection);

    if (!isGameInstalled) {
      onlineSection.style.opacity = "0.5";
      onlineSection.style.cursor = "not-allowed";
    }
    const aioSection = createFixButton(
      lt("All-In-One Fixes"),
      lt("Online Fix (Unsteam)"),
      "fa-globe",
      null, // default blue button
      function (e) {
        e.preventDefault();
        if (isGameInstalled) {
          const downloadUrl =
            "https://github.com/madoiscool/lt_api_links/releases/download/unsteam/Win64.zip";
          applyFix(
            data.appid,
            downloadUrl,
            lt("Online Fix (Unsteam)"),
            data.gameName,
            overlay,
          );
        }
      },
    );
    columnsContainer.appendChild(aioSection);
    if (!isGameInstalled) {
      aioSection.style.opacity = "0.5";
      aioSection.style.cursor = "not-allowed";
    }

    const unfixSection = createFixButton(
      lt("Manage Game"),
      lt("Un-Fix (verify game)"),
      "fa-trash",
      null, // ^^
      function (e) {
        e.preventDefault();
        if (isGameInstalled) {
          try {
            overlay.remove();
          } catch (_) {}
          showLuaToolsConfirm(
            "LuaTools",
            lt(
              "Are you sure you want to un-fix? This will remove fix files and verify game files.",
            ),
            function () {
              startUnfix(data.appid);
            },
            function () {
              showFixesResultsPopup(data, isGameInstalled);
            },
          );
        }
      },
    );
    columnsContainer.appendChild(unfixSection);
    if (!isGameInstalled) {
      unfixSection.style.opacity = "0.5";
      unfixSection.style.cursor = "not-allowed";
    }

    // body moment
    gameHeader.appendChild(gameIcon);
    gameHeader.appendChild(gameName);
    contentContainer.appendChild(gameHeader);

    contentContainer.appendChild(columnsContainer);

    if (!isGameInstalled) {
      const notInstalledWarning = document.createElement("div");
      notInstalledWarning.style.cssText =
        "margin-top: 16px; padding: 12px; background: rgba(255, 193, 7, 0.1); border: 1px solid rgba(255, 193, 7, 0.3); border-radius: 6px; color: #ffc107; font-size: 13px; text-align: center;";
      notInstalledWarning.innerHTML =
        '<i class="fa-solid fa-circle-info" style="margin-right: 8px;"></i>' +
        t("menu.error.notInstalled", "Game is not installed");
      contentContainer.appendChild(notInstalledWarning);
    }

    body.appendChild(contentContainer);

    // header moment
    header.appendChild(title);
    header.appendChild(iconButtons);

    const btnRow = document.createElement("div");
    btnRow.style.cssText =
      "flex:0 0 auto;margin-top:16px;display:flex;gap:8px;justify-content:space-between;align-items:center;";

    const rightButtons = document.createElement("div");
    rightButtons.style.cssText = "display:flex;gap:8px;";
    const gameFolderBtn = document.createElement("a");
    gameFolderBtn.className = "luatools-btn";
    gameFolderBtn.innerHTML = `<span><i class="fa-solid fa-folder" style="margin-right: 8px;"></i>${lt("Game folder")}</span>`;
    gameFolderBtn.href = "#";
    gameFolderBtn.onclick = function (e) {
      e.preventDefault();
      if (window.__LuaToolsGameInstallPath) {
        try {
          Millennium.callServerMethod("luatools", "OpenGameFolder", {
            path: window.__LuaToolsGameInstallPath,
            contentScriptQuery: "",
          });
        } catch (err) {
          backendLog("LuaTools: Failed to open game folder: " + err);
        }
      }
    };
    rightButtons.appendChild(gameFolderBtn);

    const backBtn = document.createElement("a");
    backBtn.className = "luatools-btn";
    backBtn.innerHTML = '<span><i class="fa-solid fa-arrow-left"></i></span>';
    backBtn.href = "#";
    backBtn.onclick = function (e) {
      e.preventDefault();
      try {
        overlay.remove();
      } catch (_) {}
      showSettingsPopup();
    };
    btnRow.appendChild(backBtn);
    btnRow.appendChild(rightButtons);

    // final modal
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);

    closeIconBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
    };
    settingsBtn.onclick = function (e) {
      e.preventDefault();
      try {
        overlay.remove();
      } catch (_) {}
      showSettingsManagerPopup(false, function () {
        showFixesResultsPopup(data, isGameInstalled);
      });
    };

    function startUnfix(appid) {
      try {
        Millennium.callServerMethod("luatools", "UnFixGame", {
          appid: appid,
          installPath: window.__LuaToolsGameInstallPath,
          contentScriptQuery: "",
        })
          .then(function (res) {
            const payload = typeof res === "string" ? JSON.parse(res) : res;
            if (payload && payload.success) {
              showUnfixProgress(appid);
            } else {
              const errorKey =
                payload && payload.error ? String(payload.error) : "";
              const errorMsg =
                errorKey &&
                (errorKey.startsWith("menu.error.") ||
                  errorKey.startsWith("common."))
                  ? t(errorKey)
                  : errorKey || lt("Failed to start un-fix");
              ShowLuaToolsAlert("LuaTools", errorMsg);
            }
          })
          .catch(function () {
            const msg = lt("Error starting un-fix");
            ShowLuaToolsAlert("LuaTools", msg);
          });
      } catch (err) {
        backendLog("LuaTools: Un-Fix start error: " + err);
      }
    }
  }

  function showFixesLoadingPopupAndCheck(appid) {
    if (document.querySelector(".luatools-loading-fixes-overlay")) return;
    try {
      const d = document.querySelector(".luatools-overlay");
      if (d) d.remove();
    } catch (_) {}
    try {
      const s = document.querySelector(".luatools-settings-overlay");
      if (s) s.remove();
    } catch (_) {}
    try {
      const f = document.querySelector(".luatools-fixes-overlay");
      if (f) f.remove();
    } catch (_) {}

    ensureLuaToolsStyles();
    ensureFontAwesome();
    const overlay = document.createElement("div");
    overlay.className = "luatools-loading-fixes-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const colors = getThemeColors();
    modal.style.cssText = `background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:480px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const title = document.createElement("div");
    const titleColorsLoading = getThemeColors();
    title.style.cssText = `font-size:22px;color:${titleColorsLoading.text};margin-bottom:16px;font-weight:600;`;
    title.textContent = lt("Loading fixes...");

    const body = document.createElement("div");
    const bodyColorsLoading = getThemeColors();
    body.style.cssText = `font-size:14px;line-height:1.6;margin-bottom:16px;color:${bodyColorsLoading.textSecondary};`;
    body.textContent = lt("Checking availability…");

    const progressWrap = document.createElement("div");
    const progressColorsLoading = getThemeColors();
    progressWrap.style.cssText = `background:rgba(0,0,0,0.3);height:12px;border-radius:4px;overflow:hidden;position:relative;border:1px solid ${progressColorsLoading.border};`;
    const progressBar = document.createElement("div");
    progressBar.style.cssText = `height:100%;width:0%;background:${progressColorsLoading.gradient};transition:width 0.2s linear;box-shadow:0 0 10px ${progressColorsLoading.shadow};`;
    progressWrap.appendChild(progressBar);

    modal.appendChild(title);
    modal.appendChild(body);
    modal.appendChild(progressWrap);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);

    let progress = 0;
    const progressInterval = setInterval(function () {
      if (progress < 95) {
        progress += Math.random() * 5;
        progressBar.style.width = Math.min(progress, 95) + "%";
      }
    }, 200);

    fetchFixes(appid)
      .then(function (payload) {
        if (payload && payload.success) {
          const isGameInstalled = window.__LuaToolsGameIsInstalled === true;
          showFixesResultsPopup(payload, isGameInstalled);
        } else {
          const errText =
            payload && payload.error
              ? String(payload.error)
              : lt("Failed to check for fixes.");
          ShowLuaToolsAlert("LuaTools", errText);
        }
      })
      .catch(function () {
        const msg = lt("Error checking for fixes");
        ShowLuaToolsAlert("LuaTools", msg);
      })
      .finally(function () {
        clearInterval(progressInterval);
        progressBar.style.width = "100%";
        setTimeout(function () {
          try {
            const l = document.querySelector(".luatools-loading-fixes-overlay");
            if (l) l.remove();
          } catch (_) {}
        }, 300);
      });
  }

  // Apply Fix function
  function applyFix(appid, downloadUrl, fixType, gameName, resultsOverlay) {
    try {
      // Close results overlay
      if (resultsOverlay) {
        resultsOverlay.remove();
      }

      // Check if we have the game install path
      if (!window.__LuaToolsGameInstallPath) {
        const msg = lt("Game install path not found");
        ShowLuaToolsAlert("LuaTools", msg);
        return;
      }

      backendLog("LuaTools: Applying fix " + fixType + " for appid " + appid);

      // Start the download and extraction process
      Millennium.callServerMethod("luatools", "ApplyGameFix", {
        appid: appid,
        downloadUrl: downloadUrl,
        installPath: window.__LuaToolsGameInstallPath,
        fixType: fixType,
        gameName: gameName || "",
        contentScriptQuery: "",
      })
        .then(function (res) {
          try {
            const payload = typeof res === "string" ? JSON.parse(res) : res;
            if (payload && payload.success) {
              // Show download progress popup similar to Add via LuaTools
              showFixDownloadProgress(appid, fixType);
            } else {
              const errorKey =
                payload && payload.error ? String(payload.error) : "";
              const errorMsg =
                errorKey &&
                (errorKey.startsWith("menu.error.") ||
                  errorKey.startsWith("common."))
                  ? t(errorKey)
                  : errorKey || lt("Failed to start fix download");
              ShowLuaToolsAlert("LuaTools", errorMsg);
            }
          } catch (err) {
            backendLog("LuaTools: ApplyGameFix response error: " + err);
            const msg = lt("Error applying fix");
            ShowLuaToolsAlert("LuaTools", msg);
          }
        })
        .catch(function (err) {
          backendLog("LuaTools: ApplyGameFix error: " + err);
          const msg = lt("Error applying fix");
          ShowLuaToolsAlert("LuaTools", msg);
        });
    } catch (err) {
      backendLog("LuaTools: applyFix error: " + err);
    }
  }

  // Show fix download progress popup
  function showFixDownloadProgress(appid, fixType) {
    // Reuse the download popup UI from Add via LuaTools
    if (document.querySelector(".luatools-overlay")) return;

    ensureLuaToolsStyles();
    ensureFontAwesome();
    const overlay = document.createElement("div");
    overlay.className = "luatools-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const colors = getThemeColors();
    modal.style.cssText = `background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:480px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const title = document.createElement("div");
    const applyFixTitleColors = getThemeColors();
    title.style.cssText = `font-size:22px;color:${applyFixTitleColors.text};margin-bottom:16px;font-weight:600;`;
    title.textContent = lt("Applying {fix}").replace("{fix}", fixType);

    const body = document.createElement("div");
    const applyFixBodyColors = getThemeColors();
    body.style.cssText = `font-size:15px;line-height:1.6;margin-bottom:20px;color:${applyFixBodyColors.textSecondary};`;
    body.innerHTML =
      '<div id="lt-fix-progress-msg">' + lt("Downloading...") + "</div>";

    const btnRow = document.createElement("div");
    btnRow.className = "lt-fix-btn-row";
    btnRow.style.cssText =
      "margin-top:16px;display:flex;gap:12px;justify-content:center;";

    const hideBtn = document.createElement("a");
    hideBtn.href = "#";
    hideBtn.className = "luatools-btn";
    hideBtn.style.flex = "1";
    hideBtn.innerHTML = `<span>${lt("Hide")}</span>`;
    hideBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
    };
    btnRow.appendChild(hideBtn);

    const cancelBtn = document.createElement("a");
    cancelBtn.href = "#";
    cancelBtn.className = "luatools-btn primary";
    cancelBtn.style.flex = "1";
    cancelBtn.innerHTML = `<span>${lt("Cancel")}</span>`;
    cancelBtn.onclick = function (e) {
      e.preventDefault();
      if (cancelBtn.dataset.pending === "1") return;
      cancelBtn.dataset.pending = "1";
      const span = cancelBtn.querySelector("span");
      if (span) span.textContent = lt("Cancelling...");
      const msgEl = document.getElementById("lt-fix-progress-msg");
      if (msgEl) msgEl.textContent = lt("Cancelling...");
      Millennium.callServerMethod("luatools", "CancelApplyFix", {
        appid: appid,
        contentScriptQuery: "",
      })
        .then(function (res) {
          try {
            const payload = typeof res === "string" ? JSON.parse(res) : res;
            if (!payload || payload.success !== true) {
              throw new Error(
                (payload && payload.error) || lt("Cancellation failed"),
              );
            }
          } catch (err) {
            cancelBtn.dataset.pending = "0";
            if (span) span.textContent = lt("Cancel");
            const msgEl2 = document.getElementById("lt-fix-progress-msg");
            if (msgEl2 && msgEl2.dataset.last)
              msgEl2.textContent = msgEl2.dataset.last;
            backendLog("LuaTools: CancelApplyFix response error: " + err);
            const msg = lt("Failed to cancel fix download");
            ShowLuaToolsAlert("LuaTools", msg);
          }
        })
        .catch(function (err) {
          cancelBtn.dataset.pending = "0";
          const span2 = cancelBtn.querySelector("span");
          if (span2) span2.textContent = lt("Cancel");
          const msgEl2 = document.getElementById("lt-fix-progress-msg");
          if (msgEl2 && msgEl2.dataset.last)
            msgEl2.textContent = msgEl2.dataset.last;
          backendLog("LuaTools: CancelApplyFix error: " + err);
          const msg = lt("Failed to cancel fix download");
          ShowLuaToolsAlert("LuaTools", msg);
        });
    };
    btnRow.appendChild(cancelBtn);

    modal.appendChild(title);
    modal.appendChild(body);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);

    // Start polling for progress
    pollFixProgress(appid, fixType);
  }

  function replaceFixButtonsWithClose(overlayEl) {
    if (!overlayEl) return;
    const btnRow = overlayEl.querySelector(".lt-fix-btn-row");
    if (!btnRow) return;
    btnRow.innerHTML = "";
    btnRow.style.cssText =
      "margin-top:16px;display:flex;justify-content:flex-end;";
    const closeBtn = document.createElement("a");
    closeBtn.href = "#";
    closeBtn.className = "luatools-btn primary";
    closeBtn.style.minWidth = "140px";
    closeBtn.innerHTML = `<span>${lt("Close")}</span>`;
    closeBtn.onclick = function (e) {
      e.preventDefault();
      overlayEl.remove();
    };
    btnRow.appendChild(closeBtn);
  }

  // Poll fix download and extraction progress
  function pollFixProgress(appid, fixType) {
    const poll = function () {
      try {
        const overlayEl = document.querySelector(".luatools-overlay");
        if (!overlayEl) return; // Stop if overlay was closed

        Millennium.callServerMethod("luatools", "GetApplyFixStatus", {
          appid: appid,
          contentScriptQuery: "",
        }).then(function (res) {
          try {
            const payload = typeof res === "string" ? JSON.parse(res) : res;
            if (payload && payload.success && payload.state) {
              const state = payload.state;
              const msgEl = document.getElementById("lt-fix-progress-msg");

              if (state.status === "downloading") {
                const pct =
                  state.totalBytes > 0
                    ? Math.floor((state.bytesRead / state.totalBytes) * 100)
                    : 0;
                if (msgEl) {
                  msgEl.textContent = lt("Downloading: {percent}%").replace(
                    "{percent}",
                    pct,
                  );
                  msgEl.dataset.last = msgEl.textContent;
                }
                setTimeout(poll, 500);
              } else if (state.status === "extracting") {
                if (msgEl) {
                  msgEl.textContent = lt("Extracting to game folder...");
                  msgEl.dataset.last = msgEl.textContent;
                }
                setTimeout(poll, 500);
              } else if (state.status === "cancelled") {
                if (msgEl)
                  msgEl.textContent = lt("Cancelled: {reason}").replace(
                    "{reason}",
                    state.error || lt("Cancelled by user"),
                  );
                replaceFixButtonsWithClose(overlayEl);
                return;
              } else if (state.status === "done") {
                if (msgEl)
                  msgEl.textContent = lt("{fix} applied successfully!").replace(
                    "{fix}",
                    fixType,
                  );
                replaceFixButtonsWithClose(overlayEl);
                return; // Stop polling
              } else if (state.status === "failed") {
                if (msgEl)
                  msgEl.textContent = lt("Failed: {error}").replace(
                    "{error}",
                    state.error || lt("Unknown error"),
                  );
                replaceFixButtonsWithClose(overlayEl);
                return; // Stop polling
              } else {
                // Continue polling for unknown states
                setTimeout(poll, 500);
              }
            }
          } catch (err) {
            backendLog("LuaTools: GetApplyFixStatus error: " + err);
          }
        });
      } catch (err) {
        backendLog("LuaTools: pollFixProgress error: " + err);
      }
    };
    setTimeout(poll, 500);
  }

  // Show un-fix progress popup
  function showUnfixProgress(appid) {
    // Remove any existing popup
    try {
      const old = document.querySelector(".luatools-unfix-overlay");
      if (old) old.remove();
    } catch (_) {}

    ensureLuaToolsStyles();
    ensureFontAwesome();
    const overlay = document.createElement("div");
    overlay.className = "luatools-unfix-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const colors = getThemeColors();
    modal.style.cssText = `background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:480px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const title = document.createElement("div");
    const unfixTitleColors = getThemeColors();
    title.style.cssText = `font-size:22px;color:${unfixTitleColors.text};margin-bottom:16px;font-weight:600;`;
    title.textContent = lt("Un-Fixing game");

    const body = document.createElement("div");
    body.style.cssText =
      "font-size:15px;line-height:1.6;margin-bottom:20px;color:#c7d5e0;";
    body.innerHTML =
      '<div id="lt-unfix-progress-msg">' +
      lt("Removing fix files...") +
      "</div>";

    const btnRow = document.createElement("div");
    btnRow.style.cssText =
      "margin-top:16px;display:flex;justify-content:center;";
    const hideBtn = document.createElement("a");
    hideBtn.href = "#";
    hideBtn.className = "luatools-btn";
    hideBtn.style.minWidth = "140px";
    hideBtn.innerHTML = `<span>${lt("Hide")}</span>`;
    hideBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
    };
    btnRow.appendChild(hideBtn);

    modal.appendChild(title);
    modal.appendChild(body);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);

    // Start polling for progress
    pollUnfixProgress(appid);
  }

  // Poll un-fix progress
  function pollUnfixProgress(appid) {
    const poll = function () {
      try {
        const overlayEl = document.querySelector(".luatools-unfix-overlay");
        if (!overlayEl) return; // Stop if overlay was closed

        Millennium.callServerMethod("luatools", "GetUnfixStatus", {
          appid: appid,
          contentScriptQuery: "",
        }).then(function (res) {
          try {
            const payload = typeof res === "string" ? JSON.parse(res) : res;
            if (payload && payload.success && payload.state) {
              const state = payload.state;
              const msgEl = document.getElementById("lt-unfix-progress-msg");

              if (state.status === "removing") {
                if (msgEl)
                  msgEl.textContent =
                    state.progress || lt("Removing fix files...");
                // Continue polling
                setTimeout(poll, 500);
              } else if (state.status === "done") {
                const filesRemoved = state.filesRemoved || 0;
                if (msgEl)
                  msgEl.textContent = lt(
                    "Removed {count} files. Running Steam verification...",
                  ).replace("{count}", filesRemoved);
                // Change Hide button to Close button
                try {
                  const btnRow = overlayEl.querySelector(
                    'div[style*="justify-content:center"]',
                  );
                  if (btnRow) {
                    btnRow.innerHTML = "";
                    const closeBtn = document.createElement("a");
                    closeBtn.href = "#";
                    closeBtn.className = "luatools-btn primary";
                    closeBtn.style.minWidth = "140px";
                    closeBtn.innerHTML = `<span>${lt("Close")}</span>`;
                    closeBtn.onclick = function (e) {
                      e.preventDefault();
                      overlayEl.remove();
                    };
                    btnRow.appendChild(closeBtn);
                  }
                } catch (_) {}

                // Trigger Steam verification after a short delay
                setTimeout(function () {
                  try {
                    const verifyUrl = "steam://validate/" + appid;
                    window.location.href = verifyUrl;
                    backendLog("LuaTools: Running verify for appid " + appid);
                  } catch (_) {}
                }, 1000);

                return; // Stop polling
              } else if (state.status === "failed") {
                if (msgEl)
                  msgEl.textContent = lt("Failed: {error}").replace(
                    "{error}",
                    state.error || lt("Unknown error"),
                  );
                // Change Hide button to Close button
                try {
                  const btnRow = overlayEl.querySelector(
                    'div[style*="justify-content:center"]',
                  );
                  if (btnRow) {
                    btnRow.innerHTML = "";
                    const closeBtn = document.createElement("a");
                    closeBtn.href = "#";
                    closeBtn.className = "luatools-btn primary";
                    closeBtn.style.minWidth = "140px";
                    closeBtn.innerHTML = `<span>${lt("Close")}</span>`;
                    closeBtn.onclick = function (e) {
                      e.preventDefault();
                      overlayEl.remove();
                    };
                    btnRow.appendChild(closeBtn);
                  }
                } catch (_) {}
                return; // Stop polling
              } else {
                // Continue polling for unknown states
                setTimeout(poll, 500);
              }
            }
          } catch (err) {
            backendLog("LuaTools: GetUnfixStatus error: " + err);
          }
        });
      } catch (err) {
        backendLog("LuaTools: pollUnfixProgress error: " + err);
      }
    };
    setTimeout(poll, 500);
  }

  function fetchSettingsConfig(forceRefresh) {
    try {
      if (
        !forceRefresh &&
        window.__LuaToolsSettings &&
        Array.isArray(window.__LuaToolsSettings.schema)
      ) {
        return Promise.resolve(window.__LuaToolsSettings);
      }
    } catch (_) {}

    if (
      typeof Millennium === "undefined" ||
      typeof Millennium.callServerMethod !== "function"
    ) {
      return Promise.reject(new Error(lt("LuaTools backend unavailable")));
    }

    return Millennium.callServerMethod("luatools", "GetSettingsConfig", {
      contentScriptQuery: "",
    }).then(function (res) {
      const payload = typeof res === "string" ? JSON.parse(res) : res;
      if (!payload || payload.success !== true) {
        const errorMsg =
          payload && payload.error
            ? String(payload.error)
            : t("settings.error", "Failed to load settings.");
        throw new Error(errorMsg);
      }
      const config = {
        schemaVersion: payload.schemaVersion || 0,
        schema: Array.isArray(payload.schema) ? payload.schema : [],
        values:
          payload && payload.values && typeof payload.values === "object"
            ? payload.values
            : {},
        language: payload && payload.language ? String(payload.language) : "ar",
        locales: Array.isArray(payload && payload.locales)
          ? payload.locales
          : [],
        translations:
          payload &&
          payload.translations &&
          typeof payload.translations === "object"
            ? payload.translations
            : {},
        lastFetched: Date.now(),
      };
      applyTranslationBundle({
        language: config.language,
        locales: config.locales,
        strings: config.translations,
      });
      window.__LuaToolsSettings = config;
      return config;
    });
  }

  function initialiseSettingsDraft(config) {
    const values = JSON.parse(JSON.stringify((config && config.values) || {}));
    if (!config || !Array.isArray(config.schema)) {
      return values;
    }
    for (let i = 0; i < config.schema.length; i++) {
      const group = config.schema[i];
      if (!group || !group.key) continue;
      if (
        typeof values[group.key] !== "object" ||
        values[group.key] === null ||
        Array.isArray(values[group.key])
      ) {
        values[group.key] = {};
      }
      const options = Array.isArray(group.options) ? group.options : [];
      for (let j = 0; j < options.length; j++) {
        const option = options[j];
        if (!option || !option.key) continue;
        if (typeof values[group.key][option.key] === "undefined") {
          values[group.key][option.key] = option.default;
        }
      }
    }
    return values;
  }

  function showSettingsManagerPopup(forceRefresh, onBack) {
    if (document.querySelector(".luatools-settings-manager-overlay")) return;

    try {
      const mainOverlay = document.querySelector(".luatools-settings-overlay");
      if (mainOverlay) mainOverlay.remove();
    } catch (_) {}

    ensureLuaToolsStyles();
    ensureFontAwesome();

    const overlay = document.createElement("div");
    overlay.className = "luatools-settings-manager-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:100000;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const settingsModalColors = getThemeColors();
    modal.style.cssText = `position:relative;background:${settingsModalColors.modalBg};color:${settingsModalColors.text};border:1px solid ${settingsModalColors.border};border-radius:16px;width:750px;max-height:88vh;padding:0;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${settingsModalColors.shadowRgba};animation:slideUp 0.12s ease-out;overflow:hidden;`;

    const header = document.createElement("div");
    const settingsHeaderColors = getThemeColors();
    header.style.cssText = `display:flex;justify-content:space-between;align-items:center;padding:20px 24px 16px;border-bottom:1px solid ${settingsHeaderColors.border.replace("0.3", "0.15")};`;

    const title = document.createElement("div");
    const settingsTitleColors = getThemeColors();
    title.style.cssText = `font-size:22px;color:${settingsTitleColors.text};font-weight:600;`;
    title.textContent = t("settings.title", "LuaTools · Settings");

    const iconButtons = document.createElement("div");
    iconButtons.style.cssText = "display:flex;gap:12px;";

    const closeIconBtn = document.createElement("a");
    closeIconBtn.href = "#";
    const closeBtnColors = getThemeColors();
    closeIconBtn.style.cssText = `display:flex;align-items:center;justify-content:center;width:36px;height:36px;background:rgba(${closeBtnColors.rgbString},0.08);border:1px solid ${closeBtnColors.border};border-radius:8px;color:${closeBtnColors.accent};font-size:16px;text-decoration:none;transition:all 0.2s ease;cursor:pointer;`;
    closeIconBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeIconBtn.title = t("settings.close", "Close");
    closeIconBtn.onmouseover = function () {
      const c = getThemeColors();
      this.style.background = `rgba(${c.rgbString},0.18)`;
      this.style.transform = "translateY(-1px)";
      this.style.boxShadow = `0 4px 12px ${c.shadow}`;
      this.style.borderColor = c.accent;
    };
    closeIconBtn.onmouseout = function () {
      const c = getThemeColors();
      this.style.background = `rgba(${c.rgbString},0.08)`;
      this.style.transform = "translateY(0)";
      this.style.boxShadow = "none";
      this.style.borderColor = c.border;
    };
    iconButtons.appendChild(closeIconBtn);

    // Search bar container
    const searchContainer = document.createElement("div");
    const searchColors = getThemeColors();
    searchContainer.style.cssText =
      "padding:16px 24px;border-bottom:1px solid rgba(255,255,255,0.06);";

    const searchWrap = document.createElement("div");
    searchWrap.style.cssText = `display:flex;align-items:center;gap:10px;padding:10px 14px;background:${searchColors.bgTertiary};border:1px solid ${searchColors.border};border-radius:10px;transition:all 0.2s ease;`;

    const searchIcon = document.createElement("i");
    searchIcon.className = "fa-solid fa-magnifying-glass";
    searchIcon.style.cssText = `color:${searchColors.textSecondary};font-size:14px;flex-shrink:0;`;

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.id = "luatools-settings-search";
    searchInput.placeholder = t(
      "settings.search.placeholder",
      "Search settings, games, fixes...",
    );
    searchInput.style.cssText = `flex:1;background:transparent;border:none;outline:none;color:${searchColors.text};font-size:14px;`;
    searchInput.setAttribute("autocomplete", "off");

    const searchClear = document.createElement("a");
    searchClear.href = "#";
    searchClear.style.cssText = `display:none;color:${searchColors.textSecondary};font-size:14px;text-decoration:none;padding:4px;flex-shrink:0;`;
    searchClear.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    searchClear.title = t("settings.search.clear", "Clear search");

    searchWrap.onfocus = function () {
      searchWrap.style.borderColor = searchColors.accent;
    };
    searchInput.onfocus = function () {
      const c = getThemeColors();
      searchWrap.style.borderColor = c.accent;
      searchWrap.style.boxShadow = `0 0 0 2px rgba(${c.rgbString},0.2)`;
    };
    searchInput.onblur = function () {
      const c = getThemeColors();
      searchWrap.style.borderColor = c.border;
      searchWrap.style.boxShadow = "none";
    };

    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(searchClear);
    searchContainer.appendChild(searchWrap);

    const contentWrap = document.createElement("div");
    contentWrap.id = "luatools-content-wrap";
    const contentColors = getThemeColors();
    contentWrap.style.cssText = `flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:24px;margin:0;background:transparent;`;

    // Add mouse mode tip for Big Picture
    if (window.__LUATOOLS_IS_BIG_PICTURE__) {
      const tip = document.createElement("div");
      const tipColors = getThemeColors();
      tip.style.cssText = `background:rgba(${tipColors.rgbString},0.08);border:1px solid ${tipColors.border};padding:12px 16px;border-radius:8px;font-size:13px;color:${tipColors.textSecondary};margin-bottom:20px;line-height:1.5;display:flex;align-items:center;gap:10px;`;
      tip.innerHTML =
        '<i class="fa-solid fa-info-circle" style="color:#66c0f4;font-size:14px;flex-shrink:0;"></i>' +
        t(
          "bigpicture.mouseTip",
          "To use mouse mode in Steam: Guide Button + Right Joystick, click with RB",
        );
      contentWrap.appendChild(tip);
    }

    const btnRow = document.createElement("div");
    btnRow.style.cssText =
      "padding:16px 24px 20px;display:flex;gap:10px;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,0.06);";

    const backBtn = createSettingsButton(
      "back",
      "",
      false,
      '<i class="fa-solid fa-arrow-left"></i>',
    );
    const rightButtons = document.createElement("div");
    rightButtons.style.cssText = "display:flex;gap:10px;";
    const saveBtn = createSettingsButton(
      "save",
      "",
      true,
      '<i class="fa-solid fa-floppy-disk"></i>',
    );

    modal.appendChild(header);
    modal.appendChild(searchContainer);
    modal.appendChild(contentWrap);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);

    const state = {
      config: null,
      draft: {},
      searchQuery: "",
      fixes: [],
      fixesPage: 1,
      luas: [],
      luasPage: 1,
      luasPerPage: 10
    };

    // Search functionality
    let searchDebounceTimer = null;
    searchInput.addEventListener("input", function () {
      const query = searchInput.value.trim().toLowerCase();
      searchClear.style.display = query ? "block" : "none";

      // Debounce the search
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(function () {
        state.searchQuery = query;
        applySearchFilter();
      }, 150);
    });

    searchClear.addEventListener("click", function (e) {
      e.preventDefault();
      searchInput.value = "";
      searchClear.style.display = "none";
      state.searchQuery = "";
      applySearchFilter();
      searchInput.focus();
    });

    function applySearchFilter() {
      const query = state.searchQuery;

      // Filter settings options
      const optionEls = contentWrap.querySelectorAll("[data-setting-option]");
      optionEls.forEach(function (el) {
        const searchText = (el.dataset.searchText || "").toLowerCase();
        if (!query || searchText.includes(query)) {
          el.style.display = "";
        } else {
          el.style.display = "none";
        }
      });

      // Filter settings groups (hide if all options hidden)
      const groupEls = contentWrap.querySelectorAll("[data-setting-group]");
      groupEls.forEach(function (groupEl) {
        const visibleOptions = groupEl.querySelectorAll(
          '[data-setting-option]:not([style*="display: none"])',
        );
        if (!query || visibleOptions.length > 0) {
          groupEl.style.display = "";
        } else {
          groupEl.style.display = "none";
        }
      });

      // Filter installed fixes via pagination
      state.fixesPage = 1;
      if (typeof renderFixesList === "function") {
        renderFixesList();
      }

      // Filter installed lua scripts via pagination
      state.luasPage = 1;
      if (typeof renderLuaList === "function") {
        renderLuaList();
      }
    }

    let refreshDefaultLabel = "";
    let saveDefaultLabel = "";
    let closeDefaultLabel = "";
    let backDefaultLabel = "";

    function createSettingsButton(id, text, isPrimary, iconHtml) {
      const btn = document.createElement("a");
      btn.id = "lt-settings-" + id;
      btn.href = "#";
      const btnColors = getThemeColors();
      const hasText = text && text.trim().length > 0;
      if (iconHtml) {
        btn.innerHTML = hasText
          ? iconHtml + "<span>" + text + "</span>"
          : iconHtml;
      } else {
        btn.innerHTML = "<span>" + text + "</span>";
      }

      const btnSize = hasText
        ? "padding:9px 16px;"
        : "width:38px;height:38px;padding:0;";
      btn.style.cssText = `display:inline-flex;align-items:center;justify-content:center;${btnSize}background:rgba(${btnColors.rgbString},0.1);border:1px solid ${btnColors.border};border-radius:8px;color:${btnColors.text};font-size:14px;text-decoration:none;transition:all 0.2s ease;cursor:pointer;`;

      if (isPrimary) {
        btn.style.background = `linear-gradient(135deg, rgba(${btnColors.rgbString},0.25) 0%, rgba(${btnColors.rgbString},0.15) 100%)`;
        btn.style.borderColor = btnColors.accent;
      }

      btn.onmouseover = function () {
        if (this.dataset.disabled === "1") {
          this.style.opacity = "0.6";
          this.style.cursor = "not-allowed";
          return;
        }
        const c = getThemeColors();
        if (isPrimary) {
          this.style.background = `linear-gradient(135deg, rgba(${c.rgbString},0.35) 0%, rgba(${c.rgbString},0.2) 100%)`;
        } else {
          this.style.background = `rgba(${c.rgbString},0.18)`;
        }
        this.style.transform = "translateY(-1px)";
        this.style.boxShadow = `0 4px 12px ${c.shadow}`;
      };

      btn.onmouseout = function () {
        if (this.dataset.disabled === "1") {
          this.style.opacity = "0.5";
          this.style.transform = "none";
          this.style.boxShadow = "none";
          return;
        }
        const c = getThemeColors();
        if (isPrimary) {
          this.style.background = `linear-gradient(135deg, rgba(${c.rgbString},0.25) 0%, rgba(${c.rgbString},0.15) 100%)`;
        } else {
          this.style.background = `rgba(${c.rgbString},0.1)`;
        }
        this.style.transform = "translateY(0)";
        this.style.boxShadow = "none";
      };

      if (isPrimary) {
        btn.dataset.disabled = "1";
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
      }

      return btn;
    }

    header.appendChild(title);
    header.appendChild(iconButtons);

    // Inject scrollbar styles for content area
    const scrollbarStyle = document.createElement("style");
    scrollbarStyle.textContent =
      "#luatools-content-wrap::-webkit-scrollbar { width: 8px; } " +
      "#luatools-content-wrap::-webkit-scrollbar-track { background: transparent; } " +
      "#luatools-content-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; } " +
      "#luatools-content-wrap::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }";
    modal.appendChild(scrollbarStyle);

    function applyStaticTranslations() {
      title.textContent = t("settings.title", "LuaTools · Settings");
      saveBtn.title = t("settings.save", "Save Settings");
      backBtn.title = t("Back", "Back");
      closeIconBtn.title = t("settings.close", "Close");
    }
    applyStaticTranslations();

    function setStatus(text, color) {
      let statusLine = contentWrap.querySelector(".luatools-settings-status");
      if (!statusLine) {
        statusLine = document.createElement("div");
        statusLine.className = "luatools-settings-status";
        statusLine.style.cssText =
          "font-size:13px;margin-bottom:16px;color:#c7d5e0;text-align:center;padding:6px 12px;background:rgba(255,255,255,0.03);border-radius:6px;";
        contentWrap.insertBefore(statusLine, contentWrap.firstChild);
      }
      if (!text || text.trim() === "") {
        statusLine.style.display = "none";
        return;
      }
      statusLine.style.display = "";
      statusLine.textContent = text;
      statusLine.style.color = color || "#c7d5e0";
    }

    function ensureDraftGroup(groupKey) {
      if (!state.draft[groupKey] || typeof state.draft[groupKey] !== "object") {
        state.draft[groupKey] = {};
      }
      return state.draft[groupKey];
    }

    function collectChanges() {
      if (!state.config || !Array.isArray(state.config.schema)) {
        return {};
      }
      const changes = {};
      for (let i = 0; i < state.config.schema.length; i++) {
        const group = state.config.schema[i];
        if (!group || !group.key) continue;
        const options = Array.isArray(group.options) ? group.options : [];
        const draftGroup = state.draft[group.key] || {};
        const originalGroup =
          (state.config.values && state.config.values[group.key]) || {};
        const groupChanges = {};
        for (let j = 0; j < options.length; j++) {
          const option = options[j];
          if (!option || !option.key) continue;
          const newValue = draftGroup.hasOwnProperty(option.key)
            ? draftGroup[option.key]
            : option.default;
          const oldValue = originalGroup.hasOwnProperty(option.key)
            ? originalGroup[option.key]
            : option.default;
          if (newValue !== oldValue) {
            groupChanges[option.key] = newValue;
          }
        }
        if (Object.keys(groupChanges).length > 0) {
          changes[group.key] = groupChanges;
        }
      }
      return changes;
    }

    function updateSaveState() {
      const hasChanges = Object.keys(collectChanges()).length > 0;
      const isBusy = saveBtn.dataset.busy === "1";

      let hubcapKey = "";
      let foundHubcapKey = false;
      for (const group in state.draft) {
        if (
          state.draft[group] &&
          state.draft[group].hasOwnProperty("morrenusApiKey")
        ) {
          hubcapKey = state.draft[group].morrenusApiKey;
          foundHubcapKey = true;
          break;
        }
      }

      let isValid = true;
      if (foundHubcapKey && hubcapKey) {
        isValid = /^smm_[0-9a-f]{96}$/.test(hubcapKey);
      }

      if (hasChanges && !isBusy && isValid) {
        saveBtn.dataset.disabled = "0";
        saveBtn.style.opacity = "";
        saveBtn.style.cursor = "pointer";
      } else {
        saveBtn.dataset.disabled = "1";
        saveBtn.style.opacity = "0.6";
        saveBtn.style.cursor = "not-allowed";
      }

      if (foundHubcapKey && hubcapKey && !isValid) {
        setStatus(lt("Invalid Morrenus API Key format"), "#ff5c5c");
      }
    }

    function optionLabelKey(groupKey, optionKey) {
      if (groupKey === "general") {
        if (optionKey === "displayName") return "settings.displayName.label";
        if (optionKey === "language") return "settings.language.label";
        if (optionKey === "theme") return "settings.theme.label";
        if (optionKey === "fastDownload") return "settings.fastDownload.label";
        if (optionKey === "morrenusApiKey")
          return "settings.morrenusApiKey.label";
      }
      return null;
    }

    function optionDescriptionKey(groupKey, optionKey) {
      if (groupKey === "general") {
        if (optionKey === "displayName")
          return "settings.displayName.description";
        if (optionKey === "language") return "settings.language.description";
        if (optionKey === "theme") return "settings.theme.description";
        if (optionKey === "fastDownload")
          return "settings.fastDownload.description";
        if (optionKey === "morrenusApiKey")
          return "settings.morrenusApiKey.description";
      }
      return null;
    }

    function optionPlaceholderKey(groupKey, optionKey) {
      if (groupKey === "general") {
        if (optionKey === "displayName")
          return "settings.displayName.placeholder";
        if (optionKey === "morrenusApiKey")
          return "settings.morrenusApiKey.placeholder";
      }
      return null;
    }

    function renderSettings() {
      contentWrap.innerHTML = "";
      if (
        !state.config ||
        !Array.isArray(state.config.schema) ||
        state.config.schema.length === 0
      ) {
        const emptyState = document.createElement("div");
        const emptyColors = getThemeColors();
        emptyState.style.cssText = `padding:14px;background:${emptyColors.bgTertiary};border:1px solid ${emptyColors.border};border-radius:4px;color:${emptyColors.textSecondary};`;
        emptyState.textContent = t(
          "settings.empty",
          "No settings available yet.",
        );
        contentWrap.appendChild(emptyState);
        updateSaveState();
        return;
      }

      for (let i = 0; i < state.config.schema.length; i++) {
        const group = state.config.schema[i];
        if (!group || !group.key) continue;

        const groupEl = document.createElement("div");
        const groupCardColors = getThemeColors();
        groupEl.style.cssText = `background:rgba(${groupCardColors.rgbString},0.04);border:1px solid ${groupCardColors.border};border-radius:10px;padding:18px 20px;margin-bottom:16px;`;
        groupEl.dataset.settingGroup = group.key;

        const groupTitle = document.createElement("div");
        const titleText = t("settings." + group.key, group.label || group.key);
        if (group.key === "general") {
          const generalTitleColors = getThemeColors();
          groupTitle.innerHTML = `<i class="fa-solid fa-gear" style="margin-right:10px;color:${generalTitleColors.textSecondary};font-size:20px;"></i>${titleText}`;
          groupTitle.style.cssText = `font-size:19px;color:${generalTitleColors.text};margin-bottom:14px;font-weight:600;display:flex;align-items:center;`;
        } else {
          const otherTitleColors = getThemeColors();
          groupTitle.style.cssText = `font-size:15px;font-weight:600;color:${otherTitleColors.accent};margin-bottom:6px;`;
        }
        groupEl.appendChild(groupTitle);

        if (group.description && group.key !== "general") {
          const groupDesc = document.createElement("div");
          const descColors = getThemeColors();
          groupDesc.style.cssText = `margin-bottom:14px;font-size:12px;color:${descColors.textSecondary};line-height:1.5;`;
          groupDesc.textContent = t(
            "settings." + group.key + "Description",
            group.description,
          );
          groupEl.appendChild(groupDesc);
        }

        const options = Array.isArray(group.options) ? group.options : [];
        for (let j = 0; j < options.length; j++) {
          const option = options[j];
          if (!option || !option.key) continue;

          ensureDraftGroup(group.key);
          if (!state.draft[group.key].hasOwnProperty(option.key)) {
            const sourceGroup =
              (state.config.values && state.config.values[group.key]) || {};
            const initialValue = sourceGroup.hasOwnProperty(option.key)
              ? sourceGroup[option.key]
              : option.default;
            state.draft[group.key][option.key] = initialValue;
          }

          const optionEl = document.createElement("div");
          const optionColors = getThemeColors();
          const alignItems =
            option.type === "select" || option.type === "text"
              ? "center"
              : "flex-start";
          optionEl.style.cssText =
            j === 0
              ? `padding-top:0;display:flex;justify-content:space-between;align-items:${alignItems};gap:16px;`
              : `margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);display:flex;justify-content:space-between;align-items:${alignItems};gap:16px;`;
          optionEl.dataset.settingOption = option.key;

          const labelWrap = document.createElement("div");
          labelWrap.className = "luatools-toggle-label-wrap";
          labelWrap.style.flex = "1";

          const optionLabel = document.createElement("div");
          const optLabelColors = getThemeColors();
          optionLabel.style.cssText = `font-size:14px;font-weight:500;color:${optLabelColors.text};`;
          const labelKey = optionLabelKey(group.key, option.key);
          const labelText = t(
            labelKey || "settings." + group.key + "." + option.key + ".label",
            option.label || option.key,
          );
          optionLabel.textContent = labelText;

          // Build search text from label, description, and key
          const descText = option.description || "";
          optionEl.dataset.searchText = (
            labelText +
            " " +
            descText +
            " " +
            option.key +
            " " +
            group.key
          ).toLowerCase();
          labelWrap.appendChild(optionLabel);

          if (option.description) {
            const optionDesc = document.createElement("div");
            const optDescColors = getThemeColors();
            optionDesc.style.cssText = `margin-top:3px;font-size:12px;color:${optDescColors.textSecondary};line-height:1.45;`;
            const descKey = optionDescriptionKey(group.key, option.key);
            let descTextVal = t(
              descKey ||
                "settings." + group.key + "." + option.key + ".description",
              option.description,
            );

            // Special handling for hubcap link
            if (
              descTextVal.includes("hubcapmanifest.com") ||
              descTextVal.includes("{link}")
            ) {
              const url = "https://hubcapmanifest.com";
              const linkHtml = `<a href="${url}" id="lt-hubcap-link" style="color:${optDescColors.accent};text-decoration:underline;">hubcapmanifest.com</a>`;
              if (descTextVal.includes("{link}")) {
                descTextVal = descTextVal.replace("{link}", linkHtml);
              } else {
                descTextVal = descTextVal.replace(
                  "hubcapmanifest.com",
                  linkHtml,
                );
              }
              optionDesc.innerHTML = descTextVal;

              // Add event listener after appending to document or wait?
              // Better: use a selector later or add it now if possible.
              setTimeout(() => {
                const link = document.getElementById("lt-hubcap-link");
                if (link) {
                  link.onclick = (e) => {
                    e.preventDefault();
                    Millennium.callServerMethod("luatools", "OpenExternalUrl", {
                      url,
                      contentScriptQuery: "",
                    });
                  };
                }
              }, 0);
            } else {
              optionDesc.textContent = descTextVal;
            }
            labelWrap.appendChild(optionDesc);
          }

          if (option.type === "toggle") {
            optionEl.classList.add("luatools-toggle-container");
            optionEl.appendChild(labelWrap);

            const toggleWrap = document.createElement("div");
            toggleWrap.style.cssText =
              "display:flex;align-items:center;flex-shrink:0;";

            const toggleLabel = document.createElement("label");
            toggleLabel.className = "luatools-toggle";

            const toggleInput = document.createElement("input");
            toggleInput.type = "checkbox";
            toggleInput.checked = state.draft[group.key][option.key] === true;

            const slider = document.createElement("span");
            slider.className = "luatools-slider";

            toggleInput.addEventListener("change", function () {
              state.draft[group.key][option.key] = toggleInput.checked;
              updateSaveState();
              setStatus(t("settings.unsaved", "Unsaved changes"), "#c7d5e0");
            });

            toggleLabel.appendChild(toggleInput);
            toggleLabel.appendChild(slider);
            toggleWrap.appendChild(toggleLabel);
            optionEl.appendChild(toggleWrap);
          } else {
            optionEl.appendChild(labelWrap);
            const controlWrap = document.createElement("div");

            // If it's a select or any text input, align right like toggles
            const isRightAligned =
              option.type === "select" || option.type === "text";
            if (isRightAligned) {
              optionEl.classList.add("luatools-toggle-container");
              optionEl.style.width = "100%";
              controlWrap.style.setProperty("width", "180px", "important");
              controlWrap.style.setProperty("flex-shrink", "0", "important");
            } else {
              controlWrap.style.cssText = "margin-top:8px;";
            }

            optionEl.appendChild(controlWrap);

            if (option.type === "select") {
              const selectEl = document.createElement("select");
              const selectColors = getThemeColors();
              selectEl.style.cssText = `width:100%;padding:7px 32px 7px 10px !important;background:${selectColors.bgTertiary} !important;color:${selectColors.text} !important;border:1px solid ${selectColors.border} !important;border-radius:6px !important;font-size:13px !important;cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='${encodeURIComponent(selectColors.textSecondary)}' stroke-width='1.5' fill='none'/%3E%3C/svg%3E") !important;background-repeat:no-repeat !important;background-position:right 10px center !important;transition:border-color 0.2s ease,box-shadow 0.2s ease;`;
              selectEl.onfocus = function () {
                const c = getThemeColors();
                this.style.borderColor = c.accent + " !important";
                this.style.boxShadow = `0 0 0 2px rgba(${c.rgbString},0.2)`;
              };
              selectEl.onblur = function () {
                const c = getThemeColors();
                this.style.borderColor = c.border + " !important";
                this.style.boxShadow = "none";
              };

              const choices = Array.isArray(option.choices)
                ? option.choices
                : [];
              for (let c = 0; c < choices.length; c++) {
                const choice = choices[c];
                if (!choice) continue;
                const choiceOption = document.createElement("option");
                choiceOption.value = String(choice.value);
                choiceOption.textContent = choice.label || choice.value;
                selectEl.appendChild(choiceOption);
              }

              const currentValue = state.draft[group.key][option.key];
              if (typeof currentValue !== "undefined") {
                selectEl.value = String(currentValue);
              }

              selectEl.addEventListener("change", function () {
                state.draft[group.key][option.key] = selectEl.value;
                try {
                  backendLog(
                    "LuaTools: " +
                      option.key +
                      " select changed to " +
                      selectEl.value,
                  );
                } catch (_) {}

                // If theme changed, apply it immediately
                if (group.key === "general" && option.key === "theme") {
                  try {
                    backendLog(
                      "LuaTools: Theme change detected, new value: " +
                        selectEl.value,
                    );
                  } catch (_) {}
                  // Update the settings cache so getCurrentTheme() returns the new value
                  if (
                    window.__LuaToolsSettings &&
                    window.__LuaToolsSettings.values
                  ) {
                    if (!window.__LuaToolsSettings.values.general) {
                      window.__LuaToolsSettings.values.general = {};
                    }
                    window.__LuaToolsSettings.values.general.theme =
                      selectEl.value;
                    try {
                      backendLog(
                        "LuaTools: Updated cache, theme is now: " +
                          window.__LuaToolsSettings.values.general.theme,
                      );
                    } catch (_) {}
                  }
                  // Reload styles immediately
                  ensureLuaToolsStyles();

                  // Update all modal elements with new theme colors
                  setTimeout(function () {
                    const colors = getThemeColors();

                    // Update modal background and border
                    const modalEl =
                      overlay &&
                      overlay.querySelector(
                        '[style*="background:linear-gradient"]',
                      );
                    if (modalEl) {
                      modalEl.style.background = colors.modalBg;
                      modalEl.style.borderColor = colors.border;
                    }

                    // Update header border
                    const headerEl =
                      overlay &&
                      overlay.querySelector('[style*="border-bottom"]');
                    if (headerEl) {
                      headerEl.style.borderBottomColor = colors.border.replace(
                        "0.3",
                        "0.2",
                      );
                    }

                    // Update all title and text colors
                    const titles =
                      overlay &&
                      overlay.querySelectorAll('[style*="text-shadow"]');
                    if (titles) {
                      titles.forEach(function (title) {
                        title.style.backgroundImage = colors.gradientLight;
                      });
                    }

                    // Update content wrapper border
                    const contentWrapEl =
                      overlay &&
                      overlay.querySelector("#luatools-content-wrap");
                    if (contentWrapEl) {
                      contentWrapEl.style.borderColor = colors.border;
                      contentWrapEl.style.background = colors.bgContainer;
                    }

                    // Re-render the settings content
                    renderSettings();
                  }, 50);

                  // Auto-save theme changes after a brief delay
                  setTimeout(function () {
                    if (
                      saveBtn &&
                      saveBtn.dataset.disabled !== "1" &&
                      saveBtn.dataset.busy !== "1"
                    ) {
                      saveBtn.click();
                    }
                  }, 150);
                }

                updateSaveState();
                setStatus(t("settings.unsaved", "Unsaved changes"), "#c7d5e0");
              });

              controlWrap.appendChild(selectEl);
            } else if (option.type === "text") {
              const textInput = document.createElement("input");
              textInput.type =
                option.key === "morrenusApiKey" ? "password" : "text";
              const textColors = getThemeColors();
              const placeholderKey = optionPlaceholderKey(
                group.key,
                option.key,
              );
              const placeholder = t(
                placeholderKey || "",
                option.metadata && option.metadata.placeholder
                  ? String(option.metadata.placeholder)
                  : "",
              );
              textInput.placeholder = placeholder;
              if (
                option.metadata &&
                Number.isFinite(Number(option.metadata.maxLength))
              ) {
                textInput.maxLength = Math.max(
                  1,
                  Math.min(64, Number(option.metadata.maxLength)),
                );
              }
              textInput.style.cssText = `width:180px !important;padding:7px 12px !important;background:${textColors.bgTertiary} !important;color:${textColors.text} !important;border:1px solid ${textColors.border} !important;border-radius:6px !important;font-size:13px !important;box-sizing:border-box !important;transition:border-color 0.2s ease, box-shadow 0.2s ease;`;

              const currentValue = state.draft[group.key][option.key];
              if (
                typeof currentValue !== "undefined" &&
                currentValue !== null
              ) {
                textInput.value = String(currentValue);
              }

              textInput.addEventListener("input", function () {
                state.draft[group.key][option.key] = textInput.value;
                updateSaveState();
                setStatus(t("settings.unsaved", "Unsaved changes"), "#c7d5e0");
              });

              textInput.addEventListener("focus", function () {
                textInput.style.borderColor = textColors.accent + " !important";
                textInput.style.boxShadow = `0 0 0 2px rgba(${textColors.rgbString},0.2)`;
                textInput.style.outline = "none";
              });

              textInput.addEventListener("blur", function () {
                textInput.style.borderColor = textColors.border + " !important";
                textInput.style.boxShadow = "none";
              });

              controlWrap.appendChild(textInput);

              if (option.key === "morrenusApiKey") {
                const statsDiv = document.createElement("div");
                statsDiv.style.cssText =
                  "margin-top:8px;font-size:12px;color:" +
                  textColors.textSecondary +
                  ";width:180px;word-break:break-word;";
                controlWrap.appendChild(statsDiv);

                const updateStats = function (key) {
                  if (!key || key.trim() === "") {
                    statsDiv.innerHTML = "";
                    return;
                  }
                  if (!/^smm_[0-9a-f]{96}$/.test(key)) {
                    statsDiv.innerHTML =
                      "<span style='color:#ff5c5c;'>" +
                      lt("Invalid key format") +
                      "</span>";
                    return;
                  }
                  statsDiv.innerHTML =
                    "<i class='fa-solid fa-spinner' style='animation:spin 1s linear infinite;margin-right:6px;'></i>" +
                    lt("Checking key...");
                  Millennium.callServerMethod("luatools", "GetMorrenusStats", {
                    api_key: key,
                    contentScriptQuery: "",
                  })
                    .then((r) => (typeof r === "string" ? JSON.parse(r) : r))
                    .then((res) => {
                      if (res && res.username) {
                        let expiryText = "";
                        if (res.api_key_expires_at) {
                          const expiry = new Date(res.api_key_expires_at);
                          const now = new Date();
                          const days = Math.max(
                            0,
                            Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)),
                          );
                          expiryText = days + " " + lt("days left");
                        }
                        const usage =
                          typeof res.daily_usage !== "undefined"
                            ? res.daily_usage
                            : "?";
                        const limit =
                          typeof res.daily_limit !== "undefined"
                            ? res.daily_limit
                            : "?";

                        const usageColor =
                          typeof res.daily_usage !== "undefined" &&
                          typeof res.daily_limit !== "undefined" &&
                          res.daily_usage >= res.daily_limit
                            ? "#ff5c5c"
                            : textColors.accent;

                        statsDiv.innerHTML = `
                          <div style="padding:10px;background:rgba(255,255,255,0.04);border:1px solid ${textColors.borderRgba || "rgba(255,255,255,0.1)"};border-radius:8px;">
                            <div style="font-weight:600;margin-bottom:6px;color:${textColors.text};"><i class="fa-solid fa-user" style="margin-right:6px;opacity:0.8;"></i>${res.username}</div>
                            <div style="display:flex;justify-content:space-between;margin-bottom:4px;color:${usageColor};font-weight:500;">
                                <span><i class="fa-solid fa-chart-pie" style="margin-right:6px;"></i>${lt("Usage")}</span>
                                <span>${usage} / ${limit}</span>
                            </div>
                            <div style="display:flex;justify-content:space-between;color:${textColors.textSecondary};">
                                <span><i class="fa-solid fa-clock" style="margin-right:6px;"></i>${lt("Expires")}</span>
                                <span>${expiryText}</span>
                            </div>
                          </div>
                        `;
                      } else {
                        statsDiv.innerHTML =
                          "<span style='color:#ff5c5c;'>" +
                          lt("Invalid or rejected key") +
                          "</span>";
                      }
                    })
                    .catch((e) => {
                      statsDiv.innerHTML =
                        "<span style='color:#ff5c5c;'>" +
                        lt("Failed to verify key") +
                        "</span>";
                    });
                };

                updateStats(textInput.value);

                textInput.addEventListener("input", function () {
                  if (textInput.apiDebounce)
                    clearTimeout(textInput.apiDebounce);
                  textInput.apiDebounce = setTimeout(() => {
                    updateStats(this.value);
                  }, 800);
                });
              }
            } else {
              const unsupported = document.createElement("div");
              unsupported.style.cssText = "font-size:12px;color:#ffb347;";
              unsupported.textContent = lt(
                "common.error.unsupportedOption",
              ).replace("{type}", option.type);
              controlWrap.appendChild(unsupported);
            }
          }
          groupEl.appendChild(optionEl);
        }

        contentWrap.appendChild(groupEl);
      }

      // Render API Toggles section
      renderApiTogglesSection();

      // Render Installed Fixes section
      renderInstalledFixesSection();

      // Render Installed Lua Scripts section
      renderInstalledLuaSection();

      updateSaveState();
    }

    function renderInstalledFixesSection() {
      const sectionEl = document.createElement("div");
      sectionEl.id = "luatools-installed-fixes-section";
      const sectionColors = getThemeColors();
      sectionEl.style.cssText = `margin-top:28px;padding:20px;background:rgba(${sectionColors.rgbString},0.04);border:1px solid ${sectionColors.border};border-radius:10px;`;

      const sectionTitle = document.createElement("div");
      const titleColors = getThemeColors();
      sectionTitle.style.cssText = `font-size:16px;color:${titleColors.text};margin-bottom:14px;font-weight:600;`;
      sectionTitle.innerHTML =
        '<i class="fa-solid fa-wrench" style="margin-right:8px;color:#66c0f4;"></i>' +
        t("settings.installedFixes.title", "Installed Fixes");
      sectionEl.appendChild(sectionTitle);

      const listContainer = document.createElement("div");
      listContainer.id = "luatools-fixes-list";
      listContainer.style.cssText = "min-height:50px;";
      sectionEl.appendChild(listContainer);

      contentWrap.appendChild(sectionEl);

      loadInstalledFixes(listContainer);
    }

    function renderFixesList() {
      const container = document.getElementById("luatools-fixes-list");
      if (!container) return;

      const query = state.searchQuery || "";
      const filteredFixes = state.fixes.filter(function(fix) {
          if (!query) return true;
          const gameNameText = fix.gameName || "Unknown Game";
          const searchText = (gameNameText + " " + fix.appid + " " + (fix.fixType || "") + " fix").toLowerCase();
          return searchText.includes(query);
      });

      const itemsPerPage = 10;
      const totalPages = Math.max(1, Math.ceil(filteredFixes.length / itemsPerPage));
      if (state.fixesPage < 1) state.fixesPage = 1;
      if (state.fixesPage > totalPages) state.fixesPage = totalPages;

      container.innerHTML = "";

      if (filteredFixes.length === 0) {
        const emptyColors = getThemeColors();
        const msg = query ? t("settings.search.noResults", "No matches found") : t("settings.installedFixes.empty", "No fixes installed yet.");
        container.innerHTML = `<div class="search-empty-state" style="padding:16px;background:rgba(${emptyColors.rgbString},0.03);border:1px solid ${emptyColors.border};border-radius:8px;color:${emptyColors.textSecondary};text-align:center;font-size:13px;">${msg}</div>`;
        return;
      }

      const startIndex = (state.fixesPage - 1) * itemsPerPage;
      const pageItems = filteredFixes.slice(startIndex, startIndex + itemsPerPage);

      for (let i = 0; i < pageItems.length; i++) {
        const fix = pageItems[i];
        const fixEl = createFixListItem(fix, container);
        container.appendChild(fixEl);
      }

      if (totalPages > 1) {
         const paginationDiv = document.createElement("div");
         paginationDiv.style.cssText = "display:flex;justify-content:center;align-items:center;margin-top:14px;gap:15px;margin-bottom:10px;";
         
         const btnColors = getThemeColors();
         
         const prevBtn = document.createElement("a");
         prevBtn.href = "#";
         prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
         prevBtn.style.cssText = `padding:5px 12px;color:${btnColors.accent};text-decoration:none;border-radius:4px;background:rgba(${btnColors.rgbString},0.1);transition:all 0.15s ease;`;
         if (state.fixesPage <= 1) {
            prevBtn.style.opacity = "0.5";
            prevBtn.style.pointerEvents = "none";
         }
         prevBtn.onclick = function(e) { e.preventDefault(); state.fixesPage--; renderFixesList(); };

         const pageInfo = document.createElement("span");
         pageInfo.style.cssText = `color:${btnColors.textSecondary};font-size:13px;`;
         pageInfo.textContent = t("settings.pagination", "Page {page} of {total}").replace("{page}", state.fixesPage).replace("{total}", totalPages);

         const nextBtn = document.createElement("a");
         nextBtn.href = "#";
         nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
         nextBtn.style.cssText = `padding:5px 12px;color:${btnColors.accent};text-decoration:none;border-radius:4px;background:rgba(${btnColors.rgbString},0.1);transition:all 0.15s ease;`;
         if (state.fixesPage >= totalPages) {
            nextBtn.style.opacity = "0.5";
            nextBtn.style.pointerEvents = "none";
         }
         nextBtn.onclick = function(e) { e.preventDefault(); state.fixesPage++; renderFixesList(); };

         paginationDiv.appendChild(prevBtn);
         paginationDiv.appendChild(pageInfo);
         paginationDiv.appendChild(nextBtn);
         container.appendChild(paginationDiv);
      }
    }

    function loadInstalledFixes(container) {
      const loadingColors = getThemeColors();
      container.innerHTML = `<div style="padding:16px;text-align:center;color:${loadingColors.textSecondary};font-size:13px;">${t("settings.installedFixes.loading", "Scanning for installed fixes...")}</div>`;

      Millennium.callServerMethod("luatools", "GetInstalledFixes", {
        contentScriptQuery: "",
      })
        .then(function (res) {
          const response = typeof res === "string" ? JSON.parse(res) : res;
          backendLog(
            "LuaTools: GetInstalledFixes response: " +
              JSON.stringify(response).substring(0, 200),
          );
          if (!response || !response.success) {
            backendLog(
              "LuaTools: GetInstalledFixes failed - response: " +
                JSON.stringify(response),
            );
            const errColors = getThemeColors();
            container.innerHTML = `<div style="padding:14px;background:rgba(255,92,92,0.08);border:1px solid rgba(255,92,92,0.3);border-radius:8px;color:#ff5c5c;text-align:center;font-size:13px;">${t("settings.installedFixes.error", "Failed to load installed fixes.")}</div>`;
            return;
          }

          state.fixes = Array.isArray(response.fixes) ? response.fixes : [];
          state.fixesPage = 1;
          renderFixesList();
        })
        .catch(function (err) {
          backendLog("LuaTools: GetInstalledFixes catch error: " + err);
          const catchColors = getThemeColors();
          container.innerHTML = `<div style="padding:14px;background:rgba(255,92,92,0.08);border:1px solid rgba(255,92,92,0.3);border-radius:8px;color:#ff5c5c;text-align:center;font-size:13px;">${t("settings.installedFixes.error", "Failed to load installed fixes.")}</div>`;
        });
    }

    function createFixListItem(fix, container) {
      const itemEl = document.createElement("div");
      const itemColors = getThemeColors();
      const accentColor = itemColors.accent || "#1a9fff";
      itemEl.style.cssText = `padding:14px 16px;background:rgba(${itemColors.rgbString},0.04);border:1px solid ${itemColors.border};border-radius:8px;display:flex;justify-content:space-between;align-items:center;transition:all 0.15s ease;`;

      itemEl.onmouseover = function () {
        const c = getThemeColors();
        this.style.borderColor = c.accent;
        this.style.background = `rgba(${c.rgbString},0.08)`;
      };
      itemEl.onmouseout = function () {
        const c = getThemeColors();
        this.style.borderColor = c.border;
        this.style.background = `rgba(${c.rgbString},0.04)`;
      };

      // Add search data attributes
      itemEl.dataset.fixItem = fix.appid;
      const gameNameText = fix.gameName || "Unknown Game";
      itemEl.dataset.searchText = (
        gameNameText +
        " " +
        fix.appid +
        " " +
        (fix.fixType || "") +
        " fix"
      ).toLowerCase();

      const infoDiv = document.createElement("div");
      infoDiv.style.cssText = "flex:1;padding-right:15px;";

      const gameName = document.createElement("div");
      const nameColors = getThemeColors();
      gameName.style.cssText = `font-size:15px;font-weight:600;color:${nameColors.text};margin-bottom:3px;`;
      gameName.textContent = gameNameText;
      infoDiv.appendChild(gameName);

      if (!fix.gameName || fix.gameName.startsWith("Unknown Game")) {
        fetchSteamGameName(fix.appid).then(function (name) {
          if (name) {
            fix.gameName = name;
            gameName.textContent = name;
            itemEl.dataset.searchText = (
              name +
              " " +
              fix.appid +
              " " +
              (fix.fixType || "") +
              " fix"
            ).toLowerCase();
          }
        });
      }

      const detailsDiv = document.createElement("div");
      const detailsColors = getThemeColors();
      detailsDiv.style.cssText = `font-size:12px;color:${detailsColors.textSecondary};display:flex;flex-wrap:wrap;gap:10px;`;

      if (fix.fixType) {
        const typeSpan = document.createElement("div");
        const typeColors = getThemeColors();
        typeSpan.innerHTML = `<i class="fa-solid fa-layer-group" style="margin-right:4px;color:${typeColors.accent};opacity:0.6;"></i>${fix.fixType}`;
        detailsDiv.appendChild(typeSpan);
      }

      if (fix.date) {
        const dateSpan = document.createElement("div");
        const dateColors = getThemeColors();
        dateSpan.innerHTML = `<i class="fa-solid fa-calendar-days" style="margin-right:5px;color:${dateColors.accent};opacity:0.7;"></i>${fix.date}`;
        detailsDiv.appendChild(dateSpan);
      }

      if (fix.filesCount > 0) {
        const filesSpan = document.createElement("div");
        const filesColors = getThemeColors();
        filesSpan.innerHTML = `<i class="fa-solid fa-file-code" style="margin-right:5px;color:${filesColors.accent};opacity:0.7;"></i>${t("settings.installedFixes.files", "{count} files").replace("{count}", fix.filesCount)}`;
        detailsDiv.appendChild(filesSpan);
      }

      infoDiv.appendChild(detailsDiv);
      itemEl.appendChild(infoDiv);

      const fixDeleteBtn = document.createElement("a");
      fixDeleteBtn.href = "#";
      fixDeleteBtn.style.cssText =
        "display:flex;align-items:center;justify-content:center;width:38px;height:38px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);border-radius:8px;color:#ff5050;font-size:15px;text-decoration:none;transition:all 0.15s ease;cursor:pointer;flex-shrink:0;";
      fixDeleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
      fixDeleteBtn.title = t("settings.installedFixes.delete", "Remove");
      fixDeleteBtn.onmouseover = function () {
        this.style.background = "rgba(255,80,80,0.2)";
        this.style.borderColor = "rgba(255,80,80,0.5)";
        this.style.color = "#ff6b6b";
      };
      fixDeleteBtn.onmouseout = function () {
        this.style.background = "rgba(255,80,80,0.1)";
        this.style.borderColor = "rgba(255,80,80,0.3)";
        this.style.color = "#ff5050";
      };

      fixDeleteBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (fixDeleteBtn.dataset.busy === "1") return;

        showLuaToolsConfirm(
          fix.gameName || "LuaTools",
          t(
            "settings.installedFixes.deleteConfirm",
            "Are you sure you want to remove this fix? This will delete fix files and run Steam verification.",
          ),
          function () {
            // User confirmed
            fixDeleteBtn.dataset.busy = "1";
            fixDeleteBtn.style.opacity = "0.6";
            fixDeleteBtn.innerHTML =
              '<i class="fa-solid fa-spinner fa-spin"></i>';

            Millennium.callServerMethod("luatools", "UnFixGame", {
              appid: fix.appid,
              installPath: fix.installPath || "",
              fixDate: fix.date || "",
              contentScriptQuery: "",
            })
              .then(function (res) {
                const response =
                  typeof res === "string" ? JSON.parse(res) : res;
                if (!response || !response.success) {
                  alert(
                    t(
                      "settings.installedFixes.deleteError",
                      "Failed to remove fix.",
                    ),
                  );
                  fixDeleteBtn.dataset.busy = "0";
                  fixDeleteBtn.style.opacity = "1";
                  fixDeleteBtn.innerHTML =
                    '<span><i class="fa-solid fa-trash"></i> ' +
                    t("settings.installedFixes.delete", "Delete") +
                    "</span>";
                  return;
                }

                // Poll for unfix status
                pollUnfixStatus(fix.appid, itemEl, fixDeleteBtn, container);
              })
              .catch(function (err) {
                alert(
                  t(
                    "settings.installedFixes.deleteError",
                    "Failed to remove fix.",
                  ) +
                    " " +
                    (err && err.message ? err.message : ""),
                );
                fixDeleteBtn.dataset.busy = "0";
                fixDeleteBtn.style.opacity = "1";
                fixDeleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
              });
          },
          function () {
            // User cancelled - do nothing
          },
        );
      });

      itemEl.appendChild(fixDeleteBtn);
      return itemEl;
    }

    function pollUnfixStatus(appid, itemEl, deleteBtn, container) {
      let pollCount = 0;
      const maxPolls = 60;

      function checkStatus() {
        if (pollCount >= maxPolls) {
          alert(
            t("settings.installedFixes.deleteError", "Failed to remove fix.") +
              " (Timeout)",
          );
          deleteBtn.dataset.busy = "0";
          deleteBtn.style.opacity = "1";
          deleteBtn.innerHTML =
            '<span><i class="fa-solid fa-trash"></i> ' +
            t("settings.installedFixes.delete", "Delete") +
            "</span>";
          return;
        }

        pollCount++;

        Millennium.callServerMethod("luatools", "GetUnfixStatus", {
          appid: appid,
          contentScriptQuery: "",
        })
          .then(function (res) {
            const response = typeof res === "string" ? JSON.parse(res) : res;
            if (!response || !response.success) {
              setTimeout(checkStatus, 500);
              return;
            }

            const state = response.state || {};
            const status = state.status;

            if (status === "done" && state.success) {
              // Success - remove item from list with animation
              itemEl.style.transition = "all 0.3s ease";
              itemEl.style.opacity = "0";
              itemEl.style.transform = "translateX(-20px)";
              setTimeout(function () {
                itemEl.remove();
                // Check if list is now empty
                if (container.children.length === 0) {
                  const emptyFixesColors = getThemeColors();
                  container.innerHTML = `<div style="padding:14px;background:${emptyFixesColors.bgTertiary};border:1px solid ${emptyFixesColors.border};border-radius:4px;color:${emptyFixesColors.textSecondary};text-align:center;">${t("settings.installedFixes.empty", "No fixes installed yet.")}</div>`;
                }
              }, 300);

              // Trigger Steam verification after a short delay
              setTimeout(function () {
                try {
                  const verifyUrl = "steam://validate/" + appid;
                  window.location.href = verifyUrl;
                  backendLog("LuaTools: Running verify for appid " + appid);
                } catch (_) {}
              }, 1000);

              return;
            } else if (
              status === "failed" ||
              (status === "done" && !state.success)
            ) {
              alert(
                t(
                  "settings.installedFixes.deleteError",
                  "Failed to remove fix.",
                ) +
                  " " +
                  (state.error || ""),
              );
              fixDeleteBtn.dataset.busy = "1";
              fixDeleteBtn.style.opacity = "0.6";
              fixDeleteBtn.innerHTML =
                '<span><i class="fa-solid fa-trash"></i> ' +
                t("settings.installedFixes.delete", "Delete") +
                "</span>";
              return;
            } else {
              // Still in progress
              setTimeout(checkStatus, 500);
            }
          })
          .catch(function (err) {
            setTimeout(checkStatus, 500);
          });
      }

      checkStatus();
    }

    function renderApiTogglesSection() {
      const c = getThemeColors();
      const sectionEl = document.createElement("div");
      sectionEl.id = "luatools-api-toggles-section";
      sectionEl.style.cssText = `margin-top:28px;padding:20px;background:rgba(${c.rgbString},0.04);border:1px solid ${c.border};border-radius:10px;`;

      const sectionTitle = document.createElement("div");
      sectionTitle.style.cssText = `font-size:16px;color:${c.text};margin-bottom:6px;font-weight:600;`;
      sectionTitle.innerHTML = '<i class="fa-solid fa-plug" style="margin-right:8px;color:' + c.accent + ';"></i>' + t("settings.apiToggles.title", "Download Sources");
      sectionEl.appendChild(sectionTitle);

      const sectionDesc = document.createElement("div");
      sectionDesc.style.cssText = `font-size:12px;color:${c.textSecondary};margin-bottom:14px;`;
      sectionDesc.textContent = t("settings.apiToggles.desc", "Toggle which download sources are active. Click a name to rename. Disabled sources will be skipped.");
      sectionEl.appendChild(sectionDesc);

      const listEl = document.createElement("div");
      listEl.id = "luatools-api-list";
      listEl.innerHTML = `<div style="padding:10px;text-align:center;color:${c.textSecondary};font-size:13px;">Loading...</div>`;
      sectionEl.appendChild(listEl);

      contentWrap.appendChild(sectionEl);

      Millennium.callServerMethod("luatools", "GetAllApis", { contentScriptQuery: "" })
        .then(function(res) {
          const payload = typeof res === "string" ? JSON.parse(res) : res;
          if (!payload || !payload.success || !Array.isArray(payload.apis)) {
            alert("Payload error in GetAllApis: " + JSON.stringify(payload));
            listEl.innerHTML = `<div style="color:#ff5c5c;font-size:13px;padding:10px;">${t("settings.apiToggles.error", "Failed to load APIs.")}</div>`;
            return;
          }
          listEl.innerHTML = "";
          if (payload.apis.length === 0) {
            listEl.innerHTML = `<div style="color:${getThemeColors().textSecondary};font-size:13px;padding:10px;">${t("settings.apiToggles.empty", "No APIs configured.")}</div>`;
          } else {
          payload.apis.forEach(function(api) {
            // currentName tracks renames so other ops reference the right key
            let currentName = api.name;

            const row = document.createElement("div");
            const rc = getThemeColors();
            row.style.cssText = `display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(${rc.rgbString},0.04);border:1px solid ${rc.border};border-radius:8px;margin-bottom:8px;transition:all 0.2s ease;`;
            row.draggable = false;
            
            // Reorder tracking
            // Since currentName can change if the user renames the API, we update dataset.apiName on rename
            row.dataset.apiName = currentName;

            // Drag Events
            row.addEventListener('dragstart', function(e) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', currentName);
                row.classList.add('luatools-dragging');
                row.style.opacity = '0.5';
            });
            row.addEventListener('dragend', function() {
                row.classList.remove('luatools-dragging');
                row.style.opacity = '1';
                row.draggable = false;
                Array.from(listEl.children).forEach(function(c) {
                  if(c.dataset.apiName) {
                     c.style.borderTopColor = rc.border;
                     c.style.borderBottomColor = rc.border;
                  }
                });
                
                // Collect new order and save ONLY once drag is completed
                const newOrder = Array.from(listEl.children)
                  .filter(function(c) { return c.dataset.apiName; })
                  .map(function(c) { return c.dataset.apiName; });
                
                Millennium.callServerMethod("luatools", "ReorderApis", { apiNames: JSON.stringify(newOrder), contentScriptQuery: "" })
                  .then(function(r) {
                    const rp = typeof r === "string" ? JSON.parse(r) : r;
                    if (!rp || !rp.success) {
                        alert("ReorderApis Failed: " + JSON.stringify(rp));
                    }
                  })
                  .catch(function(err){ alert("ReorderApis Error: " + err); });
            });
            row.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const dragging = listEl.querySelector('.luatools-dragging');
                if (dragging && dragging !== row) {
                   const bounding = row.getBoundingClientRect();
                   const offset = bounding.y + (bounding.height / 2);
                   if (e.clientY - offset > 0) {
                      row.style.borderBottomColor = rc.accent;
                      row.style.borderTopColor = rc.border;
                   } else {
                      row.style.borderTopColor = rc.accent;
                      row.style.borderBottomColor = rc.border;
                   }
                }
                return false;
            });
            row.addEventListener('dragleave', function(e) {
                row.style.borderTopColor = rc.border;
                row.style.borderBottomColor = rc.border;
            });
            row.addEventListener('drop', function(e) {
                e.stopPropagation();
                row.style.borderTopColor = rc.border;
                row.style.borderBottomColor = rc.border;

                const dragging = listEl.querySelector('.luatools-dragging');
                if (dragging && dragging !== row) {
                   const bounding = row.getBoundingClientRect();
                   const offset = bounding.y + (bounding.height / 2);
                   if (e.clientY - offset > 0) {
                      row.after(dragging);
                   } else {
                      row.before(dragging);
                   }
                }
                return false;
            });

            // ── Drag handle ────────────────────────────────────────────
            const handle = document.createElement("div");
            handle.innerHTML = '<i class="fa-solid fa-grip-vertical"></i>';
            handle.style.cssText = `color:${rc.textSecondary};cursor:grab;padding:0 5px;font-size:14px;opacity:0.5;transition:opacity 0.2s;`;
            handle.onmouseover = function() { this.style.opacity = "1"; };
            handle.onmouseout = function() { this.style.opacity = "0.5"; };
            handle.onmousedown = function() { row.draggable = true; };
            handle.onmouseup = function() { row.draggable = false; };
            handle.onmouseleave = function() { row.draggable = false; };
            row.appendChild(handle);

            // ── Editable name ──────────────────────────────────────────
            const nameWrap = document.createElement("div");
            nameWrap.style.cssText = "flex:1;min-width:0;";

            const nameDisplay = document.createElement("span");
            nameDisplay.style.cssText = `font-size:14px;color:${rc.text};font-weight:500;cursor:pointer;border-bottom:1px dashed transparent;transition:border-color 0.15s;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
            nameDisplay.title = t("settings.apiToggles.clickToRename", "Click to rename");
            nameDisplay.textContent = currentName;
            nameDisplay.onmouseover = function() { this.style.borderBottomColor = getThemeColors().accent; };
            nameDisplay.onmouseout  = function() { this.style.borderBottomColor = "transparent"; };

            nameDisplay.onclick = function() {
              // Switch to input
              const input = document.createElement("input");
              input.type = "text";
              input.value = currentName;
              const ic = getThemeColors();
              input.style.cssText = `font-size:14px;font-weight:500;color:${ic.text};background:rgba(${ic.rgbString},0.12);border:1px solid ${ic.accent};border-radius:4px;padding:2px 8px;outline:none;width:100%;box-sizing:border-box;`;
              nameWrap.replaceChild(input, nameDisplay);
              input.focus();
              input.select();

              function commitRename() {
                const newVal = input.value.trim();
                if (newVal && newVal !== currentName) {
                  Millennium.callServerMethod("luatools", "RenameApi", { old_name: currentName, new_name: newVal, contentScriptQuery: "" })
                    .then(function(r) {
                      const rp = typeof r === "string" ? JSON.parse(r) : r;
                      if (rp && rp.success) {
                        currentName = newVal;
                        row.dataset.apiName = newVal;
                        nameDisplay.textContent = newVal;
                      }
                    }).catch(function() {});
                }
                nameDisplay.textContent = currentName;
                nameWrap.replaceChild(nameDisplay, input);
              }

              input.onblur = commitRename;
              input.onkeydown = function(e) {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") { nameWrap.replaceChild(nameDisplay, input); }
              };
            };

            nameWrap.appendChild(nameDisplay);
            row.appendChild(nameWrap);

            // ── Toggle pill ────────────────────────────────────────────
            const pill = document.createElement("div");
            const isEnabled = api.enabled !== false;
            pill.style.cssText = `width:42px;height:22px;border-radius:11px;cursor:pointer;transition:background 0.2s ease;background:${isEnabled ? rc.accent : "rgba(255,255,255,0.15)"};position:relative;flex-shrink:0;`;
            const knob = document.createElement("div");
            knob.style.cssText = `position:absolute;top:3px;left:${isEnabled ? "22px" : "3px"};width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s ease;box-shadow:0 1px 3px rgba(0,0,0,0.4);`;
            pill.appendChild(knob);
            pill.dataset.enabled = isEnabled ? "1" : "0";
            pill.title = t("settings.apiToggles.toggle", "Enable / disable");

            pill.onclick = function() {
              const nowEnabled = pill.dataset.enabled !== "1";
              pill.dataset.enabled = nowEnabled ? "1" : "0";
              const tc = getThemeColors();
              pill.style.background = nowEnabled ? tc.accent : "rgba(255,255,255,0.15)";
              knob.style.left = nowEnabled ? "22px" : "3px";
              Millennium.callServerMethod("luatools", "ToggleApi", { apiName: currentName, contentScriptQuery: "" })
                .then(function(r) {
                  const rp = typeof r === "string" ? JSON.parse(r) : r;
                  if (!rp || !rp.success) {
                    alert("ToggleApi Failed: " + JSON.stringify(rp));
                    pill.dataset.enabled = nowEnabled ? "0" : "1";
                    pill.style.background = nowEnabled ? "rgba(255,255,255,0.15)" : getThemeColors().accent;
                    knob.style.left = nowEnabled ? "3px" : "22px";
                  }
                }).catch(function(err) {
                  alert("ToggleApi Error: " + err);
                  pill.dataset.enabled = nowEnabled ? "0" : "1";
                  pill.style.background = nowEnabled ? "rgba(255,255,255,0.15)" : getThemeColors().accent;
                  knob.style.left = nowEnabled ? "3px" : "22px";
                });
            };

            row.appendChild(pill);

            // ── Delete button ──────────────────────────────────────────
            const delBtn = document.createElement("a");
            delBtn.href = "#";
            const dc = getThemeColors();
            delBtn.style.cssText = `display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:rgba(255,92,92,0.08);border:1px solid rgba(255,92,92,0.25);color:#ff5c5c;font-size:12px;text-decoration:none;flex-shrink:0;transition:all 0.15s ease;cursor:pointer;`;
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delBtn.title = t("settings.apiToggles.remove", "Remove source");
            delBtn.onmouseover = function() { this.style.background = "rgba(255,92,92,0.2)"; this.style.borderColor = "rgba(255,92,92,0.6)"; };
            delBtn.onmouseout  = function() { this.style.background = "rgba(255,92,92,0.08)"; this.style.borderColor = "rgba(255,92,92,0.25)"; };

            delBtn.onclick = function(e) {
              e.preventDefault();
              if (delBtn.dataset.busy === "1") return;
              delBtn.dataset.busy = "1";
              delBtn.style.opacity = "0.5";
              Millennium.callServerMethod("luatools", "RemoveApi", { apiName: currentName, contentScriptQuery: "" })
                .then(function(r) {
                  const rp = typeof r === "string" ? JSON.parse(r) : r;
                  if (rp && rp.success) {
                    row.style.opacity = "0";
                    row.style.transform = "translateX(10px)";
                    setTimeout(function() { row.remove(); }, 200);
                  } else {
                    alert("RemoveApi Failed: " + JSON.stringify(rp));
                    delBtn.dataset.busy = "0";
                    delBtn.style.opacity = "1";
                  }
                }).catch(function(err) {
                  alert("RemoveApi Error: " + err);
                  delBtn.dataset.busy = "0";
                  delBtn.style.opacity = "1";
                });
            };

            row.appendChild(delBtn);
            listEl.appendChild(row);
          }); // end forEach
          } // end else

        })
        .catch(function(err) {
          alert("GetAllApis Catch Error: " + err);
          listEl.innerHTML = `<div style="color:#ff5c5c;font-size:13px;padding:10px;">${t("settings.apiToggles.error", "Failed to load APIs.")}</div>`;
        });
    }

    function renderLuaList() {
      const container = document.getElementById("luatools-lua-list");
      if (!container) return;

      const query = state.searchQuery || "";
      const filteredLuas = state.luas.filter(function(s) {
        if (!query) return true;
        const gameNameText = s.gameName || "Unknown Game";
        const searchText = (gameNameText + " " + s.appid + " lua script").toLowerCase();
        return searchText.includes(query);
      });

      const itemsPerPage = state.luasPerPage || 10;
      const totalPages = Math.max(1, Math.ceil(filteredLuas.length / itemsPerPage));
      if (state.luasPage < 1) state.luasPage = 1;
      if (state.luasPage > totalPages) state.luasPage = totalPages;

      container.innerHTML = "";

      if (filteredLuas.length === 0) {
        const ec = getThemeColors();
        const msg = query ? t("settings.search.noResults", "No matches found") : t("settings.installedLua.empty", "No Lua scripts installed yet.");
        container.innerHTML = `<div class="search-empty-state" style="padding:16px;background:rgba(${ec.rgbString},0.03);border:1px solid ${ec.border};border-radius:8px;color:${ec.textSecondary};text-align:center;font-size:13px;">${msg}</div>`;
        return;
      }

      const startIndex = (state.luasPage - 1) * itemsPerPage;
      const pageItems = filteredLuas.slice(startIndex, startIndex + itemsPerPage);

      for (let i = 0; i < pageItems.length; i++) {
        container.appendChild(createLuaListItem(pageItems[i], container));
      }

      if (totalPages > 1) {
        const paginationDiv = document.createElement("div");
        paginationDiv.style.cssText = "display:flex;justify-content:center;align-items:center;margin-top:14px;gap:15px;margin-bottom:10px;";
        const bc = getThemeColors();

        const prevBtn = document.createElement("a");
        prevBtn.href = "#";
        prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
        prevBtn.style.cssText = `padding:5px 12px;color:${bc.accent};text-decoration:none;border-radius:4px;background:rgba(${bc.rgbString},0.1);transition:all 0.15s ease;`;
        if (state.luasPage <= 1) { prevBtn.style.opacity = "0.5"; prevBtn.style.pointerEvents = "none"; }
        prevBtn.onclick = function(e) { e.preventDefault(); state.luasPage--; renderLuaList(); };

        const pageInfo = document.createElement("span");
        pageInfo.style.cssText = `color:${bc.textSecondary};font-size:13px;`;
        pageInfo.textContent = t("settings.pagination", "Page {page} of {total}").replace("{page}", state.luasPage).replace("{total}", totalPages);

        const nextBtn = document.createElement("a");
        nextBtn.href = "#";
        nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
        nextBtn.style.cssText = `padding:5px 12px;color:${bc.accent};text-decoration:none;border-radius:4px;background:rgba(${bc.rgbString},0.1);transition:all 0.15s ease;`;
        if (state.luasPage >= totalPages) { nextBtn.style.opacity = "0.5"; nextBtn.style.pointerEvents = "none"; }
        nextBtn.onclick = function(e) { e.preventDefault(); state.luasPage++; renderLuaList(); };

        paginationDiv.appendChild(prevBtn);
        paginationDiv.appendChild(pageInfo);
        paginationDiv.appendChild(nextBtn);
        container.appendChild(paginationDiv);
      }
    }

    function renderInstalledLuaSection() {
      const sectionEl = document.createElement("div");
      sectionEl.id = "luatools-installed-lua-section";
      const sectionLuaColors = getThemeColors();
      sectionEl.style.cssText = `margin-top:28px;padding:20px;background:rgba(${sectionLuaColors.rgbString},0.04);border:1px solid ${sectionLuaColors.border};border-radius:10px;`;

      const sectionTitleContainer = document.createElement("div");
      sectionTitleContainer.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;";

      const sectionTitle = document.createElement("div");
      const luaTitleColors = getThemeColors();
      sectionTitle.style.cssText = `font-size:16px;color:${luaTitleColors.text};font-weight:600;`;
      sectionTitle.innerHTML =
        '<i class="fa-solid fa-code" style="margin-right:8px;color:#ffc107;"></i>' +
        t("settings.installedLua.title", "Installed Lua Scripts");
      sectionTitleContainer.appendChild(sectionTitle);

      const perPageSelect = document.createElement("select");
      perPageSelect.style.cssText = `background:rgba(${luaTitleColors.rgbString},0.08);color:${luaTitleColors.text};border:1px solid ${luaTitleColors.border};border-radius:6px;padding:4px 8px;font-size:12px;outline:none;cursor:pointer;width:fit-content;`;
      [5, 10, 25, 50, 100].forEach(function(val) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = val + " " + t("settings.perPage", "per page");
        if (val === state.luasPerPage) opt.selected = true;
        opt.style.background = luaTitleColors.bgTertiary || "#1a1a1a";
        opt.style.color = luaTitleColors.text;
        perPageSelect.appendChild(opt);
      });
      perPageSelect.onchange = function(e) {
        state.luasPerPage = parseInt(e.target.value, 10);
        state.luasPage = 1;
        renderLuaList();
      };
      sectionTitleContainer.appendChild(perPageSelect);

      sectionEl.appendChild(sectionTitleContainer);

      const listContainer = document.createElement("div");
      listContainer.id = "luatools-lua-list";
      listContainer.style.cssText = "min-height:50px;";
      sectionEl.appendChild(listContainer);

      contentWrap.appendChild(sectionEl);

      loadInstalledLuaScripts(listContainer);
    }

    function loadInstalledLuaScripts(container) {
      const loadingLuaColors = getThemeColors();
      container.innerHTML =
        `<div style="padding:16px;text-align:center;color:${loadingLuaColors.textSecondary};font-size:13px;">` +
        t("settings.installedLua.loading", "Scanning for installed Lua scripts...") +
        "</div>";

      Millennium.callServerMethod("luatools", "GetInstalledLuaScripts", {
        contentScriptQuery: "",
      })
        .then(function (res) {
          const response = typeof res === "string" ? JSON.parse(res) : res;
          if (!response || !response.success) {
            container.innerHTML = `<div style="padding:14px;background:rgba(255,92,92,0.08);border:1px solid rgba(255,92,92,0.3);border-radius:8px;color:#ff5c5c;text-align:center;font-size:13px;">${t("settings.installedLua.error", "Failed to load installed Lua scripts.")}</div>`;
            return;
          }

          state.luas = Array.isArray(response.scripts) ? response.scripts : [];
          state.luasPage = 1;
          renderLuaList();
        })
        .catch(function (err) {
          container.innerHTML = `<div style="padding:14px;background:rgba(255,92,92,0.08);border:1px solid rgba(255,92,92,0.3);border-radius:8px;color:#ff5c5c;text-align:center;font-size:13px;">${t("settings.installedLua.error", "Failed to load installed Lua scripts.")}</div>`;
        });
    }

    function createLuaListItem(script, container) {
      const itemEl = document.createElement("div");
      const itemLuaColors = getThemeColors();
      itemEl.style.cssText = `padding:14px 16px;background:rgba(${itemLuaColors.rgbString},0.04);border:1px solid ${itemLuaColors.border};border-radius:8px;display:flex;justify-content:space-between;align-items:center;transition:all 0.15s ease;`;

      itemEl.onmouseover = function () {
        const c = getThemeColors();
        this.style.borderColor = c.accent;
        this.style.background = `rgba(${c.rgbString},0.08)`;
      };
      itemEl.onmouseout = function () {
        const c = getThemeColors();
        this.style.borderColor = c.border;
        this.style.background = `rgba(${c.rgbString},0.04)`;
      };

      // Add search data attributes
      itemEl.dataset.luaItem = script.appid;
      const gameNameText = script.gameName || "Unknown Game";
      itemEl.dataset.searchText = (
        gameNameText +
        " " +
        script.appid +
        " lua script" +
        (script.isDisabled ? " disabled" : "")
      ).toLowerCase();

      const infoDiv = document.createElement("div");
      infoDiv.style.cssText = "flex:1;padding-right:15px;";

      const gameName = document.createElement("div");
      const gameNameLuaColors = getThemeColors();
      gameName.style.cssText = `font-size:15px;font-weight:600;color:${gameNameLuaColors.text};margin-bottom:3px;display:flex;align-items:center;flex-wrap:wrap;`;
      gameName.textContent = gameNameText;

      if (!script.gameName || script.gameName.startsWith("Unknown Game")) {
        fetchSteamGameName(script.appid).then(function (name) {
          if (name) {
            script.gameName = name;
            gameName.textContent = name;
            itemEl.dataset.searchText = (
              name +
              " " +
              script.appid +
              " lua script" +
              (script.isDisabled ? " disabled" : "")
            ).toLowerCase();
          }
        });
      }

      if (script.isDisabled) {
        const disabledBadge = document.createElement("span");
        disabledBadge.style.cssText =
          "margin-left:10px;padding:3px 10px;background:rgba(255,193,7,0.15);border:1px solid rgba(255,193,7,0.4);border-radius:20px;font-size:11px;color:#ffc107;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;";
        disabledBadge.textContent = t(
          "settings.installedLua.disabled",
          "Disabled",
        );
        gameName.appendChild(disabledBadge);
      }

      infoDiv.appendChild(gameName);

      const detailsDiv = document.createElement("div");
      const detailsLuaColors = getThemeColors();
      detailsDiv.style.cssText = `font-size:12px;color:${detailsLuaColors.textSecondary};display:flex;flex-wrap:wrap;gap:10px;`;

      if (script.modifiedDate) {
        const dateSpan = document.createElement("div");
        const dateLuaColors = getThemeColors();
        dateSpan.innerHTML = `<i class="fa-solid fa-pen-to-square" style="margin-right:4px;color:${dateLuaColors.accent};opacity:0.6;"></i><strong style="font-weight:500;">${t("settings.installedLua.modified", "Modified:")}</strong> ${script.modifiedDate}`;
        detailsDiv.appendChild(dateSpan);
      }

      infoDiv.appendChild(detailsDiv);
      itemEl.appendChild(infoDiv);

      const luaDeleteBtn = document.createElement("a");
      luaDeleteBtn.href = "#";
      luaDeleteBtn.style.cssText =
        "display:flex;align-items:center;justify-content:center;width:38px;height:38px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);border-radius:8px;color:#ff5050;font-size:15px;text-decoration:none;transition:all 0.15s ease;cursor:pointer;flex-shrink:0;";
      luaDeleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
      luaDeleteBtn.title = t("settings.installedLua.delete", "Remove");
      luaDeleteBtn.onmouseover = function () {
        this.style.background = "rgba(255,80,80,0.2)";
        this.style.borderColor = "rgba(255,80,80,0.5)";
        this.style.color = "#ff6b6b";
      };
      luaDeleteBtn.onmouseout = function () {
        this.style.background = "rgba(255,80,80,0.1)";
        this.style.borderColor = "rgba(255,80,80,0.3)";
        this.style.color = "#ff5050";
        this.style.transform = "translateY(0) scale(1)";
        this.style.boxShadow = "none";
      };

      luaDeleteBtn.addEventListener("click", function (e) {
        e.preventDefault();
        if (luaDeleteBtn.dataset.busy === "1") return;

        showLuaToolsConfirm(
          script.gameName || "LuaTools",
          t(
            "settings.installedLua.deleteConfirm",
            "Remove via LuaTools for this game?",
          ),
          function () {
            // User confirmed
            luaDeleteBtn.dataset.busy = "1";
            luaDeleteBtn.style.opacity = "0.6";
            luaDeleteBtn.innerHTML =
              '<i class="fa-solid fa-spinner fa-spin"></i>';

            Millennium.callServerMethod("luatools", "DeleteLuaToolsForApp", {
              appid: script.appid,
              contentScriptQuery: "",
            })
              .then(function (res) {
                const response =
                  typeof res === "string" ? JSON.parse(res) : res;
                if (!response || !response.success) {
                  alert(
                    t(
                      "settings.installedLua.deleteError",
                      "Failed to remove Lua script.",
                    ),
                  );
                  luaDeleteBtn.dataset.busy = "0";
                  luaDeleteBtn.style.opacity = "1";
                  luaDeleteBtn.innerHTML =
                    '<span><i class="fa-solid fa-trash"></i> ' +
                    t("settings.installedLua.delete", "Delete") +
                    "</span>";
                  return;
                }

                // Success - remove item from list with animation
                itemEl.style.transition = "all 0.3s ease";
                itemEl.style.opacity = "0";
                itemEl.style.transform = "translateX(-20px)";
                setTimeout(function () {
                  itemEl.remove();
                  // Check if list is now empty
                  if (container.children.length === 0) {
                    const emptyLuaColors = getThemeColors();
                    container.innerHTML = `<div style="padding:14px;background:${emptyLuaColors.bgTertiary};border:1px solid ${emptyLuaColors.border};border-radius:4px;color:${emptyLuaColors.textSecondary};text-align:center;">${t("settings.installedLua.empty", "No Lua scripts installed yet.")}</div>`;
                  }
                }, 300);
              })
              .catch(function (err) {
                alert(
                  t(
                    "settings.installedLua.deleteError",
                    "Failed to remove Lua script.",
                  ) +
                    " " +
                    (err && err.message ? err.message : ""),
                );
                luaDeleteBtn.dataset.busy = "0";
                luaDeleteBtn.style.opacity = "1";
                luaDeleteBtn.innerHTML =
                  '<span><i class="fa-solid fa-trash"></i> ' +
                  t("settings.installedLua.delete", "Delete") +
                  "</span>";
              });
          },
          function () {
            // User cancelled - do nothing
          },
        );
      });

      itemEl.appendChild(luaDeleteBtn);
      return itemEl;
    }

    function handleLoad(force) {
      setStatus(t("settings.loading", "Loading settings..."), "#c7d5e0");
      saveBtn.dataset.disabled = "1";
      saveBtn.style.opacity = "0.6";
      contentWrap.innerHTML =
        '<div style="padding:20px;color:#c7d5e0;">' +
        t("common.status.loading", "Loading...") +
        "</div>";

      return fetchSettingsConfig(force)
        .then(function (config) {
          state.config = {
            schemaVersion: config.schemaVersion,
            schema: Array.isArray(config.schema) ? config.schema : [],
            values: initialiseSettingsDraft(config),
            language: config.language,
            locales: config.locales,
          };
          state.draft = initialiseSettingsDraft(config);
          applyStaticTranslations();
          renderSettings();
          setStatus("", "#c7d5e0");
        })
        .catch(function (err) {
          const message =
            err && err.message
              ? err.message
              : t("settings.error", "Failed to load settings.");
          contentWrap.innerHTML =
            '<div style="padding:20px;color:#ff5c5c;">' + message + "</div>";
          setStatus(
            t("common.status.error", "Error") + ": " + message,
            "#ff5c5c",
          );
        });
    }

    backBtn.addEventListener("click", function (e) {
      e.preventDefault();
      if (typeof onBack === "function") {
        overlay.remove();
        onBack();
      }
    });

    rightButtons.appendChild(saveBtn);
    btnRow.appendChild(backBtn);
    btnRow.appendChild(rightButtons);

    saveBtn.addEventListener("click", function (e) {
      e.preventDefault();
      if (saveBtn.dataset.disabled === "1" || saveBtn.dataset.busy === "1")
        return;

      const changes = collectChanges();
      try {
        backendLog(
          "LuaTools: collectChanges payload " + JSON.stringify(changes),
        );
      } catch (_) {}
      if (!changes || Object.keys(changes).length === 0) {
        setStatus(t("settings.noChanges", "No changes to save."), "#c7d5e0");
        updateSaveState();
        return;
      }

      saveBtn.dataset.busy = "1";
      saveBtn.style.opacity = "0.6";
      setStatus(t("settings.saving", "Saving..."), "#c7d5e0");
      saveBtn.style.opacity = "0.6";

      const payloadToSend = JSON.parse(JSON.stringify(changes));
      try {
        backendLog(
          "LuaTools: sending settings payload " + JSON.stringify(payloadToSend),
        );
      } catch (_) {}
      // Pass flattened keys so Millennium handles the RPC arguments as expected.
      Millennium.callServerMethod("luatools", "ApplySettingsChanges", {
        contentScriptQuery: "",
        changesJson: JSON.stringify(payloadToSend),
      })
        .then(function (res) {
          const response = typeof res === "string" ? JSON.parse(res) : res;
          if (!response || response.success !== true) {
            if (response && response.errors) {
              const errorParts = [];
              for (const groupKey in response.errors) {
                if (
                  !Object.prototype.hasOwnProperty.call(
                    response.errors,
                    groupKey,
                  )
                )
                  continue;
                const optionErrors = response.errors[groupKey];
                for (const optionKey in optionErrors) {
                  if (
                    !Object.prototype.hasOwnProperty.call(
                      optionErrors,
                      optionKey,
                    )
                  )
                    continue;
                  const errorMsg = optionErrors[optionKey];
                  errorParts.push(groupKey + "." + optionKey + ": " + errorMsg);
                }
              }
              const errText = errorParts.length
                ? errorParts.join("\n")
                : "Validation failed.";
              setStatus(errText, "#ff5c5c");
            } else {
              const message =
                response && response.error
                  ? response.error
                  : t("settings.saveError", "Failed to save settings.");
              setStatus(message, "#ff5c5c");
            }
            return;
          }

          const newValues =
            response && response.values && typeof response.values === "object"
              ? response.values
              : state.draft;
          state.config.values = initialiseSettingsDraft({
            schema: state.config.schema,
            values: newValues,
          });
          state.draft = initialiseSettingsDraft({
            schema: state.config.schema,
            values: newValues,
          });

          try {
            if (window.__LuaToolsSettings) {
              window.__LuaToolsSettings.values = JSON.parse(
                JSON.stringify(state.config.values),
              );
              window.__LuaToolsSettings.schemaVersion =
                state.config.schemaVersion;
              window.__LuaToolsSettings.lastFetched = Date.now();
              if (
                response &&
                response.translations &&
                typeof response.translations === "object"
              ) {
                window.__LuaToolsSettings.translations = response.translations;
              }
              if (response && response.language) {
                window.__LuaToolsSettings.language = response.language;
              }
            }
          } catch (_) {}

          // Invalidate the settings cache to force a fresh fetch on next settings load
          // This ensures any changes persist across page navigations
          try {
            if (window.__LuaToolsSettings) {
              window.__LuaToolsSettings.schema = null;
            }
          } catch (_) {}

          if (
            response &&
            response.translations &&
            typeof response.translations === "object"
          ) {
            applyTranslationBundle({
              language:
                response.language ||
                (window.__LuaToolsI18n && window.__LuaToolsI18n.language) ||
                "ar",
              locales:
                (window.__LuaToolsI18n && window.__LuaToolsI18n.locales) ||
                (state.config && state.config.locales) ||
                [],
              strings: response.translations,
            });
            applyStaticTranslations();
            updateButtonTranslations();
          }

          renderSettings();
          setStatus(
            t("settings.saveSuccess", "Settings saved successfully."),
            "#8bc34a",
          );

          // Reload theme if it changed
          const oldTheme = state.config.values?.general?.theme;
          const newTheme = state.draft?.general?.theme;
          if (oldTheme !== newTheme) {
            ensureLuaToolsStyles();
          }
        })
        .catch(function (err) {
          const message =
            err && err.message
              ? err.message
              : t("settings.saveError", "Failed to save settings.");
          setStatus(message, "#ff5c5c");
        })
        .finally(function () {
          saveBtn.dataset.busy = "0";
          applyStaticTranslations();
          updateSaveState();
        });
    });

    closeIconBtn.addEventListener("click", function (e) {
      e.preventDefault();
      overlay.remove();
    });

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    handleLoad(!!forceRefresh);
  }

  // Force-close any open settings overlays to avoid stacking
  function closeSettingsOverlay() {
    try {
      // Remove all settings overlays (robust against older NodeList forEach support)
      var list = document.getElementsByClassName("luatools-settings-overlay");
      while (list && list.length > 0) {
        try {
          list[0].remove();
        } catch (_) {
          break;
        }
      }
      // Also remove any download/progress overlays if present
      var list2 = document.getElementsByClassName("luatools-overlay");
      while (list2 && list2.length > 0) {
        try {
          list2[0].remove();
        } catch (_) {
          break;
        }
      }
    } catch (_) {}
  }

  // Custom modern alert dialog
  function showLuaToolsAlert(title, message, onClose) {
    if (document.querySelector(".luatools-alert-overlay")) return;

    ensureLuaToolsStyles();
    ensureFontAwesome();
    const overlay = document.createElement("div");
    overlay.className = "luatools-alert-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:100001;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const alertModalColors = getThemeColors();
    modal.style.cssText = `background:${alertModalColors.modalBg};color:${alertModalColors.text};border:1px solid ${alertModalColors.border};border-radius:16px;width:420px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${alertModalColors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const alertIconWrap = document.createElement("div");
    alertIconWrap.style.cssText = "text-align:center;margin-bottom:12px;";
    const alertIcon = document.createElement("i");
    alertIcon.className = "fa-solid fa-circle-info";
    alertIcon.style.cssText = `color:${alertModalColors.accent};font-size:32px;`;
    alertIconWrap.appendChild(alertIcon);

    const titleEl = document.createElement("div");
    titleEl.style.cssText = `font-size:20px;color:${alertModalColors.text};margin-bottom:12px;font-weight:600;text-align:center;`;
    titleEl.textContent = displayBrandText(String(title || getDisplayBrand()));

    const messageEl = document.createElement("div");
    messageEl.style.cssText = `font-size:14px;line-height:1.6;margin-bottom:24px;color:${alertModalColors.textSecondary};text-align:center;`;
    messageEl.textContent = displayBrandText(String(message || ""));

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:center;";

    const okBtn = document.createElement("a");
    okBtn.href = "#";
    okBtn.className = "luatools-btn primary";
    okBtn.style.cssText =
      "min-width:140px;display:flex;align-items:center;justify-content:center;text-align:center;";
    okBtn.innerHTML = `<span>${lt("Close")}</span>`;
    okBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
      try {
        onClose && onClose();
      } catch (_) {}
    };

    btnRow.appendChild(okBtn);

    modal.appendChild(alertIconWrap);
    modal.appendChild(titleEl);
    modal.appendChild(messageEl);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        overlay.remove();
        try {
          onClose && onClose();
        } catch (_) {}
      }
    });

    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);
  }

  // Helper to show alert with fallback
  function ShowLuaToolsAlert(title, message) {
    try {
      showLuaToolsAlert(displayBrandText(title), displayBrandText(message));
    } catch (err) {
      backendLog("LuaTools: Alert error, falling back: " + err);
      try {
        alert(
          displayBrandText(String(title)) +
            "\n\n" +
            displayBrandText(String(message)),
        );
      } catch (_) {}
    }
  }

  // Steam-style confirm helper (ShowConfirmDialog only)
  function showLuaToolsConfirm(title, message, onConfirm, onCancel) {
    // Always close settings popup first so the confirm is visible on top
    closeSettingsOverlay();

    // Create custom modern confirmation dialog
    if (document.querySelector(".luatools-confirm-overlay")) return;

    ensureLuaToolsStyles();
    ensureFontAwesome();
    const overlay = document.createElement("div");
    overlay.className = "luatools-confirm-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:100001;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const confirmColors = getThemeColors();
    modal.style.cssText = `background:${confirmColors.modalBg};color:${confirmColors.text};border:1px solid ${confirmColors.border};border-radius:16px;width:420px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${confirmColors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const confirmIconWrap = document.createElement("div");
    confirmIconWrap.style.cssText = "text-align:center;margin-bottom:12px;";
    const confirmIcon = document.createElement("i");
    confirmIcon.className = "fa-solid fa-circle-question";
    confirmIcon.style.cssText = `color:${confirmColors.accent};font-size:32px;`;
    confirmIconWrap.appendChild(confirmIcon);

    const titleEl = document.createElement("div");
    titleEl.style.cssText = `font-size:20px;color:${confirmColors.text};margin-bottom:12px;font-weight:600;text-align:center;`;
    titleEl.textContent = displayBrandText(String(title || getDisplayBrand()));

    const messageEl = document.createElement("div");
    messageEl.style.cssText = `font-size:14px;line-height:1.6;margin-bottom:24px;color:${confirmColors.textSecondary};text-align:center;`;
    messageEl.textContent = displayBrandText(
      String(message || lt("Are you sure?")),
    );

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:12px;justify-content:center;";

    const cancelBtn = document.createElement("a");
    cancelBtn.href = "#";
    cancelBtn.className = "luatools-btn";
    cancelBtn.style.cssText =
      "flex:1;display:flex;align-items:center;justify-content:center;text-align:center;";
    cancelBtn.innerHTML = `<span>${lt("Cancel")}</span>`;
    cancelBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
      try {
        onCancel && onCancel();
      } catch (_) {}
    };
    const confirmBtn = document.createElement("a");
    confirmBtn.href = "#";
    confirmBtn.className = "luatools-btn primary";
    confirmBtn.style.cssText =
      "flex:1;display:flex;align-items:center;justify-content:center;text-align:center;";
    confirmBtn.innerHTML = `<span>${lt("Confirm")}</span>`;
    confirmBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
      try {
        onConfirm && onConfirm();
      } catch (_) {}
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);

    modal.appendChild(confirmIconWrap);
    modal.appendChild(titleEl);
    modal.appendChild(messageEl);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        overlay.remove();
        try {
          onCancel && onCancel();
        } catch (_) {}
      }
    });

    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);
  }

  // DLC warning modal
  function showDlcWarning(appid, fullgameAppid, fullgameName) {
    // Close settings so modal is visible
    closeSettingsOverlay();
    if (document.querySelector(".luatools-dlc-warning-overlay")) return;

    ensureLuaToolsStyles();
    ensureFontAwesome();

    const overlay = document.createElement("div");
    overlay.className = "luatools-dlc-warning-overlay luatools-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:100001;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const colors = getThemeColors();
    modal.style.cssText = `background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:420px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const header = document.createElement("div");
    header.style.cssText = "text-align:center;margin-bottom:16px;";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-circle-info";
    icon.style.cssText = `color:${colors.accent};font-size:32px;`;
    header.appendChild(icon);

    const titleEl = document.createElement("div");
    titleEl.style.cssText = `font-size:20px;font-weight:600;text-align:center;margin-bottom:12px;color:${colors.text};`;
    titleEl.textContent = lt("DLC Detected");

    const messageEl = document.createElement("div");
    messageEl.style.cssText = `font-size:14px;line-height:1.6;margin-bottom:24px;color:${colors.textSecondary};text-align:center;`;
    messageEl.innerHTML = lt(
      "DLCs are added together with the base game. To add fixes for this DLC, please go to the base game page: <br><br><b>{gameName}</b>",
    ).replace("{gameName}", fullgameName || lt("Base Game"));

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:12px;justify-content:center;";

    const cancelBtn = document.createElement("a");
    cancelBtn.href = "#";
    cancelBtn.className = "luatools-btn";
    cancelBtn.style.cssText =
      "flex:1;display:flex;align-items:center;justify-content:center;text-align:center;";
    cancelBtn.innerHTML = `<span>${lt("Cancel")}</span>`;
    cancelBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
    };

    const goBtn = document.createElement("a");
    goBtn.href = "https://store.steampowered.com/app/" + fullgameAppid;
    goBtn.className = "luatools-btn primary";
    goBtn.style.cssText =
      "flex:1.5;display:flex;align-items:center;justify-content:center;text-align:center;";
    goBtn.innerHTML = `<span>${lt("Go to Base Game")}</span>`;
    goBtn.onclick = function (e) {
      // Let the default link behavior happen (navigation)
      // But we can also remove the overlay
      setTimeout(() => overlay.remove(), 100);
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(goBtn);

    modal.appendChild(header);
    modal.appendChild(titleEl);
    modal.appendChild(messageEl);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);

    setTimeout(function () {
      if (window.GamepadNav) window.GamepadNav.scanElements();
    }, 150);
  }

  function showLuaToolsPlayableWarning(message, onProceed, onCancel) {
    // Close settings so modal is visible
    closeSettingsOverlay();
    if (document.querySelector(".luatools-playable-warning-overlay")) return;

    ensureLuaToolsStyles();
    ensureFontAwesome();

    const overlay = document.createElement("div");
    overlay.className = "luatools-playable-warning-overlay luatools-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:100001;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const playableColors = getThemeColors();
    modal.style.cssText = `background:${playableColors.modalBg};color:${playableColors.text};border:1px solid ${playableColors.border};border-radius:16px;width:420px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${playableColors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:center;gap:12px;margin-bottom:14px;justify-content:center;";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-triangle-exclamation";
    icon.style.cssText = `color:${playableColors.accent};font-size:22px;`;
    const titleEl = document.createElement("div");
    titleEl.style.cssText = `font-size:18px;font-weight:600;text-align:center;color:${playableColors.text};`;
    titleEl.textContent = t("common.warning", "Warning");
    header.appendChild(icon);
    header.appendChild(titleEl);

    const messageEl = document.createElement("div");
    messageEl.style.cssText = `font-size:14px;line-height:1.5;margin-bottom:20px;color:${playableColors.textSecondary};text-align:center;padding:0 6px;`;
    messageEl.textContent = String(
      message ||
        "This game may not work, support for it wont be given in our discord",
    );

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:12px;justify-content:center;";

    const cancelBtn = document.createElement("a");
    cancelBtn.href = "#";
    cancelBtn.className = "luatools-btn";
    cancelBtn.style.cssText =
      "flex:1;display:flex;align-items:center;justify-content:center;text-align:center;";
    cancelBtn.innerHTML = `<span>${lt("Cancel")}</span>`;
    cancelBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
      try {
        onCancel && onCancel();
      } catch (_) {}
    };

    const proceedBtn = document.createElement("a");
    proceedBtn.href = "#";
    proceedBtn.className = "luatools-btn primary";
    proceedBtn.style.cssText =
      "flex:1;display:flex;align-items:center;justify-content:center;text-align:center;";
    proceedBtn.innerHTML = `<span>${lt("Proceed")}</span>`;
    proceedBtn.onclick = function (e) {
      e.preventDefault();
      overlay.remove();
      try {
        onProceed && onProceed();
      } catch (_) {}
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(proceedBtn);

    modal.appendChild(header);
    modal.appendChild(messageEl);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        overlay.remove();
        try {
          onCancel && onCancel();
        } catch (_) {}
      }
    });

    document.body.appendChild(overlay);

    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);
  }

  // Millennium disclaimer modal
  function showMillenniumDisclaimerModal() {
    if (document.querySelector(".luatools-disclaimer-overlay")) return;

    ensureLuaToolsStyles();
    ensureFontAwesome();

    const overlay = document.createElement("div");
    overlay.className = "luatools-disclaimer-overlay luatools-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(12px);z-index:100005;display:flex;align-items:center;justify-content:center;";

    const modal = document.createElement("div");
    const disclaimerColors = getThemeColors();
    modal.style.cssText = `background:${disclaimerColors.modalBg};color:${disclaimerColors.text};border:1px solid ${disclaimerColors.border};border-radius:16px;width:460px;padding:28px 32px;box-shadow:0 24px 80px rgba(0,0,0,.65), 0 0 0 1px ${disclaimerColors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const iconContainer = document.createElement("div");
    iconContainer.style.cssText = "text-align:center;margin-bottom:16px;";
    const icon = document.createElement("i");
    icon.className = "fa-solid fa-triangle-exclamation";
    icon.style.cssText = `color:#FFD54F;font-size:32px;`;
    iconContainer.appendChild(icon);

    const titleEl = document.createElement("div");
    titleEl.style.cssText = `font-size:20px;font-weight:600;text-align:center;margin-bottom:16px;color:#FFD54F;`;
    titleEl.textContent = t("disclaimer.title", "Quick Note");

    const messageEl = document.createElement("div");
    messageEl.style.cssText = `font-size:13px;line-height:1.6;margin-bottom:20px;color:${disclaimerColors.textSecondary};text-align:center;`;

    const line1 = document.createElement("div");
    line1.style.cssText = `margin-bottom:8px;font-weight:500;color:${disclaimerColors.text};font-size:14px;`;
    line1.textContent = t(
      "disclaimer.line1",
      "LuaTools is not affiliated with Millennium",
    );

    const line2 = document.createElement("div");
    line2.style.cssText = "margin-bottom:8px;";
    line2.textContent = t(
      "disclaimer.line2",
      "Millennium will not offer support for this plugin on their server",
    );

    const line3 = document.createElement("div");
    line3.style.cssText = `font-weight:500;color:#FFD54F;font-size:13px;`;
    line3.textContent = t(
      "disclaimer.line3",
      "This plugin is unofficial and is not supported by Millennium.",
    );

    messageEl.appendChild(line1);
    messageEl.appendChild(line2);
    messageEl.appendChild(line3);

    const inputGroup = document.createElement("div");
    inputGroup.style.cssText = "margin-bottom:16px;";

    const inputLabel = document.createElement("div");
    inputLabel.style.cssText = `font-size:11px;color:${disclaimerColors.textSecondary};margin-bottom:8px;text-align:center;text-transform:uppercase;letter-spacing:1px;`;
    inputLabel.textContent = t(
      "disclaimer.inputLabel",
      'type "I Understand" in the box bellow to continue',
    );

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("disclaimer.inputPlaceholder", "I Understand");
    input.style.cssText = `width:100%;box-sizing:border-box;background:${disclaimerColors.bgTertiary};border:1px solid ${disclaimerColors.borderRgba};border-radius:10px;padding:10px 14px;color:${disclaimerColors.text};font-size:14px;outline:none;text-align:center;transition:all 0.2s ease;`;
    input.onfocus = function () {
      this.style.borderColor = disclaimerColors.accent;
      this.style.boxShadow = `0 0 0 2px rgba(${disclaimerColors.rgbString},0.2)`;
    };
    input.onblur = function () {
      this.style.borderColor = disclaimerColors.borderRgba;
      this.style.boxShadow = "none";
    };

    inputGroup.appendChild(inputLabel);
    inputGroup.appendChild(input);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:center;";

    const confirmBtn = document.createElement("a");
    confirmBtn.href = "#";
    confirmBtn.className = "luatools-btn primary";
    confirmBtn.style.minWidth = "160px";
    confirmBtn.style.justifyContent = "center";
    confirmBtn.style.textAlign = "center";
    confirmBtn.style.display = "flex";
    confirmBtn.innerHTML = `<span>${lt("Confirm")}</span>`;
    confirmBtn.style.opacity = "0.5";
    confirmBtn.style.pointerEvents = "none";

    var expectedPhrase = t("disclaimer.inputPlaceholder", "I Understand")
      .trim()
      .toLowerCase();
    input.oninput = function () {
      if (this.value.trim().toLowerCase() === expectedPhrase) {
        confirmBtn.style.opacity = "1";
        confirmBtn.style.pointerEvents = "auto";
        confirmBtn.style.boxShadow = `0 4px 12px ${disclaimerColors.shadow}`;
      } else {
        confirmBtn.style.opacity = "0.5";
        confirmBtn.style.pointerEvents = "none";
        confirmBtn.style.boxShadow = "none";
      }
    };

    confirmBtn.onclick = function (e) {
      e.preventDefault();
      if (input.value.trim().toLowerCase() === expectedPhrase) {
        localStorage.setItem("luatools millennium disclaimer accepted", "1");
        overlay.remove();
      }
    };

    btnRow.appendChild(confirmBtn);

    modal.appendChild(iconContainer);
    modal.appendChild(titleEl);
    modal.appendChild(messageEl);
    modal.appendChild(inputGroup);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);

    document.body.appendChild(overlay);

    // Focus input after a short delay
    setTimeout(() => input.focus(), 300);

    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);
  }

  // Ensure consistent spacing for our buttons
  function ensureStyles() {
    if (!document.getElementById("luatools-spacing-styles")) {
      const style = document.createElement("style");
      style.id = "luatools-spacing-styles";
      style.textContent = `
                .luatools-restart-button { margin-left: 6px !important; margin-right: 6px !important; }
                .luatools-button { margin-right: 0 !important; position: relative !important; }
                .luatools-pills-container {
                    position: absolute !important;
                    top: -25px !important;
                    left: 50% !important;
                    transform: translateX(-50%) !important;
                    display: inline-flex;
                    gap: 4px;
                    align-items: center;
                    pointer-events: none;
                    z-index: 10;
                    white-space: nowrap;
                }
                .luatools-pill {
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 9px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    display: inline-flex;
                    align-items: center;
                    height: 16px;
                    line-height: 1;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                    cursor: default;
                }
                .luatools-pill.red { background: rgba(255, 80, 80, 0.15); color: #ff5050; border: 1px solid rgba(255, 80, 80, 0.3); }
                .luatools-pill.green { background: rgba(92, 184, 92, 0.15); color: #5cb85c; border: 1px solid rgba(92, 184, 92, 0.3); }
                .luatools-pill.yellow { background: rgba(255, 193, 7, 0.15); color: #ffc107; border: 1px solid rgba(255, 193, 7, 0.3); }
                .luatools-pill.orange { background: rgba(255, 136, 0, 0.15); color: #ff8800; border: 1px solid rgba(255, 136, 0, 0.3); }
                .luatools-pill.gray { background: rgba(150, 150, 150, 0.15); color: #a0a0a0; border: 1px solid rgba(150, 150, 150, 0.3); }
            `;
      document.head.appendChild(style); // This is now separate from the main style block
    }
  }

  // Function to update button text with current translations
  function updateButtonTranslations() {
    try {
      // Update Restart Steam button
      const restartBtn = document.querySelector(".luatools-restart-button");
      if (restartBtn) {
        const restartText = lt("Restart Steam");
        restartBtn.title = restartText;
        restartBtn.setAttribute("data-tooltip-text", restartText);
        const rspan = restartBtn.querySelector("span");
        if (rspan) {
          rspan.textContent = restartText;
        }
      }

      // Update Add via LuaTools button
      const luatoolsBtn = document.querySelector(".luatools-button");
      if (luatoolsBtn) {
        const addViaText = lt("Add via LuaTools");
        luatoolsBtn.title = addViaText;
        luatoolsBtn.setAttribute("data-tooltip-text", addViaText);
        const span = luatoolsBtn.querySelector("span");
        if (span) {
          span.textContent = addViaText;
        }
      }

      const downgradeBtn = document.getElementById("luatools-downgrade-link");
      if (downgradeBtn) {
        const downgradeText = t("menu.downgrade", "Downgrade");
        downgradeBtn.title = downgradeText;
        downgradeBtn.setAttribute("data-tooltip-text", downgradeText);
        const downgradeSpan = downgradeBtn.querySelector("span");
        if (downgradeSpan) downgradeSpan.textContent = downgradeText;
      }

      const headerBtn = document.querySelector(
        "button.luatools-header-button:not(.luatools-downgrade-library-button)",
      );
      if (headerBtn) {
        const settingsTitle = getDisplayBrand() + " Settings";
        headerBtn.title = settingsTitle;
        headerBtn.setAttribute("data-tooltip-text", settingsTitle);
        const avatar = headerBtn.querySelector("img");
        if (avatar) applySteamAvatar(avatar, "LuaTools/luatools-icon.png");
      }

      const libraryDowngradeBtn = document.querySelector(
        ".luatools-downgrade-library-button",
      );
      if (libraryDowngradeBtn) {
        const pickerTitle = t(
          "menu.downgradeLibrary",
          "Downgrade an installed game",
        );
        libraryDowngradeBtn.title = pickerTitle;
        libraryDowngradeBtn.setAttribute("data-tooltip-text", pickerTitle);
        libraryDowngradeBtn.setAttribute("aria-label", pickerTitle);
      }
    } catch (err) {
      backendLog("LuaTools: updateButtonTranslations error: " + err);
    }
  }

  function getCurrentSteamResourceAppId() {
    const match = String(window.location.href || "").match(
      /https:\/\/(?:store\.steampowered\.com|steamcommunity\.com)\/app\/(\d+)/,
    );
    const appid = match
      ? parseInt(match[1], 10)
      : parseInt(window.__LuaToolsCurrentAppId, 10);
    return Number.isSafeInteger(appid) && appid > 0 ? appid : 0;
  }

  function getCurrentSteamResourceName() {
    const selectors = [
      ".apphub_AppName",
      "#appHubAppName",
      "[data-featuretarget='game-title'] h1",
      ".page_title_area h1",
      "meta[property='og:title']",
    ];
    for (let index = 0; index < selectors.length; index += 1) {
      const element = document.querySelector(selectors[index]);
      if (!element) continue;
      const value =
        element.getAttribute && element.getAttribute("content")
          ? element.getAttribute("content")
          : element.textContent;
      const name = String(value || "")
        .replace(/\s+on Steam\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      if (name) return name;
    }
    return "";
  }

  function normalizeResourceSearchName(value) {
    let name = String(value || "").replace(/[™®©]/g, "");
    try {
      name = name.normalize("NFKC");
    } catch (_) {}
    return name
      .replace(/[™®©]/g, "")
      .replace(/['’`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildAkramResourceSearchUrl(site, gameName) {
    const normalizedName = normalizeResourceSearchName(gameName);
    if (normalizedName.length < 3) return "";
    const query = new URLSearchParams();
    if (site === "online-fix") {
      query.set("do", "search");
      query.set("subaction", "search");
      query.set("story", normalizedName);
      return "https://online-fix.me/index.php?" + query.toString();
    }
    if (site === "game3rb") {
      query.set("s", normalizedName);
      return "https://game3rb.com/?" + query.toString();
    }
    return "";
  }

  function openAkramResourceSite(site, appid, pageGameName) {
    try {
      if (!site) return Promise.resolve(false);
      const normalizedAppid = parseInt(appid, 10) || 0;

      const openUrl = function (url) {
        return Millennium.callServerMethod(INTERNAL_PLUGIN_ID, "OpenExternalUrl", {
          url: url,
          contentScriptQuery: "",
        });
      };

      let launchPromise;
      if (site === "steamdb") {
        launchPromise = Millennium.callServerMethod(
          INTERNAL_PLUGIN_ID,
          "OpenResourceSite",
          {
            site: site,
            appid: normalizedAppid,
            contentScriptQuery: "",
          },
        );
      } else {
        const pageName = normalizeResourceSearchName(
          pageGameName || getCurrentSteamResourceName(),
        );
        const officialNamePromise = normalizedAppid
          ? fetchSteamGameName(normalizedAppid)
          : Promise.resolve(null);
        launchPromise = officialNamePromise.then(function (officialName) {
          const searchUrl = buildAkramResourceSearchUrl(
            site,
            officialName || pageName,
          );
          if (!searchUrl) throw new Error("Could not determine the game name");
          return openUrl(searchUrl);
        });
      }

      return Promise.resolve(launchPromise)
        .then(function (response) {
          const payload =
            typeof response === "string" ? JSON.parse(response) : response;
          if (!payload || payload.success !== true) {
            throw new Error(
              (payload && payload.error) || "External browser launch failed",
            );
          }
          return true;
        })
        .catch(function (error) {
          backendLog("Could not open external resource: " + error);
          ShowLuaToolsAlert(
            getDisplayBrand(),
            "تعذر فتح بحث اللعبة في المتصفح الخارجي.",
          );
          return false;
        });
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  const POST_ADD_INSTALL_CHANNEL = "Akram.PostAdd.Install.v1";
  let lastPostAddInstallAppId = "";

  function openSteamInstallDialog(appid) {
    const normalizedAppid = String(appid || "").trim();
    if (!/^[1-9][0-9]{0,9}$/.test(normalizedAppid)) return false;
    const numericAppid = Number(normalizedAppid);
    if (
      !Number.isSafeInteger(numericAppid) ||
      numericAppid > 4294967295 ||
      lastPostAddInstallAppId === normalizedAppid
    ) {
      return false;
    }
    lastPostAddInstallAppId = normalizedAppid;

    try {
      const browserView =
        typeof SteamClient !== "undefined" && SteamClient
          ? SteamClient.BrowserView
          : null;
      if (browserView && typeof browserView.PostMessageToParent === "function") {
        browserView.PostMessageToParent(
          POST_ADD_INSTALL_CHANNEL,
          JSON.stringify({ type: "open_install", appid: normalizedAppid }),
        );
        return true;
      }
    } catch (error) {
      backendLog("Steam install bridge unavailable: " + error);
    }

    // Older Steam/Millennium builds may not expose the WebKit-to-SharedJS
    // bridge. Keep Steam's own protocol as a narrow fallback.
    try {
      window.location.href = "steam://install/" + normalizedAppid;
      return true;
    } catch (error) {
      backendLog("Could not open Steam install dialog: " + error);
      lastPostAddInstallAppId = "";
      return false;
    }
  }

  function openFixesForCurrentGame() {
    try {
      const match =
        window.location.href.match(
          /https:\/\/store\.steampowered\.com\/app\/(\d+)/,
        ) ||
        window.location.href.match(
          /https:\/\/steamcommunity\.com\/app\/(\d+)/,
        );
      const appid = match
        ? parseInt(match[1], 10)
        : window.__LuaToolsCurrentAppId || NaN;
      if (isNaN(appid)) {
        ShowLuaToolsAlert(
          getDisplayBrand(),
          t("menu.error.noAppId", "Could not determine game AppID"),
        );
        return;
      }

      Millennium.callServerMethod("luatools", "GetGameInstallPath", {
        appid: appid,
        contentScriptQuery: "",
      })
        .then(function (pathRes) {
          const pathPayload =
            typeof pathRes === "string" ? JSON.parse(pathRes) : pathRes;
          const isGameInstalled = !!(
            pathPayload &&
            pathPayload.success &&
            pathPayload.installPath
          );
          if (isGameInstalled) {
            window.__LuaToolsGameInstallPath = pathPayload.installPath;
          }
          window.__LuaToolsGameIsInstalled = isGameInstalled;
          closeSettingsOverlay();
          showFixesLoadingPopupAndCheck(appid);
        })
        .catch(function (error) {
          backendLog("Could not open online fixes: " + error);
          ShowLuaToolsAlert(
            getDisplayBrand(),
            t("menu.error.getPath", "Error getting game path"),
          );
        });
    } catch (error) {
      backendLog("Online fixes button error: " + error);
    }
  }

  const downgradeInstallCache = Object.create(null);
  const DOWNGRADE_RPC_TIMEOUT_MS = 10000;
  const DOWNGRADE_CATALOG_MAX_POLLS = 32;
  const DOWNGRADE_CATALOG_MAX_AGE_MS = 3 * 60 * 1000;
  const DOWNGRADE_ACTIVE_STATUSES = [
    "queued",
    "probing",
    "preflight",
    "downloading",
    "merging",
    "cleaning",
    "recovering",
    "recovery_pending",
    "stalled",
    "attention",
  ];
  const DOWNGRADE_TERMINAL_STATUSES = [
    "done",
    "failed",
    "cancelled",
  ];

  function parseDowngradeRpcPayload(response) {
    let payload = response;
    if (payload && typeof payload === "object") {
      if (Object.prototype.hasOwnProperty.call(payload, "result")) {
        payload = payload.result;
      } else if (Object.prototype.hasOwnProperty.call(payload, "value")) {
        payload = payload.value;
      }
    }
    if (typeof payload === "string") {
      payload = JSON.parse(payload);
    }
    return payload && typeof payload === "object" ? payload : {};
  }

  function getCurrentDowngradeAppId() {
    const match =
      window.location.href.match(
        /https:\/\/store\.steampowered\.com\/app\/(\d+)/,
      ) ||
      window.location.href.match(
        /https:\/\/steamcommunity\.com\/app\/(\d+)/,
      );
    if (!match || !/^[0-9]+$/.test(match[1])) return null;
    return match[1];
  }

  function callMillenniumWithTimeout(methodName, argumentsObject) {
    if (
      typeof Millennium === "undefined" ||
      typeof Millennium.callServerMethod !== "function"
    ) {
      return Promise.reject(new Error("Millennium RPC is unavailable"));
    }
    let timeoutId = null;
    const backendCall = Promise.resolve().then(function () {
      return Millennium.callServerMethod(
        INTERNAL_PLUGIN_ID,
        methodName,
        argumentsObject,
      );
    });
    const deadline = new Promise(function (_, reject) {
      timeoutId = setTimeout(function () {
        reject(new Error("Downgrade RPC timed out"));
      }, DOWNGRADE_RPC_TIMEOUT_MS);
    });
    return Promise.race([backendCall, deadline]).finally(function () {
      if (timeoutId !== null) clearTimeout(timeoutId);
    });
  }

  function callDowngradeRpc(methodName, payload) {
    return callMillenniumWithTimeout(methodName, {
      contentScriptQuery: "",
      payloadJson: JSON.stringify(payload || {}),
    }).then(parseDowngradeRpcPayload);
  }

  function getDowngradeInstallInfo(appid, forceRefresh) {
    const key = String(appid || "");
    if (!/^[0-9]+$/.test(key)) {
      return Promise.resolve({ installed: false, payload: {} });
    }

    const cached = downgradeInstallCache[key];
    // This cache belongs to the current WebKit document. A full app-page
    // navigation creates a new realm/cache, while SPA navigation uses a
    // different AppID key. Reuse the successful button-gating check instead of
    // asking Millennium for the same native method twice; StartDowngrade still
    // performs its own authoritative install/profile preflight.
    if (!forceRefresh && cached) {
      return cached.promise;
    }

    if (
      typeof Millennium === "undefined" ||
      typeof Millennium.callServerMethod !== "function"
    ) {
      return Promise.reject(new Error("Millennium RPC is unavailable"));
    }

    const promise = callMillenniumWithTimeout("GetGameInstallPath", {
      appid: key,
      contentScriptQuery: "",
    })
      .then(function (response) {
        const payload = parseDowngradeRpcPayload(response);
        const installPath =
          payload && typeof payload.installPath === "string"
            ? payload.installPath.trim()
            : "";
        return {
          installed: payload.success === true && !!installPath,
          installPath: installPath,
          gameName: String(payload.gameName || payload.name || ""),
          buildId: String(payload.buildId || ""),
          payload: payload,
        };
      })
      .catch(function (error) {
        delete downgradeInstallCache[key];
        throw error;
      });

    downgradeInstallCache[key] = {
      promise: promise,
    };
    return promise;
  }

  function isPositiveDecimalWithin(value, maxValue) {
    if (!/^[0-9]+$/.test(value)) return false;
    const normalized = value.replace(/^0+/, "");
    if (!normalized) return false;
    return (
      normalized.length < maxValue.length ||
      (normalized.length === maxValue.length && normalized <= maxValue)
    );
  }

  function normalizeDecimalId(value) {
    return String(value || "").replace(/^0+(?=[0-9])/, "");
  }

  const DOWNGRADE_VERSION_BRIDGE_CHANNEL =
    "Akram.Downgrade.Versions.v1";
  // SharedJS starts the cache and native AppDetails providers in parallel and
  // owns a 9 second total budget.  Keep this deadline wider so a valid reply
  // can never be discarded at the WebKit boundary.
  const DOWNGRADE_VERSION_BRIDGE_TIMEOUT_MS = 11000;
  const downgradeVersionBridge = {
    registered: false,
    sequence: 0,
    pending: Object.create(null),
  };

  function nextDowngradeVersionRequestId() {
    downgradeVersionBridge.sequence += 1;
    return (
      "akrams-version-" +
      Date.now().toString(36) +
      "-" +
      downgradeVersionBridge.sequence.toString(36)
    );
  }

  function ensureDowngradeVersionBridge() {
    if (downgradeVersionBridge.registered) return true;
    const browserView =
      typeof SteamClient !== "undefined" && SteamClient
        ? SteamClient.BrowserView
        : null;
    if (
      !browserView ||
      typeof browserView.RegisterForMessageFromParent !== "function" ||
      typeof browserView.PostMessageToParent !== "function"
    ) {
      return false;
    }

    try {
      browserView.RegisterForMessageFromParent(function (messageId, data) {
        if (messageId !== DOWNGRADE_VERSION_BRIDGE_CHANNEL) return;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch (error) {
          return;
        }
        const requestId = String((payload && payload.requestId) || "");
        const pending = downgradeVersionBridge.pending[requestId];
        if (!pending) return;
        if (payload.type !== pending.responseType) return;
        delete downgradeVersionBridge.pending[requestId];
        clearTimeout(pending.timeout);
        pending.resolve(payload);
      });
    } catch (error) {
      // Some Steam WebKit documents expose this function but the native bridge
      // rejects it with "Unknown method". Official branches are optional; let
      // the local/backend catalog continue instead of aborting the whole modal.
      backendLog("Steam version bridge registration unavailable: " + error);
      return false;
    }
    downgradeVersionBridge.registered = true;
    return true;
  }

  function callDowngradeVersionBridge(type, responseType, payload) {
    if (!ensureDowngradeVersionBridge()) {
      return Promise.resolve({
        success: false,
        error: "steam_version_bridge_unavailable",
      });
    }
    const requestId = nextDowngradeVersionRequestId();
    return new Promise(function (resolve) {
      const timeout = setTimeout(function () {
        delete downgradeVersionBridge.pending[requestId];
        resolve({
          success: false,
          error: "steam_version_bridge_timeout",
        });
      }, type === "join_branch" ? 15000 : DOWNGRADE_VERSION_BRIDGE_TIMEOUT_MS);
      downgradeVersionBridge.pending[requestId] = {
        responseType: responseType,
        resolve: resolve,
        timeout: timeout,
      };
      try {
        SteamClient.BrowserView.PostMessageToParent(
          DOWNGRADE_VERSION_BRIDGE_CHANNEL,
          JSON.stringify(
            Object.assign({}, payload || {}, {
              type: type,
              requestId: requestId,
            }),
          ),
        );
      } catch (error) {
        clearTimeout(timeout);
        delete downgradeVersionBridge.pending[requestId];
        resolve({
          success: false,
          error: "steam_version_bridge_send_failed",
        });
      }
    });
  }

  function getSteamDowngradeBranches(appid) {
    return callDowngradeVersionBridge("get_catalog", "catalog_result", {
      appid: String(appid),
    });
  }

  function joinSteamDowngradeBranch(appid, branch) {
    return callDowngradeVersionBridge("join_branch", "join_result", {
      appid: String(appid),
      branch: String(branch || ""),
    });
  }

  function getInstalledSteamGames() {
    return callMillenniumWithTimeout("GetInstalledSteamGames", {
      contentScriptQuery: "",
    }).then(function (response) {
      const payload = parseDowngradeRpcPayload(response);
      if (payload.success !== true || !Array.isArray(payload.games)) {
        throw new Error(payload.error || "Installed game scan failed");
      }
      return payload;
    });
  }

  function openDowngradeForApp(appid, knownGame) {
    const normalizedAppid = String(appid || "");
    if (!/^[0-9]+$/.test(normalizedAppid)) {
      ShowLuaToolsAlert(
        getDisplayBrand(),
        t("menu.error.noAppId", "Could not determine game AppID"),
      );
      return;
    }

    getDowngradeInstallInfo(normalizedAppid, false)
      .then(function (installInfo) {
        if (!installInfo.installed) {
          ShowLuaToolsAlert(
            getDisplayBrand(),
            t(
              "downgrade.error.notInstalled",
              "This game must be installed before it can be downgraded.",
            ),
          );
          return;
        }
        if (knownGame && typeof knownGame === "object") {
          installInfo.gameName = String(
            knownGame.gameName || knownGame.name || "",
          );
          installInfo.buildId = String(knownGame.buildId || "");
        }
        showDowngradeModal(normalizedAppid, installInfo);
      })
      .catch(function (error) {
        backendLog("Downgrade install check failed: " + error);
        ShowLuaToolsAlert(
          getDisplayBrand(),
          t(
            "downgrade.error.installCheck",
            "Could not verify that this game is installed.",
          ),
        );
      });
  }

  function showInstalledGamePicker() {
    if (
      document.querySelector(".luatools-downgrade-game-picker-overlay") ||
      document.querySelector(".luatools-downgrade-overlay")
    ) {
      return;
    }

    ensureLuaToolsStyles();
    ensureFontAwesome();
    const colors = getThemeColors();
    const overlay = document.createElement("div");
    overlay.className = "luatools-downgrade-game-picker-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.82);backdrop-filter:blur(12px);" +
      "z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;";

    const modal = document.createElement("div");
    modal.style.cssText = `background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:720px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;padding:24px 28px;box-sizing:border-box;box-shadow:0 24px 80px rgba(0,0,0,.68),0 0 0 1px ${colors.shadowRgba};animation:slideUp .12s ease-out;`;

    const heading = document.createElement("div");
    heading.style.cssText = `display:flex;align-items:center;gap:10px;font-size:22px;font-weight:600;color:${colors.text};margin-bottom:8px;`;
    heading.innerHTML =
      `<i class="fa-solid fa-gamepad" style="color:${colors.accent};"></i>` +
      `<span>${t("downgrade.library.title", "Choose an installed game")}</span>`;

    const description = document.createElement("div");
    description.style.cssText = `font-size:13px;line-height:1.6;color:${colors.textSecondary};margin-bottom:14px;`;
    description.textContent = t(
      "downgrade.library.description",
      "Akram's reads your Steam libraries directly. Pick any installed game; no saved game list is used.",
    );

    const search = document.createElement("input");
    search.type = "search";
    search.autocomplete = "off";
    search.placeholder = t(
      "downgrade.library.search",
      "Search by game name or AppID",
    );
    search.style.cssText = `width:100%;box-sizing:border-box;padding:11px 13px;margin-bottom:10px;background:rgba(0,0,0,.26);border:1px solid ${colors.borderRgba};border-radius:8px;color:${colors.text};font-size:13px;outline:none;`;

    const gameSelect = document.createElement("select");
    gameSelect.size = 11;
    gameSelect.disabled = true;
    gameSelect.style.cssText = `width:100%;min-height:280px;box-sizing:border-box;padding:6px;background:rgba(0,0,0,.26);border:1px solid ${colors.borderRgba};border-radius:9px;color:${colors.text};font-size:13px;outline:none;`;

    const status = document.createElement("div");
    status.style.cssText = `min-height:18px;margin-top:8px;color:${colors.textSecondary};font-size:11px;line-height:1.5;`;
    status.textContent = t(
      "downgrade.library.loading",
      "Scanning installed Steam games…",
    );

    const errorBox = document.createElement("div");
    errorBox.style.cssText =
      "display:none;margin-top:10px;padding:9px 11px;border-radius:8px;background:rgba(244,67,54,.12);" +
      "border:1px solid rgba(244,67,54,.35);color:#ff8a80;font-size:12px;line-height:1.45;";

    const actions = document.createElement("div");
    actions.style.cssText =
      "display:flex;gap:10px;justify-content:flex-end;margin-top:18px;";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "Focusable";
    cancelButton.style.cssText = `min-width:150px;padding:11px 18px;border:1px solid ${colors.border};border-radius:9px;background:transparent;color:${colors.text};font-size:13px;font-weight:600;cursor:pointer;`;
    cancelButton.textContent = t("common.cancel", "Cancel");
    const continueButton = document.createElement("button");
    continueButton.type = "button";
    continueButton.className = "Focusable";
    continueButton.disabled = true;
    continueButton.style.cssText = `min-width:190px;padding:11px 18px;border:1px solid ${colors.border};border-radius:9px;background:${colors.accent};color:#fff;font-size:13px;font-weight:700;cursor:pointer;opacity:.48;`;
    continueButton.innerHTML =
      `<i class="fa-solid fa-clock-rotate-left" style="margin-inline-end:7px;"></i>` +
      `<span>${t("downgrade.library.continue", "Choose version")}</span>`;

    actions.appendChild(cancelButton);
    actions.appendChild(continueButton);
    modal.appendChild(heading);
    modal.appendChild(description);
    modal.appendChild(search);
    modal.appendChild(gameSelect);
    modal.appendChild(status);
    modal.appendChild(errorBox);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let games = [];
    let visibleGames = [];
    function closePicker() {
      if (overlay.isConnected) overlay.remove();
    }
    function selectedGame() {
      const index = Number(gameSelect.value);
      return Number.isInteger(index) && index >= 0
        ? visibleGames[index] || null
        : null;
    }
    function updateContinue() {
      const enabled = !!selectedGame();
      continueButton.disabled = !enabled;
      continueButton.style.opacity = enabled ? "1" : ".48";
      continueButton.style.cursor = enabled ? "pointer" : "default";
    }
    function renderGames() {
      const query = search.value.trim().toLocaleLowerCase();
      visibleGames = games.filter(function (game) {
        const haystack =
          String(game.name || game.gameName || "") + " " + String(game.appid || game.appId || "");
        return !query || haystack.toLocaleLowerCase().includes(query);
      });
      gameSelect.innerHTML = "";
      visibleGames.forEach(function (game, index) {
        const option = document.createElement("option");
        option.value = String(index);
        const name = String(game.name || game.gameName || "Steam App");
        const appid = String(game.appid || game.appId || "");
        const build = game.buildId ? " · Build " + String(game.buildId) : "";
        option.textContent = name + " · AppID " + appid + build;
        gameSelect.appendChild(option);
      });
      gameSelect.disabled = visibleGames.length === 0;
      if (visibleGames.length === 0) {
        status.textContent = games.length === 0
          ? t("downgrade.library.empty", "No installed Steam games were found.")
          : t("downgrade.library.noMatch", "No installed game matches your search.");
      } else {
        status.textContent = t(
          "downgrade.library.count",
          "Found {count} installed Steam games.",
        ).replace("{count}", String(visibleGames.length));
      }
      updateContinue();
    }
    function proceed() {
      const game = selectedGame();
      if (!game) return;
      closePicker();
      openDowngradeForApp(String(game.appid || game.appId || ""), game);
    }

    cancelButton.onclick = closePicker;
    continueButton.onclick = proceed;
    search.oninput = renderGames;
    gameSelect.onchange = updateContinue;
    gameSelect.ondblclick = proceed;
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) closePicker();
    });

    getInstalledSteamGames()
      .then(function (payload) {
        games = payload.games.slice();
        renderGames();
        search.focus();
        if (window.GamepadNav) window.GamepadNav.scanElements();
      })
      .catch(function (error) {
        gameSelect.disabled = true;
        errorBox.style.display = "block";
        errorBox.textContent =
          t(
            "downgrade.library.error",
            "Could not read the installed Steam games.",
          ) +
          " " +
          String((error && error.message) || error);
        status.textContent = "";
        backendLog("Installed Steam game scan failed: " + error);
      });
  }

  function showDowngradeModal(appid, installInfo) {
    if (document.querySelector(".luatools-downgrade-overlay")) return;

    ensureLuaToolsStyles();
    ensureFontAwesome();

    const colors = getThemeColors();
    const overlay = document.createElement("div");
    overlay.className = "luatools-downgrade-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.82);backdrop-filter:blur(12px);z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;";

    const modal = document.createElement("div");
    modal.style.cssText = `background:${colors.modalBg};color:${colors.text};border:1px solid ${colors.border};border-radius:16px;width:680px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;padding:26px 30px;box-sizing:border-box;box-shadow:0 24px 80px rgba(0,0,0,.68),0 0 0 1px ${colors.shadowRgba};animation:slideUp 0.12s ease-out;`;

    const title = document.createElement("div");
    title.style.cssText = `display:flex;align-items:center;gap:10px;font-size:22px;font-weight:600;color:${colors.text};margin-bottom:10px;`;
    const selectedGameName = String(
      (installInfo && (installInfo.gameName || installInfo.name)) || "",
    );
    const modalTitle = selectedGameName
      ? t("downgrade.titleForGame", "Downgrade {game}").replace(
          "{game}",
          selectedGameName,
        )
      : t("downgrade.title", "Downgrade game");
    title.innerHTML =
      `<i class="fa-solid fa-clock-rotate-left" style="color:${colors.accent};"></i>` +
      `<span></span>`;
    title.querySelector("span").textContent = modalTitle;

    const description = document.createElement("div");
    description.style.cssText = `font-size:14px;line-height:1.6;color:${colors.textSecondary};margin-bottom:12px;`;
    description.textContent = t(
      "downgrade.description",
      "Choose an official Steam branch or an archived build. Akram's fills in the depots automatically.",
    );

    const warning = document.createElement("div");
    warning.style.cssText =
      "padding:10px 12px;margin-bottom:14px;background:rgba(255,193,7,0.10);border:1px solid rgba(255,193,7,0.32);border-radius:8px;color:#ffc857;font-size:12px;line-height:1.5;";
    warning.textContent = t(
      "downgrade.warning",
      "Depot files overwrite the current game folder. Temporary Steam depot data is removed after the files are applied.",
    );

    const installPath = document.createElement("div");
    installPath.style.cssText = `font-size:12px;color:${colors.textSecondary};margin-bottom:16px;word-break:break-all;`;
    installPath.textContent =
      t("downgrade.installPath", "Installed path: {path}").replace(
        "{path}",
        String((installInfo && installInfo.installPath) || ""),
      );

    const versionPanel = document.createElement("div");
    versionPanel.style.cssText = `display:flex;flex-direction:column;gap:7px;padding:13px 14px;margin-bottom:12px;background:rgba(${colors.rgbString},0.07);border:1px solid ${colors.borderRgba};border-radius:10px;`;

    const versionLabel = document.createElement("label");
    versionLabel.style.cssText = `font-size:12px;color:${colors.text};font-weight:700;`;
    versionLabel.textContent = t(
      "downgrade.versionPicker",
      "Game version",
    );

    const versionSelect = document.createElement("select");
    versionSelect.className = "luatools-downgrade-version-select";
    versionSelect.disabled = true;
    versionSelect.style.cssText = `width:100%;box-sizing:border-box;padding:10px 12px;background:rgba(0,0,0,.26);border:1px solid ${colors.borderRgba};border-radius:8px;color:${colors.text};font-size:13px;outline:none;`;
    const loadingOption = document.createElement("option");
    loadingOption.value = "";
    loadingOption.textContent = t(
      "downgrade.loadingVersions",
      "Finding available versions...",
    );
    versionSelect.appendChild(loadingOption);

    const versionHint = document.createElement("div");
    versionHint.style.cssText = `font-size:11px;line-height:1.5;color:${colors.textSecondary};`;
    versionHint.textContent = t(
      "downgrade.loadingVersionsHint",
      "Checking Steam branches, the public build archive, and versions recorded on this computer.",
    );

    const providerStatus = document.createElement("div");
    providerStatus.className = "luatools-downgrade-provider-status";
    providerStatus.style.cssText = `font-size:10px;line-height:1.45;color:${colors.textSecondary};opacity:.88;`;
    providerStatus.textContent = t(
      "downgrade.providers.loading",
      "Sources: checking Steam and local history…",
    );

    versionPanel.appendChild(versionLabel);
    versionPanel.appendChild(versionSelect);
    versionPanel.appendChild(versionHint);
    versionPanel.appendChild(providerStatus);

    const appliedBanner = document.createElement("div");
    appliedBanner.className = "luatools-downgrade-applied-banner";
    appliedBanner.style.cssText =
      "display:none;padding:10px 12px;margin-bottom:12px;background:rgba(96,190,255,.09);border:1px solid rgba(96,190,255,.34);border-radius:8px;color:#7ed1ff;font-size:12px;line-height:1.5;";

    const forcePanel = document.createElement("label");
    forcePanel.className = "luatools-downgrade-force-panel";
    forcePanel.style.cssText =
      "display:none;align-items:flex-start;gap:9px;padding:10px 12px;margin-bottom:12px;background:rgba(255,128,72,.10);border:1px solid rgba(255,128,72,.36);border-radius:8px;color:#ffb080;font-size:12px;line-height:1.5;cursor:pointer;";
    const forceCheckbox = document.createElement("input");
    forceCheckbox.type = "checkbox";
    forceCheckbox.style.cssText = "margin-top:3px;flex:0 0 auto;";
    const forceCopy = document.createElement("span");
    forceCopy.textContent = t(
      "downgrade.force.warning",
      "This version could not be fully verified for the current installation. Enable Force only if you accept that the game may not start.",
    );
    forcePanel.appendChild(forceCheckbox);
    forcePanel.appendChild(forceCopy);

    const rowsContainer = document.createElement("div");
    rowsContainer.className = "luatools-downgrade-rows";
    rowsContainer.style.cssText =
      "display:none;flex-direction:column;gap:10px;margin-bottom:12px;";

    const addRowBtn = document.createElement("button");
    addRowBtn.type = "button";
    addRowBtn.className = "luatools-btn";
    addRowBtn.style.cssText =
      "display:none;align-items:center;justify-content:center;gap:7px;align-self:flex-start;margin-bottom:12px;";
    addRowBtn.innerHTML =
      '<i class="fa-solid fa-plus"></i><span>' +
      t("downgrade.addDepot", "Add depot") +
      "</span>";

    const manualToggle = document.createElement("button");
    manualToggle.type = "button";
    manualToggle.className = "luatools-btn";
    manualToggle.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;gap:7px;align-self:flex-start;margin-bottom:12px;padding:7px 10px;font-size:11px;";
    manualToggle.innerHTML =
      '<i class="fa-solid fa-sliders"></i><span>' +
      t("downgrade.advancedManual", "Advanced: enter IDs manually") +
      "</span>";

    const errorText = document.createElement("div");
    errorText.style.cssText =
      "display:none;color:#ff7070;font-size:13px;line-height:1.4;margin-bottom:12px;";

    const statusPanel = document.createElement("div");
    statusPanel.style.cssText = `display:none;padding:12px 14px;margin-bottom:14px;background:rgba(${colors.rgbString},0.08);border:1px solid ${colors.borderRgba};border-radius:10px;`;

    const statusText = document.createElement("div");
    statusText.style.cssText = `font-size:13px;color:${colors.text};line-height:1.5;margin-bottom:8px;`;

    const progressText = document.createElement("div");
    progressText.style.cssText = `font-size:11px;color:${colors.textSecondary};margin-bottom:6px;`;

    const progressTrack = document.createElement("div");
    progressTrack.style.cssText =
      "height:8px;background:rgba(0,0,0,0.3);border-radius:999px;overflow:hidden;";
    const progressBar = document.createElement("div");
    progressBar.style.cssText = `height:100%;width:0%;background:${colors.gradient};transition:width .25s ease;`;
    progressTrack.appendChild(progressBar);
    statusPanel.appendChild(statusText);
    statusPanel.appendChild(progressText);
    statusPanel.appendChild(progressTrack);

    const buttonRow = document.createElement("div");
    buttonRow.style.cssText =
      "display:flex;gap:10px;justify-content:flex-end;margin-top:6px;";

    const secondaryBtn = document.createElement("a");
    secondaryBtn.href = "#";
    secondaryBtn.className = "luatools-btn";
    secondaryBtn.style.cssText =
      "display:flex;align-items:center;justify-content:center;min-width:120px;text-align:center;";
    secondaryBtn.innerHTML = `<span>${lt("Cancel")}</span>`;

    const startBtn = document.createElement("a");
    startBtn.href = "#";
    startBtn.className = "luatools-btn primary";
    startBtn.style.cssText =
      "display:flex;align-items:center;justify-content:center;min-width:150px;text-align:center;";
    startBtn.innerHTML =
      '<i class="fa-solid fa-download" style="margin-inline-end:7px;"></i><span>' +
      t("downgrade.start", "Start downgrade") +
      "</span>";

    buttonRow.appendChild(secondaryBtn);
    buttonRow.appendChild(startBtn);

    modal.appendChild(title);
    modal.appendChild(description);
    modal.appendChild(warning);
    modal.appendChild(installPath);
    modal.appendChild(appliedBanner);
    modal.appendChild(versionPanel);
    modal.appendChild(forcePanel);
    modal.appendChild(manualToggle);
    modal.appendChild(rowsContainer);
    modal.appendChild(addRowBtn);
    modal.appendChild(errorText);
    modal.appendChild(statusPanel);
    modal.appendChild(buttonRow);
    overlay.appendChild(modal);

    let active = false;
    let formLocked = false;
    let stopPending = false;
    let pollTimer = null;
    let catalogTimer = null;
    let catalogPollCount = 0;
    let catalogStartedAt = 0;
    let manualMode = false;
    let selectedVersion = null;
    let lastSelectedVersionKey = "";
    let versionEntries = [];
    let versionCatalogStatus = null;
    let localCatalogPayload = null;
    let steamCatalogPayload = null;
    let activeOtherGame = false;
    let statusAppid = String(appid);

    function setError(message) {
      const text = String(message || "");
      errorText.textContent = text;
      errorText.style.display = text ? "block" : "none";
    }

    function closeModal() {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (catalogTimer) {
        clearTimeout(catalogTimer);
        catalogTimer = null;
      }
      overlay.remove();
    }

    function formatVersionDate(value, isUnixTime) {
      if (!value) return "";
      if (isUnixTime && /^[0-9]{1,10}$/.test(String(value))) {
        const date = new Date(Number(value) * 1000);
        if (!isNaN(date.getTime())) {
          try {
            return date.toLocaleDateString();
          } catch (error) {}
        }
      }
      return String(value).slice(0, 19);
    }

    function compatibilityStatus(entry) {
      const raw = String(
        (entry && entry.compatibilityStatus) ||
          (entry && entry.compatibility && entry.compatibility.status) ||
          "",
      ).toLowerCase();
      if (raw === "compatible") return "verified";
      if (raw === "partial" || raw === "incomplete" || raw === "unknown") {
        return "unverified";
      }
      return raw || "verified";
    }

    function selectedNeedsForce() {
      return !!(
        selectedVersion &&
        selectedVersion.kind !== "steam_branch" &&
        compatibilityStatus(selectedVersion) !== "verified"
      );
    }

    function compatibilityReasonLabel(reason) {
      const normalized = String(reason || "").toLowerCase();
      const fallbacks = {
        incomplete_snapshot: "the historical depot snapshot is incomplete",
        added_target_depots: "the older version uses additional depots",
        duplicate_depot: "the candidate contains a duplicate depot",
        no_target_depots: "the candidate has no usable depots",
        unverified_manual_ids: "manually entered IDs cannot be verified",
        topology_mismatch: "the historical depot layout differs from the current install",
        build_unverified: "the historical build ID could not be verified",
        manifest_alignment_unverified: "the manifests could not be aligned to one exact build",
      };
      return t(
        "downgrade.compatibility.reason." + normalized,
        fallbacks[normalized] || normalized.replace(/_/g, " "),
      );
    }

    function sourceLabel(source) {
      const key = String(source || "").toLowerCase();
      if (key === "steamdb" || key === "steam-db") {
        return t("downgrade.source.steamdb", "SteamDB archive");
      }
      if (
        key === "depotcache" ||
        key === "steam_local" ||
        key === "steam-local" ||
        key === "steam-appmanifest" ||
        key === "content-log" ||
        key === "local_history" ||
        key === "local-history" ||
        key === "local"
      ) {
        return t("downgrade.source.local", "Steam files on this computer");
      }
      if (
        key === "steam_branch" ||
        key === "steam_official" ||
        key === "steam-official"
      ) {
        return t("downgrade.source.steam", "Steam official");
      }
      if (key === "cache") return t("downgrade.source.cache", "Saved cache");
      if (key === "gitea" || key === "steam-pics") {
        return t("downgrade.source.archive", "Build archive");
      }
      return t("downgrade.savedBuild", "Previously installed build");
    }

    function entryKey(entry) {
      if (!entry) return "";
      if (entry.kind === "steam_branch") {
        return "branch:" + String(entry.branch || "public");
      }
      if (entry.candidateId) return "candidate:" + entry.candidateId;
      if (entry.id) return "version:" + entry.id;
      return (
        "depots:" +
        (Array.isArray(entry.depots)
          ? entry.depots
              .map(function (depot) {
                return String(depot.depotId || "") + ":" + String(depot.manifestId || "");
              })
              .join(",")
          : "")
      );
    }

    function versionOptionLabel(entry) {
      const bits = [];
      if (entry.kind === "steam_branch") {
        if (!entry.branch) {
          bits.push(t("downgrade.publicBranch", "Steam public"));
        } else if (entry.description && entry.description !== entry.branch) {
          bits.push(entry.description + " (" + entry.branch + ")");
        } else {
          bits.push(entry.branch);
        }
      } else {
        bits.push(entry.label || sourceLabel(entry.source));
      }
      if (entry.buildId) bits.push("Build " + entry.buildId);
      const rawDate = entry.timestamp || entry.updatedAt;
      const date = formatVersionDate(rawDate, /^[0-9]{1,10}$/.test(String(rawDate || "")));
      if (date) bits.push(date);
      if (entry.reapply) {
        bits.unshift(t("downgrade.reapply.badge", "Reapply"));
      } else if (entry.kind !== "steam_branch") {
        bits.push(
          compatibilityStatus(entry) === "verified"
            ? t("downgrade.compatibility.verifiedBadge", "Manifest verified")
            : t("downgrade.compatibility.forceBadge", "Force required"),
        );
      }
      return bits.join(" · ");
    }

    function normalizeCandidate(version, strictContract) {
      if (!version || typeof version !== "object") return null;
      const rawDepots = Array.isArray(version.depots) ? version.depots : [];
      const depots = rawDepots
        .map(function (depot) {
          return {
            depotId: String((depot && (depot.depotId || depot.depot_id)) || ""),
            manifestId: String(
              (depot && (depot.manifestId || depot.manifest_id)) || "",
            ),
          };
        })
        .filter(function (depot) {
          return depot.depotId && depot.manifestId;
        });
      if (depots.length === 0) return null;
      const compatibility =
        version.compatibility && typeof version.compatibility === "object"
          ? version.compatibility
          : {};
      const status = String(
        compatibility.status ||
          version.compatibilityStatus ||
          (version.mode === "verified" ? "verified" : "") ||
          (version.mode === "force" ? "force" : "") ||
          (version.verified === true ? "verified" : strictContract ? "unverified" : "verified"),
      ).toLowerCase();
      return {
        kind: "candidate",
        candidateId: String(version.candidateId || version.candidate_id || version.id || ""),
        id: String(version.id || version.candidateId || version.candidate_id || ""),
        buildId: String(version.buildId || version.build_id || ""),
        timestamp: String(version.timestamp || version.updatedAt || version.updated_at || ""),
        source: String(version.source || "local_history"),
        label: String(version.label || "").slice(0, 160),
        depots: depots,
        compatibility: compatibility,
        compatibilityStatus: status,
        forceAllowed:
          version.forceAllowed !== false &&
          version.force_allowed !== false &&
          status !== "blocked" &&
          status !== "incompatible",
        reapply: version.reapply === true,
      };
    }

    function replaceDepotRows(depots) {
      rowsContainer.innerHTML = "";
      const values = Array.isArray(depots) ? depots : [];
      values.forEach(function (depot) {
        addDepotRow({
          depotId: String((depot && depot.depotId) || ""),
          manifestId: String((depot && depot.manifestId) || ""),
        });
      });
      if (manualMode && values.length === 0) addDepotRow();
    }

    function updateIdleStartButton() {
      const canStart = manualMode
        ? rowsContainer.querySelectorAll(".luatools-downgrade-row").length > 0
        : !!selectedVersion &&
          (!selectedNeedsForce() ||
            (selectedVersion.forceAllowed !== false && forceCheckbox.checked));
      startBtn.style.pointerEvents = canStart && !formLocked ? "auto" : "none";
      startBtn.style.opacity = canStart && !formLocked ? "1" : "0.5";
      const actionLabel =
        selectedVersion && selectedVersion.reapply && !manualMode
          ? t("downgrade.reapply.action", "Reapply remembered version")
          : t("downgrade.installSelected", "Install selected version");
      startBtn.innerHTML =
        '<i class="fa-solid fa-download" style="margin-inline-end:7px;"></i><span>' +
        actionLabel +
        "</span>";
    }

    function updateVersionSelection() {
      const index = Number(versionSelect.value);
      selectedVersion = Number.isInteger(index)
        ? versionEntries[index] || null
        : null;
      const selectedKey = entryKey(selectedVersion);
      if (selectedKey !== lastSelectedVersionKey) {
        forceCheckbox.checked = false;
        lastSelectedVersionKey = selectedKey;
      }
      forcePanel.style.display = "none";
      if (!selectedVersion) {
        const catalogStillLoading =
          localCatalogPayload === null || steamCatalogPayload === null;
        const catalogUnavailable =
          versionCatalogStatus && versionCatalogStatus.success === false;
        versionHint.textContent = catalogStillLoading
          ? t(
              "downgrade.loadingVersionsHint",
              "Checking Steam branches, the public build archive, and versions recorded on this computer.",
            )
          : catalogUnavailable
          ? t(
              "downgrade.catalogUnavailable",
              "The public build archive could not be reached. Reopen this window to retry, or use Advanced mode.",
            )
          : t(
              "downgrade.noVersions",
              "No older automatic version was found. You can use Advanced mode if you already have the IDs.",
            );
        replaceDepotRows([]);
        updateIdleStartButton();
        return;
      }

      if (selectedVersion.kind === "steam_branch") {
        versionHint.textContent = t(
          "downgrade.officialBranchHint",
          "Official Steam branch. Steam will replace the installed version in the same game folder.",
        );
        warning.textContent = t(
          "downgrade.officialBranchWarning",
          "Steam handles this version switch and updates the existing installation in place.",
        );
        replaceDepotRows([]);
      } else {
        const count = Array.isArray(selectedVersion.depots)
          ? selectedVersion.depots.length
          : 0;
        const verified = compatibilityStatus(selectedVersion) === "verified";
        versionHint.textContent = t(
          verified
            ? "downgrade.compatibility.verifiedHint"
            : "downgrade.compatibility.unverifiedHint",
          verified
            ? "Depot manifests match this installation · {source} · {count} depots"
            : "Incomplete match · {source} · {count} depots. Force confirmation is required.",
        )
          .replace("{source}", sourceLabel(selectedVersion.source))
          .replace("{count}", String(count));
        const reasons =
          selectedVersion.compatibility &&
          Array.isArray(selectedVersion.compatibility.reasons)
            ? selectedVersion.compatibility.reasons
            : [];
        if (reasons.length > 0) {
          versionHint.textContent +=
            " · " +
            reasons
              .slice(0, 2)
              .map(compatibilityReasonLabel)
              .join(", ");
        }
        warning.textContent = t(
          "downgrade.warning",
          "Depot files overwrite the current game folder. Temporary Steam depot data is removed after the files are applied.",
        );
        replaceDepotRows(selectedVersion.depots);
        if (!verified) {
          forcePanel.style.display = "flex";
          if (selectedVersion.forceAllowed === false) {
            forceCheckbox.checked = false;
            forceCheckbox.disabled = true;
            forceCopy.textContent = t(
              "downgrade.force.blocked",
              "This version is incompatible with the current installation and cannot be forced.",
            );
          } else {
            forceCheckbox.disabled = false;
            forceCopy.textContent = t(
              "downgrade.force.warning",
              "This version could not be fully verified for the current installation. Enable Force only if you accept that the game may not start.",
            );
          }
        }
      }
      setError("");
      updateIdleStartButton();
    }

    function providerName(provider, fallback) {
      const name = String(
        (provider && (provider.label || provider.name || provider.id || provider.source)) ||
          fallback ||
          "",
      );
      const known = String(
        (provider && (provider.id || provider.source)) || "",
      ).toLowerCase();
      return /^(steamdb|steam-db|steam-pics|gitea|steam-official|steam_official|steam_branch|steam-local|steam_local|depotcache|cache)$/.test(known)
        ? sourceLabel(known)
        : name;
    }

    function providerState(provider) {
      if (!provider || typeof provider !== "object") return "unavailable";
      if (provider.pending === true) return "loading";
      if (provider.success === true) return "ready";
      if (provider.success === false) return "unavailable";
      return String(provider.status || provider.state || "ready").toLowerCase();
    }

    function renderProviderStatus() {
      const rows = [];
      if (steamCatalogPayload === null) {
        rows.push(t("downgrade.source.steam", "Steam official") + ": " + t("downgrade.provider.loading", "checking"));
      } else {
        rows.push(
          t("downgrade.source.steam", "Steam official") +
            ": " +
            (steamCatalogPayload.success === true
              ? t("downgrade.provider.ready", "ready")
              : t("downgrade.provider.unavailable", "unavailable")),
        );
      }

      if (localCatalogPayload === null) {
        rows.push(t("downgrade.providers.archive", "History sources") + ": " + t("downgrade.provider.loading", "checking"));
      } else {
        const rawProviders = localCatalogPayload.providers;
        const providers = [];
        if (Array.isArray(rawProviders)) {
          rawProviders.forEach(function (provider) {
            providers.push(provider);
          });
        } else if (rawProviders && typeof rawProviders === "object") {
          Object.keys(rawProviders).forEach(function (key) {
            const value = rawProviders[key];
            providers.push(
              value && typeof value === "object"
                ? Object.assign({ id: key }, value)
                : { id: key, status: String(value || "") },
            );
          });
        }
        if (providers.length === 0) {
          rows.push(
            t("downgrade.providers.archive", "History sources") +
              ": " +
              (localCatalogPayload.success === true
                ? t("downgrade.provider.ready", "ready")
                : t("downgrade.provider.unavailable", "unavailable")),
          );
        } else {
          providers.slice(0, 5).forEach(function (provider) {
            const state = providerState(provider);
            let stateText = t("downgrade.provider.ready", "ready");
            if (state === "loading" || state === "pending" || state === "running") {
              stateText = t("downgrade.provider.loading", "checking");
            } else if (state === "skipped") {
              stateText = t("downgrade.provider.skipped", "not needed");
            } else if (state === "empty") {
              stateText = t("downgrade.provider.empty", "no versions");
            } else if (state === "stale") {
              stateText = t("downgrade.provider.stale", "cached");
            } else if (state === "timeout") {
              stateText = t("downgrade.provider.timeout", "timed out");
            } else if (state === "failed" || state === "error" || state === "unavailable" || state === "circuit_open") {
              stateText = t("downgrade.provider.unavailable", "unavailable");
            }
            const candidateCount = Number(provider.candidateCount);
            if (Number.isFinite(candidateCount) && candidateCount > 0) {
              stateText += " (" + String(candidateCount) + ")";
            }
            rows.push(providerName(provider, "Archive") + ": " + stateText);
          });
        }
      }
      providerStatus.textContent = rows.join(" · ");
    }

    function applyRememberedState(localPayload) {
      appliedBanner.style.display = "none";
      const applied =
        localPayload &&
        (localPayload.appliedState || localPayload.applied || localPayload.remembered);
      const reapplyCandidate =
        localPayload &&
        (localPayload.reapplyCandidate ||
          (applied && applied.reapplyCandidate) ||
          (applied && applied.canReapply === true ? applied : null));
      const drifted = !!(
        (localPayload && (localPayload.needsReapply === true || localPayload.drifted === true)) ||
        (applied &&
          (applied.needsReapply === true ||
            applied.drifted === true ||
            String(applied.status || "").toLowerCase() === "drift"))
      );
      if (!drifted) return;

      const rememberedId = String(
        (reapplyCandidate &&
          (reapplyCandidate.candidateId || reapplyCandidate.candidate_id || reapplyCandidate.id)) ||
          (applied && (applied.candidateId || applied.candidate_id)) ||
          "",
      );
      let matched = false;
      versionEntries.forEach(function (entry) {
        if (rememberedId && (entry.candidateId === rememberedId || entry.id === rememberedId)) {
          entry.reapply = true;
          matched = true;
        }
      });
      if (!matched && reapplyCandidate) {
        const normalized = normalizeCandidate(reapplyCandidate, true);
        if (normalized) {
          normalized.reapply = true;
          versionEntries.unshift(normalized);
        }
      }
      appliedBanner.style.display = "block";
      appliedBanner.textContent = t(
        "downgrade.reapply.notice",
        "Steam changed the installed build or restored its files. Your remembered version is ready to reapply.",
      );
    }

    function renderVersionCatalog(localPayload, steamPayload) {
      const previousKey = entryKey(selectedVersion);
      versionEntries = [];
      versionCatalogStatus =
        localPayload && localPayload.catalog
          ? localPayload.catalog
          : null;

      if (
        steamPayload &&
        steamPayload.success === true &&
        Array.isArray(steamPayload.branches)
      ) {
        steamPayload.branches.forEach(function (branch) {
          if (!branch || branch.selected === true) return;
          versionEntries.push({
            kind: "steam_branch",
            branch: String(branch.branch || ""),
            description: String(branch.description || ""),
            buildId: String(branch.buildId || ""),
            updatedAt: String(branch.updatedAt || ""),
          });
        });
      }

      if (
        localPayload &&
        localPayload.success !== false &&
        (Array.isArray(localPayload.candidates) || Array.isArray(localPayload.versions))
      ) {
        const strictContract = Array.isArray(localPayload.candidates);
        const rawCandidates = strictContract
          ? localPayload.candidates
          : localPayload.versions;
        rawCandidates.forEach(function (version) {
          const candidate = normalizeCandidate(version, strictContract);
          if (!candidate) return;
          const key = entryKey(candidate);
          if (versionEntries.some(function (entry) { return entryKey(entry) === key; })) return;
          versionEntries.push(candidate);
        });
      }

      applyRememberedState(localPayload);
      renderProviderStatus();

      versionSelect.innerHTML = "";
      if (versionEntries.length === 0) {
        const empty = document.createElement("option");
        empty.value = "";
        const catalogStillLoading =
          localCatalogPayload === null || steamCatalogPayload === null;
        empty.textContent = catalogStillLoading
          ? t("downgrade.loadingVersions", "Finding available versions...")
          :
          versionCatalogStatus && versionCatalogStatus.success === false
            ? t(
                "downgrade.catalogUnavailableShort",
                "Could not load the archived versions",
              )
            : t(
                "downgrade.noAutomaticVersions",
                "No older automatic versions found",
              );
        versionSelect.appendChild(empty);
        versionSelect.disabled = true;
        selectedVersion = null;
      } else {
        let selectedIndex = 0;
        versionEntries.forEach(function (entry, index) {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = versionOptionLabel(entry);
          if (entry.forceAllowed === false && compatibilityStatus(entry) !== "verified") {
            option.disabled = true;
          }
          if (previousKey && entryKey(entry) === previousKey) selectedIndex = index;
          versionSelect.appendChild(option);
        });
        versionSelect.disabled = formLocked;
        versionSelect.value = String(selectedIndex);
      }
      // A manual downgrade can be started while Steam branch discovery is
      // still pending.  Do not replace those submitted rows when the catalog
      // arrives in the background; the picker is populated for the next time
      // the user switches back to automatic mode.
      if (!manualMode && !active) updateVersionSelection();
      if (window.GamepadNav) window.GamepadNav.scanElements();
    }

    function loadVersionCatalog() {
      localCatalogPayload = null;
      steamCatalogPayload = null;
      catalogPollCount = 0;
      catalogStartedAt = Date.now();
      renderProviderStatus();

      function requestBackendCatalog(catalogJobId) {
        callDowngradeRpc("GetDowngradeVersions", {
          appid: String(appid),
          catalogJobId: String(catalogJobId || ""),
        })
          .then(function (payload) {
            if (!overlay.isConnected) return;
            localCatalogPayload = payload || { success: false, candidates: [] };
            renderVersionCatalog(localCatalogPayload, steamCatalogPayload);
            const hasPendingProvider = Array.isArray(payload && payload.providers)
              ? payload.providers.some(function (provider) {
                  const state = providerState(provider);
                  return state === "loading" || state === "pending" || state === "running";
                })
              : false;
            if (
              payload &&
              payload.catalogJobId &&
              (payload.catalogPending === true || hasPendingProvider) &&
              catalogPollCount < DOWNGRADE_CATALOG_MAX_POLLS &&
              Date.now() - catalogStartedAt < DOWNGRADE_CATALOG_MAX_AGE_MS
            ) {
              catalogPollCount += 1;
              catalogTimer = setTimeout(function () {
                requestBackendCatalog(payload.catalogJobId);
              }, 1500);
            }
          })
          .catch(function () {
            if (!overlay.isConnected) return;
            localCatalogPayload = { success: false, candidates: [], versions: [] };
            renderVersionCatalog(localCatalogPayload, steamCatalogPayload);
          });
      }

      requestBackendCatalog("");
      getSteamDowngradeBranches(appid)
        .then(function (payload) {
          if (!overlay.isConnected) return;
          steamCatalogPayload = payload || { success: false, branches: [] };
          renderVersionCatalog(localCatalogPayload, steamCatalogPayload);
        })
        .catch(function () {
          if (!overlay.isConnected) return;
          steamCatalogPayload = { success: false, branches: [] };
          renderVersionCatalog(localCatalogPayload, steamCatalogPayload);
        });
    }

    function updateRowControls() {
      const rows = rowsContainer.querySelectorAll(
        ".luatools-downgrade-row",
      );
      rows.forEach(function (row, index) {
        const indexEl = row.querySelector(".luatools-downgrade-row-index");
        if (indexEl) indexEl.textContent = String(index + 1);
        const removeBtn = row.querySelector(
          ".luatools-downgrade-remove-row",
        );
        if (removeBtn) {
          removeBtn.disabled = formLocked || active || rows.length <= 1;
          removeBtn.style.opacity = removeBtn.disabled ? "0.4" : "1";
          removeBtn.style.pointerEvents = removeBtn.disabled ? "none" : "auto";
        }
      });
    }

    function addDepotRow(values) {
      const row = document.createElement("div");
      row.className = "luatools-downgrade-row";
      row.style.cssText = `display:grid;grid-template-columns:28px minmax(120px,1fr) minmax(190px,1.45fr) 38px;gap:9px;align-items:end;padding:10px;background:rgba(${colors.rgbString},0.05);border:1px solid ${colors.borderRgba};border-radius:10px;`;

      const rowIndex = document.createElement("div");
      rowIndex.className = "luatools-downgrade-row-index";
      rowIndex.style.cssText = `align-self:center;text-align:center;color:${colors.textSecondary};font-size:12px;font-weight:700;`;

      function createIdField(labelText, fieldClass, maxLength, value) {
        const wrap = document.createElement("label");
        wrap.style.cssText =
          "display:flex;flex-direction:column;gap:5px;min-width:0;";
        const label = document.createElement("span");
        label.style.cssText = `font-size:11px;color:${colors.textSecondary};font-weight:600;`;
        label.textContent = labelText;
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "numeric";
        input.pattern = "[0-9]*";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.maxLength = maxLength;
        input.className = fieldClass;
        input.dir = "ltr";
        input.value = String(value || "");
        input.disabled = formLocked || active;
        input.style.cssText = `width:100%;box-sizing:border-box;padding:9px 10px;background:rgba(0,0,0,.22);border:1px solid ${colors.borderRgba};border-radius:7px;color:${colors.text};font-size:13px;outline:none;`;
        input.addEventListener("input", function () {
          input.style.borderColor = colors.borderRgba;
          setError("");
        });
        wrap.appendChild(label);
        wrap.appendChild(input);
        return wrap;
      }

      const depotField = createIdField(
        t("downgrade.depotId", "Depot ID"),
        "luatools-downgrade-depot-id",
        10,
        values && values.depotId,
      );
      const manifestField = createIdField(
        t("downgrade.manifestId", "Manifest ID"),
        "luatools-downgrade-manifest-id",
        20,
        values && values.manifestId,
      );

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "luatools-downgrade-remove-row";
      removeBtn.title = t("downgrade.removeDepot", "Remove depot");
      removeBtn.setAttribute(
        "aria-label",
        t("downgrade.removeDepot", "Remove depot"),
      );
      removeBtn.style.cssText =
        "height:36px;border:1px solid rgba(255,100,100,.28);border-radius:7px;background:rgba(255,80,80,.08);color:#ff7070;cursor:pointer;";
      removeBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
      removeBtn.onclick = function () {
        row.remove();
        updateRowControls();
        setError("");
      };

      row.appendChild(rowIndex);
      row.appendChild(depotField);
      row.appendChild(manifestField);
      row.appendChild(removeBtn);
      rowsContainer.appendChild(row);
      updateRowControls();
    }

    function setFormDisabled(disabled) {
      formLocked = disabled;
      rowsContainer
        .querySelectorAll("input")
        .forEach(function (input) {
          input.disabled = disabled;
        });
      addRowBtn.disabled = disabled;
      addRowBtn.style.display =
        disabled || !manualMode ? "none" : "inline-flex";
      versionSelect.disabled = disabled || versionEntries.length === 0;
      manualToggle.disabled = disabled;
      manualToggle.style.pointerEvents = disabled ? "none" : "auto";
      manualToggle.style.opacity = disabled ? "0.5" : "1";
      forceCheckbox.disabled =
        disabled ||
        !!(selectedVersion && selectedVersion.forceAllowed === false);
      forcePanel.style.pointerEvents = disabled ? "none" : "auto";
      forcePanel.style.opacity = disabled ? "0.55" : "1";
      updateRowControls();
      if (!active) updateIdleStartButton();
    }

    function collectDepots() {
      setError("");
      const depots = [];
      const seenDepotIds = Object.create(null);
      const rows = rowsContainer.querySelectorAll(
        ".luatools-downgrade-row",
      );

      for (let i = 0; i < rows.length; i++) {
        const depotInput = rows[i].querySelector(
          ".luatools-downgrade-depot-id",
        );
        const manifestInput = rows[i].querySelector(
          ".luatools-downgrade-manifest-id",
        );
        const depotId = normalizeDecimalId(depotInput.value.trim());
        const manifestId = normalizeDecimalId(manifestInput.value.trim());
        const validDepot = isPositiveDecimalWithin(depotId, "4294967295");
        const validManifest = isPositiveDecimalWithin(
          manifestId,
          "18446744073709551615",
        );

        depotInput.style.borderColor = validDepot
          ? colors.borderRgba
          : "#ff7070";
        manifestInput.style.borderColor = validManifest
          ? colors.borderRgba
          : "#ff7070";

        if (!validDepot || !validManifest) {
          setError(
            t(
              "downgrade.error.invalidIds",
              "Enter positive decimal Depot and Manifest IDs using digits only.",
            ),
          );
          return null;
        }
        if (seenDepotIds[depotId]) {
          depotInput.style.borderColor = "#ff7070";
          setError(
            t(
              "downgrade.error.duplicateDepot",
              "Each Depot ID can only appear once.",
            ),
          );
          return null;
        }

        seenDepotIds[depotId] = true;
        depotInput.value = depotId;
        manifestInput.value = manifestId;
        depots.push({ depotId: depotId, manifestId: manifestId });
      }

      return depots;
    }

    function replaceMessageParams(message, params) {
      let text = String(message || "");
      if (!params || typeof params !== "object") return text;
      Object.keys(params).forEach(function (key) {
        text = text.split("{" + key + "}").join(String(params[key]));
      });
      return text;
    }

    function errorCodeMessage(code, params) {
      const normalized = String(code || "").toLowerCase();
      const fallbacks = {
        provider_timeout: "A version source timed out. Results from other sources are still available.",
        no_history: "No older compatible version was found.",
        entitlement_denied: "Steam denied access to one or more depots for this account.",
        game_running: "Close the game before applying an older version.",
        steam_updating: "Steam is updating or staging this game. Wait for it to finish first.",
        insufficient_space: "There is not enough free disk space for the temporary depot download.",
        topology_mismatch: "This version does not match the installed depot layout.",
        manifest_missing: "Steam did not provide the requested depot manifest.",
        stalled: "The Steam depot download stopped making progress. You can keep waiting or stop it.",
        install_changed: "Steam changed the installation while the downgrade was running.",
        active_job_other_game: "Another game's downgrade is already running (App {appid}).",
        job_active: "Another game's downgrade is already running (App {appid}).",
        permission_denied: "Windows denied access to the game folder.",
        force_required: "This version is incomplete or unverified. Confirm Force mode to continue.",
        candidate_changed: "The selected version changed. Refresh the version list and try again.",
        install_not_ready: "Steam has not finished updating or staging this installation.",
        install_not_writable: "Windows denied write access to the game folder.",
        bridge_busy: "The Steam console bridge is still handling another operation.",
        interrupted: "The downgrade was interrupted by a Steam or plugin restart.",
        steam_version_bridge_unavailable: "Steam's version service is unavailable in this view.",
        steam_version_bridge_timeout: "Steam took too long to return the branch list.",
        steam_version_bridge_send_failed: "The request could not be sent to Steam.",
        steam_app_details_unavailable: "Steam could not load the official branch list.",
        branch_not_available: "That Steam branch is no longer available to this account.",
        join_beta_unavailable: "This Steam client cannot switch branches from the current view.",
        join_beta_timeout: "Steam took too long to accept the branch change.",
        join_beta_failed: "Steam rejected the branch change.",
      };
      if (!normalized) return "";
      return replaceMessageParams(
        t(
          "downgrade.errorCode." + normalized,
          fallbacks[normalized] || normalized.replace(/_/g, " "),
        ),
        params,
      );
    }

    function payloadDetail(payload, state) {
      const code =
        (state && (state.attentionCode || state.errorCode)) ||
        (payload && (payload.attentionCode || payload.errorCode));
      if (code) {
        const params = Object.assign(
          {},
          (state && (state.errorParams || state.params)) || {},
          (payload && (payload.errorParams || payload.params)) || {},
        );
        if (payload && payload.activeAppid && params.appid == null) {
          params.appid = payload.activeAppid;
        }
        return errorCodeMessage(
          code,
          params,
        );
      }
      return String(
        (state && (state.error || state.message)) ||
          (payload && (payload.error || payload.message)) ||
          "",
      );
    }

    function statusLabel(status) {
      const labels = {
        queued: t("downgrade.status.queued", "Queued"),
        probing: t("downgrade.status.probing", "Checking Steam Console"),
        preflight: t("downgrade.status.preflight", "Checking the installation"),
        downloading: t("downgrade.status.downloading", "Downloading depots"),
        merging: t(
          "downgrade.status.merging",
          "Applying older files to the game folder",
        ),
        cleaning: t("downgrade.status.cleaning", "Removing obsolete Steam-managed files"),
        recovering: t("downgrade.status.recovering", "Recovering the interrupted operation"),
        recovery_pending: t("downgrade.status.recovering", "Recovering the interrupted operation"),
        stalled: t("downgrade.status.stalled", "Download needs attention"),
        attention: t("downgrade.status.attention", "Action needed"),
        done: t("downgrade.status.done", "Downgrade applied to the game folder"),
        failed: t("downgrade.status.failed", "Downgrade failed"),
        cancelled: t(
          "downgrade.status.cancelled",
          "Remaining downgrade steps stopped",
        ),
      };
      return labels[status] || t("downgrade.status.unknown", "Waiting for status");
    }

    function stateFromPayload(payload) {
      return payload && payload.state && typeof payload.state === "object"
        ? payload.state
        : payload && payload.activeJob && typeof payload.activeJob === "object"
          ? payload.activeJob
        : payload && payload.activeState && typeof payload.activeState === "object"
          ? payload.activeState
        : payload || {};
    }

    function formatElapsedTime(createdAt) {
      let startedAt = Number(createdAt);
      if (!Number.isFinite(startedAt) || startedAt <= 0) return "0:00";
      if (startedAt < 100000000000) startedAt *= 1000;
      const elapsedSeconds = Math.max(
        0,
        Math.floor((Date.now() - startedAt) / 1000),
      );
      const minutes = Math.floor(elapsedSeconds / 60);
      const seconds = String(elapsedSeconds % 60).padStart(2, "0");
      return minutes + ":" + seconds;
    }

    function renderState(payload) {
      const state = stateFromPayload(payload);
      const status = String(state.status || "").toLowerCase();
      const progress =
        state.progress && typeof state.progress === "object"
          ? state.progress
          : {};
      const completed = Number(
        progress.completedDepots != null
          ? progress.completedDepots
          : state.completedDepots || 0,
      );
      const total = Number(
        progress.totalDepots != null
          ? progress.totalDepots
          : state.totalDepots || 0,
      );
      let percent = Number(
        progress.percent != null ? progress.percent : state.percent,
      );
      if (!Number.isFinite(percent)) {
        percent = total > 0 ? (completed / total) * 100 : 0;
      }
      percent = Math.max(0, Math.min(100, percent));

      statusPanel.style.display = "block";
      const stateAppid = String(state.appid || state.appId || "");
      activeOtherGame = !!(stateAppid && stateAppid !== String(appid));
      const terminalOtherGame =
        activeOtherGame && DOWNGRADE_TERMINAL_STATUSES.includes(status);
      const detail = payloadDetail(payload, state);
      statusText.textContent =
        (activeOtherGame
          ? terminalOtherGame
            ? t("downgrade.status.otherGameFinished", "The other game's operation finished")
            : t("downgrade.status.otherGame", "Another game is being processed")
          : statusLabel(status)) + (detail ? ": " + String(detail) : "");
      const currentDepotId = state.currentDepot
        ? typeof state.currentDepot === "object"
          ? state.currentDepot.depotId
          : state.currentDepot
        : "";
      if (status === "downloading") {
        progressText.textContent = t(
          "downgrade.progress.steamActive",
          "Steam is downloading Depot {depot}. Live percentage is unavailable · completed {completed}/{total} · elapsed {elapsed}",
        )
          .replace("{depot}", String(currentDepotId || "—"))
          .replace(
            "{completed}",
            String(Number.isFinite(completed) ? completed : 0),
          )
          .replace("{total}", String(Number.isFinite(total) ? total : 0))
          .replace("{elapsed}", formatElapsedTime(state.createdAt));
        progressBar.style.transition = "none";
        progressBar.style.width = "28%";
        progressBar.style.animation =
          "luatools-downgrade-indeterminate 1.35s ease-in-out infinite";
      } else if (status === "stalled") {
        progressText.textContent = t(
          "downgrade.progress.stalled",
          "No Steam activity was detected for Depot {depot} · completed {completed}/{total} · elapsed {elapsed}",
        )
          .replace("{depot}", String(currentDepotId || "—"))
          .replace("{completed}", String(Number.isFinite(completed) ? completed : 0))
          .replace("{total}", String(Number.isFinite(total) ? total : 0))
          .replace("{elapsed}", formatElapsedTime(state.createdAt));
        progressBar.style.animation = "none";
        progressBar.style.transform = "translateX(0)";
        progressBar.style.transition = "width .25s ease";
        progressBar.style.width = Math.max(percent, 8) + "%";
      } else {
        progressText.textContent = t(
          "downgrade.progress",
          "{completed} of {total} depots ({percent}%)",
        )
          .replace(
            "{completed}",
            String(Number.isFinite(completed) ? completed : 0),
          )
          .replace("{total}", String(Number.isFinite(total) ? total : 0))
          .replace("{percent}", String(Math.round(percent)));
        progressBar.style.animation = "none";
        progressBar.style.transform = "translateX(0)";
        progressBar.style.transition = "width .25s ease";
        progressBar.style.width = percent + "%";
      }
      if (
        currentDepotId &&
        status !== "downloading" &&
        status !== "stalled"
      ) {
        progressText.textContent +=
          " · " +
          t("downgrade.currentDepot", "Current depot: {depot}").replace(
            "{depot}",
            String(currentDepotId || "—"),
          );
      }

      if (activeOtherGame) {
        setFormDisabled(true);
        startBtn.style.display = "none";
        progressText.textContent +=
          " · " +
          t("downgrade.status.otherGameApp", "Active AppID: {appid}").replace(
            "{appid}",
            stateAppid || "—",
          );
      } else if (active && (status === "merging" || status === "cleaning")) {
        startBtn.style.display = "none";
      }

      if (DOWNGRADE_TERMINAL_STATUSES.includes(status)) {
        active = false;
        activeOtherGame = false;
        statusAppid = String(appid);
        stopPending = false;
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        const completedSuccessfully = status === "done";
        setFormDisabled(terminalOtherGame ? false : completedSuccessfully);
        startBtn.style.display =
          !terminalOtherGame && completedSuccessfully ? "none" : "flex";
        if (terminalOtherGame || !completedSuccessfully) updateIdleStartButton();
        secondaryBtn.style.pointerEvents = "auto";
        secondaryBtn.style.opacity = "1";
        secondaryBtn.innerHTML = `<span>${lt("Close")}</span>`;
      }
    }

    function schedulePoll(delay) {
      if (!active || !overlay.isConnected) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(pollStatus, delay || 1200);
    }

    function pollStatus() {
      if (!active || !overlay.isConnected) return;
      callDowngradeRpc("GetDowngradeStatus", { appid: statusAppid })
        .then(function (payload) {
          if (
            payload.success === false &&
            !(payload && (payload.activeJob || payload.activeState))
          ) {
            throw new Error(payloadDetail(payload, stateFromPayload(payload)) || "Status request failed");
          }
          renderState(payload);
          schedulePoll(1200);
        })
        .catch(function (error) {
          statusPanel.style.display = "block";
          statusText.textContent =
            t("downgrade.error.status", "Could not read downgrade status") +
            ": " +
            String((error && error.message) || error);
          schedulePoll(2500);
        });
    }

    function beginActiveState(otherGame, otherAppid) {
      active = true;
      activeOtherGame = otherGame === true;
      statusAppid = activeOtherGame && otherAppid
        ? String(otherAppid)
        : String(appid);
      stopPending = false;
      setError("");
      setFormDisabled(true);
      startBtn.style.display = "flex";
      startBtn.style.pointerEvents = "auto";
      startBtn.style.opacity = "1";
      startBtn.innerHTML =
        '<i class="fa-solid fa-stop" style="margin-inline-end:7px;"></i><span>' +
        t("downgrade.stopAfterCurrent", "Stop after current depot") +
        "</span>";
      if (activeOtherGame) startBtn.style.display = "none";
      secondaryBtn.style.pointerEvents = "auto";
      secondaryBtn.style.opacity = "1";
      secondaryBtn.innerHTML =
        `<span>${t("downgrade.runInBackground", "Run in background")}</span>`;
      statusPanel.style.display = "block";
    }

    addRowBtn.onclick = function () {
      if (!active) addDepotRow();
    };

    versionSelect.onchange = function () {
      if (!active && !manualMode) updateVersionSelection();
    };

    forceCheckbox.onchange = function () {
      setError("");
      updateIdleStartButton();
    };

    manualToggle.onclick = function (event) {
      event.preventDefault();
      if (active || formLocked) return;
      manualMode = !manualMode;
      versionPanel.style.display = manualMode ? "none" : "flex";
      forcePanel.style.display = "none";
      rowsContainer.style.display = manualMode ? "flex" : "none";
      addRowBtn.style.display = manualMode ? "inline-flex" : "none";
      manualToggle.innerHTML = manualMode
        ? '<i class="fa-solid fa-list"></i><span>' +
          t("downgrade.backToVersions", "Back to version list") +
          "</span>"
        : '<i class="fa-solid fa-sliders"></i><span>' +
          t("downgrade.advancedManual", "Advanced: enter IDs manually") +
          "</span>";
      if (manualMode) {
        warning.textContent = t(
          "downgrade.warning",
          "Depot files overwrite the current game folder. Temporary Steam depot data is removed after the files are applied.",
        );
        if (
          rowsContainer.querySelectorAll(".luatools-downgrade-row").length ===
          0
        ) {
          addDepotRow();
        }
      } else {
        updateVersionSelection();
      }
      setError("");
      updateIdleStartButton();
      if (window.GamepadNav) window.GamepadNav.scanElements();
    };

    startBtn.onclick = function (event) {
      event.preventDefault();
      if (active) {
        if (stopPending) return;
        stopPending = true;
        startBtn.style.pointerEvents = "none";
        startBtn.style.opacity = "0.55";
        statusText.textContent = t(
          "downgrade.status.stoppingAfterCurrent",
          "Stopping after the current depot finishes",
        );
        callDowngradeRpc("CancelDowngrade", { appid: String(appid) })
          .then(function (payload) {
            if (payload.success === false) {
              throw new Error(payload.error || "CancelDowngrade failed");
            }
            renderState(payload);
            if (active) schedulePoll(500);
          })
          .catch(function (error) {
            stopPending = false;
            startBtn.style.pointerEvents = "auto";
            startBtn.style.opacity = "1";
            setError(
              t(
                "downgrade.error.cancel",
                "Could not stop the remaining downgrade steps",
              ) +
                ": " +
                String((error && error.message) || error),
            );
            schedulePoll(1200);
        });
        return;
      }

      if (!manualMode && !selectedVersion) {
        setError(
          t(
            "downgrade.error.selectVersion",
            "Choose an available version first.",
          ),
        );
        return;
      }

      if (
        !manualMode &&
        selectedNeedsForce() &&
        (selectedVersion.forceAllowed === false || !forceCheckbox.checked)
      ) {
        setError(
          selectedVersion.forceAllowed === false
            ? t(
                "downgrade.force.blocked",
                "This version is incompatible with the current installation and cannot be forced.",
              )
            : t(
                "downgrade.force.confirm",
                "Confirm Force mode before installing this unverified version.",
              ),
        );
        return;
      }

      if (
        !manualMode &&
        selectedVersion &&
        selectedVersion.kind === "steam_branch"
      ) {
        setError("");
        formLocked = true;
        setFormDisabled(true);
        startBtn.style.pointerEvents = "none";
        startBtn.style.opacity = "0.55";
        statusPanel.style.display = "block";
        statusText.textContent = t(
          "downgrade.status.switchingBranch",
          "Asking Steam to switch the installed version...",
        );
        progressText.textContent = versionOptionLabel(selectedVersion);
        progressBar.style.width = "35%";

        joinSteamDowngradeBranch(appid, selectedVersion.branch)
          .then(function (payload) {
            if (!payload || payload.success !== true) {
              throw new Error(
                errorCodeMessage(payload && payload.error) ||
                  (payload && payload.error) ||
                  "Steam branch switch failed",
              );
            }
            // Joining a branch only queues work in Steam.  Do not present it
            // as completed while Steam is still downloading the build.
            progressBar.style.transition = "none";
            progressBar.style.width = "28%";
            progressBar.style.animation =
              "luatools-downgrade-indeterminate 1.35s ease-in-out infinite";
            statusText.textContent = t(
              "downgrade.status.branchQueued",
              "Steam accepted the version change.",
            );
            progressText.textContent = t(
              "downgrade.status.steamWillDownload",
              "Download progress will appear in Steam. The same game folder is used.",
            );
            startBtn.style.display = "none";
            secondaryBtn.innerHTML = `<span>${lt("Close")}</span>`;
          })
          .catch(function (error) {
            formLocked = false;
            setFormDisabled(false);
            startBtn.style.display = "flex";
            updateIdleStartButton();
            progressBar.style.width = "0%";
            setError(
              t(
                "downgrade.error.branchSwitch",
                "Steam could not switch to that version",
              ) +
                ": " +
                String((error && error.message) || error),
            );
          });
        return;
      }

      const depots = collectDepots();
      if (!depots || depots.length === 0) return;

      beginActiveState();
      statusText.textContent = t(
        "downgrade.status.starting",
        "Starting downgrade",
      );
      progressText.textContent = "";
      progressBar.style.width = "0%";

      callDowngradeRpc("StartDowngrade", {
        appid: String(appid),
        depots: depots,
        candidateId:
          !manualMode && selectedVersion
            ? String(selectedVersion.candidateId || selectedVersion.id || "")
            : "",
        mode:
          manualMode || selectedNeedsForce()
            ? "force"
            : "verified",
        pin: true,
      })
        .then(function (payload) {
          if (payload.success === false) {
            if (payload && (payload.activeJob || payload.activeState)) {
              beginActiveState(
                true,
                payload.activeAppid ||
                  (payload.activeJob && (payload.activeJob.appid || payload.activeJob.appId)) ||
                  (payload.activeState && (payload.activeState.appid || payload.activeState.appId)),
              );
              renderState(payload);
              schedulePoll(800);
              return;
            }
            throw new Error(
              payloadDetail(payload, stateFromPayload(payload)) ||
                "StartDowngrade failed",
            );
          }
          renderState(payload);
          if (active) schedulePoll(500);
        })
        .catch(function (error) {
          active = false;
          stopPending = false;
          setFormDisabled(false);
          updateIdleStartButton();
          secondaryBtn.innerHTML = `<span>${lt("Close")}</span>`;
          setError(
            t("downgrade.error.start", "Could not start downgrade") +
              ": " +
              String((error && error.message) || error),
          );
        });
    };

    secondaryBtn.onclick = function (event) {
      event.preventDefault();
      closeModal();
    };

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay && !active) closeModal();
    });

    document.body.appendChild(overlay);
    updateIdleStartButton();
    loadVersionCatalog();

    setTimeout(function () {
      if (window.GamepadNav) window.GamepadNav.scanElements();
      if (!versionSelect.disabled) versionSelect.focus();
    }, 150);

    // Resume a live operation if the modal is reopened while the backend is busy.
    callDowngradeRpc("GetDowngradeStatus", { appid: String(appid) })
      .then(function (payload) {
        const state = stateFromPayload(payload);
        const status = String(state.status || "").toLowerCase();
        if (
          (payload.success !== false ||
            (payload && (payload.activeJob || payload.activeState))) &&
          DOWNGRADE_ACTIVE_STATUSES.includes(status)
        ) {
          const stateAppid = String(state.appid || state.appId || "");
          beginActiveState(
            !!(stateAppid && stateAppid !== String(appid)),
            stateAppid,
          );
          renderState(payload);
          schedulePoll(500);
        }
      })
      .catch(function () {
        // No previous operation is a normal state for a newly opened form.
      });
  }

  function openDowngradeForCurrentGame() {
    const appid = getCurrentDowngradeAppId();
    if (!appid) {
      ShowLuaToolsAlert(
        getDisplayBrand(),
        t("menu.error.noAppId", "Could not determine game AppID"),
      );
      return;
    }
    openDowngradeForApp(appid);
  }

  const DOWNGRADE_FALLBACK_CONTAINER_ID =
    "luatools-downgrade-fallback";

  function removeEmptyDowngradeFallback() {
    const fallback = document.getElementById(
      DOWNGRADE_FALLBACK_CONTAINER_ID,
    );
    if (
      fallback &&
      !fallback.querySelector("#luatools-downgrade-link")
    ) {
      fallback.remove();
    }
  }

  function ensureDowngradeButton(container, reference) {
    if (!container) return;
    const appid = getCurrentDowngradeAppId();
    let button = document.getElementById("luatools-downgrade-link");

    if (!appid) {
      if (button) button.remove();
      removeEmptyDowngradeFallback();
      return;
    }
    if (button && button.dataset.appid !== String(appid)) {
      button.remove();
      button = null;
    }
    if (button && button.parentElement === container) return;

    getDowngradeInstallInfo(appid, false)
      .then(function (installInfo) {
        if (
          !installInfo.installed ||
          !container.isConnected ||
          getCurrentDowngradeAppId() !== String(appid)
        ) {
          const staleButton = document.getElementById(
            "luatools-downgrade-link",
          );
          if (staleButton && staleButton.dataset.appid === String(appid)) {
            staleButton.remove();
          }
          removeEmptyDowngradeFallback();
          return;
        }

        let currentButton = document.getElementById(
          "luatools-downgrade-link",
        );
        if (!currentButton) {
          currentButton = document.createElement("a");
          currentButton.id = "luatools-downgrade-link";
          currentButton.href = "#";
          currentButton.dataset.appid = String(appid);
          currentButton.className = reference && reference.className
            ? reference.className + " luatools-resource-link"
            : "btnv6_blue_hoverfade btn_medium luatools-resource-link";
          const label = t("menu.downgrade", "Downgrade");
          const span = document.createElement("span");
          span.textContent = label;
          currentButton.appendChild(span);
          currentButton.title = label;
          currentButton.setAttribute("data-tooltip-text", label);
          currentButton.addEventListener("click", function (event) {
            event.preventDefault();
            openDowngradeForCurrentGame();
          });
        }

        if (currentButton.parentElement !== container) {
          container.appendChild(currentButton);
        }
        if (container.id === DOWNGRADE_FALLBACK_CONTAINER_ID) {
          container.style.display = "flex";
        } else {
          removeEmptyDowngradeFallback();
        }
        if (window.GamepadNav) window.GamepadNav.scanElements();
      })
      .catch(function (error) {
        removeEmptyDowngradeFallback();
        backendLog("Downgrade button install check failed: " + error);
      });
  }

  // Generic store-page placement used when SteamDB/PCGamingWiki did not
  // create their optional extension container.  The queue action remains the
  // preferred native anchor; the fixed container stays hidden until the
  // asynchronous install check in ensureDowngradeButton succeeds.
  function ensureStandaloneDowngradeButton() {
    const appid = getCurrentDowngradeAppId();
    const existingButton = document.getElementById(
      "luatools-downgrade-link",
    );
    if (!appid) {
      if (existingButton) existingButton.remove();
      removeEmptyDowngradeFallback();
      return;
    }

    const queueButton = document.querySelector("#queueBtnFollow");
    if (queueButton && queueButton.parentElement) {
      ensureDowngradeButton(queueButton.parentElement, queueButton);
      removeEmptyDowngradeFallback();
      return;
    }

    if (!document.body) return;
    let fallback = document.getElementById(
      DOWNGRADE_FALLBACK_CONTAINER_ID,
    );
    if (fallback && fallback.dataset.appid !== String(appid)) {
      fallback.remove();
      fallback = null;
    }
    if (!fallback) {
      fallback = document.createElement("div");
      fallback.id = DOWNGRADE_FALLBACK_CONTAINER_ID;
      fallback.dataset.appid = String(appid);
      fallback.setAttribute("role", "group");
      fallback.setAttribute(
        "aria-label",
        t("menu.downgrade", "Downgrade"),
      );
      fallback.style.cssText =
        "position:fixed;inset-inline-end:18px;bottom:72px;z-index:99990;" +
        "display:none;align-items:center;padding:6px;border-radius:6px;" +
        "background:rgba(20,30,40,.92);box-shadow:0 4px 16px rgba(0,0,0,.45);" +
        "pointer-events:auto;";
      document.body.appendChild(fallback);
    }
    ensureDowngradeButton(fallback, null);
  }

  function ensureAkramResourceButtons(container) {
    if (!container) return;
    ensureLuaToolsStyles();
    container.dataset.akramStableOrderReady = "1";

    // Keep the useful resource buttons only.
    const links = container.querySelectorAll("a");
    for (let i = 0; i < links.length; i++) {
      const href = links[i].href || links[i].getAttribute("href") || "";
      const normalizedHref = href.toLowerCase();
      if (
        normalizedHref.includes("pcgamingwiki.com") ||
        normalizedHref.includes("steamdb.info/app/") ||
        normalizedHref.includes("steamcommunity.com/app/")
      ) {
        links[i].remove();
      }
    }
    container
      .querySelectorAll(".luatools-restart-button")
      .forEach(function (button) {
        button.remove();
      });

    const reference = container.querySelector("a");
    ensureDowngradeButton(container, reference);
    let fixesButton = document.getElementById("luatools-fixes-link");
    if (!fixesButton) {
      fixesButton = document.createElement("a");
      fixesButton.id = "luatools-fixes-link";
      fixesButton.href = "#";
      fixesButton.className = reference && reference.className
        ? reference.className + " luatools-resource-link"
        : "btnv6_blue_hoverfade btn_medium luatools-resource-link";
      const fixesSpan = document.createElement("span");
      fixesSpan.textContent = t("menu.fixesMenu", "Online Fix");
      fixesButton.appendChild(fixesSpan);
      fixesButton.title = t("menu.fixesMenu", "Online Fix");
      fixesButton.setAttribute(
        "data-tooltip-text",
        t("menu.fixesMenu", "Online Fix"),
      );
      fixesButton.addEventListener("click", function (event) {
        event.preventDefault();
        openFixesForCurrentGame();
      });
    }
    if (!fixesButton.parentElement) container.appendChild(fixesButton);
    const fixesLabel = t("menu.fixesMenu", "Online Fix");
    const fixesLabelSpan = fixesButton.querySelector("span");
    if (fixesLabelSpan) fixesLabelSpan.textContent = fixesLabel;
    fixesButton.title = fixesLabel;
    fixesButton.setAttribute("data-tooltip-text", fixesLabel);

    const resources = [
      {
        id: "luatools-online-fix-link",
        label: "Online-Fix",
        site: "online-fix",
      },
      {
        id: "luatools-game3rb-link",
        label: "Game3rb",
        site: "game3rb",
      },
    ];

    resources.forEach(function (resource) {
      let button = document.getElementById(resource.id);
      if (!button) {
        button = document.createElement("a");
        button.id = resource.id;
        button.href = "#";
        button.className = reference && reference.className
          ? reference.className + " luatools-resource-link"
          : "btnv6_blue_hoverfade btn_medium luatools-resource-link";
        const span = document.createElement("span");
        span.textContent = resource.label;
        button.appendChild(span);
        button.title = resource.label;
        button.setAttribute("data-tooltip-text", resource.label);
        button.addEventListener("click", function (event) {
          event.preventDefault();
          openAkramResourceSite(
            resource.site,
            getCurrentSteamResourceAppId(),
            getCurrentSteamResourceName(),
          );
        });
      }
      if (!button.parentElement) {
        container.appendChild(button);
      }
    });

    let steamDbButton = document.getElementById("luatools-steamdb-link");
    if (!steamDbButton) {
      steamDbButton = document.createElement("a");
      steamDbButton.id = "luatools-steamdb-link";
      steamDbButton.href = "#";
      steamDbButton.className = reference && reference.className
        ? reference.className + " luatools-resource-link"
        : "btnv6_blue_hoverfade btn_medium luatools-resource-link";
      const steamDbSpan = document.createElement("span");
      steamDbSpan.textContent = "SteamDB";
      steamDbButton.appendChild(steamDbSpan);
      steamDbButton.title = "SteamDB";
      steamDbButton.setAttribute("data-tooltip-text", "SteamDB");
      steamDbButton.addEventListener("click", function (event) {
        event.preventDefault();
        openAkramResourceSite("steamdb", getCurrentSteamResourceAppId());
      });
    }
    if (!steamDbButton.parentElement) container.appendChild(steamDbButton);

    const addButton = container.querySelector(".luatools-button");
    const downgradeButton = document.getElementById(
      "luatools-downgrade-link",
    );
    const onlineFix = document.getElementById("luatools-online-fix-link");
    const game3rb = document.getElementById("luatools-game3rb-link");
    [
      fixesButton,
      addButton,
      downgradeButton,
      onlineFix,
      game3rb,
      steamDbButton,
    ].forEach(
      function (button) {
        if (button && button.parentElement === container) {
          container.appendChild(button);
        }
      },
    );
  }

  // Function to add the LuaTools button
  // Add throttle to prevent excessive executions
  let lastButtonCheckTime = 0;
  const BUTTON_CHECK_THROTTLE = 500; // Only run once every 500ms

  function addLuaToolsButton() {
    // Throttle to prevent blocking gamepad input
    const now = Date.now();
    if (now - lastButtonCheckTime < BUTTON_CHECK_THROTTLE) {
      return; // Skip this execution, too soon
    }
    lastButtonCheckTime = now;

    // Track current URL to detect page changes
    const currentUrl = window.location.href;
    if (window.__LuaToolsLastUrl !== currentUrl) {
      // Page changed - reset button insertion flag and update translations
      window.__LuaToolsLastUrl = currentUrl;
      window.__LuaToolsButtonInserted = false;
      window.__LuaToolsRestartInserted = false;
      window.__LuaToolsIconInserted = false;
      window.__LuaToolsHeaderInserted = false;
      window.__LuaToolsPresenceCheckInFlight = false;
      window.__LuaToolsPresenceCheckAppId = undefined;
      // Ensure translations are loaded and update existing buttons
      ensureTranslationsLoaded(false).then(function () {
        updateButtonTranslations();
      });
    }

    // Store Header Button Logic (always visible)
    const headerContainer = document.querySelector("._1wn1lBlAzl3HMRqS1llwie");
    if (
      headerContainer &&
      !document.querySelector(
        "button.luatools-header-button:not(.luatools-downgrade-library-button)",
      ) &&
      !window.__LuaToolsHeaderInserted
    ) {
      ensureLuaToolsStyles();
      const headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = "luatools-header-button Focusable";
      headerBtn.tabIndex = "0";
      headerBtn.title = getDisplayBrand() + " Settings";
      headerBtn.setAttribute(
        "data-tooltip-text",
        getDisplayBrand() + " Settings",
      );

      const img = document.createElement("img");
      img.style.height = "18px";
      img.style.width = "18px";
      img.style.verticalAlign = "middle";
      img.style.borderRadius = "50%";
      img.style.objectFit = "cover";

      img.onerror = function () {
        // cogwheel fallback
        headerBtn.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="' +
          getDisplayBrand() +
          '"><path fill="currentColor" d="M12 8a4 4 0 100 8 4 4 0 000-8zm9.94 3.06l-2.12-.35a7.962 7.962 0 00-1.02-2.46l1.29-1.72a.75.75 0 00-.09-.97l-1.41-1.41a.75.75 0 00-.97-.09l-1.72 1.29c-.77-.44-1.6-.78-2.46-1.02L13.06 2.06A.75.75 0 0012.31 2h-1.62a.75.75 0 00-.75.65l-.35 2.12a7.962 7.962 0 00-2.46 1.02L5 4.6a.75.75 0 00-.97.09L2.62 6.1a.75.75 0 00-.09.97l1.29 1.72c-.44.77-.78 1.6-1.02 2.46l-2.12.35a.75.75 0 00-.65.75v1.62c0 .37.27.69.63.75l2.14.36c.24.86.58 1.69 1.02 2.46L2.53 18a.75.75 0 00.09.97l1.41 1.41c.26.26.67.29.97.09l1.72-1.29c.77.44 1.6.78 2.46 1.02l.35 2.12c.06.36.38.63.75.63h1.62c.37 0 .69-.27.75-.63l.36-2.14c.86-.24 1.69-.58 2.46-1.02l1.72 1.29c.3.2.71.17.97-.09l1.41-1.41c.26-.26.29-.67.09-.97l-1.29-1.72c.44-.77.78-1.6 1.02-2.46l2.12-.35c.36-.06.63-.38.63-.75v-1.62a.75.75 0 00-.65-.75z"/></svg>';
      };

      applySteamAvatar(img, "LuaTools/luatools-icon.png");

      headerBtn.appendChild(img);

      headerBtn.onclick = function (e) {
        e.preventDefault();
        showSettingsPopup();
      };

      headerContainer.appendChild(headerBtn);
      window.__LuaToolsHeaderInserted = true;
      backendLog("Inserted store header button");
    }

    // This entry point is deliberately independent of the current store AppID:
    // it opens a live inventory built from every appmanifest in every Steam
    // library.  The app-page button below remains a convenient shortcut.
    if (
      headerContainer &&
      !document.querySelector(".luatools-downgrade-library-button")
    ) {
      ensureLuaToolsStyles();
      const libraryBtn = document.createElement("button");
      libraryBtn.type = "button";
      libraryBtn.className =
        "luatools-header-button luatools-downgrade-library-button Focusable";
      libraryBtn.tabIndex = "0";
      const pickerTitle = t(
        "menu.downgradeLibrary",
        "Downgrade an installed game",
      );
      libraryBtn.title = pickerTitle;
      libraryBtn.setAttribute("data-tooltip-text", pickerTitle);
      libraryBtn.setAttribute("aria-label", pickerTitle);
      libraryBtn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
        'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M3 12a9 9 0 1 0 3-6.708" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round"/><path d="M3 4v5h5M12 7v5l3 2" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      libraryBtn.onclick = function (event) {
        event.preventDefault();
        showInstalledGamePicker();
      };
      const settingsButton = document.querySelector(
        "button.luatools-header-button:not(.luatools-downgrade-library-button)",
      );
      if (settingsButton && settingsButton.parentElement === headerContainer) {
        headerContainer.insertBefore(libraryBtn, settingsButton);
      } else {
        headerContainer.appendChild(libraryBtn);
      }
      backendLog("Inserted installed-game downgrade picker button");
    }

    // Check if we're in Big Picture mode
    const isBigPicture = window.__LUATOOLS_IS_BIG_PICTURE__;

    // Look for the appropriate container based on mode
    let targetContainer;
    if (isBigPicture) {
      // In Big Picture mode, use the queue button's parent as reference
      const queueBtn = document.querySelector("#queueBtnFollow");
      targetContainer = queueBtn ? queueBtn.parentElement : null;
    } else {
      // In normal mode, use the SteamDB buttons container
      targetContainer =
        document.querySelector(".steamdb-buttons") ||
        document.querySelector("[data-steamdb-buttons]") ||
        document.querySelector(".apphub_OtherSiteInfo");
    }

    if (targetContainer) {
      const steamdbContainer = targetContainer;
      ensureAkramResourceButtons(steamdbContainer);

      // Status Pills Logic
      // Always update translations for existing buttons (even if not a page change)
      const existingBtn = document.querySelector(".luatools-button");
      if (existingBtn) {
        ensureTranslationsLoaded(false).then(function () {
          updateButtonTranslations();
        });
      }

      // Check if button already exists to avoid duplicates
      if (!existingBtn && !window.__LuaToolsButtonInserted) {
        // Create the LuaTools button modeled after existing SteamDB/PCGW buttons
        // In Big Picture mode, use queue button as reference; otherwise use first link in container
        let referenceBtn = isBigPicture
          ? document.querySelector("#queueBtnFollow")
          : steamdbContainer.querySelector("a");

        // Use same custom button for both modes
        const luatoolsButton = document.createElement("a");
        luatoolsButton.href = "#";
        // Copy classes from an existing button to match look-and-feel, but set our own label
        if (referenceBtn && referenceBtn.className) {
          luatoolsButton.className =
            referenceBtn.className + " luatools-button";
        } else {
          luatoolsButton.className =
            "btnv6_blue_hoverfade btn_medium luatools-button";
        }
        const span = document.createElement("span");
        const addViaText = lt("Add via LuaTools");
        span.textContent = addViaText;
        luatoolsButton.appendChild(span);
        // Tooltip/title
        luatoolsButton.title = addViaText;
        luatoolsButton.setAttribute("data-tooltip-text", addViaText);

        // Normalize margins to match native buttons
        try {
          if (referenceBtn) {
            const cs = window.getComputedStyle(referenceBtn);
            luatoolsButton.style.marginLeft = cs.marginLeft;
            luatoolsButton.style.marginRight = cs.marginRight;
          }
        } catch (_) {}

        // Local click handler suppressed; delegated handler manages actions
        luatoolsButton.addEventListener("click", function (e) {
          e.preventDefault();
          backendLog(
            "LuaTools button clicked (delegated handler will process)",
          );
        });

        // Before inserting, ask backend if LuaTools already exists for this appid
        try {
          const match =
            window.location.href.match(
              /https:\/\/store\.steampowered\.com\/app\/(\d+)/,
            ) ||
            window.location.href.match(
              /https:\/\/steamcommunity\.com\/app\/(\d+)/,
            );
          const appid = match ? parseInt(match[1], 10) : NaN;
          if (
            !isNaN(appid) &&
            typeof Millennium !== "undefined" &&
            typeof Millennium.callServerMethod === "function"
          ) {
            // prevent multiple concurrent checks
            if (
              window.__LuaToolsPresenceCheckInFlight &&
              window.__LuaToolsPresenceCheckAppId === appid
            ) {
              return;
            }
            window.__LuaToolsPresenceCheckInFlight = true;
            window.__LuaToolsPresenceCheckAppId = appid;
            window.__LuaToolsCurrentAppId = appid;
            Millennium.callServerMethod("luatools", "HasLuaToolsForApp", {
              appid,
              contentScriptQuery: "",
            }).then(function (res) {
              try {
                const payload = typeof res === "string" ? JSON.parse(res) : res;
                if (payload && payload.success && payload.exists === true) {
                  backendLog(
                    "LuaTools already present for this app; not inserting button",
                  );
                  window.__LuaToolsPresenceCheckInFlight = false;
                  return; // do not insert
                }
                // Re-check in case another caller inserted during async
                if (
                  !document.querySelector(".luatools-button") &&
                  !window.__LuaToolsButtonInserted
                ) {
                  // Insert after restart button (order: Restart → Add)
                  steamdbContainer.insertBefore(
                    luatoolsButton,
                    steamdbContainer.firstChild,
                  );
                  window.__LuaToolsButtonInserted = true;
                  ensureAkramResourceButtons(steamdbContainer);
                  backendLog("LuaTools button inserted");
                }
                window.__LuaToolsPresenceCheckInFlight = false;
              } catch (_) {
                if (
                  !document.querySelector(".luatools-button") &&
                  !window.__LuaToolsButtonInserted
                ) {
                  steamdbContainer.insertBefore(
                    luatoolsButton,
                    steamdbContainer.firstChild,
                  );
                  window.__LuaToolsButtonInserted = true;
                  ensureAkramResourceButtons(steamdbContainer);
                  backendLog("LuaTools button inserted");
                }
                window.__LuaToolsPresenceCheckInFlight = false;
              }
            });
          } else {
            if (
              !document.querySelector(".luatools-button") &&
              !window.__LuaToolsButtonInserted
            ) {
              // Insert after restart button (order: Restart → Add)
              steamdbContainer.insertBefore(
                luatoolsButton,
                steamdbContainer.firstChild,
              );
              window.__LuaToolsButtonInserted = true;
              ensureAkramResourceButtons(steamdbContainer);
              backendLog("LuaTools button inserted");
            }
          }
        } catch (_) {
          if (
            !document.querySelector(".luatools-button") &&
            !window.__LuaToolsButtonInserted
          ) {
            steamdbContainer.insertBefore(
              luatoolsButton,
              steamdbContainer.firstChild,
            );
            window.__LuaToolsButtonInserted = true;
            ensureAkramResourceButtons(steamdbContainer);
            backendLog("LuaTools button inserted");
          }
        }
      }

      // status pills — only run once per appid
      try {
        const match =
          window.location.href.match(
            /https:\/\/store\.steampowered\.com\/app\/(\d+)/,
          ) ||
          window.location.href.match(
            /https:\/\/steamcommunity\.com\/app\/(\d+)/,
          );
        const appid = match
          ? parseInt(match[1], 10)
          : window.__LuaToolsCurrentAppId || NaN;

        if (!isNaN(appid)) {
          const pillBtn = steamdbContainer.querySelector(".luatools-button");
          if (pillBtn) {
            // Skip if pills already built for this appid
            var existingPills = pillBtn.querySelector(
              ".luatools-pills-container",
            );
            if (
              !(
                existingPills &&
                existingPills.dataset.appid === String(appid) &&
                existingPills.dataset.content
              )
            ) {
              fetchGamesDatabase().then(function (db) {
                const btn = steamdbContainer.querySelector(".luatools-button");
                if (!btn) return;

                let pillsContainer = btn.querySelector(
                  ".luatools-pills-container",
                );

                if (!pillsContainer) {
                  pillsContainer = document.createElement("div");
                  pillsContainer.className = "luatools-pills-container";
                  btn.appendChild(pillsContainer);
                }
                pillsContainer.dataset.appid = String(appid);

                const key = String(appid);
                const gameData = db && db[key] ? db[key] : null;

                // check denuvo
                const drmNotice = document.querySelector(".DRM_notice");
                const hasDenuvo =
                  drmNotice && drmNotice.textContent.includes("Denuvo");

                fetchFixes(appid).then(function (fixesData) {
                  const hasFixes =
                    fixesData &&
                    ((fixesData.genericFix &&
                      fixesData.genericFix.status === 200) ||
                      (fixesData.onlineFix &&
                        fixesData.onlineFix.status === 200));
                  const showDenuvoPill = hasDenuvo && !hasFixes;

                  const cacheKey = JSON.stringify({
                    d: gameData || "untested",
                    showDenuvo: showDenuvoPill,
                    hasFixes: hasFixes,
                  });

                  if (pillsContainer.dataset.content === cacheKey) return;
                  pillsContainer.dataset.content = cacheKey;

                  pillsContainer.innerHTML = "";

                  let status = "untested";
                  if (gameData && typeof gameData.playable !== "undefined") {
                    if (gameData.playable === 1) status = "playable";
                    else if (gameData.playable === 0) status = "unplayable";
                    else if (gameData.playable === 2) status = "needs_fixes";
                  }

                  if (status === "untested" && hasFixes) {
                    status = "needs_fixes";
                  }

                  if (status !== "untested") {
                    const pill = document.createElement("span");
                    pill.className = "luatools-pill";
                    if (status === "playable") {
                      pill.classList.add("green");
                      pill.textContent = t("gameStatus.playable", "Playable");
                    } else if (status === "unplayable") {
                      pill.classList.add("red");
                      pill.textContent = t(
                        "gameStatus.unplayable",
                        "Unplayable",
                      );
                    } else if (status === "needs_fixes") {
                      pill.classList.add("yellow");
                      pill.textContent = t(
                        "gameStatus.needsFixes",
                        "Needs fixes",
                      );
                    }
                    pillsContainer.appendChild(pill);
                  }

                  // reset button state
                  const btn =
                    steamdbContainer.querySelector(".luatools-button");
                  if (btn) {
                    btn.style.opacity = "";
                    btn.style.pointerEvents = "";
                    btn.style.cursor = "";
                    const span = btn.querySelector("span");
                    if (span && span.textContent === "Unplayable") {
                      span.textContent = lt("Add via LuaTools");
                    }
                  }

                  if (showDenuvoPill) {
                    const pill = document.createElement("span");
                    pill.className = "luatools-pill orange";
                    pill.textContent = t("gameStatus.denuvo", "Denuvo");
                    pillsContainer.appendChild(pill);
                  }
                });
              });
            }
          }
        }
      } catch (e) {
        /* ignore */
      }
    } else {
      ensureStandaloneDowngradeButton();
      if (!logState.missingOnce) {
        backendLog(
          "LuaTools: resource container missing; using generic downgrade placement",
        );
        logState.missingOnce = true;
      }
    }
  }

  // Try to add the button immediately if DOM is ready
  function onFrontendReady() {
    // Fetch settings + translations FIRST, then insert the button once in the correct language
    try {
      fetchSettingsConfig(true)
        .then(function (cfg) {
          try {
            ensureLuaToolsStyles();
          } catch (_) {}

          // Show disclaimer after translations are loaded so it displays in the correct language
          try {
            if (window.location.hostname === "store.steampowered.com") {
              if (
                localStorage.getItem(
                  "luatools millennium disclaimer accepted",
                ) !== "1"
              ) {
                showMillenniumDisclaimerModal();
              }
            }
          } catch (_) {}

          // Now translations are ready — insert the button in the correct language
          addLuaToolsButton();
        })
        .catch(function (_) {
          // Settings failed, still insert button (English fallback)
          addLuaToolsButton();
        });
    } catch (_) {
      addLuaToolsButton();
    }

    // Show gamepad hint if connected (only in Big Picture mode)
    setTimeout(function () {
      if (
        window.GamepadNav &&
        window.GamepadNav.isConnected &&
        window.GamepadNav.isConnected()
      ) {
        backendLog("[LuaTools] Gamepad detected - Navigation enabled");

        // Only show visual hint in Big Picture mode
        if (window.__LUATOOLS_IS_BIG_PICTURE__) {
          const hint = document.createElement("div");
          hint.id = "luatools-gamepad-hint";
          hint.innerHTML = "🎮 " + lt("bigpicture.mouseTip");
          hint.style.cssText =
            "\
                        position: fixed;\
                        bottom: 20px;\
                        right: 20px;\
                        background: rgba(11, 20, 30, 0.9);\
                        color: #66c0f4;\
                        padding: 12px 16px;\
                        border-radius: 8px;\
                        font-size: 14px;\
                        z-index: 99998;\
                        border: 1px solid rgba(102, 192, 244, 0.3);\
                        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);\
                        animation: fadeInOut 3s ease-in-out;\
                    ";

          // Add CSS animation if not already present
          if (!document.querySelector("#luatools-gamepad-hint-styles")) {
            const style = document.createElement("style");
            style.id = "luatools-gamepad-hint-styles";
            style.textContent =
              "\
                            @keyframes fadeInOut {\
                                0% { opacity: 0; transform: translateY(10px); }\
                                10% { opacity: 1; transform: translateY(0); }\
                                90% { opacity: 1; transform: translateY(0); }\
                                100% { opacity: 0; transform: translateY(10px); }\
                            }\
                        ";
            document.head.appendChild(style);
          }

          document.body.appendChild(hint);

          // Auto-remove after animation
          setTimeout(function () {
            if (hint && hint.parentElement) {
              hint.remove();
            }
          }, 3000);
        }
      }
    }, 500);

    // Ask backend if there is a queued startup message from InitApis
    try {
      if (
        typeof Millennium !== "undefined" &&
        typeof Millennium.callServerMethod === "function"
      ) {
        Millennium.callServerMethod("luatools", "GetInitApisMessage", {
          contentScriptQuery: "",
        }).then(function (res) {
          try {
            const payload = typeof res === "string" ? JSON.parse(res) : res;
            if (payload && payload.message) {
              const msg = String(payload.message);
              // Check if this is an update message (contains "update" or "restart")
              const isUpdateMsg =
                msg.toLowerCase().includes("update") ||
                msg.toLowerCase().includes("restart");

              if (isUpdateMsg) {
                // For update messages, use confirm dialog with OK (restart) and Cancel options
                askRestartConfirmation();
              } else {
                // For non-update messages, use regular alert
                ShowLuaToolsAlert("LuaTools", msg);
              }
            }
          } catch (_) {}
        });
        // Also show loaded apps list if present (only once per session, store page only)
        try {
          if (window.location.hostname === "store.steampowered.com") {
            if (!sessionStorage.getItem("LuaToolsLoadedAppsGate")) {
              sessionStorage.setItem("LuaToolsLoadedAppsGate", "1");
              Millennium.callServerMethod("luatools", "ReadLoadedApps", {
                contentScriptQuery: "",
              }).then(function (res) {
                try {
                  const payload =
                    typeof res === "string" ? JSON.parse(res) : res;
                  const apps =
                    payload && payload.success && Array.isArray(payload.apps)
                      ? payload.apps
                      : [];
                  if (apps.length > 0) {
                    showLoadedAppsPopup(apps);
                  }
                } catch (_) {}
              });
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onFrontendReady);
  } else {
    onFrontendReady();
  }

  // Delegate click handling in case the DOM is re-rendered and listeners are lost
  // Use bubble phase instead of capture phase to avoid interfering with gamepad navigation
  document.addEventListener(
    "click",
    function (evt) {
      // Quick exit if target doesn't have closest method or isn't an element
      if (!evt.target || !evt.target.closest) return;

      const anchor = evt.target.closest(".luatools-button");
      if (anchor) {
        evt.preventDefault();
        evt.stopPropagation(); // Stop propagation to avoid conflicts
        backendLog("LuaTools delegated click");
        try {
          const match =
            window.location.href.match(
              /https:\/\/store\.steampowered\.com\/app\/(\d+)/,
            ) ||
            window.location.href.match(
              /https:\/\/steamcommunity\.com\/app\/(\d+)/,
            );
          const appid = match ? parseInt(match[1], 10) : NaN;
          if (
            !isNaN(appid) &&
            typeof Millennium !== "undefined" &&
            typeof Millennium.callServerMethod === "function"
          ) {
            if (runState.inProgress && runState.appid === appid) {
              backendLog(
                "LuaTools: operation already in progress for this appid",
              );
              return;
            }

            // Helper that continues with the multi-API check flow
            const continueWithAdd = function () {
              // Open the loading popup first to show "Searching..."
              showTestPopup();
              const overlay = document.querySelector(".luatools-overlay");
              const status = overlay
                ? overlay.querySelector(".luatools-status")
                : null;
              const apiList = overlay
                ? overlay.querySelector(".luatools-api-list")
                : null;

              if (status)
                status.textContent = lt("Searching across sources...");

              Millennium.callServerMethod("luatools", "CheckApisForApp", {
                appid,
                contentScriptQuery: "",
              })
                .then(function (res) {
                  try {
                    const payload =
                      typeof res === "string" ? JSON.parse(res) : res;
                    if (!payload || !payload.success) {
                      throw new Error(payload.error || "Check failed");
                    }

                    const results = payload.results || [];
                    const available = results.filter((r) => r.available);

                    if (available.length === 0) {
                      const msg = lt("Game not found on any available API.");
                      if (status) status.textContent = msg;
                      const hideBtn = overlay
                        ? overlay.querySelector(".luatools-hide-btn")
                        : null;
                      if (hideBtn)
                        hideBtn.innerHTML = "<span>" + lt("Close") + "</span>";
                      return;
                    }

                    let isFastDownload = true; // default
                    try {
                      if (
                        window.__LuaToolsSettings &&
                        window.__LuaToolsSettings.values &&
                        window.__LuaToolsSettings.values.general
                      ) {
                        if (
                          typeof window.__LuaToolsSettings.values.general
                            .fastDownload !== "undefined"
                        ) {
                          isFastDownload =
                            window.__LuaToolsSettings.values.general
                              .fastDownload;
                        }
                      }
                    } catch (e) {}

                    if (isFastDownload) {
                      // Fast download enabled, proceed automatically with the first available
                      const source = available[0];
                      backendLog(
                        "LuaTools: Auto-selecting source via fast download: " + source.name,
                      );
                      startDirectDownload(appid, available, 0);
                    } else {
                      // Fast download disabled, let user select
                      showSourceSelectionModal(appid, available);
                    }
                  } catch (err) {
                    backendLog("LuaTools: CheckApisForApp error: " + err);
                    if (status)
                      status.textContent = lt("Error: {error}").replace(
                        "{error}",
                        err.message,
                      );
                  }
                })
                .catch(function (err) {
                  backendLog("LuaTools: CheckApisForApp promise error: " + err);
                });
            };

            const startDirectDownload = function (
              appid,
              availableSources,
              index = 0,
            ) {
              const source = availableSources[index];
              const url = source.url;
              const apiName = source.name;

              const performDownload = function () {
                runState.inProgress = true;
                runState.appid = appid;

                // If the selection modal was open, it should be replaced by showTestPopup or updated
                const overlay = document.querySelector(".luatools-overlay");
                if (overlay) {
                  // Reset for progress
                  const status = overlay.querySelector(".luatools-status");
                  if (status) {
                    if (index > 0) {
                      status.textContent = lt(
                        "Failed on {previous}. Trying {current}...",
                      )
                        .replace("{previous}", availableSources[index - 1].name)
                        .replace("{current}", apiName);
                    } else {
                      status.textContent = lt("Initializing download...");
                    }
                  }
                  const progressWrap = overlay.querySelector(
                    ".luatools-progress-wrap",
                  );
                  if (progressWrap) progressWrap.style.display = "block";
                  const progressInfo = overlay.querySelector(
                    ".luatools-progress-info",
                  );
                  if (progressInfo) progressInfo.style.display = "block";
                  const cancelBtn = overlay.querySelector(
                    ".luatools-cancel-btn",
                  );
                  if (cancelBtn) cancelBtn.style.display = "flex";
                } else {
                  showTestPopup();
                }

                Millennium.callServerMethod(
                  "luatools",
                  "StartAddViaLuaToolsFromUrl",
                  {
                    appid,
                    url,
                    apiName,
                    contentScriptQuery: "",
                  },
                );

                const onFailedCallback = function (errMsg) {
                  if (index + 1 < availableSources.length) {
                    backendLog(
                      "LuaTools: Fast download failed on " +
                        apiName +
                        " (" +
                        errMsg +
                        "). Trying next API: " +
                        availableSources[index + 1].name,
                    );
                    setTimeout(function () {
                      startDirectDownload(appid, availableSources, index + 1);
                    }, 1500);
                  }
                };

                startPolling(appid, onFailedCallback);
              };

              if (apiName && apiName.toLowerCase().includes("morrenus")) {
                let hubcapKey = "";
                try {
                  if (
                    window.__LuaToolsSettings &&
                    window.__LuaToolsSettings.values &&
                    window.__LuaToolsSettings.values.advanced
                  ) {
                    hubcapKey =
                      window.__LuaToolsSettings.values.advanced
                        .morrenusApiKey || "";
                  }
                  if (!hubcapKey) {
                    for (const group in window.__LuaToolsSettings.values) {
                      if (
                        window.__LuaToolsSettings.values[group] &&
                        window.__LuaToolsSettings.values[group].morrenusApiKey
                      ) {
                        hubcapKey =
                          window.__LuaToolsSettings.values[group]
                            .morrenusApiKey;
                        break;
                      }
                    }
                  }
                } catch (e) {}

                if (hubcapKey && /^smm_[0-9a-f]{96}$/.test(hubcapKey)) {
                  // Wait, check the limits
                  showTestPopup(); // Ensures basic loading modal is up
                  const overlay = document.querySelector(".luatools-overlay");
                  if (overlay) {
                    const status = overlay.querySelector(".luatools-status");
                    if (status)
                      status.textContent = lt("Verifying API limits...");
                    const cancelBtn = overlay.querySelector(
                      ".luatools-cancel-btn",
                    );
                    if (cancelBtn) cancelBtn.style.display = "none";
                  }

                  Millennium.callServerMethod("luatools", "GetMorrenusStats", {
                    api_key: hubcapKey,
                    force_refresh: true,
                    contentScriptQuery: "",
                  })
                    .then((r) => (typeof r === "string" ? JSON.parse(r) : r))
                    .then((res) => {
                      if (
                        res &&
                        res.detail === "API key not found or expired"
                      ) {
                        // 401 - invalid or expired key
                        showLuaToolsPlayableWarning(
                          lt(
                            "Your Morrenus API key is invalid or expired. Please check your key in the settings or regenerate it on the Morrenus website.",
                          ),
                          function () {
                            showSettingsManagerPopup(false, null);
                          },
                          null,
                        );
                        runState.inProgress = false;
                      } else if (
                        res &&
                        typeof res.detail === "string" &&
                        res.detail.startsWith("Daily limit reached")
                      ) {
                        // 429 - daily limit exhausted
                        showLuaToolsPlayableWarning(
                          lt(
                            "You have exceeded your daily download limit. Please wait until tomorrow for more uses, or upgrade your plan on the Morrenus website.",
                          ),
                          function () {
                            showSettingsManagerPopup(false, null);
                          },
                          null,
                        );
                        runState.inProgress = false;
                      } else if (
                        res &&
                        typeof res.daily_usage !== "undefined" &&
                        typeof res.daily_limit !== "undefined" &&
                        res.daily_usage >= res.daily_limit
                      ) {
                        // usage fields show limit reached (fallback)
                        showLuaToolsPlayableWarning(
                          lt(
                            "You have exceeded your daily download limit. Please wait until tomorrow for more uses, or upgrade your plan on the Morrenus website.",
                          ),
                          function () {
                            showSettingsManagerPopup(false, null);
                          },
                          null,
                        );
                        runState.inProgress = false;
                      } else {
                        performDownload();
                      }
                    })
                    .catch((e) => {
                      backendLog(
                        "LuaTools: Error checking Morrenus API limit: " + e,
                      );
                      // Network error or other, try to proceed and let the backend error it if needed
                      performDownload();
                    });
                  return; // yield execution to async fetch
                }
              }

              // Normal flow if not Morrenus or no key present
              performDownload();
            };

            function showSourceSelectionModal(appid, available) {
              const overlay = document.querySelector(".luatools-overlay");
              if (!overlay) return;

              const colors = getThemeColors();
              const title = overlay.querySelector(".luatools-title");
              const status = overlay.querySelector(".luatools-status");
              const apiList = overlay.querySelector(".luatools-api-list");

              if (title) title.textContent = lt("Select Download Source");
              if (status) status.style.display = "none"; // Remove "Multiple sources found" text

              if (apiList) {
                apiList.innerHTML = "";
                apiList.style.cssText =
                  "display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:16px;";

                available.forEach((source) => {
                  const btn = document.createElement("a");
                  btn.href = "#";
                  btn.className = "luatools-btn focusable";
                  btn.style.cssText = `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1;min-width:80px;padding:12px 8px;background:rgba(${colors.rgbString},0.06);border:1px solid ${colors.borderRgba};border-radius:12px;text-decoration:none;transition:all 0.2s ease;text-align:center;`;

                  const srcIcon = document.createElement("i");
                  srcIcon.className = "fa-solid fa-server";
                  srcIcon.style.cssText = `font-size:18px;color:${colors.accent};`;

                  const name = document.createElement("div");
                  name.style.cssText = `font-size:11px; font-weight:500; color:${colors.text};line-height:1.2;`;
                  name.textContent = source.name;

                  btn.appendChild(srcIcon);
                  btn.appendChild(name);

                  btn.onmouseover = function () {
                    this.style.background = `rgba(${colors.rgbString},0.25)`;
                    this.style.borderColor = colors.accent;
                    this.style.transform = "translateY(-1px)";
                  };
                  btn.onmouseout = function () {
                    this.style.background = `rgba(${colors.rgbString},0.1)`;
                    this.style.borderColor = colors.borderRgba;
                    this.style.transform = "translateY(0)";
                  };

                  btn.onclick = function (e) {
                    e.preventDefault();
                    apiList.style.display = "block"; // Reset layout for progress
                    apiList.style.flexDirection = "";
                    apiList.innerHTML = ""; // Clear selection buttons
                    if (status) status.style.display = ""; // Restore status text
                    startDirectDownload(appid, [source], 0);
                  };

                  apiList.appendChild(btn);
                });
              }

              // Update Cancel button: show it, hide the Hide/Close button, and make it close the modal
              const cancelBtn = overlay.querySelector(".luatools-cancel-btn");
              const hideBtn = overlay.querySelector(".luatools-hide-btn");

              if (cancelBtn) {
                cancelBtn.style.display = "flex";
                cancelBtn.innerHTML = `<span>${lt("Cancel")}</span>`;
                cancelBtn.onclick = function (e) {
                  e.preventDefault();
                  overlay.remove(); // Close modal immediately
                };
              }

              if (hideBtn) {
                hideBtn.style.display = "none"; // Remove "Hide" button as per request
              }

              // Re-scan for gamepad
              if (window.GamepadNav) window.GamepadNav.scanElements();
            }

            // Check if this is a dlc
            const isdlc = !!document.querySelector(".game_area_dlc_bubble");
            const parentdiv = document.querySelector(
              '.glance_details a[href*="/app/"]',
            );

            if (isdlc && parentdiv) {
              const id = parseInt(
                parentdiv.href.match(/app\/(\d+)\//)?.[1] ?? "",
              );
              const name = parentdiv.innerText ?? "name not found";

              showDlcWarning(appid, id, name);
            } else {
              // Not a dlc (or failed) ? Then continue normally
              return fetchGamesDatabase().then(function (db) {
                try {
                  const gameData = db?.[String(appid)] ?? null;
                  if (gameData?.playable === 0) {
                    // warning modal
                    showLuaToolsPlayableWarning(
                      "This game may not work, support for it wont be given in our discord",
                      function () {
                        continueWithAdd();
                      },
                      function () {},
                    );
                  } else {
                    continueWithAdd();
                  }
                } catch (_) {
                  continueWithAdd();
                }
              });
            }
          }
        } catch (_) {}
      }
    },
    false,
  ); // Changed from true to false (bubble phase instead of capture phase)

  // Poll backend for progress and update progress bar and text
  function startPolling(appid, onFailedCallback) {
    let done = false;
    let lastCheckedApi = null;
    let successfulApi = null; // Track which API successfully found the file
    let completionHandled = false;
    const timer = setInterval(() => {
      if (done) {
        clearInterval(timer);
        return;
      }
      try {
        Millennium.callServerMethod("luatools", "GetAddViaLuaToolsStatus", {
          appid,
          contentScriptQuery: "",
        }).then(function (res) {
          try {
            const payload = typeof res === "string" ? JSON.parse(res) : res;
            const st = payload && payload.state ? payload.state : {};

            // Try to find overlay (may or may not be visible)
            const overlay = document.querySelector(".luatools-overlay");
            const title = overlay
              ? overlay.querySelector(".luatools-title")
              : null;
            const status = overlay
              ? overlay.querySelector(".luatools-status")
              : null;
            const wrap = overlay
              ? overlay.querySelector(".luatools-progress-wrap")
              : null;
            const progressInfo = overlay
              ? overlay.querySelector(".luatools-progress-info")
              : null;
            const percent = overlay
              ? overlay.querySelector(".luatools-percent")
              : null;
            const downloadSize = overlay
              ? overlay.querySelector(".luatools-download-size")
              : null;
            const bar = overlay
              ? overlay.querySelector(".luatools-progress-bar")
              : null;

            // Update individual API status in the list
            if (overlay) {
              const colors = getThemeColors();
              const apiItems = overlay.querySelectorAll(".luatools-api-item");

              // Track successful API when download/processing starts
              if (
                (st.status === "downloading" ||
                  st.status === "processing" ||
                  st.status === "installing" ||
                  st.status === "done") &&
                st.currentApi &&
                !successfulApi
              ) {
                successfulApi = st.currentApi;

                // Mark all APIs: not found before successful, skipped after
                let foundSuccessful = false;
                apiItems.forEach((item) => {
                  const apiName = item.getAttribute("data-api-name");
                  const apiStatus = item.querySelector(".luatools-api-status");
                  if (!apiStatus) return;

                  if (apiName === successfulApi) {
                    foundSuccessful = true;
                    item.style.background = `rgba(${colors.rgbString},0.2)`;
                    item.style.borderColor = colors.accent;
                    apiStatus.innerHTML = `<span style="color:${colors.accent};">${lt("Found")}</span><i class="fa-solid fa-check" style="color:${colors.accent};"></i>`;
                  } else if (!foundSuccessful) {
                    // This API comes before the successful one, check if it has an error first
                    if (st.apiErrors && st.apiErrors[apiName]) {
                      const apiError = st.apiErrors[apiName];
                      item.style.background = `rgba(255, 0, 0, 0.15)`;
                      item.style.borderColor = "#ff5c5c";
                      if (apiError.type === "timeout") {
                        apiStatus.innerHTML = `<span style="color:#ff5c5c;">${lt("Error, Timed Out")}</span><i class="fa-solid fa-clock" style="color:#ff5c5c;"></i>`;
                      } else if (apiError.type === "error") {
                        const code = apiError.code ? String(apiError.code) : "";
                        apiStatus.innerHTML = `<span style="color:#ff5c5c;">${lt("Error, Code: {code}").replace("{code}", code)}</span><i class="fa-solid fa-exclamation-triangle" style="color:#ff5c5c;"></i>`;
                      }
                    } else {
                      // Mark as not found
                      item.style.background = `rgba(0,0,0,0.2)`;
                      item.style.borderColor = colors.borderRgba;
                      apiStatus.innerHTML = `<span style="color:${colors.textSecondary};">${lt("Not found")}</span><i class="fa-solid fa-xmark" style="color:${colors.textSecondary};"></i>`;
                    }
                  } else {
                    // This API comes after the successful one, mark as skipped
                    item.style.background = `rgba(0,0,0,0.15)`;
                    item.style.borderColor = colors.borderRgba;
                    apiStatus.innerHTML = `<span style="color:${colors.textSecondary};">${lt("Skipped")}</span><i class="fa-solid fa-minus" style="color:${colors.textSecondary};"></i>`;
                  }
                });
              }

              // Mark previous API as not found if we moved to a new one (only during checking phase)
              if (
                st.status === "checking" &&
                st.currentApi &&
                st.currentApi !== lastCheckedApi &&
                lastCheckedApi
              ) {
                apiItems.forEach((item) => {
                  const apiName = item.getAttribute("data-api-name");
                  const apiStatus = item.querySelector(".luatools-api-status");
                  if (!apiStatus) return;

                  if (apiName === lastCheckedApi) {
                    item.style.background = `rgba(0,0,0,0.2)`;
                    item.style.borderColor = colors.borderRgba;
                    apiStatus.innerHTML = `<span style="color:${colors.textSecondary};">${lt("Not found")}</span><i class="fa-solid fa-xmark" style="color:${colors.textSecondary};"></i>`;
                  }
                });
              }

              // Update current API status during checking
              if (st.status === "checking" && st.currentApi) {
                apiItems.forEach((item) => {
                  const apiName = item.getAttribute("data-api-name");
                  const apiStatus = item.querySelector(".luatools-api-status");
                  if (!apiStatus) return;

                  if (apiName === st.currentApi) {
                    item.style.background = `rgba(${colors.rgbString},0.15)`;
                    item.style.borderColor = colors.accent;
                    apiStatus.innerHTML = `<span style="color:${colors.accent};">${lt("Checking…")}</span><i class="fa-solid fa-spinner" style="color:${colors.accent};animation: spin 1.5s linear infinite;"></i>`;
                  }
                });

                lastCheckedApi = st.currentApi;
              }

              // Show error statuses for APIs that errored (when not checking them anymore)
              if (st.apiErrors && typeof st.apiErrors === "object") {
                apiItems.forEach((item) => {
                  const apiName = item.getAttribute("data-api-name");
                  const apiStatus = item.querySelector(".luatools-api-status");
                  if (!apiStatus || !apiName) return;

                  const apiError = st.apiErrors[apiName];
                  if (!apiError) return;

                  // Only show error if this API is not currently being checked
                  if (st.currentApi === apiName && st.status === "checking")
                    return;

                  // Don't overwrite "Found" status
                  const statusText = apiStatus.textContent || "";
                  if (
                    statusText.includes("Found") ||
                    statusText.includes("Encontrado")
                  )
                    return;

                  item.style.background = `rgba(255, 0, 0, 0.15)`;
                  item.style.borderColor = "#ff5c5c";

                  if (apiError.type === "timeout") {
                    apiStatus.innerHTML = `<span style="color:#ff5c5c;">${lt("Error, Timed Out")}</span><i class="fa-solid fa-clock" style="color:#ff5c5c;"></i>`;
                  } else if (apiError.type === "error") {
                    const code = apiError.code ? String(apiError.code) : "";
                    apiStatus.innerHTML = `<span style="color:#ff5c5c;">${lt("Error, Code: {code}").replace("{code}", code)}</span><i class="fa-solid fa-exclamation-triangle" style="color:#ff5c5c;"></i>`;
                  }
                });
              }
            }

            // Update UI if overlay is present
            if (st.status === "checking" && st.currentApi && title) {
              title.textContent = lt("LuaTools · {api}").replace(
                "{api}",
                st.currentApi,
              );
            } else if (
              (st.status === "downloading" ||
                st.status === "processing" ||
                st.status === "installing") &&
              title
            ) {
              title.textContent = t("common.appName", "LuaTools");
            }

            if (status) {
              const spinner =
                '<i class="fa-solid fa-spinner" style="font-size:14px;animation: spin 1.5s linear infinite;margin-right:8px;"></i>';
              const dlIcon =
                '<i class="fa-solid fa-cloud-arrow-down" style="font-size:14px;animation: bounce 2s infinite;margin-right:8px;"></i>';
              const gearIcon =
                '<i class="fa-solid fa-gear" style="font-size:14px;animation: spin 3s linear infinite;margin-right:8px;"></i>';

              if (st.status === "checking")
                status.innerHTML =
                  spinner + "<span>" + lt("Checking availability…") + "</span>";
              if (st.status === "downloading")
                status.innerHTML =
                  dlIcon + "<span>" + lt("Downloading…") + "</span>";
              if (st.status === "processing")
                status.innerHTML =
                  gearIcon + "<span>" + lt("Processing package…") + "</span>";
              if (st.status === "installing")
                status.innerHTML =
                  gearIcon + "<span>" + lt("Installing…") + "</span>";
              if (st.status === "checking content")
                status.innerHTML =
                  spinner + "<span>" + lt("Checking content…") + "</span>";
              if (st.status === "failed")
                status.innerHTML =
                  '<i class="fa-solid fa-circle-xmark" style="color:#ff5c5c;font-size:14px;margin-right:8px;"></i><span>' +
                  lt("Failed") +
                  "</span>";
            }
            if (
              ["downloading", "processing", "installing"].includes(st.status)
            ) {
              // reveal progress UI (if overlay visible)
              if (wrap && wrap.style.display === "none")
                wrap.style.display = "block";
              if (progressInfo && progressInfo.style.display === "none") {
                progressInfo.style.display = "flex";
                progressInfo.style.justifyContent = "space-between";
              }

              const total = st.totalBytes || 0;
              const read = st.bytesRead || 0;
              let pct =
                total > 0 ? Math.floor((read / total) * 100) : read ? 1 : 0;
              if (pct > 100) pct = 100;
              if (pct < 0) pct = 0;

              // Update bar and percentage
              if (bar) bar.style.width = pct + "%";
              if (percent) percent.textContent = pct + "%";

              // Format file sizes (only if we have size data)
              if (downloadSize) {
                if (total > 0) {
                  const formatBytes = (bytes) => {
                    if (bytes === 0) return "0 B";
                    const k = 1024;
                    const sizes = ["B", "KB", "MB", "GB"];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return (
                      Math.round((bytes / Math.pow(k, i)) * 100) / 100 +
                      " " +
                      sizes[i]
                    );
                  };
                  downloadSize.textContent =
                    formatBytes(read) + " / " + formatBytes(total);
                } else {
                  downloadSize.textContent = "";
                }
              }
              // Show Cancel button during download
              const cancelBtn = overlay
                ? overlay.querySelector(".luatools-cancel-btn")
                : null;
              if (cancelBtn && st.status === "downloading")
                cancelBtn.style.display = "";
            }

            if (["checking content", "done"].includes(st.status)) {
              // Update popup if visible
              if (title) title.textContent = t("common.appName", "LuaTools");
              if (bar) bar.style.width = "100%";
              if (percent) percent.textContent = "100%";

              // hide progress visuals after a short beat
              if (wrap || progressInfo) {
                setTimeout(function () {
                  if (wrap) wrap.style.display = "none";
                  if (progressInfo) progressInfo.style.display = "none";
                }, 300);
              }

              // Hide Cancel button
              const cancelBtn = overlay
                ? overlay.querySelector(".luatools-cancel-btn")
                : null;
              if (cancelBtn) cancelBtn.style.display = "none";
            }

            if (st.status === "done") {
              if (completionHandled) return;
              completionHandled = true;
              // Update popup if visible
              if (overlay) {
                const doneColors = getThemeColors();
                // Hide API list for clean look
                const apiList = overlay.querySelector(".luatools-api-list");
                if (apiList) apiList.style.display = "none";
                // Hide progress
                if (wrap) wrap.style.display = "none";
                if (progressInfo) progressInfo.style.display = "none";
                // Hide cancel
                const cancelBtn = overlay.querySelector(".luatools-cancel-btn");
                if (cancelBtn) cancelBtn.style.display = "none";

                // Update title with success icon
                if (title) {
                  title.innerHTML = "";
                  title.style.cssText = `display:flex;align-items:center;justify-content:center;gap:10px;font-size:20px;color:${doneColors.text};margin-bottom:12px;font-weight:600;`;
                  const checkIcon = document.createElement("i");
                  checkIcon.className = "fa-solid fa-circle-check";
                  checkIcon.style.cssText = `color:${doneColors.accent};font-size:24px;`;
                  const checkText = document.createElement("span");
                  checkText.textContent = lt("Game Added!");
                  title.appendChild(checkIcon);
                  title.appendChild(checkText);
                }

                // Build status content
                if (status) {
                  const result = st.contentCheckResult;
                  status.style.textAlign = "center";

                  if (!result) {
                    status.innerText =
                      lt("The game has been added successfully.") +
                      "\n" +
                      lt(
                        "The Steam library will refresh automatically; no restart is usually needed.",
                      );
                  } else {
                    const status_content = [
                      lt(
                        "The Steam library will refresh automatically; no restart is usually needed.",
                      ),
                      "",
                      lt("Content details =>"),
                      `\u00A0\u00A0• ${lt("Workshop: ")}${lt(result.workshop)}`,
                    ];
                    if (
                      result.dlc.missing.length ||
                      result.dlc.included.length
                    ) {
                      status_content.push(`\u00A0\u00A0• ${lt("Dlc: ")}`);
                      if (result.dlc.included.length > 0) {
                        status_content.push(
                          `\u00A0\u00A0\u00A0\u00A0◦ ${lt("Included")}: ${result.dlc.included.length}`,
                        );
                      }
                      if (result.dlc.missing.length > 0) {
                        const missingLinks = result.dlc.missing
                          .map(
                            (id) =>
                              `<a href="#" class="lt-dlc-link" data-dlc-id="${id}" style="color:#67c1f5;text-decoration:underline;cursor:pointer;">${id}</a>`,
                          )
                          .join(", ");
                        status_content.push(
                          `\u00A0\u00A0\u00A0\u00A0◦ ${lt("Missing")}: ${result.dlc.missing.length} (${missingLinks})`,
                        );
                      }
                    }
                    status.style.whiteSpace = "pre-line";
                    status.innerHTML = status_content.join("\n");
                    status
                      .querySelectorAll(".lt-dlc-link")
                      .forEach(function (link) {
                        link.addEventListener("click", function (e) {
                          e.preventDefault();
                          try {
                            Millennium.callServerMethod(
                              "luatools",
                              "OpenExternalUrl",
                              {
                                url:
                                  "https://steamdb.info/app/" +
                                  link.dataset.dlcId +
                                  "/",
                                contentScriptQuery: "",
                              },
                            );
                          } catch (_) {}
                        });
                      });
                  }
                }

                // Update Hide button to styled Close
                const hideBtn = overlay.querySelector(".luatools-hide-btn");
                if (hideBtn) {
                  hideBtn.className = "luatools-btn primary luatools-hide-btn";
                  hideBtn.style.cssText =
                    "min-width:140px;display:flex;align-items:center;justify-content:center;text-align:center;";
                  hideBtn.innerHTML =
                    '<i class="fa-solid fa-xmark" style="margin-right:6px;"></i><span>' +
                    lt("Close") +
                    "</span>";
                }
              }
              done = true;
              clearInterval(timer);
              runState.inProgress = false;
              runState.appid = null;
              // Remove button since game is added (works even if popup is hidden)
              const btnEl = document.querySelector(".luatools-button");
              if (btnEl && btnEl.parentElement) {
                btnEl.parentElement.removeChild(btnEl);
              }
              // Steam may take a moment to notice the new stplug-in entry. The
              // SharedJS bridge waits for the app to appear, opens its Library
              // page, then invokes Steam's native install-location wizard.
              setTimeout(function () {
                if (overlay && overlay.parentElement) overlay.remove();
                openSteamInstallDialog(appid);
              }, 450);
            }
            if (st.status === "failed") {
              // Mark all APIs as not found when failed (unless they have error status)
              if (overlay && !successfulApi) {
                const colors = getThemeColors();
                const apiItems = overlay.querySelectorAll(".luatools-api-item");
                apiItems.forEach((item) => {
                  const apiName = item.getAttribute("data-api-name");
                  const apiStatus = item.querySelector(".luatools-api-status");
                  if (!apiStatus) return;

                  // Skip if this API already has an error status
                  if (st.apiErrors && st.apiErrors[apiName]) {
                    const apiError = st.apiErrors[apiName];
                    item.style.background = `rgba(255, 0, 0, 0.15)`;
                    item.style.borderColor = "#ff5c5c";
                    if (apiError.type === "timeout") {
                      apiStatus.innerHTML = `<span style="color:#ff5c5c;">${lt("Error, Timed Out")}</span><i class="fa-solid fa-clock" style="color:#ff5c5c;"></i>`;
                    } else if (apiError.type === "error") {
                      const code = apiError.code ? String(apiError.code) : "";
                      apiStatus.innerHTML = `<span style="color:#ff5c5c;">${lt("Error, Code: {code}").replace("{code}", code)}</span><i class="fa-solid fa-exclamation-triangle" style="color:#ff5c5c;"></i>`;
                    }
                    return;
                  }

                  // Check if this API is still in "Waiting..." or "Checking..." state
                  const statusText = apiStatus.textContent || "";
                  if (
                    statusText.includes("Waiting") ||
                    statusText.includes("Esperando") ||
                    statusText.includes("Checking") ||
                    statusText.includes("Verificando")
                  ) {
                    item.style.background = `rgba(0,0,0,0.2)`;
                    item.style.borderColor = colors.borderRgba;
                    apiStatus.innerHTML = `<span style="color:${colors.textSecondary};">${lt("Not found")}</span><i class="fa-solid fa-xmark" style="color:${colors.textSecondary};"></i>`;
                  }
                });
              }

              // show error in the popup if visible
              if (status)
                status.textContent = lt("Failed: {error}").replace(
                  "{error}",
                  st.error || lt("Unknown error"),
                );
              // Hide Cancel button and update Hide to Close
              const cancelBtn = overlay
                ? overlay.querySelector(".luatools-cancel-btn")
                : null;
              if (cancelBtn) cancelBtn.style.display = "none";
              const hideBtn = overlay
                ? overlay.querySelector(".luatools-hide-btn")
                : null;
              if (hideBtn) {
                hideBtn.style.display = "flex";
                hideBtn.className = "luatools-btn primary luatools-hide-btn";
                hideBtn.innerHTML =
                  '<i class="fa-solid fa-xmark" style="margin-right:6px;"></i><span>' +
                  lt("Close") +
                  "</span>";
              }
              if (wrap) wrap.style.display = "none";
              if (progressInfo) progressInfo.style.display = "none";
              done = true;
              clearInterval(timer);
              runState.inProgress = false;
              runState.appid = null;

              if (onFailedCallback) {
                onFailedCallback(st.error || "Unknown error");
              }
            }
          } catch (_) {}
        });
      } catch (_) {
        clearInterval(timer);
      }
    }, 300);
  }

  // Also try after a delay to catch dynamically loaded content
  setTimeout(addLuaToolsButton, 1000);
  setTimeout(addLuaToolsButton, 3000);

  // Listen for URL changes (Steam uses pushState for navigation)
  let lastUrl = window.location.href;

  function checkUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      // URL changed - reset flags and update buttons
      window.__LuaToolsButtonInserted = false;
      window.__LuaToolsRestartInserted = false;
      window.__LuaToolsIconInserted = false;
      window.__LuaToolsHeaderInserted = false;

      window.__LuaToolsPresenceCheckInFlight = false;
      window.__LuaToolsPresenceCheckAppId = undefined;
      // Update translations and re-add buttons.  Steam navigation can finish
      // inside the 500 ms insertion throttle or replace the target DOM shortly
      // after pushState, so guarantee bounded retries after every route change.
      const refreshButtonPlacement = function () {
        updateButtonTranslations();
        addLuaToolsButton();
      };
      ensureTranslationsLoaded(false)
        .then(refreshButtonPlacement)
        .catch(refreshButtonPlacement);
      setTimeout(addLuaToolsButton, BUTTON_CHECK_THROTTLE + 100);
      setTimeout(addLuaToolsButton, 1800);
    }
  }

  // Steam can replace the store document without delivering pushState,
  // popstate, or a useful mutation to this content script.  In that case a
  // route-only watcher sees the new URL too late (or starts with it) and the
  // bounded retries can all run before the app-page controls exist.  Keep a
  // cheap, generic presence watchdog: it only invokes the throttled placement
  // routine when an app page has no live button for its current AppID.
  const BUTTON_PLACEMENT_WATCHDOG_MS = 2000;
  function repairMissingAppPageButtons() {
    checkUrlChange();
    const appid = getCurrentDowngradeAppId();
    if (!appid) return;
    const button = document.getElementById("luatools-downgrade-link");
    if (
      !button ||
      !button.isConnected ||
      button.dataset.appid !== String(appid)
    ) {
      addLuaToolsButton();
    }
  }

  // Check URL changes and repair missed SPA/document transitions without
  // continuously rebuilding controls that are already present.
  setInterval(repairMissingAppPageButtons, BUTTON_PLACEMENT_WATCHDOG_MS);
  window.addEventListener("popstate", checkUrlChange);
  // Override pushState/replaceState to detect navigation
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function () {
    originalPushState.apply(history, arguments);
    setTimeout(checkUrlChange, 100);
  };
  history.replaceState = function () {
    originalReplaceState.apply(history, arguments);
    setTimeout(checkUrlChange, 100);
  };

  // Pre-fetch settings quietly to ensure background values (like fastDownload) are populated immediately,
  // and apply themes immediately once settings load.
  function bootSettings() {
    if (typeof Millennium === "undefined" || typeof Millennium.callServerMethod !== "function") {
        setTimeout(bootSettings, 200);
        return;
    }
    loadThemes().then(function() {
        return fetchSettingsConfig();
    }).then(function() {
        if (typeof ensureLuaToolsStyles === "function") ensureLuaToolsStyles();
    }).catch(function(e) {
        try { backendLog("LuaTools: Boot sequence failed: " + String(e)); } catch(_) {}
    });
  }
  bootSettings();

  // Use MutationObserver to catch dynamically added content
  // Heavily optimized and throttled version to avoid blocking gamepad
  if (typeof MutationObserver !== "undefined") {
    let mutationTimeout;
    let lastMutationProcessTime = 0;
    const MUTATION_THROTTLE = 1000; // Only process once per second

    const observer = new MutationObserver(function (mutations) {
      // Additional throttle on top of debounce
      const now = Date.now();
      if (now - lastMutationProcessTime < MUTATION_THROTTLE) {
        return; // Skip if processed recently
      }

      // Debounce mutations to avoid blocking the UI
      clearTimeout(mutationTimeout);
      mutationTimeout = setTimeout(function () {
        lastMutationProcessTime = Date.now();

        let shouldUpdate = false;
        // Quick check: only process first 10 mutations to avoid long loops
        const mutationsToCheck = Math.min(mutations.length, 10);

        for (let i = 0; i < mutationsToCheck; i++) {
          const mutation = mutations[i];
          if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            // Only check first 3 added nodes to avoid blocking
            const nodesToCheck = Math.min(mutation.addedNodes.length, 3);

            for (let j = 0; j < nodesToCheck; j++) {
              const node = mutation.addedNodes[j];
              if (node.nodeType === 1) {
                // Element node
                // Quick class check without querySelector (faster)
                if (
                  node.classList &&
                  (node.classList.contains("steamdb-buttons") ||
                    node.classList.contains("apphub_OtherSiteInfo") ||
                    node.id === "queueBtnFollow")
                ) {
                  shouldUpdate = true;
                  break;
                }
              }
            }
          }
          if (shouldUpdate) break;
        }

        if (shouldUpdate) {
          updateButtonTranslations();
          addLuaToolsButton();
        }
      }, 300); // Increased debounce to 300ms
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function showLoadedAppsPopup(apps) {
    // Avoid duplicates
    if (document.querySelector(".luatools-loadedapps-overlay")) return;
    ensureFontAwesome();
    ensureLuaToolsStyles();
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);z-index:99999;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease-out;";
    overlay.className = "luatools-loadedapps-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);z-index:99999;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease-out;";
    overlay.className = "luatools-loadedapps-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);z-index:99999;display:flex;align-items:center;justify-content:center;";
    const modal = document.createElement("div");
    const loadedAppsModalColors = getThemeColors();
    modal.style.cssText = `background:${loadedAppsModalColors.modalBg};color:${loadedAppsModalColors.text};border:2px solid ${loadedAppsModalColors.border};border-radius:8px;width:560px;padding:28px 32px;box-shadow:0 20px 60px rgba(0,0,0,.8), 0 0 0 1px ${loadedAppsModalColors.shadowRgba};animation:slideUp 0.1s ease-out;`;
    const title = document.createElement("div");
    const loadedAppsTitleColors = getThemeColors();
    title.style.cssText = `font-size:24px;color:${loadedAppsTitleColors.text};margin-bottom:20px;font-weight:700;text-shadow:0 2px 8px ${loadedAppsTitleColors.shadow};background:${loadedAppsTitleColors.gradientLight};-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;text-align:center;`;
    title.textContent = lt("LuaTools · Added Games");
    const body = document.createElement("div");
    const loadedAppsBodyColors = getThemeColors();
    body.style.cssText = `font-size:14px;line-height:1.8;margin-bottom:16px;max-height:320px;overflow:auto;padding:16px;border:1px solid ${loadedAppsBodyColors.border};border-radius:12px;background:${loadedAppsBodyColors.bgContainer};`;
    if (apps && apps.length) {
      const list = document.createElement("div");
      apps.forEach(function (item) {
        const a = document.createElement("a");
        a.href = "steam://install/" + String(item.appid);
        a.textContent = String(item.name || item.appid);
        const linkColors = getThemeColors();
        a.style.cssText = `display:block;color:${linkColors.textSecondary};text-decoration:none;padding:10px 16px;margin-bottom:8px;background:rgba(${linkColors.rgbString},0.08);border:1px solid rgba(${linkColors.rgbString},0.2);border-radius:4px;transition:all 0.3s ease;`;
        a.onmouseover = function () {
          const c = getThemeColors();
          this.style.background = `rgba(${c.rgbString},0.2)`;
          this.style.borderColor = c.accent;
          this.style.transform = "translateX(4px)";
          this.style.color = c.text;
        };
        a.onmouseout = function () {
          const c = getThemeColors();
          this.style.background = `rgba(${c.rgbString},0.08)`;
          this.style.borderColor = `rgba(${c.rgbString},0.2)`;
          this.style.transform = "translateX(0)";
          this.style.color = c.textSecondary;
        };
        a.onclick = function (e) {
          e.preventDefault();
          try {
            window.location.href = a.href;
          } catch (_) {}
        };
        a.oncontextmenu = function (e) {
          e.preventDefault();
          const url = "https://steamdb.info/app/" + String(item.appid) + "/";
          try {
            Millennium.callServerMethod("luatools", "OpenExternalUrl", {
              url,
              contentScriptQuery: "",
            });
          } catch (_) {}
        };
        list.appendChild(a);
      });
      body.appendChild(list);
    } else {
      body.style.textAlign = "center";
      body.textContent = lt("No games found.");
    }
    const btnRow = document.createElement("div");
    btnRow.style.cssText =
      "margin-top:16px;display:flex;gap:8px;justify-content:space-between;align-items:center;";
    const instructionText = document.createElement("div");
    instructionText.style.cssText = "font-size:12px;color:#8f98a0;";
    instructionText.textContent = lt(
      "Left click to install, Right click for SteamDB",
    );
    const dismissBtn = document.createElement("a");
    dismissBtn.className = "luatools-btn";
    dismissBtn.innerHTML = "<span>" + lt("Dismiss") + "</span>";
    dismissBtn.href = "#";
    dismissBtn.onclick = function (e) {
      e.preventDefault();
      try {
        Millennium.callServerMethod("luatools", "DismissLoadedApps", {
          contentScriptQuery: "",
        });
      } catch (_) {}
      try {
        sessionStorage.setItem("LuaToolsLoadedAppsShown", "1");
      } catch (_) {}
      overlay.remove();
    };
    btnRow.appendChild(instructionText);
    btnRow.appendChild(dismissBtn);
    modal.appendChild(title);
    modal.appendChild(body);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);

    // Re-scan elements for gamepad navigation
    setTimeout(function () {
      if (window.GamepadNav) {
        window.GamepadNav.scanElements();
      }
    }, 150);
  }

  // ============================================
  // GAMEPAD NAVIGATION INTEGRATION
  // ============================================
  // Note: The gamepad back handler is configured in the gamepad system at the top of this file
  // It already handles all overlay types automatically using OVERLAY_SELECTOR_STRING
})();
