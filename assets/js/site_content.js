// ================================================================
//  site_content.js
//  Loader-agnostic save pipeline for the site_content settings form.
//  - Reads:  handled by load_site_contents.js (unchanged)
//  - Writes: this file -> POST /api/settings (multipart/form-data)
// ================================================================

// ---------- Image Preview Helpers ----------
function previewImage(input, previewId) {
  if (!input?.files?.length) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = document.getElementById(previewId);
    if (img) img.src = e.target.result;
  };
  reader.readAsDataURL(input.files[0]);
}

// ---------- Core helper: create a single option item ----------
function createOptionItem(containerId, value = "") {
  const isChannel = containerId === "payment_channels_list";
  const inputClass = isChannel ? "channelInput" : "purposeInput";
  const inputName = isChannel ? "payment_channels[]" : "payment_purposes[]";

  // <div class="listItem optionItem">
  const div = document.createElement("div");
  div.className = "listItem optionItem";

  // <input type="text" class="channelInput" name="payment_channels[]" />
  const input = document.createElement("input");
  input.type = "text";
  input.className = inputClass;
  input.name = inputName;
  input.value = value;

  // <button type="button" class="btn iconBtn dangerBtn">
  //   <i class="fas fa-trash-alt"></i>
  // </button>
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn iconBtn dangerBtn";
  // Wire via listener instead of inline onclick so it survives a strict CSP
  btn.addEventListener("click", () => {
    const item = btn.closest(".optionItem");
    if (item) item.remove();
  });
  btn.innerHTML = '<i class="fas fa-trash-alt"></i>';

  div.appendChild(input);
  div.appendChild(btn);
  return div;
}

// ---------- Add a single empty option ----------
function addOption(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const item = createOptionItem(containerId, "");
  container.appendChild(item);
}

// ---------- Rebuild entire list from an array ----------
// Kept the original signature (containerId, itemsArray, inputClass).
// The inputClass parameter is ignored because we derive it from containerId.
function rebuildDropdownList(containerId, itemsArray /*, inputClass */) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = ""; // clear existing

  for (const item of itemsArray) {
    const itemDiv = createOptionItem(containerId, item);
    container.appendChild(itemDiv);
  }
}

// ---------- Global remove function (kept for backward compatibility) ----------
function removeOption(button) {
  const item = button.closest(".optionItem");
  if (item) item.remove();
}

// ---------- Wire up UI (safe when script runs early) ----------
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

  const form = document.getElementById("site_content_form");
  if (form) {
    form.addEventListener("submit", saveSiteContent);
  }

  // Clear the invalid state as soon as the user starts fixing a field
  wireRequiredFieldCleanup();
}

// ================================================================
//  Save / Edit Settings
// ================================================================

const SAVE_API_URL = "api/settings";

/**
 * Declarative spec: setting_key -> { description, kind }
 * kind: "image" | "text" | "list"
 *   - image : reads a <input type="file"> with that id; if no file, keeps "<key>.png"
 *   - text  : reads the element with that id (.value, or .checked for checkboxes)
 *   - list  : reads every .optionItem input inside #<key> and JSON-stringifies it
 */
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
};

// ================================================================
//  Required-field validation
//  - Blocks submit when a required text field is blank
//  - Flags every blank field, scrolls to the first one,
//    plays a shake animation, and fires showAlertTOP
//  - The red/highlight state auto-clears after a few seconds
// ================================================================

/**
 * Keys (from SETTINGS_SPEC) that must not be blank.
 * Fields that aren't present in the DOM are skipped, so this list is
 * safe to keep even if a field only exists on some pages.
 */
const REQUIRED_TEXT_KEYS = [
  "dept_name",
  "cemetery_name",
  "cemetery_address",
  "cemetery_google_maps",
  "office_address",
  "contact_phone",
  "contact_email",
];

/** How long the red / shake highlight stays on screen (ms). */
const INVALID_FLASH_MS = 2500;

// 1. Inject the shake / highlight styling once.
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

/**
 * Remove the invalid state and cancel any pending auto-clear timer.
 * Called by the input/change listeners as soon as the user types.
 */
function clearInvalidField(el) {
  if (!el) return;
  el.classList.remove("fieldInvalid");
  if (el._invalidTimer) {
    clearTimeout(el._invalidTimer);
    el._invalidTimer = null;
  }
}

/**
 * Flag a field as invalid. Pass { scroll: true } for the field we
 * want to bring into view.
 *
 * The `.fieldInvalid` class auto-removes after INVALID_FLASH_MS so
 * the red highlight fades away on its own if the user doesn't act.
 */
function flashInvalidField(el, { scroll = false } = {}) {
  if (!el) return;

  // Cancel any timer from a previous flash on this field
  if (el._invalidTimer) {
    clearTimeout(el._invalidTimer);
    el._invalidTimer = null;
  }

  // Remove → force reflow → re-add so the animation replays on
  // every submit attempt, even if the class is still present.
  el.classList.remove("fieldInvalid");
  void el.offsetWidth; // reflow
  el.classList.add("fieldInvalid");

  // Auto-clear the red highlight after a few seconds
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

  // Focus after the scroll settles; preventScroll stops a second jump.
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

/** Read the current value of a field the same way saveSiteContent does. */
function readFieldValue(el) {
  if (!el) return "";
  if (el.type === "checkbox") return el.checked ? "1" : "0";
  return String(el.value ?? "");
}

/** Every required field that is currently blank (and exists on the page). */
function findMissingRequiredFields() {
  const missing = [];
  for (const key of REQUIRED_TEXT_KEYS) {
    const el = document.getElementById(key);
    if (!el) continue; // not rendered on this page → skip
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

/** Short, readable alert copy. */
function buildMissingMessage(labels) {
  if (labels.length === 1) return `${labels[0]} is required.`;
  if (labels.length <= 3) return `Please fill in: ${labels.join(", ")}.`;
  return `Please fill in ${labels.length} required fields (${labels
    .slice(0, 3)
    .join(", ")}, …).`;
}

/**
 * Returns true when the form is valid.
 * Otherwise: flags + animates every blank field, scrolls to the first,
 * shows showAlertTOP, and returns false.
 */
function validateRequiredSettings({ scroll = true, alert = true } = {}) {
  wireRequiredFieldCleanup(); // safety: fields may have been re-rendered

  const missing = findMissingRequiredFields();
  if (missing.length === 0) return true;

  // Flag all of them (so nothing is silently hidden), scroll the first.
  missing.forEach((m, i) =>
    flashInvalidField(m.el, { scroll: scroll && i === 0 }),
  );

  if (alert && typeof showAlertTOP === "function") {
    showAlertTOP(buildMissingMessage(missing.map((m) => m.label)), "error");
  }

  return false;
}

/** Clear the red/shake state as soon as the user starts fixing a field. */
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

/** Collect all non-empty input values inside a `.list` container. */
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

/**
 * Submit handler: gathers every field, sends as multipart/form-data,
 * shows a summary modal, then a toast after dismissal, then re-syncs.
 *
 * Safe to call directly: saveSiteContent() — event is optional.
 */
async function saveSiteContent(event) {
  if (event && typeof event.preventDefault === "function") {
    event.preventDefault();
  }

  // ---- Block submit until every required text field is filled ----
  if (!validateRequiredSettings()) return;

  // ---- Build the settings array, tracking file index alignment ----
  const settings = [];
  const filesByIndex = {};

  for (const [key, spec] of Object.entries(SETTINGS_SPEC)) {
    let value = "";

    if (spec.kind === "image") {
      const fileInput = document.getElementById(key);
      const file = fileInput?.files?.[0] ?? null;
      if (file) {
        // Index must match the setting entry's position
        filesByIndex[settings.length] = file;
        value = ""; // server replaces with the saved filename
      } else {
        // Preserve existing convention: <img src="api/images/<key>.png">
        value = `${key}.png`;
      }
    } else if (spec.kind === "list") {
      value = JSON.stringify(collectListValues(key));
    } else {
      const el = document.getElementById(key);
      if (!el) continue; // silently skip fields not on this page
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

  // ---- Multipart body ----
  const fd = new FormData();
  settings.forEach((s, i) => {
    fd.append(`bulk_settings[${i}][setting_key]`, s.setting_key);
    fd.append(`bulk_settings[${i}][description]`, s.description);
    fd.append(`bulk_settings[${i}][setting_value]`, s.setting_value);
    if (filesByIndex[i]) {
      fd.append(`bulk_images[${i}]`, filesByIndex[i], `${s.setting_key}.png`);
    }
  });

  // ---- UI: disable the submit button while in flight ----
  const form = document.getElementById("site_content_form");
  const submitBtn = form?.querySelector('button[type="submit"]');
  const originalHTML = submitBtn ? submitBtn.innerHTML : null;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
  }

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
        showAlertTOP(message, "error");
      }
      return;
    }

    // 1. Summary modal — await dismissal
    await showSavedSummary(settings);

    // 2. Re-sync from server now that the modal is gone
    if (typeof window.loadSiteContent === "function") {
      window.loadSiteContent();
    }

    // 3. Reset file inputs so the same file isn't re-uploaded on a 2nd submit
    for (const [key, spec] of Object.entries(SETTINGS_SPEC)) {
      if (spec.kind === "image") {
        const fi = document.getElementById(key);
        if (fi) fi.value = "";
      }
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      if (originalHTML !== null) submitBtn.innerHTML = originalHTML;
    }
  }
}

// ================================================================
//  ConfirmModal reuse — info / summary dialog
//  (No edits to confirm-modal.js; we only add CSS + a helper.)
// ================================================================

// 1. Hide Cancel in "primary" (info) mode, and make the info block scrollable.
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

// 2. Trim long values (URLs, JSON arrays) so rows stay readable.
function prettySettingValue(key, value) {
  const v = String(value ?? "");
  if (key.endsWith("_list")) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) {
        return arr.length ? arr.join(", ") : "(empty)";
      }
    } catch {
      /* fall through */
    }
  }
  return v.length > 80 ? v.slice(0, 77) + "…" : v;
}

// 3. Show the summary. Resolves when the user dismisses it.
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
    // no onConfirm -> Confirm just closes the modal
    // Cancel button is hidden via injected CSS
  });
}

// ================================================================
//  Bootstrap + global exports
// ================================================================

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireSiteContentUI);
} else {
  wireSiteContentUI();
}

window.addOption = addOption;
window.rebuildDropdownList = rebuildDropdownList;
window.removeOption = removeOption;
window.saveSiteContent = saveSiteContent;
window.showSavedSummary = showSavedSummary;
