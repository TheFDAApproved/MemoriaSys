(() => {
    'use strict';

    // Configuration constants
    const API_URL = 'api/monitor.php';
    const DEFAULT_LIMIT = 100;
    const MIN_SEARCH_LENGTH = 3;
    const SEARCH_DEBOUNCE_MS = 350;
    const PAGINATION_WINDOW = 5;

    // Application state
    const state = {
        page: 1,
        limit: DEFAULT_LIMIT,
        search: '',
        totalPages: 1,
        totalRecords: 0,
        items: [],
        loading: false,
        controller: null,
        requestId: 0,
        silentNextRender: false,
    };

    // DOM element references
    const els = {
        tbody: document.getElementById('reservation'),
        noData: document.getElementById('monitor_no_data'),
        searchInput: document.getElementById('user_search'),
        currentPageLabel: document.getElementById('current_page_num'),
        totalPagesLabel: document.getElementById('total_pages_num'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
        carouselViewport: document.getElementById('carousel_viewport'),
    };

    if (!els.tbody) {
        console.error('[monitor.js] Target tbody #reservation not found.');
        return;
    }

    let actionInProgress = false;

    // Action-button loading indicator
    // Injects the spinner animation used while an action button is busy.
    function injectLoadingStyles() {
        if (document.getElementById('recordsBtnLoadingStyles')) return;
        const style = document.createElement('style');
        style.id = 'recordsBtnLoadingStyles';
        style.textContent = `
            .records-btn-loading {
                pointer-events: none !important;
                cursor: progress;
            }
            .records-btn-loading > * {
                opacity: 0.35;
            }
            .records-btn-loading::after {
                content: "";
                position: absolute;
                top: 50%;
                left: 50%;
                width: 14px;
                height: 14px;
                margin: -7px 0 0 -7px;
                border: 2px solid rgba(0, 0, 0, 0.55);
                border-top-color: transparent;
                border-radius: 50%;
                box-sizing: border-box;
                animation: recordsBtnSpin 0.7s linear infinite;
                pointer-events: none;
            }
            @keyframes recordsBtnSpin {
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    // Runs an async action while disabling the button and showing a spinner
    // Prevents double-clicks and overlapping actions
    async function runAction(btn, fn) {
        if (actionInProgress) return;
        if (!btn || btn.dataset.loading === 'true') return;

        actionInProgress = true;
        const prevDisabled = btn.disabled;

        const wasStatic = window.getComputedStyle(btn).position === 'static';
        if (wasStatic) btn.style.position = 'relative';

        btn.dataset.loading = 'true';
        btn.classList.add('records-btn-loading');
        btn.disabled = true;

        try {
            await new Promise((r) => requestAnimationFrame(() => r()));
            await fn();
        } catch (err) {
            console.error('[monitor.js] Action failed:', err);
        } finally {
            btn.classList.remove('records-btn-loading');
            btn.disabled = prevDisabled;
            if (wasStatic) btn.style.position = '';
            delete btn.dataset.loading;
            actionInProgress = false;
        }
    }

    // Notification and error helpers
    const GENERIC_ERROR = 'Something went wrong. Please try again.';

    // Detects raw technical errors so they can be replaced with a friendly message
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

    function notify(kind, message) {
        if (!message) return;
        const rawText = String(message);
        const displayText = (kind === 'error' && looksRawMessage(rawText))
            ? GENERIC_ERROR
            : rawText;
        if (typeof window.showAlertTOP === 'function') {
            const type = kind === 'success' ? 'success'
                : kind === 'error' ? 'error'
                    : kind === 'warning' ? 'warning'
                        : 'info';
            window.showAlertTOP(displayText, type);
            return;
        }
        if (kind === 'error') console.error('[monitor.js]', rawText);
        else console.log('[monitor.js]', rawText);
    }

    function warnSearchTooShort(value) {
        const min = MIN_SEARCH_LENGTH;
        const len = String(value || '').trim().length;
        notify(
            'warning',
            `Please enter at least ${min} characters to search — ` +
            `you've only typed ${len}.`
        );
    }

    // Value formatting helpers
    const escapeHtml = (v) => {
        if (v === null || v === undefined) return '';
        return String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    const displayVal = (v) => {
        const s = (v === null || v === undefined) ? '' : String(v).trim();
        return s === '' ? '-' : s;
    };

    // SMS helpers [build a pre-filled message and open the SMS modal]
    function formatSmsDate(v) {
        if (!v) return '';
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return String(v);
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    function buildSmsMessage(o) {
        const contact = o && o.contact_person_name ? String(o.contact_person_name).trim() : '';
        const deceased = o && o.deceased_name ? String(o.deceased_name).trim() : '';
        let msg = 'Hello ' + (contact || 'Sir/Ma\'am') + ', this is an official notice.';
        const expiry = formatSmsDate(o && o.lease_expiration_date);
        const subject = deceased || 'the deceased';
        if (expiry) msg += ' The lease for ' + subject + ' expires on ' + expiry + '.';
        else msg += ' This is regarding the lease for ' + subject + '.';
        return msg;
    }

    // Renders a contact number as an SMS link when a number exists
    function renderPhoneLink(occ) {
        if (!occ) return '-';
        const raw = occ.contact_person_phone_number;
        if (raw === null || raw === undefined) return '-';
        const s = String(raw).trim();
        if (s === '') return '-';
        return (
            '<a href="#" class="smsPhoneLink" data-action="sms"' +
            ' data-phone="' + escapeHtml(s) + '"' +
            ' data-contact="' + escapeHtml(occ.contact_person_name || '') + '"' +
            ' data-deceased="' + escapeHtml(occ.deceased_name || '') + '"' +
            ' data-expiry="' + escapeHtml(occ.lease_expiration_date || '') + '"' +
            ' title="Send SMS">' + escapeHtml(s) + '</a>'
        );
    }

    function handleSmsClick(event) {
        const link = event.target.closest('[data-action="sms"]');
        if (!link || !els.tbody.contains(link)) return;
        event.preventDefault();
        const phone = String(link.dataset.phone || '').trim();
        if (!phone) { notify('warning', 'This occupant has no contact number on file.'); return; }
        if (typeof window.openSmsModal !== 'function') {
            console.warn('[monitor.js] openSmsModal not available — load sms_notification.js.');
            notify('error', 'SMS feature is not available right now.');
            return;
        }
        window.openSmsModal(phone, buildSmsMessage({
            contact_person_name: link.dataset.contact || '',
            deceased_name: link.dataset.deceased || '',
            lease_expiration_date: link.dataset.expiry || '',
        }));
    }

    // Search clear button [injected next to the search input]
    let searchClearBtn = null;
    (function mountSearchClearBtn() {
        if (!els.searchInput) return;
        const box = els.searchInput.closest('.searchBox');
        if (!box) return;
        searchClearBtn = document.createElement('button');
        searchClearBtn.type = 'button';
        searchClearBtn.className = 'searchClearBtn';
        searchClearBtn.setAttribute('aria-label', 'Clear search');
        searchClearBtn.title = 'Clear';
        searchClearBtn.innerHTML = '<i class="fas fa-times"></i>';
        box.appendChild(searchClearBtn);
        searchClearBtn.addEventListener('click', () => {
            els.searchInput.value = '';
            searchClearBtn.classList.remove('is-visible');
            els.searchInput.focus();
            if (state.search !== '') {
                state.search = '';
                state.page = 1;
                fetchReservations();
            }
        });
        toggleSearchClear(els.searchInput.value);
    })();

    function toggleSearchClear(value) {
        if (!searchClearBtn) return;
        searchClearBtn.classList.toggle('is-visible', String(value || '').length > 0);
    }

    // Loading / empty / error state helpers
    const setLoading = (isLoading) => {
        state.loading = isLoading;
        const wrapper = els.tbody.closest('.tableWrapper');
        if (wrapper) wrapper.classList.toggle('isLoading', isLoading);
        if (isLoading && els.noData) els.noData.style.display = 'none';
        if (els.prevBtn) els.prevBtn.disabled = isLoading || state.page <= 1;
        if (els.nextBtn) els.nextBtn.disabled = isLoading || state.page >= state.totalPages;
    };

    function showEmptyState() {
        if (!els.noData) return;
        els.noData.innerHTML = '<i class="fas fa-inbox"></i> No data found';
        els.noData.style.display = '';
    }

    function showError(message) {
        if (!els.noData) return;
        const display = (message && !looksRawMessage(message)) ? message : GENERIC_ERROR;
        els.noData.innerHTML = `<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(display)}`;
        els.noData.style.display = '';
    }

    // Data fetching
    // Loads reservations from the API using the current page, limit, and search
    // Uses AbortController + requestId to safely ignore stale responses
    async function fetchReservations() {
        if (state.controller) state.controller.abort();
        state.controller = new AbortController();

        const params = new URLSearchParams();
        params.set('page', String(state.page));
        params.set('limit', String(state.limit));
        if (state.search) params.set('search_term', state.search);

        const reqId = ++state.requestId;
        setLoading(true);
        let loadError = null;

        try {
            const response = await fetch(`${API_URL}?${params.toString()}`, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
                signal: state.controller.signal,
            });

            if (reqId !== state.requestId) return;
            const json = await response.json().catch(() => null);
            if (!response.ok) {
                const msg = (json && (json.message || json.error)) || `Request failed (${response.status})`;
                throw new Error(msg);
            }
            if (json && json.success === false) throw new Error(json.message || 'Request failed.');

            const payload = (json && json.data) ? json.data : (json || {});
            state.items = Array.isArray(payload.reservations) ? payload.reservations : [];
            const pg = payload.pagination || {};
            state.page = Number(pg.current_page) || state.page;
            state.totalPages = Math.max(1, Number(pg.total_pages) || 1);
            state.totalRecords = Number(pg.total_records) || state.items.length;
        } catch (err) {
            if (err.name === 'AbortError') return;
            if (reqId !== state.requestId) return;
            loadError = err;
        }

        if (reqId !== state.requestId) return;

        setLoading(false);

        if (loadError) {
            state.items = [];
            state.totalPages = 1;
            state.totalRecords = 0;
            render();
            showError(loadError.message || 'Failed to load reservations.');
        } else {
            render();
        }
    }

    // Refreshes without playing the row fade-in animation
    function silentRefresh() {
        state.silentNextRender = true;
        return fetchReservations();
    }

    // Re-fetches a single reservation by ID [used before viewing or printing]
    async function refetchReservation(reservationId) {
        if (!reservationId) return null;
        try {
            const res = await fetch(`${API_URL}/${encodeURIComponent(reservationId)}`, {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!res.ok) return null;
            const json = await res.json().catch(() => null);
            if (!json || json.success === false) return null;
            const payload = (json && json.data) ? json.data : json;
            return (payload && payload.reservation) ? payload.reservation : null;
        } catch (err) {
            console.warn('[monitor.js] refetch reservation failed:', err);
            return null;
        }
    }

    // Rendering
    function render() {
        renderRows();
        renderPagination();
    }

    function renderRows() {
        els.tbody.innerHTML = '';

        if (!state.items.length) {
            if (els.noData) {
                if (state.loading) els.noData.style.display = 'none';
                else showEmptyState();
            }
            state.silentNextRender = false;
            return;
        }
        if (els.noData) els.noData.style.display = 'none';

        const fragment = document.createDocumentFragment();

        state.items.forEach((res) => {
            const old = res.old_interment || null;
            const neu = res.pending_interment || {};
            const grave = res.target_grave || {};

            const tr = document.createElement('tr');
            tr.dataset.reservationId = res.reservation_id;
            tr.dataset.type = old ? 'replace' : 'vacant';
            tr.classList.add('monitorRow', `type-${old ? 'replace' : 'vacant'}`);

            // Old occupant columns
            const oldName = old ? displayVal(old.deceased_name) : '-';
            const oldExpiration = old ? displayVal(old.lease_expiration_date) : '-';
            const oldContact = old ? displayVal(old.contact_person_name) : '-';
            const oldPhoneCell = renderPhoneLink(old);

            // Block / grave code
            const blockName = displayVal(grave.block_name);
            const graveCode = displayVal(grave.grave_code);
            const locationCell = (blockName !== '-' && graveCode !== '-')
                ? `${escapeHtml(blockName)} <span style="color:#94a3b8">/</span> ${escapeHtml(graveCode)}`
                : escapeHtml(blockName !== '-' ? blockName : graveCode);

            // Pending occupant columns
            const newName = displayVal(neu.deceased_name);
            const newAddress = displayVal(neu.last_known_address);
            const newContact = displayVal(neu.contact_person_name);
            const newPhoneCell = renderPhoneLink(neu);
            const newContactAddress = displayVal(neu.contact_person_address);
            const remarks = displayVal(neu.remarks || (old && old.remarks));

            // Row action buttons
            let actionButtons = '';
            if (old) {
                actionButtons += `<button type="button" class="viewBtn monitorActionBtn" data-action="view-old" title="View Old Occupant" aria-label="View Old Occupant"><i class="fas fa-user-clock"></i></button>`;
            }
            actionButtons += `<button type="button" class="viewBtn monitorActionBtn" data-action="view-new" title="View New Occupant" aria-label="View New Occupant"><i class="fas fa-user-plus"></i></button>`;
            actionButtons += `<button type="button" class="checkBtn monitorActionBtn" data-action="check" title="Confirm Reservation" aria-label="Confirm Reservation"><i class="fas fa-check"></i></button>`;
            actionButtons += `<button type="button" class="cancelBtn monitorActionBtn" data-action="cancel" title="Cancel Reservation" aria-label="Cancel Reservation"><i class="fas fa-times"></i></button>`;
            actionButtons += `<button type="button" class="printBtn monitorActionBtn" data-action="print" title="Print Certificate" aria-label="Print Certificate"><i class="fas fa-print"></i></button>`;

            tr.innerHTML = `
                <td>${escapeHtml(oldName)}</td>
                <td>${locationCell}</td>
                <td>${escapeHtml(oldExpiration)}</td>
                <td>${escapeHtml(oldContact)}</td>
                <td>${oldPhoneCell}</td>
                <td>${escapeHtml(newName)}</td>
                <td>${escapeHtml(newAddress)}</td>
                <td>${escapeHtml(newContact)}</td>
                <td>${newPhoneCell}</td>
                <td>${escapeHtml(newContactAddress)}</td>
                <td class="remarksCell">${escapeHtml(remarks)}</td>
                <td class="actionCell"><div class="actions">${actionButtons}</div></td>
            `;
            fragment.appendChild(tr);
        });

        els.tbody.appendChild(fragment);

        els.tbody.querySelectorAll('.monitorActionBtn').forEach((btn) => {
            btn.addEventListener('click', handleActionClick);
        });

        if (!state.silentNextRender) {
            els.tbody.classList.remove('animate');
            void els.tbody.offsetWidth;
            els.tbody.classList.add('animate');
        }
        state.silentNextRender = false;
    }

    function renderPagination() {
        if (els.currentPageLabel) els.currentPageLabel.textContent = state.page;
        if (els.totalPagesLabel) els.totalPagesLabel.textContent = state.totalPages;
        if (els.prevBtn) els.prevBtn.disabled = state.loading || state.page <= 1;
        if (els.nextBtn) els.nextBtn.disabled = state.loading || state.page >= state.totalPages;

        if (!els.carouselTrack) return;
        els.carouselTrack.innerHTML = '';

        const total = state.totalPages;
        if (total < 1) return;

        const windowSize = PAGINATION_WINDOW;
        let start = Math.max(1, state.page - Math.floor(windowSize / 2));
        let end = Math.min(total, start + windowSize - 1);
        start = Math.max(1, end - windowSize + 1);

        // First page + ellipsis when the window doesn't start at page 1
        if (start > 1) {
            els.carouselTrack.appendChild(makePageBtn(1));
            if (start > 2) els.carouselTrack.appendChild(makeEllipsis());
        }
        for (let p = start; p <= end; p++) els.carouselTrack.appendChild(makePageBtn(p));
        // Last page + ellipsis when the window doesn't end at the last page
        if (end < total) {
            if (end < total - 1) els.carouselTrack.appendChild(makeEllipsis());
            els.carouselTrack.appendChild(makePageBtn(total));
        }
    }

    function makePageBtn(pageNum) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pageNumBtn' + (pageNum === state.page ? ' active' : '');
        btn.textContent = String(pageNum);
        btn.dataset.page = String(pageNum);
        if (pageNum === state.page) btn.setAttribute('aria-current', 'page');
        btn.addEventListener('click', () => goToPage(pageNum));
        return btn;
    }

    function makeEllipsis() {
        const span = document.createElement('span');
        span.className = 'pageEllipsis';
        span.textContent = '…';
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    function goToPage(page) {
        const target = Math.min(Math.max(1, page), state.totalPages);
        if (target === state.page || state.loading) return;
        state.page = target;
        fetchReservations();
    }

    // Reservation helpers
    // Converts the reservation object into the payload expected by the API
    function buildPayloadFromReservation(res) {
        const n = res.pending_interment || {};
        const o = res.old_interment || null;

        const payload = {
            control_number: n.control_number || '',
            deceased_name: n.deceased_name || '',
            deceased_sex: n.deceased_sex || '',
            deceased_date_of_birth: n.deceased_date_of_birth || null,
            deceased_date_of_death: n.deceased_date_of_death || null,
            last_known_address: n.last_known_address || '',
            death_certificate: n.death_certificate || '',
            contact_person_name: n.contact_person_name || '',
            contact_person_phone_number: n.contact_person_phone_number || '',
            contact_person_email: n.contact_person_email || '',
            contact_person_address: n.contact_person_address || '',
            contact_person_address_barangay: n.contact_person_address_barangay || '',
            assistance_type: n.assistance_type || 'Other',
            burial_permit_number: n.burial_permit_number || '',
            burial_permit_date: n.burial_permit_date || null,
            transfer_permit_number: n.transfer_permit_number || '',
            transfer_permit_issued_by: n.transfer_permit_issued_by || '',
            transfer_permit_date: n.transfer_permit_date || null,
            exhumation_permit_number: n.exhumation_permit_number || '',
            exhumation_permit_date: n.exhumation_permit_date || null,
            date_buried: n.date_buried || null,
            date_exhumed: n.date_exhumed || null,
            burial_clearance_date: n.burial_clearance_date || null,
            lease_expiration_date: n.lease_expiration_date || null,
            remarks: n.remarks || '',
            reservation_notes: res.reservation_notes || '',
        };

        if (o) {
            payload.old_new_status = res.old_new_status || 'Inactive';
            if (res.old_new_grave && res.old_new_grave.grave_id) {
                payload.old_new_grave_id = res.old_new_grave.grave_id;
                payload.old_new_grave_code = res.old_new_grave.code || res.old_new_grave.grave_code || '';
            }
            if (res.old_new_assistance_type) payload.old_new_assistance_type = res.old_new_assistance_type;
            if (res.old_new_remarks) payload.old_new_remarks = res.old_new_remarks;
            if (res.exhumation_permit_number) payload.exhumation_permit_number = res.exhumation_permit_number;
            if (res.transfer_permit_number) payload.transfer_permit_number = res.transfer_permit_number;
            if (res.old_edited_fields) payload.old_edited_fields = res.old_edited_fields;
        }

        return payload;
    }

    // Uses the shared confirm modal if available, otherwise falls back to window.confirm
    function confirmDialog(opts) {
        if (typeof window.showConfirmModal === 'function') return window.showConfirmModal(opts);
        const plain = [opts.title, opts.message].filter(Boolean).join('\n\n');
        return Promise.resolve(window.confirm(plain));
    }

    function findReservationById(id) {
        return state.items.find(r => String(r.reservation_id) === String(id)) || null;
    }

    // Removes a row from the table with a short fade and updates local counters
    function removeRowLocally(reservationId) {
        state.items = state.items.filter(
            r => String(r.reservation_id) !== String(reservationId)
        );
        const row = els.tbody.querySelector(
            `tr[data-reservation-id="${CSS.escape(String(reservationId))}"]`
        );
        if (row) {
            row.classList.add('rowFadeOut');
            setTimeout(() => {
                row.remove();
                if (!state.items.length && els.noData) showEmptyState();
            }, 180);
        }
        state.totalRecords = Math.max(0, state.totalRecords - 1);
    }

    // Row action dispatcher
    async function handleActionClick(event) {
        const btn = event.currentTarget;
        const row = btn.closest('tr');
        if (!row) return;
        const reservation = findReservationById(row.dataset.reservationId);
        if (!reservation) return;

        const action = btn.dataset.action;

        await runAction(btn, async () => {
            if (action === 'view-old') await openOldOccupant(reservation);
            else if (action === 'view-new') await openNewOccupant(reservation);
            else if (action === 'check') await confirmReservation(reservation);
            else if (action === 'cancel') await cancelReservation(reservation);
            else if (action === 'print') await printCertificate(reservation);
        });
    }

    async function openOldOccupant(reservation) {
        const fresh = await refetchReservation(reservation.reservation_id);
        const payload = fresh || reservation;
        if (typeof window.openMonitorOldOccupant === 'function') {
            return await Promise.resolve(window.openMonitorOldOccupant(payload));
        }
        document.dispatchEvent(new CustomEvent('monitor:view-old', { detail: payload }));
    }

    async function openNewOccupant(reservation) {
        const fresh = await refetchReservation(reservation.reservation_id);
        const payload = fresh || reservation;
        if (typeof window.openMonitorNewOccupant === 'function') {
            return await Promise.resolve(window.openMonitorNewOccupant(payload));
        }
        document.dispatchEvent(new CustomEvent('monitor:view-new', { detail: payload }));
    }

    // Reservation actions: confirm, cancel, print
    // Confirms the reservation. For a transfer, the old occupant is replaced
    async function confirmReservation(reservation) {
        const old = reservation.old_interment || null;
        const neu = reservation.pending_interment || {};
        const grave = reservation.target_grave || {};

        const rows = [];
        if (old) rows.push({ label: 'Old Occupant', value: old.deceased_name || '' });
        rows.push({ label: 'New Occupant', value: neu.deceased_name || '' });
        rows.push({ label: 'Block', value: grave.block_name || '' });
        rows.push({ label: 'Grave Code', value: grave.grave_code || '' });

        const ok = await confirmDialog({
            title: old ? 'Confirm Reservation' : 'Confirm Interment',
            message: 'Do you really want to confirm this reservation?',
            variant: 'primary',
            confirmText: old ? 'Confirm Transfer' : 'Confirm',
            cancelText: 'Cancel',
            rows,
            onConfirm: async function () {
                const payload = buildPayloadFromReservation(reservation);
                const res = await fetch(
                    `${API_URL}/${encodeURIComponent(reservation.reservation_id)}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                        },
                        credentials: 'same-origin',
                        body: JSON.stringify(payload),
                    }
                );
                const json = await res.json().catch(() => null);
                if (!res.ok || (json && json.success === false)) {
                    const apiMsg = json && (json.message || json.error);
                    throw new Error((apiMsg && !looksRawMessage(apiMsg)) ? apiMsg : GENERIC_ERROR);
                }
            },
        });

        if (!ok) return;
        removeRowLocally(reservation.reservation_id);
        notify('success', 'Reservation confirmed.');
    }

    // Cancels a pending reservation. For a transfer, the old occupant stays as-is
    async function cancelReservation(reservation) {
        const neu = reservation.pending_interment || {};
        const old = reservation.old_interment || null;
        const grave = reservation.target_grave || {};

        const rows = [
            { label: 'Name', value: neu.deceased_name || '' },
            { label: 'Block', value: grave.block_name || '' },
            { label: 'Grave Code', value: grave.grave_code || '' },
        ];

        const ok = await confirmDialog({
            title: 'Cancel Reservation',
            message: old
                ? 'Do you really want to cancel this pending reservation? The Old Occupant will return to Reserve unchanged.'
                : 'Do you really want to cancel this pending reservation?',
            variant: 'danger',
            confirmText: 'Yes, Cancel',
            cancelText: 'Keep',
            rows,
            onConfirm: async function () {
                const res = await fetch(
                    `${API_URL}/${encodeURIComponent(reservation.reservation_id)}`,
                    {
                        method: 'DELETE',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                        },
                        credentials: 'same-origin',
                        body: JSON.stringify({}),
                    }
                );
                const json = await res.json().catch(() => null);
                if (!res.ok || (json && json.success === false)) {
                    const apiMsg = json && (json.message || json.error);
                    throw new Error((apiMsg && !looksRawMessage(apiMsg)) ? apiMsg : GENERIC_ERROR);
                }
            },
        });

        if (!ok) return;
        removeRowLocally(reservation.reservation_id);
        notify('success', 'Reservation cancelled.');
    }

    // Prints the burial certificate for the pending interment
    async function printCertificate(reservation) {
        const fresh = await refetchReservation(reservation.reservation_id);
        const payload = fresh || reservation;

        const newOcc = payload.pending_interment || {};
        const intermentId = newOcc.interment_id;

        if (intermentId === null || intermentId === undefined || intermentId === '') {
            notify('warning', 'No printable ID found for this reservation.');
            return;
        }

        if (typeof window.memoria_certificate !== 'function') {
            console.warn('[monitor.js] memoria_certificate not available.');
            notify('error', 'Print certificate feature is not available right now.');
            return;
        }

        await Promise.resolve(window.memoria_certificate(intermentId));
    }

    // Search input handling
    let searchTimer = null;
    if (els.searchInput) {
        els.searchInput.addEventListener('input', () => {
            toggleSearchClear(els.searchInput.value);
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const value = els.searchInput.value.trim();
                if (value.length === 0) {
                    if (state.search !== '') {
                        state.search = '';
                        state.page = 1;
                        fetchReservations();
                    }
                    return;
                }
                if (value.length < MIN_SEARCH_LENGTH) return;
                if (value === state.search) return;
                state.search = value;
                state.page = 1;
                fetchReservations();
            }, SEARCH_DEBOUNCE_MS);
        });

        els.searchInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            clearTimeout(searchTimer);

            const value = els.searchInput.value.trim();

            if (value.length > 0 && value.length < MIN_SEARCH_LENGTH) {
                warnSearchTooShort(value);
                return;
            }

            state.search = value;
            state.page = 1;
            fetchReservations();
        });
    }

    // Pagination buttons and row-level SMS clicks
    if (els.prevBtn) els.prevBtn.addEventListener('click', () => goToPage(state.page - 1));
    if (els.nextBtn) els.nextBtn.addEventListener('click', () => goToPage(state.page + 1));
    els.tbody.addEventListener('click', handleSmsClick);

    // Cross-component events [burial modal]
    document.addEventListener('monitor_burial_modal:saved', () => { silentRefresh(); });
    document.addEventListener('monitor_burial_modal:executed', (e) => {
        const id = e.detail && e.detail.reservationId;
        if (id) removeRowLocally(id);
        else silentRefresh();
    });

    // Public API [exposed for other scripts]
    window.MonitorTable = {
        refresh: () => fetchReservations(),
        silentRefresh,
        reload: () => fetchReservations(),
        setSearch(term) {
            state.search = String(term || '').trim();
            if (els.searchInput) els.searchInput.value = state.search;
            toggleSearchClear(state.search);
            state.page = 1;
            return fetchReservations();
        },
        goToPage,
        getItem(reservationId) {
            return state.items.find(r => Number(r.reservation_id) === Number(reservationId)) || null;
        },
        getState() { return { ...state }; },
    };

    // Initial setup
    if (els.searchInput && els.searchInput.value) {
        const v = els.searchInput.value.trim();
        if (v.length === 0 || v.length >= MIN_SEARCH_LENGTH) state.search = v;
        toggleSearchClear(v);
    }
    if (els.noData) els.noData.style.display = 'none';

    injectLoadingStyles();

    fetchReservations();
})();