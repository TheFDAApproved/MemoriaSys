const EXCEL_API = "api/csv";

function updateColorHex(input) {
    if (!input) return;
    const hexLabel = document.getElementById("main_color_1");
    if (hexLabel) hexLabel.textContent = input.value;
}

function applyUIColor(input) {
    if (!input) return;
    const color = input.value;

    [document, window.parent.document].forEach((doc) => {
        const root = doc.documentElement;
        root.style.setProperty("--mainColor", color);

        // Convert hex to RGB to decide between light and dark text
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

// Input error animation
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

    if (scroll) {
        el.scrollIntoView({
            behavior: "smooth",
            block: scrollBlock,
            inline: "nearest",
        });
    }

    el.classList.remove("inputError");
    void el.offsetWidth;
    el.classList.add("inputError");

    if (el._inputErrorTimeout) clearTimeout(el._inputErrorTimeout);
    el._inputErrorTimeout = setTimeout(() => {
        el.classList.remove("inputError");
        el._inputErrorTimeout = null;
    }, duration);

    if (focus) {
        try {
            el.focus({ preventScroll: true });
        } catch {
            el.focus();
        }
    }
}

// Image preview helper
function previewImage(input, previewId) {
    if (!input?.files?.length) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = document.getElementById(previewId);
        if (img) img.src = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
}

// HTML escaping helper
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

// Import report modal
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

    DeleteModal.open({ onConfirm: async () => { } });

    const modal = document.getElementById("deleteModalOverlay");
    if (!modal) return;

    const titleEl = modal.querySelector("#deleteModalTitle");
    if (titleEl) {
        titleEl.textContent = hasErrors
            ? "Import Finished with Errors"
            : "Import Finished";
    }

    const msgEl = modal.querySelector("#deleteModalMessage");
    if (msgEl) {
        msgEl.textContent =
            `Inserted: ${inserted}, Updated: ${updated}, ` +
            `Skipped: ${skipped} of ${total_rows} row(s).`;
    }

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

    const confirmBtn = modal.querySelector('[data-action="confirm"]');
    if (confirmBtn) {
        confirmBtn.innerHTML = `<i class="fas fa-check" aria-hidden="true"></i><span>Close</span>`;
    }

    const cancelBtn = modal.querySelector('[data-action="cancel"]');
    if (cancelBtn) cancelBtn.style.display = "none";
}

// Page initialization
document.addEventListener("DOMContentLoaded", () => {

    const GENERIC_ERROR = "Something went wrong. Please try again.";

    function looksRawMessage(text) {
        if (!text) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;
        if (/ERR_NGROK_|ngrok/i.test(t)) return true;
        if (/^HTTP\s+\d{3}/i.test(t)) return true;
        if (
            /non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(
                t,
            )
        )
            return true;
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
        if (
            /^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(
                t,
            )
        )
            return true;
        if (t.length > 200) return true;
        return false;
    }

    function friendlyMessage(raw, fallback) {
        if (!raw) return fallback || GENERIC_ERROR;
        const s = String(raw).trim();
        if (!s || looksRawMessage(s)) return fallback || GENERIC_ERROR;
        return s;
    }

    // Generic confirm dialog [reuses DeleteModal markup]
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

        DeleteModal.open({ onConfirm });

        const modal = document.getElementById("deleteModalOverlay");
        if (!modal) return;

        const titleEl = modal.querySelector("#deleteModalTitle");
        if (titleEl) titleEl.textContent = title;

        const msgEl = modal.querySelector("#deleteModalMessage");
        if (msgEl) msgEl.textContent = message;

        // Optional warning note
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

        // Icon palette per variant
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

        // Confirm button label + loading state
        const confirmBtn = modal.querySelector('[data-action="confirm"]');
        if (confirmBtn) {
            confirmBtn.innerHTML =
                `<i class="fas ${confirmIcon}" aria-hidden="true"></i>` +
                `<span>${confirmText}</span>`;

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

            // Stop observing once the modal closes
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

    // Profile section
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

    // Maps input IDs to the keys expected by the profile API
    const FIELD_TO_API_KEY = {
        name: "name",
        user_name: "username",
        email: "email",
        phone_number: "phone_number",
    };

    const PROFILE_API = "api/users/me";

    const PROFILE_ERROR_FIELD_MAP = [
        { re: /user[\s_-]*name/i, field: "user_name" },
        { re: /e-?mail/i, field: "email" },
        { re: /\bphone(?:\s*number)?\b/i, field: "phone_number" },
        { re: /password/i, field: "new_pass" },
        { re: /(?<!user[\s_-]*)\b(?:full\s+)?name\b/i, field: "name" },
    ];

    function findProfileErrorFields(message) {
        if (!message) return [];

        const fields = [];
        for (const { re, field } of PROFILE_ERROR_FIELD_MAP) {
            if (re.test(message) && !fields.includes(field)) {
                fields.push(field);
            }
        }
        return fields;
    }

    const REQUIRED_PROFILE_FIELDS = {
        name: "Full Name",
        user_name: "Username",
        email: "Email",
        phone_number: "Phone Number",
        address: "Address",
    };

    function getMissingProfileFields() {
        const missing = [];
        for (const [id, label] of Object.entries(REQUIRED_PROFILE_FIELDS)) {
            const el = document.getElementById(id);
            if (!el || el.disabled) continue;
            if (el.value.trim() === "") missing.push({ el, label });
        }
        return missing;
    }

    function validateProfileFields() {
        const missing = getMissingProfileFields();
        if (missing.length === 0) return true;

        const labels = missing.map((m) => m.label);
        showAlertTOP(
            labels.length === 1
                ? `Please fill in the required field: ${labels[0]}.`
                : `Please fill in the required fields: ${labels.join(", ")}.`,
            "warning",
        );
        animateInputError(missing[0].el);
        return false;
    }

    // Philippine phone number patterns
    const PH_MOBILE_RE = /^(?:\+?63|0)?9\d{9}$/;
    const PH_MANILA_RE = /^(?:\+?63|0)2\d{8}$/;
    const PH_PROVINCE_RE = /^(?:\+?63|0)[3-8]\d{8,9}$/;

    function isValidPHPhoneNumber(raw) {
        const s = String(raw ?? "").replace(/[\s\-.()]/g, "");
        if (!s || !/^\+?\d+$/.test(s)) return false;
        return (
            PH_MOBILE_RE.test(s) || PH_MANILA_RE.test(s) || PH_PROVINCE_RE.test(s)
        );
    }

    function validatePhoneNumber() {
        const el = document.getElementById("phone_number");
        if (!el || el.disabled) return true;

        const raw = (el.value ?? "").trim();
        if (raw === "") return true;

        if (isValidPHPhoneNumber(raw)) return true;

        showAlertTOP(
            "Please enter a valid Philippine phone number (e.g. 09171234567 or +639171234567).",
            "warning",
        );
        animateInputError(el);
        return false;
    }

    // Holds the last saved values so Cancel can restore them
    const originalProfile = {};

    function snapshotProfile() {
        profileFields.forEach((field) => {
            originalProfile[field.id] = field.value;
        });
    }

    function buildProfilePayload(extra = {}) {
        const payload = {};
        profileFields.forEach((field) => {
            const apiKey = FIELD_TO_API_KEY[field.id] || field.id;
            payload[apiKey] = field.value;
        });
        return { ...payload, ...extra };
    }

    async function saveProfileToServer(payload) {
        const response = await fetch(PROFILE_API, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(payload),
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(
                friendlyMessage(result?.message, "Failed to update profile"),
            );
        }
        return result;
    }

    // Switches the profile form between view, edit and password modes
    function setProfileMode(mode) {
        const isView = mode === "view";
        const isEdit = mode === "edit";
        const isPassword = mode === "password";

        profileFields.forEach((field) => {
            if (isEdit) field.removeAttribute("readonly");
            else field.setAttribute("readonly", true);
        });

        editModeNotice.hidden = !isEdit;
        inlinePasswordSection.hidden = !isPassword;

        editProfileBtn.hidden = !isView;
        changePasswordBtn.hidden = !isView;
        cancelProfileBtn.hidden = isView;
        saveChangesBtn.hidden = !isEdit;
        updatePasswordBtn.hidden = !isPassword;
    }

    setProfileMode("view");

    // Clear the error highlight as soon as a field has a value
    Object.keys(REQUIRED_PROFILE_FIELDS).forEach((id) => {
        const el = document.getElementById(id);
        el?.addEventListener("input", () => {
            if (el.value.trim() !== "") el.classList.remove("inputError");
        });
    });

    editProfileBtn?.addEventListener("click", () => {
        snapshotProfile();
        setProfileMode("edit");
    });

    changePasswordBtn?.addEventListener("click", () => {
        snapshotProfile();
        setProfileMode("password");
    });

    cancelProfileBtn?.addEventListener("click", () => {
        // Restore last saved values and clear password fields
        profileFields.forEach((field) => {
            field.value = originalProfile[field.id] ?? "";
        });

        const np = document.getElementById("new_pass");
        const cp = document.getElementById("confirm_pass");
        if (np) np.value = "";
        if (cp) cp.value = "";

        setProfileMode("view");
    });

    saveChangesBtn?.addEventListener("click", async () => {
        if (!validateProfileFields()) return;
        if (!validatePhoneNumber()) return;

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
            showAlertTOP(
                friendlyMessage(err?.message, "Failed to update profile"),
                "error",
            );

            const errorFields = findProfileErrorFields(err.message);
            console.log("Profile error fields:", errorFields);

            errorFields.forEach((fieldId, index) => {
                animateInputError(fieldId, {
                    scroll: index === 0,
                    focus: index === 0,
                });
            });
        } finally {
            saveChangesBtn.disabled = false;
            saveChangesBtn.innerHTML = originalHTML;
        }
    });

    const LOGIN_URL = new URL("login.html", window.location.href).href;

    updatePasswordBtn?.addEventListener("click", () => {
        if (!validateProfileFields()) return;

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
                const payload = { password: newPass };
                await saveProfileToServer(payload);

                showAlertTOP("Password updated, please log-in again", "success");
                setTimeout(() => {
                    try {
                        if (window.top.location.origin === window.location.origin) {
                            window.top.location.replace(LOGIN_URL);
                            return;
                        }
                    } catch {
                        /* cross-origin */
                    }

                    window.top.postMessage(
                        { type: "auth:redirect", url: LOGIN_URL },
                        "*",
                    );
                }, 3500);
                return new Promise(() => { });
            },
        });
    });

    // System configuration section
    const systemConfigForm = document.getElementById("system_config_form");
    const SYSTEM_API = "api/settings";

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

    const SIGNATORY_INDEXES = [1, 2, 3, 4];

    const IMAGE_SETTINGS = [
        { key: "header", desc: "Report Header Image", inputId: "header" },
        { key: "footer", desc: "Report Footer Image", inputId: "footer" },
        {
            key: "cemetery_map_image",
            desc: "For the cemetery map backgound image",
            inputId: "cemetery_map_image",
        },
    ];

    const SYSTEM_ERROR_FIELD_MAP = [
        {
            re: /textbee/i,
            fields: ["textbee_api_key", "textbee_device_id"],
        },
        {
            re: /for\s+['"]?header['"]?/i,
            fields: ["header"],
        },
        {
            re: /for\s+['"]?footer['"]?/i,
            fields: ["footer"],
        },
    ];

    function findSystemErrorFields(message) {
        if (!message) return [];
        const out = [];
        for (const { re, fields } of SYSTEM_ERROR_FIELD_MAP) {
            if (re.test(message)) {
                for (const f of fields) if (!out.includes(f)) out.push(f);
            }
        }
        return out;
    }

    systemConfigForm?.addEventListener("submit", async (e) => {
        e.preventDefault();

        // TextBee: API key and device ID must be filled together or cleared together
        {
            const keyEl = document.getElementById("textbee_api_key");
            const devEl = document.getElementById("textbee_device_id");

            if (keyEl && devEl) {
                const keyVal = (keyEl.value ?? "").trim();
                const devVal = (devEl.value ?? "").trim();

                const keyEmpty = keyVal === "";
                const devEmpty = devVal === "";

                if (keyEmpty !== devEmpty) {
                    const missingEl = keyEmpty ? keyEl : devEl;
                    const missingLabel = keyEmpty ? "API Key" : "Device ID";
                    const filledLabel = keyEmpty ? "Device ID" : "API Key";

                    showAlertTOP(
                        `TextBee: ${filledLabel} is filled in but ${missingLabel} is empty. ` +
                        `Fill in both, or clear both.`,
                        "warning",
                    );
                    animateInputError(missingEl);
                    return;
                }
            }
        }

        // Signatories: each name/title pair must be filled together or cleared together
        for (const i of SIGNATORY_INDEXES) {
            const nameEl = document.getElementById(`people_name_${i}`);
            const titleEl = document.getElementById(`people_title_${i}`);

            const nameVal = (nameEl?.value ?? "").trim();
            const titleVal = (titleEl?.value ?? "").trim();

            const nameEmpty = nameVal === "";
            const titleEmpty = titleVal === "";

            if (nameEmpty === titleEmpty) continue;

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

        const entries = [];

        // Plain text/color settings
        for (const def of SYSTEM_SETTINGS) {
            const el = document.getElementById(def.inputId);
            if (!el) continue;
            const val = (el.value ?? "").trim();
            if (!val) continue;
            entries.push({ key: def.key, desc: def.desc, value: val, file: null });
        }

        // Signatory name/title pairs
        for (const i of SIGNATORY_INDEXES) {
            const nameEl = document.getElementById(`people_name_${i}`);
            const titleEl = document.getElementById(`people_title_${i}`);
            if (!nameEl && !titleEl) continue;

            const nameVal = (nameEl?.value ?? "").trim();
            const titleVal = (titleEl?.value ?? "").trim();

            entries.push({
                key: `people_name_${i}`,
                desc: `Report Signatory ${i} Name`,
                value: nameVal,
                file: null,
            });
            entries.push({
                key: `people_title_${i}`,
                desc: `Report Signatory ${i} Title`,
                value: titleVal,
                file: null,
            });
        }

        // Image uploads
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

        // Build multipart form data
        const fd = new FormData();
        entries.forEach((entry, idx) => {
            fd.append(`bulk_settings[${idx}][setting_key]`, entry.key);
            fd.append(`bulk_settings[${idx}][description]`, entry.desc);
            fd.append(`bulk_settings[${idx}][setting_value]`, entry.value);
            if (entry.file) {
                fd.append(`bulk_images[${idx}]`, entry.file, entry.file.name);
            }
        });

        const submitBtn = systemConfigForm.querySelector('button[type="submit"]');
        const originalHTML = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';

        try {
            const response = await fetch(SYSTEM_API, {
                method: "POST",
                credentials: "same-origin",
                body: fd,
            });

            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(result?.message || `HTTP ${response.status}`);
            }

            // Remember the saved color so the undo button works later
            const mainColorEntry = entries.find(
                (entry) => entry.key === "main_color",
            );

            window.main_mainColor = mainColorEntry?.value ?? "";

            showAlertTOP("Settings saved successfully.", "success");
        } catch (err) {
            console.error("Save Configuration failed:", err);
            showAlertTOP(
                friendlyMessage(err?.message, "Failed to save settings."),
                "error",
            );

            const errorFields = findSystemErrorFields(err.message);
            console.log("Settings error fields:", errorFields);

            errorFields.forEach((fieldId, index) => {
                // Image errors highlight the preview instead of the hidden input
                let target = fieldId;
                if (fieldId === "header" || fieldId === "footer") {
                    const preview = document.getElementById(`preview_${fieldId}`);
                    if (preview) target = preview;
                }

                animateInputError(target, {
                    scroll: index === 0,
                    focus: index === 0,
                });
            });
        } finally {
            // Refresh image previews and re-enable the submit button
            document.getElementById("preview_footer").src = "api/images/footer.png";
            document.getElementById("preview_header").src = "api/images/header.png";
            refreshImages();
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalHTML;
        }
    });

    // CSV import / export section
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

        // Basic client-side file validation
        if (!file.name.toLowerCase().endsWith(".csv")) {
            showAlertTOP("Only .csv files are allowed.", "error");
            return;
        }
        const MAX_SIZE = 100 * 1024 * 1024;
        if (file.size === 0 || file.size > MAX_SIZE) {
            showAlertTOP("Invalid file size (must be > 0 and ≤ 100 MB).", "error");
            return;
        }

        const fd = new FormData();
        fd.append("csv_file", file, file.name);

        const originalHTML = importNowBtn.innerHTML;
        importNowBtn.disabled = true;
        importNowBtn.innerHTML =
            '<i class="fas fa-spinner fa-spin"></i> Importing…';

        try {
            const response = await fetch(EXCEL_API, {
                method: "POST",
                credentials: "same-origin",
                body: fd,
            });

            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(result?.message || `HTTP ${response.status}`);
            }

            const data = result?.data ?? {};
            const message = result?.message || "Import finished.";

            // Show a detailed report when there are issues, otherwise a simple toast
            if (data.has_errors || data.has_warnings) {
                showImportReportModal(data);
            } else {
                showAlertTOP(message, "success");
            }

            if (data.errors?.length || data.warnings?.length) {
                console.groupCollapsed("📋 Import details");
                if (data.errors?.length) console.error("Errors:", data.errors);
                if (data.warnings?.length) console.warn("Warnings:", data.warnings);
                console.groupEnd();
            }

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

    // CSV export
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

            // If the server sent JSON instead of a file, show its message
            const contentType = response.headers.get("Content-Type") || "";
            if (contentType.includes("application/json")) {
                const parsed = await response.json();
                showAlertTOP(parsed?.message || "Nothing to export.", "info");
                return;
            }

            // Try to use the server-provided filename
            const cd = response.headers.get("Content-Disposition") || "";
            const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
            const filename =
                match?.[1] ||
                `interments_export_${new Date().toISOString().slice(0, 10)}.csv`;

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
            showAlertTOP(friendlyMessage(err?.message, "Export failed."), "error");
        } finally {
            excelExportBtn.disabled = false;
            excelExportBtn.innerHTML = originalHTML;
        }
    });

    // Small global helpers
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

    // Backup / restore section
    const BACKUP_API = "api/backup";
    const BACKUP_LIMIT = 5;

    const backupNowBtn = document.getElementById("backupNowBtn");
    const backupVersionSel = document.getElementById("backupVersion");
    const restoreBtn = document.getElementById("restoreBtn");
    const downloadBtn = document.getElementById("downloadBtn");

    let backupList = [];

    function formatBackupSize(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / (1024 * 1024)).toFixed(1) + " MB";
    }

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

    function renderBackupOptions(backups) {
        backupList = Array.isArray(backups) ? backups : [];

        backupVersionSel.innerHTML = "";

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

        backupList.forEach((b, i) => {
            const opt = document.createElement("option");
            opt.value = b.filename;
            const base = `Version ${i + 1} — ${formatBackupDate(b.date)} · ${formatBackupSize(b.size_in_bytes)}`;
            opt.textContent = i === 0 ? `${base} (Latest)` : base;
            backupVersionSel.appendChild(opt);
        });

        // Fill remaining slots so the dropdown always shows the limit
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

    async function loadBackups({ silent = false } = {}) {
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
                showAlertTOP(
                    friendlyMessage(err?.message, "Failed to load backups."),
                    "error",
                );
            }
            renderBackupOptions([]);
            return [];
        }
    }

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

            showAlertTOP(result?.message || "Backup created.", "success");

            await loadBackups({ silent: true });
        } catch (err) {
            console.error("Backup failed:", err);
            showAlertTOP(friendlyMessage(err?.message, "Backup failed."), "error");
        } finally {
            backupNowBtn.disabled = false;
            backupNowBtn.innerHTML = originalHTML;
        }
    });

    downloadBtn?.addEventListener("click", () => {
        const filename = backupVersionSel.value;
        if (!filename) return;

        const item = backupList.find((b) => b.filename === filename);

        const url =
            item?.download || `${BACKUP_API}/${encodeURIComponent(filename)}`;

        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    });

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
                    throw new Error(
                        friendlyMessage(result?.message, "Failed to restore database."),
                    );
                }

                showAlertTOP(result?.message || "Database restored.", "success");

                await loadBackups({ silent: true });
            },
        });
    });

    // Initial state: backups are loaded silently on page load
    restoreBtn.disabled = true;
    downloadBtn.disabled = true;

    loadBackups({ silent: true });
});