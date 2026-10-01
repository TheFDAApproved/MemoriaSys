const ReserveBurialModal = (() => {
    let modalEl = null;
    let loadPromise = null;
    let currentMode = 'view';

    let activeGraveId = null;
    let activeOldIntermentId = null;
    let activeOriginalValues = {};

    let takenControlNos = [];

    let addOriginalBlock = '';
    let addOriginalGraveCode = '';
    let addOriginalGraveId = null;
    let addOriginalOldIntermentId = null;

    let isEditMode = false;
    let viewSnapshot = {};

    const VIEW_EDITABLE_FIELDS = [
        'block', 'burial_block', 'req_assistance', 'deceased_remarks',
        'date_interment', 'permit_exhumation', 'permit_transfer'
    ];

    const ADD_READONLY_FIELDS = ['block', 'grave_code'];

    const VIEW_EDITABLE_SELECTS = ['burial_block', 'block', 'req_assistance', 'grave_code'];

    const SELECT_ARROW_SVG =
        "url(\"data:image/svg+xml;utf8," +
        "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'>" +
        "<path fill='%23455A75' d='M0 0l5 6 5-6z'/>" +
        "</svg>\")";

    const LEASE_YEARS = 5;

    let blocksPromise = null;
    let blockOptions = [];
    let selectedSlot = null;

    let blockChangeTimer = null;
    let gravesToken = 0;

    const BLOCK_CHANGE_DEBOUNCE_MS = 250;

    const BLOCKS_API = 'api/blocks.php';
    const GRAVES_API = 'api/graves.php';

    const AVAILABLE_BLOCK_STATUSES = new Set(['available', 'vacant', 'open', 'active']);
    const AVAILABLE_GRAVE_STATUSES = new Set(['vacant', 'available', 'open']);

    function warn(message) {
        if (!message) return;
        if (typeof window.showAlertTOP === 'function') {
            window.showAlertTOP(String(message), 'warning');
            return;
        }
        console.warn('[reserve_modal]', message);
    }

    function pick(...values) {
        for (const v of values) {
            if (v === null || v === undefined) continue;
            const s = String(v).trim();
            if (s !== '' && s !== 'N/A') return s;
        }
        return '';
    }

    function controlNoExists(value) {
        const v = String(value || '').trim().toUpperCase();
        return takenControlNos.some(n => String(n).trim().toUpperCase() === v);
    }

    function generateControlNo() {
        const year = new Date().getFullYear();
        for (let attempt = 0; attempt < 1000; attempt++) {
            const seq = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
            const code = `CTRL-${year}-${seq}`;
            if (!controlNoExists(code)) return code;
        }
        return '';
    }

    function formatControlNoInput(value) {
        let v = String(value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');

        const parts = v.split('-');
        const p0 = (parts[0] || '').slice(0, 4);
        const p1 = parts.length > 1 ? (parts[1] || '').slice(0, 4) : null;
        const p2 = parts.length > 2 ? (parts[2] || '').slice(0, 3) : null;

        let out = p0;
        if (p1 !== null) out += '-' + p1;
        if (p2 !== null) out += '-' + p2;
        return out;
    }

    function todayISO() {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return local.toISOString().split('T')[0];
    }

    function formatPhoneValue(raw) {
        let digits = String(raw || '').replace(/\D/g, '');
        if (digits.startsWith('63')) digits = digits.slice(2);
        if (digits.startsWith('0')) digits = digits.slice(1);
        digits = digits.slice(0, 10);

        let out = '+63';
        if (digits.length > 0) out += ' ' + digits.slice(0, 3);
        if (digits.length > 3) out += ' ' + digits.slice(3, 6);
        if (digits.length > 6) out += ' ' + digits.slice(6, 10);
        return out;
    }

    function formatNameValue(raw) {
        if (!raw) return '';
        return raw.replace(/[^\p{L}\s'.-]/gu, '');
    }

    function addYearsISO(isoDate, years) {
        if (!isoDate) return '';

        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate).trim());
        if (!m) return '';

        const y = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);

        if (mo < 1 || mo > 12) return '';
        if (d < 1 || d > 31) return '';

        const probe = new Date(y, mo - 1, d);
        if (
            probe.getFullYear() !== y ||
            probe.getMonth() !== mo - 1 ||
            probe.getDate() !== d
        ) return '';

        const targetYear = y + years;
        const targetMonth = mo - 1;
        const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
        const targetDay = Math.min(d, lastDayOfTargetMonth);

        const result = new Date(targetYear, targetMonth, targetDay);
        const yy = result.getFullYear();
        const mm = String(result.getMonth() + 1).padStart(2, '0');
        const dd = String(result.getDate()).padStart(2, '0');

        return `${yy}-${mm}-${dd}`;
    }

    function recalcExpirationFromInterment() {
        if (!modalEl) return;

        const intermentInput = modalEl.querySelector('#date_interment');
        const expirationInput = modalEl.querySelector('#expiration_date');
        if (!intermentInput || !expirationInput) return;

        const raw = (intermentInput.value || '').trim();
        expirationInput.value = raw ? addYearsISO(raw, LEASE_YEARS) : '';
    }

    function detectMode(data) {
        if (!data || typeof data !== 'object') return 'add';
        const type = String(data.type || '').toLowerCase();
        if (type === 'expired' || type === 'expiring') return 'view';
        if (data.interment_id && type !== 'vacant') return 'view';
        return 'add';
    }

    function clearBlockChangeTimer() {
        if (blockChangeTimer) {
            clearTimeout(blockChangeTimer);
            blockChangeTimer = null;
        }
    }

    function blockIsAvailable(b) {
        const status = String(
            (b && (b.block_status || b.status || b.availability)) || ''
        ).trim().toLowerCase();
        if (!status) return true;
        return AVAILABLE_BLOCK_STATUSES.has(status);
    }

    async function fetchBlocks() {
        const url = BLOCKS_API + '?status=available';
        const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const data = json && typeof json === 'object' && 'data' in json ? json.data : json;
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.blocks)) return data.blocks;
        return [];
    }

    async function loadBlocks() {
        if (blocksPromise) return blocksPromise;

        blocksPromise = (async () => {
            try {
                const list = await fetchBlocks();
                blockOptions = list
                    .map(block => ({
                        id: block && (block.block_id ?? block.id) != null ? (block.block_id ?? block.id) : null,
                        name: String((block && (block.block_name ?? block.name)) || '').trim(),
                        type: String((block && block.block_type) || '').trim(),
                        status: String((block && (block.block_status ?? block.status)) || '').trim(),
                    }))
                    .filter(b => b.name !== '')
                    .filter(blockIsAvailable);
            } catch (err) {
                console.warn('[reserve_modal] Unable to load blocks:', err);
                blockOptions = [];
                blocksPromise = null;
            }

            renderBlockOptions();
            return blockOptions;
        })();

        return blocksPromise;
    }

    function renderBlockOptions(keepValue) {
        if (!modalEl) return;
        const select = modalEl.querySelector('#block');
        if (!select || select.tagName !== 'SELECT') return;

        const isView = currentMode === 'view' && !isEditMode;
        const current = keepValue !== undefined ? keepValue : select.value;

        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = isView ? '' : 'Select Block...';
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);

        blockOptions.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.name;
            opt.textContent = b.name;
            if (b.id != null) opt.dataset.blockId = String(b.id);
            if (b.type) opt.dataset.blockType = b.type;
            select.appendChild(opt);
        });

        if (current) {
            const exists = Array.from(select.options).some(o => o.value === current);
            if (!exists) {
                const opt = document.createElement('option');
                opt.value = current;
                opt.textContent = current;
                opt.dataset.placeholder = 'true';
                select.appendChild(opt);
            }
            select.value = current;
        } else {
            select.selectedIndex = 0;
        }
    }

    function ensureGraveCodeSelect() {
        if (!modalEl) return;
        const el = modalEl.querySelector('#grave_code');
        if (!el) return;
        if (el.tagName === 'SELECT') return;

        const select = document.createElement('select');
        select.id = 'grave_code';
        if (el.name) select.name = el.name;
        if (el.className) select.className = el.className;
        if (el.hasAttribute('required')) select.setAttribute('required', '');

        el.parentNode.replaceChild(select, el);
    }

    async function fetchGravesForBlock(blockId) {
        const url =
            `${GRAVES_API}?block_id=${encodeURIComponent(blockId)}` +
            `&status=vacant`;

        const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const json = await res.json();
        const data = json && typeof json === 'object' && 'data' in json ? json.data : json;
        const graves = data && Array.isArray(data.graves) ? data.graves : [];

        return graves.filter(g => {
            const s = String(g.status || '').trim().toLowerCase();
            if (!s) return true;
            return AVAILABLE_GRAVE_STATUSES.has(s);
        });
    }

    function renderGraveOptions(graves, selectedGraveId) {
        const select = modalEl ? modalEl.querySelector('#grave_code') : null;
        if (!select || select.tagName !== 'SELECT') return;

        const isView = currentMode === 'view' && !isEditMode;

        select.innerHTML = '';

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = isView
            ? ''
            : (graves.length ? 'Select Grave Code...' : 'No available grave codes');
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);

        const seen = new Set();
        for (const g of (graves || [])) {
            const code = String(g.grave_code || '').trim();
            const id = g.grave_id;
            if (!code || id == null) continue;
            if (seen.has(code)) continue;
            seen.add(code);

            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = code;
            opt.dataset.graveId = String(id);
            if (g._pinned) opt.dataset.pinned = 'true';
            select.appendChild(opt);
        }

        if (selectedGraveId != null) {
            const selId = Number(selectedGraveId);
            const match = Array.from(select.options).find(
                o => o.dataset.graveId && Number(o.dataset.graveId) === selId
            );
            if (match) select.value = match.value;
        }

        updateSelectedSlotFromGraveSelect();
    }

    function updateSelectedSlotFromGraveSelect() {
        const select = modalEl ? modalEl.querySelector('#grave_code') : null;
        if (!select || select.tagName !== 'SELECT') {
            selectedSlot = null;
            return;
        }
        const opt = select.options[select.selectedIndex];
        if (!opt || !opt.dataset.graveId || !opt.value) {
            selectedSlot = null;
            return;
        }
        selectedSlot = {
            grave_id: Number(opt.dataset.graveId),
            grave_code: opt.value,
        };
    }

    function setGraveCodeHint(message, isError) {
        if (!modalEl) return;
        const hint = modalEl.querySelector('#grave_code_hint');
        if (!hint) return;
        hint.textContent = message || '';
        hint.classList.toggle('error', !!isError);
        hint.classList.toggle('visible', !!message);
    }

    function resetGraveSelectUI() {
        const select = modalEl ? modalEl.querySelector('#grave_code') : null;
        if (!select || select.tagName !== 'SELECT') return;

        const isView = currentMode === 'view' && !isEditMode;

        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = isView ? '' : 'Select Block first...';
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);
        selectedSlot = null;
        setGraveCodeHint('');
    }

    async function loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode) {
        const select = modalEl ? modalEl.querySelector('#grave_code') : null;
        if (!select || select.tagName !== 'SELECT') return;

        clearBlockChangeTimer();
        const token = ++gravesToken;

        if (currentMode === 'view' && !isEditMode) {
            if (pinnedGraveId) {
                renderGraveOptions([{
                    grave_id: Number(pinnedGraveId),
                    grave_code: pinnedGraveCode || '',
                    _pinned: true,
                }], pinnedGraveId);
            } else {
                renderGraveOptions([], null);
            }
            return;
        }

        select.innerHTML = '';
        const loading = document.createElement('option');
        loading.value = '';
        loading.textContent = 'Loading...';
        loading.disabled = true;
        loading.selected = true;
        select.appendChild(loading);
        selectedSlot = null;

        let graves = [];
        let fetchError = null;
        try {
            graves = await fetchGravesForBlock(blockId);
        } catch (err) {
            fetchError = err;
        }

        if (token !== gravesToken) return;

        if (fetchError) {
            console.warn('[reserve_modal] Unable to fetch graves:', fetchError);
            setGraveCodeHint('Unable to load grave codes. Please try again.', true);
            renderGraveOptions([], null);
            return;
        }

        if (pinnedGraveId) {
            const pinId = Number(pinnedGraveId);
            const exists = graves.some(g => Number(g.grave_id) === pinId);
            if (!exists) {
                graves.unshift({
                    grave_id: pinId,
                    grave_code: pinnedGraveCode || '',
                    status: 'occupied',
                    _pinned: true,
                });
            }
        }

        if (!graves.length) {
            setGraveCodeHint('No available grave codes in this block.', true);
        } else {
            setGraveCodeHint('');
        }

        renderGraveOptions(graves, pinnedGraveId);
    }

    function onBlockChange() {
        const blockSelect = modalEl ? modalEl.querySelector('#block') : null;
        if (!blockSelect) return;

        const opt = blockSelect.options[blockSelect.selectedIndex];
        const blockId = opt ? opt.dataset.blockId : null;
        const blockName = (blockSelect.value || '').trim();

        if (currentMode === 'add' && addOriginalBlock) {
            if (blockName === addOriginalBlock) {
                restoreOriginalAddContext();
                return;
            }
            activeOldIntermentId = null;
            activeGraveId = null;
        }

        if (!blockId || !blockName) {
            renderGraveOptions([], null);
            setGraveCodeHint('');
            return;
        }

        const origBlock = String(pick(activeOriginalValues.block_name) || '').trim();
        const origGraveId = Number(pick(activeOriginalValues.grave_id)) || null;
        const origGraveCode = pick(activeOriginalValues.grave_code);

        let pinnedGraveId = null;
        let pinnedGraveCode = null;
        if (origBlock && origBlock === blockName && origGraveId) {
            pinnedGraveId = origGraveId;
            pinnedGraveCode = origGraveCode;
        }

        clearBlockChangeTimer();
        blockChangeTimer = setTimeout(() => {
            blockChangeTimer = null;
            loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
        }, BLOCK_CHANGE_DEBOUNCE_MS);
    }

    function restoreOriginalAddContext() {
        if (!modalEl) return;

        activeGraveId = addOriginalGraveId;
        activeOldIntermentId = addOriginalOldIntermentId;

        const select = modalEl.querySelector('#grave_code');
        if (select && select.tagName === 'SELECT') {
            const selId = Number(addOriginalGraveId) || null;
            if (selId && addOriginalGraveCode) {
                let match = Array.from(select.options).find(
                    o => o.dataset.graveId && Number(o.dataset.graveId) === selId
                );
                if (!match) {
                    const opt = document.createElement('option');
                    opt.value = addOriginalGraveCode;
                    opt.textContent = addOriginalGraveCode;
                    opt.dataset.graveId = String(selId);
                    opt.dataset.pinned = 'true';
                    select.appendChild(opt);
                    match = opt;
                }
                select.value = match.value;
                updateSelectedSlotFromGraveSelect();
            } else {
                select.value = '';
                selectedSlot = null;
            }
        }

        setGraveCodeHint('');
    }

    async function ensureLoaded() {
        modalEl = document.getElementById('burial_modal_overlay');
        if (modalEl) { bindEvents(); return; }

        if (!loadPromise) loadPromise = loadModalHtml();
        await loadPromise;

        modalEl = document.getElementById('burial_modal_overlay');
        if (modalEl) bindEvents();
    }

    async function loadModalHtml() {
        const paths = ['burial_modal.html', 'assets/html/burial_modal.html'];
        let html = null;

        for (const path of paths) {
            try {
                const res = await fetch(path);
                if (res.ok) { html = await res.text(); break; }
            } catch (_) { }
        }

        if (!html) {
            console.error('Failed to load burial_modal.html.');
            return;
        }

        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const fragment = parsed.getElementById('burial_modal_overlay');
        if (!fragment) {
            console.error('burial_modal.html missing #burial_modal_overlay.');
            return;
        }

        document.body.appendChild(document.adoptNode(fragment));
    }

    function bindEvents() {
        if (!modalEl || modalEl.dataset.reserveBound === 'true') return;
        modalEl.dataset.reserveBound = 'true';

        const cancelBtn = modalEl.querySelector('.paperCancelBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (currentMode === 'view' && isEditMode) {
                    exitEditMode(true);
                } else {
                    close();
                }
            });
        }

        modalEl.addEventListener('click', e => {
            if (e.target === modalEl && !isEditMode) close();
        });

        const form = modalEl.querySelector('#burial_clearance_form');
        if (form) form.addEventListener('submit', handleSubmit);

        const controlNo = modalEl.querySelector('#control_no');
        if (controlNo) {
            controlNo.removeAttribute('placeholder');
            controlNo.addEventListener('input', e => {
                e.target.value = formatControlNoInput(e.target.value);
            });
        }

        const phone = modalEl.querySelector('#req_phone');
        if (phone) {
            phone.addEventListener('input', e => {
                e.target.value = formatPhoneValue(e.target.value);
            });
            phone.addEventListener('blur', e => {
                if (!e.target.value) e.target.value = '+63';
            });
        }

        ['req_name', 'deceased_name'].forEach(id => {
            const field = modalEl.querySelector(`#${id}`);
            if (field) {
                field.addEventListener('input', e => {
                    e.target.value = formatNameValue(e.target.value);
                });
            }
        });

        const blockSelect = modalEl.querySelector('#block');
        if (blockSelect) {
            blockSelect.addEventListener('change', () => {
                if (!blockSelect.disabled) onBlockChange();
            });
        }

        const graveSelect = modalEl.querySelector('#grave_code');
        if (graveSelect) {
            graveSelect.addEventListener('change', () => {
                updateSelectedSlotFromGraveSelect();
                setGraveCodeHint('');
            });
        }

        const dateInterment = modalEl.querySelector('#date_interment');
        if (dateInterment) {
            dateInterment.addEventListener('input', recalcExpirationFromInterment);
            dateInterment.addEventListener('change', recalcExpirationFromInterment);
        }
    }

    async function open(a, b, c) {
        let mode, data, options;

        if (typeof a === 'string' && (a === 'view' || a === 'add')) {
            mode = a;
            data = (b && typeof b === 'object') ? b : {};
            options = (c && typeof c === 'object') ? c : {};
        } else if (a && typeof a === 'object') {
            data = a;
            options = (b && typeof b === 'object') ? b : {};
            mode = detectMode(data);
        } else {
            mode = 'add';
            data = {};
            options = {};
        }

        await ensureLoaded();
        if (!modalEl) return;

        currentMode = mode;
        isEditMode = false;

        activeGraveId = Number(data.grave_id) || null;
        activeOldIntermentId = data.old_interment_id || data.interment_id || null;

        takenControlNos = Array.isArray(options.takenControlNos)
            ? options.takenControlNos.map(v => String(v).trim().toUpperCase())
            : [];

        const form = modalEl.querySelector('#burial_clearance_form');
        if (form) form.reset();

        if (form) {
            if (mode === 'view') {
                form.setAttribute('novalidate', 'novalidate');
            } else {
                form.removeAttribute('novalidate');
            }
        }

        modalEl.classList.toggle('view-mode', mode === 'view');

        ensureGraveCodeSelect();

        blocksPromise = null;
        await loadBlocks();
        renderBlockOptions('');

        const d = { ...data };

        if (mode === 'add') {
            const preservedBlockName = pick(data.block_name, data.block);
            const preservedGraveCode = pick(data.grave_code);
            const preservedGraveId = Number(data.grave_id) || null;
            const preservedOldId = data.old_interment_id || data.interment_id || null;

            Object.keys(d).forEach(k => { delete d[k]; });

            d.block_name = preservedBlockName;
            d.grave_code = preservedGraveCode;
            d.grave_id = preservedGraveId;
            if (data.row_num != null) d.row_num = data.row_num;
            if (data.col_num != null) d.col_num = data.col_num;

            d.clearance_date = todayISO();
            d.control_no = generateControlNo();
            d.req_phone = '+63';

            addOriginalBlock = preservedBlockName;
            addOriginalGraveCode = preservedGraveCode;
            addOriginalGraveId = preservedGraveId;
            addOriginalOldIntermentId = preservedOldId;
        } else {
            addOriginalBlock = '';
            addOriginalGraveCode = '';
            addOriginalGraveId = null;
            addOriginalOldIntermentId = null;
        }

        activeOriginalValues = {
            block_name: pick(data.block_name, data.block),
            grave_code: pick(data.grave_code),
            grave_id: pick(data.grave_id, data.current_grave_id),
            block_type: pick(data.block_type, data.burial_block),
            assistance_type: pick(data.assistance_type, data.req_assistance),
            remarks: pick(data.interment_remarks, data.remarks),
            date_interment: pick(data.plan_date_interment, data.date_buried, data.date_interment),
            expiration_date: pick(data.plan_expiration_date, data.lease_expiration_date, data.expiration_date),
            exhumation_permit_number: pick(data.plan_exhumation_permit_number, data.exhumation_permit_number),
            transfer_permit_number: pick(data.plan_transfer_permit_number, data.transfer_permit_number),
        };

        viewSnapshot = { ...d };

        populateFields(d);
        setEditable(mode);

        resetGraveSelectUI();

        const blockSelect = modalEl.querySelector('#block');
        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const blockName = blockSelect.value;

            const origBlock = String(pick(activeOriginalValues.block_name) || '').trim();
            const origGraveId = Number(pick(activeOriginalValues.grave_id)) || null;
            const origGraveCode = pick(activeOriginalValues.grave_code);

            let pinnedGraveId = null;
            let pinnedGraveCode = null;
            if (origBlock === blockName && origGraveId) {
                pinnedGraveId = origGraveId;
                pinnedGraveCode = origGraveCode;
            }

            if (blockId) {
                await loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
            } else if (pinnedGraveId) {
                renderGraveOptions([{
                    grave_id: pinnedGraveId,
                    grave_code: pinnedGraveCode || '',
                    _pinned: true,
                }], pinnedGraveId);
            } else {
                renderGraveOptions([], null);
            }
        } else {
            renderGraveOptions([], null);
        }

        modalEl.style.display = 'block';
        modalEl.classList.add('active');
    }

    function populateFields(data) {
        const setFieldValue = (id, value) => {
            const field = modalEl.querySelector(`#${id}`);
            if (!field) return;

            const strValue = pick(value);

            if (field.tagName === 'SELECT') {
                const stale = field.querySelector('option[data-placeholder="true"]');
                if (stale) stale.remove();

                let matched = Array.from(field.options).find(
                    opt => opt.value === strValue || opt.text === strValue
                );

                if (!matched && strValue) {
                    const lower = strValue.toLowerCase();
                    matched = Array.from(field.options).find(
                        opt =>
                            opt.value.toLowerCase() === lower ||
                            opt.text.toLowerCase().includes(lower) ||
                            lower.includes(opt.value.toLowerCase())
                    );
                }

                if (!matched && strValue) {
                    const opt = document.createElement('option');
                    opt.value = strValue;
                    opt.textContent = strValue;
                    field.appendChild(opt);
                    field.value = strValue;
                } else if (matched) {
                    field.value = matched.value;
                }
            } else {
                field.value = strValue;
            }
        };

        if (currentMode === 'add') {
            setFieldValue('control_no', data.control_no);
            setFieldValue('clearance_date', data.clearance_date);

            setFieldValue('req_name', pick(data.contact_person_name, data.req_name));
            setFieldValue('req_email', pick(data.contact_person_email, data.req_email, data.contactEmail, data.email));
            setFieldValue('req_phone', pick(data.contact_person_phone_number, data.req_phone) || '+63');
            setFieldValue('req_street', pick(data.contact_person_address, data.req_street));

            const brgy = pick(data.contact_person_address_barangay, data.requesting_barangay)
                .replace(/^(Barangay|Brgy\.\s*)/i, '').trim();
            setFieldValue('requesting_barangay', brgy);

            const rawAssist = pick(data.assistance, data.assistance_type, data.req_assistance);
            let mappedAssist = rawAssist;
            if (/burial/i.test(rawAssist)) mappedAssist = 'Burial of the late';
            else if (/transfer|exhumation/i.test(rawAssist)) mappedAssist = 'Transfer the remains of the late to the bone chamber';
            else if (/^other/i.test(rawAssist)) mappedAssist = 'Other...';
            setFieldValue('req_assistance', mappedAssist);

            setFieldValue('deceased_name', pick(data.deceased_name));
            setFieldValue('deceased_sex', pick(data.deceased_sex));
            setFieldValue('deceased_dob', pick(data.deceased_date_of_birth, data.deceased_dob));
            setFieldValue('deceased_bod', pick(data.deceased_date_of_death, data.deceased_bod));
            setFieldValue('deceased_address', pick(data.last_known_address, data.deceased_address));
            setFieldValue('deceased_cert', pick(data.death_certificate, data.deceased_cert));

            setFieldValue('permit_burial', pick(data.burial_permit_number, data.permit_burial));
            setFieldValue('permit_exhumation', pick(data.exhumation_permit_number, data.permit_exhumation));
            setFieldValue('permit_transfer', pick(data.transfer_permit_number, data.permit_transfer));

            const rawType = pick(data.burialType, data.burial_type, data.burial_block);
            let mappedType = rawType;
            if (/niche|wall/i.test(rawType)) mappedType = 'Niche Wall';
            else if (/bone/i.test(rawType)) mappedType = 'Bone Chamber';
            else if (/lawn|ground|standard/i.test(rawType)) mappedType = 'Lawn / Grounds';
            setFieldValue('burial_block', mappedType);

            setFieldValue('block', pick(data.block_name, data.block));

            setFieldValue('deceased_remarks', pick(data.interment_remarks, data.remarks));

            recalcExpirationFromInterment();
            return;
        }

        setFieldValue('clearance_date', pick(data.burial_clearance_date, data.clearance_date));
        setFieldValue('control_no', pick(data.control_number, data.control_no));

        setFieldValue('req_name', pick(data.contact_person_name, data.req_name));
        setFieldValue('req_email', pick(data.contact_person_email, data.req_email, data.contactEmail, data.email)); 

        const rawPhone = pick(data.contact_person_phone_number, data.req_phone);
        setFieldValue('req_phone', rawPhone ? formatPhoneValue(rawPhone) : '');

        setFieldValue('req_street', pick(data.contact_person_address, data.req_street));

        const rawBrgy = pick(data.contact_person_address_barangay, data.requesting_barangay)
            .replace(/^(Barangay|Brgy\.\s*)/i, '').trim();
        setFieldValue('requesting_barangay', rawBrgy);

        const rawAssist = pick(data.plan_assistance_type, data.assistance_type, data.req_assistance);
        let mappedAssist = rawAssist;
        if (/burial/i.test(rawAssist)) mappedAssist = 'Burial of the late';
        else if (/transfer|exhumation/i.test(rawAssist)) mappedAssist = 'Transfer the remains of the late to the bone chamber';
        else if (/^other/i.test(rawAssist)) mappedAssist = 'Other...';
        setFieldValue('req_assistance', mappedAssist);

        setFieldValue('deceased_name', pick(data.deceased_name));
        setFieldValue('deceased_sex', pick(data.deceased_sex));
        setFieldValue('deceased_dob', pick(data.deceased_date_of_birth, data.deceased_dob));
        setFieldValue('deceased_bod', pick(data.deceased_date_of_death, data.deceased_bod));
        setFieldValue('deceased_address', pick(data.last_known_address, data.deceased_address));
        setFieldValue('deceased_cert', pick(data.death_certificate, data.deceased_cert));

        setFieldValue('permit_burial', pick(data.burial_permit_number, data.permit_burial));

        setFieldValue(
            'permit_exhumation',
            pick(data.plan_exhumation_permit_number, data.exhumation_permit_number, data.permit_exhumation)
        );
        setFieldValue(
            'permit_transfer',
            pick(data.plan_transfer_permit_number, data.transfer_permit_number, data.permit_transfer)
        );

        const rawType = pick(data.plan_burial_type, data.block_type, data.burial_block);
        let mappedType = rawType;
        if (/niche|wall/i.test(rawType)) mappedType = 'Niche Wall';
        else if (/bone/i.test(rawType)) mappedType = 'Bone Chamber';
        else if (/lawn|ground|standard/i.test(rawType)) mappedType = 'Lawn / Grounds';
        setFieldValue('burial_block', mappedType);

        setFieldValue('block', pick(data.plan_block_name, data.block_name, data.block));

        setFieldValue('date_interment', pick(data.plan_date_interment, data.date_buried, data.date_interment));
        setFieldValue('expiration_date', pick(data.plan_expiration_date, data.lease_expiration_date, data.expiration_date));

        setFieldValue('deceased_remarks', pick(data.plan_remarks, data.interment_remarks, data.remarks));
    }

    function setEditable(mode) {
        const fields = modalEl.querySelectorAll('input, select, textarea');

        fields.forEach(field => {
            if (field.tagName === 'SELECT') {
                field.style.webkitAppearance = '';
                field.style.appearance = '';
                field.style.backgroundImage = '';
                field.style.backgroundRepeat = '';
                field.style.backgroundPosition = '';
                field.style.backgroundSize = '';
                field.style.paddingRight = '';
                field.style.pointerEvents = '';
                field.style.cursor = '';
                field.style.opacity = '';
                field.style.visibility = '';
            }

            if (field.id === 'expiration_date') {
                field.disabled = true;
                field.readOnly = true;
                field.setAttribute('aria-readonly', 'true');
                return;
            }

            if (field.id === 'control_no') {
                field.readOnly = mode === 'view';
                if (field.hasAttribute('placeholder')) field.removeAttribute('placeholder');
                return;
            }

            if (field.id === 'grave_code') {
                let editable;
                if (mode === 'view') {
                    editable = isEditMode && VIEW_EDITABLE_FIELDS.includes('block');
                } else {
                    editable = !ADD_READONLY_FIELDS.includes('grave_code');
                }
                if (field.tagName === 'SELECT') {
                    field.disabled = !editable;
                } else {
                    field.readOnly = !editable;
                    field.disabled = false;
                }
                return;
            }

            let editable;
            if (mode === 'view') {
                editable = isEditMode && VIEW_EDITABLE_FIELDS.includes(field.id);
            } else {
                editable = !ADD_READONLY_FIELDS.includes(field.id);
            }

            if (field.tagName === 'SELECT') {
                field.disabled = !editable;
            } else {
                field.readOnly = !editable;
            }
        });

        if (mode === 'view' && isEditMode) {
            VIEW_EDITABLE_SELECTS.forEach(id => {
                const sel = modalEl.querySelector(`#${id}`);
                if (!sel || sel.tagName !== 'SELECT') return;

                sel.disabled = false;
                sel.removeAttribute('disabled');
                sel.style.pointerEvents = 'auto';
                sel.style.cursor = 'pointer';
                sel.style.webkitAppearance = 'none';
                sel.style.appearance = 'none';
                sel.style.backgroundRepeat = 'no-repeat';
                sel.style.backgroundPosition = 'right 12px center';
                sel.style.backgroundSize = '10px 6px';
                sel.style.backgroundImage = SELECT_ARROW_SVG;
                sel.style.paddingRight = '28px';
            });
        }

        updateButtons(mode);
    }

    function updateButtons(mode) {
        const saveBtn = modalEl.querySelector('.paperSaveBtn');
        const cancelBtn = modalEl.querySelector('.paperCancelBtn');

        if (saveBtn) {
            saveBtn.style.display = 'inline-block';
            saveBtn.textContent = (mode === 'view' && !isEditMode) ? 'Edit' : 'Save';
        }
        if (cancelBtn) {
            cancelBtn.textContent = 'Cancel';
        }
    }

    function enterEditMode() {
        isEditMode = true;
        setEditable(currentMode);

        const blockSelect = modalEl.querySelector('#block');
        if (blockSelect) renderBlockOptions(blockSelect.value || '');

        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const blockName = blockSelect.value;

            const origBlock = String(pick(activeOriginalValues.block_name) || '').trim();
            const origGraveId = Number(pick(activeOriginalValues.grave_id)) || null;
            const origGraveCode = pick(activeOriginalValues.grave_code);

            let pinnedGraveId = null;
            let pinnedGraveCode = null;
            if (origBlock === blockName && origGraveId) {
                pinnedGraveId = origGraveId;
                pinnedGraveCode = origGraveCode;
            }

            if (blockId) {
                loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
            } else if (pinnedGraveId) {
                renderGraveOptions([{
                    grave_id: pinnedGraveId,
                    grave_code: pinnedGraveCode || '',
                    _pinned: true,
                }], pinnedGraveId);
            } else {
                resetGraveSelectUI();
            }
        } else {
            resetGraveSelectUI();
        }
    }

    function exitEditMode(discard) {
        if (discard) {
            populateFields({ ...viewSnapshot });
        }
        isEditMode = false;
        setEditable(currentMode);

        const blockSelect = modalEl.querySelector('#block');
        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const blockName = blockSelect.value;

            const origBlock = String(pick(activeOriginalValues.block_name) || '').trim();
            const origGraveId = Number(pick(activeOriginalValues.grave_id)) || null;
            const origGraveCode = pick(activeOriginalValues.grave_code);

            let pinnedGraveId = null;
            let pinnedGraveCode = null;
            if (origBlock === blockName && origGraveId) {
                pinnedGraveId = origGraveId;
                pinnedGraveCode = origGraveCode;
            }

            if (blockId) {
                loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
            } else if (pinnedGraveId) {
                renderGraveOptions([{
                    grave_id: pinnedGraveId,
                    grave_code: pinnedGraveCode || '',
                    _pinned: true,
                }], pinnedGraveId);
            } else {
                resetGraveSelectUI();
            }
        } else {
            resetGraveSelectUI();
        }
    }

    function applySavedViewState() {
        if (!modalEl) return;

        const savedValues = {
            block_name: (modalEl.querySelector('#block')?.value || '').trim(),
            grave_code: (modalEl.querySelector('#grave_code')?.value || '').trim().toUpperCase(),
            burial_block: modalEl.querySelector('#burial_block')?.value || '',
            assistance_type: modalEl.querySelector('#req_assistance')?.value || '',
            remarks: (modalEl.querySelector('#deceased_remarks')?.value || '').trim(),
            date_interment: (modalEl.querySelector('#date_interment')?.value || '').trim(),
            expiration_date: (modalEl.querySelector('#expiration_date')?.value || '').trim(),
            exhumation_permit_number: (modalEl.querySelector('#permit_exhumation')?.value || '').trim(),
            transfer_permit_number: (modalEl.querySelector('#permit_transfer')?.value || '').trim(),
        };

        viewSnapshot = { ...viewSnapshot, ...savedValues };

        activeOriginalValues = {
            ...activeOriginalValues,
            block_name: savedValues.block_name,
            grave_code: savedValues.grave_code,
            grave_id: (selectedSlot && selectedSlot.grave_id) || activeOriginalValues.grave_id,
            block_type: savedValues.burial_block,
            assistance_type: savedValues.assistance_type,
            remarks: savedValues.remarks,
            date_interment: savedValues.date_interment,
            expiration_date: savedValues.expiration_date,
            exhumation_permit_number: savedValues.exhumation_permit_number,
            transfer_permit_number: savedValues.transfer_permit_number,
        };

        isEditMode = false;
        setEditable(currentMode);
    }

    function handleSubmit(event) {
        event.preventDefault();

        if (currentMode === 'view') {
            if (!isEditMode) {
                enterEditMode();
                return;
            }

            if (!activeOldIntermentId) {
                console.error('[reserve] Missing interment ID.');
                return;
            }

            updateSelectedSlotFromGraveSelect();

            const remarks = (modalEl.querySelector('#deceased_remarks')?.value || '').trim();
            const newBlock = (modalEl.querySelector('#block')?.value || '').trim();
            const newGraveCode = (modalEl.querySelector('#grave_code')?.value || '').trim().toUpperCase();
            const newBurialType = modalEl.querySelector('#burial_block')?.value || '';
            const newAssistance = modalEl.querySelector('#req_assistance')?.value || '';
            const newDateInterment = (modalEl.querySelector('#date_interment')?.value || '').trim();
            const newExpiration = (modalEl.querySelector('#expiration_date')?.value || '').trim();
            const newExhumation = (modalEl.querySelector('#permit_exhumation')?.value || '').trim();
            const newTransfer = (modalEl.querySelector('#permit_transfer')?.value || '').trim();

            let assistance = 'Other';
            if (/^burial/i.test(newAssistance)) assistance = 'Burial';
            else if (/transfer/i.test(newAssistance)) assistance = 'Transfer the remains of the late';

            const saveBtn = modalEl.querySelector('.paperSaveBtn');
            if (saveBtn) saveBtn.disabled = true;

            const reEnableSave = () => {
                if (!modalEl) return;
                const btn = modalEl.querySelector('.paperSaveBtn');
                if (btn) btn.disabled = false;
            };

            document.dispatchEvent(new CustomEvent('reserve_burial_modal:update', {
                detail: {
                    old_interment_id: activeOldIntermentId,
                    target_grave_id: (selectedSlot && selectedSlot.grave_id) || activeGraveId,
                    data: {
                        block_name: newBlock,
                        grave_code: newGraveCode,
                        burial_type: newBurialType,
                        assistance_type: assistance,
                        remarks,
                        date_interment: newDateInterment,
                        expiration_date: newExpiration,
                        exhumation_permit_number: newExhumation,
                        transfer_permit_number: newTransfer,
                    },
                    onSuccess: () => {
                        reEnableSave();
                        if (!isEditMode) return;
                        applySavedViewState();
                    },
                    onError: () => {
                        reEnableSave();
                    },
                },
            }));

            return;
        }

        const phoneRaw = modalEl.querySelector('#req_phone')?.value.trim() || '';
        const phoneDigits = phoneRaw.replace(/\D/g, '').replace(/^63/, '');
        if (phoneDigits.length !== 10) {
            warn('Phone number must be in the format +63 XXX XXX XXXX.');
            return;
        }

        const controlNoField = modalEl.querySelector('#control_no');
        const controlNo = (controlNoField?.value || '').trim().toUpperCase();

        if (!/^CTRL-\d{4}-\d{3}$/.test(controlNo)) {
            warn('Control No. must follow the format CTRL-YYYY-NNN (e.g., CTRL-2026-001).');
            controlNoField?.focus();
            return;
        }
        if (controlNoExists(controlNo)) {
            warn(`Control No. "${controlNo}" is already used by another record.`);
            controlNoField?.focus();
            return;
        }

        const assistRaw = modalEl.querySelector('#req_assistance')?.value || '';
        let assistance = 'Other';
        if (/^burial/i.test(assistRaw)) assistance = 'Burial';
        else if (/transfer/i.test(assistRaw)) assistance = 'Transfer the remains of the late';

        const blockName = (modalEl.querySelector('#block')?.value || '').trim();
        if (!blockName) {
            warn('Block is missing. Please reopen the Add modal from the Reserve table.');
            return;
        }

        updateSelectedSlotFromGraveSelect();

        const graveCode = (modalEl.querySelector('#grave_code')?.value || '').trim().toUpperCase();
        if (!graveCode) {
            warn('Grave Code is missing. Please reopen the Add modal from the Reserve table.');
            return;
        }

        const targetGraveId =
            (selectedSlot && selectedSlot.grave_id) ||
            activeGraveId ||
            addOriginalGraveId ||
            null;

        recalcExpirationFromInterment();

        const dateInterment = modalEl.querySelector('#date_interment')?.value || null;
        const expirationDate = modalEl.querySelector('#expiration_date')?.value || null;

        const payload = {
            control_number: controlNo,
            deceased_name: modalEl.querySelector('#deceased_name')?.value.trim() || '',
            deceased_sex: modalEl.querySelector('#deceased_sex')?.value || '',
            deceased_date_of_birth: modalEl.querySelector('#deceased_dob')?.value || null,
            deceased_date_of_death: modalEl.querySelector('#deceased_bod')?.value || null,
            last_known_address: modalEl.querySelector('#deceased_address')?.value.trim() || '',
            death_certificate: modalEl.querySelector('#deceased_cert')?.value.trim() || '',
            contact_person_name: modalEl.querySelector('#req_name')?.value.trim() || '',
            contact_person_phone_number: phoneRaw,
            contact_person_email: 'noemail@reserve.local',
            contact_person_address: modalEl.querySelector('#req_street')?.value.trim() || '',
            contact_person_address_barangay: modalEl.querySelector('#requesting_barangay')?.value || '',
            assistance_type: assistance,
            burial_permit_number: modalEl.querySelector('#permit_burial')?.value.trim() || '',
            exhumation_permit_number: modalEl.querySelector('#permit_exhumation')?.value.trim() || '',
            transfer_permit_number: modalEl.querySelector('#permit_transfer')?.value.trim() || '',
            burial_clearance_date: modalEl.querySelector('#clearance_date')?.value || null,
            date_buried: dateInterment,
            lease_expiration_date: expirationDate,
            remarks: modalEl.querySelector('#deceased_remarks')?.value.trim() || '',
            block_name: blockName,
            block_type: modalEl.querySelector('#burial_block')?.value || '',
        };

        if (activeOldIntermentId) {
            payload.old_interment_id = activeOldIntermentId;
        } else if (targetGraveId) {
            payload.grave_id = targetGraveId;
            payload.grave_code = graveCode;
        } else {
            warn('No target grave could be determined. Please reopen the Add modal.');
            return;
        }

        document.dispatchEvent(new CustomEvent('reserve_burial_modal:save', {
            detail: { mode: currentMode, data: payload },
        }));

        close();
    }

    function close() {
        if (!modalEl) return;

        modalEl.style.display = 'none';
        modalEl.classList.remove('active');

        clearBlockChangeTimer();
        gravesToken++;

        selectedSlot = null;
        isEditMode = false;
        viewSnapshot = {};

        addOriginalBlock = '';
        addOriginalGraveCode = '';
        addOriginalGraveId = null;
        addOriginalOldIntermentId = null;
    }

    return { open, close };
})();

window.ReserveBurialModal = ReserveBurialModal;
window.closeReserveBurialModal = () => ReserveBurialModal.close();

window.openReserveBurialModal = (item, options) => ReserveBurialModal.open('add', item, options);
window.openViewBurialModal = (item, options) => ReserveBurialModal.open('view', item, options);