(() => {
    'use strict';

    const API_URL = 'api/reserve.php';
    const DEFAULT_LIMIT = 100;
    const MIN_SEARCH_LENGTH = 3;
    const SEARCH_DEBOUNCE_MS = 350;
    const PAGINATION_WINDOW = 5;

    const state = {
        page: 1,
        limit: DEFAULT_LIMIT,
        search: '',
        status: 'all',
        totalPages: 1,
        totalRecords: 0,
        items: [],
        loading: false,
        controller: null,
        requestId: 0,
    };

    const els = {
        tbody: document.getElementById('reservation'),
        noData: document.getElementById('reservation_no_data'),
        searchInput: document.getElementById('user_search'),
        statusFilter: document.getElementById('role_filter'),
        filterBtn: document.getElementById('filter_btn'),
        currentPageLabel: document.getElementById('current_page_num'),
        totalPagesLabel: document.getElementById('total_pages_num'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
        carouselViewport: document.getElementById('carousel_viewport'),
    };

    if (!els.tbody) {
        console.error('[reserve.js] Target tbody #reservation not found.');
        return;
    }

    // ------------------------------------------------------------------
    // Flatten the nested API item  {type, grave:{...}, interment:{...}|null}
    // into the flat shape the rest of this file (and the modal) expects.
    // ------------------------------------------------------------------
    function flattenItem(raw) {
        if (!raw || typeof raw !== 'object') return null;

        // Detect if the API is already sending flat data
        // (e.g., grave_id is at the root, and there is no nested 'grave' object)
        const isFlat = raw.grave === undefined && raw.grave_id !== undefined;

        // If flat, source data directly from 'raw'. Otherwise, use the nested objects.
        const g = isFlat ? raw : (raw.grave || {});
        const i = isFlat ? raw : (raw.interment || null);
        
        // Check if an interment actually exists
        const hasI = isFlat 
            ? (raw.interment_id != null) 
            : !!(i && i.interment_id != null);

        const pickVal = (obj, key) => (obj && obj[key] != null) ? obj[key] : null;

        return {
            type: raw.type || null,

            grave_id:      pickVal(g, 'grave_id'),
            grave_code:    pickVal(g, 'grave_code'),
            row_num:       pickVal(g, 'row_num'),
            col_num:       pickVal(g, 'col_num'),
            grave_status:  pickVal(g, 'grave_status'),
            grave_remarks: pickVal(g, 'grave_remarks'),
            block_id:      pickVal(g, 'block_id'),
            block_name:    pickVal(g, 'block_name'),
            block_type:    pickVal(g, 'block_type'),

            interment_id:                    hasI ? i.interment_id : null,
            control_number:                  hasI ? i.control_number : null,
            deceased_name:                   hasI ? i.deceased_name : null,
            deceased_sex:                    hasI ? i.deceased_sex : null,
            last_known_address:              hasI ? i.last_known_address : null,
            death_certificate:               hasI ? i.death_certificate : null,
            deceased_date_of_birth:          hasI ? i.deceased_date_of_birth : null,
            deceased_date_of_death:          hasI ? i.deceased_date_of_death : null,
            current_grave_id:                hasI ? i.current_grave_id : null,
            contact_person_name:             hasI ? i.contact_person_name : null,
            contact_person_phone_number:     hasI ? i.contact_person_phone_number : null,
            contact_person_email:            hasI ? i.contact_person_email : null,
            contact_person_address:          hasI ? i.contact_person_address : null,
            contact_person_address_barangay: hasI ? i.contact_person_address_barangay : null,
            assistance_type:                 hasI ? i.assistance_type : null,
            burial_permit_number:            hasI ? i.burial_permit_number : null,
            burial_permit_date:              hasI ? i.burial_permit_date : null,
            transfer_permit_number:          hasI ? i.transfer_permit_number : null,
            transfer_permit_issued_by:       hasI ? i.transfer_permit_issued_by : null,
            transfer_permit_date:            hasI ? i.transfer_permit_date : null,
            exhumation_permit_number:        hasI ? i.exhumation_permit_number : null,
            exhumation_permit_date:          hasI ? i.exhumation_permit_date : null,
            date_buried:                     hasI ? i.date_buried : null,
            date_exhumed:                    hasI ? i.date_exhumed : null,
            burial_clearance_date:           hasI ? i.burial_clearance_date : null,
            lease_expiration_date:           hasI ? i.lease_expiration_date : null,
            interment_status:                hasI ? (i.interment_status || i.status) : null,
            interment_remarks:               hasI ? (i.interment_remarks || i.remarks) : null,
        };
    }

    function notify(kind, message) {
        if (!message) return;
        const text = String(message);

        if (typeof window.showAlertTOP === 'function') {
            const type =
                kind === 'success' ? 'success'
                    : kind === 'error' ? 'error'
                        : kind === 'warning' ? 'warning'
                            : 'info';
            window.showAlertTOP(text, type);
            return;
        }

        if (kind === 'error') console.error('[reserve.js]', text);
        else console.log('[reserve.js]', text);
    }

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

    const escapeHtml = (value) => {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    const formatDate = (value) => {
        if (!value) return '-';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return escapeHtml(value);
        return d.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
        });
    };

    const getRemarks = (item) => {
        if (item.interment_remarks && String(item.interment_remarks).trim() !== '') {
            return item.interment_remarks;
        }
        if (item.grave_remarks && String(item.grave_remarks).trim() !== '') {
            return item.grave_remarks;
        }
        return '';
    };

    function formatSmsDate(value) {
        if (!value) return '';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }

    function buildSmsMessage(item) {
        const contact = (item && item.contact_person_name)
            ? String(item.contact_person_name).trim()
            : '';
        const deceased = (item && item.deceased_name)
            ? String(item.deceased_name).trim()
            : '';

        let msg = 'Hello ' + (contact || 'Sir/Ma\'am') + ', this is an official notice.';

        const expiry = formatSmsDate(item && item.lease_expiration_date);
        const subject = deceased || 'the deceased';

        if (expiry) {
            msg += ' The lease for ' + subject + ' expires on ' + expiry + '.';
        } else {
            msg += ' This is regarding the lease for ' + subject + '.';
        }

        return msg;
    }

    function renderPhoneCell(item) {
        const raw = item ? item.contact_person_phone_number : '';
        if (raw === null || raw === undefined) return '-';
        const s = String(raw).trim();
        if (s === '') return '-';

        return (
            '<a href="#" class="smsPhoneLink" data-action="sms"' +
            ' data-grave-id="' + escapeHtml(item.grave_id) + '"' +
            ' title="Send SMS">' +
            escapeHtml(s) +
            '</a>'
        );
    }

    const setLoading = (isLoading) => {
        state.loading = isLoading;

        const wrapper = els.tbody.closest('.tableWrapper');
        if (wrapper) wrapper.classList.toggle('isLoading', isLoading);

        if (isLoading && els.noData) {
            els.noData.style.display = 'none';
        }

        if (els.prevBtn) {
            els.prevBtn.disabled = isLoading || state.page <= 1;
        }
        if (els.nextBtn) {
            els.nextBtn.disabled = isLoading || state.page >= state.totalPages;
        }
    };

    function showEmptyState() {
        if (!els.noData) return;
        els.noData.innerHTML =
            '<i class="fas fa-inbox"></i> No data found';
        els.noData.style.display = '';
    }

    function showError(message) {
        if (!els.noData) return;
        els.noData.innerHTML =
            `<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(message)}`;
        els.noData.style.display = '';
    }

    async function fetchReservations() {
        if (state.controller) state.controller.abort();
        state.controller = new AbortController();

        const params = new URLSearchParams();
        params.set('page', String(state.page));
        params.set('limit', String(state.limit));

        if (state.search) params.set('search_term', state.search);
        if (state.status && state.status !== 'all') {
            params.set('status', state.status);
        }

        const reqId = ++state.requestId;

        setLoading(true);

        let loadError = null;

        try {
            const response = await fetch(`${API_URL}?${params.toString()}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                credentials: 'same-origin',
                signal: state.controller.signal,
            });

            if (reqId !== state.requestId) return;

            const json = await response.json().catch(() => null);

            if (!response.ok) {
                const msg = (json && (json.message || json.error))
                    || `Request failed (${response.status})`;
                throw new Error(msg);
            }
            if (json && json.success === false) {
                throw new Error(json.message || 'Request failed.');
            }

            const payload = (json && json.data) ? json.data : (json || {});

            const rawItems = Array.isArray(payload.items) ? payload.items : [];
            state.items = rawItems.map(flattenItem).filter(Boolean);

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

    async function refetchReserveItem(graveId) {
        if (!graveId) return null;

        try {
            const res = await fetch(`${API_URL}/${encodeURIComponent(graveId)}`, {
                headers: { 'Accept': 'application/json' },
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!res.ok) return null;

            const json = await res.json().catch(() => null);
            if (!json || json.success === false) return null;

            const payload = (json && json.data) ? json.data : json;
            const itemData = (payload && payload.item) ? payload.item : payload;
            return flattenItem(itemData);        
        } catch (err) {
            console.warn('[reserve.js] refetch item failed:', err);
            return null;
        }
    }

    function render() {
        renderRows();
        renderPagination();
    }

    function renderRows() {
        els.tbody.innerHTML = '';

        if (!state.items.length) {
            if (els.noData) {
                if (state.loading) {
                    els.noData.style.display = 'none';
                } else {
                    showEmptyState();
                }
            }
            return;
        }

        if (els.noData) els.noData.style.display = 'none';

        const fragment = document.createDocumentFragment();

        state.items.forEach((item) => {
            const tr = document.createElement('tr');
            tr.dataset.graveId = item.grave_id;
            tr.dataset.type = item.type;
            tr.classList.add('reserveRow', `type-${item.type || 'unknown'}`);

            const nameCell = escapeHtml(item.deceased_name || '-');

            const blockParts = [item.block_name, item.grave_code].filter(Boolean);
            const blockCell = blockParts.length ? escapeHtml(blockParts.join(' - ')) : '-';

            const expirationCell = formatDate(item.lease_expiration_date);
            const contactPerson = escapeHtml(item.contact_person_name || '-');
            const phoneCell = renderPhoneCell(item);
            const remarksCell = escapeHtml(getRemarks(item) || '-');

            let actionButtons = '';

            if (item.type === 'expiring' || item.type === 'expired') {
                actionButtons += `
          <button
            type="button"
            class="viewBtn viewActionBtn"
            data-grave-id="${item.grave_id}"
            title="View Details"
            aria-label="View Details"
          >
            <i class="fas fa-file-lines"></i>
          </button>
        `;
            }

            actionButtons += `
        <button
          type="button"
          class="addBtn reserveActionBtn"
          data-grave-id="${item.grave_id}"
          title="Reserve"
          aria-label="Reserve"
        >
          <i class="fas fa-plus"></i>
        </button>
      `;

            const actionCell = `<div class="actions">${actionButtons}</div>`;

            tr.innerHTML = `
        <td>${nameCell}</td>
        <td>${blockCell}</td>
        <td>${expirationCell}</td>
        <td>${contactPerson}</td>
        <td>${phoneCell}</td>
        <td class="remarksCell">${remarksCell}</td>
        <td class="actionCell">${actionCell}</td>
      `;

            fragment.appendChild(tr);
        });

        els.tbody.appendChild(fragment);

        els.tbody.querySelectorAll('.reserveActionBtn').forEach((btn) => {
            btn.addEventListener('click', handleReserveClick);
        });
        els.tbody.querySelectorAll('.viewActionBtn').forEach((btn) => {
            btn.addEventListener('click', handleViewClick);
        });
    }

    function renderPagination() {
        els.currentPageLabel.textContent = state.page;
        els.totalPagesLabel.textContent = state.totalPages;

        els.prevBtn.disabled = state.loading || state.page <= 1;
        els.nextBtn.disabled = state.loading || state.page >= state.totalPages;

        if (!els.carouselTrack) return;
        els.carouselTrack.innerHTML = '';

        const total = state.totalPages;
        if (total < 1) return;

        const windowSize = PAGINATION_WINDOW;
        let start = Math.max(1, state.page - Math.floor(windowSize / 2));
        let end = Math.min(total, start + windowSize - 1);
        start = Math.max(1, end - windowSize + 1);

        if (start > 1) {
            els.carouselTrack.appendChild(makePageBtn(1));
            if (start > 2) els.carouselTrack.appendChild(makeEllipsis());
        }

        for (let p = start; p <= end; p++) {
            els.carouselTrack.appendChild(makePageBtn(p));
        }

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

    function handleReserveClick(event) {
        const btn = event.currentTarget;
        const graveId = Number(btn.dataset.graveId);
        const item = state.items.find((row) => Number(row.grave_id) === graveId);
        if (!item) return;
        openReserveModal(item);
    }

    function handleViewClick(event) {
        const btn = event.currentTarget;
        const graveId = Number(btn.dataset.graveId);
        const item = state.items.find((row) => Number(row.grave_id) === graveId);
        if (!item) return;
        openEditOldOccupant(item);
    }

    async function openEditOldOccupant(item) {
        const fresh = await refetchReserveItem(item.grave_id);
        const payload = fresh || item;

        if (typeof window.openEditOldOccupantModal === 'function') {
            window.openEditOldOccupantModal(payload);
            return;
        }
        if (typeof window.openReserveBurialModal === 'function') {
            window.openReserveBurialModal(payload);
            return;
        }
        document.dispatchEvent(new CustomEvent('reserve:edit-old', { detail: payload }));
    }

    function handleSmsClick(event) {
        const link = event.target.closest('[data-action="sms"]');
        if (!link || !els.tbody.contains(link)) return;
        event.preventDefault();

        const graveId = Number(link.dataset.graveId);
        const item = state.items.find((row) => Number(row.grave_id) === graveId);
        if (!item) return;

        const phone = String(item.contact_person_phone_number || '').trim();
        if (!phone) {
            notify('warning', 'This reservation has no contact number on file.');
            return;
        }

        if (typeof window.openSmsModal !== 'function') {
            console.warn('[reserve.js] openSmsModal is not available — load sms_notification.js.');
            notify('error', 'SMS feature is not available right now.');
            return;
        }

        const message = buildSmsMessage(item);
        window.openSmsModal(phone, message);
    }

    function openReserveModal(item) {
        if (typeof window.openReserveBurialModal === 'function') {
            window.openReserveBurialModal(item);
            return;
        }
        if (window.ReserveBurialModal && typeof window.ReserveBurialModal.open === 'function') {
            window.ReserveBurialModal.open('add', item);
            return;
        }
        if (typeof window.openBurialModal === 'function') {
            window.openBurialModal(item);
            return;
        }
        document.dispatchEvent(new CustomEvent('reserve:open', { detail: item }));
    }

    async function openViewModal(item) {
        const fresh = await refetchReserveItem(item.grave_id);
        const payload = fresh || item;

        if (typeof window.openViewBurialModal === 'function') {
            window.openViewBurialModal(payload);
            return;
        }
        if (window.ReserveBurialModal && typeof window.ReserveBurialModal.open === 'function') {
            window.ReserveBurialModal.open('view', payload);
            return;
        }
        document.dispatchEvent(new CustomEvent('reserve:view', { detail: payload }));
    }

    // ------------------------------------------------------------------
    // CREATE RESERVATION (POST /reserve.php)
    //
    // The modal dispatches `reserve_burial_modal:save` with { mode, data }.
    // `data` is the exact payload the PHP endpoint expects (N fields +
    // either `grave_id`/`grave_code` for vacant OR `old_interment_id` +
    // `old_new_status` for replacement).
    //
    // NOTE: The old `reserve_burial_modal:update` flow was removed. The
    // new PHP treats reservations as FROZEN — to change one, cancel it in
    // monitor.php and create a new one.
    // ------------------------------------------------------------------
    document.addEventListener('reserve_burial_modal:save', async (event) => {
        const detail = event.detail || {};
        if (detail.mode !== 'add') return;

        const payload = detail.data || {};
        if (!payload || typeof payload !== 'object') {
            console.warn('[reserve.js] reserve_burial_modal:save missing payload.');
            if (typeof detail.onError === 'function') detail.onError();
            return;
        }

        try {
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                credentials: 'same-origin',
                body: JSON.stringify(payload),
            });

            const json = await res.json().catch(() => null);
            if (!res.ok || (json && json.success === false)) {
                const msg = (json && (json.message || json.error)) || `Save failed (${res.status})`;
                throw new Error(msg);
            }

            const data = (json && json.data) ? json.data : {};
            const pendingId = (data.pending_interment_id != null)
                ? data.pending_interment_id
                : '—';
            console.log('[reserve.js] Reservation created. pending_interment_id =', pendingId, data);

            await fetchReservations();

            notify('success', 'Reservation created successfully.');

            // CHANGED: notify the modal (it stays open — see handleSubmit).
            if (typeof detail.onSuccess === 'function') detail.onSuccess(data);
        } catch (err) {
            console.error('[reserve.js] Failed to create reservation:', err);
            notify('error', err.message || 'Failed to create reservation.');

            // CHANGED: let the modal re-enable its Save button.
            if (typeof detail.onError === 'function') detail.onError(err);
        }
    });

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
            if (value.length > 0 && value.length < MIN_SEARCH_LENGTH) return;

            state.search = value;
            state.page = 1;
            fetchReservations();
        });
    }

    if (els.filterBtn) {
        els.filterBtn.addEventListener('click', (event) => {
            event.preventDefault();
            clearTimeout(searchTimer);

            if (els.searchInput) {
                const value = els.searchInput.value.trim();
                if (value.length === 0 || value.length >= MIN_SEARCH_LENGTH) {
                    state.search = value;
                }
            }
            if (els.statusFilter) {
                state.status = els.statusFilter.value || 'all';
            }

            state.page = 1;
            fetchReservations();
        });
    }

    if (els.prevBtn) {
        els.prevBtn.addEventListener('click', () => goToPage(state.page - 1));
    }
    if (els.nextBtn) {
        els.nextBtn.addEventListener('click', () => goToPage(state.page + 1));
    }

    els.tbody.addEventListener('click', handleSmsClick);

    window.ReserveTable = {
        refresh: () => fetchReservations(),
        reload: () => fetchReservations(),
        setStatus(status) {
            state.status = status || 'all';
            if (els.statusFilter) els.statusFilter.value = state.status;
            state.page = 1;
            return fetchReservations();
        },
        setSearch(term) {
            state.search = String(term || '').trim();
            if (els.searchInput) els.searchInput.value = state.search;
            toggleSearchClear(state.search);
            state.page = 1;
            return fetchReservations();
        },
        goToPage,
        getItem(graveId) {
            return state.items.find((row) => Number(row.grave_id) === Number(graveId)) || null;
        },
        getState() {
            return { ...state };
        },
    };

    if (els.statusFilter && els.statusFilter.value) {
        state.status = els.statusFilter.value || 'all';
    }
    if (els.searchInput && els.searchInput.value) {
        const v = els.searchInput.value.trim();
        if (v.length === 0 || v.length >= MIN_SEARCH_LENGTH) state.search = v;
        toggleSearchClear(v);
    }

    if (els.noData) els.noData.style.display = 'none';

    fetchReservations();
})();