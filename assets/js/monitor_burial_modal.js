const MonitorBurialModal = (() => {
    let modalEl = null;
    let loadPromise = null;
    let bound = false;

    let currentOccupantType = 'new';
    let currentReservation = null;
    let currentData = {};
    let originalValues = {};
    let isEditMode = false;

    let blocksLoaded = false;
    let blockOptions = [];
    let selectedSlot = null;
    let syncToken = 0;

    const MONITOR_API = 'api/monitor.php';
    const BLOCKS_API = 'api/blocks.php';
    const GRAVES_API = 'api/graves.php';

    const LEASE_YEARS = 5;

    function alertMsg(message, type) {
        if (!message) return;
        if (typeof window.showAlertTOP === 'function') {
            window.showAlertTOP(String(message), type || 'info');
            return;
        }
        if (type === 'error' || type === 'warning') console.warn('[MonitorModal]', message);
        else console.log('[MonitorModal]', message);
    }

    function removeInlineStatus() {
        if (!modalEl) return;

        const inlineSelectors = [
            '.formStatus', '.statusBar', '.saveStatus', '.inlineAlert',
            '.paperStatus', '.paperStatusBar', '.inlineStatus',
            '#form_status', '#save_status', '#status_bar', '#inline_status'
        ];

        inlineSelectors.forEach(function (sel) {
            modalEl.querySelectorAll(sel).forEach(function (el) {
                el.style.display = 'none';
                el.textContent = '';
            });
        });

        const staleMessages = [
            'changes saved',
            'changes saved successfully',
            'record added successfully',
            'record deleted successfully',
            'record transferred successfully'
        ];

        modalEl.querySelectorAll('div, span, p, small').forEach(function (el) {
            if (el.children.length) return;
            const t = (el.textContent || '').trim().toLowerCase();
            if (staleMessages.includes(t)) {
                el.style.display = 'none';
                el.textContent = '';
            }
        });
    }

    function pick(...values) {
        for (const v of values) {
            if (v === null || v === undefined) continue;
            const s = String(v).trim();
            if (s !== '' && s !== 'N/A') return s;
        }
        return '';
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

    async function ensureLoaded() {
        modalEl = document.getElementById('burial_modal_overlay');
        if (modalEl) {
            bindEvents();
            removeInlineStatus();
            return;
        }

        if (!loadPromise) loadPromise = loadModalHtml();
        await loadPromise;

        modalEl = document.getElementById('burial_modal_overlay');
        if (modalEl) {
            bindEvents();
            removeInlineStatus();
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

        if (!html) {
            console.error('[MonitorModal] Failed to load burial_modal.html.');
            return;
        }

        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const fragment = parsed.getElementById('burial_modal_overlay');
        if (!fragment) {
            console.error('[MonitorModal] burial_modal.html missing overlay.');
            return;
        }

        document.body.appendChild(document.adoptNode(fragment));
    }

    function bindEvents() {
        if (!modalEl || bound) return;
        bound = true;

        const form = modalEl.querySelector('#burial_clearance_form');
        if (form) {
            form.setAttribute('novalidate', 'novalidate');
            form.addEventListener('submit', handleSubmit);
        }

        const cancelBtn = modalEl.querySelector('.paperCancelBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (isEditMode) {
                    exitEditMode(true);
                } else {
                    close();
                }
            });
        }

        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl && !isEditMode) close();
        });

        const phone = modalEl.querySelector('#req_phone');
        if (phone) {
            phone.addEventListener('input', (e) => {
                e.target.value = formatPhoneValue(e.target.value);
            });
            phone.addEventListener('blur', (e) => {
                if (!e.target.value) e.target.value = '+63';
            });
        }

        const blockSelect = modalEl.querySelector('#block');
        if (blockSelect) {
            blockSelect.addEventListener('change', () => {
                if (!blockSelect.disabled) handleBlockChange();
            });
        }

        const dateInterment = modalEl.querySelector('#date_interment');
        if (dateInterment) {
            dateInterment.addEventListener('input', recalcExpirationFromInterment);
            dateInterment.addEventListener('change', recalcExpirationFromInterment);
        }
    }

    async function fetchBlocks() {
        const res = await fetch(BLOCKS_API, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const data = json && typeof json === 'object' && 'data' in json ? json.data : json;
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.blocks)) return data.blocks;
        return [];
    }

    async function loadBlocks() {
        if (blocksLoaded) return;

        try {
            const list = await fetchBlocks();
            blockOptions = list
                .map(block => ({
                    id: block && (block.block_id ?? block.id) != null
                        ? (block.block_id ?? block.id) : null,
                    name: String((block && (block.block_name ?? block.name)) || '').trim(),
                    type: String((block && block.block_type) || '').trim(),
                }))
                .filter(b => b.name !== '');
            blocksLoaded = true;
        } catch (err) {
            console.warn('[MonitorModal] Unable to load blocks:', err);
            blockOptions = [];
        }
    }

    function renderBlockOptions(keepValue) {
        if (!modalEl) return;
        const select = modalEl.querySelector('#block');
        if (!select || select.tagName !== 'SELECT') return;

        const current = keepValue !== undefined ? keepValue : select.value;

        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select Block...';
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

    async function fetchFirstVacantSlot(blockId) {
        const url = `${GRAVES_API}?block_id=${encodeURIComponent(blockId)}&status=vacant&limit=1`;
        const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const json = await res.json();
        const data = json && typeof json === 'object' && 'data' in json ? json.data : json;
        const graves = data && Array.isArray(data.graves) ? data.graves : [];
        const first = graves[0];
        if (!first || first.grave_id == null) return null;

        const status = String(first.status || '').trim().toLowerCase();
        if (status && status !== 'vacant') return null;

        return {
            grave_id: Number(first.grave_id),
            grave_code: String(first.grave_code || ''),
        };
    }

    async function handleBlockChange() {
        if (!modalEl) return;

        const blockSelect = modalEl.querySelector('#block');
        const graveCode = modalEl.querySelector('#grave_code');
        if (!blockSelect || !graveCode) return;

        const selectedOption = blockSelect.options[blockSelect.selectedIndex];
        const blockName = (blockSelect.value || '').trim();
        const blockId = selectedOption ? selectedOption.dataset.blockId : null;

        selectedSlot = null;
        graveCode.value = '';

        if (!blockName || !blockId) return;

        const token = ++syncToken;
        try {
            const slot = await fetchFirstVacantSlot(blockId);
            if (token !== syncToken) return;
            if (!slot || !slot.grave_code) return;

            selectedSlot = slot;
            graveCode.value = slot.grave_code;
        } catch (err) {
            console.warn('[MonitorModal] Unable to fetch vacant slot:', err);
        }
    }

    function mapOldOccupant(reservation) {
        const old = reservation.old_occupant || {};
        const target = reservation.target_grave || {};

        let planRemarks = '';
        let planBurialType = '';
        let planDateInterment = '';
        let planExpirationDate = '';
        let planExhumationPermit = '';
        let planTransferPermit = '';
        let oldEdits = {};

        const raw = old.planned_new_remarks;
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    planRemarks = parsed.remarks || '';
                    planBurialType = parsed.burial_type || '';
                    planDateInterment = parsed.date_interment || '';
                    planExpirationDate = parsed.expiration_date || '';
                    planExhumationPermit = parsed.exhumation_permit_number || '';
                    planTransferPermit = parsed.transfer_permit_number || '';

                    if (parsed.old_edits && typeof parsed.old_edits === 'object') {
                        oldEdits = parsed.old_edits;
                    }
                } else {
                    planRemarks = String(raw);
                }
            } catch (_) {
                planRemarks = String(raw);
            }
        }

        if (old.planned_exhumation_permit_number) {
            planExhumationPermit = old.planned_exhumation_permit_number;
        }
        if (old.planned_transfer_permit_number) {
            planTransferPermit = old.planned_transfer_permit_number;
        }

        const base = {
            interment_id: old.interment_id,
            control_number: old.control_number,
            deceased_name: old.deceased_name,
            deceased_sex: old.deceased_sex,
            deceased_date_of_birth: old.deceased_date_of_birth,
            deceased_date_of_death: old.deceased_date_of_death,
            last_known_address: old.last_known_address,
            death_certificate: old.death_certificate,
            contact_person_name: old.contact_person_name,
            contact_person_phone_number: old.contact_person_phone_number,
            contact_person_address: old.contact_person_address,
            contact_person_address_barangay: old.contact_person_address_barangay,
            assistance_type: old.assistance_type,
            burial_permit_number: old.burial_permit_number,
            exhumation_permit_number: old.exhumation_permit_number,
            transfer_permit_number: old.transfer_permit_number,
            date_buried: old.date_buried,
            burial_clearance_date: old.burial_clearance_date,
            lease_expiration_date: old.lease_expiration_date,

            block_name: '',
            grave_code: '',
            block_type: '',
            remarks: old.remarks || '',
        };

        if (old.planned_block_name) base.block_name = old.planned_block_name;
        if (old.planned_grave_code) base.grave_code = old.planned_grave_code;

        const resolvedType = planBurialType || old.planned_block_type || '';
        if (resolvedType) base.block_type = resolvedType;

        if (old.planned_new_assistance_type) {
            base.assistance_type = old.planned_new_assistance_type;
        }
        if (planRemarks) {
            base.remarks = planRemarks;
        }
        if (planDateInterment) {
            base.date_buried = planDateInterment;
        }
        if (planExpirationDate) {
            base.lease_expiration_date = planExpirationDate;
        }

        if (planExhumationPermit) {
            base.exhumation_permit_number = planExhumationPermit;
        }
        if (planTransferPermit) {
            base.transfer_permit_number = planTransferPermit;
        }

        if (!base.block_name && target.block_name) base.block_name = target.block_name;
        if (!base.grave_code && target.grave_code) base.grave_code = target.grave_code;
        if (!base.block_type && target.block_type) base.block_type = target.block_type;

        Object.keys(oldEdits).forEach(k => {
            const v = oldEdits[k];
            if (v !== null && v !== undefined && v !== '') {
                base[k] = v;
            }
        });

        return base;
    }

    function mapNewOccupant(reservation) {
        const n = reservation.new_occupant || {};
        const g = reservation.target_grave || {};

        return {
            interment_id: n.interment_id,
            control_number: n.control_number,
            deceased_name: n.deceased_name,
            deceased_sex: n.deceased_sex,
            deceased_date_of_birth: n.deceased_date_of_birth,
            deceased_date_of_death: n.deceased_date_of_death,
            last_known_address: n.last_known_address,
            death_certificate: n.death_certificate,
            contact_person_name: n.contact_person_name,
            contact_person_phone_number: n.contact_person_phone_number,
            contact_person_address: n.contact_person_address,
            contact_person_address_barangay: n.contact_person_address_barangay,
            assistance_type: n.assistance_type,
            burial_permit_number: n.burial_permit_number,
            exhumation_permit_number: n.exhumation_permit_number,
            transfer_permit_number: n.transfer_permit_number,
            date_buried: n.date_buried,
            burial_clearance_date: n.burial_clearance_date,
            lease_expiration_date: n.lease_expiration_date,

            block_name: g.block_name,
            grave_code: g.grave_code,
            block_type: g.block_type,

            remarks: n.remarks || '',
        };
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
                    matched = Array.from(field.options).find(opt => {
                        if (!opt.value) return false;
                        if (opt.value.toLowerCase() === lower) return true;
                        if (opt.text.toLowerCase() === lower) return true;
                        if (opt.text.toLowerCase().includes(lower)) return true;
                        if (lower.includes(opt.value.toLowerCase())) return true;
                        return false;
                    });
                }

                if (!matched && strValue) {
                    const opt = document.createElement('option');
                    opt.value = strValue;
                    opt.textContent = strValue;
                    field.appendChild(opt);
                    field.value = strValue;
                    return;
                }

                if (matched) {
                    field.value = matched.value;
                } else {
                    field.selectedIndex = 0;
                }
            } else {
                field.value = strValue;
            }
        };

        setFieldValue('control_no', data.control_number);
        setFieldValue('clearance_date', data.burial_clearance_date);

        setFieldValue('req_name', data.contact_person_name);
        setFieldValue('req_phone', data.contact_person_phone_number
            ? formatPhoneValue(data.contact_person_phone_number) : '');
        setFieldValue('req_street', data.contact_person_address);

        const brgy = pick(data.contact_person_address_barangay)
            .replace(/^(Barangay|Brgy\.\s*)/i, '').trim();
        setFieldValue('requesting_barangay', brgy);

        const rawAssist = pick(data.assistance_type);
        let mappedAssist = rawAssist;
        if (/burial/i.test(rawAssist)) mappedAssist = 'Burial of the late';
        else if (/transfer|exhumation/i.test(rawAssist)) mappedAssist = 'Transfer the remains of the late to the bone chamber';
        else if (/^other/i.test(rawAssist)) mappedAssist = 'Other...';
        setFieldValue('req_assistance', mappedAssist);

        setFieldValue('deceased_name', data.deceased_name);
        setFieldValue('deceased_sex', data.deceased_sex);
        setFieldValue('deceased_dob', data.deceased_date_of_birth);
        setFieldValue('deceased_bod', data.deceased_date_of_death);
        setFieldValue('deceased_address', data.last_known_address);
        setFieldValue('deceased_cert', data.death_certificate);

        setFieldValue('permit_burial', data.burial_permit_number);
        setFieldValue('permit_exhumation', data.exhumation_permit_number);
        setFieldValue('permit_transfer', data.transfer_permit_number);

        const rawType = pick(data.block_type);
        let mappedType = rawType;
        if (/niche|wall/i.test(rawType)) mappedType = 'Niche Wall';
        else if (/bone/i.test(rawType)) mappedType = 'Bone Chamber';
        else if (/lawn|ground|standard/i.test(rawType)) mappedType = 'Lawn / Grounds';
        setFieldValue('burial_block', mappedType);

        setFieldValue('block', data.block_name);
        setFieldValue('grave_code', data.grave_code);
        setFieldValue('date_interment', data.date_buried);
        setFieldValue('expiration_date', data.lease_expiration_date);

        setFieldValue('deceased_remarks', data.remarks);
    }

    function setButtonState() {
        const saveBtn = modalEl.querySelector('.paperSaveBtn');
        const cancelBtn = modalEl.querySelector('.paperCancelBtn');
        if (saveBtn) saveBtn.textContent = isEditMode ? 'Save' : 'Edit';
        if (cancelBtn) cancelBtn.textContent = 'Cancel';
    }

    function applyMode() {
        const fields = modalEl.querySelectorAll('input, select, textarea');

        fields.forEach(field => {
            let editable;

            if (field.id === 'expiration_date' || field.id === 'control_no') {
                editable = false;
            } else if (field.id === 'grave_code') {
                editable = false;
            } else if (field.id === 'block') {
                editable = isEditMode;
            } else {
                editable = isEditMode;
            }

            if (field.tagName === 'SELECT') {
                field.disabled = !editable;
                field.classList.toggle('select-readonly', !editable);
            } else {
                field.readOnly = !editable;
            }
        });

        setButtonState();
    }

    function enterEditMode() {
        isEditMode = true;
        applyMode();
    }

    function exitEditMode(discard) {
        if (discard) {
            populateFields(originalValues);
        }
        isEditMode = false;
        applyMode();
    }

    async function handleSubmit(e) {
        e.preventDefault();

        if (!isEditMode) {
            enterEditMode();
            return;
        }

        if (currentOccupantType === 'old') {
            recalcExpirationFromInterment();
        }

        const edited = collectFormValues();

        const invalidDate = ['deceased_date_of_birth', 'deceased_date_of_death',
            'date_buried', 'burial_clearance_date', 'lease_expiration_date']
            .some(k => edited[k] && Number.isNaN(Date.parse(edited[k])));
        if (invalidDate) {
            alertMsg('One of the dates is invalid. Please check and try again.', 'warning');
            return;
        }

        if (!edited.deceased_name) {
            alertMsg('Deceased name is required.', 'warning');
            return;
        }

        try {
            await saveEdits(edited);

            originalValues = { ...edited };
            isEditMode = false;
            applyMode();

            alertMsg('Changes saved successfully.', 'success');

            document.dispatchEvent(new CustomEvent('monitor_burial_modal:saved', {
                detail: {
                    occupantType: currentOccupantType,
                    reservationId: currentReservation ? currentReservation.reservation_id : null,
                },
            }));

        } catch (err) {
            console.error('[MonitorModal] Save failed:', err);
            const msg = (err && err.message) ? err.message : 'Unknown error';
            alertMsg(msg || 'Failed to save changes.', 'error');
        }
    }

    function collectFormValues() {
        const val = (id) => {
            const el = modalEl.querySelector(`#${id}`);
            return el ? String(el.value || '').trim() : '';
        };

        const assistRaw = val('req_assistance');
        let assistance = 'Other';
        if (/^burial/i.test(assistRaw)) assistance = 'Burial';
        else if (/transfer/i.test(assistRaw)) assistance = 'Transfer the remains of the late';

        return {
            control_number: val('control_no'),
            deceased_name: val('deceased_name'),
            deceased_sex: val('deceased_sex'),
            deceased_date_of_birth: val('deceased_dob') || null,
            deceased_date_of_death: val('deceased_bod') || null,
            last_known_address: val('deceased_address'),
            death_certificate: val('deceased_cert'),
            contact_person_name: val('req_name'),
            contact_person_phone_number: val('req_phone'),
            contact_person_address: val('req_street'),
            contact_person_address_barangay: val('requesting_barangay'),
            assistance_type: assistance,
            burial_permit_number: val('permit_burial'),
            exhumation_permit_number: val('permit_exhumation'),
            transfer_permit_number: val('permit_transfer'),
            block_type: val('burial_block'),
            block_name: val('block'),
            grave_code: val('grave_code'),
            date_buried: val('date_interment') || null,
            burial_clearance_date: val('clearance_date') || null,
            lease_expiration_date: val('expiration_date') || null,
            remarks: val('deceased_remarks'),
        };
    }

    async function saveEdits(edited) {
        let url, payload;

        if (currentOccupantType === 'old') {
            url = `${MONITOR_API}?action=save_old_edits`;
            payload = {
                reservation_id: currentReservation.reservation_id,
                old_interment_id: currentReservation.old_occupant
                    ? currentReservation.old_occupant.interment_id : null,
                ...edited,
            };
        } else {
            url = `${MONITOR_API}?action=save_new_edits`;
            payload = {
                reservation_id: currentReservation.reservation_id,
                pending_interment_id: currentReservation.new_occupant
                    ? currentReservation.new_occupant.interment_id : null,
                ...edited,
            };
        }

        const res = await fetch(url, {
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
        return json;
    }

    async function open(occupantType, reservation) {
        await ensureLoaded();
        if (!modalEl) return;

        currentOccupantType = occupantType;
        currentReservation = reservation;
        isEditMode = false;

        const data = occupantType === 'old'
            ? mapOldOccupant(reservation)
            : mapNewOccupant(reservation);

        currentData = data;
        originalValues = { ...data };

        const form = modalEl.querySelector('#burial_clearance_form');
        if (form) form.reset();

        const hint = modalEl.querySelector('#grave_code_hint');
        if (hint) { hint.textContent = ''; hint.classList.remove('visible'); }

        await loadBlocks();
        renderBlockOptions(data.block_name);

        selectedSlot = (data.grave_code && reservation.target_grave)
            ? { grave_id: reservation.target_grave.grave_id, grave_code: data.grave_code }
            : null;

        populateFields(data);
        applyMode();

        removeInlineStatus();

        modalEl.style.display = 'block';
        modalEl.classList.add('active');
    }

    function close() {
        if (!modalEl) return;
        modalEl.style.display = 'none';
        modalEl.classList.remove('active');
        isEditMode = false;
    }

    return { open, close };
})();

window.MonitorBurialModal = MonitorBurialModal;
window.openMonitorOldOccupant = (reservation) => MonitorBurialModal.open('old', reservation);
window.openMonitorNewOccupant = (reservation) => MonitorBurialModal.open('new', reservation);
window.closeMonitorBurialModal = () => MonitorBurialModal.close();