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
    let booted = false;

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

    const pick = (...values) => {
        for (const v of values) {
            if (v === null || v === undefined) continue;
            const s = String(v).trim();
            if (s !== '' && s !== 'N/A') return s;
        }
        return '';
    };

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

        const toast =
            document.getElementById('records_toast') ||
            document.getElementById('app_toast');

        if (toast) {
            toast.textContent = text;
            toast.dataset.kind = kind;
            toast.classList.add('visible');
            clearTimeout(toast.__hideTimer);
            toast.__hideTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
            return;
        }

        document.dispatchEvent(
            new CustomEvent('records:notify', { detail: { kind, message: text } })
        );

        if (kind === 'error') console.error('[records.js]', text);
        else console.log('[records.js]', text);
    }

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
            if (ct.includes('application/json')) payload = await response.json();
            else {
                const text = await response.text();
                if (text && /^[\s]*[{[]/.test(text)) {
                    try { payload = JSON.parse(text); } catch (_) { }
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

    function autoDetect() {
        if (!els.tbody) {
            els.tbody =
                document.getElementById('burial_table_body') ||
                document.getElementById('records_body') ||
                document.querySelector('#burial_records tbody');
        }
        if (!els.noData) {
            els.noData = document.getElementById('burial_no_data');
        }
        if (!els.searchInput) {
            els.searchInput = document.getElementById('user_search');
        }
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

        state.items = Array.isArray(data.interments) ? data.interments : [];
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

        if (els.tableWrapper) {
            els.tableWrapper.classList.toggle('isLoading', !!isLoading);
        } else if (els.tbody) {
            els.tbody.classList.toggle('isLoading', !!isLoading);
        }

        if (isLoading && els.noData) {
            els.noData.style.display = 'none';
        }
    }

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
        if (item.transfer_date) return { badge: `History ${item.transfer_date}`, name: raw };
        return { badge: '', name: raw };
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

        const actionButtons = `
        <button type="button" class="viewBtn" data-action="view" data-id="${id}" title="View / Edit" aria-label="View / Edit">
          <i class="fas fa-file-lines"></i>
        </button>
        <button type="button" class="printBtn" data-action="print" onclick="memoria_certificate('${id}')" title="Print" aria-label="Print">
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
        <td>${dash(item.contact_person_phone_number)}</td>
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

        return `
      <tr class="${classes}" data-parent-id="${parentId}"${styleAttr}>
        <td>${badgeCell}</td>
        <td>${dash(name)}</td>
        <td>${dash(item.deceased_sex)}</td>
        <td>${formatDate(item.deceased_date_of_birth)}</td>
        <td>${dash(item.last_known_address)}</td>
        <td>${formatDate(item.date_buried)}</td>
        <td>${dash(item.block_name)}</td>
        <td>${dash(item.grave_code)}</td>
        <td>${formatDate(item.lease_expiration_date)}</td>
        <td>${dash(item.contact_person_name)}</td>
        <td>${dash(item.contact_person_phone_number)}</td>
        <td>${escapeHtml(buildContactAddress(item))}</td>
        <td>${dash(item.status)}</td>
        <td class="remarksCell">${dash(item.remarks)}</td>
        <td class="actionCell"></td>
      </tr>`;
    }

    function defaultRenderRow(item, history = []) {
        if (item && item.is_history && history.length === 0) {
            return renderHistoryRow(item, item.interment_id, true);
        }
        return renderMainRow(item, Array.isArray(history) && history.length > 0);
    }

    function renderRows() {
        if (!els.tbody) return;

        els.tbody.classList.remove('animate');
        els.tbody.innerHTML = '';

        if (!state.items.length) {
            if (els.noData) {
                if (state.loading || state.lastError) {
                    els.noData.style.display = 'none';
                } else {
                    els.noData.style.display = '';
                }
            }
            return;
        }

        if (els.noData) els.noData.style.display = 'none';

        const groups = [];
        const byId = new Map();

        for (const item of state.items) {
            const id = Number(item.interment_id);
            if (!Number.isFinite(id)) continue;

            if (item.is_history) {
                const g = byId.get(id);
                if (g) {
                    g.history.push(item);
                } else {
                    groups.push({ id, main: null, history: [item] });
                }
            } else {
                const g = { id, main: item, history: [] };
                byId.set(id, g);
                groups.push(g);
            }
        }

        for (const g of groups) {
            g.history.sort((a, b) => {
                const ta = new Date(a.transfer_date || 0).getTime();
                const tb = new Date(b.transfer_date || 0).getTime();
                return tb - ta;
            });
        }

        const html = [];

        for (const g of groups) {
            if (g.main) {
                html.push(renderMainRow(g.main, g.history.length > 0));
                for (const h of g.history) html.push(renderHistoryRow(h, g.id, false));
            } else {
                for (const h of g.history) html.push(renderHistoryRow(h, g.id, true));
            }
        }

        els.tbody.innerHTML = html.join('');

        els.tbody.offsetWidth;
        els.tbody.classList.add('animate');
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
        fetchRecords();
    }

    function bindEvents() {
        if (els.searchInput && !els.searchInput.__recordsBound) {
            els.searchInput.__recordsBound = true;
            els.searchInput.addEventListener('input', () => {
                clearTimeout(searchTimer);
                const value = els.searchInput.value.trim();
                searchTimer = setTimeout(() => {
                    if (value.length === 0) { setSearch(''); return; }
                    if (value.length < CONFIG.MIN_SEARCH_LENGTH) return;
                    setSearch(value);
                }, CONFIG.SEARCH_DEBOUNCE_MS);
            });
            els.searchInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                clearTimeout(searchTimer);
                const value = els.searchInput.value.trim();
                if (value.length > 0 && value.length < CONFIG.MIN_SEARCH_LENGTH) return;
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

    function onAddClick(e) {
        e.preventDefault();

        const takenControlNos = state.items
            .map((r) => r.control_number)
            .filter(Boolean);

        if (global.BurialModal && typeof global.BurialModal.open === 'function') {
            global.BurialModal.open('add', {}, { takenControlNos });
        } else {
            document.dispatchEvent(new CustomEvent('records:add'));
        }
    }

    function onRowActionClick(e) {
        const btn = e.target.closest('button[data-action]');
        if (btn && els.tbody.contains(btn)) {
            e.preventDefault();

            const action = btn.dataset.action;
            const id = btn.dataset.id ? Number(btn.dataset.id) : null;
            if (!id) return;

            const item = RecordsAPI.getItem(id);

            if (action === 'view') {
                if (item && global.BurialModal && typeof global.BurialModal.open === 'function') {
                    global.BurialModal.open('view', mapItemToModal(item), {
                        takenControlNos: state.items
                            .filter((r) => Number(r.interment_id) !== Number(id))
                            .map((r) => r.control_number),
                    });
                } else {
                    document.dispatchEvent(new CustomEvent('records:view', { detail: { item, id } }));
                }
                return;
            }

            if (action === 'print') {
                document.dispatchEvent(new CustomEvent('records:print', { detail: { item, id } }));
                return;
            }

            if (action === 'delete') {
                handleDelete(id, item);
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

    function mapItemToModal(item) {
        return {
            id: item.interment_id,
            interment_id: item.interment_id,
            control_no: item.control_number,
            deceased_name: item.deceased_name,
            deceased_sex: item.deceased_sex,
            deceased_dob: item.deceased_date_of_birth,
            deceased_bod: item.deceased_date_of_death,
            deceased_address: item.last_known_address,
            deceased_cert: item.death_certificate,

            req_name: item.contact_person_name,
            req_email: item.contact_person_email,
            req_phone: item.contact_person_phone_number,
            req_street: item.contact_person_address,
            barangay: item.contact_person_address_barangay,

            assistance: item.assistance_type,
            permit_burial: item.burial_permit_number,
            permit_exhumation: item.exhumation_permit_number,
            permit_transfer: item.transfer_permit_number,

            clearance_date: item.burial_clearance_date,
            date_interment: item.date_buried,
            expiration_date: item.lease_expiration_date,

            burial_block: item.block_type,
            block: item.block_name,
            grave_code: item.grave_code,
            current_grave_id: item.current_grave_id,
            row_num: item.row_num,
            col_num: item.col_num,

            status: item.status,
            remarks: item.remarks,
        };
    }

    async function handleDelete(id, item) {
        if (!global.DeleteModal || typeof global.DeleteModal.open !== 'function') {
            const name = item ? item.deceased_name : `#${id}`;
            const ok = global.confirm
                ? global.confirm(`Delete record for "${name}"?`)
                : true;
            if (!ok) return;

            try {
                await performDelete(id, item);
            } catch (_) {
            }
            return;
        }

        global.DeleteModal.open({
            controlNo: item ? item.control_number : '',
            deceasedName: item ? item.deceased_name : '',
            blockName: item ? item.block_name : '',
            graveCode: item ? item.grave_code : '',
            onConfirm: async () => {
                const result = await performDelete(id, item);
                return result;
            },
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
        if (result && result.pending_on_grave) {
            message += ' Note: a pending reservation targets the same grave.';
        }
        notify('success', message);

        await fetchRecords();

        document.dispatchEvent(
            new CustomEvent('records:deleted', { detail: { id, result } })
        );

        return result;
    }

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

        const status = payload.status || 'Active';
        if (status !== 'Active') payload.current_grave_id = null;

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

        await fetchRecords();

        document.dispatchEvent(
            new CustomEvent('records:saved', {
                detail: { mode: isEdit ? 'edit' : 'add', result, payload },
            })
        );

        if (onSuccess) {
            let updatedData = payload;
            if (isEdit) {
                const fresh = RecordsAPI.getItem(payload.interment_id);
                if (fresh) updatedData = mapItemToModal(fresh);
            }
            onSuccess(updatedData, result);
        }
    }

    document.addEventListener('burial_modal:save', handleModalSave);

    function boot() {
        if (booted) return;
        booted = true;

        autoDetect();
        if (!els.tbody) {
            console.warn('[records.js] No table body found — call RecordsAPI.init({ tbody: "…" }).');
            return;
        }

        if (!global.BurialModal && els.addBtn) {
            console.warn('[records.js] BurialModal not found — load burial_modal.js before records.js.');
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