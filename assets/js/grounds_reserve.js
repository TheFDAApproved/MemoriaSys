/**
 * grounds_reserve.js — Read-only Reserve page for ROLE_GROUNDS.
 *
 * Talks to the existing api/reserve.php (GET only).
 * Renders 4 columns: Block · Grave Code · Expiration Date · Status.
 * No action buttons, no modals, no SMS, no writes.
 */
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
        statusFilter: document.getElementById('status_filter'),
        filterBtn: document.getElementById('filter_btn'),
        currentPageLabel: document.getElementById('current_page_num'),
        totalPagesLabel: document.getElementById('total_pages_num'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
        carouselViewport: document.getElementById('carousel_viewport'),
    };

    if (!els.tbody) {
        console.error('[grounds_reserve.js] Target tbody #reservation not found.');
        return;
    }

    // ------------------------------------------------------------------
    // Flatten nested API items {type, grave:{...}, interment:{...}|null}
    // into the shape this page needs.
    // ------------------------------------------------------------------
    function flattenItem(raw) {
        if (!raw || typeof raw !== 'object') return null;

        const isFlat = raw.grave === undefined && raw.grave_id !== undefined;
        const g = isFlat ? raw : (raw.grave || {});
        const i = isFlat ? raw : (raw.interment || null);
        const hasI = isFlat
            ? (raw.interment_id != null)
            : !!(i && i.interment_id != null);

        const pick = (obj, key) => (obj && obj[key] != null) ? obj[key] : null;

        return {
            type: raw.type || null,
            grave_id: pick(g, 'grave_id'),
            grave_code: pick(g, 'grave_code'),
            block_name: pick(g, 'block_name'),
            grave_status: pick(g, 'grave_status'),
            lease_expiration_date: hasI ? i.lease_expiration_date : null,
        };
    }

    function getStatusLabel(type) {
        switch (type) {
            case 'vacant':   return 'Available';
            case 'expiring': return 'Expiring';
            case 'expired':  return 'Expired';
            default:         return '-';
        }
    }

    // ------------------------------------------------------------------
    // Safe rendering helpers
    // ------------------------------------------------------------------
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

    function notify(kind, message) {
        if (!message) return;
        const rawText = String(message);
        const displayText = (kind === 'error' && looksRawMessage(rawText))
            ? GENERIC_ERROR
            : rawText;

        if (typeof window.showAlertTOP === 'function') {
            const type =
                kind === 'success' ? 'success'
                    : kind === 'error' ? 'error'
                        : kind === 'warning' ? 'warning'
                            : 'info';
            window.showAlertTOP(displayText, type);
            return;
        }

        if (kind === 'error') console.error('[grounds_reserve.js]', rawText);
        else console.log('[grounds_reserve.js]', rawText);
    }

    // ------------------------------------------------------------------
    // Loading / empty / error states
    // ------------------------------------------------------------------
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
        els.noData.innerHTML =
            '<i class="fas fa-inbox"></i> No data found';
        els.noData.style.display = '';
    }

    function showError(message) {
        if (!els.noData) return;
        const display = (message && !looksRawMessage(message)) ? message : GENERIC_ERROR;
        els.noData.innerHTML =
            `<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(display)}`;
        els.noData.style.display = '';
    }

    // ------------------------------------------------------------------
    // Fetch (GET only)
    // ------------------------------------------------------------------
    async function fetchSpaces() {
        if (state.controller) state.controller.abort();
        state.controller = new AbortController();

        const params = new URLSearchParams();
        params.set('page', String(state.page));
        params.set('limit', String(state.limit));
        if (state.search) params.set('search_term', state.search);
        if (state.status && state.status !== 'all') params.set('status', state.status);

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
            renderRows();
            renderPagination();
            showError(loadError.message || 'Failed to load burial spaces.');
        } else {
            renderRows();
            renderPagination();
        }
    }

    // ------------------------------------------------------------------
    // Render rows — 4 columns, no actions
    // ------------------------------------------------------------------
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

            const blockCell = escapeHtml(item.block_name || '-');
            const graveCodeCell = escapeHtml(item.grave_code || '-');
            const expirationCell = formatDate(item.lease_expiration_date);

            const statusLabel = getStatusLabel(item.type);
            const statusClass = `statusPill status-${item.type || 'unknown'}`;

            tr.innerHTML = `
                <td>${blockCell}</td>
                <td>${graveCodeCell}</td>
                <td>${expirationCell}</td>
                <td><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
            `;

            fragment.appendChild(tr);
        });

        els.tbody.appendChild(fragment);
    }

    // ------------------------------------------------------------------
    // Pagination
    // ------------------------------------------------------------------
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
        fetchSpaces();
    }

    // ------------------------------------------------------------------
    // Search + filter
    // ------------------------------------------------------------------
    let searchTimer = null;

    if (els.searchInput) {
        els.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const value = els.searchInput.value.trim();

                if (value.length === 0) {
                    if (state.search !== '') {
                        state.search = '';
                        state.page = 1;
                        fetchSpaces();
                    }
                    return;
                }

                if (value.length < MIN_SEARCH_LENGTH) return;
                if (value === state.search) return;

                state.search = value;
                state.page = 1;
                fetchSpaces();
            }, SEARCH_DEBOUNCE_MS);
        });

        els.searchInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            clearTimeout(searchTimer);

            const value = els.searchInput.value.trim();

            if (value.length > 0 && value.length < MIN_SEARCH_LENGTH) {
                notify(
                    'warning',
                    `Please enter at least ${MIN_SEARCH_LENGTH} characters to search — ` +
                    `you've only typed ${value.length}.`
                );
                return;
            }

            state.search = value;
            state.page = 1;
            fetchSpaces();
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
            fetchSpaces();
        });
    }

    if (els.prevBtn) {
        els.prevBtn.addEventListener('click', () => goToPage(state.page - 1));
    }
    if (els.nextBtn) {
        els.nextBtn.addEventListener('click', () => goToPage(state.page + 1));
    }

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------
    if (els.noData) els.noData.style.display = 'none';
    fetchSpaces();
})();