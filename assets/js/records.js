(function (global) {
    'use strict';

    const CONFIG = {
        ENDPOINT: 'api/records.php',
        DEFAULT_LIMIT: 100,
        MIN_SEARCH_LENGTH: 3,
        SEARCH_DEBOUNCE_MS: 350,
        PAGINATION_WINDOW: 5,
        REQUEST_TIMEOUT_MS: 30000,
    };

    const state = {
        page: 1,
        limit: CONFIG.DEFAULT_LIMIT,
        search: '',
        totalPages: 1,
        totalRecords: 0,
        items: [],
        loading: false,
        controller: null,
        lastError: null,
    };

    const els = {
        tbody: null,
        noData: null,
        searchInput: null,
        prevBtn: null,
        nextBtn: null,
        currentPageLabel: null,
        totalPagesLabel: null,
        carouselTrack: null,
        carouselViewport: null,
        addBtn: null,
        tableWrapper: null,
    };

    let searchTimer = null;
    // NEW: ref to the injected "clear search" (X) button.
    let searchClearBtn = null;
    let booted = false;

    // NEW: global lock so only one modal-opening action can run at a time.
    // Prevents double-open if the user clicks two different buttons quickly.
    let actionInProgress = false;

    // ---------- NEW: button loading state ----------

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

    // Runs `fn` while showing a spinner on `btn`. Guarantees cleanup on
    // success OR failure. Safe against double-clicks and cross-button
    // re-entrancy (global actionInProgress flag).
    async function runAction(btn, fn) {
        if (actionInProgress) return;
        if (!btn || btn.dataset.loading === 'true') return;

        actionInProgress = true;
        const prevDisabled = btn.disabled;

        // Only give the button a containing block for the ::after spinner
        // if it isn't positioned already. Floating / absolutely-positioned
        // buttons (e.g. the "+" add button) already are, and overriding
        // their position would make them jump mid-load.
        const wasStatic = window.getComputedStyle(btn).position === 'static';
        if (wasStatic) btn.style.position = 'relative';

        btn.dataset.loading = 'true';
        btn.classList.add('records-btn-loading');
        btn.disabled = true;

        try {
            // Yield one frame so the loading state actually paints before
            // fn runs (important when fn is mostly synchronous).
            await new Promise((r) => requestAnimationFrame(() => r()));
            await fn();
        } catch (err) {
            console.error('[records.js] Action failed:', err);
        } finally {
            btn.classList.remove('records-btn-loading');
            btn.disabled = prevDisabled;
            if (wasStatic) btn.style.position = '';
            delete btn.dataset.loading;
            actionInProgress = false;
        }
    }

    // ---------- formatting helpers ----------

    // Helper to strictly enforce only Active or Inactive statuses
    const isStatusValid = (status) => {
        const s = String(status || '').toLowerCase().trim();
        return s === 'active' || s === 'inactive';
    };

    const escapeHtml = (value) => {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    const dash = (value) => {
        if (value === null || value === undefined) return '—';
        const s = String(value).trim();
        return s === '' ? '—' : escapeHtml(s);
    };

    const formatDate = (value) => {
        if (!value) return '—';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return escapeHtml(value);
        return d.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
        });
    };

    // ---- raw-error sanitization ----
    // Prevents ngrok/proxy HTML pages, bare HTTP status codes, JSON parse
    // failures, and network failures from reaching showAlertTOP.
    const GENERIC_ERROR = 'Something went wrong. Please try again.';

    const looksRawMessage = (text) => {
        if (!text) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;                       // HTML body
        if (/ERR_NGROK_|ngrok/i.test(t)) return true;                         // ngrok
        if (/^HTTP\s+\d{3}/i.test(t)) return true;                            // bare "HTTP 502"
        if (/^Request failed \(\d{3}\)$/i.test(t)) return true;               // our own fallback
        if (/non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(t)) return true;
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
        if (/^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(t)) return true;
        if (t.length > 200) return true;                                      // giant dumps
        return false;
    };

    function notify(kind, message) {
        if (!message) return;
        const rawText = String(message);
        const displayText = (kind === 'error' && looksRawMessage(rawText))
            ? GENERIC_ERROR
            : rawText;

        const type =
            kind === 'success' ? 'success'
                : kind === 'error' ? 'error'
                    : kind === 'warning' ? 'warning'
                        : 'info';

        window.showAlertTOP(displayText, type);

        if (kind === 'error') console.error('[records.js]', rawText);
        else console.log('[records.js]', rawText);
    }

    // Single source of truth for the "search term is too short" warning.
    // Routed through notify() so it shows up via showAlertTOP(text, 'warning').
    function warnSearchTooShort(value) {
        const min = CONFIG.MIN_SEARCH_LENGTH;
        const len = String(value || '').trim().length;
        notify(
            'warning',
            `Please enter at least ${min} characters to search — ` +
            `you've only typed ${len}.`
        );
    }

    // ---------- search clear (X) button ----------

    // NEW: inject the "clear search" button inside the search box, matching
    // the behaviour of reserve.js. Idempotent — calling it twice is safe.
    function mountSearchClearBtn() {
        if (!els.searchInput) return;

        // Prefer the .searchBox wrapper if present, otherwise fall back to the
        // input's direct parent so this still works on simpler layouts.
        const box = els.searchInput.closest('.searchBox') || els.searchInput.parentElement;
        if (!box) return;

        // Don't mount twice.
        const existing = box.querySelector('.searchClearBtn');
        if (existing) {
            searchClearBtn = existing;
            toggleSearchClear(els.searchInput.value);
            return;
        }

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
                fetchRecords();
            }
        });

        toggleSearchClear(els.searchInput.value);
    }

    // NEW: show/hide the X based on whether the field has content.
    function toggleSearchClear(value) {
        if (!searchClearBtn) return;
        searchClearBtn.classList.toggle('is-visible', String(value || '').length > 0);
    }

    // ---------- HTTP ----------

    async function call(method, path = '', { body = null, query = null, signal = null } = {}) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

        let url = CONFIG.ENDPOINT + (path || '');
        if (query && typeof query === 'object') {
            const usp = new URLSearchParams();
            for (const [k, v] of Object.entries(query)) {
                if (v === undefined || v === null || v === '') continue;
                usp.append(k, v);
            }
            const qs = usp.toString();
            if (qs) url += '?' + qs;
        }

        const opts = {
            method,
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        };

        if (body !== null && method !== 'GET' && method !== 'HEAD') {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }

        let response;
        try {
            response = await fetch(url, opts);
        } catch (err) {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (err.name === 'AbortError') {
                const cancelled = new Error('Request cancelled.');
                cancelled.cancelled = true;
                throw cancelled;
            }
            throw new Error('Network error — could not reach the server.');
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }

        let payload = null;
        const ct = response.headers.get('content-type') || '';
        try {
            if (ct.includes('application/json')) {
                payload = await response.json();
            } else {
                const text = await response.text();
                if (text && /^[\s]*[{[]/.test(text)) {
                    try { payload = JSON.parse(text); } catch (_) { /* not JSON */ }
                } else {
                    payload = text || null;
                }
            }
        } catch (_) {
            payload = null;
        }

        if (response.status === 401 || response.status === 403) {
            document.dispatchEvent(new CustomEvent('records:unauthorized', {
                detail: { status: response.status, payload },
            }));
        }

        const envelope =
            payload && typeof payload === 'object' && 'status' in payload
                ? payload
                : null;

        const httpOk = response.ok;
        const logicalOk = !envelope || envelope.status < 400;

        if (!httpOk || !logicalOk) {
            const message =
                (envelope && envelope.message) ||
                (payload && payload.message) ||
                (typeof payload === 'string' ? payload : '') ||
                `Request failed (${response.status})`;

            const error = new Error(message);
            error.status = response.status;
            error.payload = envelope || payload;
            throw error;
        }

        return envelope ? envelope.data : payload;
    }

    const RecordsAPI = {
        list(opts = {}) {
            const query = {};
            if (opts.page != null) query.page = opts.page;
            if (opts.limit != null) query.limit = opts.limit;
            if (opts.search_term) query.search_term = opts.search_term;
            return call('GET', '', { query });
        },
        get(id) {
            if (id == null) return Promise.reject(new Error('interment_id is required.'));
            return call('GET', `/${encodeURIComponent(id)}`);
        },
        create(data) {
            return call('POST', '', { body: data });
        },
        update(id, data) {
            if (id == null) return Promise.reject(new Error('interment_id is required.'));
            return call('PUT', `/${encodeURIComponent(id)}`, { body: data });
        },
        remove(id) {
            if (id == null) return Promise.reject(new Error('interment_id is required.'));
            return call('DELETE', `/${encodeURIComponent(id)}`);
        },
        refresh: () => fetchRecords(),
        goToPage,
        setSearch,
        getState: () => ({ ...state }),
        getItem: (id) =>
            state.items.find((row) => Number(row.interment_id) === Number(id)) || null,
        init,
    };

    // ---------- DOM detection ----------

    function autoDetect() {
        if (!els.tbody) {
            els.tbody =
                document.getElementById('burial_table_body') ||
                document.getElementById('records_body') ||
                document.querySelector('#burial_records tbody');
        }
        if (!els.noData) els.noData = document.getElementById('burial_no_data');
        if (!els.searchInput) els.searchInput = document.getElementById('user_search');
        if (!els.prevBtn) els.prevBtn = document.getElementById('prev_page_btn');
        if (!els.nextBtn) els.nextBtn = document.getElementById('next_page_btn');
        if (!els.currentPageLabel) els.currentPageLabel = document.getElementById('current_page_num');
        if (!els.totalPagesLabel) els.totalPagesLabel = document.getElementById('total_pages_num');
        if (!els.carouselTrack) els.carouselTrack = document.getElementById('carousel_track');
        if (!els.carouselViewport) els.carouselViewport = document.getElementById('carousel_viewport');
        if (!els.addBtn) els.addBtn = document.getElementById('open_add_modal_btn');

        if (!els.tableWrapper && els.tbody) {
            els.tableWrapper =
                els.tbody.closest('.tableScrollWrapper') ||
                els.tbody.closest('.tableWrapper') ||
                els.tbody.closest('table');
        }
    }

    function init(overrides = {}) {
        Object.assign(els, overrides || {});
        autoDetect();
        bindEvents();
        return fetchRecords();
    }

    // ---------- fetch ----------

    async function fetchRecords() {
        if (!els.tbody) {
            return RecordsAPI.list({
                page: state.page,
                limit: state.limit,
                search_term: state.search,
            });
        }

        if (state.controller) state.controller.abort();
        state.controller = new AbortController();

        setLoading(true);
        state.lastError = null;

        let result;
        try {
            result = await call('GET', '', {
                query: {
                    page: state.page,
                    limit: state.limit,
                    search_term: state.search || undefined,
                },
                signal: state.controller.signal,
            });
        } catch (err) {
            if (err.cancelled) return;
            setLoading(false);

            state.items = [];
            state.totalPages = 1;
            state.totalRecords = 0;
            state.lastError = err;

            renderRows();
            renderPagination();
            notify('error', err.message || 'Failed to load records.');
            document.dispatchEvent(new CustomEvent('records:error', { detail: { error: err } }));
            return;
        }

        const data = result || {};
        const pagination = data.pagination || {};

        // Filter both the main items and their nested history items
        state.items = Array.isArray(data.interments) 
        ? data.interments
            .filter(item => isStatusValid(item.status))
            .map(item => {
                if (Array.isArray(item.history)) {
                    item.history = item.history.filter(h => isStatusValid(h.status));
                }
                return item;
            })
        : [];
        
        state.page = Number(pagination.current_page) || state.page;
        state.totalPages = Math.max(1, Number(pagination.total_pages) || 1);
        state.totalRecords = Number(pagination.total_records) || state.items.length;

        setLoading(false);
        renderRows();
        renderPagination();

        document.dispatchEvent(new CustomEvent('records:loaded', {
            detail: {
                items: state.items,
                pagination: {
                    current_page: state.page,
                    per_page: state.limit,
                    total_records: state.totalRecords,
                    total_pages: state.totalPages,
                },
            },
        }));

        return result;
    }

    function setLoading(isLoading) {
        state.loading = isLoading;

        if (els.tableWrapper) els.tableWrapper.classList.toggle('isLoading', !!isLoading);
        else if (els.tbody) els.tbody.classList.toggle('isLoading', !!isLoading);

        if (isLoading && els.noData) els.noData.style.display = 'none';
    }

    // ---------- row rendering ----------

    function buildContactAddress(item) {
        const parts = [
            item.contact_person_address,
            item.contact_person_address_barangay,
        ].filter((p) => p && String(p).trim() !== '');
        return parts.length ? parts.join(', ') : '—';
    }

    function splitHistoryName(item) {
        const raw = String(item.deceased_name || '').trim();
        const m = raw.match(/^\[History\s+([^\]]+)\]\s*(.*)$/i);
        if (m) return { badge: `History ${m[1]}`, name: m[2] };
        if (item.event_date) return { badge: `History ${item.event_date}`, name: raw };
        return { badge: '', name: raw };
    }

    function buildSmsMessage(item) {
        const contact = String(item && item.contact_person_name ? item.contact_person_name : '').trim();
        return contact ? `Greetings ${contact}.` : 'Greetings.';
    }

    function renderPhoneCell(item) {
        const raw = item ? item.contact_person_phone_number : null;
        if (raw === null || raw === undefined) return '—';
        const s = String(raw).trim();
        if (s === '') return '—';

        return (
            '<a href="#" class="smsPhoneLink" data-action="sms"' +
            ' data-id="' + escapeHtml(item.interment_id) + '"' +
            ' title="Send SMS">' +
            escapeHtml(s) +
            '</a>'
        );
    }

    function renderMainRow(item, hasHistory) {
        const id = item.interment_id;

        const controlCell = hasHistory
            ? `<div class="controlNoCell">
           <button type="button"
                   class="historyToggle"
                   aria-expanded="false"
                   aria-label="Toggle transfer history"
                   title="Toggle transfer history">
             <i class="fas fa-chevron-right"></i>
           </button>
           <span class="controlNoText">${dash(item.control_number)}</span>
         </div>`
            : dash(item.control_number);

        // NOTE: inline onclick="memoria_certificate(...)" was removed from the
        // print button — the delegated handler in onRowActionClick now owns
        // the call so we can show a loading state. data-id was added so the
        // handler can resolve it.
        const actionButtons = `
        <button type="button" class="viewBtn" data-action="view" data-id="${id}" title="View / Edit" aria-label="View / Edit">
          <i class="fas fa-file-lines"></i>
        </button>
        <button type="button" class="printBtn" data-action="print" data-id="${id}" title="Print" aria-label="Print">
          <i class="fas fa-print"></i>
        </button>
        <button type="button" class="deleteBtn" data-action="delete" data-id="${id}" title="Delete" aria-label="Delete">
          <i class="fas fa-trash"></i>
        </button>`;

        const rowClass = `recordRow${hasHistory ? ' hasHistory' : ''}`;

        return `
      <tr class="${rowClass}" data-id="${id}">
        <td>${controlCell}</td>
        <td>${dash(item.deceased_name)}</td>
        <td>${dash(item.deceased_sex)}</td>
        <td>${formatDate(item.deceased_date_of_birth)}</td>
        <td>${dash(item.last_known_address)}</td>
        <td>${formatDate(item.date_buried)}</td>
        <td>${dash(item.block_name)}</td>
        <td>${dash(item.grave_code)}</td>
        <td>${formatDate(item.lease_expiration_date)}</td>
        <td>${dash(item.contact_person_name)}</td>
        <td>${renderPhoneCell(item)}</td>
        <td>${escapeHtml(buildContactAddress(item))}</td>
        <td>${dash(item.status)}</td>
        <td class="remarksCell">${dash(item.remarks)}</td>
        <td class="actionCell"><div class="actions">${actionButtons}</div></td>
      </tr>`;
    }

    function renderHistoryRow(item, parentId, visible = false) {
        const { badge, name } = splitHistoryName(item);

        const badgeCell = badge
            ? `<span class="historyBadge">
           <i class="fas fa-clock-rotate-left"></i>${escapeHtml(badge)}
         </span>`
            : '';

        const classes = visible ? 'historyRow visible' : 'historyRow';
        const styleAttr = visible ? '' : ' style="display:none"';

        const blockName = item.from_grave ? item.from_grave.block_name : item.block_name;
        const graveCode = item.from_grave ? item.from_grave.grave_code : item.grave_code;

        return `
      <tr class="${classes}" data-parent-id="${parentId}"${styleAttr}>
        <td>${badgeCell}</td>
        <td>${dash(name)}</td>
        <td>${dash(item.deceased_sex)}</td>
        <td>${formatDate(item.deceased_date_of_birth)}</td>
        <td>${dash(item.last_known_address)}</td>
        <td>${formatDate(item.date_buried)}</td>
        <td>${dash(blockName)}</td>
        <td>${dash(graveCode)}</td>
        <td>${formatDate(item.lease_expiration_date)}</td>
        <td>${dash(item.contact_person_name)}</td>
        <td>${dash(item.contact_person_phone_number)}</td>
        <td>${escapeHtml(buildContactAddress(item))}</td>
        <td>${dash(item.status)}</td>
        <td class="remarksCell">${dash(item.remarks)}</td>
        <td class="actionCell"></td>
      </tr>`;
    }

    // Sort helper — matches PHP's `event_date DESC, history_id DESC`.
    function compareHistoryDesc(a, b) {
        const ta = new Date(a.event_date || 0).getTime();
        const tb = new Date(b.event_date || 0).getTime();
        if (tb !== ta) return tb - ta;
        const ha = Number(a.history_id) || 0;
        const hb = Number(b.history_id) || 0;
        return hb - ha;
    }

    function renderRows() {
        if (!els.tbody) return;

        els.tbody.classList.remove('animate');
        els.tbody.innerHTML = '';

        if (!state.items.length) {
            if (els.noData) {
                els.noData.style.display = (state.loading || state.lastError) ? 'none' : '';
            }
            return;
        }

        if (els.noData) els.noData.style.display = 'none';

        const html = [];

        for (const item of state.items) {
            // The list endpoint returns LIVE rows at the top level, each with
            // a nested `history` array. If a flat history row ever slips in
            // at the top level, skip it — it belongs under its parent.
            if (item.is_history) continue;

            const id = Number(item.interment_id);
            if (!Number.isFinite(id)) continue;

            const history = Array.isArray(item.history)
                ? item.history.slice().sort(compareHistoryDesc)
                : [];

            html.push(renderMainRow(item, history.length > 0));

            for (const h of history) {
                html.push(renderHistoryRow(h, id, false));
            }
        }

        els.tbody.innerHTML = html.join('');
        els.tbody.offsetWidth;
        els.tbody.classList.add('animate');
    }

    // ---------- pagination ----------

    function renderPagination() {
        if (els.currentPageLabel) els.currentPageLabel.textContent = state.page;
        if (els.totalPagesLabel) els.totalPagesLabel.textContent = state.totalPages;

        if (els.prevBtn) els.prevBtn.disabled = state.loading || state.page <= 1;
        if (els.nextBtn) els.nextBtn.disabled = state.loading || state.page >= state.totalPages;

        if (!els.carouselTrack) return;
        els.carouselTrack.innerHTML = '';

        const total = state.totalPages;
        if (total < 1) return;

        const windowSize = CONFIG.PAGINATION_WINDOW;
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
        const target = Math.min(Math.max(1, Number(page) || 1), state.totalPages);
        if (target === state.page || state.loading) return;
        state.page = target;
        fetchRecords();
    }

    function setSearch(term) {
        const value = String(term || '').trim();
        if (value === state.search) return;
        state.search = value;
        state.page = 1;
        if (els.searchInput) els.searchInput.value = value;
        // NEW: keep the X button in sync when search is set programmatically.
        toggleSearchClear(value);
        fetchRecords();
    }

    // ---------- event wiring ----------

    function bindEvents() {
        injectLoadingStyles();

        if (els.searchInput && !els.searchInput.__recordsBound) {
            els.searchInput.__recordsBound = true;

            // NEW: inject the "clear search" X button into the search box.
            mountSearchClearBtn();

            // Typing: still debounced auto-search (unchanged), but NO warning
            // here — short terms are silently ignored until the user hits Enter.
            els.searchInput.addEventListener('input', () => {
                // NEW: reflect field content on the X button immediately,
                // not on the debounce tick, so it feels responsive.
                toggleSearchClear(els.searchInput.value);

                clearTimeout(searchTimer);
                const value = els.searchInput.value.trim();
                searchTimer = setTimeout(() => {
                    if (value.length === 0) { setSearch(''); return; }
                    if (value.length < CONFIG.MIN_SEARCH_LENGTH) return;
                    setSearch(value);
                }, CONFIG.SEARCH_DEBOUNCE_MS);
            });

            // Enter: explicit search submission. If the term is non-empty but
            // too short, warn the user via showAlertTOP instead of silently
            // doing nothing.
            els.searchInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                clearTimeout(searchTimer);

                const value = els.searchInput.value.trim();

                if (value.length === 0) {
                    setSearch('');
                    return;
                }

                if (value.length < CONFIG.MIN_SEARCH_LENGTH) {
                    warnSearchTooShort(value);
                    return;
                }

                setSearch(value);
            });
        }

        if (els.prevBtn && !els.prevBtn.__recordsBound) {
            els.prevBtn.__recordsBound = true;
            els.prevBtn.addEventListener('click', () => goToPage(state.page - 1));
        }
        if (els.nextBtn && !els.nextBtn.__recordsBound) {
            els.nextBtn.__recordsBound = true;
            els.nextBtn.addEventListener('click', () => goToPage(state.page + 1));
        }

        if (els.tbody && !els.tbody.__recordsDelegated) {
            els.tbody.__recordsDelegated = true;
            els.tbody.addEventListener('click', onRowActionClick);
        }

        if (els.addBtn && !els.addBtn.__recordsBound) {
            els.addBtn.__recordsBound = true;
            els.addBtn.addEventListener('click', onAddClick);
        }
    }

    async function onAddClick(e) {
        e.preventDefault();

        const takenControlNos = state.items
            .map((r) => r.control_number)
            .filter(Boolean);

        await runAction(els.addBtn, async () => {
            await global.BurialModal.open('add', {}, { takenControlNos });
        });
    }

    function handleSmsClick(link) {
        const id = Number(link.dataset.id);
        const item = RecordsAPI.getItem(id);
        if (!item) return;

        const phone = String(item.contact_person_phone_number || '').trim();
        if (!phone) {
            notify('warning', 'This record has no contact number on file.');
            return;
        }

        global.openSmsModal(phone, buildSmsMessage(item));
    }

    async function onRowActionClick(e) {
        // SMS link takes priority — must return before row/history toggle logic.
        const smsLink = e.target.closest('[data-action="sms"]');
        if (smsLink && els.tbody.contains(smsLink)) {
            e.preventDefault();
            handleSmsClick(smsLink);
            return;
        }

        const btn = e.target.closest('button[data-action]');
        if (btn && els.tbody.contains(btn)) {
            e.preventDefault();

            const action = btn.dataset.action;
            const id = btn.dataset.id ? Number(btn.dataset.id) : null;
            if (!id) return;

            const item = RecordsAPI.getItem(id);

            if (action === 'view') {
                await runAction(btn, async () => {
                    // Fetch the full record so the modal sees the freshest live
                    // row (single-GET returns flat: index 0 = live, 1..n = history).
                    let fullItem = item;
                    try {
                        const resData = await RecordsAPI.get(id);
                        if (resData && Array.isArray(resData.interments) && resData.interments.length > 0) {
                            fullItem = resData.interments[0];
                        }
                    } catch (err) {
                        console.warn('[records.js] Failed to fetch full item before viewing:', err);
                    }

                    await global.BurialModal.open('view', fullItem, {
                        takenControlNos: state.items
                            .filter((r) => Number(r.interment_id) !== Number(id))
                            .map((r) => r.control_number),
                    });
                });
                return;
            }

            if (action === 'print') {
                await runAction(btn, async () => {
                    // Inline onclick was removed from renderMainRow — the
                    // call now lives here so we can await it and manage the
                    // loading state.
                    if (typeof global.memoria_certificate === 'function') {
                        await Promise.resolve(global.memoria_certificate(id));
                    }
                    document.dispatchEvent(new CustomEvent('records:print', { detail: { item, id } }));
                });
                return;
            }

            if (action === 'delete') {
                await runAction(btn, async () => {
                    await handleDelete(id, item);
                });
                return;
            }
            return;
        }

        const toggle = e.target.closest('.historyToggle');
        if (toggle && els.tbody.contains(toggle)) {
            e.preventDefault();
            toggleHistory(toggle);
            return;
        }

        const row = e.target.closest('tr.recordRow.hasHistory');
        if (row && els.tbody.contains(row) && !e.target.closest('.actionCell')) {
            const rowToggle = row.querySelector('.historyToggle');
            if (rowToggle) toggleHistory(rowToggle);
        }
    }

    function toggleHistory(toggleBtn) {
        const mainRow = toggleBtn.closest('tr.recordRow');
        if (!mainRow) return;

        const id = mainRow.dataset.id;
        const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
        const next = !expanded;

        toggleBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
        mainRow.classList.toggle('expanded', next);

        let sibling = mainRow.nextElementSibling;
        while (
            sibling &&
            sibling.classList.contains('historyRow') &&
            sibling.dataset.parentId === id
        ) {
            if (next) {
                sibling.style.display = '';
                sibling.classList.remove('visible');
                sibling.offsetWidth;
                sibling.classList.add('visible');
            } else {
                sibling.style.display = 'none';
                sibling.classList.remove('visible');
            }
            sibling = sibling.nextElementSibling;
        }
    }

    // ---------- delete ----------

    async function handleDelete(id, item) {
        if (!global.DeleteModal || typeof global.DeleteModal.open !== 'function') {
            const name = item ? item.deceased_name : `#${id}`;
            const ok = global.confirm(`Delete record for "${name}"?`);
            if (!ok) return;

            try { await performDelete(id, item); } catch (_) { /* already notified */ }
            return;
        }

        global.DeleteModal.open({
            controlNo: item ? item.control_number : '',
            deceasedName: item ? item.deceased_name : '',
            blockName: item ? item.block_name : '',
            graveCode: item ? item.grave_code : '',
            onConfirm: () => performDelete(id, item),
        });
    }

    async function performDelete(id, item) {
        let result;
        try {
            result = await RecordsAPI.remove(id);
        } catch (err) {
            notify('error', err.message || 'Failed to delete record.');
            throw err;
        }

        let message = 'Record deleted successfully.';
        if (result && result.grave_freed) {
            message = `Record deleted successfully. Grave ${result.grave_id} is now vacant.`;
        }
        notify('success', message);

        const idx = state.items.findIndex(r => Number(r.interment_id) === Number(id));
        if (idx > -1) {
            state.items.splice(idx, 1);
            state.totalRecords--;
            renderPagination();
        }

        const row = els.tbody.querySelector(`tr.recordRow[data-id="${id}"]`);
        if (row) {
            let sibling = row.nextElementSibling;
            while (sibling && sibling.classList.contains('historyRow') && sibling.dataset.parentId == id) {
                const next = sibling.nextElementSibling;
                sibling.remove();
                sibling = next;
            }
            row.remove();
        }

        if (state.items.length === 0 && els.noData) els.noData.style.display = '';

        document.dispatchEvent(
            new CustomEvent('records:deleted', { detail: { id, result } })
        );

        return result;
    }

    // ---------- save ----------
    async function handleModalSave(event) {
        const detail = event.detail || {};
        const mode = detail.mode;
        const payload = detail.data || {};
        const onSuccess = typeof detail.onSuccess === 'function' ? detail.onSuccess : null;
        const onError = typeof detail.onError === 'function' ? detail.onError : null;

        if (mode === 'view') return;

        if (!payload.control_number || !payload.deceased_name || !payload.assistance_type) {
            notify('error', 'Control Number, Deceased Name and Assistance Type are required.');
            if (onError) onError(new Error('Validation failed.'));
            return;
        }

        if ((payload.status || 'Active') !== 'Active') {
            payload.current_grave_id = null;
        }

        const isEdit = mode === 'edit' && payload.interment_id != null;

        let result;
        try {
            if (isEdit) {
                result = await RecordsAPI.update(payload.interment_id, payload);
                notify('success', 'Changes saved successfully.');
            } else {
                result = await RecordsAPI.create(payload);
                notify('success', 'Record added successfully.');
            }
        } catch (err) {
            notify('error', err.message || 'Failed to save changes.');
            document.dispatchEvent(
                new CustomEvent('records:error', {
                    detail: { error: err, action: isEdit ? 'update' : 'create', payload },
                })
            );
            if (onError) onError(err);
            return;
        }

        let freshItem = null;
        let freshHistory = null;

        try {
            const fetchId = isEdit ? payload.interment_id : result.interment_id;
            const freshData = await RecordsAPI.get(fetchId);

            if (freshData && Array.isArray(freshData.interments) && freshData.interments.length > 0) {
                freshItem = freshData.interments[0];
                
                // Filter the history right when we construct the fresh record
                freshHistory = freshData.interments
                    .filter(x => x && x.is_history)
                    .filter(h => isStatusValid(h.status))
                    .sort(compareHistoryDesc);
                freshItem.history = freshHistory;

                if (isEdit) {
                    // ---- Update state ----
                    const idx = state.items.findIndex(
                        r => Number(r.interment_id) === Number(fetchId) && !r.is_history
                    );
                    
                    if (isStatusValid(freshItem.status)) {
                        // Status is still good, update it
                        if (idx > -1) state.items[idx] = freshItem;
                    } else {
                        // Status changed to something else (e.g. Expired). 
                        // Reload the table so it filters it out and disappears.
                        await fetchRecords();
                        return; // Stop running the rest of the DOM update below
                    }
                    
                    // ---- Update DOM in place, no tbody wipe, no animation ----
                    const existingRow = els.tbody.querySelector(`tr.recordRow[data-id="${fetchId}"]`);
                    if (existingRow) {
                        let sib = existingRow.nextElementSibling;
                        while (
                            sib &&
                            sib.classList.contains('historyRow') &&
                            String(sib.dataset.parentId) === String(fetchId)
                        ) {
                            const nxt = sib.nextElementSibling;
                            sib.remove();
                            sib = nxt;
                        }

                        const block = [renderMainRow(freshItem, freshHistory.length > 0)];
                        for (const h of freshHistory) {
                            block.push(renderHistoryRow(h, fetchId, false));
                        }

                        existingRow.outerHTML = block.join('');
                    }
                } else {
                    // ---- New record: history always starts empty ----
                    if (isStatusValid(freshItem.status)) {
                        state.items.unshift(freshItem);
                        state.totalRecords++;
                        els.tbody.insertAdjacentHTML('afterbegin', renderMainRow(freshItem, false));
                        renderPagination();
                        if (els.noData) els.noData.style.display = 'none';
                    }
                }
            } else {
                await fetchRecords();
            }
        } catch (err) {
            console.warn('[records.js] Could not refresh row in place, reloading table.', err);
            await fetchRecords();
        }

        document.dispatchEvent(
            new CustomEvent('records:saved', {
                detail: { mode: isEdit ? 'edit' : 'add', result, payload },
            })
        );

        if (onSuccess) {
            const updatedData = freshItem
                || RecordsAPI.getItem(isEdit ? payload.interment_id : result.interment_id)
                || payload;
            onSuccess(updatedData, result);
        }
    }
    
    document.addEventListener('burial_modal:save', handleModalSave);

    // ---------- boot ----------

    function boot() {
        if (booted) return;
        booted = true;

        autoDetect();
        if (!els.tbody) {
            console.warn('[records.js] No table body found — call RecordsAPI.init({ tbody: "…" }).');
            return;
        }

        if (els.noData) els.noData.style.display = 'none';

        bindEvents();
        fetchRecords();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }

    global.RecordsAPI = RecordsAPI;
    global.RecordsTable = RecordsAPI;

})(window);