const MonitorBurialModal = (() => {
    // ------------------------------------------------------------------
    // module state
    // ------------------------------------------------------------------
    let modalEl = null;
    let loadPromise = null;
    let bound = false;

    let reservation = null;
    let wizardMode = null;          // 'old' | 'new' | null
    let submissionSucceeded = false;

    let oldOccupantOriginal = null; // flat O data at open time
    let newOccupantOriginal = null; // flat N data at open time
    let oldModeSnapshot = null;     // form fields when leaving Old step
    let newModeSnapshot = null;     // form fields when leaving New step

    let burialTypePlaceholderText = null;

    let blocksPromise = null;
    let blockOptions = [];
    let selectedSlot = null;

    let blockChangeTimer = null;
    let gravesToken = 0;

    let nextBtn = null;
    let backBtn = null;

    // ▼ ADDED: header element ref (parity with Reserve)
    let locationHeaderEl = null;

    // Cache for the barangay_options settings fetch (idempotent, retries on error).
    let barangayOptionsPromise = null;

    const MONITOR_API = 'api/monitor.php';
    const BLOCKS_API = 'api/blocks.php';
    const GRAVES_API = 'api/graves.php';
    const SETTINGS_API = 'api/settings';

    const LEASE_YEARS = 5;
    const BLOCK_CHANGE_DEBOUNCE_MS = 250;

    const INTERMENT_FIELD_IDS = ['date_buried', 'date_interment'];
    const EXPIRATION_FIELD_IDS = ['lease_expiration_date', 'expiration_date'];

    // ▼ CHANGED: removed OLD_DIRECT_EDIT_FIELDS whitelist — old occupant
    //            is fully editable, matching Reserve's setEditable("old").

    // Fields locked when editing the New occupant.
    const NEW_OCCUPANT_READONLY_FIELDS = new Set([
        'status',
        'block',
        'grave_code',
        'burial_block',
    ]);

    // O bio fields staged into old_edited_fields (php allow-list).
    const OLD_EDITABLE_STRING_FIELDS = [
        'deceased_name',
        'last_known_address',
        'death_certificate',
        'contact_person_name',
        'contact_person_phone_number',
        'contact_person_email',
        'contact_person_address',
        'contact_person_address_barangay',
        'burial_permit_number',
        'transfer_permit_number',
        'transfer_permit_issued_by',
        'exhumation_permit_number',
        'remarks',
    ];
    const OLD_EDITABLE_DATE_FIELDS = [
        'deceased_date_of_birth',
        'deceased_date_of_death',
        'burial_permit_date',
        'transfer_permit_date',
        'exhumation_permit_date',
        'date_exhumed',
        'burial_clearance_date',
    ];
    const OLD_EDITABLE_ENUM_FIELDS = {
        deceased_sex: ['Male', 'Female', 'Unknown'],
    };

    // ==================================================================
    // Raw-error sanitization
    // Prevents ngrok/proxy HTML pages, bare HTTP status codes, JSON parse
    // failures, and network failures from reaching showAlertTOP or the
    // shared confirm modal's error display.
    // ==================================================================
    const GENERIC_ERROR = 'Something went wrong. Please try again.';

    const looksRawMessage = (text) => {
        if (!text) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;                          // HTML body
        if (/ERR_NGROK_|ngrok/i.test(t)) return true;                            // ngrok
        if (/^HTTP\s+\d{3}/i.test(t)) return true;                               // bare "HTTP 502"
        if (/^Save failed \(\d{3}\)$/i.test(t)) return true;                     // our own fallback
        if (/non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(t)) return true;
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
        if (/^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(t)) return true;
        if (t.length > 200) return true;                                          // giant dumps
        return false;
    };

    function friendlyMessage(raw, fallback) {
        if (!raw) return fallback || GENERIC_ERROR;
        const s = String(raw).trim();
        if (!s || looksRawMessage(s)) return fallback || GENERIC_ERROR;
        return s;
    }

    // ==================================================================
    // styles
    // ==================================================================
    function injectWizardStyles() {
        if (document.getElementById('reserveWizardMiniStyles')) return;
        const style = document.createElement('style');
        style.id = 'reserveWizardMiniStyles';
        style.textContent = `
            /* ▼ ADDED: location header (parity with Reserve) */
            #burial_modal_overlay .wizardLocationHeader {
                margin: 0 0 16px 0;
                padding: 6px 10px;
                background: #f4f8ff;
                border-left: 3px solid #2b6cd4;
                border-radius: 4px;
                font-size: 0.95rem;
                font-weight: 600;
                color: #1f2a3d;
                width: 100%;
                box-sizing: border-box;
            }
            #burial_modal_overlay .wizardLocationHeader .locName { color: #2b6cd4; }
            #burial_modal_overlay .wizardLocationHeader .locCurrent {
                font-weight: 400;
                font-size: 0.85rem;
                color: #56637a;
            }
            /* ▲ ADDED */

            #burial_modal_overlay .paperFormActions {
                display: flex !important;
                align-items: center;
                gap: 8px;
            }
            #burial_modal_overlay .paperFormActions .paperBackBtn  { order: 1; }
            #burial_modal_overlay .paperFormActions .paperCancelBtn {
                order: 2;
                margin-right: auto;
            }
            #burial_modal_overlay .paperFormActions .paperNextBtn { order: 3; }
            #burial_modal_overlay .paperFormActions .paperSaveBtn { order: 4; }

            #burial_modal_overlay .paperFormActions .paperNextBtn,
            #burial_modal_overlay .paperFormActions .paperBackBtn {
                font: inherit;
                padding: 8px 18px;
                border-radius: 6px;
                border: 1px solid #c4cdd9;
                background: #fff;
                color: #2b3a55;
                cursor: pointer;
                min-width: 100px;
            }
            #burial_modal_overlay .paperFormActions .paperNextBtn:hover,
            #burial_modal_overlay .paperFormActions .paperBackBtn:hover {
                background: #eef3fb;
            }

            #burial_modal_overlay #lease_expiration_date,
            #burial_modal_overlay #expiration_date {
                background: #eef2f8;
                color: #475569;
                cursor: not-allowed;
            }
        `;
        document.head.appendChild(style);
    }

    // ==================================================================
    // remarks hint UI (subtle floating pill over empty textarea)
    // ==================================================================
    function injectRemarksHintStyles() {
        if (document.getElementById('remarksHintStyles')) return;
        const style = document.createElement('style');
        style.id = 'remarksHintStyles';
        style.textContent = `
            .remarksFloatHint {
                position: absolute;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 4px 10px;
                font-size: 11.5px;
                font-weight: 500;
                line-height: 1.35;
                color: #8a6d3b;
                background: #fdf6e3;
                border: 1px dashed #e8d9a8;
                border-radius: 999px;
                white-space: nowrap;
                user-select: none;
                pointer-events: none;
                opacity: 0.85;
                z-index: 2;
            }
            .remarksFloatHint i {
                font-size: 10px;
                opacity: 0.7;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureRemarksHint() {
        if (!modalEl) return;
        const remarksField = modalEl.querySelector('#remarks');
        if (!remarksField) return;

        if (remarksField._remarksHint) {
            if (typeof remarksField._remarksHintUpdate === 'function') {
                remarksField._remarksHintUpdate();
            }
            return;
        }

        const parent = remarksField.parentElement;
        if (!parent) return;

        injectRemarksHintStyles();

        if (window.getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }

        const hint = document.createElement('span');
        hint.className = 'remarksFloatHint';
        hint.setAttribute('aria-hidden', 'true');
        hint.innerHTML =
            '<i class="fas fa-pen-to-square"></i>Add remarks if possible';
        hint.style.display = 'none';

        parent.appendChild(hint);

        const positionHint = () => {
            if (hint.style.display === 'none') return;
            const fieldRect = remarksField.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            if (!fieldRect.width || !parentRect.width) return;
            hint.style.top = fieldRect.top - parentRect.top + 8 + 'px';
            hint.style.right = parentRect.right - fieldRect.right + 12 + 'px';
        };

        const update = () => {
            // Hidden if: submitted, no active wizard (view/initial), or has value.
            if (submissionSucceeded || !wizardMode) {
                hint.style.display = 'none';
                return;
            }
            const val = (remarksField.value || '').trim();
            if (val === '') {
                hint.style.display = 'inline-flex';
                requestAnimationFrame(positionHint);
            } else {
                hint.style.display = 'none';
            }
        };

        remarksField.addEventListener('input', update);
        remarksField.addEventListener('change', update);

        remarksField._remarksHint = hint;
        remarksField._remarksHintUpdate = update;
        update();
    }

    function refreshRemarksHint() {
        if (!modalEl) return;
        const remarksField = modalEl.querySelector('#remarks');
        if (!remarksField || typeof remarksField._remarksHintUpdate !== 'function') {
            ensureRemarksHint();
            return;
        }
        remarksField._remarksHintUpdate();
    }

    // ==================================================================
    // utilities
    // ==================================================================
    function warn(message) {
        if (!message) return;
        if (typeof window.showAlertTOP === 'function') {
            window.showAlertTOP(String(message), 'warning');
            return;
        }
        console.warn('[MonitorModal]', message);
    }

    // Same contract as monitor.js — uses the shared confirm modal if loaded.
    function confirmDialog(opts) {
        if (typeof window.showConfirmModal === 'function') return window.showConfirmModal(opts);
        const plain = [opts.title, opts.message].filter(Boolean).join('\n\n');
        return Promise.resolve(window.confirm(plain));
    }

    function pick(...values) {
        for (const v of values) {
            if (v === null || v === undefined) continue;
            const s = String(v).trim();
            if (s !== '' && s !== 'N/A') return s;
        }
        return '';
    }

    function sliceDate(val) {
        if (val === null || val === undefined) return '';
        const s = String(val).trim();
        if (!s) return '';
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
        return m ? m[1] : s;
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
        const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
        const probe = new Date(y, mo - 1, d);
        if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return '';
        const tY = y + years, tM = mo - 1;
        const lastDay = new Date(tY, tM + 1, 0).getDate();
        const r = new Date(tY, tM, Math.min(d, lastDay));
        return `${r.getFullYear()}-${String(r.getMonth() + 1).padStart(2, '0')}-${String(r.getDate()).padStart(2, '0')}`;
    }

    function getIntermentField() {
        if (!modalEl) return null;
        for (const id of INTERMENT_FIELD_IDS) {
            const el = modalEl.querySelector('#' + id);
            if (el) return el;
        }
        return null;
    }
    function getExpirationField() {
        if (!modalEl) return null;
        for (const id of EXPIRATION_FIELD_IDS) {
            const el = modalEl.querySelector('#' + id);
            if (el) return el;
        }
        return null;
    }
    function recalcExpirationFromInterment() {
        if (!modalEl) return;
        const i = getIntermentField();
        const e = getExpirationField();
        if (!i || !e) return;
        const raw = (i.value || '').trim();
        e.value = raw ? addYearsISO(raw, LEASE_YEARS) : '';
    }

    // ▼ ADDED: location header helpers (parity with Reserve)
    function ensureLocationHeader() {
        if (!modalEl) return;
        injectWizardStyles();
        const burialBlock = modalEl.querySelector('#burial_block');
        if (!burialBlock) return;
        const wrapper = burialBlock.closest('.col') || burialBlock.parentElement;
        if (!wrapper) return;

        const stray = modalEl.querySelector('.wizardLocationHeader');
        if (stray && stray !== locationHeaderEl) stray.remove();

        if (!locationHeaderEl || !document.body.contains(locationHeaderEl)) {
            const h = document.createElement('div');
            h.className = 'wizardLocationHeader';
            h.innerHTML = `Where will <span class="locName">this person</span> go? <span class="locCurrent"></span>`;
            const row = wrapper.closest('.row') || wrapper.parentNode;
            row.parentNode.insertBefore(h, row);
            locationHeaderEl = h;
        }
    }

    function updateLocationHeaderText(name, currentInfo) {
        ensureLocationHeader();
        const span = locationHeaderEl?.querySelector('.locName');
        if (span) span.textContent = name || 'this person';

        const cur = locationHeaderEl?.querySelector('.locCurrent');
        if (cur) {
            if (currentInfo) cur.textContent = ` (they are currently in the ${currentInfo})`;
            else cur.textContent = '(Locked, going into this assigned grave)';
        }
    }

    function refreshOldOccupantHeader() {
        if (!modalEl) return;
        const nameEl = modalEl.querySelector('#deceased_name');
        const fromField = (nameEl?.value || '').trim();
        const name =
            fromField ||
            pick(oldOccupantOriginal?.deceased_name, oldModeSnapshot?.deceased_name) ||
            'this occupant';

        // ▼ FIXED: "currently at" should show O's CURRENT grave (the target
        //          grave N is moving into), not O's destination.
        const srcBlock = pick(
            reservation?.target_grave?.block_name,
            oldOccupantOriginal?.block
        );
        const srcGrave = pick(
            reservation?.target_grave?.grave_code,
            oldOccupantOriginal?.grave_code
        );
        // ▲ FIXED
        const info = (srcBlock || srcGrave) ? `${srcBlock || '—'} / ${srcGrave || '—'}` : '';
        updateLocationHeaderText(name, info);
    }

    function refreshNewOccupantHeader() {
        if (!modalEl) return;
        const nameEl = modalEl.querySelector('#deceased_name');
        const fromField = (nameEl?.value || '').trim();
        const name = fromField || pick(newModeSnapshot?.deceased_name) || 'the incoming person';
        updateLocationHeaderText(name, '');
    }
    // ▲ ADDED

    function normalizeType(value) {
        const s = String(value || '').trim();
        if (!s) return '';
        if (/niche|wall/i.test(s)) return 'Niche';
        if (/bone/i.test(s)) return 'Bone Chamber';
        if (/lawn|ground|standard/i.test(s)) return 'Lawn/Grounds';
        if (/unmapped/i.test(s)) return 'Unmapped Area';
        if (/private|owned/i.test(s)) return 'Private';
        if (/mausoleum/i.test(s)) return 'Mausoleum';
        if (/mass/i.test(s)) return 'Mass Grave';
        if (/cluster/i.test(s)) return 'Cluster';
        if (/^block\b/i.test(s)) return 'Block';
        return s;
    }

    function blocksMatchingType(typeLabel) {
        const norm = normalizeType(typeLabel);
        if (!norm) return blockOptions;
        return blockOptions.filter(b => normalizeType(b.type) === norm);
    }

    function currentBurialType() {
        const select = modalEl ? modalEl.querySelector('#burial_block') : null;
        return select ? (select.value || '') : '';
    }

    function setBurialTypeFromBlockType(blockType) {
        if (!modalEl) return;
        const select = modalEl.querySelector('#burial_block');
        if (!select || select.tagName !== 'SELECT') return;
        const raw = String(blockType || '').trim();
        if (!raw) { select.value = ''; return; }
        const norm = normalizeType(raw);
        let matched = Array.from(select.options).find(o => o.value !== '' && normalizeType(o.value) === norm);
        if (!matched) matched = Array.from(select.options).find(o => o.value === raw);
        if (!matched) {
            const opt = document.createElement('option');
            opt.value = raw; opt.textContent = raw;
            select.appendChild(opt);
            matched = opt;
        }
        select.value = matched.value;
        updateBurialTypePlaceholder();
    }

    function updateBurialTypePlaceholder() {
        if (!modalEl) return;
        const select = modalEl.querySelector('#burial_block');
        if (!select || select.tagName !== 'SELECT') return;
        if (!select.options.length) return;
        const placeholder = select.options[0];
        if (burialTypePlaceholderText === null) {
            burialTypePlaceholderText = (placeholder.textContent || '').trim() || 'Select Burial Type';
        }
        const isReadOnly = (wizardMode === 'new' || !wizardMode) && !isFieldEditableForCurrentMode();
        const hasValue = !!select.value;
        placeholder.textContent = (isReadOnly && !hasValue) ? '' : burialTypePlaceholderText;
    }

    function isFieldEditableForCurrentMode() {
        if (submissionSucceeded) return false;
        if (!wizardMode) return false;
        return true;
    }

    function clearBlockChangeTimer() {
        if (blockChangeTimer) {
            clearTimeout(blockChangeTimer);
            blockChangeTimer = null;
        }
    }

    // ==================================================================
    // blocks + graves
    // ==================================================================
    async function fetchBlocks() {
        const res = await fetch(BLOCKS_API, {
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
                    .map(b => ({
                        id: b && (b.block_id ?? b.id) != null ? (b.block_id ?? b.id) : null,
                        name: String((b && (b.block_name ?? b.name)) || '').trim(),
                        type: String((b && b.block_type) || '').trim(),
                        status: String((b && (b.block_status ?? b.status)) || '').trim(),
                    }))
                    .filter(b => b.name !== '');
            } catch (err) {
                console.warn('[MonitorModal] Unable to load blocks:', err);
                blockOptions = [];
                blocksPromise = null;
            }
            renderBlockOptions();
            return blockOptions;
        })();
        return blocksPromise;
    }

    function renderBlockOptions(keepValue, filterType) {
        if (!modalEl) return;
        const select = modalEl.querySelector('#block');
        if (!select || select.tagName !== 'SELECT') return;

        const isOldEditable = (wizardMode === 'old' && !submissionSucceeded);
        const current = keepValue !== undefined ? keepValue : select.value;
        const list = filterType ? blocksMatchingType(filterType) : blockOptions;

        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        if (!isOldEditable) placeholder.textContent = '';
        else if (filterType && list.length === 0) placeholder.textContent = 'No blocks for this Burial Type';
        else placeholder.textContent = 'Select Block...';
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);

        list.forEach(b => {
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
                const match = blockOptions.find(b => b.name === current);
                const opt = document.createElement('option');
                opt.value = current;
                opt.textContent = current;
                opt.dataset.placeholder = 'true';
                if (match && match.id != null) opt.dataset.blockId = String(match.id);
                if (match && match.type) opt.dataset.blockType = match.type;
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
        const url = `${GRAVES_API}?block_id=${encodeURIComponent(blockId)}&status=vacant`;
        const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const data = json && typeof json === 'object' && 'data' in json ? json.data : json;
        return data && Array.isArray(data.graves) ? data.graves : [];
    }

    function renderGraveOptions(graves, selectedGraveId) {
        const select = modalEl ? modalEl.querySelector('#grave_code') : null;
        if (!select || select.tagName !== 'SELECT') return;

        const isOldEditable = (wizardMode === 'old' && !submissionSucceeded);
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = !isOldEditable
            ? ''
            : (graves.length ? 'Select Grave Code...' : 'No available grave codes');
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);

        const seen = new Set();
        for (const g of (graves || [])) {
            const code = String(g.grave_code || '').trim();
            const id = g.grave_id;
            if (!code || id == null || seen.has(code)) continue;
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
        if (!select || select.tagName !== 'SELECT') { selectedSlot = null; return; }
        const opt = select.options[select.selectedIndex];
        if (!opt || !opt.dataset.graveId || !opt.value) { selectedSlot = null; return; }
        selectedSlot = { grave_id: Number(opt.dataset.graveId), grave_code: opt.value };
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
        const isOldEditable = (wizardMode === 'old' && !submissionSucceeded);
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = isOldEditable ? 'Select Block first...' : '';
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

        if (!(wizardMode === 'old' && !submissionSucceeded)) {
            if (pinnedGraveId || pinnedGraveCode) {
                renderGraveOptions([{
                    grave_id: pinnedGraveId != null ? Number(pinnedGraveId) : null,
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
        try { graves = await fetchGravesForBlock(blockId); } catch (err) { fetchError = err; }
        if (token !== gravesToken) return;

        if (fetchError) {
            console.warn('[MonitorModal] Unable to fetch graves:', fetchError);
            setGraveCodeHint('Unable to load grave codes. Please try again.', true);
            renderGraveOptions([], null);
            return;
        }

        if (pinnedGraveId || pinnedGraveCode) {
            const pinId = pinnedGraveId != null ? Number(pinnedGraveId) : null;
            const pinCode = String(pinnedGraveCode || '').trim();
            const exists = graves.some(g => {
                if (pinId != null && Number(g.grave_id) === pinId) return true;
                if (pinCode && String(g.grave_code || '').trim() === pinCode) return true;
                return false;
            });
            if (!exists) {
                graves.unshift({
                    grave_id: pinId != null ? pinId : null,
                    grave_code: pinCode,
                    status: 'occupied',
                    _pinned: true,
                });
            }
        }

        if (!graves.length) setGraveCodeHint('No available grave codes in this block.', true);
        else setGraveCodeHint('');

        renderGraveOptions(graves, pinnedGraveId);
    }

    function onBlockChange() {
        const blockSelect = modalEl ? modalEl.querySelector('#block') : null;
        if (!blockSelect) return;
        const opt = blockSelect.options[blockSelect.selectedIndex];
        const blockId = opt ? opt.dataset.blockId : null;
        const blockName = (blockSelect.value || '').trim();
        const blockType = opt ? (opt.dataset.blockType || '') : '';
        if (blockName && blockType) setBurialTypeFromBlockType(blockType);

        if (!blockId || !blockName) {
            renderGraveOptions([], null);
            setGraveCodeHint('');
            return;
        }

        clearBlockChangeTimer();
        blockChangeTimer = setTimeout(() => {
            blockChangeTimer = null;
            loadGraveOptions(blockId, blockName, null, null);
        }, BLOCK_CHANGE_DEBOUNCE_MS);
    }

    function onBurialTypeChange() {
        if (!modalEl) return;
        const burialType = currentBurialType();
        const blockSelect = modalEl.querySelector('#block');
        const blockIsEditable = blockSelect && !blockSelect.disabled;
        if (blockIsEditable) {
            blockSelect.value = '';
            resetGraveSelectUI();
            renderBlockOptions('', burialType);
        }
        updateBurialTypePlaceholder();
    }

    // ▼ CHANGED: run status handler in any wizard mode; treat anything
    //            that isn't "Active" as a clear signal (matches Reserve).
    async function handleStatusChange() {
        if (!modalEl) return;
        if (wizardMode !== 'old') return;

        const statusSelect = modalEl.querySelector('#status');
        if (!statusSelect) return;

        if (statusSelect.value !== 'Active') {
            const blockEl = modalEl.querySelector('#block');
            if (blockEl) blockEl.value = '';
            const typeEl = modalEl.querySelector('#burial_block');
            if (typeEl) typeEl.selectedIndex = 0;
            resetGraveSelectUI();
            updateBurialTypePlaceholder();
            return;
        }
        await loadBlocks();
        renderBlockOptions('');
        resetGraveSelectUI();
        updateBurialTypePlaceholder();
    }
    // ▲ CHANGED

    // ==================================================================
    // barangay_options
    // ==================================================================
    // Normalise the stored JSON value into [{ value, label }, ...].
    function normalizeBarangayOptions(data) {
        const pairs = [];
        if (Array.isArray(data)) {
            data.forEach((item) => {
                if (item === null || item === undefined) return;
                if (typeof item === 'object') {
                    const v = item.value ?? item.id ?? item.key ?? item.name ?? '';
                    const l = item.label ?? item.text ?? item.title ?? item.name ?? v;
                    if (String(v) !== '' || String(l) !== '') {
                        pairs.push({ value: String(v), label: String(l) });
                    }
                } else {
                    pairs.push({ value: String(item), label: String(item) });
                }
            });
        } else if (data && typeof data === 'object') {
            for (const [v, l] of Object.entries(data)) {
                pairs.push({ value: String(v), label: String(l) });
            }
        }
        return pairs;
    }

    // Fetch api/settings once, pull the barangay_options value, and
    // repopulate #contact_person_address_barangay. On any failure we
    // silently fall back to whatever is already in burial_modal.html.
    async function loadBarangayOptions() {
        if (barangayOptionsPromise) return barangayOptionsPromise;

        barangayOptionsPromise = (async () => {
            if (!modalEl) return;
            const select = modalEl.querySelector('#contact_person_address_barangay');
            if (!select || select.tagName !== 'SELECT') return;

            let rows;
            try {
                const res = await fetch(SETTINGS_API, {
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const result = await res.json();
                rows = Array.isArray(result) ? result : result?.data;
                if (!Array.isArray(rows)) {
                    // Well-formed response, just nothing usable — don't retry.
                    return;
                }
            } catch (err) {
                // Network / HTTP failure — leave the HTML defaults alone,
                // but reset so a later open can retry.
                console.warn(
                    '[MonitorModal] Unable to load barangay_options:',
                    err,
                );
                barangayOptionsPromise = null;
                return;
            }

            const row = rows.find(
                (r) => String(r?.setting_key ?? r?.key ?? '') === 'barangay_options',
            );
            if (!row) return;

            const rawValue = row?.setting_value ?? row?.value ?? '';
            let parsed;
            try {
                parsed = JSON.parse(rawValue);
            } catch {
                // Invalid JSON — keep whatever burial_modal.html had.
                return;
            }

            const pairs = normalizeBarangayOptions(parsed);
            if (!pairs.length) return;

            // Preserve whatever is currently selected, if it still exists.
            const current = select.value;

            select.innerHTML = '';

            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.disabled = true;
            placeholder.selected = true;
            placeholder.defaultSelected = true;
            placeholder.textContent = 'Select Barangay...';
            select.appendChild(placeholder);

            pairs.forEach(({ value, label }) => {
                const opt = document.createElement('option');
                opt.value = value;
                opt.textContent = label;
                select.appendChild(opt);
            });

            if (current && pairs.some((p) => p.value === current)) {
                select.value = current;
            } else {
                select.value = '';
            }
        })();

        return barangayOptionsPromise;
    }

    // ==================================================================
    // load / bind
    // ==================================================================
    async function ensureLoaded() {
        modalEl = document.getElementById('burial_modal_overlay');
        if (modalEl) {
            bindEvents();
            ensureWizardButtons();
            ensureRemarksHint();
            await loadBarangayOptions();
            return;
        }
        if (!loadPromise) loadPromise = loadModalHtml();
        await loadPromise;
        modalEl = document.getElementById('burial_modal_overlay');
        if (modalEl) {
            bindEvents();
            ensureWizardButtons();
            ensureRemarksHint();
            await loadBarangayOptions();
        }
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
        if (!html) { console.error('[MonitorModal] Failed to load burial_modal.html.'); return; }
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const fragment = parsed.getElementById('burial_modal_overlay');
        if (!fragment) { console.error('[MonitorModal] burial_modal.html missing overlay.'); return; }
        document.body.appendChild(document.adoptNode(fragment));
    }

    function ensureWizardButtons() {
        if (!modalEl) return;
        const actions = modalEl.querySelector('.paperFormActions');
        if (!actions) return;

        const existingNext = actions.querySelectorAll('.paperNextBtn');
        existingNext.forEach((el, i) => { if (i > 0) el.remove(); });
        const existingBack = actions.querySelectorAll('.paperBackBtn');
        existingBack.forEach((el, i) => { if (i > 0) el.remove(); });

        let n = actions.querySelector('.paperNextBtn');
        if (!n) {
            n = document.createElement('button');
            n.type = 'button';
            n.className = 'paperNextBtn';
            n.textContent = 'Next (New Occupant) →';
            n.style.display = 'none';
            n.addEventListener('click', handleNextClick);
            actions.appendChild(n);
        }
        nextBtn = n;

        let b = actions.querySelector('.paperBackBtn');
        if (!b) {
            b = document.createElement('button');
            b.type = 'button';
            b.className = 'paperBackBtn';
            b.textContent = '← Back (Old Occupant)';
            b.style.display = 'none';
            b.addEventListener('click', handleBackClick);
            actions.appendChild(b);
        }
        backBtn = b;
        injectWizardStyles();
    }

    function bindEvents() {
        if (!modalEl || bound) return;
        bound = true;

        const form = modalEl.querySelector('#burial_clearance_form');
        if (form) {
            form.setAttribute('novalidate', 'novalidate');
            form.addEventListener('submit', handleSubmit);
        }

        const saveBtn = modalEl.querySelector('.paperSaveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', (e) => {
                if (submissionSucceeded) { e.preventDefault(); close(); return; }
                e.preventDefault();
                handleSubmit(e);
            });
        }

        const cancelBtn = modalEl.querySelector('.paperCancelBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                handleCancel();
            });
        }

        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl && !submissionSucceeded) handleCancel();
        });

        const phone = modalEl.querySelector('#contact_person_phone_number');
        if (phone) {
            phone.addEventListener('input', (e) => {
                if (submissionSucceeded) return;
                e.target.value = formatPhoneValue(e.target.value);
            });
            phone.addEventListener('blur', (e) => {
                if (submissionSucceeded) return;
                if (!e.target.value) e.target.value = '+63';
            });
        }

        ['contact_person_name', 'deceased_name'].forEach(id => {
            const f = modalEl.querySelector('#' + id);
            if (f) f.addEventListener('input', (e) => {
                if (submissionSucceeded) return;
                e.target.value = formatNameValue(e.target.value);
            });
        });

        // ▼ ADDED: live-update location header name as user types
        const headerNameEl = modalEl.querySelector('#deceased_name');
        if (headerNameEl) {
            headerNameEl.addEventListener('input', () => {
                if (submissionSucceeded) return;
                if (wizardMode === 'old') refreshOldOccupantHeader();
                else if (wizardMode === 'new') refreshNewOccupantHeader();
            });
        }
        // ▲ ADDED

        const blockSelect = modalEl.querySelector('#block');
        if (blockSelect) {
            blockSelect.addEventListener('change', () => {
                if (submissionSucceeded) return;
                if (!blockSelect.disabled) onBlockChange();
            });
        }

        const graveSelect = modalEl.querySelector('#grave_code');
        if (graveSelect) {
            graveSelect.addEventListener('change', () => {
                if (submissionSucceeded) return;
                updateSelectedSlotFromGraveSelect();
                setGraveCodeHint('');
            });
        }

        const burialTypeSelect = modalEl.querySelector('#burial_block');
        if (burialTypeSelect) {
            burialTypeSelect.addEventListener('change', () => {
                if (submissionSucceeded) return;
                onBurialTypeChange();
            });
        }

        INTERMENT_FIELD_IDS.forEach(id => {
            const el = modalEl.querySelector('#' + id);
            if (!el) return;
            el.addEventListener('input', () => { if (!submissionSucceeded) recalcExpirationFromInterment(); });
            el.addEventListener('change', () => { if (!submissionSucceeded) recalcExpirationFromInterment(); });
            el.addEventListener('blur', () => { if (!submissionSucceeded) recalcExpirationFromInterment(); });
        });

        const statusSelect = modalEl.querySelector('#status');
        if (statusSelect) {
            statusSelect.addEventListener('change', () => {
                if (submissionSucceeded) return;
                handleStatusChange();
            });
        }
    }

    // ==================================================================
    // reservation → flat field values
    // ==================================================================
    function reservationToOldFields(res) {
        const o = res.old_interment || {};
        const ong = res.old_new_grave || null;
        const edits = res.old_edited_fields || {};

        const base = {
            control_number: o.control_number || '',
            deceased_name: o.deceased_name || '',
            deceased_sex: o.deceased_sex || '',
            deceased_date_of_birth: o.deceased_date_of_birth || '',
            deceased_date_of_death: o.deceased_date_of_death || '',
            last_known_address: o.last_known_address || '',
            death_certificate: o.death_certificate || '',
            contact_person_name: o.contact_person_name || '',
            contact_person_phone_number: o.contact_person_phone_number || '',
            contact_person_email: o.contact_person_email || '',
            contact_person_address: o.contact_person_address || '',
            contact_person_address_barangay: o.contact_person_address_barangay || '',
            assistance_type: res.old_new_assistance_type || o.assistance_type || '',
            burial_permit_number: o.burial_permit_number || '',
            burial_permit_date: o.burial_permit_date || '',
            transfer_permit_number: res.transfer_permit_number || o.transfer_permit_number || '',
            transfer_permit_issued_by: o.transfer_permit_issued_by || '',
            transfer_permit_date: o.transfer_permit_date || '',
            exhumation_permit_number: res.exhumation_permit_number || o.exhumation_permit_number || '',
            exhumation_permit_date: o.exhumation_permit_date || '',
            date_buried: o.date_buried || '',
            date_exhumed: o.date_exhumed || '',
            burial_clearance_date: o.burial_clearance_date || '',
            lease_expiration_date: o.lease_expiration_date || '',
            remarks: res.old_new_remarks || o.remarks || '',

            status: res.old_new_status || 'Active',
            block: ong ? (ong.block_name || '') : '',
            grave_code: ong ? (ong.grave_code || '') : '',
            burial_block: ong ? (ong.block_type || '') : '',
        };

        Object.keys(edits).forEach(k => {
            const v = edits[k];
            if (v === null || v === undefined) return;
            if (k in base) base[k] = v;
        });

        if (base.status === 'Inactive') {
            base.block = '';
            base.grave_code = '';
            base.burial_block = '';
        }
        return base;
    }

    function reservationToNewFields(res) {
        const n = res.pending_interment || {};
        const g = res.target_grave || {};
        return {
            control_number: n.control_number || '',
            deceased_name: n.deceased_name || '',
            deceased_sex: n.deceased_sex || '',
            deceased_date_of_birth: n.deceased_date_of_birth || '',
            deceased_date_of_death: n.deceased_date_of_death || '',
            last_known_address: n.last_known_address || '',
            death_certificate: n.death_certificate || '',
            contact_person_name: n.contact_person_name || '',
            contact_person_phone_number: n.contact_person_phone_number || '',
            contact_person_email: n.contact_person_email || '',
            contact_person_address: n.contact_person_address || '',
            contact_person_address_barangay: n.contact_person_address_barangay || '',
            assistance_type: n.assistance_type || '',
            burial_permit_number: n.burial_permit_number || '',
            burial_permit_date: n.burial_permit_date || '',
            transfer_permit_number: n.transfer_permit_number || '',
            transfer_permit_issued_by: n.transfer_permit_issued_by || '',
            transfer_permit_date: n.transfer_permit_date || '',
            exhumation_permit_number: n.exhumation_permit_number || '',
            exhumation_permit_date: n.exhumation_permit_date || '',
            date_buried: n.date_buried || '',
            date_exhumed: n.date_exhumed || '',
            burial_clearance_date: n.burial_clearance_date || '',
            lease_expiration_date: n.lease_expiration_date || '',
            remarks: n.remarks || '',

            // N will be Activated on execute — show that in the UI.
            status: 'Active',
            block: g.block_name || '',
            grave_code: g.grave_code || '',
            burial_block: g.block_type || '',
        };
    }

    // ==================================================================
    // form I/O
    // ==================================================================
    function setFieldValue(id, val) {
        const el = modalEl.querySelector('#' + id);
        if (!el) return;
        const s = (val === null || val === undefined) ? '' : String(val);
        if (el.tagName === 'SELECT') {
            const stale = el.querySelector('option[data-placeholder="true"]');
            if (stale) stale.remove();
            let matched = Array.from(el.options).find(o => o.value === s || o.text === s);
            if (!matched && s) {
                const opt = document.createElement('option');
                opt.value = s; opt.textContent = s;
                el.appendChild(opt);
                matched = opt;
            }
            if (matched) el.value = matched.value;
            else el.selectedIndex = 0;
        } else {
            el.value = s;
        }
    }

    function populateFields(data) {
        setFieldValue('control_number', data.control_number);
        if (!modalEl.querySelector('#control_number')) {
            setFieldValue('control_no', data.control_number);
        }

        setFieldValue('burial_clearance_date', sliceDate(data.burial_clearance_date));
        setFieldValue('contact_person_name', data.contact_person_name);
        setFieldValue('contact_person_email', data.contact_person_email);
        setFieldValue('contact_person_phone_number',
            data.contact_person_phone_number ? formatPhoneValue(data.contact_person_phone_number) : '+63');
        setFieldValue('contact_person_address', data.contact_person_address);
        setFieldValue('contact_person_address_barangay',
            pick(data.contact_person_address_barangay).replace(/^(Barangay|Brgy\.\s*)/i, '').trim());

        const rawAssist = pick(data.assistance_type);
        let mappedAssist = rawAssist;
        if (/burial/i.test(rawAssist)) mappedAssist = 'Burial';
        else if (/transfer|exhumation/i.test(rawAssist)) mappedAssist = 'Transfer the remains of the late';
        else if (/^other/i.test(rawAssist)) mappedAssist = 'Other';
        setFieldValue('assistance_type', mappedAssist);

        setFieldValue('deceased_name', data.deceased_name);
        setFieldValue('deceased_sex', data.deceased_sex);
        setFieldValue('deceased_date_of_birth', sliceDate(data.deceased_date_of_birth));
        setFieldValue('deceased_date_of_death', sliceDate(data.deceased_date_of_death));
        setFieldValue('last_known_address', data.last_known_address);
        setFieldValue('death_certificate', data.death_certificate);

        setFieldValue('burial_permit_number', data.burial_permit_number);
        setFieldValue('burial_permit_date', sliceDate(data.burial_permit_date));
        setFieldValue('transfer_permit_number', data.transfer_permit_number);
        setFieldValue('transfer_permit_issued_by', data.transfer_permit_issued_by);
        setFieldValue('transfer_permit_date', sliceDate(data.transfer_permit_date));
        setFieldValue('exhumation_permit_number', data.exhumation_permit_number);
        setFieldValue('exhumation_permit_date', sliceDate(data.exhumation_permit_date));

        setFieldValue('date_buried', sliceDate(data.date_buried));
        if (!modalEl.querySelector('#date_buried')) {
            setFieldValue('date_interment', sliceDate(data.date_buried));
        }
        setFieldValue('date_exhumed', sliceDate(data.date_exhumed));
        setFieldValue('lease_expiration_date', sliceDate(data.lease_expiration_date));
        if (!modalEl.querySelector('#lease_expiration_date')) {
            setFieldValue('expiration_date', sliceDate(data.lease_expiration_date));
        }

        setFieldValue('remarks', data.remarks);

        // Status: always Active unless the caller passed an explicit value.
        const statusVal = pick(data.status, 'Active');
        setFieldValue('status', statusVal);

        const rawType = pick(data.burial_block);
        if (rawType) setBurialTypeFromBlockType(rawType);
        else {
            const t = modalEl.querySelector('#burial_block');
            if (t && t.tagName === 'SELECT') t.value = '';
        }

        setFieldValue('block', data.block);
        renderBlockOptions(data.block || '');

        resetGraveSelectUI();
        if (data.grave_code) {
            const sel = modalEl.querySelector('#grave_code');
            if (sel && sel.tagName === 'SELECT') {
                const opt = document.createElement('option');
                opt.value = data.grave_code;
                opt.textContent = data.grave_code;
                opt.dataset.graveId = '0';
                opt.dataset.pinned = 'true';
                sel.appendChild(opt);
                sel.value = data.grave_code;
            }
        }

        updateBurialTypePlaceholder();

        // ▼ ADDED: refresh remarks hint after populate
        refreshRemarksHint();
        // ▲ ADDED
    }

    function readAllFormFields() {
        const out = {};
        if (!modalEl) return out;
        modalEl.querySelectorAll('input, select, textarea').forEach(el => {
            if (!el.id) return;
            const tag = (el.tagName || '').toLowerCase();
            if (tag === 'input' && (el.type === 'button' || el.type === 'submit')) return;
            out[el.id] = el.value;
        });
        return out;
    }

    function applyFormFields(values) {
        if (!modalEl || !values) return;
        Object.keys(values).forEach(id => {
            const el = modalEl.querySelector('#' + id);
            if (!el) return;
            const tag = (el.tagName || '').toLowerCase();
            if (tag === 'input' && (el.type === 'button' || el.type === 'submit')) return;

            const raw = values[id];
            const val = (raw === null || raw === undefined) ? '' : String(raw);
            if (tag === 'select') {
                const has = Array.from(el.options).some(o => o.value === val);
                if (!has && val !== '') {
                    const opt = document.createElement('option');
                    opt.value = val; opt.textContent = val;
                    opt.dataset.pinned = 'true';
                    el.appendChild(opt);
                }
                el.value = val;
            } else {
                el.value = val;
            }
        });

        // ▼ ADDED: refresh remarks hint after form restore
        refreshRemarksHint();
        // ▲ ADDED
    }

    function readField(id) {
        const el = modalEl.querySelector('#' + id);
        return el ? String(el.value || '').trim() : '';
    }

    function collectFormValues() {
        const assistRaw = readField('assistance_type');
        let assistance = 'Other';
        if (/^burial/i.test(assistRaw)) assistance = 'Burial';
        else if (/transfer/i.test(assistRaw)) assistance = 'Transfer the remains of the late';

        const dob = readField('deceased_date_of_birth') || null;
        const dod = readField('deceased_date_of_death') || null;
        const bpDate = readField('burial_permit_date') || null;
        const tpDate = readField('transfer_permit_date') || null;
        const epDate = readField('exhumation_permit_date') || null;
        const dBuried = readField('date_buried') || readField('date_interment') || null;
        const dExhumed = readField('date_exhumed') || null;
        const bClearance = readField('burial_clearance_date') || null;
        const leaseExp = readField('lease_expiration_date') || readField('expiration_date') || null;

        return {
            control_number: readField('control_number') || readField('control_no'),
            deceased_name: readField('deceased_name'),
            deceased_sex: readField('deceased_sex'),
            deceased_date_of_birth: dob,
            deceased_date_of_death: dod,
            last_known_address: readField('last_known_address'),
            death_certificate: readField('death_certificate'),
            contact_person_name: readField('contact_person_name'),
            contact_person_email: readField('contact_person_email'),
            contact_person_phone_number: readField('contact_person_phone_number'),
            contact_person_address: readField('contact_person_address'),
            contact_person_address_barangay: readField('contact_person_address_barangay'),
            assistance_type: assistance,
            burial_permit_number: readField('burial_permit_number'),
            burial_permit_date: bpDate,
            transfer_permit_number: readField('transfer_permit_number'),
            transfer_permit_issued_by: readField('transfer_permit_issued_by'),
            transfer_permit_date: tpDate,
            exhumation_permit_number: readField('exhumation_permit_number'),
            exhumation_permit_date: epDate,
            date_buried: dBuried,
            date_exhumed: dExhumed,
            burial_clearance_date: bClearance,
            lease_expiration_date: leaseExp,
            remarks: readField('remarks'),
            block: readField('block'),
            grave_code: readField('grave_code'),
            burial_block: readField('burial_block'),
            status: readField('status'),
        };
    }

    // ==================================================================
    // mode / locking
    // ==================================================================
    function applyMode() {
        if (!modalEl) return;

        const locked = submissionSucceeded;
        const isOld = wizardMode === 'old';
        const isNew = wizardMode === 'new';

        modalEl.querySelectorAll('input, select, textarea').forEach(field => {
            if (field.closest('.paperFormActions')) return;

            if (EXPIRATION_FIELD_IDS.includes(field.id) ||
                field.id === 'control_number' || field.id === 'control_no') {
                if (field.tagName === 'SELECT') field.disabled = true;
                else { field.readOnly = true; field.disabled = false; }
                field.style.background = '#eef2f8';
                field.style.color = '#475569';
                field.style.cursor = 'not-allowed';
                field.style.pointerEvents = '';
                return;
            }

            field.style.background = '';
            field.style.color = '';
            field.style.cursor = '';
            field.style.pointerEvents = '';
            field.removeAttribute('aria-readonly');

            if (locked) {
                if (field.tagName === 'SELECT') {
                    field.disabled = true;
                    field.style.pointerEvents = 'none';
                } else {
                    field.readOnly = true;
                    field.disabled = false;
                }
                field.style.cursor = 'not-allowed';
                return;
            }

            // ▼ CHANGED: old occupant is fully editable (like Reserve).
            //            new occupant keeps the readonly location/status set.
            let editable = false;
            if (isOld) editable = true;
            else if (isNew) editable = !NEW_OCCUPANT_READONLY_FIELDS.has(field.id);
            // ▲ CHANGED

            if (field.tagName === 'SELECT') {
                field.disabled = !editable;
                field.classList.toggle('select-readonly', !editable);
            } else {
                field.readOnly = !editable;
                field.disabled = false;
            }
        });

        updateBurialTypePlaceholder();
        updateWizardButtons();

        // ▼ ADDED: refresh remarks hint after applyMode changes editability
        refreshRemarksHint();
        // ▲ ADDED
    }

    function lockFieldsOnly() {
        if (!modalEl) return;
        modalEl.querySelectorAll('input, select, textarea').forEach(el => {
            if (el.closest('.paperFormActions')) return;
            el.disabled = true;
            el.readOnly = true;
            if (el.tagName === 'SELECT') el.style.pointerEvents = 'none';
            el.style.cursor = 'not-allowed';
            el.style.background = '';
            el.style.color = '';
        });

        // ▼ ADDED: refresh remarks hint after lock
        refreshRemarksHint();
        // ▲ ADDED
    }

    function unlockFields() {
        if (!modalEl) return;
        modalEl.querySelectorAll('input, select, textarea').forEach(el => {
            if (el.closest('.paperFormActions')) return;
            el.disabled = false;
            el.readOnly = false;
            el.style.pointerEvents = '';
            el.style.cursor = '';
            el.style.background = '';
            el.style.color = '';
        });
    }

    // ==================================================================
    // wizard buttons
    // ==================================================================
    function updateWizardButtons() {
        ensureWizardButtons();

        const saveBtn = modalEl.querySelector('.paperSaveBtn');
        const cancelBtn = modalEl.querySelector('.paperCancelBtn');
        const hasOld = !!(reservation && reservation.old_interment);

        if (submissionSucceeded) {
            if (wizardMode === 'old') {
                if (nextBtn) nextBtn.style.display = hasOld ? 'inline-block' : 'none';
                if (backBtn) backBtn.style.display = 'none';
            } else {
                if (nextBtn) nextBtn.style.display = 'none';
                if (backBtn) backBtn.style.display = hasOld ? 'inline-block' : 'none';
            }
            if (saveBtn) {
                saveBtn.style.display = 'inline-block';
                saveBtn.textContent = 'Close';
                saveBtn.disabled = false;
                saveBtn.type = 'button';
            }
            if (cancelBtn) cancelBtn.style.display = 'none';
            return;
        }

        if (wizardMode === 'old') {
            if (saveBtn) saveBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'inline-block';
            if (backBtn) backBtn.style.display = 'none';
            if (cancelBtn) {
                cancelBtn.style.display = '';
                cancelBtn.textContent = 'Cancel';
            }
        } else if (wizardMode === 'new') {
            if (saveBtn) {
                saveBtn.style.display = 'inline-block';
                saveBtn.textContent = 'Save';
                saveBtn.disabled = false;
            }
            if (nextBtn) nextBtn.style.display = 'none';
            if (backBtn) backBtn.style.display = hasOld ? 'inline-block' : 'none';
            if (cancelBtn) {
                cancelBtn.style.display = '';
                cancelBtn.textContent = 'Cancel';
            }
        } else {
            if (saveBtn) saveBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
            if (backBtn) backBtn.style.display = 'none';
            if (cancelBtn) { cancelBtn.style.display = ''; cancelBtn.textContent = 'Close'; }
        }
    }

    // ==================================================================
    // wizard step transitions
    // ==================================================================
    async function enterOldStep() {
        wizardMode = 'old';
        const data = oldModeSnapshot
            ? { ...reservationToOldFields(reservation), ...oldModeSnapshot }
            : reservationToOldFields(reservation);

        unlockFields();
        populateFields(data);
        applyMode();
        updateWizardButtons();

        if (data.status === 'Active' && data.block) {
            const blockSelect = modalEl.querySelector('#block');
            const opt = blockSelect ? blockSelect.options[blockSelect.selectedIndex] : null;
            const blockId = opt ? opt.dataset.blockId : null;
            const pinnedGraveId = reservation.old_new_grave
                ? reservation.old_new_grave.grave_id : null;
            if (blockId) {
                await loadGraveOptions(blockId, data.block, pinnedGraveId, data.grave_code);
            }
        }

        // ▼ ADDED: refresh "Where will <name> go?" header
        refreshOldOccupantHeader();
        // ▲ ADDED
    }

    async function enterNewStep() {
        wizardMode = 'new';
        const base = reservationToNewFields(reservation);
        const data = newModeSnapshot ? { ...base, ...newModeSnapshot } : base;

        unlockFields();
        populateFields(data);
        applyMode();
        updateWizardButtons();

        // ▼ ADDED: refresh "Where will <name> go?" header
        refreshNewOccupantHeader();
        // ▲ ADDED
    }

    // ▼ CHANGED: full parity with Reserve's handleNextClick —
    //            phone format, Active-requires-destination, Inactive-requires-empty.
    async function handleNextClick() {
        if (submissionSucceeded) {
            wizardMode = 'new';
            unlockFields();
            applyFormFields(newModeSnapshot || {});
            lockFieldsOnly();
            updateBurialTypePlaceholder();
            updateWizardButtons();
            refreshNewOccupantHeader();
            return;
        }

        if (wizardMode !== 'old') return;

        // ---- A) Phone format (only if user actually typed something) ----
        const phoneEl = modalEl.querySelector('#contact_person_phone_number');
        const rawPhone = (phoneEl?.value || '').trim();
        if (rawPhone && rawPhone !== '+63') {
            const digits = rawPhone.replace(/\D/g, '').replace(/^63/, '');
            if (digits.length !== 10) {
                warn('Old occupant phone must be in the format +63 XXX XXX XXXX.');
                phoneEl?.focus();
                return;
            }
        }

        // ---- B) Status ↔ destination consistency ----
        const statusEl = modalEl.querySelector('#status');
        const blockEl = modalEl.querySelector('#block');
        const graveEl = modalEl.querySelector('#grave_code');
        const typeEl = modalEl.querySelector('#burial_block');

        if (statusEl?.value === 'Active') {
            const hasBlock = !!(blockEl?.value || '').trim();
            const hasGrave = !!(graveEl?.value || '').trim();
            const hasType = !!(typeEl?.value || '').trim();

            if (!hasBlock && !hasGrave && !hasType) {
                warn(
                    'Status is set to Active, but no destination was chosen. ' +
                    'Please pick a Burial Type, Block, and Grave Code for the old occupant, ' +
                    'or set their status to Inactive.'
                );
                (typeEl || blockEl || graveEl)?.focus();
                return;
            }
            if (!hasType || !hasBlock || !hasGrave) {
                warn(
                    'Please complete the destination (Burial Type, Block, and Grave Code) ' +
                    'for the old occupant, or set their status to Inactive.'
                );
                (!hasType ? typeEl : (!hasBlock ? blockEl : graveEl))?.focus();
                return;
            }
        } else {
            // Non-Active → destination must be empty. handleStatusChange already
            // clears these, but double-check in case the user re-selected.
            if ((blockEl?.value || '').trim() || (graveEl?.value || '').trim()) {
                warn('Inactive old occupant cannot have a Block or Grave Code.');
                blockEl?.focus();
                return;
            }
        }

        // ---- C) Snapshot only after validation ----
        oldModeSnapshot = readAllFormFields();

        if (!oldModeSnapshot.deceased_name) {
            warn('Old occupant name is required.');
            return;
        }

        recalcExpirationFromInterment();
        await enterNewStep();
    }
    // ▲ CHANGED

    async function handleBackClick() {
        if (submissionSucceeded) {
            wizardMode = 'old';
            unlockFields();
            applyFormFields(oldModeSnapshot || {});
            lockFieldsOnly();
            updateBurialTypePlaceholder();
            updateWizardButtons();
            refreshOldOccupantHeader();
            return;
        }

        if (wizardMode !== 'new') return;

        newModeSnapshot = readAllFormFields();
        await enterOldStep();
    }

    // ==================================================================
    // payload builder
    // ==================================================================
    function computeOldBioDiff(current) {
        const diff = {};
        if (!reservation) return diff;
        const baseline = oldOccupantOriginal || reservationToOldFields(reservation);

        const push = (key, value) => {
            const cur = (value === null || value === undefined) ? '' : String(value).trim();
            const orig = (baseline[key] === null || baseline[key] === undefined) ? '' : String(baseline[key]).trim();
            if (cur === orig) return;
            diff[key] = cur === '' ? null : cur;
        };

        OLD_EDITABLE_STRING_FIELDS.forEach(f => push(f, current[f]));
        OLD_EDITABLE_DATE_FIELDS.forEach(f => push(f, current[f]));
        Object.keys(OLD_EDITABLE_ENUM_FIELDS).forEach(f => push(f, current[f]));
        return diff;
    }

    // ▼ CHANGED: resolve the selected grave's id from the dropdown and
    //            send `old_new_grave_id` alongside the code (server prefers id).
    function resolveSelectedGraveId() {
        const sel = modalEl ? modalEl.querySelector('#grave_code') : null;
        if (!sel || sel.tagName !== 'SELECT') return null;
        const opt = sel.options[sel.selectedIndex];
        if (!opt || !opt.dataset.graveId) return null;
        const n = Number(opt.dataset.graveId);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    // ▲ CHANGED

    function buildPayload() {
        const oldValues = oldModeSnapshot || {};
        const newValues = newModeSnapshot || collectFormValues();

        const nSource = wizardMode === 'new' ? collectFormValues() : newValues;
        const oSource = wizardMode === 'old' ? collectFormValues() : oldValues;

        const payload = {
            control_number: nSource.control_number || '',
            deceased_name: nSource.deceased_name || '',
            deceased_sex: nSource.deceased_sex || '',
            deceased_date_of_birth: nSource.deceased_date_of_birth || null,
            deceased_date_of_death: nSource.deceased_date_of_death || null,
            last_known_address: nSource.last_known_address || '',
            death_certificate: nSource.death_certificate || '',
            contact_person_name: nSource.contact_person_name || '',
            contact_person_phone_number: nSource.contact_person_phone_number || '',
            contact_person_email: nSource.contact_person_email || '',
            contact_person_address: nSource.contact_person_address || '',
            contact_person_address_barangay: nSource.contact_person_address_barangay || '',
            assistance_type: nSource.assistance_type || 'Other',
            burial_permit_number: nSource.burial_permit_number || '',
            burial_permit_date: nSource.burial_permit_date || null,
            transfer_permit_number: nSource.transfer_permit_number || '',
            transfer_permit_issued_by: nSource.transfer_permit_issued_by || '',
            transfer_permit_date: nSource.transfer_permit_date || null,
            exhumation_permit_number: nSource.exhumation_permit_number || '',
            exhumation_permit_date: nSource.exhumation_permit_date || null,
            date_buried: nSource.date_buried || null,
            date_exhumed: nSource.date_exhumed || null,
            burial_clearance_date: nSource.burial_clearance_date || null,
            lease_expiration_date: nSource.lease_expiration_date || null,
            remarks: nSource.remarks || '',
            reservation_notes: reservation.reservation_notes || '',
        };

        if (reservation.exhumation_permit_number) {
            payload.exhumation_permit_number = reservation.exhumation_permit_number;
        }
        if (reservation.transfer_permit_number) {
            payload.transfer_permit_number = reservation.transfer_permit_number;
        }

        if (reservation.old_interment) {
            const status = oSource.status || 'Inactive';
            payload.old_new_status = status;

            if (status === 'Active' && oSource.grave_code) {
                // ▼ FIXED: only resolve the id when the OLD step is the active form,
                //          because only then does #grave_code hold O's destination.
                //          On the 'new' step, #grave_code holds N's target, so sending
                //          its id here would assign O to the wrong grave.
                //          Falling back to just the code is safe: monitor.php
                //          resolves `old_new_grave_code` → grave_id itself.
                if (wizardMode === 'old') {
                    const gid = resolveSelectedGraveId();
                    if (gid) payload.old_new_grave_id = gid;
                }
                // ▲ FIXED
                payload.old_new_grave_code = oSource.grave_code;
            }
            if (oSource.assistance_type) {
                payload.old_new_assistance_type = oSource.assistance_type;
            }
            if (oSource.remarks) {
                payload.old_new_remarks = oSource.remarks;
            }

            const bioDiff = computeOldBioDiff(oSource);
            if (Object.keys(bioDiff).length) payload.old_edited_fields = bioDiff;
        }

        return payload;
    }

    // ==================================================================
    // submit — Save opens the confirm dialog first; only then POST
    // ==================================================================
    async function handleSubmit(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();

        if (submissionSucceeded) { close(); return; }
        if (wizardMode === 'old') return;      // must go through Next first

        recalcExpirationFromInterment();
        newModeSnapshot = readAllFormFields();

        const phoneRaw = readField('contact_person_phone_number');
        const digits = phoneRaw.replace(/\D/g, '').replace(/^63/, '');
        if (digits.length !== 10) {
            warn('Phone number must be in the format +63 XXX XXX XXXX.');
            return;
        }

        if (!readField('deceased_name')) {
            warn('Deceased name is required.');
            return;
        }

        const payload = buildPayload();

        // --- Confirm step ---
        const old = reservation.old_interment || null;
        const newName = readField('deceased_name') || '';
        const blockName = readField('block') || '';
        const graveCode = readField('grave_code') || '';

        const rows = [];
        if (old) rows.push({ label: 'Old Occupant', value: old.deceased_name || '' });
        rows.push({ label: 'New Occupant', value: newName });
        rows.push({ label: 'Block', value: blockName });
        rows.push({ label: 'Grave Code', value: graveCode });

        const saveBtn = modalEl.querySelector('.paperSaveBtn');
        const originalSaveText = saveBtn ? saveBtn.textContent : 'Save';
        let postSucceeded = false;

        const ok = await confirmDialog({
            title: old ? 'Confirm Reservation' : 'Confirm Interment',
            message: 'Do you really want to confirm this reservation?',
            variant: 'primary',
            confirmText: old ? 'Confirm Transfer' : 'Confirm',
            cancelText: 'Cancel',
            rows,
            onConfirm: async function () {
                if (saveBtn) {
                    saveBtn.disabled = true;
                    saveBtn.textContent = 'Saving...';
                }
                try {
                    const res = await fetch(
                        `${MONITOR_API}/${encodeURIComponent(reservation.reservation_id)}`,
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
                        // Raw-error sanitization: this throw escapes into
                        // the shared confirm modal's error display.
                        throw new Error(friendlyMessage(apiMsg, 'Failed to save reservation.'));
                    }
                    postSucceeded = true;
                } catch (err) {
                    if (saveBtn) {
                        saveBtn.disabled = false;
                        saveBtn.textContent = originalSaveText;
                    }
                    console.error('[MonitorModal] Save failed:', err);
                    throw err; // let the confirm modal show the error
                }
            },
        });

        if (!ok || !postSucceeded) {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = originalSaveText;
            }
            return;
        }

        // Post-execute "checking" lock in the burial modal.
        submissionSucceeded = true;
        lockFieldsOnly();
        if (saveBtn) {
            saveBtn.textContent = 'Close';
            saveBtn.disabled = false;
            saveBtn.type = 'button';
        }
        updateBurialTypePlaceholder();
        updateWizardButtons();

        document.dispatchEvent(new CustomEvent('monitor_burial_modal:executed', {
            detail: { reservationId: reservation.reservation_id },
        }));

        if (typeof window.showAlertTOP === 'function') {
            window.showAlertTOP('Reservation confirmed and executed.', 'success');
        }
    }

    // ==================================================================
    // cancel
    // ==================================================================
    function handleCancel() {
        oldModeSnapshot = null;
        newModeSnapshot = null;
        oldOccupantOriginal = null;
        newOccupantOriginal = null;
        submissionSucceeded = false;
        wizardMode = null;
        close();
    }

    // ==================================================================
    // open / close
    // ==================================================================
    async function open(startType, res) {
        await ensureLoaded();
        if (!modalEl || !res) return;

        // ▼ ADDED: ensure remarks hint is wired up before first render
        ensureRemarksHint();
        // ▲ ADDED

        reservation = res;
        submissionSucceeded = false;
        oldModeSnapshot = null;
        newModeSnapshot = null;

        oldOccupantOriginal = res.old_interment ? reservationToOldFields(res) : null;
        newOccupantOriginal = reservationToNewFields(res);

        blocksPromise = null;

        const form = modalEl.querySelector('#burial_clearance_form');
        if (form) form.reset();

        ensureGraveCodeSelect();
        const hint = modalEl.querySelector('#grave_code_hint');
        if (hint) { hint.textContent = ''; hint.classList.remove('visible'); }

        await loadBlocks();

        const hasOld = !!res.old_interment;
        const startAt = (startType === 'old' && hasOld) ? 'old' : 'new';

        // ▼ FIX: if we're opening directly on 'new' but the reservation has an
        //        old occupant, seed oldModeSnapshot from the O's current state.
        //        Without this, buildPayload() sends old_new_status='Inactive'
        //        plus an old_edited_fields diff that nulls every O bio field,
        //        which the server rejects — so Save appears to do nothing.
        if (startAt === 'new' && hasOld && oldOccupantOriginal) {
            oldModeSnapshot = { ...oldOccupantOriginal };
        }
        // ▲ FIX

        if (startAt === 'old') {
            await enterOldStep();
        } else {
            await enterNewStep();
        }

        modalEl.querySelectorAll('input, select, textarea').forEach(f => {
            f.style.background = '';
            f.style.color = '';
            f.style.cursor = '';
        });

        modalEl.style.display = 'block';
        modalEl.classList.add('active');

        // ▼ ADDED: refresh remarks hint now that modal is visible, so
        //          getBoundingClientRect can position the pill correctly.
        refreshRemarksHint();
        // ▲ ADDED
    }

    function close() {
        if (!modalEl) return;
        modalEl.style.display = 'none';
        modalEl.classList.remove('active');

        clearBlockChangeTimer();
        gravesToken++;

        selectedSlot = null;
        submissionSucceeded = false;
        wizardMode = null;
        oldModeSnapshot = null;
        newModeSnapshot = null;
        oldOccupantOriginal = null;
        newOccupantOriginal = null;
        reservation = null;

        // ▼ ADDED: remove the location header on close (parity with Reserve)
        if (locationHeaderEl && locationHeaderEl.parentNode) {
            locationHeaderEl.parentNode.removeChild(locationHeaderEl);
        }
        locationHeaderEl = null;
        // ▲ ADDED

        // ▼ ADDED: hint will be hidden (wizardMode=null) — reflect that now
        refreshRemarksHint();
        // ▲ ADDED

        const actions = modalEl.querySelector('.paperFormActions');
        if (actions) {
            actions.querySelectorAll('.paperNextBtn').forEach(n => n.remove());
            actions.querySelectorAll('.paperBackBtn').forEach(b => b.remove());
        }
        nextBtn = null;
        backBtn = null;

        const saveBtn = modalEl.querySelector('.paperSaveBtn');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
            saveBtn.type = 'submit';
            saveBtn.style.display = '';
        }
        const cancelBtn = modalEl.querySelector('.paperCancelBtn');
        if (cancelBtn) {
            cancelBtn.style.display = '';
            cancelBtn.textContent = 'Cancel';
        }
    }

    return { open, close };
})();

window.MonitorBurialModal = MonitorBurialModal;
window.openMonitorOldOccupant = (reservation) => MonitorBurialModal.open('old', reservation);
window.openMonitorNewOccupant = (reservation) => MonitorBurialModal.open('new', reservation);
window.closeMonitorBurialModal = () => MonitorBurialModal.close();