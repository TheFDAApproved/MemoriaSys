(function () {
  "use strict";

  const API_URL = "/api/settings";

  // Dropdowns: setting_key -> placeholder text
  const SELECT_SETTINGS = {
    payment_channels_list: "Select payment method",
    payment_purposes_list: "Select payment purpose",
  };

  function loadSiteContent() {
    fetch(API_URL, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((result) => {
        const rows = Array.isArray(result) ? result : result?.data;
        if (!Array.isArray(rows)) {
          console.error("Invalid settings response:", result);
          if (typeof showAlertTOP === "function") {
            showAlertTOP("Failed to load settings: invalid response", "error");
          }
          return;
        }

        // Build a map: setting_key -> value (first occurrence wins)
        const settings = new Map();
        for (const row of rows) {
          const key = row?.setting_key ?? row?.key;
          const value = row?.setting_value ?? row?.value ?? "";
          if (!key || settings.has(key)) continue;
          settings.set(key, value);
        }

        // Process longer keys first so they claim their elements
        // before shorter prefixes can overwrite them.
        const keys = [...settings.keys()].sort((a, b) => b.length - a.length);
        const claimed = new Set();

        for (const key of keys) {
          const value = settings.get(key);

          // Safe key check for CSS selector
          if (!/^[A-Za-z0-9_-]+$/.test(key)) {
            console.warn(`Skipping unsafe setting key: "${key}"`);
            continue;
          }

          // Find every element whose id starts with this key
          const targets = [];
          document.querySelectorAll(`[id^="${key}"]`).forEach((el) => {
            if (claimed.has(el)) return;
            claimed.add(el);
            targets.push(el);
          });

          if (targets.length === 0) {
            console.warn(`No element found with id starting with "${key}"`);
            continue;
          }

          // ---------- Dropdown lists ----------
          if (SELECT_SETTINGS[key]) {
            let options;
            try {
              options = JSON.parse(value);
            } catch {
              console.warn(`Invalid JSON for ${key}:`, value);
              continue;
            }
            const placeholder = SELECT_SETTINGS[key];
            targets.forEach((el) => {
              if (el.tagName === "SELECT") {
                populateSelect(el, options, placeholder);
              } else {
                console.warn(`Element for "${key}" is not a <select>`, el);
              }
            });
            continue;
          }

          // ---------- Google Maps iframe src ----------
          if (key === "cemetery_google_maps") {
            targets.forEach((el) => {
              let iframe =
                el.tagName === "IFRAME" ? el : el.querySelector("iframe");
              if (!iframe) {
                console.warn(`No iframe found for #${el.id}`);
                return;
              }
              try {
                const url = new URL(value, window.location.href);
                if (url.protocol === "http:" || url.protocol === "https:") {
                  iframe.src = url.href;
                } else {
                  console.warn("Invalid map URL protocol:", value);
                }
              } catch {
                console.warn("Invalid map URL:", value);
              }
            });
            continue;
          }

          // ---------- All other settings (text / value) ----------
          targets.forEach((el) => {
            if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
              if (el.type === "checkbox") {
                el.checked = /^(1|true|yes|on)$/i.test(String(value).trim());
              } else {
                el.value = value;
              }
            } else {
              el.textContent = value;
            }
          });
        }
      })
      .catch((error) => {
        console.error("Error loading settings:", error);
        if (typeof showAlertTOP === "function") {
          showAlertTOP("Failed to load settings", "error");
        }
      });
  }

  // Helper: fill a <select> with options from JSON data
  function populateSelect(select, data, placeholder) {
    // Normalise to array of { value, label }
    const options = [];

    if (Array.isArray(data)) {
      data.forEach((item) => {
        if (item === null || item === undefined) return;
        if (typeof item === "object") {
          const value = item.value ?? item.id ?? item.key ?? item.name ?? "";
          const label =
            item.label ?? item.text ?? item.title ?? item.name ?? value;
          options.push({ value: String(value), label: String(label) });
        } else {
          options.push({ value: String(item), label: String(item) });
        }
      });
    } else if (data && typeof data === "object") {
      for (const [value, label] of Object.entries(data)) {
        options.push({ value: String(value), label: String(label) });
      }
    }

    const previous = select.value;
    select.innerHTML = "";

    if (placeholder) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = placeholder;
      opt.disabled = true; // <-- can't be re-selected
      opt.selected = true; // <-- shown by default until user picks something
      select.appendChild(opt);
    }

    options.forEach(({ value, label }) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    });

    // Keep the previously selected value if it still exists
    if (previous && options.some((o) => o.value === previous)) {
      select.value = previous;
    } else if (placeholder) {
      select.value = ""; // stays on the disabled placeholder
    }
  }

  // Expose globally so you can call it wherever needed
  window.loadSiteContent = loadSiteContent;
})();

(function () {
  "use strict";

  const USER_API = "/api/users/me";

  /* ------------------------------------------------------------------
   * Special id-prefix aliases: id prefix -> JSON key.
   * Any element whose id starts with the left side gets the right side.
   * ------------------------------------------------------------------ */
  const ALIASES = {
    user_name: "username", // #user_name*      -> username
    user_role: "role", // #user_role*      -> role
    fullname: "name", // #fullname*       -> name
    // user_avatar is handled separately (first two letters of name, uppercase)
  };

  function loadUserContent() {
    fetch(USER_API, { cache: "no-store", credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((result) => {
        // Accept either { data: {...} } or a raw user object
        const user = result?.data ?? result;

        if (!user || typeof user !== "object" || Array.isArray(user)) {
          console.error("Invalid user response:", result);
          if (typeof showAlertTOP === "function") {
            showAlertTOP("Failed to load user info: invalid response", "error");
          }
          return;
        }

        const claimed = new Set();

        // 1. Special case: user_avatar -> first two letters of name, uppercase
        paintUserAvatar(user, claimed);

        // 2. Aliases (user_name, user_role, fullname) -> source JSON keys
        for (const [idPrefix, sourceKey] of Object.entries(ALIASES)) {
          const value = user[sourceKey];
          if (value === undefined || value === null) continue;
          for (const el of collectTargets(idPrefix, claimed)) {
            writeValue(el, value);
          }
        }

        // 3. Every JSON key -> any element whose id starts with that key.
        //    Longest keys first so overlaps resolve safely.
        const keys = Object.keys(user).sort((a, b) => b.length - a.length);
        for (const key of keys) {
          const value = user[key];
          if (value === undefined || value === null) continue;
          for (const el of collectTargets(key, claimed)) {
            writeValue(el, value);
          }
        }
      })
      .catch((error) => {
        console.error("Error loading user:", error);
        if (typeof showAlertTOP === "function") {
          showAlertTOP("Failed to load user info", "error");
        }
      });
  }

  /* ---------------------- helpers ---------------------- */

  /** Paint #user_avatar* with the first two letters of the user's name. */
  function paintUserAvatar(user, claimed) {
    const source = String(user?.name ?? user?.username ?? "").trim();
    if (!source) return;

    // First two characters, uppercased (uses code points, so emoji-safe)
    const initials = Array.from(source).slice(0, 2).join("").toUpperCase();

    for (const el of collectTargets("user_avatar", claimed)) {
      writeValue(el, initials);
    }
  }

  /** All elements whose id starts with `prefix`, skipping claimed ones. */
  function collectTargets(prefix, claimed) {
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
      console.warn(`Skipping unsafe id prefix: "${prefix}"`);
      return [];
    }
    const found = [];
    document.querySelectorAll(`[id^="${prefix}"]`).forEach((el) => {
      if (claimed.has(el)) return;
      claimed.add(el);
      found.push(el);
    });
    return found;
  }

  /** Write a scalar into the correct slot for the element type. */
  function writeValue(el, value) {
    const text = value === null || value === undefined ? "" : String(value);

    switch (el.tagName) {
      case "INPUT":
        if (el.type === "checkbox") {
          el.checked = /^(1|true|yes|on)$/i.test(text.trim());
          return;
        }
        if (el.type === "radio") return; // handled manually if needed
        el.value = text;
        return;
      case "TEXTAREA":
      case "SELECT":
        el.value = text;
        return;
      default:
        el.textContent = text; // never parsed as HTML -> safe
    }
  }

  /* expose globally */
  window.loadUserContent = loadUserContent;
})();
