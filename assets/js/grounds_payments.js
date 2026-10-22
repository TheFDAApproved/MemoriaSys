/**
 * grounds-payments.js
 *
 * Grounds Staff view of the Payments page.
 *
 * Same table layout, columns, search, pagination, and status badges as the
 * Admin/Office page. The only functional differences are:
 *
 *   Tab 1 — pending_grounds  → Confirm button (action: "confirm_grounds")
 *   Tab 2 — pending_office   → Read-only (payment is still with office)
 *   Tab 3 — verified         → Read-only (shows a "Verified" pill)
 *
 * Grounds staff may additionally edit the "grounds" remark for any row.
 * The backend (payments.php → edit_remark) enforces:
 *   grounds remark → ROLE_ADMIN, ROLE_GROUNDS
 *   office remark  → ROLE_ADMIN, ROLE_OFFICE
 *   payer remark   → read-only
 *
 * Endpoints:
 *   GET  api/payments.php?status=<pending_office|pending_grounds|verified>
 *   PUT  api/payments.php?path_info=<id>  { action: "confirm_grounds" }
 *   PUT  api/payments.php?path_info=<id>  { action: "edit_remark", remark_type, remark_value }
 */
(() => {
    'use strict';

    // ------------------------------------------------------------------ config
    const API_URL = 'api/payments.php';
    const PER_PAGE = 10;
    const SEARCH_MIN_LEN = 3;
    const SEARCH_DEBOUNCE_MS = 350;
    const REQUEST_TIMEOUT_MS = 30000;
    const REMARK_MAX_LEN = 2000;

    const SEARCH_PLACEHOLDER = 'Search...';

    const TABS = {
        pending_grounds: {
            key: 'pending_grounds',
            status: 'pending_grounds',
            confirmAction: 'confirm_grounds',
            canConfirm: true,
            roleCheck: roleIsGrounds,
            confirmPrompt: {
                title: 'Confirm Grounds Completion?',
                message:
                    'Mark the grounds work for this payment as completed? ' +
                    'It will move to "Completed Payments".',
                confirmText: 'Confirm',
            },
        },
        pending_office: {
            key: 'pending_office',
            status: 'pending_office',
            canConfirm: false,
        },
        verified: {
            key: 'verified',
            status: 'verified',
            canConfirm: false,
        },
    };

    // ------------------------------------------------------------------ state
    const state = {
        activeTab: 'pending_grounds',
        page: 1,
        totalPages: 1,
        totalRecords: 0,
        search: '',
        loading: false,
        requestId: 0,
        remarksModal: null,
        editingSection: null,
    };

    // ------------------------------------------------------------------ DOM
    const el = {
        tabButtons: document.querySelectorAll('.subnavBtn[data-tab]'),
        search: document.getElementById('payment_search'),
        tbody: document.getElementById('payments_tbody'),
        noData: document.getElementById('no_data'),
        tableWrapper: document.getElementById('table_wrapper'),
        currentPage: document.getElementById('current_page_num'),
        totalPages: document.getElementById('total_pages_num'),
        totalRecords: document.getElementById('total_records'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
    };

    if (!el.tbody) {
        console.warn('[grounds-payments] tbody missing; aborting.');
        return;
    }

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

    const truncate = (text, max) => {
        const s = String(text || '');
        if (s.length <= max) return s;
        return s.slice(0, max - 1) + '\u2026';
    };

    const GENERIC_ERROR = 'Something went wrong. Please try again.';

    const looksRawMessage = (text) => {
        if (!text) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;
        if (/ERR_NGROK_|ngrok/i.test(t)) return true;
        if (/^HTTP\s+\d{3}/i.test(t)) return true;
        if (/^Request failed \(\d{3}\)$/i.test(t)) return true;
        if (/non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(t)) return true;
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
        if (/^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(t)) return true;
        if (t.length > 200) return true;
        return false;
    };

    const friendlyMessage = (err, fallback) => {
        if (!err) return fallback || GENERIC_ERROR;
        const msg = (err && err.message) ? String(err.message).trim() : String(err).trim();
        if (!msg || looksRawMessage(msg)) return fallback || GENERIC_ERROR;
        return msg;
    };

    const notify = (message, type) => {
        try {
            if (typeof window.showAlertTOP === 'function') {
                window.showAlertTOP(message, type);
                return;
            }
        } catch (_) { /* ignore */ }
        if (type === 'error') console.error(message);
        else console.log(message);
    };

    const debounce = (fn, wait) => {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait);
        };
    };

    const isAbortError = (err) => !!(err && err.name === 'AbortError');
    const unwrap = (json) => (json && (json.data !== undefined ? json.data : json)) || {};

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

    async function askConfirm(message, opts) {
        if (typeof window.confirm_ui === 'function') {
            return !!(await window.confirm_ui(message, opts));
        }
        return window.confirm(message);
    }

    // ------------------------------------------------------------------ role
    function getUserRole() {
        const candidates = [
            window.currentUser && window.currentUser.role,
            window.userData && window.userData.role,
            window.__USER__ && window.__USER__.role,
            document.body && document.body.dataset && document.body.dataset.userRole,
            document.documentElement && document.documentElement.dataset && document.documentElement.dataset.userRole,
        ];
        for (let i = 0; i < candidates.length; i++) {
            if (candidates[i]) return String(candidates[i]).toLowerCase();
        }
        return '';
    }

    function roleIsGrounds() {
        const role = getUserRole();
        if (!role) return true;   // unknown → optimistic; backend enforces
        return role.includes('grounds');
    }

    function currentTabCanConfirm() {
        const tabCfg = TABS[state.activeTab];
        if (!tabCfg || !tabCfg.canConfirm) return false;
        try {
            return !!tabCfg.roleCheck();
        } catch (_) {
            return false;
        }
    }

    /** Grounds can edit only their own remark; office/admin/payer are read-only. */
    function canEditRemark(type) {
        if (type !== 'grounds') return false;
        const role = getUserRole();
        if (!role) return true; // unknown → optimistic; backend enforces
        return role.includes('grounds');
    }

    // ------------------------------------------------------------------ status
    function classifyStatus(p) {
        const office = !!p.office_confirmed;
        const grounds = !!p.grounds_confirmed;
        if (office && grounds) return 'completed';
        if (office) return 'pending_grounds';
        return 'pending_office';
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

    // ------------------------------------------------------------------ cells
    const remarkTypes = ['payer', 'office', 'grounds'];
    const remarkField = (type) => 'remarks_' + type;
    const remarkLabelFor = (type) => type.charAt(0).toUpperCase() + type.slice(1);

    const readRemark = (payment, type) => {
        const v = payment && payment[remarkField(type)];
        if (v === null || v === undefined) return '';
        return String(v);
    };

    function buildProofCell(p) {
        if (!p.image_link) return '<span class="muted">\u2014</span>';
        const url = escapeHtml(p.image_link);
        return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" '
            + 'class="proofLink" title="Open proof of payment">'
            + '<img src="' + url + '" alt="Proof" class="proofThumb">'
            + '</a>';
    }

    function buildRemarksCell(p) {
        const rows = remarkTypes.map((type) => {
            const value = readRemark(p, type);
            const empty = value.trim() === '';
            const preview = empty ? '\u2014' : truncate(value, 60);

            const cls = 'pmRemarkRow is-' + type
                + (empty ? ' is-empty' : '');

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

    function buildActionsCell(p) {
        const wrap = document.createElement('div');
        wrap.className = 'pmActionGroup';

        if (state.activeTab === 'pending_grounds' && currentTabCanConfirm()) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pmActionBtn pmActionBtn--verify';
            btn.title = 'Confirm grounds completion';
            btn.setAttribute('aria-label', 'Confirm grounds completion');
            btn.innerHTML = '<i class="fas fa-check"></i>';
            btn.addEventListener('click', (ev) => runConfirm(p, ev.currentTarget, TABS[state.activeTab]));
            wrap.appendChild(btn);
        } else if (state.activeTab === 'verified') {
            const pill = document.createElement('span');
            pill.className = 'pmVerifiedPill';
            pill.title = 'Payment fully verified';
            pill.innerHTML = '<i class="fas fa-circle-check"></i><span>Verified</span>';
            wrap.appendChild(pill);
        }
        // pending_office tab: intentionally empty (read-only).

        return wrap;
    }

    // ------------------------------------------------------------------ notice
    function buildReadOnlyNoticeHtml() {
        if (state.activeTab === 'pending_office') {
            return ''
                + '<tr class="readOnlyNoticeRow is-office">'
                + '  <td colspan="11">'
                + '    <div class="readOnlyNotice">'
                + '      <i class="fas fa-lock"></i>'
                + '      <span>These payments are still awaiting '
                + '      <strong>Administrator / Office Staff</strong> confirmation.</span>'
                + '    </div>'
                + '  </td>'
                + '</tr>';
        }
        return '';
    }

    // ------------------------------------------------------------------ render
    function hideNoData() {
        if (!el.noData) return;
        el.noData.hidden = true;
        el.noData.style.display = 'none';
    }

    function showNoData(message) {
        if (!el.noData) return;
        el.noData.hidden = false;
        el.noData.style.display = '';
        el.noData.innerHTML = '<i class="fas fa-inbox"></i> '
            + escapeHtml(message || 'No records found');
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

    function renderRows(payments) {
        el.tbody.innerHTML = '';

        const noticeHtml = buildReadOnlyNoticeHtml();
        if (noticeHtml) {
            el.tbody.insertAdjacentHTML('beforeend', noticeHtml);
        }

        if (!Array.isArray(payments) || payments.length === 0) {
            showNoData('No records found');
            return;
        }

        hideNoData();

        const frag = document.createDocumentFragment();

        payments.forEach((p) => {
            const tr = document.createElement('tr');
            tr.dataset.paymentId = p.payment_id;
            tr.__payment = p;

            tr.innerHTML =
                '<td>' + escapeHtml(p.deceased_name || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.payers_name || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.payment_channel || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.reference_number || '\u2014') + '</td>' +
                '<td>' + formatMoney(p.amount) + '</td>' +
                '<td>' + escapeHtml(p.payers_phone_number || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.payers_email || '\u2014') + '</td>' +
                '<td>' + escapeHtml(p.purpose || '\u2014') + '</td>' +
                '<td>' + buildProofCell(p) + '</td>' +
                '<td>' + buildRemarksCell(p) + '</td>' +
                '<td>' + buildStatusBadge(p) + '</td>';

            const actionCell = document.createElement('td');
            actionCell.appendChild(buildActionsCell(p));
            tr.appendChild(actionCell);

            frag.appendChild(tr);
        });

        el.tbody.appendChild(frag);
    }

    function renderPagination(pagination) {
        const total = Math.max(1, Number(pagination.total_pages) || 1);
        const current = Math.min(Math.max(1, Number(pagination.current_page) || 1), total);
        const records = Math.max(0, Number(pagination.total_records) || 0);

        state.totalPages = total;
        state.page = current;
        state.totalRecords = records;

        if (el.currentPage) el.currentPage.textContent = String(current);
        if (el.totalPages) el.totalPages.textContent = String(total);
        if (el.totalRecords) el.totalRecords.textContent = String(records);

        if (el.prevBtn) el.prevBtn.disabled = current <= 1;
        if (el.nextBtn) el.nextBtn.disabled = current >= total;

        if (!el.carouselTrack) return;
        el.carouselTrack.innerHTML = '';

        const WINDOW = 5;
        let start = Math.max(1, current - Math.floor(WINDOW / 2));
        let end = Math.min(total, start + WINDOW - 1);
        start = Math.max(1, end - WINDOW + 1);

        const addEllipsis = () => {
            const span = document.createElement('span');
            span.className = 'pageEllipsis';
            span.textContent = '\u2026';
            span.setAttribute('aria-hidden', 'true');
            el.carouselTrack.appendChild(span);
        };

        const addPageBtn = (page) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = page === current ? 'active' : '';
            btn.textContent = String(page);
            btn.dataset.page = String(page);
            if (page === current) btn.setAttribute('aria-current', 'page');
            btn.addEventListener('click', () => {
                if (page === state.page) return;
                state.page = page;
                loadTab();
            });
            el.carouselTrack.appendChild(btn);
        };

        if (start > 1) {
            addPageBtn(1);
            if (start > 2) addEllipsis();
        }
        for (let i = start; i <= end; i++) addPageBtn(i);
        if (end < total) {
            if (end < total - 1) addEllipsis();
            addPageBtn(total);
        }
    }

    // ------------------------------------------------------------------ tab UI
    function updateTabUI() {
        el.tabButtons.forEach((btn) => {
            const isActive = btn.dataset.tab === state.activeTab;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        // Hide the Action column entirely on tabs where no action is offered.
        if (el.tableWrapper) {
            el.tableWrapper.classList.toggle(
                'hideActionCol',
                state.activeTab === 'pending_office'
            );
        }

        if (el.search) el.search.placeholder = SEARCH_PLACEHOLDER;
    }

    function switchTab(tabId) {
        if (!TABS[tabId] || tabId === state.activeTab) return;
        state.activeTab = tabId;
        state.page = 1;
        state.search = '';
        if (el.search) el.search.value = '';
        updateTabUI();
        loadTab();
    }

    // ------------------------------------------------------------------ fetch
    function buildQuery() {
        const tabCfg = TABS[state.activeTab];
        const params = new URLSearchParams();
        params.set('page', String(state.page));
        params.set('limit', String(PER_PAGE));
        params.set('status', tabCfg.status);
        if (state.search && state.search.length >= SEARCH_MIN_LEN) {
            params.set('search_term', state.search);
        }
        return params.toString();
    }

    async function loadTab() {
        const reqId = ++state.requestId;
        state.loading = true;
        renderLoading();

        try {
            const res = await fetchWithTimeout(API_URL + '?' + buildQuery(), {
                method: 'GET',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' },
            });

            if (reqId !== state.requestId) return;

            const json = await res.json().catch(() => null);

            if (!res.ok || (json && json.success === false)) {
                const msg = (json && (json.message || json.error))
                    || ('Request failed (' + res.status + ')');
                throw new Error(msg);
            }

            const payload = unwrap(json);
            renderRows(payload.payments || []);
            renderPagination(payload.pagination || {
                total_pages: 1,
                current_page: 1,
                total_records: 0,
            });
        } catch (err) {
            if (reqId !== state.requestId) return;
            console.error('[grounds-payments] load error:', err);
            const msg = isAbortError(err)
                ? 'Loading payments timed out. Please try again.'
                : friendlyMessage(err, 'Unable to load payment records.');
            renderError(msg);
        } finally {
            if (reqId === state.requestId) state.loading = false;
        }
    }

    // ------------------------------------------------------------------ tab counts
    async function loadTabCounts() {
        await Promise.allSettled(Object.keys(TABS).map(async (tabId) => {
            try {
                const res = await fetchWithTimeout(
                    API_URL + '?status=' + encodeURIComponent(TABS[tabId].status)
                    + '&page=1&limit=1',
                    {
                        method: 'GET',
                        credentials: 'same-origin',
                        headers: { 'Accept': 'application/json' },
                    }
                );
                const json = await res.json().catch(() => null);
                if (!json) return;
                const data = unwrap(json);
                const total = Number(data.pagination && data.pagination.total_records) || 0;
                const badge = document.querySelector(
                    '[data-count-tab="' + tabId + '"]'
                );
                if (badge) badge.textContent = total > 0 ? String(total) : '';
            } catch (_) { /* silent */ }
        }));
    }

    // ------------------------------------------------------------------ confirm action
    async function runConfirm(payment, btn, tabCfg) {
        if (!btn || btn.disabled) return;
        if (!tabCfg || !tabCfg.canConfirm) return;
        if (!tabCfg.roleCheck || !tabCfg.roleCheck()) {
            notify('You do not have permission to confirm this payment.', 'error');
            return;
        }

        let ok = false;
        try {
            ok = await askConfirm(tabCfg.confirmPrompt.message, {
                title: tabCfg.confirmPrompt.title,
                confirmText: tabCfg.confirmPrompt.confirmText,
                cancelText: 'Cancel',
            });
        } catch (_) { ok = false; }
        if (!ok) return;

        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

        let succeeded = false;
        try {
            const res = await fetchWithTimeout(
                API_URL + '?path_info=' + encodeURIComponent(payment.payment_id),
                {
                    method: 'PUT',
                    credentials: 'same-origin',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify({ action: tabCfg.confirmAction }),
                }
            );

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                const msg = (json && (json.message || json.error))
                    || ('Request failed (' + res.status + ')');
                throw new Error(msg);
            }

            notify((json && json.message) || 'Payment confirmed.', 'success');
            succeeded = true;

            await loadTab();
            loadTabCounts();
        } catch (err) {
            console.error('[grounds-payments] confirm error:', err);
            const msg = isAbortError(err)
                ? 'Request timed out. Please try again.'
                : friendlyMessage(err, 'Confirm failed.');
            notify(msg, 'error');
        } finally {
            if (!succeeded && btn.isConnected) {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        }
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

    function closeActiveEditor() {
        const section = state.editingSection;
        if (!section) return;
        if (typeof section.__endEdit === 'function') section.__endEdit();
    }

    async function saveRemark(payment, type, value) {
        try {
            const res = await fetchWithTimeout(
                API_URL + '?path_info=' + encodeURIComponent(payment.payment_id),
                {
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
                }
            );

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                throw new Error((json && (json.message || json.error))
                    || ('Request failed (' + res.status + ')'));
            }

            const key = remarkField(type);
            const v = (value || '').trim();
            payment[key] = v === '' ? null : v;

            notify((json && json.message) || (remarkLabelFor(type) + ' remark saved.'), 'success');
            return true;
        } catch (err) {
            console.error('[grounds-payments] save remark error:', err);
            const msg = isAbortError(err)
                ? 'Saving remark timed out. Please try again.'
                : friendlyMessage(err, 'Failed to save remark.');
            notify(msg, 'error');
            return false;
        }
    }

    function refreshRowRemarks(payment) {
        const row = el.tbody.querySelector(
            'tr[data-payment-id="' + CSS.escape(String(payment.payment_id)) + '"]'
        );
        if (!row) return;
        row.__payment = payment;
        const cells = row.querySelectorAll('td');
        const remarkCell = cells[cells.length - 3]; // 10th of 12
        if (remarkCell) remarkCell.innerHTML = buildRemarksCell(payment);
    }

    function buildRemarkSection(payment, type) {
        const isPayer = (type === 'payer');
        const canEdit = !isPayer && canEditRemark(type);
        const value = readRemark(payment, type);
        const empty = value.trim() === '';

        const section = document.createElement('section');
        section.className = 'pmRemarkSection is-' + type;
        section.dataset.type = type;

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

        const view = document.createElement('div');
        view.className = 'pmRemarkSectionValue' + (empty ? ' is-empty' : '');
        view.textContent = empty ? '\u2014' : value;
        section.appendChild(view);

        if (!canEdit) return section;

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
            if (editBtn) editBtn.style.display = 'none';

            state.editingSection = section;
            section.__endEdit = endEdit;

            textarea.focus();
            try { textarea.setSelectionRange(textarea.value.length, textarea.value.length); } catch (_) { }
        }

        function endEdit() {
            view.hidden = false;
            textarea.hidden = true;
            actions.hidden = true;
            if (editBtn) editBtn.style.display = '';

            textarea.value = original;
            view.textContent = original.trim() === '' ? '\u2014' : original;
            view.classList.toggle('is-empty', original.trim() === '');

            if (state.editingSection === section) {
                state.editingSection = null;
                delete section.__endEdit;
            }
        }

        saveBtn.addEventListener('click', async () => {
            const newValue = textarea.value;
            if (newValue === original) { endEdit(); return; }
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

            if (!ok) return;

            const current = readRemark(payment, type);
            const isNowEmpty = current.trim() === '';
            view.textContent = isNowEmpty ? '\u2014' : current;
            view.classList.toggle('is-empty', isNowEmpty);
            original = current;

            refreshRowRemarks(payment);
            endEdit();
        });

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
            '<h3 class="pmRemarksTitle" id="pmRemarksTitle"><span>Payment Remarks</span></h3>';
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
            body.appendChild(buildRemarkSection(payment, type));
        });
        card.appendChild(body);

        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) closeRemarksModal();
        });

        const onKey = (e) => {
            if (e.key === 'Escape') {
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

        // Auto-open the Grounds editor if the row was clicked on the grounds remark.
        if (focusType === 'grounds' && canEditRemark('grounds')) {
            setTimeout(() => {
                const section = body.querySelector('.pmRemarkSection.is-grounds');
                if (!section) return;
                const btn = section.querySelector('.pmRemarkEditBtn');
                if (btn) btn.click();
            }, 120);
        }
    }

    // ------------------------------------------------------------------ events
    let eventsBound = false;

    function bindEvents() {
        if (eventsBound) return;
        eventsBound = true;

        el.tabButtons.forEach((btn) => {
            btn.addEventListener('click', () => switchTab(btn.dataset.tab));
        });

        if (el.search) {
            el.search.addEventListener('input', debounce(() => {
                const v = el.search.value.trim();
                if (v.length > 0 && v.length < SEARCH_MIN_LEN) return;
                if (v === state.search) return;
                state.search = v;
                state.page = 1;
                loadTab();
            }, SEARCH_DEBOUNCE_MS));

            el.search.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const v = el.search.value.trim();
                if (v.length > 0 && v.length < SEARCH_MIN_LEN) {
                    notify(
                        'Please enter at least ' + SEARCH_MIN_LEN + ' characters to search.',
                        'warning'
                    );
                    return;
                }
                state.search = v;
                state.page = 1;
                loadTab();
            });
        }

        if (el.prevBtn) {
            el.prevBtn.addEventListener('click', () => {
                if (state.page <= 1) return;
                state.page -= 1;
                loadTab();
            });
        }

        if (el.nextBtn) {
            el.nextBtn.addEventListener('click', () => {
                if (state.page >= state.totalPages) return;
                state.page += 1;
                loadTab();
            });
        }

        if (el.tbody) {
            el.tbody.addEventListener('click', (e) => {
                const remarkRow = e.target.closest('[data-action="remark"]');
                if (!remarkRow || !el.tbody.contains(remarkRow)) return;
                e.preventDefault();
                const row = remarkRow.closest('tr');
                if (!row) return;
                const payment = row.__payment;
                if (!payment) return;
                openRemarksModal(payment, remarkRow.dataset.type || '');
            });

            el.tbody.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const remarkRow = e.target.closest('[data-action="remark"]');
                if (!remarkRow || !el.tbody.contains(remarkRow)) return;
                e.preventDefault();
                const row = remarkRow.closest('tr');
                if (!row) return;
                const payment = row.__payment;
                if (!payment) return;
                openRemarksModal(payment, remarkRow.dataset.type || '');
            });
        }
    }

    // ------------------------------------------------------------------ init
    function start() {
        bindEvents();
        updateTabUI();
        loadTab();
        loadTabCounts();

        setTimeout(() => {
            updateTabUI();
            loadTab();
        }, 500);
    }

    if (document.readyState === 'complete') {
        start();
    } else {
        window.addEventListener('load', start);
    }
})();