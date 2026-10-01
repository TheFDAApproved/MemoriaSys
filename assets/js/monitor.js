document.addEventListener('DOMContentLoaded', function () {
    const API_URL = 'api/monitor.php';
    const PER_PAGE = 100;
    const MAX_PAGE_BUTTONS = 5;

    const state = {
        items: [],
        page: 1,
        totalPages: 1,
        totalRecords: 0,
        appliedSearch: '',
        requestId: 0,
        lastRenderKey: ''
    };

    const els = {
        searchBox: document.querySelector('.searchBox'),
        searchInput: document.getElementById('user_search'),
        tableBody: document.getElementById('reservation'),
        noData: document.getElementById('monitor_no_data'),
        currentPageNum: document.getElementById('current_page_num'),
        totalPagesNum: document.getElementById('total_pages_num'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
        carouselViewport: document.getElementById('carousel_viewport'),
        tableWrapper: document.querySelector('.tableWrapper')
    };

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'searchClearBtn';
    closeBtn.setAttribute('aria-label', 'Clear search');
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    if (els.searchBox) els.searchBox.appendChild(closeBtn);

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function displayVal(v) {
        const s = (v === null || v === undefined) ? '' : String(v).trim();
        return s === '' ? '-' : s;
    }

    function isApiFailure(res, json) {
        if (!res.ok) return true;
        if (!json || typeof json !== 'object') return true;
        if (json.success === false) return true;
        if (json.status === 'error' || json.status === 'fail') return true;
        if (json.error) return true;
        return false;
    }

    function extractApiMessage(json, fallback) {
        if (json && typeof json === 'object') {
            if (json.message) return json.message;
            if (json.error) return json.error;
        }
        return fallback;
    }

    function graveLabel(grave) {
        if (!grave) return '-';
        const b = grave.block_name || '-';
        const g = grave.grave_code || '-';
        return b + ' / ' + g;
    }

    function confirmDialog(opts) {
        if (typeof window.showConfirmModal === 'function') {
            return window.showConfirmModal(opts);
        }
        const plain = [opts.title, opts.message].filter(Boolean).join('\n\n');
        return Promise.resolve(window.confirm(plain));
    }

    async function fetchMonitor() {
        const params = new URLSearchParams();
        params.set('page', state.page);
        params.set('limit', PER_PAGE);

        const searchVal = state.appliedSearch.trim();
        if (searchVal.length >= 3) params.set('search_term', searchVal);

        const res = await fetch(API_URL + '?' + params.toString());
        const text = await res.text();

        let json = null;
        try { json = JSON.parse(text); }
        catch (_) { throw new Error('Non-JSON response: ' + text.slice(0, 200)); }

        if (isApiFailure(res, json)) {
            throw new Error(extractApiMessage(json, 'HTTP ' + res.status));
        }

        return (json && json.data) ? json.data : json;
    }

    async function refetchTransfer(pendingId) {
        if (!pendingId) return null;

        try {
            const res = await fetch(`${API_URL}/${encodeURIComponent(pendingId)}`, {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (!res.ok) return null;

            const json = await res.json().catch(() => null);
            if (!json || json.success === false) return null;

            const payload = (json && json.data) ? json.data : json;
            return (payload && payload.transfer) ? payload.transfer : null;
        } catch (_) {
            return null;
        }
    }

    async function loadMonitor() {
        const reqId = ++state.requestId;

        try {
            const data = await fetchMonitor();
            if (reqId !== state.requestId) return;

            state.items = Array.isArray(data.transfers) ? data.transfers : [];
            const pag = data.pagination || {};
            state.totalPages = Math.max(1, parseInt(pag.total_pages, 10) || 1);
            state.totalRecords = parseInt(pag.total_records, 10) || 0;

            if (state.page > state.totalPages) state.page = state.totalPages;

            renderTable();
            renderPagination();
        } catch (e) {
            if (reqId !== state.requestId) return;
            console.warn('[monitor] fetch failed:', e);
            state.items = [];
            state.totalPages = 1;
            state.totalRecords = 0;
            renderTable();
            renderPagination();
        }
    }

    function buildRenderKey() {
        if (!state.items.length) return 'empty:' + state.page;

        return state.items.map(function (t) {
            const n = t.new_occupant || {};
            const o = t.old_occupant || {};
            const g = t.target_grave || {};
            return [
                t.type,
                n.interment_id, n.deceased_name, n.control_number,
                o.interment_id, o.deceased_name, o.control_number,
                g.grave_id, g.grave_code, g.block_name
            ].join('|');
        }).join(',') + ':' + state.page;
    }

    function buildRowHtml(transfer) {
        const newOcc = transfer.new_occupant || {};
        const oldOcc = transfer.old_occupant || null;
        const grave = transfer.target_grave || {};

        const oldName = oldOcc ? displayVal(oldOcc.deceased_name) : '-';
        const oldExpiration = oldOcc ? displayVal(oldOcc.lease_expiration_date) : '-';
        const oldContactName = oldOcc ? displayVal(oldOcc.contact_person_name) : '-';
        const oldContactPhone = oldOcc ? displayVal(oldOcc.contact_person_phone_number) : '-';

        const blockName = displayVal(grave.block_name);
        const graveCode = displayVal(grave.grave_code);
        const locationCell = (blockName !== '-' && graveCode !== '-')
            ? `${escapeHtml(blockName)} <span style="color:#94a3b8">/</span> ${escapeHtml(graveCode)}`
            : escapeHtml(blockName !== '-' ? blockName : graveCode);

        const newName = displayVal(newOcc.deceased_name);
        const newAddress = displayVal(newOcc.last_known_address);
        const newContactName = displayVal(newOcc.contact_person_name);
        const newContactPhone = displayVal(newOcc.contact_person_phone_number);
        const newContactAddress = displayVal(newOcc.contact_person_address);
        const remarks = displayVal(newOcc.remarks || (oldOcc && oldOcc.remarks));

        const pendingId = newOcc.interment_id || '';

        const viewOldBtn = oldOcc
            ? '<button type="button" class="viewBtn"   data-action="view-old" title="View Old Occupant"><i class="fas fa-user-clock"></i></button>'
            : '';

        const actionsHtml =
            viewOldBtn +
            '<button type="button" class="viewBtn"   data-action="view-new" title="View New Occupant"><i class="fas fa-user-plus"></i></button>' +
            '<button type="button" class="checkBtn"  data-action="check"    title="Confirm Transfer"><i class="fas fa-check"></i></button>' +
            '<button type="button" class="cancelBtn" data-action="cancel"   title="Cancel"><i class="fas fa-times"></i></button>';

        return (
            '<tr data-id="' + escapeHtml(pendingId) + '"' +
            ' data-type="' + escapeHtml(transfer.type || '') + '">' +
            '<td>' + escapeHtml(oldName) + '</td>' +
            '<td>' + locationCell + '</td>' +
            '<td>' + escapeHtml(oldExpiration) + '</td>' +
            '<td>' + escapeHtml(oldContactName) + '</td>' +
            '<td>' + escapeHtml(oldContactPhone) + '</td>' +
            '<td>' + escapeHtml(newName) + '</td>' +
            '<td>' + escapeHtml(newAddress) + '</td>' +
            '<td>' + escapeHtml(newContactName) + '</td>' +
            '<td>' + escapeHtml(newContactPhone) + '</td>' +
            '<td>' + escapeHtml(newContactAddress) + '</td>' +
            '<td>' + escapeHtml(remarks) + '</td>' +
            '<td><div class="actions">' + actionsHtml + '</div></td>' +
            '</tr>'
        );
    }

    function renderTable() {
        const key = buildRenderKey();
        const changed = key !== state.lastRenderKey;
        state.lastRenderKey = key;

        if (!state.items.length) {
            els.tableBody.innerHTML = '';
            els.noData.style.display = 'flex';
            return;
        }

        els.noData.style.display = 'none';
        els.tableBody.innerHTML = state.items.map(buildRowHtml).join('');

        if (changed) {
            els.tableBody.classList.remove('animate');
            void els.tableBody.offsetWidth;
            els.tableBody.classList.add('animate');
        }
    }

    function renderPagination() {
        const total = state.totalPages;
        if (els.currentPageNum) els.currentPageNum.textContent = state.page;
        if (els.totalPagesNum) els.totalPagesNum.textContent = total;

        els.prevBtn.disabled = state.page <= 1;
        els.nextBtn.disabled = state.page >= total;

        let startPage, endPage;

        if (total <= MAX_PAGE_BUTTONS) {
            startPage = 1;
            endPage = total;
        } else {
            const half = Math.floor(MAX_PAGE_BUTTONS / 2);
            startPage = state.page - half;
            endPage = startPage + MAX_PAGE_BUTTONS - 1;
            if (startPage < 1) { startPage = 1; endPage = MAX_PAGE_BUTTONS; }
            if (endPage > total) { endPage = total; startPage = total - MAX_PAGE_BUTTONS + 1; }
        }

        const existing = els.carouselTrack.querySelectorAll('button');
        const existingValues = Array.prototype.map.call(existing, b => b.textContent);
        const newValues = [];
        for (let i = startPage; i <= endPage; i++) newValues.push(String(i));

        const sameSet = existingValues.length === newValues.length &&
            existingValues.every((v, i) => v === newValues[i]);

        if (sameSet) {
            Array.prototype.forEach.call(existing, function (btn, i) {
                const pageNum = startPage + i;
                btn.classList.toggle('active', pageNum === state.page);
            });
            centerActivePage();
            return;
        }

        els.carouselTrack.innerHTML = '';
        for (let i = startPage; i <= endPage; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = i;
            if (i === state.page) btn.classList.add('active');
            btn.addEventListener('click', (function (pageNum) {
                return function () { goToPage(pageNum); };
            })(i));
            els.carouselTrack.appendChild(btn);
        }

        centerActivePage();
    }

    function centerActivePage() {
        const active = els.carouselTrack.querySelector('button.active');
        if (!active) { els.carouselTrack.style.transform = 'translateX(0)'; return; }

        const vw = els.carouselViewport.clientWidth;
        const tw = els.carouselTrack.scrollWidth;
        if (tw <= vw) { els.carouselTrack.style.transform = 'translateX(0)'; return; }

        const center = active.offsetLeft + active.offsetWidth / 2;
        let t = center - vw / 2;
        const max = tw - vw;
        if (t < 0) t = 0;
        if (t > max) t = max;
        els.carouselTrack.style.transform = 'translateX(' + (-t) + 'px)';
    }

    function goToPage(page) {
        if (page < 1 || page > state.totalPages) return;
        if (page === state.page) return;

        state.page = page;
        state.lastRenderKey = '';
        loadMonitor();
        if (els.tableWrapper) els.tableWrapper.scrollTop = 0;
    }

    function updateCloseButton() {
        const hasText = els.searchInput.value.length > 0;
        closeBtn.classList.toggle('is-visible', hasText);
        els.searchInput.style.paddingRight = hasText ? '36px' : '';
    }

    let searchTimer = null;
    els.searchInput.addEventListener('input', function () {
        updateCloseButton();
        clearTimeout(searchTimer);

        searchTimer = setTimeout(function () {
            const val = els.searchInput.value.trim();
            const prev = state.appliedSearch;

            state.appliedSearch = val.length >= 3 ? val : '';
            state.page = 1;
            state.lastRenderKey = '';

            if (val.length > 0 && val.length < 3) {
                if (prev.length >= 3) loadMonitor();
                return;
            }
            loadMonitor();
        }, 300);
    });

    els.searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') e.preventDefault();
    });

    els.searchBox.addEventListener('click', function (e) {
        if (e.target === closeBtn || closeBtn.contains(e.target)) return;
        els.searchInput.focus();
    });

    closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        els.searchInput.value = '';
        state.appliedSearch = '';
        updateCloseButton();
        state.page = 1;
        state.lastRenderKey = '';
        loadMonitor();
        els.searchInput.focus();
    });

    function findTransferByPendingId(id) {
        return state.items.find(function (t) {
            const n = t.new_occupant || {};
            return String(n.interment_id) === String(id);
        });
    }

    async function viewOldOccupant(transfer) {
        if (!transfer.old_occupant) return;

        const pendingId = (transfer.new_occupant || {}).interment_id;
        const fresh = await refetchTransfer(pendingId);
        const payload = fresh || transfer;

        if (typeof window.openMonitorOldOccupant === 'function') {
            window.openMonitorOldOccupant(payload);
            return;
        }
        console.warn('[monitor] monitor_burial_modal.js is not loaded.');
    }

    async function viewNewOccupant(transfer) {
        const pendingId = (transfer.new_occupant || {}).interment_id;
        const fresh = await refetchTransfer(pendingId);
        const payload = fresh || transfer;

        if (typeof window.openMonitorNewOccupant === 'function') {
            window.openMonitorNewOccupant(payload);
            return;
        }
        console.warn('[monitor] monitor_burial_modal.js is not loaded.');
    }

    async function confirmTransfer(pendingId, transfer) {
        const oldOcc = transfer.old_occupant || null;
        const newOcc = transfer.new_occupant || {};
        const grave = transfer.target_grave || {};

        const rows = [];
        if (oldOcc) {
            rows.push({ label: 'Old Occupant', value: oldOcc.deceased_name || '' });
        }
        rows.push({ label: 'New Occupant', value: newOcc.deceased_name || '' });
        rows.push({ label: 'Block', value: grave.block_name || '' });
        rows.push({ label: 'Grave Code', value: grave.grave_code || '' });

        const ok = await confirmDialog({
            title: oldOcc ? 'Confirm Reservation' : 'Confirm Interment',
            message: 'Do you really want to confirm this reservation?',
            variant: 'primary',
            confirmText: oldOcc ? 'Confirm Transfer' : 'Confirm',
            cancelText: 'Cancel',
            rows: rows,
            onConfirm: async function () {
                const res = await fetch(API_URL + '/' + encodeURIComponent(pendingId), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pending_interment_id: pendingId })
                });

                let json = null;
                try { json = await res.json(); } catch (_) { }

                if (isApiFailure(res, json)) {
                    throw new Error(extractApiMessage(json, 'HTTP ' + res.status));
                }
            }
        });

        if (!ok) return;

        loadMonitor();
        if (typeof window.showAlertTOP === 'function') {
            window.showAlertTOP('Changes saved successfully.', 'success');
        }
    }

    async function cancelTransfer(pendingId, transfer) {
        const newOcc = transfer.new_occupant || {};
        const oldOcc = transfer.old_occupant || null;
        const grave = transfer.target_grave || {};

        const rows = [
            { label: 'Name', value: newOcc.deceased_name || '' },
            { label: 'Block', value: grave.block_name || '' },
            { label: 'Grave Code', value: grave.grave_code || '' }
        ];

        const ok = await confirmDialog({
            title: 'Cancel Reservation',
            message: oldOcc
                ? 'Do you really want to cancel this pending reservation? The Old Occupant will return to Reserve unchanged.'
                : 'Do you really want to cancel this pending reservation?',
            variant: 'danger',
            confirmText: 'Yes, Cancel',
            cancelText: 'Keep',
            rows: rows,
            onConfirm: async function () {
                const res = await fetch(API_URL + '/' + encodeURIComponent(pendingId), {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pending_interment_id: pendingId })
                });

                let json = null;
                try { json = await res.json(); } catch (_) { }

                if (isApiFailure(res, json)) {
                    throw new Error(extractApiMessage(json, 'HTTP ' + res.status));
                }
            }
        });

        if (!ok) return;

        loadMonitor();
        if (typeof window.showAlertTOP === 'function') {
            window.showAlertTOP('Record deleted successfully.', 'success');
        }
    }

    els.tableBody.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;

        const row = btn.closest('tr');
        if (!row) return;

        const transfer = findTransferByPendingId(row.dataset.id);
        if (!transfer) return;

        const pendingId = (transfer.new_occupant || {}).interment_id;
        if (!pendingId) return;

        const action = btn.dataset.action;

        if (action === 'view-old') viewOldOccupant(transfer);
        if (action === 'view-new') viewNewOccupant(transfer);
        if (action === 'check') confirmTransfer(pendingId, transfer);
        if (action === 'cancel') cancelTransfer(pendingId, transfer);
    });

    els.prevBtn.addEventListener('click', () => goToPage(state.page - 1));
    els.nextBtn.addEventListener('click', () => goToPage(state.page + 1));

    window.addEventListener('resize', centerActivePage);

    updateCloseButton();
    loadMonitor();

    document.addEventListener('monitor_burial_modal:saved', function () {
        loadMonitor();
    });
});