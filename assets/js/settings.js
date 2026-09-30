/* ================================================================
   settings.js
   ================================================================ */

const EXCEL_API = "/api/csv"; // ← change to your actual endpoint

document.addEventListener("DOMContentLoaded", () => {
  /* ============================================================
     1. INFO POPUPS
     ============================================================ */
  const infoIcons = document.querySelectorAll(".infoIcon");

  function closeAllPopups(except = null) {
    document.querySelectorAll(".infoPopup.show").forEach((popup) => {
      if (popup === except) return;
      popup.classList.remove("show");
      const btn = popup.parentElement?.querySelector(".infoIcon");
      btn?.setAttribute("aria-expanded", "false");
    });
  }

  infoIcons.forEach((icon) => {
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      const popup = icon.parentElement?.querySelector(".infoPopup");
      if (!popup) return;

      const isOpen = popup.classList.contains("show");
      closeAllPopups();
      if (!isOpen) {
        popup.classList.add("show");
        icon.setAttribute("aria-expanded", "true");
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".infoWrap")) closeAllPopups();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllPopups();
  });

  /* ============================================================
     REUSABLE CONFIRM DIALOG
     ------------------------------------------------------------
     Reuses the existing DeleteModal, but re-labels and restyles
     it in the DOM right after opening — no changes to
     delete_modal.js required.

     Usage:
       openConfirmDialog({
         variant: "warning",          // "info" | "warning" | "danger"
         icon: "fa-key",
         title: "Change Password",
         message: "You are about to change your password.",
         note: "You will be logged out.",  // optional
         confirmText: "Change Password",
         confirmIcon: "fa-key",
         loadingText: "Changing…",
         onConfirm: async () => { ... },
       });
     ============================================================ */
  function openConfirmDialog(opts = {}) {
    const {
      variant = "info",
      icon = "fa-question",
      title = "Confirm",
      message = "Are you sure?",
      note = "",
      confirmText = "Confirm",
      confirmIcon = "fa-check",
      loadingText = "Working…",
      onConfirm = null,
    } = opts;

    if (!window.DeleteModal) {
      console.warn("DeleteModal not loaded — cannot open confirm dialog.");
      return;
    }

    // 1. Open the base modal with our async handler
    DeleteModal.open({ onConfirm });

    // 2. Customize the DOM right after it mounts
    const modal = document.getElementById("deleteModalOverlay");
    if (!modal) return;

    // ---- Title ----
    const titleEl = modal.querySelector("#deleteModalTitle");
    if (titleEl) titleEl.textContent = title;

    // ---- Message ----
    const msgEl = modal.querySelector("#deleteModalMessage");
    if (msgEl) msgEl.textContent = message;

    // ---- Info section: hide it, or repurpose it as a warning note ----
    const infoEl = modal.querySelector("#deleteModalInfo");
    if (infoEl) {
      if (note) {
        infoEl.style.cssText = [
          "display:flex",
          "align-items:flex-start",
          "gap:8px",
          "margin:12px 0 0",
          "padding:10px 14px",
          "background-color:#fffbeb",
          "border:1px solid #fde68a",
          "border-radius:6px",
          "font-size:13px",
          "line-height:1.5",
          "color:#92400e",
          "text-align:left",
        ].join(";");
        infoEl.innerHTML =
          `<i class="fas fa-triangle-exclamation" aria-hidden="true" style="margin-top:1px"></i>` +
          `<span>${note}</span>`;
      } else {
        infoEl.style.display = "none";
      }
    }

    // ---- Icon + variant colors ----
    const iconWrap = modal.querySelector(".deleteModalIcon");
    if (iconWrap) {
      const palette = {
        info: { bg: "#dbeafe", fg: "#2563eb" },
        warning: { bg: "#fef3c7", fg: "#d97706" },
        danger: { bg: "#fee2e2", fg: "#dc2626" },
      }[variant];

      if (palette) {
        iconWrap.style.backgroundColor = palette.bg;
        iconWrap.style.color = palette.fg;
      }
      const iconI = iconWrap.querySelector("i");
      if (iconI) iconI.className = `fas ${icon}`;
    }

    // ---- Confirm button text/icon + keep it in sync during loading ----
    const confirmBtn = modal.querySelector('[data-action="confirm"]');
    if (confirmBtn) {
      // Idle state
      confirmBtn.innerHTML =
        `<i class="fas ${confirmIcon}" aria-hidden="true"></i>` +
        `<span>${confirmText}</span>`;

      // The base modal's setLoading() rewrites this button's innerHTML
      // to "Deleting…" / "Delete". Watch it and re-apply our labels.
      const observer = new MutationObserver(() => {
        if (confirmBtn.disabled) {
          if (!confirmBtn.textContent.includes(loadingText)) {
            confirmBtn.innerHTML =
              `<span class="spinner" aria-hidden="true"></span>` +
              `<span>${loadingText}</span>`;
          }
        } else {
          if (!confirmBtn.textContent.includes(confirmText)) {
            confirmBtn.innerHTML =
              `<i class="fas ${confirmIcon}" aria-hidden="true"></i>` +
              `<span>${confirmText}</span>`;
          }
        }
      });
      observer.observe(confirmBtn, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled"],
      });

      // Stop observing once the modal closes, so nothing leaks
      const stopObserver = new MutationObserver(() => {
        if (!modal.classList.contains("visible")) {
          observer.disconnect();
          stopObserver.disconnect();
        }
      });
      stopObserver.observe(modal, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
  }

  /* ============================================================
     2. PROFILE SECTION
     ============================================================ */
  const profileFields = document.querySelectorAll(".profileField");

  const editModeNotice = document.getElementById("editModeNotice");
  const inlinePasswordSection = document.getElementById(
    "inlinePasswordSection",
  );

  const editProfileBtn = document.getElementById("editProfileBtn");
  const changePasswordBtn = document.getElementById("changePasswordBtn");
  const cancelProfileBtn = document.getElementById("cancelProfileBtn");
  const saveChangesBtn = document.getElementById("saveChangesBtn");
  const updatePasswordBtn = document.getElementById("updatePasswordBtn");

  /* -------- HTML field id -> API key --------
     Only needed where they differ. */
  const FIELD_TO_API_KEY = {
    name: "name",
    user_name: "username",
    email: "email",
    phone_number: "phone_number",
  };

  const PROFILE_API = "/api/users/me";
  /* -------- Map an error message to the field it belongs to --------
     Order matters: more specific patterns first. */
  const PROFILE_ERROR_FIELD_MAP = [
    { re: /username/i, field: "user_name" },
    { re: /email/i, field: "email" },
    { re: /phone/i, field: "phone_number" },
    { re: /password/i, field: "new_pass" },
    { re: /full name|name/i, field: "name" },
  ];

  function findProfileErrorField(message) {
    if (!message) return null;
    for (const { re, field } of PROFILE_ERROR_FIELD_MAP) {
      if (re.test(message)) return field;
    }
    return null;
  }

  /* -------- Snapshot of the current input values -------- */
  const originalProfile = {};

  function snapshotProfile() {
    profileFields.forEach((field) => {
      originalProfile[field.id] = field.value;
    });
  }

  /* -------- Build a payload from the current field values -------- */
  function buildProfilePayload(extra = {}) {
    const payload = {};
    profileFields.forEach((field) => {
      const apiKey = FIELD_TO_API_KEY[field.id] || field.id;
      payload[apiKey] = field.value;
    });
    return { ...payload, ...extra };
  }

  /* -------- PUT /api/users/me -------- */
  async function saveProfileToServer(payload) {
    const response = await fetch(PROFILE_API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });

    // Some endpoints return JSON even on errors; be defensive.
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result?.message || `HTTP ${response.status}`);
    }
    return result;
  }

  /**
   * Modes:
   *  - "view"     : fields readonly, no password, [Edit] [Change Password]
   *  - "edit"     : fields editable, notice, no password, [Cancel] [Save Changes]
   *  - "password" : fields editable, notice, password visible, [Cancel] [Update Password]
   */
  function setProfileMode(mode) {
    const isView = mode === "view";
    const isEdit = mode === "edit";
    const isPassword = mode === "password";
    const isEditable = isEdit || isPassword;

    profileFields.forEach((field) => {
      if (isEditable) field.removeAttribute("readonly");
      else field.setAttribute("readonly", true);
    });

    editModeNotice.hidden = !isEditable;
    inlinePasswordSection.hidden = !isPassword;

    editProfileBtn.hidden = !isView;
    changePasswordBtn.hidden = !isView;
    cancelProfileBtn.hidden = isView;
    saveChangesBtn.hidden = !isEdit;
    updatePasswordBtn.hidden = !isPassword;
  }

  setProfileMode("view");

  /* -------- Enter edit mode -------- */
  editProfileBtn?.addEventListener("click", () => {
    snapshotProfile();
    setProfileMode("edit");
  });

  /* -------- Enter password mode -------- */
  changePasswordBtn?.addEventListener("click", () => {
    snapshotProfile();
    setProfileMode("password");
  });

  /* -------- Cancel -------- */
  cancelProfileBtn?.addEventListener("click", () => {
    profileFields.forEach((field) => {
      field.value = originalProfile[field.id] ?? "";
    });

    const np = document.getElementById("new_pass");
    const cp = document.getElementById("confirm_pass");
    if (np) np.value = "";
    if (cp) cp.value = "";

    setProfileMode("view");
  });

  /* -------- Save Changes (profile only) -------- */
  saveChangesBtn?.addEventListener("click", async () => {
    const payload = buildProfilePayload();

    saveChangesBtn.disabled = true;
    const originalHTML = saveChangesBtn.innerHTML;
    saveChangesBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';

    try {
      const result = await saveProfileToServer(payload);
      showAlertTOP(
        result?.message || "Profile updated successfully",
        "success",
      );

      snapshotProfile();
      setProfileMode("view");
    } catch (err) {
      console.error("Save Changes failed:", err);
      showAlertTOP(err.message || "Failed to update profile", "error");

      const field = findProfileErrorField(err.message);
      if (field) animateInputError(field);
    } finally {
      saveChangesBtn.disabled = false;
      saveChangesBtn.innerHTML = originalHTML;
    }
  });

  const LOGOUT_API = "/api/auth"; // adjust to your actual logout endpoint
  const LOGIN_URL = "login.html";

  updatePasswordBtn?.addEventListener("click", () => {
    const newPass = document.getElementById("new_pass")?.value ?? "";
    const confirmPass = document.getElementById("confirm_pass")?.value ?? "";

    if (!newPass || !confirmPass) {
      showAlertTOP("Please fill in both password fields.", "warning");
      animateInputError("new_pass");
      return;
    }
    if (newPass !== confirmPass) {
      showAlertTOP("Passwords do not match.", "error");
      animateInputError("confirm_pass");
      return;
    }

    openConfirmDialog({
      variant: "warning",
      icon: "fa-key",
      title: "Change Password",
      message: "You are about to change your password.",
      note: "For your security, you will be logged out and need to sign in again with your new password.",
      confirmText: "Change Password",
      confirmIcon: "fa-key",
      loadingText: "Changing…",
      onConfirm: async () => {
        // 1. Send the update
        const payload = buildProfilePayload({ password: newPass });
        await saveProfileToServer(payload);

        // 2. Best-effort logout
        try {
          await fetch(LOGOUT_API, {
            method: "DELETE",
            credentials: "same-origin",
          });
        } catch (e) {
          console.warn("Logout failed — redirecting anyway.", e);
        }

        // 3. Redirect
        window.location.href = LOGIN_URL;

        // Never resolve — keeps the modal in its "Changing…" state
        // while the browser navigates away.
        return new Promise(() => {});
      },
    });
  });

  /* ============================================================
     3. SYSTEM CONFIGURATION
     ============================================================ */
  const systemConfigForm = document.getElementById("system_config_form");
  const SYSTEM_API = "/api/settings";

  // Simple single-input settings
  const SYSTEM_SETTINGS = [
    { key: "main_color", desc: "UI Primary Color", inputId: "main_color" },
    {
      key: "textbee_api_key",
      desc: "Textbee API Key (sensitive)",
      inputId: "textbee_api_key",
    },
    {
      key: "textbee_device_id",
      desc: "Textbee Device ID (sensitive)",
      inputId: "textbee_device_id",
    },
  ];

  // Signatory pairs — name + title must both be filled, or both empty
  const SIGNATORY_INDEXES = [1, 2, 3, 4];

  // Image settings — only included when a new file was picked
  const IMAGE_SETTINGS = [
    { key: "header", desc: "Report Header Image", inputId: "header" },
    { key: "footer", desc: "Report Footer Image", inputId: "footer" },
  ];

  systemConfigForm?.addEventListener("submit", async (e) => {
    e.preventDefault();

    /* -------- 1. Validate signatory pairs --------
       Rules per pair:
         - both filled  → OK
         - both empty   → OK (pair is skipped)
         - only one     → ERROR, highlight the missing one */
    for (const i of SIGNATORY_INDEXES) {
      const nameEl = document.getElementById(`people_name_${i}`);
      const titleEl = document.getElementById(`people_title_${i}`);

      const nameVal = (nameEl?.value ?? "").trim();
      const titleVal = (titleEl?.value ?? "").trim();

      const nameEmpty = nameVal === "";
      const titleEmpty = titleVal === "";

      // Both filled, or both empty → fine
      if (nameEmpty === titleEmpty) continue;

      // Exactly one filled → error
      const missingEl = nameEmpty ? nameEl : titleEl;
      const missingLabel = nameEmpty ? "name" : "title";
      const filledLabel = nameEmpty ? "title" : "name";

      showAlertTOP(
        `Signatory ${i}: ${filledLabel} is filled in but ${missingLabel} is empty. ` +
          `Fill in both, or clear both.`,
        "warning",
      );
      animateInputError(missingEl);
      return;
    }

    /* -------- 2. Build the entries list -------- */
    const entries = [];

    // Simple inputs
    for (const def of SYSTEM_SETTINGS) {
      const el = document.getElementById(def.inputId);
      if (!el) continue;
      const val = (el.value ?? "").trim();
      if (!val) continue;
      entries.push({ key: def.key, desc: def.desc, value: val, file: null });
    }

    // Signatory pairs — always sent so that clearing a pair wipes the DB value.
    // Empty strings pass through as-is (PHP now accepts empty for these keys).
    for (const i of SIGNATORY_INDEXES) {
      const nameEl = document.getElementById(`people_name_${i}`);
      const titleEl = document.getElementById(`people_title_${i}`);
      if (!nameEl && !titleEl) continue;

      const nameVal = (nameEl?.value ?? "").trim();
      const titleVal = (titleEl?.value ?? "").trim();

      entries.push({
        key: `people_name_${i}`,
        desc: `Report Signatory ${i} Name`,
        value: nameVal, // "" when empty — that's correct
        file: null,
      });
      entries.push({
        key: `people_title_${i}`,
        desc: `Report Signatory ${i} Title`,
        value: titleVal,
        file: null,
      });
    }

    // Image settings — only if a new file was picked
    for (const def of IMAGE_SETTINGS) {
      const input = document.getElementById(def.inputId);
      const file = input?.files?.[0];
      if (!file) continue;
      entries.push({ key: def.key, desc: def.desc, value: "", file });
    }

    if (entries.length === 0) {
      showAlertTOP("Nothing to save.", "info");
      return;
    }

    /* -------- 3. Build FormData with indexed keys --------
       PHP expects $_POST['bulk_settings'][i][...]
       and          $_FILES['bulk_images']['name'][i]
       at the SAME index. */
    const fd = new FormData();
    entries.forEach((entry, idx) => {
      fd.append(`bulk_settings[${idx}][setting_key]`, entry.key);
      fd.append(`bulk_settings[${idx}][description]`, entry.desc);
      fd.append(`bulk_settings[${idx}][setting_value]`, entry.value);
      if (entry.file) {
        fd.append(`bulk_images[${idx}]`, entry.file, entry.file.name);
      }
    });

    /* -------- 4. Submit -------- */
    const submitBtn = systemConfigForm.querySelector('button[type="submit"]');
    const originalHTML = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';

    try {
      const response = await fetch(SYSTEM_API, {
        method: "POST",
        credentials: "same-origin",
        body: fd, // no Content-Type header — the browser sets the boundary
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result?.message || `HTTP ${response.status}`);
      }

      showAlertTOP("Settings saved successfully.", "success");
    } catch (err) {
      console.error("Save Configuration failed:", err);
      showAlertTOP(err.message || "Failed to save settings.", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalHTML;
    }
  });

  /* ============================================================
     3. EXCEL IMPORT PREVIEW
     ============================================================ */
  const csvImport = document.getElementById("csvImport");
  const importPreview = document.getElementById("importPreview");
  const importFileName = document.getElementById("importFileName");
  const importNowBtn = document.getElementById("importNowBtn");
  const importCancelBtn = document.getElementById("importCancelBtn");

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  csvImport?.addEventListener("change", () => {
    const file = csvImport.files?.[0];
    if (!file) {
      importPreview.hidden = true;
      return;
    }
    importFileName.textContent = `${file.name} · ${formatFileSize(file.size)}`;
    importPreview.hidden = false;
  });

  importCancelBtn?.addEventListener("click", () => {
    csvImport.value = "";
    importPreview.hidden = true;
  });

  importNowBtn?.addEventListener("click", async () => {
    const file = csvImport.files?.[0];
    if (!file) return;

    /* -------- client-side guards (mirror the server) -------- */
    if (!file.name.toLowerCase().endsWith(".csv")) {
      showAlertTOP("Only .csv files are allowed.", "error");
      return;
    }
    const MAX_SIZE = 100 * 1024 * 1024; // 100 MB
    if (file.size === 0 || file.size > MAX_SIZE) {
      showAlertTOP("Invalid file size (must be > 0 and ≤ 100 MB).", "error");
      return;
    }

    /* -------- build payload -------- */
    const fd = new FormData();
    fd.append("csv_file", file, file.name); // key MUST be "csv_file" (matches $_FILES in PHP)

    /* -------- loading state -------- */
    const originalHTML = importNowBtn.innerHTML;
    importNowBtn.disabled = true;
    importNowBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Importing…';

    try {
      const response = await fetch(EXCEL_API, {
        method: "POST",
        credentials: "same-origin", // sends the session cookie for checkuser()
        body: fd, // no Content-Type header — browser sets boundary
      });

      // Be defensive: response may be JSON even on error.
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result?.message || `HTTP ${response.status}`);
      }

      /* -------- success --------
         Shape (per your PHP): { success, message, data: {...} } */
      const data = result?.data ?? {};
      const message = result?.message || "Import finished.";

      // If anything was reported, show the report modal — NO toast.
      if (data.has_errors || data.has_warnings) {
        showImportReportModal(data);
      } else {
        // Clean import → plain toast
        showAlertTOP(message, "success");
      }

      // Still log everything for debugging
      if (data.errors?.length || data.warnings?.length) {
        console.groupCollapsed("📋 Import details");
        if (data.errors?.length) console.error("Errors:", data.errors);
        if (data.warnings?.length) console.warn("Warnings:", data.warnings);
        console.groupEnd();
      }

      /* -------- reset UI -------- */
      csvImport.value = "";
      importPreview.hidden = true;
    } catch (err) {
      console.error("Import failed:", err);
      showAlertTOP(
        "Import failed. Please read the CSV instrutor first! Make sure the exact headers are present!",
        "error",
      );
    } finally {
      importNowBtn.disabled = false;
      importNowBtn.innerHTML = originalHTML;
    }
  });

  const excelExportBtn = document.getElementById("excelExportBtn");

  excelExportBtn?.addEventListener("click", async () => {
    const originalHTML = excelExportBtn.innerHTML;
    excelExportBtn.disabled = true;
    excelExportBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Exporting…';

    try {
      const response = await fetch(EXCEL_API, {
        method: "GET",
        credentials: "same-origin",
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.message || `HTTP ${response.status}`);
      }

      // Your PHP can return JSON when the DB is empty ("Looks like the database is empty.")
      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("application/json")) {
        const parsed = await response.json();
        showAlertTOP(parsed?.message || "Nothing to export.", "info");
        return;
      }

      /* -------- grab the filename from Content-Disposition -------- */
      const cd = response.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      const filename =
        match?.[1] ||
        `interments_export_${new Date().toISOString().slice(0, 10)}.csv`;

      /* -------- trigger the download -------- */
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = decodeURIComponent(filename);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      showAlertTOP("Export downloaded.", "success");
    } catch (err) {
      console.error("Export failed:", err);
      showAlertTOP(err.message || "Export failed.", "error");
    } finally {
      excelExportBtn.disabled = false;
      excelExportBtn.innerHTML = originalHTML;
    }
  });

  /* ============================================================
     GLOBAL HELPERS (used by inline onclick in HTML)
     ============================================================ */
  window.togglePass = function (inputId, btnEl) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    const icon = btnEl.querySelector("i");
    if (icon) {
      icon.classList.toggle("fa-eye", showing);
      icon.classList.toggle("fa-eye-slash", !showing);
    }
  };

  window.updateColorHex = function (colorInput) {
    const hex = colorInput.value;
    const label = colorInput.closest(".colorRow")?.querySelector(".colorHex");
    if (label) label.textContent = hex;
  };

  /* ============================================================
     DATABASE BACKUP & RESTORE
     ------------------------------------------------------------
     GET    /api/backup            → list
     GET    /api/backup/{file}     → download
     POST   /api/backup            → create (5-file retention)
     PUT    /api/backup/{file}     → restore
     ============================================================ */
  const BACKUP_API = "/api/backup";
  const BACKUP_LIMIT = 5; // must mirror BACKUP_LIMIT in PHP

  const backupNowBtn = document.getElementById("backupNowBtn");
  const backupVersionSel = document.getElementById("backupVersion");
  const restoreBtn = document.getElementById("restoreBtn");
  const downloadBtn = document.getElementById("downloadBtn");

  // The last list returned by GET /api/backup — kept so Download/Restore
  // can look up the authoritative `download` URL the server handed us.
  let backupList = [];

  /* ---------- formatting helpers ---------- */

  function formatBackupSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  // "2026-09-30 14:14:00"  →  "Sep 30, 2026 · 2:14 PM"
  // Parsed by hand so the DB wall-clock string isn't shoved through
  // Date()'s ISO parsing (which would re-interpret it in UTC).
  function formatBackupDate(raw) {
    const m = String(raw || "").match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
    );
    if (!m) return raw || "Unknown date";

    const [, y, mo, d, h, mi] = m;
    const dt = new Date(+y, +mo - 1, +d, +h, +mi);

    const datePart = dt.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const timePart = dt.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${datePart} · ${timePart}`;
  }

  /* ---------- render the <select> ---------- */

  function renderBackupOptions(backups) {
    backupList = Array.isArray(backups) ? backups : [];

    backupVersionSel.innerHTML = "";

    // No backups on the server — show a clear, disabled placeholder.
    if (backupList.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = "No backups yet — click “Back Up Now”";
      backupVersionSel.appendChild(opt);

      restoreBtn.disabled = true;
      downloadBtn.disabled = true;
      return;
    }

    // Real entries — server already returns newest first.
    backupList.forEach((b, i) => {
      const opt = document.createElement("option");
      opt.value = b.filename;
      const base = `Version ${i + 1} — ${formatBackupDate(b.date)} · ${formatBackupSize(b.size_in_bytes)}`;
      opt.textContent = i === 0 ? `${base} (Latest)` : base;
      backupVersionSel.appendChild(opt);
    });

    // Pad the remaining slots so the retention policy is visually obvious.
    for (let i = backupList.length; i < BACKUP_LIMIT; i++) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.disabled = true;
      opt.textContent = `Version ${i + 1} — Empty slot`;
      backupVersionSel.appendChild(opt);
    }

    backupVersionSel.selectedIndex = 0;
    restoreBtn.disabled = false;
    downloadBtn.disabled = false;
  }

  /* ---------- GET /api/backup ---------- */

  async function loadBackups({ silent = false } = {}) {
    // Optimistic busy state — only on first load (buttons not yet wired).
    const hadList = backupList.length > 0;

    try {
      const res = await fetch(BACKUP_API, {
        method: "GET",
        credentials: "same-origin",
      });

      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(result?.message || `HTTP ${res.status}`);
      }

      // PHP shape: { success, message, data: [ {filename, size_in_bytes, date, download}, ... ] }
      const data = Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result)
          ? result
          : [];

      renderBackupOptions(data);
      return data;
    } catch (err) {
      console.error("Failed to load backups:", err);
      if (!silent && !hadList) {
        showAlertTOP(err.message || "Failed to load backups.", "error");
      }
      renderBackupOptions([]);
      return [];
    }
  }

  /* ---------- POST /api/backup ---------- */

  backupNowBtn?.addEventListener("click", async () => {
    const originalHTML = backupNowBtn.innerHTML;
    backupNowBtn.disabled = true;
    backupNowBtn.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Backing up…';

    try {
      const res = await fetch(BACKUP_API, {
        method: "POST",
        credentials: "same-origin",
      });

      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(result?.message || `HTTP ${res.status}`);
      }

      // Message already includes the filename in PHP.
      showAlertTOP(result?.message || "Backup created.", "success");

      // Reload so pruning (retention) is reflected immediately.
      await loadBackups({ silent: true });
    } catch (err) {
      console.error("Backup failed:", err);
      showAlertTOP(err.message || "Backup failed.", "error");
    } finally {
      backupNowBtn.disabled = false;
      backupNowBtn.innerHTML = originalHTML;
    }
  });

  /* ---------- GET /api/backup/{file}  (download) ---------- */

  downloadBtn?.addEventListener("click", () => {
    const filename = backupVersionSel.value;
    if (!filename) return;

    const item = backupList.find((b) => b.filename === filename);

    // Prefer the URL the server handed us; fall back to constructing one.
    const url =
      item?.download || `${BACKUP_API}/${encodeURIComponent(filename)}`;

    // Navigate via a hidden anchor so the browser handles the
    // Content-Disposition: attachment response natively (and keeps cookies).
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  /* ---------- PUT /api/backup/{file}  (restore) ---------- */

  restoreBtn?.addEventListener("click", () => {
    const filename = backupVersionSel.value;
    if (!filename) return;

    const item = backupList.find((b) => b.filename === filename);
    const when = item ? formatBackupDate(item.date) : filename;

    openConfirmDialog({
      variant: "danger",
      icon: "fa-clock-rotate-left",
      title: "Restore Database",
      message: `You are about to restore the backup from ${when}.`,
      note: "This will replace ALL current data. Make sure nobody else is using the system. This action cannot be undone.",
      confirmText: "Restore",
      confirmIcon: "fa-clock-rotate-left",
      loadingText: "Restoring…",
      onConfirm: async () => {
        const res = await fetch(
          `${BACKUP_API}/${encodeURIComponent(filename)}`,
          { method: "PUT", credentials: "same-origin" },
        );

        const result = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(result?.message || `HTTP ${res.status}`);
        }

        showAlertTOP(result?.message || "Database restored.", "success");

        // Backup files themselves didn't change, but re-sync anyway in
        // case another tab created or pruned one in the meantime.
        await loadBackups({ silent: true });
      },
    });
  });

  /* ---------- Initial load ---------- */

  restoreBtn.disabled = true;
  downloadBtn.disabled = true;

  loadBackups({ silent: true });
});

function updateColorHex(input) {
  if (!input) return;
  const hexLabel = document.getElementById("main_color_1");
  if (hexLabel) hexLabel.textContent = input.value;
}

function applyUIColor(input) {
  if (!input) return;

  const color = input.value;

  // Update BOTH the iframe and the parent
  [document, window.parent.document].forEach((doc) => {
    const root = doc.documentElement;
    root.style.setProperty("--mainColor", color);

    const rgb = color.match(/\w\w/g)?.map((x) => parseInt(x, 16));
    if (!rgb) return;
    const brightness = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
    const textColor = brightness > 128 ? "#0f172a" : "#ffffff";

    root.style.setProperty("--sidebarText", textColor);
    root.style.setProperty(
      "--sidebar-hover",
      `color-mix(in srgb, ${color}, white 12%)`,
    );
    root.style.setProperty(
      "--sidebar-border",
      `color-mix(in srgb, ${color}, white 18%)`,
    );
    root.style.setProperty(
      "--sidebar-accent",
      `color-mix(in srgb, ${color}, white 40%)`,
    );
    root.style.setProperty(
      "--sidebarText-muted",
      `color-mix(in srgb, ${textColor}, transparent 30%)`,
    );
  });
}

/* ================================================================
   REUSABLE INPUT ERROR ANIMATION
   ----------------------------------------------------------------
   Shakes an input, flashes its border red, and cleans up after
   `duration` ms. Smoothly scrolls the field into view first.
   ================================================================ */
function animateInputError(target, opts = {}) {
  const {
    duration = 2500,
    focus = true,
    scroll = true,
    scrollBlock = "center",
  } = opts;

  const el =
    typeof target === "string" ? document.getElementById(target) : target;
  if (!el) return;

  // 1. Smoothly scroll the field into view first
  if (scroll) {
    el.scrollIntoView({
      behavior: "smooth",
      block: scrollBlock, // "center" | "start" | "nearest" | "end"
      inline: "nearest",
    });
  }

  // 2. Restart the shake cleanly if it's already animating
  el.classList.remove("inputError");
  void el.offsetWidth; // force reflow so the animation replays
  el.classList.add("inputError");

  // 3. Cancel any pending cleanup for this element
  if (el._inputErrorTimeout) clearTimeout(el._inputErrorTimeout);
  el._inputErrorTimeout = setTimeout(() => {
    el.classList.remove("inputError");
    el._inputErrorTimeout = null;
  }, duration);

  // 4. Focus WITHOUT letting the browser auto-scroll (we already did)
  if (focus) {
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }
}

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

/* ================================================================
   IMPORT REPORT MODAL
   ----------------------------------------------------------------
   Reuses DeleteModal as a scrollable report dialog.
   Called from the CSV import handler when the server reports
   row-level errors or warnings.
   ================================================================ */

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function buildIssueListHTML(errors, warnings) {
  const block = (title, icon, color, items) => `
    <div style="margin-bottom:12px">
      <div style="
        display:flex;align-items:center;gap:8px;
        font-weight:600;font-size:13px;color:${color};margin-bottom:6px">
        <i class="fas ${icon}" aria-hidden="true"></i>
        ${title} (${items.length})
      </div>
      <ul style="
        margin:0;padding-left:22px;
        font-size:13px;line-height:1.55;color:#334155">
        ${items
          .map((it) => `<li style="margin-bottom:4px">${escapeHtml(it)}</li>`)
          .join("")}
      </ul>
    </div>`;

  const parts = [];
  if (errors.length)
    parts.push(block("Errors", "fa-circle-xmark", "#dc2626", errors));
  if (warnings.length)
    parts.push(
      block("Warnings", "fa-triangle-exclamation", "#d97706", warnings),
    );
  return parts.join("");
}

function showImportReportModal(data = {}) {
  const {
    total_rows = 0,
    inserted = 0,
    updated = 0,
    skipped = 0,
    errors = [],
    warnings = [],
  } = data;

  if (!window.DeleteModal) {
    console.warn("DeleteModal not loaded — falling back to console.");
    console.log("Import report:", data);
    return;
  }

  const hasErrors = errors.length > 0;

  // 1. Open base modal with a no-op confirm (button just closes it)
  DeleteModal.open({ onConfirm: async () => {} });

  const modal = document.getElementById("deleteModalOverlay");
  if (!modal) return;

  // 2. Title
  const titleEl = modal.querySelector("#deleteModalTitle");
  if (titleEl) {
    titleEl.textContent = hasErrors
      ? "Import Finished with Errors"
      : "Import Finished";
  }

  // 3. Message — one-line summary
  const msgEl = modal.querySelector("#deleteModalMessage");
  if (msgEl) {
    msgEl.textContent =
      `Inserted: ${inserted}, Updated: ${updated}, ` +
      `Skipped: ${skipped} of ${total_rows} row(s).`;
  }

  // 4. Info section — becomes a scrollable issue list
  const infoEl = modal.querySelector("#deleteModalInfo");
  if (infoEl) {
    infoEl.style.cssText = [
      "display:block",
      "max-height:320px",
      "overflow-y:auto",
      "margin:14px 0 0",
      "padding:14px 16px",
      "background:#f8fafc",
      "border:1px solid #e2e8f0",
      "border-radius:8px",
      "text-align:left",
    ].join(";");
    infoEl.innerHTML = buildIssueListHTML(errors, warnings);
  }

  // 5. Icon + colors
  const iconWrap = modal.querySelector(".deleteModalIcon");
  if (iconWrap) {
    const palette = hasErrors
      ? { bg: "#fee2e2", fg: "#dc2626" }
      : { bg: "#fef3c7", fg: "#d97706" };
    iconWrap.style.backgroundColor = palette.bg;
    iconWrap.style.color = palette.fg;
    const iconI = iconWrap.querySelector("i");
    if (iconI) {
      iconI.className = hasErrors
        ? "fas fa-circle-exclamation"
        : "fas fa-triangle-exclamation";
    }
  }

  // 6. Confirm → "Close"
  const confirmBtn = modal.querySelector('[data-action="confirm"]');
  if (confirmBtn) {
    confirmBtn.innerHTML = `<i class="fas fa-check" aria-hidden="true"></i><span>Close</span>`;
  }

  // 7. Hide the Cancel button (only one action here)
  const cancelBtn = modal.querySelector('[data-action="cancel"]');
  if (cancelBtn) cancelBtn.style.display = "none";
}
