/**
 * Memoria – Payments page controller
 *
 * Loads payment records from api/payments.php (paginated, role-filtered server-side),
 * wires live search + status filter + pagination, performs
 * confirm_office / confirm_grounds / soft-delete actions, opens the shared
 * SMS modal (window.openSmsModal from sms_notification.js) from the contact link,
 * and manages the Office / Grounds remarks via a modal.
 *
 * Payer remark is always view-only. Office and Admin share remarks_office.
 * Only one remark section can be in edit mode at a time.
 *
 * No dummy data. Idempotent event binding. XSS-safe rendering.
 *
 * Order-stability contract:
 *   - Verify actions update the row in place (no reload) so items never jump.
 *   - Delete removes the row locally; a reload is only triggered when the
 *     current page becomes empty and we can step back a page.
 *
 * Busy-state contract:
 *   - While a verify/delete request is in flight, the whole <tr> is inert:
 *     action buttons disabled, remarks cell & SMS link unclickable, row dimmed.
 */
(function () {
    'use strict';

    // ------------------------------------------------------------------ config
    const API_URL = 'api/payments.php';

    const PER_PAGE = 10;
    const SEARCH_MIN_LEN = 3;
    const SEARCH_DEBOUNCE_MS = 350;
    const REMARK_MAX_LEN = 2000;

    // Requests that take longer than this are aborted so a busy / hung
    // backend never leaves a button stuck in the loading state.
    const REQUEST_TIMEOUT_MS = 30000;

    // ------------------------------------------------------------------ state
    const state = {
        page: 1,
        totalPages: 1,
        search: '',
        status: 'all',
        loading: false,
        requestId: 0,
        remarksModal: null,
        editingSection: null,   // section element currently in edit mode, or null
    };

    // ------------------------------------------------------------------ DOM
    const el = {
        search: document.getElementById('payment_search'),
        statusFilter: document.getElementById('status_filter'),
        filterBtn: document.getElementById('filter_btn'),
        tbody: document.getElementById('paymentsTableBody'),
        noData: document.getElementById('burialNoData'),
        currentPage: document.getElementById('current_page_num'),
        totalPages: document.getElementById('total_pages_num'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
    };

    // ------------------------------------------------------------------ helpers
    const escapeHtml = (value) => {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    const formatMoney = (value) => {
        const n = Number(value) || 0;
        try {
            return n.toLocaleString('en-PH', { style: 'currency', currency: 'PHP' });
        } catch (_) {
            return '\u20B1' + n.toFixed(2);
        }
    };

    const debounce = (fn, wait) => {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait);
        };
    };

    const notify = (message, type) => {
        try {
            if (typeof window.showAlertTOP === 'function') { window.showAlertTOP(message, type); return; }
            if (typeof window.showAlert === 'function') { window.showAlert(message, type); return; }
            if (window.Alert && typeof window.Alert.show === 'function') { window.Alert.show(message, type); return; }
            if (window.toast && typeof window.toast.show === 'function') { window.toast.show(message, type); return; }
        } catch (_) { /* fall through */ }
        if (type === 'error') console.error(message);
        else console.log(message);
    };

    /**
     * Promise-based confirm that prefers the shared confirm_ui.js modal
     * and gracefully falls back to native confirm() if it isn't loaded.
     * Always await this — never test it directly.
     */
    async function askConfirm(message, opts) {
        if (typeof window.confirm_ui === 'function') {
            return !!(await window.confirm_ui(message, opts));
        }
        return window.confirm(message);
    }

    /**
     * Fetch wrapper that aborts after `ms` so a slow/busy endpoint cannot
     * leave the UI stuck in a loading state forever.
     */
    async function fetchWithTimeout(url, options, ms) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ms || REQUEST_TIMEOUT_MS);
        try {
            const opts = Object.assign({}, options || {}, { signal: controller.signal });
            return await fetch(url, opts);
        } finally {
            clearTimeout(timeout);
        }
    }

    const isAbortError = (err) => !!(err && err.name === 'AbortError');

    const unwrap = (json) => (json && (json.data !== undefined ? json.data : json)) || {};

    const classifyStatus = (p) => {
        const office = !!p.office_confirmed;
        const grounds = !!p.grounds_confirmed;
        if (office && grounds) return 'completed';
        if (office) return 'pending_grounds';
        return 'pending_office';
    };

    /** Find the <tr> for a payment id, or null. */
    function getRow(paymentId) {
        if (!el.tbody) return null;
        return el.tbody.querySelector(
            'tr[data-payment-id="' + CSS.escape(String(paymentId)) + '"]'
        );
    }

    // ------------------------------------------------------------------ role
    function getUserRole() {
        const candidates = [
            window.currentUser && window.currentUser.role,
            window.userData && window.userData.role,
            window.__USER__ && window.__USER__.role,
            document.body && document.body.dataset && document.body.dataset.userRole,
        ];
        for (let i = 0; i < candidates.length; i++) {
            if (candidates[i]) return String(candidates[i]).toLowerCase();
        }
        return '';
    }

    const canEditRemark = (type) => {
        const role = getUserRole();
        const unknown = role === '';
        if (type === 'payer') return false;
        if (type === 'office') return unknown || role.includes('admin') || role.includes('office');
        if (type === 'grounds') return unknown || role.includes('admin') || role.includes('grounds');
        return false;
    };

    // ------------------------------------------------------------------ remarks helpers
    const remarkTypes = ['payer', 'office', 'grounds'];

    const remarkField = (type) => 'remarks_' + type;

    const readRemark = (payment, type) => {
        const v = payment && payment[remarkField(type)];
        if (v === null || v === undefined) return '';
        return String(v);
    };

    const truncate = (text, max) => {
        const s = String(text || '');
        if (s.length <= max) return s;
        return s.slice(0, max - 1) + '\u2026';
    };

    const remarkIconFor = (type) => (type === 'payer' ? 'fas fa-lock' : 'fas fa-pen');

    const remarkLabelFor = (type) => type.charAt(0).toUpperCase() + type.slice(1);

    // ------------------------------------------------------------------ message
    const buildVerificationMessage = (p) => {
        const name = (p.payers_name || p.deceased_name || 'valued client').trim();
        const ref = (p.reference_number || '').trim();
        return 'Hello ' + name + ', your payment with the reference number: ' + ref + ' is now verified.';
    };

    const openSms = (phone, message) => {
        if (typeof window.openSmsModal === 'function') {
            window.openSmsModal(phone, message);
            return;
        }
        if (!phone) {
            notify('No phone number available for this record.', 'error');
            return;
        }
        const url = 'sms:' + encodeURIComponent(phone) + '&body=' + encodeURIComponent(message || '');
        try { window.location.href = url; } catch (_) { }
    };

    // ------------------------------------------------------------------ busy state

    /**
     * Puts the row containing `btn` into a "busy" state:
     *   - row gets `pmRowBusy`, `inert`, and `aria-busy="true"`
     *   - every action button in that row is disabled
     *   - the clicked button shows a spinner
     *   - the row is dimmed and gets `cursor: progress`
     *
     * While busy, clicks on the remarks cell and the SMS link are blocked
     * (via CSS `pointer-events:none` on those children, plus delegation
     * guards in the row handlers). Keyboard activation is blocked by
     * `inert` and the same delegation guards.
     *
     * Returns a `restore()` function that undoes all of the above.
     * Callers should invoke `restore()` only on the failure path; on
     * success the row is either refreshed in place (verify) or removed
     * (delete), so restore is unnecessary.
     */
    function enterRowBusy(btn) {
        if (!btn) return function noop() {};

        const row = btn.closest('tr');
        const group = btn.closest('.pmActionGroup');

        if (row) {
            row.classList.add('pmRowBusy');
            row.setAttribute('inert', '');
            row.setAttribute('aria-busy', 'true');
        }

        // Fallback: no action group — just busy-state the single button.
        if (!group) {
            const originalHtml = btn.innerHTML;
            const wasDisabled = btn.disabled;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            return function restore() {
                btn.innerHTML = originalHtml;
                btn.disabled = wasDisabled;
                if (row) {
                    row.classList.remove('pmRowBusy');
                    row.removeAttribute('inert');
                    row.removeAttribute('aria-busy');
                }
            };
        }

        const buttons = Array.from(group.querySelectorAll('button'));
        const snapshot = buttons.map((b) => ({ html: b.innerHTML, disabled: b.disabled }));

        buttons.forEach((b) => { b.disabled = true; });
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        return function restore() {
            buttons.forEach((b, i) => {
                const snap = snapshot[i];
                if (!snap) return;
                b.innerHTML = snap.html;
                b.disabled = snap.disabled;
            });
            if (row) {
                row.classList.remove('pmRowBusy');
                row.removeAttribute('inert');
                row.removeAttribute('aria-busy');
            }
        };
    }

    /**
     * Clears the busy visual state from a row without touching button HTML
     * (used when we're about to replace the action cell entirely anyway).
     */
    function clearRowBusy(row) {
        if (!row) return;
        row.classList.remove('pmRowBusy');
        row.removeAttribute('inert');
        row.removeAttribute('aria-busy');
    }

    // ------------------------------------------------------------------ styles
    function injectStyles() {
        if (document.getElementById('paymentsActionStyles')) return;
        const style = document.createElement('style');
        style.id = 'paymentsActionStyles';
        style.textContent = `
            /* ============================================================
               Status badges
               ============================================================ */
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

            /* ============================================================
               Action column
               ============================================================ */
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

            /* ============================================================
               Row-busy state (verify / delete in flight)
               ============================================================ */
            .paymentsTable tr.pmRowBusy {
                opacity: 0.55;
                cursor: progress;
                user-select: none;
                transition: opacity 0.15s ease;
            }
            .paymentsTable tr.pmRowBusy .pmActionGroup,
            .paymentsTable tr.pmRowBusy .pmRemarksCell,
            .paymentsTable tr.pmRowBusy .smsPhoneLink {
                pointer-events: none;
            }
            .paymentsTable tr.pmRowBusy .pmActionBtn {
                cursor: progress;
            }

            /* ============================================================
               Verified pill
               ============================================================ */
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

            /* ============================================================
               Remarks column — compact structured preview
               ============================================================ */
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

            /* ============================================================
               Remarks modal
               ============================================================ */
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

            /* [hidden] must always win — otherwise display:flex on
               .pmRemarkEditActions overrides the hidden attribute and
               Cancel/Save stay visible in read-only mode. */
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
        `;
        document.head.appendChild(style);
    }

    // ------------------------------------------------------------------ render
    function showNoData(message) {
        if (!el.noData) return;
        el.noData.hidden = false;
        el.noData.style.display = '';
        el.noData.innerHTML = '<i class="fas fa-inbox"></i> ' + escapeHtml(message || 'No records found');
    }

    function hideNoData() {
        if (!el.noData) return;
        el.noData.hidden = true;
        el.noData.style.display = 'none';
    }

    function renderLoading() {
        hideNoData();
        el.tbody.innerHTML =
            '<tr><td colspan="12" style="text-align:center;padding:24px;opacity:.75;">'
            + '<i class="fas fa-spinner fa-spin"></i> Loading payments\u2026'
            + '</td></tr>';
    }

    function renderError(message) {
        el.tbody.innerHTML = '';
        showNoData(message || 'Failed to load payment records.');
    }

    function buildStatusBadge(p) {
        const key = classifyStatus(p);
        if (key === 'completed') {
            return '<span class="pmStatusBadge pmStatus--completed">'
                + '<i class="fas fa-circle-check"></i>Completed</span>';
        }
        if (key === 'pending_grounds') {
            return '<span class="pmStatusBadge pmStatus--pendingGrounds">'
                + '<i class="fas fa-clock"></i>Pending \u2013 Grounds</span>';
        }
        return '<span class="pmStatusBadge pmStatus--pendingOffice">'
            + '<i class="fas fa-clock"></i>Pending \u2013 Office</span>';
    }

    function buildRemarksCell(p) {
        const rows = remarkTypes.map((type) => {
            const value = readRemark(p, type);
            const empty = value.trim() === '';
            const preview = empty ? '-' : truncate(value, 60);

            const cls = 'pmRemarkRow is-' + type
                + (empty ? ' is-empty' : '')
                + (type === 'payer' ? ' is-readonly' : '');

            return ''
                + '<div class="' + cls + '"'
                + ' data-action="remark"'
                + ' data-type="' + type + '"'
                + ' role="button" tabindex="0"'
                + ' title="View ' + escapeHtml(remarkLabelFor(type)) + ' remark">'
                + '<span class="pmRemarkLabel">' + escapeHtml(remarkLabelFor(type)) + '</span>'
                + '<span class="pmRemarkPreview' + (empty ? ' is-empty' : '') + '">'
                + escapeHtml(preview)
                + '</span>'
                + '</div>';
        }).join('');

        return '<div class="pmRemarksCell" data-payment-id="' + escapeHtml(p.payment_id) + '">'
            + rows
            + '</div>';
    }

    function buildProofCell(p) {
        if (!p.image_link) return '<span style="opacity:.55;">\u2014</span>';
        const url = escapeHtml(p.image_link);
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" title="Open proof">'
            + '<img src="' + url + '" alt="Proof of payment" '
            + 'style="max-width:60px;max-height:60px;border-radius:4px;object-fit:cover;display:block;">'
            + '</a>';
    }

    function buildPhoneCell(p) {
        const phoneRaw = (p.payers_phone_number || '').trim();
        if (!phoneRaw) return '<span style="opacity:.55;">\u2014</span>';

        const phone = escapeHtml(phoneRaw);
        return '<a href="#"'
            + ' class="smsPhoneLink"'
            + ' data-action="sms"'
            + ' data-payment-id="' + escapeHtml(p.payment_id) + '"'
            + ' title="Send SMS notification">'
            + phone
            + '</a>';
    }

    function makeIconBtn(iconClass, className, handler, title) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pmActionBtn ' + (className || '');
        btn.title = title || '';
        btn.setAttribute('aria-label', title || '');
        btn.innerHTML = '<i class="' + iconClass + '"></i>';
        btn.addEventListener('click', handler);
        return btn;
    }

    function buildActionsCell(p) {
        const wrap = document.createElement('div');
        wrap.className = 'pmActionGroup';

        const key = classifyStatus(p);

        if (key === 'completed') {
            const pill = document.createElement('span');
            pill.className = 'pmVerifiedPill';
            pill.title = 'Payment fully verified';
            pill.innerHTML = '<i class="fas fa-circle-check"></i><span>Verified</span>';
            wrap.appendChild(pill);
        } else if (key === 'pending_grounds') {
            wrap.appendChild(makeIconBtn(
                'fas fa-check',
                'pmActionBtn--verify',
                (ev) => runAction(p, 'confirm_grounds', ev.currentTarget),
                'Verify \u2014 mark grounds work as completed'
            ));
        } else {
            wrap.appendChild(makeIconBtn(
                'fas fa-check',
                'pmActionBtn--verify',
                (ev) => runAction(p, 'confirm_office', ev.currentTarget),
                'Verify \u2014 confirm payment received by office'
            ));
        }

        wrap.appendChild(makeIconBtn(
            'fas fa-trash',
            'pmActionBtn--delete',
            (ev) => confirmDelete(p, ev.currentTarget),
            'Delete payment record'
        ));

        return wrap;
    }

    function renderRows(payments) {
        el.tbody.innerHTML = '';

        if (!Array.isArray(payments) || payments.length === 0) {
            showNoData('No records found');
            return;
        }
        hideNoData();

        const frag = document.createDocumentFragment();
        payments.forEach((p) => {
            const tr = document.createElement('tr');
            tr.dataset.paymentId = p.payment_id;

            tr.innerHTML =
                '<td>' + escapeHtml(p.deceased_name || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.payers_name || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.payment_channel || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.reference_number || '\u2014') + '</td>' +
                '<td>' + formatMoney(p.amount) + '</td>' +
                '<td>' + buildPhoneCell(p) + '</td>' +
                '<td>' + escapeHtml(p.payers_email || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.purpose || '\u2014') + '</td>' +
                '<td>' + buildProofCell(p) + '</td>' +
                '<td>' + buildRemarksCell(p) + '</td>' +
                '<td>' + buildStatusBadge(p) + '</td>';

            const actionCell = document.createElement('td');
            actionCell.appendChild(buildActionsCell(p));
            tr.appendChild(actionCell);

            tr.__payment = p;

            frag.appendChild(tr);
        });

        el.tbody.appendChild(frag);
    }

    function renderPagination(pagination) {
        const total = Math.max(1, Number(pagination.total_pages) || 1);
        const current = Math.min(Math.max(1, Number(pagination.current_page) || 1), total);

        state.totalPages = total;
        state.page = current;

        if (el.currentPage) el.currentPage.textContent = String(current);
        if (el.totalPages) el.totalPages.textContent = String(total);

        if (el.prevBtn) el.prevBtn.disabled = current <= 1;
        if (el.nextBtn) el.nextBtn.disabled = current >= total;

        if (!el.carouselTrack) return;
        el.carouselTrack.innerHTML = '';

        const WINDOW = 5;
        let start = Math.max(1, current - Math.floor(WINDOW / 2));
        let end = Math.min(total, start + WINDOW - 1);
        start = Math.max(1, end - WINDOW + 1);

        for (let i = start; i <= end; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pageNavBtn' + (i === current ? ' active' : '');
            btn.textContent = String(i);
            if (i === current) btn.setAttribute('aria-current', 'page');
            btn.addEventListener('click', () => {
                if (i === state.page) return;
                state.page = i;
                loadPayments();
            });
            el.carouselTrack.appendChild(btn);
        }
    }

    // ------------------------------------------------------------------ in-place row updates

    /**
     * Refresh the status + action cells of an existing row without
     * rebuilding the whole tbody. Used after a successful verify so the
     * row keeps its exact position in the list.
     */
    function refreshRowAfterAction(payment) {
        const row = getRow(payment.payment_id);
        if (!row) return;
        row.__payment = payment;

        const cells = row.querySelectorAll('td');
        if (!cells.length) return;

        // status cell is second-to-last
        const statusCell = cells[cells.length - 2];
        if (statusCell) statusCell.innerHTML = buildStatusBadge(payment);

        // action cell is last
        const actionCell = cells[cells.length - 1];
        if (actionCell) {
            actionCell.innerHTML = '';
            actionCell.appendChild(buildActionsCell(payment));
        }

        clearRowBusy(row);
    }

    function refreshRowRemarks(payment) {
        const row = getRow(payment.payment_id);
        if (!row) return;
        const cells = row.querySelectorAll('td');
        const remarkCell = cells[cells.length - 3];
        if (remarkCell) remarkCell.innerHTML = buildRemarksCell(payment);
        row.__payment = payment;
    }

    /**
     * Remove a row from the DOM without re-fetching.
     * Returns true if the row was found and removed.
     */
    function removeRowLocally(payment) {
        const row = getRow(payment.payment_id);
        if (!row) return false;
        row.remove();
        return true;
    }

    // ------------------------------------------------------------------ remarks modal
    function closeRemarksModal() {
        const modal = state.remarksModal;
        if (!modal) return;
        modal.backdrop.classList.remove('pmVisible');
        setTimeout(() => {
            if (modal.backdrop.parentNode) modal.backdrop.parentNode.removeChild(modal.backdrop);
            if (state.remarksModal === modal) state.remarksModal = null;
        }, 200);
        document.removeEventListener('keydown', modal.onKey, false);
        state.editingSection = null;
    }

    /** Close the currently open editor, if any, without saving. */
    function closeActiveEditor() {
        const section = state.editingSection;
        if (!section) return;
        if (typeof section.__endEdit === 'function') section.__endEdit();
    }

    function buildRemarkSection(payment, type, options) {
        const opts = options || {};
        const isPayer = (type === 'payer');
        const canEdit = !isPayer && canEditRemark(type);
        const value = readRemark(payment, type);
        const empty = value.trim() === '';

        const section = document.createElement('section');
        section.className = 'pmRemarkSection is-' + type;
        section.dataset.type = type;

        // --- header
        const header = document.createElement('div');
        header.className = 'pmRemarkSectionHeader';

        const label = document.createElement('span');
        label.className = 'pmRemarkSectionLabel';
        label.textContent = remarkLabelFor(type);
        header.appendChild(label);

        let editBtn = null;
        if (canEdit) {
            editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'pmRemarkEditBtn';
            editBtn.title = 'Edit ' + remarkLabelFor(type) + ' remark';
            editBtn.setAttribute('aria-label', editBtn.title);
            editBtn.innerHTML = '<i class="fas fa-pen"></i>';
            editBtn.addEventListener('click', () => beginEdit());
            header.appendChild(editBtn);
        }

        section.appendChild(header);

        // --- view (always rendered in read-only mode)
        const view = document.createElement('div');
        view.className = 'pmRemarkSectionValue' + (empty ? ' is-empty' : '');
        view.textContent = empty ? '-' : value;
        section.appendChild(view);

        // Payer is permanently read-only — no edit controls at all.
        if (!canEdit) return section;

        // --- edit UI (initially hidden; revealed only in edit mode)
        const textarea = document.createElement('textarea');
        textarea.className = 'pmRemarkTextarea';
        textarea.maxLength = REMARK_MAX_LEN;
        textarea.placeholder = 'Enter ' + type + ' remark\u2026';
        textarea.hidden = true;
        section.appendChild(textarea);

        const actions = document.createElement('div');
        actions.className = 'pmRemarkEditActions';
        actions.hidden = true;

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'pmRemarkBtn pmRemarkBtn--ghost';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => endEdit());

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'pmRemarkBtn pmRemarkBtn--primary';
        saveBtn.textContent = 'Save';

        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        section.appendChild(actions);

        // --- edit lifecycle
        let original = value;

        function beginEdit() {
            // Close any other section that is currently editing.
            if (state.editingSection && state.editingSection !== section) {
                closeActiveEditor();
            }

            original = readRemark(payment, type);
            textarea.value = original;

            view.hidden = true;
            textarea.hidden = false;
            actions.hidden = false;
            section.classList.add('is-editing');
            if (editBtn) editBtn.style.display = 'none';

            state.editingSection = section;
            section.__endEdit = endEdit;   // allow the manager to cancel it

            textarea.focus();
            try { textarea.setSelectionRange(textarea.value.length, textarea.value.length); } catch (_) { }
        }

        function endEdit() {
            // Restore the read-only UI.
            view.hidden = false;
            textarea.hidden = true;
            actions.hidden = true;
            section.classList.remove('is-editing');
            if (editBtn) editBtn.style.display = '';

            // Discard the user's unsaved edits — value stays whatever was last saved.
            textarea.value = original;
            view.textContent = original.trim() === '' ? '-' : original;
            view.classList.toggle('is-empty', original.trim() === '');

            if (state.editingSection === section) {
                state.editingSection = null;
                delete section.__endEdit;
            }
        }

        saveBtn.addEventListener('click', async () => {
            const newValue = textarea.value;

            // No-op save → just close.
            if (newValue === original) { endEdit(); return; }

            // Basic validation.
            if (newValue.length > REMARK_MAX_LEN) {
                notify('Remark is too long (max ' + REMARK_MAX_LEN + ' characters).', 'error');
                textarea.focus();
                return;
            }

            saveBtn.disabled = true;
            cancelBtn.disabled = true;
            const prevLabel = saveBtn.textContent;
            saveBtn.textContent = 'Saving\u2026';

            const ok = await saveRemark(payment, type, newValue);

            saveBtn.disabled = false;
            cancelBtn.disabled = false;
            saveBtn.textContent = prevLabel;

            // On failure: keep the section in edit mode with the user's input intact.
            if (!ok) return;

            // On success: update view in place, then return to read-only mode.
            const current = readRemark(payment, type);
            const isNowEmpty = current.trim() === '';
            view.textContent = isNowEmpty ? '-' : current;
            view.classList.toggle('is-empty', isNowEmpty);
            original = current;

            refreshRowRemarks(payment);
            endEdit();
        });

        if (opts.focus) {
            setTimeout(() => {
                try { beginEdit(); } catch (_) { }
            }, 80);
        }

        return section;
    }

    function openRemarksModal(payment, focusType) {
        if (!payment) return;
        closeRemarksModal();

        const backdrop = document.createElement('div');
        backdrop.className = 'pmRemarksBackdrop';
        backdrop.setAttribute('role', 'dialog');
        backdrop.setAttribute('aria-modal', 'true');
        backdrop.setAttribute('aria-labelledby', 'pmRemarksTitle');

        const card = document.createElement('div');
        card.className = 'pmRemarksCard';
        backdrop.appendChild(card);

        const header = document.createElement('div');
        header.className = 'pmRemarksHeader';
        header.innerHTML =
            '<h3 class="pmRemarksTitle" id="pmRemarksTitle">'
            + '<span>Payment Remarks</span>'
            + '</h3>';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'pmRemarksClose';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = '<i class="fas fa-times"></i>';
        closeBtn.addEventListener('click', closeRemarksModal);
        header.appendChild(closeBtn);
        card.appendChild(header);

        const body = document.createElement('div');
        body.className = 'pmRemarksBody';

        remarkTypes.forEach((type) => {
            body.appendChild(buildRemarkSection(payment, type, {
                focus: type === focusType,
            }));
        });

        card.appendChild(body);

        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) closeRemarksModal();
        });

        const onKey = (e) => {
            if (e.key === 'Escape') {
                // If an editor is open, Escape cancels it first.
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
        requestAnimationFrame(() => backdrop.classList.add('pmVisible'));

        state.remarksModal = { backdrop, card, onKey };
        document.addEventListener('keydown', onKey, false);

        setTimeout(() => {
            try { closeBtn.focus({ preventScroll: true }); } catch (_) { closeBtn.focus(); }
        }, 60);
    }

    // ------------------------------------------------------------------ network
    function buildQuery() {
        const params = new URLSearchParams();
        params.set('page', String(state.page));
        params.set('limit', String(PER_PAGE));

        if (state.search && state.search.length >= SEARCH_MIN_LEN) {
            params.set('search_term', state.search);
        }
        if (state.status && state.status !== 'all') {
            params.set('status', state.status);
        }
        return params.toString();
    }

    async function loadPayments() {
        const reqId = ++state.requestId;
        state.loading = true;
        renderLoading();

        try {
            const res = await fetchWithTimeout(API_URL + '?' + buildQuery(), {
                method: 'GET',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' },
            });

            const json = await res.json().catch(() => null);

            if (!res.ok || (json && json.success === false)) {
                const msg = (json && (json.message || json.error))
                    || ('Request failed (HTTP ' + res.status + ')');
                throw new Error(msg);
            }
            if (reqId !== state.requestId) return;

            const payload = unwrap(json);
            renderRows(payload.payments);
            renderPagination(payload.pagination || { total_pages: 1, current_page: 1 });
        } catch (err) {
            if (reqId !== state.requestId) return;
            console.error('[payments] load error:', err);
            const msg = isAbortError(err)
                ? 'Loading payments timed out. Please try again.'
                : (err.message || 'Unable to load payment records.');
            renderError(msg);
        } finally {
            if (reqId === state.requestId) state.loading = false;
        }
    }

    async function saveRemark(payment, type, value) {
        try {
            const res = await fetchWithTimeout(API_URL + '?path_info=' + encodeURIComponent(payment.payment_id), {
                method: 'PUT',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    action: 'edit_remark',
                    remark_type: type,
                    remark_value: value,
                }),
            });

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                throw new Error((json && (json.message || json.error))
                    || ('Request failed (HTTP ' + res.status + ')'));
            }

            const key = remarkField(type);
            const v = (value || '').trim();
            payment[key] = v === '' ? null : v;

            notify((json && json.message) || (remarkLabelFor(type) + ' remark saved.'), 'success');
            return true;
        } catch (err) {
            console.error('[payments] save remark error:', err);
            const msg = isAbortError(err)
                ? 'Saving remark timed out. Please try again.'
                : (err.message || 'Failed to save remark.');
            notify(msg, 'error');
            return false;
        }
    }

    async function runAction(payment, action, btn) {
        // Guard against double-open of the confirm modal (e.g. fast double-click).
        if (btn && btn.dataset.confirming === '1') return;

        const prompts = {
            confirm_office: {
                message: 'Confirm this payment was received by the office?',
                title: 'Confirm office receipt?',
                confirmText: 'Confirm',
            },
            confirm_grounds: {
                message: 'Mark the grounds work as completed for this payment?',
                title: 'Mark grounds as completed?',
                confirmText: 'Confirm',
            },
        };

        const cfg = prompts[action] || {
            message: 'Proceed?',
            title: 'Confirm action?',
            confirmText: 'Confirm',
        };

        if (btn) btn.dataset.confirming = '1';
        let ok = false;
        try {
            ok = await askConfirm(cfg.message, {
                title: cfg.title,
                confirmText: cfg.confirmText,
                cancelText: 'Cancel',
            });
        } finally {
            if (btn) delete btn.dataset.confirming;
        }
        if (!ok) return;

        // Enter loading state BEFORE the request so the user sees feedback
        // while the endpoint is being hit.
        const restore = enterRowBusy(btn);

        let succeeded = false;
        try {
            const res = await fetchWithTimeout(API_URL + '?path_info=' + encodeURIComponent(payment.payment_id), {
                method: 'PUT',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ action: action }),
            });

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                throw new Error((json && (json.message || json.error))
                    || ('Request failed (HTTP ' + res.status + ')'));
            }
            notify((json && json.message) || 'Action completed.', 'success');

            // ---- No-reload local update --------------------------------
            // Mutate the payment object optimistically and re-render only
            // this row's status + action cells. The row keeps its exact
            // position, so no re-ordering can happen.
            if (action === 'confirm_office') payment.office_confirmed = 1;
            if (action === 'confirm_grounds') payment.grounds_confirmed = 1;

            refreshRowAfterAction(payment);
            succeeded = true;
        } catch (err) {
            console.error('[payments] action error:', err);
            const msg = isAbortError(err)
                ? 'Request timed out. The server may be busy \u2014 please try again.'
                : (err.message || 'Action failed.');
            notify(msg, 'error');
        } finally {
            if (!succeeded) restore();
        }
    }

    async function confirmDelete(payment, btn) {
        // Guard against double-open of the confirm modal (e.g. fast double-click).
        if (btn && btn.dataset.confirming === '1') return;

        const label = payment.reference_number || ('#' + payment.payment_id);

        if (btn) btn.dataset.confirming = '1';
        let ok = false;
        try {
            ok = await askConfirm(
                'Delete payment ' + label + '? It will be hidden from this list.',
                {
                    title: 'Delete payment?',
                    confirmText: 'Delete',
                    cancelText: 'Cancel',
                    danger: true,
                }
            );
        } finally {
            if (btn) delete btn.dataset.confirming;
        }
        if (!ok) return;

        // Enter loading state BEFORE the request so the user sees feedback
        // (spinner on the delete button + dimmed, inert row) while the
        // DELETE runs.
        const restore = enterRowBusy(btn);

        let succeeded = false;
        try {
            const res = await fetchWithTimeout(API_URL + '?path_info=' + encodeURIComponent(payment.payment_id), {
                method: 'DELETE',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' },
            });

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                throw new Error((json && (json.message || json.error))
                    || ('Request failed (HTTP ' + res.status + ')'));
            }
            notify((json && json.message) || 'Payment deleted.', 'success');

            // ---- No-reload local removal -------------------------------
            // Remove the row directly instead of re-fetching, so the
            // remaining rows keep their exact order.
            const removed = removeRowLocally(payment);

            if (!removed) {
                // Unexpected: row wasn't in the DOM. Fall back to a full
                // reload so the list isn't left showing a phantom entry.
                loadPayments();
            } else if (el.tbody.children.length === 0) {
                // The page is now empty.
                if (state.page > 1) {
                    // Step back a page — this is the only situation where
                    // a re-fetch is unavoidable. The previous page has
                    // already been seen, so its order is stable.
                    state.page -= 1;
                    loadPayments();
                } else {
                    showNoData('No records found');
                }
            }
            // Otherwise: leave the page slightly under-filled. The next
            // navigation will fetch the correct slice from the server.

            succeeded = true;
        } catch (err) {
            console.error('[payments] delete error:', err);
            const msg = isAbortError(err)
                ? 'Delete request timed out. The server may be busy \u2014 please try again.'
                : (err.message || 'Delete failed.');
            notify(msg, 'error');
        } finally {
            if (!succeeded) restore();
        }
    }

    // ------------------------------------------------------------------ events
    let eventsBound = false;

    function bindEvents() {
        if (eventsBound) return;
        eventsBound = true;

        if (el.search) {
            el.search.addEventListener('input', debounce((e) => {
                const v = e.target.value.trim();
                if (v.length > 0 && v.length < SEARCH_MIN_LEN) return;
                if (v === state.search) return;
                state.search = v;
                state.page = 1;
                loadPayments();
            }, SEARCH_DEBOUNCE_MS));

            el.search.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = el.search.value.trim();
                    if (v.length > 0 && v.length < SEARCH_MIN_LEN) return;
                    state.search = v;
                    state.page = 1;
                    loadPayments();
                }
            });
        }

        if (el.statusFilter) {
            el.statusFilter.addEventListener('change', () => {
                state.status = el.statusFilter.value || 'all';
                state.page = 1;
                loadPayments();
            });
        }

        if (el.filterBtn) {
            el.filterBtn.addEventListener('click', () => {
                if (el.search) state.search = el.search.value.trim();
                if (el.statusFilter) state.status = el.statusFilter.value || 'all';
                state.page = 1;
                loadPayments();
            });
        }

        if (el.prevBtn) {
            el.prevBtn.addEventListener('click', () => {
                if (state.page <= 1) return;
                state.page -= 1;
                loadPayments();
            });
        }

        if (el.nextBtn) {
            el.nextBtn.addEventListener('click', () => {
                if (state.page >= state.totalPages) return;
                state.page += 1;
                loadPayments();
            });
        }

        if (el.tbody) {
            el.tbody.addEventListener('click', (e) => {
                const smsLink = e.target.closest('[data-action="sms"]');
                if (smsLink && el.tbody.contains(smsLink)) {
                    e.preventDefault();
                    const row = smsLink.closest('tr');
                    // Block interactions while the row is busy.
                    if (!row || row.classList.contains('pmRowBusy')) return;
                    const payment = row.__payment;
                    if (!payment) return;

                    const phone = (payment.payers_phone_number || '').trim();
                    if (!phone) {
                        notify('This record has no phone number.', 'error');
                        return;
                    }
                    openSms(phone, buildVerificationMessage(payment));
                    return;
                }

                const remarkRow = e.target.closest('[data-action="remark"]');
                if (remarkRow && el.tbody.contains(remarkRow)) {
                    e.preventDefault();
                    const row = remarkRow.closest('tr');
                    // Block interactions while the row is busy.
                    if (!row || row.classList.contains('pmRowBusy')) return;
                    const payment = row.__payment;
                    if (!payment) return;
                    openRemarksModal(payment, remarkRow.dataset.type || '');
                }
            });

            el.tbody.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const remarkRow = e.target.closest('[data-action="remark"]');
                if (!remarkRow || !el.tbody.contains(remarkRow)) return;
                e.preventDefault();
                const row = remarkRow.closest('tr');
                // Block keyboard activation while the row is busy.
                if (!row || row.classList.contains('pmRowBusy')) return;
                const payment = row.__payment;
                if (!payment) return;
                openRemarksModal(payment, remarkRow.dataset.type || '');
            });
        }
    }

    // ------------------------------------------------------------------ init
    function init() {
        if (!el.tbody) {
            console.warn('[payments] table body not found; aborting.');
            return;
        }
        injectStyles();
        hideNoData();
        bindEvents();
        loadPayments();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();