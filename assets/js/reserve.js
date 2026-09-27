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

    const setLoading = (isLoading) => {
        state.loading = isLoading;
        const wrapper = els.tbody.closest('.tableWrapper');
        if (wrapper) wrapper.classList.toggle('isLoading', isLoading);
    };

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

        setLoading(true);

        try {
            const response = await fetch(`${API_URL}?${params.toString()}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                credentials: 'same-origin',
                signal: state.controller.signal,
            });

            const json = await response.json().catch(() => null);

            if (!response.ok) {
                const msg = (json && (json.message || json.error)) || `Request failed (${response.status})`;
                throw new Error(msg);
            }
            if (json && json.success === false) {
                throw new Error(json.message || 'Request failed.');
            }

            const payload = (json && json.data) ? json.data : (json || {});

            state.items = Array.isArray(payload.items) ? payload.items : [];
            const pg = payload.pagination || {};
            state.page = Number(pg.current_page) || state.page;
            state.totalPages = Math.max(1, Number(pg.total_pages) || 1);
            state.totalRecords = Number(pg.total_records) || state.items.length;

            render();
        } catch (err) {
            if (err.name === 'AbortError') return;

            console.error('[reserve.js] Fetch error:', err);
            state.items = [];
            state.totalPages = 1;
            state.totalRecords = 0;
            render();

            showError(err.message || 'Failed to load reservations.');
        } finally {
            setLoading(false);
        }
    }

    async function refetchReserveItem(graveId) {
        if (!graveId) return null;

        try {
            const res = await fetch(`${API_URL}/${encodeURIComponent(graveId)}`, {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!res.ok) return null;

            const json = await res.json().catch(() => null);
            if (!json || json.success === false) return null;

            const payload = (json && json.data) ? json.data : json;
            return (payload && payload.item) ? payload.item : null;
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
            els.noData.style.display = '';
            return;
        }
        els.noData.style.display = 'none';

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
            const contactPhone = escapeHtml(item.contact_person_phone_number || '-');
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
        <td>${contactPhone}</td>
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

    function showError(message) {
        if (!els.noData) return;
        els.noData.innerHTML =
            `<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(message)}`;
        els.noData.style.display = '';
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
        openViewModal(item);
    }

    function openReserveModal(item) {
        if (typeof window.openReserveBurialModal === 'function') {
            window.openReserveBurialModal(item);
            return;
        }
        if (window.ReserveBurialModal && typeof window.ReserveBurialModal.open === 'function') {
            window.ReserveBurialModal.open(item);
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
        if (window.ReserveBurialModal && typeof window.ReserveBurialModal.view === 'function') {
            window.ReserveBurialModal.view(payload);
            return;
        }
        document.dispatchEvent(new CustomEvent('reserve:view', { detail: payload }));
    }

    document.addEventListener('reserve_burial_modal:update', async (event) => {
        const detail = event.detail || {};
        const oldIntermentId = detail.old_interment_id;
        if (!oldIntermentId) {
            console.warn('[reserve.js] reserve_burial_modal:update missing old_interment_id.');
            return;
        }

        const payload = {
            old_interment_id: oldIntermentId,
            target_grave_id: detail.target_grave_id || null,
            block_name: detail.data?.block_name || '',
            grave_code: detail.data?.grave_code || '',
            burial_type: detail.data?.burial_type || '',
            assistance_type: detail.data?.assistance_type || '',
            remarks: detail.data?.remarks || '',
            date_interment: detail.data?.date_interment || '',
            expiration_date: detail.data?.expiration_date || '',
            exhumation_permit_number: detail.data?.exhumation_permit_number || '',
            transfer_permit_number: detail.data?.transfer_permit_number || '',
        };

        try {
            const res = await fetch(`${API_URL}?action=update_reservation_plan`, {
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

            await fetchReservations();

            notify('success', 'Changes saved successfully.');
        } catch (err) {
            console.error('[reserve.js] Failed to save reservation plan:', err);
            notify('error', err.message || 'Failed to save reservation plan.');
        }
    });

    document.addEventListener('reserve_burial_modal:save', async (event) => {
        const detail = event.detail || {};
        if (detail.mode !== 'add') return;

        const payload = detail.data || {};
        if (!payload || typeof payload !== 'object') {
            console.warn('[reserve.js] reserve_burial_modal:save missing payload.');
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
            const pendingId = data.new_interment_id != null ? data.new_interment_id : '—';
            console.log('[reserve.js] Pending interment created:', pendingId, data);

            await fetchReservations();

            notify('success', 'Reservation saved as PENDING.');
        } catch (err) {
            console.error('[reserve.js] Failed to create reservation:', err);
            notify('error', err.message || 'Failed to create reservation.');
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

    fetchReservations();
})();