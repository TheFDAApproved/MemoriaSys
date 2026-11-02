(function () {
    "use strict";

    const API_URL = "api/settings";

    // Settings that are rendered as dropdowns
    // Maps the setting key to the placeholder text shown in the dropdown1
    const SELECT_SETTINGS = {
        payment_channels_list: "Select payment method",
        payment_purposes_list: "Select payment purpose",
        barangay_options: "Select barangay",
    };

    // Settings that are rendered as editable .list containers
    // Maps the setting key to the CSS class used on the input row
    const DROPDOWN_INPUT_CLASSES = {
        payment_channels_list: "channelInput",
        payment_purposes_list: "purposeInput",
        barangay_options: "barangayInput",
    };

    // These settings store a plain address string. When the matching element is a link (<a>), its href is pointed at Google Maps
    const MAPS_ADDRESS_KEYS = new Set(["cemetery_address", "office_address"]);
    const MAPS_BASE_URL = "https://maps.google.com/";

    // These settings store a plain email or phone string. When the matching element is a link (<a>), the href becomes mailto: or tel:
    const CONTACT_LINK_KEYS = new Set(["contact_email", "contact_phone"]);

    // Load every setting from the API and write it into matching page elements. Elements are matched by the start of their id
    function loadSiteContent(showerror = false) {
        fetch(API_URL, { cache: "no-store" })
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then((result) => {
                const rows = Array.isArray(result) ? result : result?.data;
                if (!Array.isArray(rows)) {
                    if (typeof showAlertTOP === "function" && showerror) {
                        showAlertTOP("Failed to load settings: invalid response", "error");
                    }
                    return;
                }

                // Build a lookup: setting_key -> value
                // The first occurrence of a key wins
                const settings = new Map();
                for (const row of rows) {
                    const key = row?.setting_key ?? row?.key;
                    const value = row?.setting_value ?? row?.value ?? "";
                    if (!key || settings.has(key)) continue;
                    settings.set(key, value);
                }

                // Process longer keys first so they claim their elements before shorter prefixes can overwrite them
                const keys = [...settings.keys()].sort((a, b) => b.length - a.length);
                const claimed = new Set();

                for (const key of keys) {
                    const value = settings.get(key);

                    // Skip keys that would break the CSS selector below
                    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
                        continue;
                    }

                    // Collect every element whose id starts with this key
                    const targets = [];
                    document.querySelectorAll(`[id^="${key}"]`).forEach((el) => {
                        if (claimed.has(el)) return;
                        claimed.add(el);
                        targets.push(el);
                    });

                    if (targets.length === 0) {
                        continue;
                    }

                    // Dropdown
                    if (SELECT_SETTINGS[key]) {
                        let options;
                        try {
                            options = JSON.parse(value);
                        } catch {
                            continue;
                        }

                        const placeholder = SELECT_SETTINGS[key];

                        targets.forEach((el) => {
                            // Classic <select> element
                            if (el.tagName === "SELECT") {
                                populateSelect(el, options, placeholder);
                                return;
                            }

                            // Editable list container rendered by JS
                            if (el.classList.contains("list")) {
                                const inputClass =
                                    DROPDOWN_INPUT_CLASSES[key] ?? "purposeInput";

                                // Normalise options to an array of strings
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
                                }
                                return;
                            }
                        });

                        continue;
                    }

                    // Google Maps iFrame src
                    // The value is a URL. It is applied to a matching iframe, or stored as-is if the target is a text field
                    if (key === "cemetery_google_maps") {
                        targets.forEach((el) => {
                            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
                                if (el.type === "checkbox") {
                                    el.checked = /^(1|true|yes|on)$/i.test(String(value).trim());
                                } else {
                                    el.value = value;
                                }
                                return;
                            }

                            const iframe =
                                el.tagName === "IFRAME" ? el : el.querySelector("iframe");
                            if (!iframe) {
                                return;
                            }

                            try {
                                const url = new URL(value, window.location.href);
                                if (url.protocol === "http:" || url.protocol === "https:") {
                                    iframe.src = url.href;
                                }
                            } catch { }
                        });
                        continue;
                    }

                    // Addresses -> Google Maps links
                    if (MAPS_ADDRESS_KEYS.has(key)) {
                        const address =
                            value === null || value === undefined ? "" : String(value).trim();

                        targets.forEach((el) => {
                            // Editable fields keep the plain address text.
                            if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
                                if (el.type === "checkbox") {
                                    el.checked = /^(1|true|yes|on)$/i.test(address);
                                } else if (el.type === "file" || el.type === "radio") {
                                    return;
                                } else {
                                    el.value = address;
                                }
                                return;
                            }

                            // Links show the address and point at Google Maps
                            if (el.tagName === "A") {
                                el.textContent = address;

                                if (address) {
                                    el.setAttribute("href", buildMapsHref(address));
                                } else {
                                    el.removeAttribute("href");
                                }
                                return;
                            }

                            // Fallback: plain text
                            el.textContent = address;
                        });

                        continue;
                    }

                    // Contact links (mailto: / tel:) 
                    if (CONTACT_LINK_KEYS.has(key)) {
                        const contact =
                            value === null || value === undefined ? "" : String(value).trim();

                        targets.forEach((el) => {
                            // Editable fields keep the plain value
                            if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
                                if (el.type === "checkbox") {
                                    el.checked = /^(1|true|yes|on)$/i.test(contact);
                                } else if (el.type === "file" || el.type === "radio") {
                                    return;
                                } else {
                                    el.value = contact;
                                }
                                return;
                            }

                            // Links show the value and use mailto:/tel: hrefs
                            if (el.tagName === "A") {
                                el.textContent = contact;

                                const href = buildContactHref(key, contact);
                                if (href) {
                                    el.setAttribute("href", href);
                                } else {
                                    el.removeAttribute("href");
                                }
                                return;
                            }

                            // Fallback: plain text
                            el.textContent = contact;
                        });

                        continue;
                    }

                    // All other settings
                    targets.forEach((el) => {
                        if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
                            if (el.type === "checkbox") {
                                el.checked = /^(1|true|yes|on)$/i.test(String(value).trim());
                            } else if (el.type === "file" || el.type === "radio") {
                                return;
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
                if (typeof showAlertTOP === "function" && showerror) {
                    showAlertTOP("Failed to load settings", "error");
                }
            });
    }

    // Build a Google Maps search URL for an address string
    // Returns "" when the address is empty
    function buildMapsHref(address) {
        const text = String(address ?? "").trim();
        if (!text) return "";
        return `${MAPS_BASE_URL}?${new URLSearchParams({ q: text }).toString()}`;
    }

    // Build a mailto: or tel: URL for a contact value
    // Returns "" when the value is empty
    function buildContactHref(key, value) {
        const text = String(value ?? "").trim();
        if (!text) return "";

        if (key === "contact_email") {
            return `mailto:${text}`;
        }

        // tel: strips whitespace and parentheses so the URL is clean, while keeping digits, "+", and separators like "-" / "."
        const phone = text.replace(/[\s()]/g, "");
        return phone ? `tel:${phone}` : "";
    }

    // Fill a <select> with options from JSON data
    // The placeholder is shown first and cannot be re-selected
    function populateSelect(select, data, placeholder) {
        const options = [];

        // Normalise the input to a list of { value, label }
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
            opt.disabled = true;
            opt.selected = true;
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
            select.value = "";
        }
    }

    window.loadSiteContent = loadSiteContent;
})();

(function () {
    "use strict";

    // Endpoint that returns the current user's info
    const USER_API = "api/users/me";

    // Special id-prefix aliases: id prefix -> JSON key
    // Any element whose id starts with the left side reads from the right side
    const ALIASES = {
        user_name: "username",
        user_role: "role",
        fullname: "name",
    };

    // Load the current user's info and write it into matching page elements
    function loadUserContent(showerror = false) {
        fetch(USER_API, { cache: "no-store", credentials: "same-origin" })
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then((result) => {
                // Accept either { data: {...} } or a raw user object
                const user = result?.data ?? result;

                if (!user || typeof user !== "object" || Array.isArray(user)) {
                    if (typeof showAlertTOP === "function" && showerror) {
                        showAlertTOP("Failed to load user info: invalid response", "error");
                    }
                    return;
                }

                const claimed = new Set();

                // Special case: avatar shows the first two letters of the name
                paintUserAvatar(user, claimed);

                // Fill alias-based elements (user_name, user_role, fullname)
                for (const [idPrefix, sourceKey] of Object.entries(ALIASES)) {
                    const value = user[sourceKey];
                    if (value === undefined || value === null) continue;
                    for (const el of collectTargets(idPrefix, claimed)) {
                        writeValue(el, value);
                    }
                }

                // Fill every other element whose id starts with a JSON key
                // Longer keys first so overlaps resolve safely
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
                if (typeof showAlertTOP === "function" && showerror) {
                    showAlertTOP("Failed to load user info", "error");
                }
            });
    }

    // Paint #user_avatar* with the first two letters of the user's name
    function paintUserAvatar(user, claimed) {
        const source = String(user?.name ?? user?.username ?? "").trim();
        if (!source) return;

        // Use code points so emoji characters are counted correctly
        const initials = Array.from(source).slice(0, 2).join("").toUpperCase();

        for (const el of collectTargets("user_avatar", claimed)) {
            writeValue(el, initials);
        }
    }

    // Find all elements whose id starts with `prefix`, skipping claimed ones
    function collectTargets(prefix, claimed) {
        if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
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

    // Write a scalar value into the correct slot for the element type
    function writeValue(el, value) {
        const text = value === null || value === undefined ? "" : String(value);

        switch (el.tagName) {
            case "INPUT":
                if (el.type === "checkbox") {
                    el.checked = /^(1|true|yes|on)$/i.test(text.trim());
                    return;
                }
                if (el.type === "radio") return;
                el.value = text;
                return;
            case "TEXTAREA":
            case "SELECT":
                el.value = text;
                return;
            default:
                el.textContent = text;
        }
    }

    window.loadUserContent = loadUserContent;
})();

(function () {
    "use strict";

    // Query parameter used for cache-busting
    const CACHE_PARAM = "t";
    const DEFAULT_SELECTOR = "img, source, video[poster]";
    const DEFAULT_TIMEOUT = 10000;

    // Should this URL be rewritten at all?
    // Skips empty values, in-page anchors, and inline or non-network URLs
    function isBustable(raw) {
        if (typeof raw !== "string") return false;
        const value = raw.trim();
        if (!value || value.startsWith("#")) return false;
        if (/^(data|blob|javascript|mailto|tel|about):/i.test(value)) return false;
        return true;
    }

    // Return `raw` with ?t=<stamp> set (replacing any previous value)
    // Returns null for URLs that are not http(s)
    function withStamp(raw, stamp) {
        try {
            const url = new URL(raw, document.baseURI);
            if (url.protocol !== "http:" && url.protocol !== "https:") return null;
            url.searchParams.set(CACHE_PARAM, stamp);
            return url.href;
        } catch {
            return null;
        }
    }

    // Cache-bust every candidate URL inside a srcset string
    function bustSrcset(srcset, stamp) {
        // data: URLs contain commas and cannot be split safely
        if (!srcset || /data:/i.test(srcset)) return null;

        return srcset
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const pieces = part.split(/\s+/);
                const busted = withStamp(pieces[0], stamp);
                if (!busted) return part;
                pieces[0] = busted;
                return pieces.join(" ");
            })
            .join(", ");
    }

    // Resolve when an <img> finishes loading (or errors / times out)
    function waitForImage(img, timeout) {
        return new Promise((resolve) => {
            // Already decoded and usable? Nothing to wait for
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

    // Add a fresh ?t=<timestamp> to every image URL inside `root` (or the whole page) so the browser re-downloads instead of using cache
    // Returns a Promise with a summary once images finish loading
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

        const elements = Array.from(scope.querySelectorAll(selector));

        // Include `root` itself if it matches the selector
        if (scope.nodeType === 1 && scope.matches && scope.matches(selector)) {
            elements.unshift(scope);
        }

        const jobs = [];

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

        // Apply all the new URLs first
        for (const job of jobs) {
            job.el.setAttribute(job.attr, job.value);
        }

        // Then wait for the <img> elements to finish loading
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

    window.refreshImages = refreshImages;
    window.reloadImages = refreshImages;
})();