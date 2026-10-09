(function () {
  "use strict";

  const API_URL = "api/settings";

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
              // Classic <select>
              if (el.tagName === "SELECT") {
                populateSelect(el, options, placeholder);
                return;
              }

              // Our editable list container (e.g. <div class="list" id="...">)
              if (el.classList.contains("list")) {
                const inputClass =
                  key === "payment_channels_list"
                    ? "channelInput"
                    : "purposeInput";

                // Normalise to an array of strings (rebuildDropdownList expects strings)
                const items = Array.isArray(options)
                  ? options
                      .map((o) => {
                        if (o === null || o === undefined) return "";
                        if (typeof o === "object") {
                          return String(o.value ?? o.label ?? o.name ?? "");
                        }
                        return String(o);
                      })
                      .filter(Boolean)
                  : Object.values(options).map(String);

                if (typeof window.rebuildDropdownList === "function") {
                  window.rebuildDropdownList(key, items, inputClass);
                } else {
                  console.warn("rebuildDropdownList not defined yet");
                }
                return;
              }

              console.warn(
                `Element for "${key}" is not a <select> or .list`,
                el,
              );
            });

            continue;
          }
          // ---------- Google Maps iframe src (or plain text input) ----------
          if (key === "cemetery_google_maps") {
            targets.forEach((el) => {
              // Text input / textarea: just store the URL string as-is
              if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
                if (el.type === "checkbox") {
                  el.checked = /^(1|true|yes|on)$/i.test(String(value).trim());
                } else {
                  el.value = value;
                }
                return;
              }

              // Otherwise: the element itself is an iframe, or contains one
              const iframe =
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
              } else if (el.type === "file" || el.type === "radio") {
                return; // cannot be set programmatically — skip
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

  const USER_API = "api/users/me";

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

(function () {
  "use strict";

  /* ==================================================================
   * refreshImages()
   * ------------------------------------------------------------------
   * Cache-busts every <img> (plus <source srcset> and <video poster>)
   * by writing a fresh ?t=<timestamp> onto the URL, forcing the
   * browser to re-download the image instead of reusing its cache.
   *
   *   await window.refreshImages();                       // whole page
   *   window.refreshImages(document.querySelector("#gallery"));
   *   window.refreshImages(document, { stamp: "v2", timeout: 5000 });
   *
   * Returns a Promise that resolves with a small summary object once
   * every image has loaded (or the timeout elapsed).
   * ================================================================== */

  const CACHE_PARAM = "t"; // query param used for cache-busting
  const DEFAULT_SELECTOR = "img, source, video[poster]";
  const DEFAULT_TIMEOUT = 10000;

  /* ---------------------- helpers ---------------------- */

  /** Should we touch this URL at all? */
  function isBustable(raw) {
    if (typeof raw !== "string") return false;
    const value = raw.trim();
    if (!value || value.startsWith("#")) return false;
    // Never rewrite inline / non-network URLs
    if (/^(data|blob|javascript|mailto|tel|about):/i.test(value)) return false;
    return true;
  }

  /** Return `raw` with ?t=<stamp> set (replacing any previous value). */
  function withStamp(raw, stamp) {
    try {
      const url = new URL(raw, document.baseURI);
      // Only http(s) — skip anything exotic
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      url.searchParams.set(CACHE_PARAM, stamp); // set() replaces, never stacks
      return url.href;
    } catch {
      return null;
    }
  }

  /** Cache-bust every candidate URL inside a srcset string. */
  function bustSrcset(srcset, stamp) {
    // Commas inside data: URLs would break naive splitting — just skip those.
    if (!srcset || /data:/i.test(srcset)) return null;

    return srcset
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const pieces = part.split(/\s+/); // [url, ...descriptors]
        const busted = withStamp(pieces[0], stamp);
        if (!busted) return part;
        pieces[0] = busted;
        return pieces.join(" ");
      })
      .join(", ");
  }

  /** Resolve when an <img> finishes loading (or errors / times out). */
  function waitForImage(img, timeout) {
    return new Promise((resolve) => {
      // Already decoded and usable? Nothing to wait for.
      if (img.complete && img.naturalWidth > 0) {
        resolve(true);
        return;
      }

      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
      };

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ok);
      };

      const onLoad = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), timeout);

      img.addEventListener("load", onLoad);
      img.addEventListener("error", onError);
    });
  }

  /* ---------------------- main ---------------------- */

  function refreshImages(root, options) {
    const scope =
      root && typeof root.querySelectorAll === "function" ? root : document;

    const opts = options || {};
    const stamp = String(opts.stamp != null ? opts.stamp : Date.now());
    const selector =
      typeof opts.selector === "string" ? opts.selector : DEFAULT_SELECTOR;
    const timeout = Number.isFinite(opts.timeout)
      ? opts.timeout
      : DEFAULT_TIMEOUT;

    // Collect the elements we care about.
    const elements = Array.from(scope.querySelectorAll(selector));

    // If `scope` itself is a matching element (e.g. you passed an <img>),
    // make sure it's included too.
    if (scope.nodeType === 1 && scope.matches && scope.matches(selector)) {
      elements.unshift(scope);
    }

    const jobs = []; // { el, attr, value }

    for (const el of elements) {
      const tag = el.tagName;

      if (tag === "IMG") {
        const src = el.getAttribute("src");
        if (isBustable(src)) {
          const busted = withStamp(src, stamp);
          if (busted) jobs.push({ el, attr: "src", value: busted });
        }

        const srcset = el.getAttribute("srcset");
        const bustedSet = bustSrcset(srcset, stamp);
        if (bustedSet) jobs.push({ el, attr: "srcset", value: bustedSet });
      } else if (tag === "SOURCE") {
        const srcset = el.getAttribute("srcset");
        const bustedSet = bustSrcset(srcset, stamp);
        if (bustedSet) jobs.push({ el, attr: "srcset", value: bustedSet });
      } else if (tag === "VIDEO") {
        const poster = el.getAttribute("poster");
        if (isBustable(poster)) {
          const busted = withStamp(poster, stamp);
          if (busted) jobs.push({ el, attr: "poster", value: busted });
        }
      }
    }

    if (jobs.length === 0) {
      return Promise.resolve({ stamp, updated: 0, loaded: 0, failed: 0 });
    }

    // Apply all the new URLs first…
    for (const job of jobs) {
      job.el.setAttribute(job.attr, job.value);
    }

    // …then wait for the <img> elements to actually finish loading.
    const images = elements.filter((el) => el.tagName === "IMG");

    return Promise.all(images.map((img) => waitForImage(img, timeout))).then(
      (results) => {
        const loaded = results.filter(Boolean).length;
        return {
          stamp,
          updated: jobs.length,
          loaded,
          failed: images.length - loaded,
        };
      },
    );
  }

  /* expose globally */
  window.refreshImages = refreshImages;
  window.reloadImages = refreshImages; // friendly alias
})();
