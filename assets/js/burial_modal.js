const BurialModal = (() => {
    let modalEl = null;
    let loadPromise = null;
    let currentMode = "view";
    let activeRecordId = null;
    let takenControlNos = [];

    let blocksPromise = null;
    let blockOptions = [];

    let selectedSlot = null;

    let syncToken = 0;

    const SYNC_DEBOUNCE_MS = 300;
    const LOADING_SHOW_DELAY_MS = 250;
    const LOADING_MIN_VISIBLE_MS = 400;

    let syncDebounceTimer = null;
    let loadingShowTimer = null;
    let loadingHideTimer = null;
    let loadingShownAt = 0;

    const BLOCKS_API = "api/blocks.php";
    const GRAVES_API = "api/graves.php";

    function isValidControlNo(value) {
        const v = String(value || "").trim().toUpperCase();
        return v.length > 0 && /^[A-Z0-9-]+$/.test(v);
    }

    function controlNoExists(value) {
        const v = String(value || "").trim().toUpperCase();
        return takenControlNos.some(n => String(n).trim().toUpperCase() === v);
    }

    function generateControlNo() {
        const year = new Date().getFullYear();
        for (let attempt = 0; attempt < 1000; attempt++) {
            const seq = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
            const code = `CTRL-${year}-${seq}`;
            if (!controlNoExists(code)) return code;
        }
        return "";
    }

    function formatControlNoInput(value) {
        let v = String(value || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");

        const parts = v.split("-");
        const p0 = (parts[0] || "").slice(0, 4);
        const p1 = parts.length > 1 ? (parts[1] || "").slice(0, 4) : null;
        const p2 = parts.length > 2 ? (parts[2] || "").slice(0, 3) : null;

        let out = p0;
        if (p1 !== null) out += "-" + p1;
        if (p2 !== null) out += "-" + p2;
        return out;
    }

    function todayISO() {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return local.toISOString().split("T")[0];
    }

    function addYears(isoDate, years) {
        if (!isoDate || isoDate === "N/A" || isoDate === "Pending") return "";
        const d = new Date(`${isoDate}T00:00:00`);
        if (Number.isNaN(d.getTime())) return "";
        d.setFullYear(d.getFullYear() + years);
        return d.toISOString().split("T")[0];
    }

    function formatPhoneValue(raw) {
        let digits = String(raw || "").replace(/\D/g, "");
        if (digits.startsWith("63")) digits = digits.slice(2);
        if (digits.startsWith("0")) digits = digits.slice(1);
        digits = digits.slice(0, 10);

        let out = "+63";
        if (digits.length > 0) out += " " + digits.slice(0, 3);
        if (digits.length > 3) out += " " + digits.slice(3, 6);
        if (digits.length > 6) out += " " + digits.slice(6, 10);
        return out;
    }

    function formatNameValue(raw) {
        if (!raw) return "";
        return raw.replace(/[^\p{L}\s'.-]/gu, "");
    }

    function pick(...values) {
        for (const v of values) {
            if (v === null || v === undefined) continue;
            const s = String(v).trim();
            if (s !== "" && s !== "N/A") return s;
        }
        return "";
    }

    function clearSyncTimers() {
        if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
        if (loadingShowTimer) { clearTimeout(loadingShowTimer); loadingShowTimer = null; }
        if (loadingHideTimer) { clearTimeout(loadingHideTimer); loadingHideTimer = null; }
    }

    function resetGraveCodeUI() {
        if (!modalEl) return;
        clearSyncTimers();
        const codeInput = modalEl.querySelector("#grave_code");
        if (codeInput) {
            codeInput.value = "";
            codeInput.classList.remove("loading");
        }
        loadingShownAt = 0;
        setGraveCodeHint("");
    }

    function injectStyles() {
        if (document.getElementById("burialModalFieldStyles")) return;

        const style = document.createElement("style");
        style.id = "burialModalFieldStyles";
        style.textContent = `
            #burial_modal_overlay #block {
                max-height: 210px;
                overflow-y: auto;
                scrollbar-width: thin;
            }
            #burial_modal_overlay #block option {
                padding: 4px 8px;
            }

            #burial_modal_overlay .fieldHint {
                display: block;
                min-height: 1em;
                margin-top: 2px;
                font-size: 0.75rem;
                line-height: 1em;
                color: #6b7280;
                visibility: hidden;
            }
            #burial_modal_overlay .fieldHint.error {
                color: #b91c1c;
                font-weight: 600;
                visibility: visible;
            }
            #burial_modal_overlay .fieldHint.visible {
                visibility: visible;
            }

            #burial_modal_overlay #grave_code.loading {
                background-image: linear-gradient(
                    90deg,
                    rgba(148, 163, 184, 0.12) 25%,
                    rgba(148, 163, 184, 0.28) 50%,
                    rgba(148, 163, 184, 0.12) 75%
                );
                background-size: 200% 100%;
                animation: burialModalShimmer 1.2s linear infinite;
                color: transparent;
                caret-color: transparent;
                transition: background-image 0.15s linear;
            }
            @keyframes burialModalShimmer {
                0%   { background-position:  200% 0; }
                100% { background-position: -200% 0; }
            }
        `;
        document.head.appendChild(style);
    }

    function fetchBlocks() {
        return fetch(BLOCKS_API, { headers: { Accept: "application/json" } })
            .then(res => {
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.json();
            })
            .then(json => {
                const data = (json && typeof json === "object" && "data" in json)
                    ? json.data
                    : json;

                if (Array.isArray(data)) return data;
                if (data && Array.isArray(data.blocks)) return data.blocks;
                return [];
            });
    }

    async function loadBlocks() {
        if (blocksPromise) return blocksPromise;

        blocksPromise = (async () => {
            try {
                const list = await fetchBlocks();
                blockOptions = list
                    .map(b => ({
                        id: (b && (b.block_id ?? b.id)) != null ? (b.block_id ?? b.id) : null,
                        name: String((b && (b.block_name ?? b.name)) || "").trim(),
                        type: String((b && b.block_type) || "").trim()
                    }))
                    .filter(b => b.name !== "");
            } catch (err) {
                console.warn("[burial_modal] Unable to load blocks:", err);
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
        const select = modalEl.querySelector("#block");
        if (!select) return;

        const current = keepValue !== undefined ? keepValue : select.value;

        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Select Block...";
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);

        blockOptions.forEach(b => {
            const opt = document.createElement("option");
            opt.value = b.name;
            opt.textContent = b.name;
            if (b.id != null) opt.dataset.blockId = String(b.id);
            if (b.type) opt.dataset.blockType = b.type;
            select.appendChild(opt);
        });

        if (current) {
            const exists = Array.from(select.options).some(o => o.value === current);
            if (!exists) {
                const opt = document.createElement("option");
                opt.value = current;
                opt.textContent = current;
                opt.dataset.placeholder = "true";
                select.appendChild(opt);
            }
            select.value = current;
        } else {
            select.selectedIndex = 0;
        }
    }

    async function fetchFirstVacantSlot(blockId) {
        const url =
            `${GRAVES_API}?block_id=${encodeURIComponent(blockId)}` +
            `&status=vacant&limit=1`;

        const res = await fetch(url, {
            headers: { Accept: "application/json" },
            cache: "no-store"
        });
        if (!res.ok) throw new Error("HTTP " + res.status);

        const json = await res.json();
        const data = (json && typeof json === "object" && "data" in json) ? json.data : json;
        const graves = (data && Array.isArray(data.graves)) ? data.graves : [];
        const first = graves[0];

        if (!first || first.grave_id == null) return null;

        const status = String(first.status || "").trim().toLowerCase();
        if (status && status !== "vacant") return null;

        return {
            grave_id: Number(first.grave_id),
            grave_code: String(first.grave_code || ""),
            row_num: first.row_num,
            col_num: first.col_num
        };
    }

    function setGraveCodeHint(message, isError) {
        if (!modalEl) return;
        const hint = modalEl.querySelector("#grave_code_hint");
        if (!hint) return;

        hint.textContent = message || "";
        hint.classList.toggle("error", !!isError);
        hint.classList.toggle("visible", !!message);
    }

    function scheduleGraveCodeSync() {
        if (!modalEl) return;

        clearSyncTimers();
        const codeInput = modalEl.querySelector("#grave_code");
        if (codeInput) {
            codeInput.value = "";
            codeInput.classList.remove("loading");
        }
        loadingShownAt = 0;
        setGraveCodeHint("");

        syncToken++;

        syncDebounceTimer = setTimeout(() => {
            syncDebounceTimer = null;
            syncGraveCode();
        }, SYNC_DEBOUNCE_MS);
    }

    async function syncGraveCode() {
        if (!modalEl) return;

        const blockSel = modalEl.querySelector("#block");
        const codeInput = modalEl.querySelector("#grave_code");
        if (!blockSel || !codeInput) return;

        if (currentMode === "view") return;

        clearSyncTimers();
        selectedSlot = null;
        codeInput.value = "";
        codeInput.classList.remove("loading");
        loadingShownAt = 0;
        setGraveCodeHint("");

        const opt = blockSel.options[blockSel.selectedIndex];
        const blockName = (blockSel.value || "").trim();
        const blockId = opt ? opt.dataset.blockId : null;

        if (!blockName || !blockId) return;

        const token = ++syncToken;

        loadingShowTimer = setTimeout(() => {
            if (token !== syncToken) return;
            loadingShownAt = Date.now();
            codeInput.classList.add("loading");
            loadingShowTimer = null;
        }, LOADING_SHOW_DELAY_MS);

        let slot = null;
        let fetchError = null;
        try {
            slot = await fetchFirstVacantSlot(blockId);
        } catch (err) {
            fetchError = err;
        }

        if (token !== syncToken) return;

        if (loadingShowTimer) {
            clearTimeout(loadingShowTimer);
            loadingShowTimer = null;
        }

        if (codeInput.classList.contains("loading")) {
            const elapsed = Date.now() - loadingShownAt;
            const remaining = Math.max(0, LOADING_MIN_VISIBLE_MS - elapsed);
            if (loadingHideTimer) clearTimeout(loadingHideTimer);
            loadingHideTimer = setTimeout(() => {
                codeInput.classList.remove("loading");
                loadingHideTimer = null;
            }, remaining);
        } else {
            codeInput.classList.remove("loading");
        }

        if (fetchError) {
            console.warn("[burial_modal] Unable to fetch vacant slot:", fetchError);
            setGraveCodeHint("Unable to check grave availability. Please try again.", true);
            return;
        }

        if (!slot || !slot.grave_code) {
            setGraveCodeHint("No available grave codes in this block.", true);
            return;
        }

        selectedSlot = slot;
        codeInput.value = slot.grave_code;
        setGraveCodeHint("");
    }

    async function ensureLoaded() {
        injectStyles();

        modalEl = document.getElementById("burial_modal_overlay");
        if (modalEl) {
            bindEvents();
            return;
        }

        if (!loadPromise) loadPromise = loadModalHtml();
        await loadPromise;

        modalEl = document.getElementById("burial_modal_overlay");
        if (modalEl) bindEvents();
    }

    async function loadModalHtml() {
        const paths = ["burial_modal.html", "assets/html/burial_modal.html"];
        let html = null;

        for (const path of paths) {
            try {
                const res = await fetch(path);
                if (res.ok) { html = await res.text(); break; }
            } catch (_) { }
        }

        if (!html) {
            console.error("Failed to load burial_modal.html.");
            return;
        }

        const parsed = new DOMParser().parseFromString(html, "text/html");
        const fragment = parsed.getElementById("burial_modal_overlay");
        if (!fragment) {
            console.error("burial_modal.html did not contain #burial_modal_overlay.");
            return;
        }

        document.body.appendChild(document.adoptNode(fragment));
    }

    function bindEvents() {
        if (!modalEl || modalEl.dataset.bound === "true") return;
        modalEl.dataset.bound = "true";

        const cancelBtn = modalEl.querySelector(".paperCancelBtn");
        if (cancelBtn) cancelBtn.addEventListener("click", close);

        modalEl.addEventListener("click", (e) => {
            if (e.target === modalEl) close();
        });

        const form = modalEl.querySelector("#burial_clearance_form");
        if (form) form.addEventListener("submit", handleSubmit);

        const dateInterment = modalEl.querySelector("#date_interment");
        if (dateInterment) {
            dateInterment.addEventListener("change", () => {
                const exp = modalEl.querySelector("#expiration_date");
                if (exp) exp.value = addYears(dateInterment.value, 5);
            });
        }

        const phone = modalEl.querySelector("#req_phone");
        if (phone) {
            phone.addEventListener("input", (e) => {
                e.target.value = formatPhoneValue(e.target.value);
            });
            phone.addEventListener("blur", (e) => {
                if (!e.target.value) e.target.value = "+63";
            });
        }

        ["req_name", "deceased_name"].forEach((id) => {
            const field = modalEl.querySelector(`#${id}`);
            if (field) {
                field.addEventListener("input", (e) => {
                    e.target.value = formatNameValue(e.target.value);
                });
            }
        });

        const controlNo = modalEl.querySelector("#control_no");
        if (controlNo) {
            controlNo.addEventListener("input", (e) => {
                e.target.value = formatControlNoInput(e.target.value);
            });
        }

        const blockSelect = modalEl.querySelector("#block");
        if (blockSelect) {
            blockSelect.addEventListener("change", scheduleGraveCodeSync);
        }
    }

    async function open(mode = "view", data = {}, options = {}) {
        await ensureLoaded();
        if (!modalEl) return;

        currentMode = mode;
        activeRecordId = data.id || null;
        takenControlNos = Array.isArray(options.takenControlNos)
            ? options.takenControlNos.map(n => String(n).trim().toUpperCase())
            : [];

        selectedSlot = null;
        syncToken++;

        const form = modalEl.querySelector("#burial_clearance_form");
        if (form) form.reset();

        modalEl.classList.toggle("view-mode", mode === "view");

        blocksPromise = null;
        await loadBlocks();
        renderBlockOptions("");

        resetGraveCodeUI();

        const d = { ...data };
        if (mode === "add") {
            if (!pick(d.control_no, d.controlNo)) d.control_no = generateControlNo();
            if (!pick(d.clearance_date, d.clearanceDate)) d.clearance_date = todayISO();
            if (!pick(d.req_phone, d.contactPhone)) d.req_phone = "+63";
        }

        populateFields(d);
        setEditable(mode !== "view");

        if (mode === "add") {
            await syncGraveCode();
        } else {
            const loadedGraveId = Number(pick(data.current_grave_id, data.grave_id)) || null;
            const loadedGraveCode = pick(data.grave_code, data.graveCode);
            if (loadedGraveId) {
                selectedSlot = {
                    grave_id: loadedGraveId,
                    grave_code: loadedGraveCode,
                    row_num: pick(data.row_num, data.grave_row) || null,
                    col_num: pick(data.col_num, data.grave_col) || null
                };
            }
        }

        modalEl.style.display = "block";
        modalEl.classList.add("active");
    }

    function populateFields(data) {
        const isView = currentMode === "view";

        const setFieldValue = (id, val) => {
            const field = modalEl.querySelector(`#${id}`);
            if (!field) return;

            let strVal = pick(val);

            if (field.tagName === "SELECT") {
                const stale = field.querySelector('option[data-placeholder="true"]');
                if (stale) stale.remove();

                let matched = Array.from(field.options).find(
                    opt => opt.value === strVal || opt.text === strVal
                );
                if (!matched && strVal) {
                    const lower = strVal.toLowerCase();
                    matched = Array.from(field.options).find(opt =>
                        opt.value.toLowerCase() === lower ||
                        opt.text.toLowerCase().includes(lower) ||
                        lower.includes(opt.value.toLowerCase())
                    );
                }
                if (matched) {
                    field.value = matched.value;
                } else if (strVal) {
                    const opt = document.createElement("option");
                    opt.value = strVal;
                    opt.textContent = strVal;
                    if (strVal === "-") opt.dataset.placeholder = "true";
                    field.appendChild(opt);
                    field.value = strVal;
                } else {
                    field.value = "";
                }
            } else {
                field.value = strVal;
            }
        };

        setFieldValue("clearance_date", pick(data.clearance_date, data.clearanceDate, data.control_date));
        setFieldValue("control_no", pick(data.control_no, data.controlNo));

        setFieldValue("req_name", pick(data.req_name, data.contactName, data.applicant_full_name));

        const rawPhone = pick(data.req_phone, data.contactPhone, data.phone_number);
        if (rawPhone) {
            setFieldValue("req_phone", formatPhoneValue(rawPhone));
        } else {
            setFieldValue("req_phone", isView ? "" : "+63");
        }

        const rawBrgy = pick(data.barangay, data.barangay_address, data.requesting_barangay);
        setFieldValue("requesting_barangay", rawBrgy.replace(/^(Barangay|Brgy\.)\s*/i, "").trim());

        if (pick(data.purokStreet, data.purok_zone_street)) {
            setFieldValue("req_street", pick(data.purokStreet, data.purok_zone_street));
        } else if (pick(data.contactAddress, data.req_street)) {
            const parts = pick(data.contactAddress, data.req_street).split(",");
            setFieldValue("req_street", parts[0].trim());
        } else {
            setFieldValue("req_street", "");
        }

        const rawAssist = pick(data.assistance, data.assistance_type, data.req_assistance);
        let mappedAssist = rawAssist;
        if (/burial/i.test(rawAssist)) mappedAssist = "Burial of the late";
        else if (/transfer|exhumation/i.test(rawAssist))
            mappedAssist = "Transfer the remains of the late to the bone chamber";
        else if (/^other/i.test(rawAssist)) mappedAssist = "Other...";
        setFieldValue("req_assistance", mappedAssist);

        setFieldValue("deceased_name", pick(data.deceased_name, data.name));
        setFieldValue("deceased_sex", pick(data.deceased_sex, data.sex));
        setFieldValue("deceased_dob", pick(data.deceased_dob, data.dob, data.deceased_date_of_birth));
        setFieldValue("deceased_bod", pick(data.deceased_bod, data.dod, data.deceased_date_of_death));
        setFieldValue("deceased_address", pick(data.deceased_address, data.address, data.last_known_address));
        setFieldValue("deceased_cert", pick(data.deceased_cert, data.certNo, data.death_certificate_no));

        setFieldValue("permit_burial", pick(data.permit_burial, data.permitBurial, data.burial_permit_no));
        setFieldValue("permit_exhumation", pick(data.permit_exhumation, data.permitExhumation, data.exhumation_permit_no));
        setFieldValue("permit_transfer", pick(data.permit_transfer, data.permitTransfer, data.transfer_permit_no));

        const rawType = pick(data.burialType, data.burial_type, data.burial_block);
        let mappedType = rawType;
        if (/niche|wall/i.test(rawType)) mappedType = "Niche Wall";
        else if (/bone/i.test(rawType)) mappedType = "Bone Chamber";
        else if (/lawn|ground|standard/i.test(rawType)) mappedType = "Lawn / Grounds";
        setFieldValue("burial_block", mappedType);

        setFieldValue("block", pick(data.block, data.blockName, data.block_name));

        setFieldValue("grave_code", pick(data.grave_code, data.graveCode));
        setFieldValue("date_interment", pick(data.date_interment, data.dateInterment, data.date_of_interment));
        setFieldValue("expiration_date", pick(data.expiration_date, data.expiration));
        setFieldValue("deceased_remarks", pick(data.deceased_remarks, data.remarks));
    }

    function setEditable(editable) {
        const inputs = modalEl.querySelectorAll("input, select, textarea");
        inputs.forEach((el) => {
            if (el.id === "expiration_date") {
                el.disabled = true;
            } else if (el.id === "grave_code") {
                el.readOnly = true;
                el.disabled = !editable;
            } else {
                el.disabled = !editable;
            }
        });

        const controlNo = modalEl.querySelector("#control_no");
        if (controlNo) {
            controlNo.readOnly = !editable;
        }

        const saveBtn = modalEl.querySelector(".paperSaveBtn");
        if (saveBtn) saveBtn.style.display = editable ? "inline-block" : "none";

        const cancelBtn = modalEl.querySelector(".paperCancelBtn");
        if (cancelBtn) cancelBtn.textContent = editable ? "Cancel" : "Close";
    }

    async function handleSubmit(e) {
        e.preventDefault();

        const phoneRaw = modalEl.querySelector("#req_phone")?.value.trim() || "";
        const phoneDigits = phoneRaw.replace(/\D/g, "").replace(/^63/, "");
        if (phoneDigits.length !== 10) {
            alert("Phone number must be in the format +63 XXX XXX XXXX (10 digits after +63).");
            return;
        }

        const controlNoField = modalEl.querySelector("#control_no");
        const controlNo = (controlNoField?.value || "").trim().toUpperCase();

        if (!/^CTRL-\d{4}-\d{3}$/.test(controlNo)) {
            alert("Control No. must follow the format CTRL-YYYY-NNN (e.g., CTRL-2026-001).");
            controlNoField?.focus();
            return;
        }
        if (controlNoExists(controlNo)) {
            alert(`Control No. "${controlNo}" is already used by another record.`);
            controlNoField?.focus();
            return;
        }

        const street = modalEl.querySelector("#req_street")?.value.trim() || "";
        const barangay = modalEl.querySelector("#requesting_barangay")?.value || "";

        const assistRaw = modalEl.querySelector("#req_assistance")?.value || "";
        let assistance = "Other";
        if (/^burial/i.test(assistRaw)) assistance = "Burial";
        else if (/transfer/i.test(assistRaw)) assistance = "Transfer the remains of the late";

        const burialTypeRaw = modalEl.querySelector("#burial_block")?.value || "";

        const blockField = modalEl.querySelector("#block");
        const blockName = (blockField?.value || "").trim();
        if (!blockName) {
            alert("Please select a Block from the available options.");
            blockField?.focus();
            return;
        }
        const blockIsListed = Array.from(blockField.options)
            .some(o => o.value === blockName && o.dataset.placeholder !== "true");
        if (!blockIsListed) {
            alert("Please select a valid Block from the list.");
            blockField?.focus();
            return;
        }

        let graveCode = (modalEl.querySelector("#grave_code")?.value || "").trim();

        if (!selectedSlot || !graveCode) {
            if (syncDebounceTimer) {
                clearTimeout(syncDebounceTimer);
                syncDebounceTimer = null;
            }
            await syncGraveCode();
            graveCode = (modalEl.querySelector("#grave_code")?.value || "").trim();
        }

        if (!selectedSlot || !selectedSlot.grave_id || !graveCode) {
            alert("This block has no available grave codes. Please choose another block.");
            blockField?.focus();
            return;
        }

        const payload = {
            interment_id: activeRecordId || undefined,
            control_number: controlNo,
            deceased_name: modalEl.querySelector("#deceased_name")?.value.trim() || "",
            deceased_sex: modalEl.querySelector("#deceased_sex")?.value || "",
            deceased_date_of_birth: modalEl.querySelector("#deceased_dob")?.value || null,
            deceased_date_of_death: modalEl.querySelector("#deceased_bod")?.value || null,
            last_known_address: modalEl.querySelector("#deceased_address")?.value.trim() || "",
            death_certificate: modalEl.querySelector("#deceased_cert")?.value.trim() || "",

            contact_person_name: modalEl.querySelector("#req_name")?.value.trim() || "",
            contact_person_phone_number: phoneRaw,
            contact_person_address: street,
            contact_person_address_barangay: barangay,

            assistance_type: assistance,
            burial_permit_number: modalEl.querySelector("#permit_burial")?.value.trim() || "",
            exhumation_permit_number: modalEl.querySelector("#permit_exhumation")?.value.trim() || "",
            transfer_permit_number: modalEl.querySelector("#permit_transfer")?.value.trim() || "",

            burial_clearance_date: modalEl.querySelector("#clearance_date")?.value || null,
            date_buried: modalEl.querySelector("#date_interment")?.value || null,
            lease_expiration_date: modalEl.querySelector("#expiration_date")?.value || null,

            remarks: modalEl.querySelector("#deceased_remarks")?.value.trim() || "",

            current_grave_id: selectedSlot.grave_id,

            block_name: blockName,
            grave_code: graveCode,
            block_type: burialTypeRaw,

            status: "Active"
        };

        document.dispatchEvent(new CustomEvent("burial_modal:save", {
            detail: { mode: currentMode, data: payload }
        }));

        close();
    }

    function close() {
        if (!modalEl) return;
        modalEl.style.display = "none";
        modalEl.classList.remove("active");
        clearSyncTimers();
        selectedSlot = null;
        syncToken++;
    }

    return { open, close };
})();

window.BurialModal = BurialModal;
window.closeSeamlessModal = () => BurialModal.close();