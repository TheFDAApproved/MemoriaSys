(function () {
    "use strict";

    // Configuration
    const API_URL = "api/payments.php";
    const PER_PAGE = 10;
    const SEARCH_MIN_LEN = 3;
    const SEARCH_DEBOUNCE_MS = 350;
    const REMARK_MAX_LEN = 2000;
    const REQUEST_TIMEOUT_MS = 30000;
    const GENERIC_ERROR = "Something went wrong. Please try again.";

    // Application State
    // Tracks pagination, filters, in-flight requests, and modal instances
    const state = {
        page: 1,
        totalPages: 1,
        search: "",
        status: "all",
        loading: false,
        requestId: 0,
        remarksModal: null,
        proofModal: null,
        editingSection: null,
    };

    // Cached DOM Elements
    const el = {
        search: document.getElementById("payment_search"),
        statusFilter: document.getElementById("status_filter"),
        filterBtn: document.getElementById("filter_btn"),
        tbody: document.getElementById("paymentsTableBody"),
        noData: document.getElementById("burialNoData"),
        currentPage: document.getElementById("current_page_num"),
        totalPages: document.getElementById("total_pages_num"),
        prevBtn: document.getElementById("prev_page_btn"),
        nextBtn: document.getElementById("next_page_btn"),
        carouselTrack: document.getElementById("carousel_track"),
    };

    // General Utility Helpers
    // Escape text so it can be inserted into HTML safely
    const escapeHtml = (value) => {
        if (value === null || value === undefined) return "";
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    };

    // Detects raw technical messages so they are never shown directly to the user
    const looksRawMessage = (text) => {
        if (!text) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;
        if (/ERR_NGROK_|ngrok/i.test(t)) return true;
        if (/^HTTP\s+\d{3}/i.test(t)) return true;
        if (/^Request failed \(HTTP \d{3}\)$/i.test(t)) return true;
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
    };

    // Return a user-friendly message, falling back to a generic one
    const friendlyMessage = (err, fallback) => {
        if (!err) return fallback || GENERIC_ERROR;
        const msg =
            err && err.message ? String(err.message).trim() : String(err).trim();
        if (!msg || looksRawMessage(msg)) return fallback || GENERIC_ERROR;
        return msg;
    };

    // Format a number as Philippine pesos
    const formatMoney = (value) => {
        const n = Number(value) || 0;
        try {
            return n.toLocaleString("en-PH", { style: "currency", currency: "PHP" });
        } catch (_) {
            return "\u20B1" + n.toFixed(2);
        }
    };

    // Delay a function call until input stops for the given time
    const debounce = (fn, wait) => {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait);
        };
    };

    // Show an alert using the page-wide alert helper when available
    const notify = (message, type) => {
        try {
            if (typeof window.showAlertTOP === "function") {
                window.showAlertTOP(message, type);
                return;
            }
        } catch (_) { }
        if (type === "error") console.error(message);
        else console.log(message);
    };

    // Ask the user for confirmation using the custom dialog if available
    async function askConfirm(message, opts) {
        if (typeof window.confirm_ui === "function") {
            return !!(await window.confirm_ui(message, opts));
        }
        return window.confirm(message);
    }

    // fetch() wrapper that aborts the request after a timeout
    async function fetchWithTimeout(url, options, ms) {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            ms || REQUEST_TIMEOUT_MS,
        );
        try {
            const opts = Object.assign({}, options || {}, {
                signal: controller.signal,
            });
            return await fetch(url, opts);
        } finally {
            clearTimeout(timeout);
        }
    }

    // True when a fetch was cancelled by the timeout controller
    const isAbortError = (err) => !!(err && err.name === "AbortError");

    // Unwrap a JSON envelope, returning the inner `data` when present
    const unwrap = (json) =>
        (json && (json.data !== undefined ? json.data : json)) || {};

    // Payment-Specific Helpers
    // Combine the office and grounds flags into a single status key
    const classifyStatus = (p) => {
        const office = !!p.office_confirmed;
        const grounds = !!p.grounds_confirmed;
        if (office && grounds) return "completed";
        if (office) return "pending_grounds";
        return "pending_office";
    };

    const remarkTypes = ["payer", "office", "grounds"];

    // Map a remark type to the payment field that stores it
    const remarkField = (type) => "remarks_" + type;

    const readRemark = (payment, type) => {
        const v = payment && payment[remarkField(type)];
        if (v === null || v === undefined) return "";
        return String(v);
    };

    const truncate = (text, max) => {
        const s = String(text || "");
        if (s.length <= max) return s;
        return s.slice(0, max - 1) + "\u2026";
    };

    const remarkLabelFor = (type) => type.charAt(0).toUpperCase() + type.slice(1);

    // Only office and grounds remarks can be edited by the user
    const canEditRemark = (type) => type === "office" || type === "grounds";

    // Build the SMS message sent after a payment is verified
    const buildVerificationMessage = (p) => {
        const name = (p.payers_name || p.deceased_name || "valued client").trim();
        const ref = (p.reference_number || "").trim();
        return (
            "Hello " +
            name +
            ", your payment with the reference number: " +
            ref +
            " is now verified."
        );
    };

    // Open the SMS composer, using the custom modal when available
    const openSms = (phone, message) => {
        if (typeof window.openSmsModal === "function") {
            window.openSmsModal(phone, message);
            return;
        }
        if (!phone) {
            notify("No phone number available for this record.", "error");
            return;
        }
        const url =
            "sms:" +
            encodeURIComponent(phone) +
            "&body=" +
            encodeURIComponent(message || "");
        try {
            window.location.href = url;
        } catch (_) { }
    };

    // Find the table row that belongs to a given payment id
    function getRow(paymentId) {
        if (!el.tbody) return null;
        return el.tbody.querySelector(
            'tr[data-payment-id="' + CSS.escape(String(paymentId)) + '"]',
        );
    }

    // Row Busy Indicator
    // Disable a row's controls while an action is running
    // Returns a function that restores the original state
    function enterRowBusy(btn) {
        if (!btn) return function noop() { };

        const row = btn.closest("tr");
        const group = btn.closest(".pmActionGroup");

        if (row) {
            row.classList.add("pmRowBusy");
            row.setAttribute("inert", "");
            row.setAttribute("aria-busy", "true");
        }

        if (!group) {
            const originalHtml = btn.innerHTML;
            const wasDisabled = btn.disabled;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            return function restore() {
                btn.innerHTML = originalHtml;
                btn.disabled = wasDisabled;
                if (row) {
                    row.classList.remove("pmRowBusy");
                    row.removeAttribute("inert");
                    row.removeAttribute("aria-busy");
                }
            };
        }

        const buttons = Array.from(group.querySelectorAll("button"));
        const snapshot = buttons.map((b) => ({
            html: b.innerHTML,
            disabled: b.disabled,
        }));

        buttons.forEach((b) => {
            b.disabled = true;
        });
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        return function restore() {
            buttons.forEach((b, i) => {
                const snap = snapshot[i];
                if (!snap) return;
                b.innerHTML = snap.html;
                b.disabled = snap.disabled;
            });
            if (row) {
                row.classList.remove("pmRowBusy");
                row.removeAttribute("inert");
                row.removeAttribute("aria-busy");
            }
        };
    }

    function clearRowBusy(row) {
        if (!row) return;
        row.classList.remove("pmRowBusy");
        row.removeAttribute("inert");
        row.removeAttribute("aria-busy");
    }

    // Inline Styles
    function injectStyles() {
        if (document.getElementById("paymentsActionStyles")) return;
        const style = document.createElement("style");
        style.id = "paymentsActionStyles";
        style.textContent = `
            .pmStatusBadge {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 4px 10px;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 600;
                line-height: 1;
                white-space: nowrap;
                border: 1px solid transparent;
                vertical-align: middle;
            }
            .pmStatusBadge i { font-size: 11px; }
            .pmStatus--pendingOffice  { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
            .pmStatus--pendingGrounds { background: #ffedd5; color: #9a3412; border-color: #fed7aa; }
            .pmStatus--completed      { background: #dcfce7; color: #166534; border-color: #bbf7d0; }

            .paymentsTable td:last-child,
            .paymentsTable th:last-child {
                white-space: nowrap;
                width: 1%;
            }
            .paymentsTable td:last-child {
                vertical-align: middle;
                text-align: center;
            }

            .pmActionGroup {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                flex-wrap: nowrap;
                white-space: nowrap;
                line-height: 1;
            }

            .pmActionBtn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                padding: 0;
                margin: 0;
                font-size: 13px;
                font-family: inherit;
                color: #606770;
                background: transparent;
                border: 1px solid transparent;
                border-radius: 8px;
                cursor: pointer;
                flex: 0 0 auto;
                transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
            }
            .pmActionBtn i { line-height: 1; pointer-events: none; }
            .pmActionBtn:hover { background: #f8fafc; border-color: #e5e7eb; color: #1c1e21; }
            .pmActionBtn:active { transform: translateY(1px); }
            .pmActionBtn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.15); }
            .pmActionBtn--verify:hover,
            .pmActionBtn--verify:focus-visible { background: #eff6ff; border-color: #dbeafe; color: #2563eb; }
            .pmActionBtn--delete:hover,
            .pmActionBtn--delete:focus-visible { background: #fef2f2; border-color: #fee2e2; color: #dc2626; }
            .pmActionBtn--unverify:hover,
            .pmActionBtn--unverify:focus-visible { background: #fff7ed; border-color: #fed7aa; color: #d97706; }

            .paymentsTable tr.pmRowBusy {
                opacity: 0.55;
                cursor: progress;
                user-select: none;
                transition: opacity 0.15s ease;
            }
            .paymentsTable tr.pmRowBusy .pmActionGroup,
            .paymentsTable tr.pmRowBusy .pmRemarksCell,
            .paymentsTable tr.pmRowBusy .pmProofCell,
            .paymentsTable tr.pmRowBusy .smsPhoneLink {
                pointer-events: none;
            }
            .paymentsTable tr.pmRowBusy .pmActionBtn {
                cursor: progress;
            }

            .pmVerifiedPill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 32px;
                padding: 0 12px;
                border-radius: 8px;
                font-size: 12.5px;
                font-weight: 600;
                line-height: 1;
                white-space: nowrap;
                background: #16a34a;
                color: #ffffff;
                cursor: default;
                user-select: none;
                flex: 0 0 auto;
                vertical-align: middle;
                border: 1px solid #16a34a;
            }
            .pmVerifiedPill i { font-size: 13px; line-height: 1; }

            .pmProofCell {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 60px;
                height: 60px;
                border-radius: 6px;
                overflow: hidden;
                cursor: pointer;
                background: #f1f5f9;
                border: 1px solid #e5e7eb;
                position: relative;
                vertical-align: middle;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .pmProofCell:hover {
                border-color: var(--mainColor, #2563eb);
                box-shadow: 0 2px 10px rgba(37, 99, 235, 0.20);
            }
            .pmProofCell:focus-visible {
                outline: none;
                box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.30);
            }
            .pmProofThumb {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }
            .pmProofBroken {
                display: none;
                align-items: center;
                justify-content: center;
                flex-direction: column;
                gap: 3px;
                width: 100%;
                height: 100%;
                color: #dc2626;
                font-size: 16px;
                background: #fef2f2;
            }
            .pmProofBroken small {
                font-size: 8.5px;
                font-weight: 800;
                letter-spacing: 0.4px;
                text-transform: uppercase;
                color: #b91c1c;
            }
            .pmProofCell.is-broken { border-color: #fecaca; background: #fef2f2; }
            .pmProofCell.is-broken:hover { border-color: #dc2626; box-shadow: 0 2px 10px rgba(220, 38, 38, 0.18); }
            .pmProofCell.is-broken .pmProofThumb  { display: none; }
            .pmProofCell.is-broken .pmProofBroken { display: flex; }

            .pmRemarksCell {
                display: flex;
                flex-direction: column;
                gap: 3px;
                max-width: 280px;
                min-width: 200px;
                text-align: left;
                font-size: 12px;
                line-height: 1.35;
            }
            .pmRemarkRow {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 2px 4px;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.15s ease;
                white-space: nowrap;
                overflow: hidden;
            }
            .pmRemarkRow:hover { background: #f1f5f9; }
            .pmRemarkRow:focus-visible {
                outline: none;
                background: #eff6ff;
                box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.25);
            }
            .pmRemarkIcon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 14px;
                color: #94a3b8;
                font-size: 10px;
                flex: 0 0 auto;
            }
            .pmRemarkRow.is-office:hover  .pmRemarkIcon { color: #2563eb; }
            .pmRemarkRow.is-grounds:hover .pmRemarkIcon { color: #d97706; }
            .pmRemarkRow.is-payer         .pmRemarkIcon { color: #cbd5e1; }
            .pmRemarkLabel {
                font-weight: 700;
                color: #6b7280;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.3px;
                flex: 0 0 auto;
                min-width: 52px;
            }
            .pmRemarkPreview {
                color: #1c1e21;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                flex: 1 1 auto;
            }
            .pmRemarkPreview.is-empty {
                color: #9ca3af;
                font-style: italic;
                font-weight: 500;
            }

            .pmRemarksBackdrop {
                position: fixed;
                inset: 0;
                background: rgba(15, 18, 28, 0.5);
                -webkit-backdrop-filter: blur(2px);
                backdrop-filter: blur(2px);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                z-index: 9999;
                opacity: 0;
                transition: opacity 0.2s ease;
            }
            .pmRemarksBackdrop.pmVisible { opacity: 1; }

            .pmRemarksCard {
                width: 100%;
                max-width: 540px;
                max-height: calc(100vh - 40px);
                background: #ffffff;
                border: 1px solid #e5e7eb;
                border-radius: 14px;
                box-shadow: 0 20px 50px rgba(15, 18, 28, 0.20);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                transform: translateY(10px) scale(0.98);
                transition: transform 0.2s ease;
                font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
            }
            .pmRemarksBackdrop.pmVisible .pmRemarksCard {
                transform: translateY(0) scale(1);
            }

            .pmRemarksHeader {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 16px 20px;
                background: #f9fafb;
                border-bottom: 1px solid #eef0f3;
            }
            .pmRemarksTitle {
                display: inline-flex;
                align-items: center;
                gap: 10px;
                margin: 0;
                font-size: 15px;
                font-weight: 700;
                color: #111827;
                letter-spacing: 0.1px;
            }
            .pmRemarksTitle i {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 30px;
                height: 30px;
                border-radius: 8px;
                background: rgba(99, 102, 241, 0.12);
                color: var(--mainColor, #2563eb);
                font-size: 13px;
            }
            .pmRemarksClose {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                padding: 0;
                border: 1px solid transparent;
                border-radius: 8px;
                background: transparent;
                color: #606770;
                font-size: 13px;
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
            }
            .pmRemarksClose:hover {
                background: #fef2f2;
                border-color: #fee2e2;
                color: #dc2626;
            }
            .pmRemarksClose:focus-visible {
                outline: none;
                box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.15);
            }

            .pmRemarksBody {
                padding: 16px 20px 20px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .pmRemarkSection {
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 6px 2px;
                background: transparent;
                border: none;
                border-radius: 0;
                transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
            }
            .pmRemarkSection.is-editing {
                background: #ffffff;
                border-color: var(--mainColor, #2563eb);
                box-shadow: none;
            }
            .pmRemarkSectionHeader {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .pmRemarkSectionLabel {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                font-size: 11.5px;
                font-weight: 700;
                color: #374151;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .pmRemarkSectionLabel i { font-size: 11px; }
            .pmRemarkSection.is-payer   .pmRemarkSectionLabel i { color: #94a3b8; }
            .pmRemarkSection.is-office  .pmRemarkSectionLabel i { color: #2563eb; }
            .pmRemarkSection.is-grounds .pmRemarkSectionLabel i { color: #d97706; }

            .pmRemarkSectionValue {
                font-size: 13.5px;
                line-height: 1.55;
                color: #1c1e21;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .pmRemarkSectionValue.is-empty {
                color: #9ca3af;
                font-style: italic;
            }

            .pmRemarkEditBtn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                padding: 0;
                border: 1px solid transparent;
                border-radius: 6px;
                background: transparent;
                color: #606770;
                font-size: 12px;
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
            }
            .pmRemarkEditBtn:hover {
                background: #eff6ff;
                border-color: #dbeafe;
                color: #2563eb;
            }
            .pmRemarkEditBtn:focus-visible {
                outline: none;
                box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.15);
            }

            .pmRemarkTextarea {
                width: 100%;
                min-height: 90px;
                resize: vertical;
                padding: 10px 12px;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                font-family: inherit;
                font-size: 13.5px;
                line-height: 1.5;
                color: #1c1e21;
                background: #ffffff;
                outline: none;
                box-sizing: border-box;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .pmRemarkTextarea:focus {
                border-color: var(--mainColor, #2563eb);
                box-shadow: none;
            }

            .pmRemarkEditActions {
                display: flex;
                justify-content: flex-end;
                gap: 8px;
            }

            .pmRemarkEditActions[hidden],
            .pmRemarkTextarea[hidden],
            .pmRemarkSectionValue[hidden] {
                display: none !important;
            }

            .pmRemarkBtn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 8px 14px;
                min-height: 34px;
                font-family: inherit;
                font-size: 13px;
                font-weight: 600;
                line-height: 1;
                border-radius: 8px;
                border: 1px solid transparent;
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, filter 0.15s ease;
            }
            .pmRemarkBtn--ghost {
                background: #ffffff;
                border-color: #e5e7eb;
                color: #4b5563;
            }
            .pmRemarkBtn--ghost:hover { background: #f3f4f6; border-color: #d1d5db; color: #1c1e21; }
            .pmRemarkBtn--primary {
                background: var(--mainColor, #2563eb);
                border-color: var(--mainColor, #2563eb);
                color: #ffffff;
            }
            .pmRemarkBtn--primary:hover { filter: brightness(0.94); }
            .pmRemarkBtn:focus-visible {
                outline: none;
                box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.30);
            }
            .pmRemarkBtn:disabled { opacity: 0.6; cursor: not-allowed; }

            @media (max-width: 480px) {
                .pmRemarksHeader { padding: 14px 16px; }
                .pmRemarksBody   { padding: 14px 16px 18px; }
                .pmRemarksCard   { max-width: 100%; }
            }

            .pmProofBackdrop {
                position: fixed;
                inset: 0;
                background: rgba(15, 18, 28, 0.65);
                -webkit-backdrop-filter: blur(3px);
                backdrop-filter: blur(3px);
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
                z-index: 10000;
                opacity: 0;
                transition: opacity 0.2s ease;
            }
            .pmProofBackdrop.pmVisible { opacity: 1; }

            .pmProofCard {
                width: 100%;
                max-width: 720px;
                max-height: calc(100vh - 40px);
                background: #ffffff;
                border-radius: 14px;
                box-shadow: 0 20px 60px rgba(15, 18, 28, 0.40);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                transform: scale(0.96);
                transition: transform 0.2s ease;
                font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
            }
            .pmProofBackdrop.pmVisible .pmProofCard { transform: scale(1); }

            .pmProofHeader {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 14px 18px;
                background: #f9fafb;
                border-bottom: 1px solid #eef0f3;
            }
            .pmProofTitle {
                display: inline-flex;
                align-items: center;
                gap: 10px;
                margin: 0;
                font-size: 14.5px;
                font-weight: 700;
                color: #111827;
            }
            .pmProofTitle i {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 30px;
                height: 30px;
                border-radius: 8px;
                background: rgba(99, 102, 241, 0.12);
                color: var(--mainColor, #2563eb);
                font-size: 13px;
            }

            .pmProofImageWrap {
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 14px;
                background: #0f172a;
                min-height: 220px;
            }
            .pmProofImageWrap img {
                max-width: 100%;
                max-height: 62vh;
                object-fit: contain;
                display: block;
                border-radius: 4px;
            }
            .pmProofSpinner {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                min-height: 180px;
                color: #94a3b8;
                font-size: 26px;
            }
            .pmProofBrokenBig {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 10px;
                padding: 40px 20px;
                text-align: center;
                width: 100%;
            }
            .pmProofBrokenBig i {
                font-size: 44px;
                color: #f87171;
            }
            .pmProofBrokenBig strong {
                color: #ffffff;
                font-size: 15px;
                font-weight: 700;
            }
            .pmProofBrokenBig span {
                color: #94a3b8;
                font-size: 12.5px;
                max-width: 380px;
                line-height: 1.5;
            }

            .pmProofUrlRow {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 12px 16px;
                background: #f8fafc;
                border-top: 1px solid #eef0f3;
            }
            .pmProofUrlLabel {
                font-size: 10.5px;
                font-weight: 800;
                letter-spacing: 0.6px;
                text-transform: uppercase;
                color: #64748b;
                flex: 0 0 auto;
            }
            .pmProofUrlLink {
                flex: 1 1 auto;
                min-width: 0;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size: 12px;
                color: var(--mainColor, #2563eb);
                text-decoration: none;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                padding: 6px 10px;
                background: #ffffff;
                border: 1px solid #e2e8f0;
                border-radius: 6px;
                transition: border-color 0.15s ease, background 0.15s ease;
            }
            .pmProofUrlLink:hover {
                text-decoration: underline;
                border-color: var(--mainColor, #2563eb);
            }
            .pmProofUrlLink:focus-visible {
                outline: none;
                box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
            }
            .pmProofCopyBtn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 34px;
                height: 34px;
                padding: 0;
                background: #ffffff;
                border: 1px solid #e2e8f0;
                border-radius: 6px;
                color: #64748b;
                cursor: pointer;
                flex: 0 0 auto;
                transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
            }
            .pmProofCopyBtn:hover {
                background: #f1f5f9;
                color: #1c1e21;
                border-color: #cbd5e1;
            }
            .pmProofCopyBtn:focus-visible {
                outline: none;
                box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25);
            }
            .pmProofCopyBtn.is-copied {
                color: #16a34a;
                border-color: #bbf7d0;
                background: #f0fdf4;
            }

            @media (max-width: 480px) {
                .pmProofCard           { max-width: 100%; }
                .pmProofHeader         { padding: 12px 14px; }
                .pmProofUrlRow         { padding: 10px 12px; flex-wrap: wrap; }
                .pmProofImageWrap img  { max-height: 50vh; }
            }

            .pmSearchClearBtn {
                position: absolute;
                right: 8px;
                top: 50%;
                transform: translateY(-50%);
                display: none;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                padding: 0;
                margin: 0;
                border: none;
                border-radius: 50%;
                background: transparent;
                color: #9ca3af;
                font-size: 11px;
                line-height: 1;
                cursor: pointer;
                z-index: 5;
                transition: background 0.15s ease, color 0.15s ease;
            }
            .pmSearchClearBtn:hover {
                background: #f3f4f6;
                color: #4b5563;
            }
            .pmSearchClearBtn:focus-visible {
                outline: none;
                box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.30);
            }
            .pmSearchClearBtn.is-visible {
                display: inline-flex;
            }
            .pmSearchInputWithClear::-webkit-search-cancel-button,
            .pmSearchInputWithClear::-webkit-search-decoration {
                -webkit-appearance: none;
                appearance: none;
            }
        `;
        document.head.appendChild(style);
    }

    // Table Empty / Loading / Error States
    function showNoData(message) {
        if (!el.noData) return;
        el.noData.hidden = false;
        el.noData.style.display = "";
        el.noData.innerHTML =
            '<i class="fas fa-inbox"></i> ' +
            escapeHtml(message || "No records found");
    }

    function hideNoData() {
        if (!el.noData) return;
        el.noData.hidden = true;
        el.noData.style.display = "none";
    }

    function renderLoading() {
        hideNoData();
        el.tbody.innerHTML =
            '<tr><td colspan="12" style="text-align:center;padding:24px;opacity:.75;">' +
            '<i class="fas fa-spinner fa-spin"></i> Loading payments\u2026' +
            "</td></tr>";
    }

    function renderError(message) {
        el.tbody.innerHTML = "";
        showNoData(message || "Failed to load payment records.");
    }

    // Table Cell Builders
    function buildStatusBadge(p) {
        const key = classifyStatus(p);
        if (key === "completed") {
            return (
                '<span class="pmStatusBadge pmStatus--completed">' +
                '<i class="fas fa-circle-check"></i>Completed</span>'
            );
        }
        if (key === "pending_grounds") {
            return (
                '<span class="pmStatusBadge pmStatus--pendingGrounds">' +
                '<i class="fas fa-clock"></i>Pending \u2013 Grounds</span>'
            );
        }
        return (
            '<span class="pmStatusBadge pmStatus--pendingOffice">' +
            '<i class="fas fa-clock"></i>Pending \u2013 Office</span>'
        );
    }

    function buildRemarksCell(p) {
        const rows = remarkTypes
            .map((type) => {
                const value = readRemark(p, type);
                const empty = value.trim() === "";
                const preview = empty ? "-" : truncate(value, 60);

                const cls =
                    "pmRemarkRow is-" +
                    type +
                    (empty ? " is-empty" : "") +
                    (type === "payer" ? " is-readonly" : "");

                return (
                    "" +
                    '<div class="' +
                    cls +
                    '"' +
                    ' data-action="remark"' +
                    ' data-type="' +
                    type +
                    '"' +
                    ' role="button" tabindex="0"' +
                    ' title="View ' +
                    escapeHtml(remarkLabelFor(type)) +
                    ' remark">' +
                    '<span class="pmRemarkLabel">' +
                    escapeHtml(remarkLabelFor(type)) +
                    "</span>" +
                    '<span class="pmRemarkPreview' +
                    (empty ? " is-empty" : "") +
                    '">' +
                    escapeHtml(preview) +
                    "</span>" +
                    "</div>"
                );
            })
            .join("");

        return (
            '<div class="pmRemarksCell" data-payment-id="' +
            escapeHtml(p.payment_id) +
            '">' +
            rows +
            "</div>"
        );
    }

    function buildProofCell(p) {
        if (!p.image_link) return '<span style="opacity:.55;">\u2014</span>';
        const url = escapeHtml(p.image_link);
        return (
            "" +
            '<div class="pmProofCell"' +
            ' data-action="proof"' +
            ' data-payment-id="' +
            escapeHtml(p.payment_id) +
            '"' +
            ' role="button" tabindex="0"' +
            ' title="View proof of payment">' +
            '<img class="pmProofThumb" src="' +
            url +
            '" alt="Proof of payment" loading="lazy">' +
            '<span class="pmProofBroken">' +
            '<i class="fas fa-exclamation-triangle"></i>' +
            "<small>Invalid</small>" +
            "</span>" +
            "</div>"
        );
    }

    function buildPhoneCell(p) {
        const phoneRaw = (p.payers_phone_number || "").trim();
        if (!phoneRaw) return '<span style="opacity:.55;">\u2014</span>';

        const phone = escapeHtml(phoneRaw);
        return (
            '<a href="#"' +
            ' class="smsPhoneLink"' +
            ' data-action="sms"' +
            ' data-payment-id="' +
            escapeHtml(p.payment_id) +
            '"' +
            ' title="Send SMS notification">' +
            phone +
            "</a>"
        );
    }

    function makeIconBtn(iconClass, className, handler, title) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pmActionBtn " + (className || "");
        btn.title = title || "";
        btn.setAttribute("aria-label", title || "");
        btn.innerHTML = '<i class="' + iconClass + '"></i>';
        btn.addEventListener("click", handler);
        return btn;
    }

    function buildVerifiedPill(title) {
        const pill = document.createElement("span");
        pill.className = "pmVerifiedPill";
        pill.title = title || "Payment fully verified";
        pill.innerHTML = '<i class="fas fa-circle-check"></i><span>Verified</span>';
        return pill;
    }

    function buildActionsCell(p) {
        const wrap = document.createElement("div");
        wrap.className = "pmActionGroup";

        const key = classifyStatus(p);

        if (key === "completed") {
            wrap.appendChild(buildVerifiedPill("Payment fully verified"));
            wrap.appendChild(
                makeIconBtn(
                    "fas fa-undo",
                    "pmActionBtn--unverify",
                    (ev) => runAction(p, "unconfirm_grounds", ev.currentTarget),
                    "Undo grounds verification (then undo office to fully revert)",
                ),
            );
        } else if (key === "pending_grounds") {
            wrap.appendChild(
                makeIconBtn(
                    "fas fa-check",
                    "pmActionBtn--verify",
                    (ev) => runAction(p, "confirm_grounds", ev.currentTarget),
                    "Verify \u2014 mark grounds work as completed",
                ),
            );
            wrap.appendChild(
                makeIconBtn(
                    "fas fa-undo",
                    "pmActionBtn--unverify",
                    (ev) => runAction(p, "unconfirm_office", ev.currentTarget),
                    "Undo office verification (returns to Pending \u2013 Office)",
                ),
            );
        } else {
            wrap.appendChild(
                makeIconBtn(
                    "fas fa-check",
                    "pmActionBtn--verify",
                    (ev) => runAction(p, "confirm_office", ev.currentTarget),
                    "Verify \u2014 confirm payment received by office",
                ),
            );
        }

        wrap.appendChild(
            makeIconBtn(
                "fas fa-trash",
                "pmActionBtn--delete",
                (ev) => confirmDelete(p, ev.currentTarget),
                "Delete payment record",
            ),
        );

        return wrap;
    }

    // Table Rendering
    function renderRows(payments) {
        el.tbody.innerHTML = "";

        if (!Array.isArray(payments) || payments.length === 0) {
            showNoData("No records found");
            return;
        }
        hideNoData();

        const frag = document.createDocumentFragment();
        payments.forEach((p) => {
            const tr = document.createElement("tr");
            tr.dataset.paymentId = p.payment_id;

            tr.innerHTML =
                "<td>" +
                escapeHtml(p.deceased_name || "\u2014") +
                "</td>" +
                "<td>" +
                escapeHtml(p.payers_name || "\u2014") +
                "</td>" +
                "<td>" +
                escapeHtml(p.payment_channel || "\u2014") +
                "</td>" +
                "<td>" +
                escapeHtml(p.reference_number || "\u2014") +
                "</td>" +
                "<td>" +
                formatMoney(p.amount) +
                "</td>" +
                "<td>" +
                buildPhoneCell(p) +
                "</td>" +
                "<td>" +
                escapeHtml(p.payers_email || "\u2014") +
                "</td>" +
                "<td>" +
                escapeHtml(p.purpose || "\u2014") +
                "</td>" +
                "<td>" +
                buildProofCell(p) +
                "</td>" +
                "<td>" +
                buildRemarksCell(p) +
                "</td>" +
                "<td>" +
                buildStatusBadge(p) +
                "</td>";

            const actionCell = document.createElement("td");
            actionCell.appendChild(buildActionsCell(p));
            tr.appendChild(actionCell);

            // Store the payment on the row so event handlers can find it
            tr.__payment = p;

            frag.appendChild(tr);
        });

        el.tbody.appendChild(frag);
    }

    function renderPagination(pagination) {
        const total = Math.max(1, Number(pagination.total_pages) || 1);
        const current = Math.min(
            Math.max(1, Number(pagination.current_page) || 1),
            total,
        );

        state.totalPages = total;
        state.page = current;

        if (el.currentPage) el.currentPage.textContent = String(current);
        if (el.totalPages) el.totalPages.textContent = String(total);

        if (el.prevBtn) el.prevBtn.disabled = current <= 1;
        if (el.nextBtn) el.nextBtn.disabled = current >= total;

        if (!el.carouselTrack) return;
        el.carouselTrack.innerHTML = "";

        // Show a sliding window of page numbers centered on the current page
        const WINDOW = 5;
        let start = Math.max(1, current - Math.floor(WINDOW / 2));
        let end = Math.min(total, start + WINDOW - 1);
        start = Math.max(1, end - WINDOW + 1);

        for (let i = start; i <= end; i++) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "pageNavBtn" + (i === current ? " active" : "");
            btn.textContent = String(i);
            if (i === current) btn.setAttribute("aria-current", "page");
            btn.addEventListener("click", () => {
                if (i === state.page) return;
                state.page = i;
                loadPayments();
            });
            el.carouselTrack.appendChild(btn);
        }
    }

    // Rebuild the status and action cells after a status change
    function refreshRowAfterAction(payment) {
        const row = getRow(payment.payment_id);
        if (!row) return;
        row.__payment = payment;

        const cells = row.querySelectorAll("td");
        if (!cells.length) return;

        const statusCell = cells[cells.length - 2];
        if (statusCell) statusCell.innerHTML = buildStatusBadge(payment);

        const actionCell = cells[cells.length - 1];
        if (actionCell) {
            actionCell.innerHTML = "";
            actionCell.appendChild(buildActionsCell(payment));
        }

        clearRowBusy(row);
    }

    // Rebuild only the remarks cell [used after saving a remark]
    function refreshRowRemarks(payment) {
        const row = getRow(payment.payment_id);
        if (!row) return;
        const cells = row.querySelectorAll("td");
        const remarkCell = cells[cells.length - 3];
        if (remarkCell) remarkCell.innerHTML = buildRemarksCell(payment);
        row.__payment = payment;
    }

    function removeRowLocally(payment) {
        const row = getRow(payment.payment_id);
        if (!row) return false;
        row.remove();
        return true;
    }

    // Remarks Modal
    function closeRemarksModal() {
        const modal = state.remarksModal;
        if (!modal) return;
        modal.backdrop.classList.remove("pmVisible");
        setTimeout(() => {
            if (modal.backdrop.parentNode)
                modal.backdrop.parentNode.removeChild(modal.backdrop);
            if (state.remarksModal === modal) state.remarksModal = null;
        }, 200);
        document.removeEventListener("keydown", modal.onKey, false);
        state.editingSection = null;
    }

    function closeActiveEditor() {
        const section = state.editingSection;
        if (!section) return;
        if (typeof section.__endEdit === "function") section.__endEdit();
    }

    function buildRemarkSection(payment, type, options) {
        const opts = options || {};
        const isPayer = type === "payer";
        const canEdit = !isPayer && canEditRemark(type);
        const value = readRemark(payment, type);
        const empty = value.trim() === "";

        const section = document.createElement("section");
        section.className = "pmRemarkSection is-" + type;
        section.dataset.type = type;

        const header = document.createElement("div");
        header.className = "pmRemarkSectionHeader";

        const label = document.createElement("span");
        label.className = "pmRemarkSectionLabel";
        label.textContent = remarkLabelFor(type);
        header.appendChild(label);

        let editBtn = null;
        if (canEdit) {
            editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "pmRemarkEditBtn";
            editBtn.title = "Edit " + remarkLabelFor(type) + " remark";
            editBtn.setAttribute("aria-label", editBtn.title);
            editBtn.innerHTML = '<i class="fas fa-pen"></i>';
            editBtn.addEventListener("click", () => beginEdit());
            header.appendChild(editBtn);
        }

        section.appendChild(header);

        const view = document.createElement("div");
        view.className = "pmRemarkSectionValue" + (empty ? " is-empty" : "");
        view.textContent = empty ? "-" : value;
        section.appendChild(view);

        if (!canEdit) return section;

        const textarea = document.createElement("textarea");
        textarea.className = "pmRemarkTextarea";
        textarea.maxLength = REMARK_MAX_LEN;
        textarea.placeholder = "Enter " + type + " remark\u2026";
        textarea.hidden = true;
        section.appendChild(textarea);

        const actions = document.createElement("div");
        actions.className = "pmRemarkEditActions";
        actions.hidden = true;

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "pmRemarkBtn pmRemarkBtn--ghost";
        cancelBtn.textContent = "Cancel";
        cancelBtn.addEventListener("click", () => endEdit());

        const saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "pmRemarkBtn pmRemarkBtn--primary";
        saveBtn.textContent = "Save";

        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        section.appendChild(actions);

        let original = value;

        function beginEdit() {
            if (state.editingSection && state.editingSection !== section) {
                closeActiveEditor();
            }

            original = readRemark(payment, type);
            textarea.value = original;

            view.hidden = true;
            textarea.hidden = false;
            actions.hidden = false;
            section.classList.add("is-editing");
            if (editBtn) editBtn.style.display = "none";

            state.editingSection = section;
            section.__endEdit = endEdit;

            textarea.focus();
            try {
                textarea.setSelectionRange(
                    textarea.value.length,
                    textarea.value.length,
                );
            } catch (_) { }
        }

        function endEdit() {
            view.hidden = false;
            textarea.hidden = true;
            actions.hidden = true;
            section.classList.remove("is-editing");
            if (editBtn) editBtn.style.display = "";

            textarea.value = original;
            view.textContent = original.trim() === "" ? "-" : original;
            view.classList.toggle("is-empty", original.trim() === "");

            if (state.editingSection === section) {
                state.editingSection = null;
                delete section.__endEdit;
            }
        }

        saveBtn.addEventListener("click", async () => {
            const newValue = textarea.value;

            if (newValue === original) {
                endEdit();
                return;
            }

            if (newValue.length > REMARK_MAX_LEN) {
                notify(
                    "Remark is too long (max " + REMARK_MAX_LEN + " characters).",
                    "error",
                );
                textarea.focus();
                return;
            }

            saveBtn.disabled = true;
            cancelBtn.disabled = true;
            const prevLabel = saveBtn.textContent;
            saveBtn.textContent = "Saving\u2026";

            const ok = await saveRemark(payment, type, newValue);

            saveBtn.disabled = false;
            cancelBtn.disabled = false;
            saveBtn.textContent = prevLabel;

            if (!ok) return;

            const current = readRemark(payment, type);
            const isNowEmpty = current.trim() === "";
            view.textContent = isNowEmpty ? "-" : current;
            view.classList.toggle("is-empty", isNowEmpty);
            original = current;

            refreshRowRemarks(payment);
            endEdit();
        });

        if (opts.focus) {
            setTimeout(() => {
                try {
                    beginEdit();
                } catch (_) { }
            }, 80);
        }

        return section;
    }

    function openRemarksModal(payment, focusType) {
        if (!payment) return;
        closeRemarksModal();

        const backdrop = document.createElement("div");
        backdrop.className = "pmRemarksBackdrop";
        backdrop.setAttribute("role", "dialog");
        backdrop.setAttribute("aria-modal", "true");
        backdrop.setAttribute("aria-labelledby", "pmRemarksTitle");

        const card = document.createElement("div");
        card.className = "pmRemarksCard";
        backdrop.appendChild(card);

        const header = document.createElement("div");
        header.className = "pmRemarksHeader";
        header.innerHTML =
            '<h3 class="pmRemarksTitle" id="pmRemarksTitle">' +
            "<span>Payment Remarks</span>" +
            "</h3>";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "pmRemarksClose";
        closeBtn.setAttribute("aria-label", "Close");
        closeBtn.innerHTML = '<i class="fas fa-times"></i>';
        closeBtn.addEventListener("click", closeRemarksModal);
        header.appendChild(closeBtn);
        card.appendChild(header);

        const body = document.createElement("div");
        body.className = "pmRemarksBody";

        remarkTypes.forEach((type) => {
            body.appendChild(
                buildRemarkSection(payment, type, {
                    focus: type === focusType,
                }),
            );
        });

        card.appendChild(body);

        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) closeRemarksModal();
        });

        const onKey = (e) => {
            if (e.key === "Escape") {
                if (state.editingSection) {
                    e.preventDefault();
                    closeActiveEditor();
                    return;
                }
                e.preventDefault();
                closeRemarksModal();
            }
        };

        document.body.appendChild(backdrop);
        requestAnimationFrame(() => backdrop.classList.add("pmVisible"));

        state.remarksModal = { backdrop, card, onKey };
        document.addEventListener("keydown", onKey, false);

        setTimeout(() => {
            try {
                closeBtn.focus({ preventScroll: true });
            } catch (_) {
                closeBtn.focus();
            }
        }, 60);
    }

    // Proof of Payment Modal
    function closeProofModal() {
        const modal = state.proofModal;
        if (!modal) return;
        modal.backdrop.classList.remove("pmVisible");
        setTimeout(() => {
            if (modal.backdrop.parentNode)
                modal.backdrop.parentNode.removeChild(modal.backdrop);
            if (state.proofModal === modal) state.proofModal = null;
        }, 200);
        document.removeEventListener("keydown", modal.onKey, false);
    }

    function openProofModal(payment) {
        if (!payment) return;
        closeProofModal();

        const url = String(payment.image_link || "").trim();
        if (!url) {
            notify("No proof image attached to this payment.", "error");
            return;
        }

        const backdrop = document.createElement("div");
        backdrop.className = "pmProofBackdrop";
        backdrop.setAttribute("role", "dialog");
        backdrop.setAttribute("aria-modal", "true");
        backdrop.setAttribute("aria-labelledby", "pmProofTitle");

        const card = document.createElement("div");
        card.className = "pmProofCard";
        backdrop.appendChild(card);

        const header = document.createElement("div");
        header.className = "pmProofHeader";
        const title = document.createElement("h3");
        title.className = "pmProofTitle";
        title.id = "pmProofTitle";
        title.innerHTML =
            '<i class="fas fa-image"></i><span>Proof of Payment</span>';
        header.appendChild(title);

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "pmRemarksClose";
        closeBtn.setAttribute("aria-label", "Close");
        closeBtn.innerHTML = '<i class="fas fa-times"></i>';
        closeBtn.addEventListener("click", closeProofModal);
        header.appendChild(closeBtn);
        card.appendChild(header);

        const imgWrap = document.createElement("div");
        imgWrap.className = "pmProofImageWrap";

        const spinner = document.createElement("div");
        spinner.className = "pmProofSpinner";
        spinner.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        imgWrap.appendChild(spinner);

        const img = document.createElement("img");
        img.alt = "Proof of payment";
        img.style.display = "none";

        img.addEventListener(
            "load",
            () => {
                spinner.remove();
                img.style.display = "";
            },
            { once: true },
        );

        img.addEventListener(
            "error",
            () => {
                spinner.remove();
                img.remove();
                const broken = document.createElement("div");
                broken.className = "pmProofBrokenBig";
                broken.innerHTML =
                    '<i class="fas fa-exclamation-triangle"></i>' +
                    "<strong>Image failed to load</strong>" +
                    "<span>The image at this URL could not be loaded. Check the URL below or open it in a new tab.</span>";
                imgWrap.appendChild(broken);
            },
            { once: true },
        );

        img.src = url;
        imgWrap.appendChild(img);
        card.appendChild(imgWrap);

        const urlRow = document.createElement("div");
        urlRow.className = "pmProofUrlRow";

        const urlLabel = document.createElement("span");
        urlLabel.className = "pmProofUrlLabel";
        urlLabel.textContent = "URL";

        const urlLink = document.createElement("a");
        urlLink.className = "pmProofUrlLink";
        urlLink.href = url;
        urlLink.target = "_blank";
        urlLink.rel = "noopener noreferrer";
        urlLink.textContent = url;
        urlLink.title = url;

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "pmProofCopyBtn";
        copyBtn.title = "Copy URL";
        copyBtn.setAttribute("aria-label", "Copy URL");
        copyBtn.innerHTML = '<i class="fas fa-copy"></i>';

        const flashCopied = () => {
            copyBtn.classList.add("is-copied");
            copyBtn.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => {
                copyBtn.classList.remove("is-copied");
                copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
            }, 1400);
        };

        copyBtn.addEventListener("click", async () => {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(url);
                    flashCopied();
                    return;
                }
            } catch (_) { }

            try {
                const ta = document.createElement("textarea");
                ta.value = url;
                ta.setAttribute("readonly", "");
                ta.style.position = "fixed";
                ta.style.top = "-1000px";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
                flashCopied();
            } catch (_) {
                notify("Could not copy URL.", "error");
            }
        });

        urlRow.appendChild(urlLabel);
        urlRow.appendChild(urlLink);
        urlRow.appendChild(copyBtn);
        card.appendChild(urlRow);

        const onKey = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                closeProofModal();
            }
        };

        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) closeProofModal();
        });

        document.body.appendChild(backdrop);
        requestAnimationFrame(() => backdrop.classList.add("pmVisible"));

        state.proofModal = { backdrop, card, onKey };
        document.addEventListener("keydown", onKey, false);

        setTimeout(() => {
            try {
                closeBtn.focus({ preventScroll: true });
            } catch (_) {
                closeBtn.focus();
            }
        }, 60);
    }

    // Server Communication
    function buildQuery() {
        const params = new URLSearchParams();
        params.set("page", String(state.page));
        params.set("limit", String(PER_PAGE));

        if (state.search && state.search.length >= SEARCH_MIN_LEN) {
            params.set("search_term", state.search);
        }
        if (state.status && state.status !== "all") {
            params.set("status", state.status);
        }
        return params.toString();
    }

    async function loadPayments() {
        const reqId = ++state.requestId;
        state.loading = true;
        renderLoading();

        try {
            const res = await fetchWithTimeout(API_URL + "?" + buildQuery(), {
                method: "GET",
                credentials: "same-origin",
                headers: { Accept: "application/json" },
            });

            const json = await res.json().catch(() => null);

            if (!res.ok || (json && json.success === false)) {
                const msg =
                    (json && (json.message || json.error)) ||
                    "Request failed (HTTP " + res.status + ")";
                throw new Error(msg);
            }
            if (reqId !== state.requestId) return;

            const payload = unwrap(json);
            renderRows(payload.payments);
            renderPagination(
                payload.pagination || { total_pages: 1, current_page: 1 },
            );
        } catch (err) {
            if (reqId !== state.requestId) return;
            console.error("[payments] load error:", err);
            const msg = isAbortError(err)
                ? "Loading payments timed out. Please try again."
                : friendlyMessage(err, "Unable to load payment records.");
            renderError(msg);
        } finally {
            if (reqId === state.requestId) state.loading = false;
        }
    }

    async function saveRemark(payment, type, value) {
        try {
            const res = await fetchWithTimeout(
                API_URL + "?path_info=" + encodeURIComponent(payment.payment_id),
                {
                    method: "PUT",
                    credentials: "same-origin",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: JSON.stringify({
                        action: "edit_remark",
                        remark_type: type,
                        remark_value: value,
                    }),
                },
            );

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                throw new Error(
                    (json && (json.message || json.error)) ||
                    "Request failed (HTTP " + res.status + ")",
                );
            }

            const key = remarkField(type);
            const v = (value || "").trim();
            payment[key] = v === "" ? null : v;

            notify(
                (json && json.message) || remarkLabelFor(type) + " remark saved.",
                "success",
            );
            return true;
        } catch (err) {
            console.error("[payments] save remark error:", err);
            const msg = isAbortError(err)
                ? "Saving remark timed out. Please try again."
                : friendlyMessage(err, "Failed to save remark.");
            notify(msg, "error");
            return false;
        }
    }

    async function runAction(payment, action, btn) {
        if (btn && btn.dataset.confirming === "1") return;

        // Messages shown in the confirm dialog for each action
        const prompts = {
            confirm_office: {
                message: "Confirm this payment was received by the office?",
                title: "Confirm office receipt?",
                confirmText: "Confirm",
            },
            confirm_grounds: {
                message: "Mark the grounds work as completed for this payment?",
                title: "Mark grounds as completed?",
                confirmText: "Confirm",
            },
            unconfirm_office: {
                message:
                    "Undo the office verification for this payment? It will return to \u201CPending \u2013 Office\u201D.",
                title: "Undo office verification?",
                confirmText: "Undo",
                danger: true,
            },
            unconfirm_grounds: {
                message:
                    "Undo the grounds completion for this payment? It will return to \u201CPending \u2013 Grounds\u201D.",
                title: "Undo grounds verification?",
                confirmText: "Undo",
                danger: true,
            },
        };

        const cfg = prompts[action] || {
            message: "Proceed?",
            title: "Confirm action?",
            confirmText: "Confirm",
        };

        if (btn) btn.dataset.confirming = "1";
        let ok = false;
        try {
            ok = await askConfirm(cfg.message, {
                title: cfg.title,
                confirmText: cfg.confirmText,
                cancelText: "Cancel",
                danger: cfg.danger || false,
            });
        } finally {
            if (btn) delete btn.dataset.confirming;
        }
        if (!ok) return;

        const restore = enterRowBusy(btn);

        let succeeded = false;
        try {
            const res = await fetchWithTimeout(
                API_URL + "?path_info=" + encodeURIComponent(payment.payment_id),
                {
                    method: "PUT",
                    credentials: "same-origin",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: JSON.stringify({ action: action }),
                },
            );

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                throw new Error(
                    (json && (json.message || json.error)) ||
                    "Request failed (HTTP " + res.status + ")",
                );
            }
            notify((json && json.message) || "Action completed.", "success");

            if (action === "confirm_office") payment.office_confirmed = 1;
            if (action === "confirm_grounds") payment.grounds_confirmed = 1;
            if (action === "unconfirm_office") payment.office_confirmed = 0;
            if (action === "unconfirm_grounds") payment.grounds_confirmed = 0;

            refreshRowAfterAction(payment);
            succeeded = true;
        } catch (err) {
            console.error("[payments] action error:", err);
            const msg = isAbortError(err)
                ? "Request timed out. The server may be busy \u2014 please try again."
                : friendlyMessage(err, "Action failed.");
            notify(msg, "error");
        } finally {
            if (!succeeded) restore();
        }
    }

    async function confirmDelete(payment, btn) {
        if (btn && btn.dataset.confirming === "1") return;

        const label = payment.reference_number || "#" + payment.payment_id;

        if (btn) btn.dataset.confirming = "1";
        let ok = false;
        try {
            ok = await askConfirm(
                "Delete payment " + label + "? It will be hidden from this list.",
                {
                    title: "Delete payment?",
                    confirmText: "Delete",
                    cancelText: "Cancel",
                    danger: true,
                },
            );
        } finally {
            if (btn) delete btn.dataset.confirming;
        }
        if (!ok) return;

        const restore = enterRowBusy(btn);

        let succeeded = false;
        try {
            const res = await fetchWithTimeout(
                API_URL + "?path_info=" + encodeURIComponent(payment.payment_id),
                {
                    method: "DELETE",
                    credentials: "same-origin",
                    headers: { Accept: "application/json" },
                },
            );

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                throw new Error(
                    (json && (json.message || json.error)) ||
                    "Request failed (HTTP " + res.status + ")",
                );
            }
            notify((json && json.message) || "Payment deleted.", "success");

            const removed = removeRowLocally(payment);

            if (!removed) {
                loadPayments();
            } else if (el.tbody.children.length === 0) {
                // Fall back a page if the last row on this page was removed
                if (state.page > 1) {
                    state.page -= 1;
                    loadPayments();
                } else {
                    showNoData("No records found");
                }
            }

            succeeded = true;
        } catch (err) {
            console.error("[payments] delete error:", err);
            const msg = isAbortError(err)
                ? "Delete request timed out. The server may be busy \u2014 please try again."
                : friendlyMessage(err, "Delete failed.");
            notify(msg, "error");
        } finally {
            if (!succeeded) restore();
        }
    }

    // Search Clear Button
    // Adds a small "x" button inside the search input
    function setupSearchClearButton() {
        const input = el.search;
        if (!input) return;

        const parent = input.parentElement;
        if (!parent) return;

        if (window.getComputedStyle(parent).position === "static") {
            parent.style.position = "relative";
        }

        input.style.paddingRight = "30px";
        input.classList.add("pmSearchInputWithClear");

        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "pmSearchClearBtn";
        clearBtn.setAttribute("aria-label", "Clear search");
        clearBtn.title = "Clear search";
        clearBtn.innerHTML = '<i class="fas fa-times"></i>';

        const updateVisibility = () => {
            if (input.value.length > 0) {
                clearBtn.classList.add("is-visible");
            } else {
                clearBtn.classList.remove("is-visible");
            }
        };

        clearBtn.addEventListener("click", () => {
            input.value = "";
            updateVisibility();

            const hadSearch = state.search !== "";
            state.search = "";
            state.page = 1;
            if (hadSearch) loadPayments();

            input.focus();
        });

        input.addEventListener("input", updateVisibility);

        parent.appendChild(clearBtn);
        updateVisibility();
    }

    // Event Bindings
    let eventsBound = false;

    function bindEvents() {
        if (eventsBound) return;
        eventsBound = true;

        if (el.search) {
            el.search.addEventListener(
                "input",
                debounce((e) => {
                    const v = e.target.value.trim();
                    if (v.length > 0 && v.length < SEARCH_MIN_LEN) return;
                    if (v === state.search) return;
                    state.search = v;
                    state.page = 1;
                    loadPayments();
                }, SEARCH_DEBOUNCE_MS),
            );

            el.search.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    const v = el.search.value.trim();
                    if (v.length > 0 && v.length < SEARCH_MIN_LEN) {
                        notify("Too short to search", "warning");
                        return;
                    }
                    state.search = v;
                    state.page = 1;
                    loadPayments();
                }
            });
        }

        if (el.statusFilter) {
            el.statusFilter.addEventListener("change", () => {
                state.status = el.statusFilter.value || "all";
                state.page = 1;
                loadPayments();
            });
        }

        if (el.filterBtn) {
            el.filterBtn.addEventListener("click", () => {
                if (el.search) {
                    const v = el.search.value.trim();
                    if (v.length > 0 && v.length < SEARCH_MIN_LEN) {
                        notify("Too short to search", "warning");
                        return;
                    }
                    state.search = v;
                }
                if (el.statusFilter) state.status = el.statusFilter.value || "all";
                state.page = 1;
                loadPayments();
            });
        }

        if (el.prevBtn) {
            el.prevBtn.addEventListener("click", () => {
                if (state.page <= 1) return;
                state.page -= 1;
                loadPayments();
            });
        }

        if (el.nextBtn) {
            el.nextBtn.addEventListener("click", () => {
                if (state.page >= state.totalPages) return;
                state.page += 1;
                loadPayments();
            });
        }

        if (el.tbody) {
            // Mark a proof thumbnail as broken when its image fails to load
            el.tbody.addEventListener(
                "error",
                (e) => {
                    const img = e.target;
                    if (!img || img.tagName !== "IMG") return;
                    if (!img.classList.contains("pmProofThumb")) return;
                    const cell = img.closest(".pmProofCell");
                    if (cell) cell.classList.add("is-broken");
                },
                true,
            );

            el.tbody.addEventListener("click", (e) => {
                const proofCell = e.target.closest('[data-action="proof"]');
                if (proofCell && el.tbody.contains(proofCell)) {
                    e.preventDefault();
                    const row = proofCell.closest("tr");
                    if (!row || row.classList.contains("pmRowBusy")) return;
                    const payment = row.__payment;
                    if (!payment) return;
                    openProofModal(payment);
                    return;
                }

                const smsLink = e.target.closest('[data-action="sms"]');
                if (smsLink && el.tbody.contains(smsLink)) {
                    e.preventDefault();
                    const row = smsLink.closest("tr");
                    if (!row || row.classList.contains("pmRowBusy")) return;
                    const payment = row.__payment;
                    if (!payment) return;

                    const phone = (payment.payers_phone_number || "").trim();
                    if (!phone) {
                        notify("This record has no phone number.", "error");
                        return;
                    }
                    openSms(phone, buildVerificationMessage(payment));
                    return;
                }

                const remarkRow = e.target.closest('[data-action="remark"]');
                if (remarkRow && el.tbody.contains(remarkRow)) {
                    e.preventDefault();
                    const row = remarkRow.closest("tr");
                    if (!row || row.classList.contains("pmRowBusy")) return;
                    const payment = row.__payment;
                    if (!payment) return;
                    openRemarksModal(payment, remarkRow.dataset.type || "");
                }
            });

            // Keyboard support [Enter / Space] for the same row actions
            el.tbody.addEventListener("keydown", (e) => {
                if (e.key !== "Enter" && e.key !== " ") return;

                const proofCell = e.target.closest('[data-action="proof"]');
                if (proofCell && el.tbody.contains(proofCell)) {
                    e.preventDefault();
                    const row = proofCell.closest("tr");
                    if (!row || row.classList.contains("pmRowBusy")) return;
                    const payment = row.__payment;
                    if (!payment) return;
                    openProofModal(payment);
                    return;
                }

                const remarkRow = e.target.closest('[data-action="remark"]');
                if (!remarkRow || !el.tbody.contains(remarkRow)) return;
                e.preventDefault();
                const row = remarkRow.closest("tr");
                if (!row || row.classList.contains("pmRowBusy")) return;
                const payment = row.__payment;
                if (!payment) return;
                openRemarksModal(payment, remarkRow.dataset.type || "");
            });
        }
    }

    // Initialization
    function init() {
        if (!el.tbody) {
            console.warn("[payments] table body not found; aborting.");
            return;
        }
        injectStyles();
        hideNoData();
        setupSearchClearButton();
        bindEvents();
        loadPayments();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();