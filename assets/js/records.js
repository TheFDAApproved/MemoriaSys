document.addEventListener('DOMContentLoaded', function () {
    const MAX_PAGE_BUTTONS = 5;
    const PER_PAGE = 100;
    const API_URL = 'api/records.php';

    const ALLOWED_STATUSES = ['Occupied', 'Expired', 'Expiring'];

    const state = {
        rawRecords: [],
        allRecords: [],
        data: [],
        page: 1,
        totalPages: 1,
        appliedSearch: '',
        appliedStatus: 'all',
        requestId: 0,
        lastRenderKey: '',
        columnsResized: false
    };

    const els = {
        searchBox: document.querySelector('.searchBox'),
        searchInput: document.getElementById('user_search'),
        statusFilter: document.getElementById('status_filter'),
        tableBody: document.getElementById('burial_table_body'),
        noData: document.getElementById('burial_no_data'),
        currentPageNum: document.getElementById('current_page_num'),
        totalPagesNum: document.getElementById('total_pages_num'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
        carouselViewport: document.getElementById('carousel_viewport'),
        tableScrollWrapper: document.querySelector('.tableScrollWrapper'),
        table: document.querySelector('.tableScrollWrapper table'),
        addModalBtn: document.getElementById('open_add_modal_btn')
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

    function sanitizeVal(val, defaultVal = '') {
        if (val === null || val === undefined ||
            String(val).trim() === '' || String(val).trim() === '-' ||
            String(val).trim() === 'N/A') {
            return defaultVal;
        }
        return String(val).trim();
    }

    function displayVal(v) {
        const s = (v === null || v === undefined) ? '' : String(v).trim();
        return s === '' ? '-' : s;
    }

    function normalizeStatus(raw) {
        const s = String(raw || '').trim().toLowerCase();
        if (!s) return 'Occupied';

        if (s === 'occupied') return 'Occupied';
        if (s === 'expired') return 'Expired';
        if (s === 'expiring') return 'Expiring';

        return null;
    }

    function groupHistoryByInterment(interments) {
        const historyMap = {};
        const parents = [];

        interments.forEach(function (item) {
            if (item.is_history) {
                const pid = item.interment_id;
                if (!historyMap[pid]) historyMap[pid] = [];
                historyMap[pid].push(item);
            } else {
                parents.push(item);
            }
        });

        Object.keys(historyMap).forEach(function (pid) {
            historyMap[pid].sort(function (a, b) {
                return String(b.transfer_date || '').localeCompare(String(a.transfer_date || ''));
            });
        });

        return { historyMap, parents };
    }

    function mapHistoryEntry(h) {
        const rawName = sanitizeVal(h.deceased_name);
        const cleanName = rawName.replace(/^\[History[^\]]*\]\s*/i, '').trim();

        return {
            transferDate: sanitizeVal(h.transfer_date),
            controlNo: sanitizeVal(h.control_number || h.control_no),
            name: cleanName,
            sex: sanitizeVal(h.deceased_sex),
            dob: sanitizeVal(h.deceased_date_of_birth),
            address: sanitizeVal(h.last_known_address),
            dateInterment: sanitizeVal(h.date_buried),
            block: sanitizeVal(h.block_name),
            graveCode: sanitizeVal(h.grave_code),
            expiration: sanitizeVal(h.lease_expiration_date),
            contactName: sanitizeVal(h.contact_person_name),
            contactPhone: sanitizeVal(h.contact_person_phone_number),
            contactAddress: sanitizeVal(h.contact_person_address),
            remarks: sanitizeVal(h.remarks)
        };
    }

    function autoBlock(item, index) {
        const raw = sanitizeVal(item.block || item.block_name);
        if (raw) return raw;
        return 'Block ' + (Math.floor(index / 100) + 1);
    }

    function autoGraveCode(item, block, index) {
        const raw = sanitizeVal(item.grave_code);
        if (raw) return raw;
        const lot = (index % 100) + 1;
        return block + '-' + String(lot).padStart(3, '0');
    }

    function mapRecord(item, index) {
        const idVal = item.id || item.interment_id || (index + 101);

        const fullContactAddress = item.purok_zone_street && item.barangay_address
            ? `${item.purok_zone_street}, ${item.barangay_address}`
            : (item.contact_person_address || '');

        const block = autoBlock(item, index);
        const graveCode = autoGraveCode(item, block, index);
        const status = normalizeStatus(item.grave_status || item.status);

        const rawName = sanitizeVal(item.deceased_name);
        const cleanName = rawName.replace(/^\[History[^\]]*\]\s*/i, '').trim();

        return {
            id: idVal,
            controlNo: sanitizeVal(item.control_no || item.control_number),
            name: cleanName || 'Vacant / Unregistered',
            sex: sanitizeVal(item.deceased_sex),
            dob: sanitizeVal(item.deceased_date_of_birth),
            address: sanitizeVal(item.last_known_address),
            dateInterment: sanitizeVal(item.date_of_interment || item.date_buried),
            block: block,
            graveCode: graveCode,
            expiration: sanitizeVal(item.expiration_date || item.lease_expiration_date),
            contactName: sanitizeVal(item.applicant_full_name || item.contact_person_name),
            contactPhone: sanitizeVal(item.phone_number || item.contact_person_phone_number),
            contactAddress: fullContactAddress,
            remarks: sanitizeVal(item.remarks),
            graveStatus: status,
            isHistory: false,
            history: []
        };
    }

    function filterByStatus(records) {
        return records.filter(function (r) {
            return r.graveStatus && ALLOWED_STATUSES.indexOf(r.graveStatus) !== -1;
        });
    }

    async function fetchAllRecords() {
        const res = await fetch(API_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const text = await res.text();
        let payload;
        try { payload = JSON.parse(text); }
        catch (e) { throw new Error('Non-JSON response: ' + text.slice(0, 200)); }

        const interments = payload?.data?.interments || [];
        const { historyMap, parents } = groupHistoryByInterment(interments);

        const mapped = parents.map(function (item, idx) {
            const rec = mapRecord(item, idx);
            const hists = historyMap[item.interment_id] || [];
            rec.history = hists.map(mapHistoryEntry);
            return rec;
        });

        return filterByStatus(mapped);
    }

    async function loadRecords(opts) {
        const silent = !!(opts && opts.silent);
        const reqId = ++state.requestId;

        try {
            const fetched = await fetchAllRecords();
            if (reqId !== state.requestId) return;

            const queued = (typeof CemeteryPipeline !== 'undefined')
                ? CemeteryPipeline.getRecordsQueue()
                    .filter(function (r) { return !r.is_history; })
                    .filter(function (r) {
                        const s = normalizeStatus(r.graveStatus || r.grave_status || r.status);
                        return s !== null;
                    })
                    .map(function (r, i) {
                        const rec = mapRecord(r, i);
                        rec.history = [];
                        return rec;
                    })
                    .filter(function (r) { return r.graveStatus !== null; })
                : [];

            state.rawRecords = filterByStatus(queued.concat(fetched));

            applySearchFilter();
            applyPage();
            renderTable(silent);
            renderPagination(silent);

            if (typeof CemeteryPipeline !== 'undefined') {
                CemeteryPipeline.setCache('records', state.rawRecords);
            }
        } catch (e) {
            if (reqId !== state.requestId) return;
            console.warn('[records] fetch failed, using fallback:', e);

            let fallback = [];
            if (typeof getRecordsView === 'function') {
                fallback = filterByStatus(
                    getRecordsView()
                        .filter(function (r) { return !r.is_history; })
                        .map(function (item, idx) {
                            const rec = mapRecord(item, idx);
                            rec.history = [];
                            return rec;
                        })
                );
            } else if (typeof CEMETERY_MASTER_DATA !== 'undefined' &&
                Array.isArray(CEMETERY_MASTER_DATA.data)) {
                fallback = CEMETERY_MASTER_DATA.data
                    .filter(function (i) {
                        return !i.is_history
                            && ALLOWED_STATUSES.indexOf(String(i.grave_status || '').trim()) !== -1
                            && i.flags?.is_record;
                    })
                    .map(function (item, idx) {
                        const rec = mapRecord(item, idx);
                        rec.history = [];
                        return rec;
                    });
                fallback = filterByStatus(fallback);
            }

            state.rawRecords = fallback;
            applySearchFilter();
            applyPage();
            renderTable(silent);
            renderPagination(silent);
        }
    }

    function recordMatchesQuery(item, query) {
        const { history, ...rest } = item;
        if (Object.values(rest).some(function (v) {
            return String(v).toLowerCase().includes(query);
        })) return true;

        if (Array.isArray(history) && history.length > 0) {
            return history.some(function (h) {
                return Object.values(h).some(function (v) {
                    return String(v).toLowerCase().includes(query);
                });
            });
        }
        return false;
    }

    function applySearchFilter() {
        const query = state.appliedSearch.toLowerCase().trim();
        const status = state.appliedStatus;

        state.allRecords = state.rawRecords.filter(function (item) {
            if (status && status !== 'all' && item.graveStatus !== status) return false;
            if (!query) return true;
            return recordMatchesQuery(item, query);
        });
    }

    function applyPage() {
        state.totalPages = Math.max(1, Math.ceil(state.allRecords.length / PER_PAGE));
        if (state.page > state.totalPages) state.page = state.totalPages;
        if (state.page < 1) state.page = 1;
        const start = (state.page - 1) * PER_PAGE;
        state.data = state.allRecords.slice(start, start + PER_PAGE);
    }

    function buildRenderKey() {
        if (state.data.length === 0) return 'empty:' + state.page + ':' + state.appliedStatus;

        return state.data.map(function (r) {
            const base = [r.id, r.controlNo, r.name, r.sex, r.dob, r.address, r.dateInterment,
            r.block, r.graveCode, r.expiration, r.contactName, r.contactPhone,
            r.contactAddress, r.remarks, r.graveStatus].join('|');

            const hist = (r.history || []).map(function (h) {
                return [h.transferDate, h.block, h.graveCode, h.remarks].join('~');
            }).join('^');

            return base + '#' + hist;
        }).join(',') + ':' + state.page + ':' + state.appliedStatus;
    }

    function buildRowHtml(r) {
        const hasHistory = Array.isArray(r.history) && r.history.length > 0;

        const controlCell =
            '<td>' +
            '<div class="controlNoCell">' +
            (hasHistory
                ? '<button type="button" class="historyToggle" data-action="toggle-history" ' +
                'aria-expanded="false" aria-label="Toggle history" title="Show history">' +
                '<i class="fas fa-chevron-right"></i></button>'
                : '') +
            '<span class="controlNoText">' + escapeHtml(displayVal(r.controlNo)) + '</span>' +
            '</div>' +
            '</td>';

        const mainRow =
            '<tr data-id="' + escapeHtml(r.id) + '"' + (hasHistory ? ' class="hasHistory"' : '') + '>' +
            controlCell +
            '<td>' + escapeHtml(displayVal(r.name)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.sex)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.dob)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.address)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.dateInterment)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.block)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.graveCode)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.expiration)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.contactName)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.contactPhone)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.contactAddress)) + '</td>' +
            '<td>' + escapeHtml(displayVal(r.remarks)) + '</td>' +
            '<td>' +
            '<div class="actions">' +
            '<button type="button" class="viewBtn"   data-action="view"   title="View"><i class="fas fa-eye"></i></button>' +
            '<button type="button" class="editBtn"   data-action="edit"   title="Edit"><i class="fas fa-edit"></i></button>' +
            '<button type="button" class="deleteBtn" data-action="delete" title="Delete"><i class="fas fa-trash-alt"></i></button>' +
            '</div>' +
            '</td>' +
            '</tr>';

        let historyRows = '';
        if (hasHistory) {
            historyRows = r.history.map(function (h) {
                return (
                    '<tr class="historyRow" data-parent-id="' + escapeHtml(r.id) + '" style="display:none">' +
                    '<td>' +
                    '<div class="controlNoCell">' +
                    '<span class="historyBadge" title="Transferred on ' +
                    escapeHtml(displayVal(h.transferDate)) + '">' +
                    '<i class="fas fa-history"></i>' +
                    '<span>' + escapeHtml(displayVal(h.transferDate)) + '</span>' +
                    '</span>' +
                    '</div>' +
                    '</td>' +
                    '<td>' + escapeHtml(displayVal(h.name)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.sex)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.dob)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.address)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.dateInterment)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.block)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.graveCode)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.expiration)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.contactName)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.contactPhone)) + '</td>' +
                    '<td>' + escapeHtml(displayVal(h.contactAddress)) + '</td>' +
                    '<td title="' + escapeHtml(displayVal(h.remarks)) + '">' +
                    escapeHtml(displayVal(h.remarks)) +
                    '</td>' +
                    '<td></td>' +
                    '</tr>'
                );
            }).join('');
        }

        return mainRow + historyRows;
    }

    function renderTable(silent) {
        const rows = state.data;

        if (rows.length === 0) {
            const emptyKey = 'empty:' + state.page + ':' + state.appliedStatus;
            if (state.lastRenderKey !== emptyKey) {
                els.tableBody.innerHTML = '';
                state.lastRenderKey = emptyKey;
            }
            els.noData.style.display = 'flex';
            return;
        }

        els.noData.style.display = 'none';

        const key = buildRenderKey();
        if (key === state.lastRenderKey) return;
        state.lastRenderKey = key;

        const prevScrollTop = els.tableScrollWrapper ? els.tableScrollWrapper.scrollTop : 0;
        const prevScrollLeft = els.tableScrollWrapper ? els.tableScrollWrapper.scrollLeft : 0;

        els.tableBody.innerHTML = rows.map(buildRowHtml).join('');

        if (!silent) {
            els.tableBody.classList.remove('animate');
            void els.tableBody.offsetWidth;
            els.tableBody.classList.add('animate');
        }

        if (els.tableScrollWrapper) {
            if (prevScrollTop > 0) els.tableScrollWrapper.scrollTop = prevScrollTop;
            if (prevScrollLeft > 0) els.tableScrollWrapper.scrollLeft = prevScrollLeft;
        }

        ensureResizableColumns();
    }

    function toggleHistory(row) {
        if (!row) return;
        const id = row.dataset.id;
        if (!id) return;

        const historyRows = els.tableBody.querySelectorAll('tr.historyRow[data-parent-id="' + id + '"]');
        if (!historyRows.length) return;

        const toggle = row.querySelector('.historyToggle');
        const isOpen = historyRows[0].style.display !== 'none';
        const willOpen = !isOpen;

        historyRows.forEach(function (hr) {
            hr.style.display = willOpen ? 'table-row' : 'none';
            if (willOpen) {
                hr.classList.remove('visible');
                void hr.offsetWidth;
                hr.classList.add('visible');
            } else {
                hr.classList.remove('visible');
            }
        });

        row.classList.toggle('expanded', willOpen);
        if (toggle) toggle.setAttribute('aria-expanded', String(willOpen));
    }

    function renderPagination(silent) {
        const total = state.totalPages;

        els.currentPageNum.textContent = state.page;
        els.totalPagesNum.textContent = total;

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

            if (startPage < 1) {
                startPage = 1;
                endPage = MAX_PAGE_BUTTONS;
            }
            if (endPage > total) {
                endPage = total;
                startPage = total - MAX_PAGE_BUTTONS + 1;
            }
        }

        const existingButtons = els.carouselTrack.querySelectorAll('button');
        const existingValues = Array.prototype.map.call(existingButtons, b => b.textContent);
        const newValues = [];
        for (let i = startPage; i <= endPage; i++) newValues.push(String(i));

        const sameSet = existingValues.length === newValues.length &&
            existingValues.every((v, i) => v === newValues[i]);

        if (sameSet) {
            Array.prototype.forEach.call(existingButtons, function (btn, i) {
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
        if (!active) {
            els.carouselTrack.style.transform = 'translateX(0)';
            return;
        }

        const vw = els.carouselViewport.clientWidth;
        const tw = els.carouselTrack.scrollWidth;
        if (tw <= vw) {
            els.carouselTrack.style.transform = 'translateX(0)';
            return;
        }

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

        applyPage();
        renderTable(false);
        renderPagination(false);

        if (els.tableScrollWrapper) els.tableScrollWrapper.scrollTop = 0;
    }

    function updateCloseButton() {
        const hasText = els.searchInput.value.length > 0;
        closeBtn.classList.toggle('is-visible', hasText);
        els.searchInput.style.paddingRight = hasText ? '36px' : '';
    }

    els.searchInput.addEventListener('input', function () {
        updateCloseButton();
        state.appliedSearch = els.searchInput.value;
        state.page = 1;
        state.lastRenderKey = '';
        applySearchFilter();
        applyPage();
        renderTable(true);
        renderPagination(true);
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
        applySearchFilter();
        applyPage();
        renderTable(false);
        renderPagination(false);
        els.searchInput.focus();
    });

    if (els.statusFilter) {
        Array.from(els.statusFilter.options).forEach(function (opt) {
            const v = String(opt.value || '').trim();
            if (v === '' || v === 'all') return;
            if (ALLOWED_STATUSES.indexOf(v) === -1) opt.remove();
        });

        els.statusFilter.addEventListener('change', function () {
            state.appliedStatus = els.statusFilter.value || 'all';
            state.page = 1;
            state.lastRenderKey = '';
            applySearchFilter();
            applyPage();
            renderTable(false);
            renderPagination(false);
        });
    }

    els.tableBody.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-action]');

        if (btn && btn.dataset.action === 'toggle-history') {
            e.stopPropagation();
            toggleHistory(btn.closest('tr'));
            return;
        }

        if (btn) {
            const row = btn.closest('tr');
            if (!row) return;

            const id = Number(row.dataset.id);
            if (!id) return;

            const record = state.rawRecords.find(r => Number(r.id) === id);
            if (!record) return;

            const action = btn.dataset.action;

            if (action === 'view') {
                if (window.BurialModal) window.BurialModal.open('view', record);

            } else if (action === 'edit') {
                if (!window.BurialModal) return;
                const takenControlNos = state.rawRecords
                    .filter(r => Number(r.id) !== id)
                    .map(r => r.controlNo)
                    .filter(Boolean);
                window.BurialModal.open('edit', record, { takenControlNos });

            } else if (action === 'delete') {
                deleteRecord(id);
            }
            return;
        }

        const row = e.target.closest('tr[data-id]');
        if (row && row.classList.contains('hasHistory')) {
            toggleHistory(row);
        }
    });

    function handleModalSave(e) {
        const { mode, data } = e.detail;
        const method = mode === 'add' ? 'POST' : 'PUT';

        fetch(API_URL, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
            .then(res => res.json())
            .then(resData => {
                if (resData.status === 'success') loadRecords();
                else console.warn('[records] save failed:', resData);
            })
            .catch(err => console.error('[records] save request failed:', err));
    }

    function deleteRecord(id) {
        if (!confirm('Delete this record?')) return;

        fetch(API_URL + '?id=' + id, { method: 'DELETE' })
            .then(res => res.json())
            .then(() => loadRecords())
            .catch(err => console.error('[records] delete request failed:', err));
    }

    document.addEventListener('burial_modal:save', handleModalSave);

    if (els.addModalBtn) {
        els.addModalBtn.addEventListener('click', function () {
            if (!window.BurialModal) {
                console.error('BurialModal is not loaded. Check burial_modal.js.');
                return;
            }
            const takenControlNos = state.rawRecords
                .map(r => r.controlNo)
                .filter(Boolean);
            window.BurialModal.open('add', {}, { takenControlNos });
        });
    }

    els.prevBtn.addEventListener('click', () => goToPage(state.page - 1));
    els.nextBtn.addEventListener('click', () => goToPage(state.page + 1));

    window.addEventListener('resize', centerActivePage);

    function ensureResizableColumns() {
        const table = els.table;
        if (!table) return;
        if (state.columnsResized) return;

        const ths = Array.from(table.querySelectorAll('thead th'));
        if (!ths.length) return;

        const widths = ths.map(th => th.getBoundingClientRect().width);
        if (widths.some(w => !w)) return;

        let colgroup = table.querySelector('colgroup');
        if (!colgroup) {
            colgroup = document.createElement('colgroup');
            table.insertBefore(colgroup, table.firstChild);
        }
        colgroup.innerHTML = '';
        widths.forEach(w => {
            const col = document.createElement('col');
            col.style.width = w + 'px';
            colgroup.appendChild(col);
        });

        table.style.tableLayout = 'fixed';
        table.style.minWidth = widths.reduce((a, b) => a + b, 0) + 'px';

        const cols = Array.from(colgroup.children);

        const updateMinWidth = () => {
            const sum = cols.reduce((a, c) => a + (parseFloat(c.style.width) || 0), 0);
            table.style.minWidth = sum + 'px';
        };

        ths.forEach((th, i) => {
            if (th.querySelector('.col-resizer')) return;

            const resizer = document.createElement('span');
            resizer.className = 'col-resizer';
            resizer.setAttribute('aria-hidden', 'true');
            th.appendChild(resizer);

            let startX = 0;
            let startW = 0;

            const onMove = (e) => {
                const w = Math.max(60, startW + (e.clientX - startX));
                cols[i].style.width = w + 'px';
                updateMinWidth();
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                document.body.classList.remove('resizing');
            };

            resizer.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                startX = e.clientX;
                startW = th.getBoundingClientRect().width;
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
                document.body.classList.add('resizing');
            });
        });

        state.columnsResized = true;
    }

    updateCloseButton();
    loadRecords();
});