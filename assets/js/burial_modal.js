const BurialModal = (() => {
    // ---------- module state ----------
    let modalEl = null;
    let loadPromise = null;
    let currentMode = "view";
    let activeRecordId = null;
    let takenControlNos = [];

    let originalData = null;
    let originalSlot = null;

    let blocksPromise = null;
    let blockOptions = [];

    let selectedSlot = null;
    let gravesToken = 0;
    let burialTypePlaceholderText = null;

    let blockChangeTimer = null;
    const BLOCK_CHANGE_DEBOUNCE_MS = 250;

    const BLOCKS_API = "api/blocks.php";
    const GRAVES_API = "api/graves.php";

    // Fields that map 1:1 with records.php columns.
    // Adding/removing a field here is the only place you need to touch
    // to keep the form and the API in sync.
    const FORM_FIELDS = [
        "control_number",
        "burial_clearance_date",
        "contact_person_name",
        "contact_person_address",
        "contact_person_address_barangay",
        "contact_person_phone_number",
        "contact_person_email",
        "assistance_type",
        "deceased_name",
        "deceased_sex",
        "deceased_date_of_birth",
        "last_known_address",
        "deceased_date_of_death",
        "death_certificate",
        "burial_permit_number",
        "burial_permit_date",
        "transfer_permit_number",
        "transfer_permit_issued_by",
        "transfer_permit_date",
        "exhumation_permit_number",
        "exhumation_permit_date",
        "date_buried",
        "lease_expiration_date",
        "status",
        "remarks",
    ];

    // ---------- tiny DOM helpers ----------
    const $ = (id) => (modalEl ? modalEl.querySelector("#" + id) : null);
    const $$ = (sel) => (modalEl ? modalEl.querySelectorAll(sel) : []);

    // ---------- small utilities ----------
    function controlNoExists(value) {
        const v = String(value || "").trim().toUpperCase();
        return takenControlNos.some(n => String(n).trim().toUpperCase() === v);
    }

    function generateControlNo() {
        const year = new Date().getFullYear();
        for (let i = 0; i < 1000; i++) {
            const seq = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
            const code = `CTRL-${year}-${seq}`;
            if (!controlNoExists(code)) return code;
        }
        return "";
    }

    // NOTE: formatControlNoInput() was removed — control_number is now free text.

    function todayISO() {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return local.toISOString().split("T")[0];
    }

    function addYears(isoDate, years) {
        if (!isoDate) return "";
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

    // Normalize a block_type string to match the <select id="burial_block"> options.
    function normalizeType(value) {
        const s = String(value || "").trim();
        if (!s) return "";
        if (/niche|wall/i.test(s)) return "Niche";
        if (/bone/i.test(s)) return "Bone Chamber";
        if (/lawn|ground|standard/i.test(s)) return "Lawn/Grounds";
        if (/unmapped/i.test(s)) return "Unmapped Area";
        if (/mausoleum/i.test(s)) return "Mausoleum";
        if (/mass/i.test(s)) return "Mass Grave";
        if (/cluster/i.test(s)) return "Cluster";
        if (/^block\b/i.test(s)) return "Block";
        if (/private|owned/i.test(s)) return "Private";
        return s;
    }

    // Trim, coalesce null/undefined, treat "N/A" as empty.
    function pick(val) {
        if (val === null || val === undefined) return "";
        const s = String(val).trim();
        return s === "N/A" ? "" : s;
    }

    function clearBlockChangeTimer() {
        if (blockChangeTimer) {
            clearTimeout(blockChangeTimer);
            blockChangeTimer = null;
        }
    }

    // ---------- styles ----------
    function injectStyles() {
        if (document.getElementById("burialModalFieldStyles")) return;
        const style = document.createElement("style");
        style.id = "burialModalFieldStyles";
        style.textContent = `
            #burial_modal_overlay #block,
            #burial_modal_overlay #grave_code {
                max-height: 210px;
                overflow-y: auto;
                scrollbar-width: thin;
            }
            #burial_modal_overlay #block option,
            #burial_modal_overlay #grave_code option {
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
        `;
        document.head.appendChild(style);
    }

    // ---------- block / grave API ----------
    function blocksMatchingType(typeLabel) {
        const norm = normalizeType(typeLabel);
        if (!norm) return blockOptions;
        return blockOptions.filter(b => normalizeType(b.type) === norm);
    }

    async function fetchBlocks() {
        const res = await fetch(BLOCKS_API, {
            headers: { Accept: "application/json" },
            cache: "no-store"
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        const data = (json && typeof json === "object" && "data" in json) ? json.data : json;
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
                        id: (b && (b.block_id ?? b.id)) ?? null,
                        name: String((b && (b.block_name)) || "").trim(),
                        type: String((b && b.block_type) || "").trim(),
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

    function renderBlockOptions(keepValue, filterType) {
        const select = $("block");
        if (!select) return;

        const isView = currentMode === "view";
        const current = keepValue !== undefined ? keepValue : select.value;
        const list = filterType ? blocksMatchingType(filterType) : blockOptions;

        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.selected = true;
        placeholder.textContent = isView
            ? ""
            : (filterType && list.length === 0
                ? "No blocks for this Burial Type"
                : "Select Block...");
        select.appendChild(placeholder);

        list.forEach(b => {
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
                const match = blockOptions.find(b => b.name === current);
                const opt = document.createElement("option");
                opt.value = current;
                opt.textContent = current;
                opt.dataset.placeholder = "true";
                if (match && match.id != null) opt.dataset.blockId = String(match.id);
                if (match && match.type) opt.dataset.blockType = match.type;
                select.appendChild(opt);
            }
            select.value = current;
        } else {
            select.selectedIndex = 0;
        }
    }

    async function fetchGravesForBlock(blockId) {
        const url = `${GRAVES_API}?block_id=${encodeURIComponent(blockId)}`;
        const res = await fetch(url, {
            headers: { Accept: "application/json" },
            cache: "no-store"
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        const data = (json && typeof json === "object" && "data" in json) ? json.data : json;
        const graves = (data && Array.isArray(data.graves)) ? data.graves : [];
        return graves;
    }

    function ensureGraveCodeSelect() {
        const el = $("grave_code");
        if (!el || el.tagName === "SELECT") return;

        const select = document.createElement("select");
        select.id = "grave_code";
        if (el.name) select.name = el.name;
        if (el.className) select.className = el.className;
        if (el.hasAttribute("required")) select.setAttribute("required", "");
        el.parentNode.replaceChild(select, el);
    }

    function renderGraveOptions(graves, selectedGraveId) {
        const select = $("grave_code");
        if (!select) return;

        const isView = currentMode === "view";
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = isView
            ? ""
            : (graves.length ? "Select Grave Code..." : "No available grave codes");
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);

        const seen = new Set();
        for (const g of (graves || [])) {
            const code = String(g.grave_code || "").trim();
            const id = g.grave_id;
            if (!code || id == null || seen.has(code)) continue;
            seen.add(code);

            const opt = document.createElement("option");
            opt.value = code;
            opt.textContent = code;
            opt.dataset.graveId = String(id);
            if (g._pinned) opt.dataset.pinned = "true";
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
        const select = $("grave_code");
        if (!select || select.selectedIndex < 0) {
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
            grave_code: opt.value
        };
    }

    function setGraveCodeHint(message, isError) {
        const hint = $("grave_code_hint");
        if (!hint) return;
        hint.textContent = message || "";
        hint.classList.toggle("error", !!isError);
        hint.classList.toggle("visible", !!message);
    }

    function resetGraveSelectUI() {
        const select = $("grave_code");
        if (!select) return;
        const isView = currentMode === "view";
        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = isView ? "" : "Select Block first...";
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);

        selectedSlot = null;
        setGraveCodeHint("");
    }

    async function loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode) {
        const select = $("grave_code");
        if (!select) return;

        clearBlockChangeTimer();
        const token = ++gravesToken;

        if (currentMode === "view") {
            if (pinnedGraveId) {
                renderGraveOptions([{
                    grave_id: Number(pinnedGraveId),
                    grave_code: pinnedGraveCode || "",
                    _pinned: true
                }], pinnedGraveId);
            } else {
                renderGraveOptions([], null);
            }
            return;
        }

        select.innerHTML = "";
        const loading = document.createElement("option");
        loading.value = "";
        loading.textContent = "Loading...";
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
            console.warn("[burial_modal] Unable to fetch graves:", fetchError);
            setGraveCodeHint("Unable to load grave codes. Please try again.", true);
            renderGraveOptions([], null);
            return;
        }

        if (pinnedGraveId) {
            const pinId = Number(pinnedGraveId);
            const exists = graves.some(g => Number(g.grave_id) === pinId);
            if (!exists) {
                graves.unshift({
                    grave_id: pinId,
                    grave_code: pinnedGraveCode || "",
                    status: "occupied",
                    _pinned: true
                });
            }
        }

        setGraveCodeHint(
            graves.length ? "" : "No available grave codes in this block.",
            !graves.length
        );
        renderGraveOptions(graves, pinnedGraveId);
    }

    function setBurialTypeFromBlockType(blockType) {
        const select = $("burial_block");
        if (!select || select.tagName !== "SELECT") return;

        const raw = String(blockType || "").trim();
        if (!raw) return;

        const norm = normalizeType(raw);
        let matched = Array.from(select.options).find(
            o => o.value !== "" && normalizeType(o.value) === norm
        );
        if (!matched) matched = Array.from(select.options).find(o => o.value === raw);
        if (!matched) {
            const opt = document.createElement("option");
            opt.value = raw;
            opt.textContent = raw;
            select.appendChild(opt);
            matched = opt;
        }
        select.value = matched.value;
        updateBurialTypePlaceholder();
    }

    function onBlockChange() {
        const blockSelect = $("block");
        if (!blockSelect) return;

        const opt = blockSelect.options[blockSelect.selectedIndex];
        const blockId = opt ? opt.dataset.blockId : null;
        const blockName = (blockSelect.value || "").trim();
        const blockType = opt ? (opt.dataset.blockType || "") : "";

        if (blockName && blockType) setBurialTypeFromBlockType(blockType);

        resetGraveSelectUI();

        if (!blockId || !blockName) {
            renderGraveOptions([], null);
            setGraveCodeHint("");
            return;
        }

        let pinnedGraveId = null;
        let pinnedGraveCode = null;
        if (originalData && originalData.current_grave_id) {
            if (pick(originalData.block_name) === blockName) {
                pinnedGraveId = originalData.current_grave_id;
                pinnedGraveCode = pick(originalData.grave_code);
            }
        }

        clearBlockChangeTimer();
        blockChangeTimer = setTimeout(() => {
            blockChangeTimer = null;
            loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
        }, BLOCK_CHANGE_DEBOUNCE_MS);
    }

    function onBurialTypeChange() {
        const burialType = $("burial_block")?.value || "";
        const blockSelect = $("block");
        if (blockSelect) blockSelect.value = "";
        resetGraveSelectUI();
        renderBlockOptions("", burialType);
        updateBurialTypePlaceholder();
    }

    function updateBurialTypePlaceholder() {
        const select = $("burial_block");
        if (!select || select.tagName !== "SELECT" || !select.options.length) return;
        const placeholder = select.options[0];
        if (burialTypePlaceholderText === null) {
            burialTypePlaceholderText = (placeholder.textContent || "").trim() || "Select Burial Type";
        }
        const isView = currentMode === "view";
        const hasValue = !!select.value;
        placeholder.textContent = (isView && !hasValue) ? "" : burialTypePlaceholderText;
    }

    // ---------- location helpers ----------
    // Active = all-filled or all-empty (never partial).
    // Inactive = must be all-empty.
    function readLocationState() {
        const burialType = currentBurialTypeValue();
        const blockName = currentBlockValue();
        const graveCode = ($("grave_code")?.value || "").trim();
        const flags = [!!burialType, !!blockName, !!graveCode];
        return {
            burialType,
            blockName,
            graveCode,
            anyFilled: flags.some(Boolean),
            allFilled: flags.every(Boolean),
            allEmpty: flags.every(v => !v),
        };
    }

    function clearLocationFields() {
        const burialTypeSelect = $("burial_block");
        if (burialTypeSelect) burialTypeSelect.value = "";

        const blockSelect = $("block");
        if (blockSelect) blockSelect.selectedIndex = 0;

        resetGraveSelectUI();
        updateBurialTypePlaceholder();
    }

    // ---------- modal load ----------
    async function ensureLoaded() {
        injectStyles();
        modalEl = document.getElementById("burial_modal_overlay");
        if (modalEl) {
            ensureGraveCodeSelect();
            ensureEditButton();
            bindEvents();
            return;
        }
        if (!loadPromise) loadPromise = loadModalHtml();
        await loadPromise;
        modalEl = document.getElementById("burial_modal_overlay");
        if (modalEl) {
            ensureGraveCodeSelect();
            ensureEditButton();
            bindEvents();
        }
    }

    async function loadModalHtml() {
        const paths = ["burial_modal.html", "assets/html/burial_modal.html"];
        let html = null;
        for (const path of paths) {
            try {
                const res = await fetch(path);
                if (res.ok) { html = await res.text(); break; }
            } catch (_) { /* try next */ }
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

    function ensureEditButton() {
        const actions = modalEl.querySelector(".paperFormActions");
        if (!actions || actions.querySelector(".paperEditBtn")) return;

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "paperEditBtn";
        editBtn.textContent = "Edit";

        const saveBtn = actions.querySelector(".paperSaveBtn");
        if (saveBtn) actions.insertBefore(editBtn, saveBtn);
        else actions.appendChild(editBtn);

        editBtn.addEventListener("click", enterEditMode);
    }

    function updateActionButtons() {
        const saveBtn = modalEl.querySelector(".paperSaveBtn");
        const cancelBtn = modalEl.querySelector(".paperCancelBtn");
        const editBtn = modalEl.querySelector(".paperEditBtn");

        const isView = currentMode === "view";
        const isEdit = currentMode === "edit";
        const isAdd = currentMode === "add";
        const isPending = originalData && String(originalData.status).trim() === "Pending";

        if (saveBtn) saveBtn.style.display = (isEdit || isAdd) ? "inline-block" : "none";
        if (editBtn) editBtn.style.display = (isView && !isPending) ? "inline-block" : "none";
        if (cancelBtn) {
            cancelBtn.textContent = (isEdit || isAdd) ? "Cancel" : "Close";
            cancelBtn.style.display = "inline-block";
        }
    }

    // ---------- edit / cancel / apply ----------
    function currentBurialTypeValue() {
        return $("burial_block")?.value || "";
    }

    function currentBlockValue() {
        return $("block")?.value || "";
    }

    function enterEditMode() {
        if (!modalEl || currentMode !== "view") return;

        if (originalData && String(originalData.status).trim() === "Pending") {
            window.showAlertTOP("Cannot edit a Pending interment here. Use Monitor.", "warning");
            return;
        }

        currentMode = "edit";
        modalEl.classList.remove("view-mode");
        setEditable(true);
        updateActionButtons();

        const blockSelect = $("block");
        if (!blockSelect) return;

        renderBlockOptions(blockSelect.value || "", currentBurialTypeValue());

        if (blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const pinnedGraveId = originalData ? pick(originalData.current_grave_id) : null;
            const pinnedGraveCode = originalData ? pick(originalData.grave_code) : null;
            if (blockId) loadGraveOptions(blockId, blockSelect.value, pinnedGraveId, pinnedGraveCode);
        } else {
            resetGraveSelectUI();
        }
    }

    function cancelEdit() {
        if (!modalEl || currentMode !== "edit") return;
        currentMode = "view";
        modalEl.classList.add("view-mode");

        clearBlockChangeTimer();
        gravesToken++;
        selectedSlot = originalSlot ? { ...originalSlot } : null;

        if (originalData) populateFields(originalData);
        renderBlockOptions(currentBlockValue(), currentBurialTypeValue());
        setEditable(false);
        updateActionButtons();

        const blockSelect = $("block");
        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const pinnedGraveId = originalData ? pick(originalData.current_grave_id) : null;
            const pinnedGraveCode = originalData ? pick(originalData.grave_code) : null;
            if (blockId) loadGraveOptions(blockId, blockSelect.value, pinnedGraveId, pinnedGraveCode);
        } else {
            renderBlockOptions("", currentBurialTypeValue());
            resetGraveSelectUI();
        }
    }

    function applySavedData(updatedData) {
        if (!modalEl) return;

        currentMode = "view";
        modalEl.classList.add("view-mode");
        clearBlockChangeTimer();
        gravesToken++;

        if (updatedData && typeof updatedData === "object") {
            originalData = { ...updatedData };
            if (updatedData.interment_id) activeRecordId = updatedData.interment_id;

            const newGraveId = Number(pick(updatedData.current_grave_id)) || null;
            const newGraveCode = pick(updatedData.grave_code);
            if (newGraveId) {
                selectedSlot = {
                    grave_id: newGraveId,
                    grave_code: newGraveCode,
                    row_num: updatedData.row_num || null,
                    col_num: updatedData.col_num || null
                };
                originalSlot = { ...selectedSlot };
            } else {
                selectedSlot = null;
                originalSlot = null;
            }
        }

        populateFields(originalData || {});
        renderBlockOptions(currentBlockValue(), currentBurialTypeValue());
        setEditable(false);
        updateActionButtons();

        const blockSelect = $("block");
        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const pinnedGraveId = originalData ? pick(originalData.current_grave_id) : null;
            const pinnedGraveCode = originalData ? pick(originalData.grave_code) : null;
            if (blockId) loadGraveOptions(blockId, blockSelect.value, pinnedGraveId, pinnedGraveCode);
        } else {
            renderBlockOptions("", currentBurialTypeValue());
            resetGraveSelectUI();
        }
    }

    function handleCancelClick() {
        if (currentMode === "edit") cancelEdit();
        else close();
    }

    // ---------- event bindings ----------
    function bindEvents() {
        if (!modalEl || modalEl.dataset.bound === "true") return;
        modalEl.dataset.bound = "true";

        modalEl.querySelector(".paperCancelBtn")?.addEventListener("click", handleCancelClick);

        modalEl.addEventListener("click", (e) => {
            if (e.target === modalEl) handleCancelClick();
        });

        modalEl.querySelector("#burial_clearance_form")?.addEventListener("submit", handleSubmit);

        // date_buried → auto-calc lease_expiration_date (+5 years)
        $("date_buried")?.addEventListener("change", (e) => {
            const exp = $("lease_expiration_date");
            if (exp) exp.value = addYears(e.target.value, 5);
        });

        // phone formatting
        const phone = $("contact_person_phone_number");
        if (phone) {
            phone.addEventListener("input", (e) => {
                e.target.value = formatPhoneValue(e.target.value);
            });
            phone.addEventListener("blur", (e) => {
                if (!e.target.value) e.target.value = "+63";
            });
        }

        // name sanitization
        ["contact_person_name", "deceased_name"].forEach((id) => {
            $(id)?.addEventListener("input", (e) => {
                e.target.value = formatNameValue(e.target.value);
            });
        });

        // NOTE: control_number is now free text — no input formatter bound here.

        $("block")?.addEventListener("change", onBlockChange);
        $("grave_code")?.addEventListener("change", () => {
            updateSelectedSlotFromGraveSelect();
            setGraveCodeHint("");
        });
        $("burial_block")?.addEventListener("change", onBurialTypeChange);

        // Status flip:
        //   → Inactive: wipe the location (must be empty).
        //   → Active:   leave as-is, hint only if the location is partial.
        $("status")?.addEventListener("change", (e) => {
            if (e.target.value !== "Active") {
                clearLocationFields();
                setGraveCodeHint("");
                return;
            }
            const state = readLocationState();
            if (state.anyFilled && !state.allFilled) {
                setGraveCodeHint(
                    "Complete the location (Type, Block, Grave Code) or clear all of it.",
                    true
                );
            } else {
                setGraveCodeHint("");
            }
        });
    }

    // ---------- open / populate ----------
    async function open(mode = "view", data = {}, options = {}) {
        await ensureLoaded();
        if (!modalEl) return;

        currentMode = mode;
        activeRecordId = data.interment_id || data.id || null;
        takenControlNos = Array.isArray(options.takenControlNos)
            ? options.takenControlNos.map(n => String(n).trim().toUpperCase())
            : [];

        originalData = { ...data };
        selectedSlot = null;
        originalSlot = null;
        gravesToken++;
        clearBlockChangeTimer();

        modalEl.querySelector("#burial_clearance_form")?.reset();
        modalEl.classList.toggle("view-mode", mode === "view");

        ensureGraveCodeSelect();

        blocksPromise = null;
        await loadBlocks();

        const d = { ...data };
        if (mode === "add") {
            if (!d.control_number) d.control_number = generateControlNo();
            if (!d.burial_clearance_date) d.burial_clearance_date = todayISO();
            if (!d.contact_person_phone_number) d.contact_person_phone_number = "+63";
        }

        const initialBurialType = pick(d.block_type);
        const initialBlockName = pick(d.block_name);

        renderBlockOptions(initialBlockName || "", initialBurialType || "");
        resetGraveSelectUI();
        populateFields(d);
        setEditable(mode !== "view");
        ensureEditButton();
        updateActionButtons();

        const blockSelect = $("block");
        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const pinnedGraveId = pick(d.current_grave_id);
            const pinnedGraveCode = pick(d.grave_code);
            if (blockId) {
                await loadGraveOptions(blockId, blockSelect.value, pinnedGraveId, pinnedGraveCode);
            }
        } else {
            renderGraveOptions([], null);
        }

        if (mode !== "add" && selectedSlot) originalSlot = { ...selectedSlot };

        modalEl.style.display = "block";
        modalEl.classList.add("active");
    }

    function populateFields(data) {
        const src = data || {};
        const isView = currentMode === "view";

        // 1:1 fields
        FORM_FIELDS.forEach((id) => {
            const field = $(id);
            if (!field) return;

            const raw = src[id];
            const str = pick(raw);

            if (field.type === "date") {
                field.value = str ? str.slice(0, 10) : "";
                return;
            }

            if (field.tagName === "SELECT") {
                const stale = field.querySelector('option[data-placeholder="true"]');
                if (stale) stale.remove();

                let matched = Array.from(field.options).find(
                    opt => opt.value === str || opt.text === str
                );
                if (!matched && str) {
                    const lower = str.toLowerCase();
                    matched = Array.from(field.options).find(opt =>
                        opt.value.toLowerCase() === lower || opt.text.toLowerCase() === lower
                    );
                }
                if (matched) {
                    field.value = matched.value;
                } else if (str) {
                    const opt = document.createElement("option");
                    opt.value = str;
                    opt.textContent = str;
                    opt.dataset.placeholder = "true";
                    field.appendChild(opt);
                    field.value = str;
                } else {
                    field.value = "";
                    field.selectedIndex = 0;
                }
                return;
            }

            field.value = str;
        });

        // Phone needs the +63 formatting treatment
        const phoneField = $("contact_person_phone_number");
        if (phoneField) {
            const p = pick(src.contact_person_phone_number);
            phoneField.value = p ? formatPhoneValue(p) : (isView ? "" : "+63");
        }

        // Burial Type (UI-only) — derived from the joined block_type
        const mappedType = normalizeType(pick(src.block_type));
        const burialTypeSelect = $("burial_block");
        if (burialTypeSelect) {
            if (mappedType) {
                const matched = Array.from(burialTypeSelect.options).find(
                    o => o.value !== "" && normalizeType(o.value) === mappedType
                );
                burialTypeSelect.value = matched ? matched.value : "";
            } else {
                burialTypeSelect.value = "";
            }
        }

        // Block (UI-only) — make sure the joined block_name is in the list
        const blockSelect = $("block");
        if (blockSelect) {
            // Drop any dynamically pinned option from a previous render.
            const stale = blockSelect.querySelector('option[data-placeholder="true"]');
            if (stale) stale.remove();

            const blockName = pick(src.block_name);
            if (blockName) {
                const exists = Array.from(blockSelect.options).some(o => o.value === blockName);
                if (!exists) {
                    const match = blockOptions.find(b => b.name === blockName);
                    const opt = document.createElement("option");
                    opt.value = blockName;
                    opt.textContent = blockName;
                    opt.dataset.placeholder = "true";
                    if (match && match.id != null) opt.dataset.blockId = String(match.id);
                    if (match && match.type) opt.dataset.blockType = match.type;
                    blockSelect.appendChild(opt);
                }
                blockSelect.value = blockName;
            } else {
                // Inactive / no location: clear the selection.
                blockSelect.selectedIndex = 0;
            }
        }
    }

    function setEditable(editable) {
        $$("input, select, textarea").forEach((el) => {
            if (el.id === "lease_expiration_date") {
                el.disabled = true;
            } else {
                el.disabled = !editable;
            }
        });

        const controlNo = $("control_number");
        if (controlNo) controlNo.readOnly = !editable;

        updateBurialTypePlaceholder();
    }

    // ---------- submit ----------
    async function handleSubmit(e) {
        e.preventDefault();

        const phoneRaw = ($("contact_person_phone_number")?.value || "").trim();
        const phoneDigits = phoneRaw.replace(/\D/g, "").replace(/^63/, "");
        if (phoneDigits.length !== 10) {
            window.showAlertTOP(
                "Phone number must be in the format +63 XXX XXX XXXX (10 digits after +63).",
                "error"
            );
            return;
        }

        // control_number: free text. Only require that it isn't blank.
        const controlNoField = $("control_number");
        const controlNo = (controlNoField?.value || "").trim();
        if (!controlNo) {
            window.showAlertTOP("Control No. cannot be empty.", "error");
            controlNoField?.focus();
            return;
        }
        if (controlNoExists(controlNo) && !isOwnControlNo(controlNo)) {
            window.showAlertTOP(
                `Control No. "${controlNo}" is already used by another record.`,
                "error"
            );
            controlNoField?.focus();
            return;
        }

        const currentStatus = String($("status")?.value || "Active").trim();

        // Location rules:
        //   Active   → all-filled or all-empty (never partial).
        //   Inactive → all-empty (no location at all).
        updateSelectedSlotFromGraveSelect();
        const loc = readLocationState();

        if (currentStatus === "Active") {
            if (loc.anyFilled && !loc.allFilled) {
                window.showAlertTOP(
                    "Active records must have a complete location (Burial Type, Block, Grave Code) or none at all.",
                    "error"
                );
                setGraveCodeHint("Complete all location fields or clear all of them.", true);
                return;
            }
        } else {
            if (loc.anyFilled) {
                window.showAlertTOP(
                    "Inactive records must not have a location. Clear Burial Type, Block, and Grave Code.",
                    "error"
                );
                setGraveCodeHint("Inactive records must have an empty location. Please clear Burial Type, Block, and Grave Code.", true);
                return;
            }
        }

        // Build the payload 1:1 from FORM_FIELDS
        const payload = { interment_id: activeRecordId || undefined };
        FORM_FIELDS.forEach((id) => {
            const field = $(id);
            if (!field) return;
            let val = field.value;
            if (typeof val === "string") val = val.trim();
            if (val === "") val = null;
            payload[id] = val;
        });
        payload.control_number = controlNo;
        payload.status = currentStatus;

        // Grave assignment only on Active rows; Inactive always forces null.
        let finalGraveId = selectedSlot ? Number(selectedSlot.grave_id) : null;
        if (currentStatus !== "Active") finalGraveId = null;
        payload.current_grave_id = finalGraveId;

        const submitMode = currentMode;
        const saveBtn = modalEl.querySelector(".paperSaveBtn");
        if (saveBtn) saveBtn.disabled = true;

        const reEnableSave = () => {
            const btn = modalEl.querySelector(".paperSaveBtn");
            if (btn) btn.disabled = false;
        };

        document.dispatchEvent(new CustomEvent("burial_modal:save", {
            detail: {
                mode: submitMode,
                data: payload,
                onSuccess: (updatedData) => {
                    reEnableSave();
                    applySavedData(updatedData);
                },
                onError: () => {
                    reEnableSave();
                }
            }
        }));
    }

    function isOwnControlNo(value) {
        if (!originalData) return false;
        const own = String(originalData.control_number || "").trim().toUpperCase();
        return own !== "" && own === String(value || "").trim().toUpperCase();
    }

    function close() {
        if (!modalEl) return;
        modalEl.style.display = "none";
        modalEl.classList.remove("active");
        clearBlockChangeTimer();
        gravesToken++;
        selectedSlot = null;
        originalSlot = null;
        originalData = null;
        currentMode = "view";
    }

    return { open, close };
})();

window.BurialModal = BurialModal;
window.closeSeamlessModal = () => BurialModal.close();