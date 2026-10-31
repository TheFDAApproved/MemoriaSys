// Show a preview of a selected image file inside an <img> element
function previewImage(input, previewId) {
    if (!input?.files?.length) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = document.getElementById(previewId);
        if (img) img.src = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
}

// Dynamic list options
// Maps each list container to the input class and name it should use
const LIST_INPUT_CONFIG = {
    payment_channels_list: {
        inputClass: "channelInput",
        inputName: "payment_channels[]",
    },
    payment_purposes_list: {
        inputClass: "purposeInput",
        inputName: "payment_purposes[]",
    },
    barangay_options: {
        inputClass: "barangayInput",
        inputName: "barangay_options[]",
    },
};

// Return the config for a container, falling back to the purpose settings
function getListInputConfig(containerId) {
    return (
        LIST_INPUT_CONFIG[containerId] || {
            inputClass: "purposeInput",
            inputName: "payment_purposes[]",
        }
    );
}

// Create one row [text input + delete button] for a list container
function createOptionItem(containerId, value = "") {
    const { inputClass, inputName } = getListInputConfig(containerId);

    const div = document.createElement("div");
    div.className = "listItem optionItem";

    const input = document.createElement("input");
    input.type = "text";
    input.className = inputClass;
    input.name = inputName;
    input.value = value;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn iconBtn dangerBtn";
    btn.addEventListener("click", () => {
        const item = btn.closest(".optionItem");
        if (item) item.remove();
    });
    btn.innerHTML = '<i class="fas fa-trash-alt"></i>';

    div.appendChild(input);
    div.appendChild(btn);
    return div;
}

// Append a new empty row to the given container
function addOption(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const item = createOptionItem(containerId, "");
    container.appendChild(item);
}

// Replace all rows in a container with the given values.
function rebuildDropdownList(containerId, itemsArray) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = "";

    for (const item of itemsArray) {
        const itemDiv = createOptionItem(containerId, item);
        container.appendChild(itemDiv);
    }
}

// Remove a row using its closest .optionItem ancestor
function removeOption(button) {
    const item = button.closest(".optionItem");
    if (item) item.remove();
}

// Save button loading state
const SAVE_API_URL = "api/settings";

// Inject the CSS used to show a saving overlay and loading button state
(function injectSaveLoadingCss() {
    if (document.getElementById("saveLoadingStyles")) return;
    const s = document.createElement("style");
    s.id = "saveLoadingStyles";
    s.textContent = `
    #site_content_form {
      position: relative;
      transition: opacity 150ms ease;
    }
    #site_content_form.is-saving {
      pointer-events: none;
    }
    #site_content_form.is-saving::after {
      content: "";
      position: absolute;
      inset: 0;
      background: rgba(255, 255, 255, 0.55);
      -webkit-backdrop-filter: blur(1px);
      backdrop-filter: blur(1px);
      border-radius: inherit;
      z-index: 20;
    }

    .btn.is-loading {
      cursor: progress !important;
      opacity: 0.85;
      pointer-events: none;
    }
  `;
    document.head.appendChild(s);
})();

// Find the save button by trying known IDs, then selectors, then text match
function resolveSaveButton(form) {
    return (
        document.getElementById("save_site_content") ||
        document.getElementById("saveSiteContent") ||
        document.getElementById("save_changes") ||
        document.getElementById("site_content_save") ||
        form?.querySelector('button[type="submit"]') ||
        form?.querySelector(".btn.primaryBtn, .btn.btnPrimary, .btn-primary") ||
        [...document.querySelectorAll("button")].find((b) =>
            /save\s*changes/i.test(b.textContent || ""),
        ) ||
        null
    );
}

// Toggle the "saving" state on the form and its save button
// Returns a restore function when enabled so the caller can reset the UI
function setSavingState(isSaving, { form, button } = {}) {
    if (!form) form = document.getElementById("site_content_form");
    const btn = button || resolveSaveButton(form);

    if (!isSaving) {
        if (form) form.classList.remove("is-saving");
        if (btn) {
            btn.disabled = false;
            btn.classList.remove("is-loading");
            btn.removeAttribute("aria-busy");
        }
        return () => { };
    }

    const savedHtml = btn ? btn.innerHTML : null;

    if (form) form.classList.add("is-saving");
    if (btn) {
        btn.disabled = true;
        btn.classList.add("is-loading");
        btn.setAttribute("aria-busy", "true");
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    }

    return function restore() {
        if (form) form.classList.remove("is-saving");
        if (btn) {
            btn.disabled = false;
            btn.classList.remove("is-loading");
            btn.removeAttribute("aria-busy");
            if (savedHtml !== null) btn.innerHTML = savedHtml;
        }
    };
}

// Settings schema
// Describes every field saved by the form [image, text, or list]
const SETTINGS_SPEC = {
    logo_1: { description: "Header Logo 1", kind: "image" },
    logo_2: { description: "Header Logo 2", kind: "image" },
    cemetery_logo: { description: "Cemetery Logo", kind: "image" },
    cemetery_mark: { description: "Cemetery Mark", kind: "image" },
    cemetery_background: { description: "Cemetery Background", kind: "image" },
    qr_code: { description: "Payment QR Code", kind: "image" },

    dept_name: { description: "Main Department Name", kind: "text" },
    cemetery_name: { description: "Cemetery Name", kind: "text" },
    cemetery_address: { description: "Cemetery Physical Address", kind: "text" },
    office_address: {
        description: "Administrative Office Address",
        kind: "text",
    },
    cemetery_google_maps: { description: "Google Maps Embed URL", kind: "text" },
    contact_phone: { description: "Contact Hotline / Phone", kind: "text" },
    contact_email: { description: "Official Email Address", kind: "text" },

    payment_channels_list: { description: "Payment Channels", kind: "list" },
    payment_purposes_list: { description: "Purposes of Payment", kind: "list" },
    barangay_options: { description: "Barangay Dropdowns", kind: "list" },
};

// Fields that must not be empty before the form can be saved
const REQUIRED_TEXT_KEYS = [
    "dept_name",
    "cemetery_name",
    "cemetery_address",
    "cemetery_google_maps",
    "office_address",
    "contact_phone",
    "contact_email",
];

// Required field validation
// How long the "invalid" highlight stays on a field
const INVALID_FLASH_MS = 2500;

// Inject the CSS used to highlight missing required fields
(function injectRequiredFieldCss() {
    if (document.getElementById("requiredFieldStyles")) return;
    const s = document.createElement("style");
    s.id = "requiredFieldStyles";
    s.textContent = `
    @keyframes requiredFieldShake {
      0%, 100% { transform: translateX(0); }
      15%      { transform: translateX(-6px); }
      30%      { transform: translateX(5px); }
      45%      { transform: translateX(-4px); }
      60%      { transform: translateX(3px); }
      75%      { transform: translateX(-2px); }
    }
    .fieldInvalid {
      animation: requiredFieldShake 520ms cubic-bezier(.36,.07,.19,.97);
      border-color: #e11d48 !important;
      box-shadow: 0 0 0 3px rgba(225, 29, 72, 0.18) !important;
      outline: none !important;
      scroll-margin-top: 96px;
      transition: box-shadow 400ms ease, border-color 400ms ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .fieldInvalid { animation: none; }
    }
  `;
    document.head.appendChild(s);
})();

// Stop highlighting an input and cancel its flash timer
function clearInvalidField(el) {
    if (!el) return;
    el.classList.remove("fieldInvalid");
    if (el._invalidTimer) {
        clearTimeout(el._invalidTimer);
        el._invalidTimer = null;
    }
}

// Briefly highlight an input to show it needs attention
// Optionally scrolls the field into view and focuses it
function flashInvalidField(el, { scroll = false } = {}) {
    if (!el) return;

    if (el._invalidTimer) {
        clearTimeout(el._invalidTimer);
        el._invalidTimer = null;
    }

    // Remove and re-add the class so the animation restarts
    el.classList.remove("fieldInvalid");
    void el.offsetWidth;
    el.classList.add("fieldInvalid");

    el._invalidTimer = window.setTimeout(() => {
        el.classList.remove("fieldInvalid");
        el._invalidTimer = null;
    }, INVALID_FLASH_MS);

    if (!scroll) return;

    const reduceMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
    )?.matches;

    el.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
    });

    window.setTimeout(
        () => {
            try {
                el.focus({ preventScroll: true });
            } catch {
                el.focus();
            }
        },
        reduceMotion ? 0 : 350,
    );
}

// Read an input's current value [checkboxes become "1" or "0"]
function readFieldValue(el) {
    if (!el) return "";
    if (el.type === "checkbox") return el.checked ? "1" : "0";
    return String(el.value ?? "");
}

// Collect all required fields that are currently empty
function findMissingRequiredFields() {
    const missing = [];
    for (const key of REQUIRED_TEXT_KEYS) {
        const el = document.getElementById(key);
        if (!el) continue;
        if (!readFieldValue(el).trim()) {
            missing.push({
                key,
                el,
                label: SETTINGS_SPEC[key]?.description || key,
            });
        }
    }
    return missing;
}

// Build the message shown when required fields are empty
function buildMissingMessage(labels) {
    return "Please fill in the required fields";
}

// Validate required fields and show feedback when any are missing
function validateRequiredSettings({ scroll = true, alert = true } = {}) {
    wireRequiredFieldCleanup();

    const missing = findMissingRequiredFields();
    if (missing.length === 0) return true;

    missing.forEach((m, i) =>
        flashInvalidField(m.el, { scroll: scroll && i === 0 }),
    );

    if (alert && typeof showAlertTOP === "function") {
        showAlertTOP(buildMissingMessage(missing.map((m) => m.label)), "error");
    }

    return false;
}

// Attach listeners that clear the invalid state when the user types
function wireRequiredFieldCleanup() {
    for (const key of REQUIRED_TEXT_KEYS) {
        const el = document.getElementById(key);
        if (!el || el.dataset.requiredWired === "1") continue;
        el.dataset.requiredWired = "1";
        const clear = () => clearInvalidField(el);
        el.addEventListener("input", clear);
        el.addEventListener("change", clear);
    }
}

// Helpers
// Read the trimmed values of all list inputs in a container
function collectListValues(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    const out = [];
    container.querySelectorAll(".optionItem input").forEach((inp) => {
        const v = String(inp.value ?? "").trim();
        if (v) out.push(v);
    });
    return out;
}

// Friendly error messages
const GENERIC_ERROR = "Something went wrong. Please try again.";

// Detect messages that look like raw errors and should not be shown as-is
function looksRawMessage(text) {
    if (!text) return true;
    const t = String(text).trim();
    if (!t) return true;
    if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;
    if (/ERR_NGROK_|ngrok/i.test(t)) return true;
    if (/^HTTP\s+\d{3}/i.test(t)) return true;
    if (/^Save failed \(HTTP \d{3}\)$/i.test(t)) return true;
    if (
        /non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(
            t,
        )
    )
        return true;
    if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
    if (
        /^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(t)
    )
        return true;
    if (t.length > 200) return true;
    return false;
}

// Return a user-friendly message, or a fallback when the raw text looks technical
function friendlyMessage(raw, fallback) {
    if (!raw) return fallback || GENERIC_ERROR;
    const s = String(raw).trim();
    if (!s || looksRawMessage(s)) return fallback || GENERIC_ERROR;
    return s;
}

// Save settings
async function saveSiteContent(event) {
    if (event && typeof event.preventDefault === "function") {
        event.preventDefault();
    }

    if (!validateRequiredSettings()) return;

    const settings = [];
    const filesByIndex = {};

    // Walk every setting, collecting its value or attached file
    for (const [key, spec] of Object.entries(SETTINGS_SPEC)) {
        let value = "";

        if (spec.kind === "image") {
            const fileInput = document.getElementById(key);
            const file = fileInput?.files?.[0] ?? null;
            if (file) {
                filesByIndex[settings.length] = file;
                value = "";
            } else {
                value = `${key}.png`;
            }
        } else if (spec.kind === "list") {
            value = JSON.stringify(collectListValues(key));
        } else {
            const el = document.getElementById(key);
            if (!el) continue;
            if (el.type === "checkbox") {
                value = el.checked ? "1" : "0";
            } else {
                value = el.value ?? "";
            }
        }

        settings.push({
            setting_key: key,
            description: spec.description,
            setting_value: value,
        });
    }

    if (settings.length === 0) {
        if (typeof showAlertTOP === "function") {
            showAlertTOP("Nothing to save", "error");
        }
        return;
    }

    // Build a multipart body so images can be uploaded along with the text
    const fd = new FormData();
    settings.forEach((s, i) => {
        fd.append(`bulk_settings[${i}][setting_key]`, s.setting_key);
        fd.append(`bulk_settings[${i}][description]`, s.description);
        fd.append(`bulk_settings[${i}][setting_value]`, s.setting_value);
        if (filesByIndex[i]) {
            fd.append(`bulk_images[${i}]`, filesByIndex[i], `${s.setting_key}.png`);
        }
    });

    const form = document.getElementById("site_content_form");
    const restoreSaving = setSavingState(true, { form });

    try {
        let response;
        try {
            response = await fetch(SAVE_API_URL, {
                method: "POST",
                body: fd,
                credentials: "same-origin",
                cache: "no-store",
            });
        } catch (networkError) {
            console.error("Save settings — network error:", networkError);
            if (typeof showAlertTOP === "function") {
                showAlertTOP("Network error — could not reach server", "error");
            }
            return;
        }

        const data = await response.json().catch(() => null);

        if (!response.ok) {
            const message =
                data?.message || data?.error || `Save failed (HTTP ${response.status})`;
            console.error("Save settings — server error:", message, data);
            if (typeof showAlertTOP === "function") {
                showAlertTOP(friendlyMessage(message), "error");
            }
            return;
        }

        await showSavedSummary(settings);

        if (typeof window.loadSiteContent === "function") {
            window.loadSiteContent();
        }

        // Clear the file inputs so the next save won't resend them
        for (const [key, spec] of Object.entries(SETTINGS_SPEC)) {
            if (spec.kind === "image") {
                const fi = document.getElementById(key);
                if (fi) fi.value = "";
            }
        }
    } finally {
        restoreSaving();

        // Refresh image previews so they reflect the saved files
        try {
            const setPreview = (id, src) => {
                const el = document.getElementById(id);
                if (el) el.src = src;
            };
            setPreview("preview_logo_1", "api/images/logo_1.png");
            setPreview("preview_logo_2", "api/images/logo_2.png");
            setPreview("preview_cemetery_logo", "api/images/cemetery_logo.png");
            setPreview("preview_cemetery_mark", "api/images/cemetery_mark.png");
            setPreview(
                "preview_cemetery_background",
                "api/images/cemetery_background.png",
            );
            setPreview("preview_qr_code", "api/images/qr_code.png");

            if (typeof refreshImages === "function") refreshImages();
        } catch (e) {
            console.warn("Preview reset skipped:", e);
        }
    }
}

// Saved summary dialog
// Inject CSS that hides the cancel button when the modal is used for info only
(function injectInfoDialogCss() {
    if (document.getElementById("confirmModalInfoDialogStyles")) return;
    const s = document.createElement("style");
    s.id = "confirmModalInfoDialogStyles";
    s.textContent = `
    .confirmModalOverlay.primary .confirmModalCancel { display: none !important; }
    .confirmModalOverlay.primary .confirmModalConfirm { flex: 1; }
    .confirmModalOverlay.primary .confirmModalInfo {
      max-height: 45vh;
      overflow-y: auto;
    }
  `;
    document.head.appendChild(s);
})();

// Shorten long values for display in the summary dialog
function prettySettingValue(key, value) {
    const v = String(value ?? "");
    if (key.endsWith("_list") || key === "barangay_options") {
        try {
            const arr = JSON.parse(v);
            if (Array.isArray(arr)) {
                return arr.length ? arr.join(", ") : "(empty)";
            }
        } catch { }
    }
    return v.length > 80 ? v.slice(0, 77) + "…" : v;
}

// Show a summary dialog listing the settings that were saved
function showSavedSummary(settings, opts = {}) {
    if (typeof window.ConfirmModal?.open !== "function") {
        return Promise.resolve(false);
    }

    const rows = (settings || []).map((s) => ({
        label: s.description || s.setting_key,
        value: prettySettingValue(s.setting_key, s.setting_value),
    }));

    return window.ConfirmModal.open({
        variant: "primary",
        title: opts.title || "Settings Saved",
        message:
            opts.message ||
            (rows.length === 1
                ? "1 setting was updated."
                : `${rows.length} settings were updated.`),
        rows,
        confirmText: opts.confirmText || "Done",
    });
}

// UI wiring and init
// Attach click handlers for the add buttons and the save form
function wireSiteContentUI() {
    const addChannel = document.getElementById("add_payment_channel");
    if (addChannel) {
        addChannel.addEventListener("click", () =>
            addOption("payment_channels_list"),
        );
    }

    const addPurpose = document.getElementById("add_payment_purpose");
    if (addPurpose) {
        addPurpose.addEventListener("click", () =>
            addOption("payment_purposes_list"),
        );
    }

    const addBarangay =
        document.getElementById("add_barangay_option") ||
        document.getElementById("add_barangay") ||
        document.getElementById("add_barangay_options");
    if (addBarangay) {
        addBarangay.addEventListener("click", () => addOption("barangay_options"));
    }

    const form = document.getElementById("site_content_form");
    if (form) {
        form.addEventListener("submit", saveSiteContent);
    }

    wireRequiredFieldCleanup();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireSiteContentUI);
} else {
    wireSiteContentUI();
}

// Expose functions used by inline HTML handlers and other scripts
window.addOption = addOption;
window.rebuildDropdownList = rebuildDropdownList;
window.removeOption = removeOption;
window.saveSiteContent = saveSiteContent;
window.showSavedSummary = showSavedSummary;