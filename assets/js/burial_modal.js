const BurialModal = (() => {
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

    const BLOCK_CHANGE_DEBOUNCE_MS = 250;
    let blockChangeTimer = null;

    const BLOCKS_API = "api/blocks.php";
    const GRAVES_API = "api/graves.php";

    const AVAILABLE_BLOCK_STATUSES = new Set(["available", "vacant", "open", "active"]);
    const AVAILABLE_GRAVE_STATUSES = new Set(["vacant", "available", "open"]);

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

    function clearBlockChangeTimer() {
        if (blockChangeTimer) {
            clearTimeout(blockChangeTimer);
            blockChangeTimer = null;
        }
    }

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

    function normalizeType(value) {
        const s = String(value || "").trim();
        if (!s) return "";
        if (/niche|wall/i.test(s)) return "Niche Wall";
        if (/bone/i.test(s)) return "Bone Chamber";
        if (/lawn|ground|standard/i.test(s)) return "Lawn / Grounds";
        if (/unmapped/i.test(s)) return "Unmapped Area";
        if (/private|owned|mausoleum/i.test(s)) return "Private / Owned";
        return s;
    }

    function blocksMatchingType(typeLabel) {
        const norm = normalizeType(typeLabel);
        if (!norm) return blockOptions;
        return blockOptions.filter(b => normalizeType(b.type) === norm);
    }

    function setBurialTypeFromBlockType(blockType) {
        if (!modalEl) return;
        const select = modalEl.querySelector("#burial_block");
        if (!select || select.tagName !== "SELECT") return;

        const raw = String(blockType || "").trim();
        if (!raw) return;

        const norm = normalizeType(raw);

        let matched = Array.from(select.options).find(
            o => o.value !== "" && normalizeType(o.value) === norm
        );
        if (!matched) {
            matched = Array.from(select.options).find(o => o.value === raw);
        }

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

    function blockIsAvailable(b) {
        const status = String(
            (b && (b.block_status || b.status || b.availability)) || ""
        ).trim().toLowerCase();
        if (!status) return true;
        return AVAILABLE_BLOCK_STATUSES.has(status);
    }

    function fetchBlocks() {
        const url = BLOCKS_API + "?status=available";
        return fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" })
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
                        type: String((b && b.block_type) || "").trim(),
                        status: String((b && (b.block_status ?? b.status)) || "").trim()
                    }))
                    .filter(b => b.name !== "")
                    .filter(blockIsAvailable);
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
        if (!modalEl) return;
        const select = modalEl.querySelector("#block");
        if (!select) return;

        const isView = currentMode === "view";
        const current = keepValue !== undefined ? keepValue : select.value;
        const list = filterType ? blocksMatchingType(filterType) : blockOptions;

        select.innerHTML = "";

        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.disabled = true;
        placeholder.selected = true;
        if (isView) {
            placeholder.textContent = "";
        } else if (filterType && list.length === 0) {
            placeholder.textContent = "No blocks for this Burial Type";
        } else {
            placeholder.textContent = "Select Block...";
        }
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
        const url =
            `${GRAVES_API}?block_id=${encodeURIComponent(blockId)}` +
            `&status=vacant`;

        const res = await fetch(url, {
            headers: { Accept: "application/json" },
            cache: "no-store"
        });
        if (!res.ok) throw new Error("HTTP " + res.status);

        const json = await res.json();
        const data = (json && typeof json === "object" && "data" in json) ? json.data : json;
        const graves = (data && Array.isArray(data.graves)) ? data.graves : [];

        return graves.filter(g => {
            const s = String(g.status || "").trim().toLowerCase();
            if (!s) return true;
            return AVAILABLE_GRAVE_STATUSES.has(s);
        });
    }

    function ensureGraveCodeSelect() {
        if (!modalEl) return;
        const el = modalEl.querySelector("#grave_code");
        if (!el) return;
        if (el.tagName === "SELECT") return;

        const select = document.createElement("select");
        select.id = "grave_code";
        if (el.name) select.name = el.name;
        if (el.className) select.className = el.className;
        if (el.hasAttribute("required")) select.setAttribute("required", "");

        el.parentNode.replaceChild(select, el);
    }

    function renderGraveOptions(graves, selectedGraveId) {
        const select = modalEl ? modalEl.querySelector("#grave_code") : null;
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
            if (!code || id == null) continue;
            if (seen.has(code)) continue;
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
        const select = modalEl ? modalEl.querySelector("#grave_code") : null;
        if (!select) {
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
        if (!modalEl) return;
        const hint = modalEl.querySelector("#grave_code_hint");
        if (!hint) return;
        hint.textContent = message || "";
        hint.classList.toggle("error", !!isError);
        hint.classList.toggle("visible", !!message);
    }

    function resetGraveSelectUI() {
        const select = modalEl ? modalEl.querySelector("#grave_code") : null;
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
        const select = modalEl ? modalEl.querySelector("#grave_code") : null;
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

        if (!graves.length) {
            setGraveCodeHint("No available grave codes in this block.", true);
        } else {
            setGraveCodeHint("");
        }

        renderGraveOptions(graves, pinnedGraveId);
    }

    function onBlockChange() {
        const blockSelect = modalEl ? modalEl.querySelector("#block") : null;
        if (!blockSelect) return;

        const opt = blockSelect.options[blockSelect.selectedIndex];
        const blockId = opt ? opt.dataset.blockId : null;
        const blockName = (blockSelect.value || "").trim();
        const blockType = opt ? (opt.dataset.blockType || "") : "";

        if (blockName && blockType) {
            setBurialTypeFromBlockType(blockType);
        }

        resetGraveSelectUI();

        if (!blockId || !blockName) {
            renderGraveOptions([], null);
            setGraveCodeHint("");
            return;
        }

        let pinnedGraveId = null;
        let pinnedGraveCode = null;
        if (originalData && originalData.current_grave_id) {
            const origBlockName = pick(originalData.block, originalData.blockName, originalData.block_name);
            if (origBlockName === blockName) {
                pinnedGraveId = pick(originalData.current_grave_id, originalData.grave_id);
                pinnedGraveCode = pick(originalData.grave_code, originalData.graveCode);
            }
        }

        clearBlockChangeTimer();
        blockChangeTimer = setTimeout(() => {
            blockChangeTimer = null;
            loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
        }, BLOCK_CHANGE_DEBOUNCE_MS);
    }

    function onBurialTypeChange() {
        if (!modalEl) return;

        const burialTypeSelect = modalEl.querySelector("#burial_block");
        const burialType = burialTypeSelect ? (burialTypeSelect.value || "") : "";

        const blockSelect = modalEl.querySelector("#block");
        if (blockSelect) blockSelect.value = "";

        resetGraveSelectUI();

        renderBlockOptions("", burialType);

        updateBurialTypePlaceholder();
    }

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

    function ensureEditButton() {
        if (!modalEl) return;
        const actions = modalEl.querySelector(".paperFormActions");
        if (!actions) return;
        if (actions.querySelector(".paperEditBtn")) return;

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
        if (!modalEl) return;
        const saveBtn = modalEl.querySelector(".paperSaveBtn");
        const cancelBtn = modalEl.querySelector(".paperCancelBtn");
        const editBtn = modalEl.querySelector(".paperEditBtn");

        const isView = currentMode === "view";
        const isEdit = currentMode === "edit";
        const isAdd = currentMode === "add";

        if (saveBtn) saveBtn.style.display = (isEdit || isAdd) ? "inline-block" : "none";
        if (editBtn) editBtn.style.display = isView ? "inline-block" : "none";
        if (cancelBtn) {
            cancelBtn.textContent = "Cancel";
            cancelBtn.style.display = "inline-block";
        }
    }

    function currentBurialTypeValue() {
        const select = modalEl ? modalEl.querySelector("#burial_block") : null;
        return select ? (select.value || "") : "";
    }

    function currentBlockValue() {
        const select = modalEl ? modalEl.querySelector("#block") : null;
        return select ? (select.value || "") : "";
    }

    function enterEditMode() {
        if (!modalEl) return;
        if (currentMode !== "view") return;

        currentMode = "edit";
        modalEl.classList.remove("view-mode");
        setEditable(true);
        updateActionButtons();

        const blockSelect = modalEl.querySelector("#block");
        if (blockSelect) {
            const currentBlockName = blockSelect.value || "";
            const burialType = currentBurialTypeValue();
            renderBlockOptions(currentBlockName, burialType);
        }

        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const blockName = blockSelect.value;
            const pinnedGraveId = originalData ? pick(originalData.current_grave_id, originalData.grave_id) : null;
            const pinnedGraveCode = originalData ? pick(originalData.grave_code, originalData.graveCode) : null;
            if (blockId) {
                loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
            }
        } else {
            resetGraveSelectUI();
        }
    }

    function cancelEdit() {
        if (!modalEl) return;
        if (currentMode !== "edit") return;

        currentMode = "view";
        modalEl.classList.add("view-mode");

        clearBlockChangeTimer();
        gravesToken++;
        selectedSlot = originalSlot ? { ...originalSlot } : null;

        if (originalData) {
            populateFields(originalData);
        }

        renderBlockOptions(currentBlockValue(), currentBurialTypeValue());

        setEditable(false);
        updateActionButtons();

        const blockSelect = modalEl.querySelector("#block");
        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const blockName = blockSelect.value;
            const pinnedGraveId = originalData ? pick(originalData.current_grave_id, originalData.grave_id) : null;
            const pinnedGraveCode = originalData ? pick(originalData.grave_code, originalData.graveCode) : null;
            if (blockId) {
                loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
            }
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

            const newGraveId = Number(pick(updatedData.current_grave_id, updatedData.grave_id)) || null;
            const newGraveCode = pick(updatedData.grave_code, updatedData.graveCode);
            if (newGraveId) {
                selectedSlot = {
                    grave_id: newGraveId,
                    grave_code: newGraveCode,
                    row_num: pick(updatedData.row_num) || null,
                    col_num: pick(updatedData.col_num) || null
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

        const blockSelect = modalEl.querySelector("#block");
        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const blockName = blockSelect.value;
            const pinnedGraveId = originalData ? pick(originalData.current_grave_id, originalData.grave_id) : null;
            const pinnedGraveCode = originalData ? pick(originalData.grave_code, originalData.graveCode) : null;
            if (blockId) {
                loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
            }
        } else {
            renderBlockOptions("", currentBurialTypeValue());
            resetGraveSelectUI();
        }
    }

    function handleCancelClick() {
        if (currentMode === "edit") {
            cancelEdit();
        } else {
            close();
        }
    }

    function bindEvents() {
        if (!modalEl || modalEl.dataset.bound === "true") return;
        modalEl.dataset.bound = "true";

        const cancelBtn = modalEl.querySelector(".paperCancelBtn");
        if (cancelBtn) cancelBtn.addEventListener("click", handleCancelClick);

        modalEl.addEventListener("click", (e) => {
            if (e.target !== modalEl) return;
            handleCancelClick();
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
            blockSelect.addEventListener("change", onBlockChange);
        }

        const graveSelect = modalEl.querySelector("#grave_code");
        if (graveSelect) {
            graveSelect.addEventListener("change", () => {
                updateSelectedSlotFromGraveSelect();
                setGraveCodeHint("");
            });
        }

        const burialTypeSelect = modalEl.querySelector("#burial_block");
        if (burialTypeSelect) {
            burialTypeSelect.addEventListener("change", onBurialTypeChange);
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

        originalData = { ...data };
        selectedSlot = null;
        originalSlot = null;
        gravesToken++;
        clearBlockChangeTimer();

        const form = modalEl.querySelector("#burial_clearance_form");
        if (form) form.reset();

        modalEl.classList.toggle("view-mode", mode === "view");

        ensureGraveCodeSelect();

        blocksPromise = null;
        await loadBlocks();

        const d = { ...data };
        if (mode === "add") {
            if (!pick(d.control_no, d.controlNo)) d.control_no = generateControlNo();
            if (!pick(d.clearance_date, d.clearanceDate)) d.clearance_date = todayISO();
            if (!pick(d.req_phone, d.contactPhone)) d.req_phone = "+63";
        }

        const initialBurialType = pick(
            d.burialType,
            d.burial_type,
            d.burial_block,
            d.block_type
        );
        const initialBlockName = pick(d.block, d.blockName, d.block_name);

        renderBlockOptions(initialBlockName || "", initialBurialType || "");
        resetGraveSelectUI();

        populateFields(d);
        setEditable(mode !== "view");
        ensureEditButton();
        updateActionButtons();

        const blockSelect = modalEl.querySelector("#block");
        if (blockSelect && blockSelect.value) {
            const opt = blockSelect.options[blockSelect.selectedIndex];
            const blockId = opt ? opt.dataset.blockId : null;
            const blockName = blockSelect.value;
            const pinnedGraveId = pick(d.current_grave_id, d.grave_id);
            const pinnedGraveCode = pick(d.grave_code, d.graveCode);
            if (blockId) {
                await loadGraveOptions(blockId, blockName, pinnedGraveId, pinnedGraveCode);
            }
        } else {
            renderGraveOptions([], null);
        }

        if (mode !== "add" && selectedSlot) {
            originalSlot = { ...selectedSlot };
        }

        modalEl.style.display = "block";
        modalEl.classList.add("active");
    }

    function populateFields(data) {
        const isView = currentMode === "view";
        const src = data || {};
        const consumed = new Set();

        const setFieldValue = (id, val) => {
            const field = modalEl.querySelector(`#${id}`);
            if (!field) return;
            consumed.add(id);

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
                        opt.text.toLowerCase() === lower
                    );
                }
                if (matched) {
                    field.value = matched.value;
                } else if (strVal) {
                    const opt = document.createElement("option");
                    opt.value = strVal;
                    opt.textContent = strVal;
                    opt.dataset.placeholder = "true";
                    field.appendChild(opt);
                    field.value = strVal;
                } else {
                    field.value = "";
                    field.selectedIndex = 0;
                }
                return;
            }

            if (field.type === "date") {
                field.value = strVal ? strVal.slice(0, 10) : "";
                return;
            }

            field.value = strVal;
        };

        setFieldValue("clearance_date", pick(src.clearance_date, src.clearanceDate, src.control_date, src.burial_clearance_date));
        setFieldValue("control_no", pick(src.control_no, src.controlNo, src.control_number));

        setFieldValue("req_name", pick(src.req_name, src.contactName, src.applicant_full_name, src.contact_person_name));

        const rawPhone = pick(src.req_phone, src.contactPhone, src.phone_number, src.contact_person_phone_number);
        if (rawPhone) {
            setFieldValue("req_phone", formatPhoneValue(rawPhone));
        } else {
            setFieldValue("req_phone", isView ? "" : "+63");
        }

        setFieldValue(
            "req_email",
            pick(src.req_email, src.contact_person_email, src.contactEmail, src.email)
        );

        const rawBrgy = pick(
            src.requesting_barangay,
            src.barangay,
            src.barangay_address,
            src.contact_person_address_barangay
        );
        setFieldValue("requesting_barangay", rawBrgy.replace(/^(Barangay|Brgy\.)\s*/i, "").trim());

        if (pick(src.purokStreet, src.purok_zone_street)) {
            setFieldValue("req_street", pick(src.purokStreet, src.purok_zone_street));
        } else if (pick(src.contactAddress, src.req_street, src.contact_person_address)) {
            const parts = pick(src.contactAddress, src.req_street, src.contact_person_address).split(",");
            setFieldValue("req_street", parts[0].trim());
        } else {
            setFieldValue("req_street", "");
        }

        const rawAssist = pick(src.assistance, src.assistance_type, src.req_assistance);
        let mappedAssist = rawAssist;
        if (/burial/i.test(rawAssist)) mappedAssist = "Burial of the late";
        else if (/transfer|exhumation/i.test(rawAssist))
            mappedAssist = "Transfer the remains of the late to the bone chamber";
        else if (/^other/i.test(rawAssist)) mappedAssist = "Other...";
        setFieldValue("req_assistance", mappedAssist);

        setFieldValue("deceased_name", pick(src.deceased_name, src.name));
        setFieldValue("deceased_sex", pick(src.deceased_sex, src.sex));
        setFieldValue("deceased_dob", pick(src.deceased_dob, src.dob, src.deceased_date_of_birth));
        setFieldValue("deceased_bod", pick(src.deceased_bod, src.dod, src.deceased_date_of_death));
        setFieldValue("deceased_address", pick(src.deceased_address, src.address, src.last_known_address));
        setFieldValue("deceased_cert", pick(src.deceased_cert, src.certNo, src.death_certificate, src.death_certificate_no));

        setFieldValue("permit_burial", pick(src.permit_burial, src.permitBurial, src.burial_permit_no, src.burial_permit_number));
        setFieldValue("permit_exhumation", pick(src.permit_exhumation, src.permitExhumation, src.exhumation_permit_no, src.exhumation_permit_number));
        setFieldValue("permit_transfer", pick(src.permit_transfer, src.permitTransfer, src.transfer_permit_no, src.transfer_permit_number));

        const rawType = pick(src.burialType, src.burial_type, src.burial_block, src.block_type);
        const mappedType = normalizeType(rawType);
        setFieldValue("burial_block", mappedType);

        setFieldValue("block", pick(src.block, src.blockName, src.block_name));

        consumed.add("grave_code");

        setFieldValue("date_interment", pick(src.date_interment, src.dateInterment, src.date_of_interment, src.date_buried));
        setFieldValue("expiration_date", pick(src.expiration_date, src.expiration, src.lease_expiration_date));
        setFieldValue("status", pick(src.status, "Active"));
        setFieldValue("deceased_remarks", pick(src.deceased_remarks, src.remarks));

        const allFields = modalEl.querySelectorAll("input[id], select[id], textarea[id]");
        allFields.forEach((field) => {
            if (consumed.has(field.id)) return;
            if (field.type === "hidden") return;
            if (field.id === "grave_code") return;
            if (field.id === "block") return;
            if (field.id === "burial_block") return;

            const raw = src[field.id];
            if (raw === undefined || raw === null || raw === "") return;

            if (field.tagName === "SELECT") {
                const val = String(raw);
                let matched = Array.from(field.options).find(
                    opt => opt.value === val || opt.text === val
                );
                if (!matched) {
                    const opt = document.createElement("option");
                    opt.value = val;
                    opt.textContent = val;
                    field.appendChild(opt);
                    matched = opt;
                }
                field.value = matched.value;
            } else if (field.type === "date") {
                field.value = String(raw).slice(0, 10);
            } else {
                field.value = String(raw);
            }
        });
    }

    function updateBurialTypePlaceholder() {
        if (!modalEl) return;
        const select = modalEl.querySelector("#burial_block");
        if (!select || select.tagName !== "SELECT") return;
        if (!select.options.length) return;

        const placeholder = select.options[0];

        if (burialTypePlaceholderText === null) {
            const original = (placeholder.textContent || "").trim();
            burialTypePlaceholderText = original || "Select Burial Type";
        }

        const isView = currentMode === "view";
        const hasValue = !!select.value;

        placeholder.textContent =
            (isView && !hasValue) ? "" : burialTypePlaceholderText;
    }

    function setEditable(editable) {
        const inputs = modalEl.querySelectorAll("input, select, textarea");
        inputs.forEach((el) => {
            if (el.id === "expiration_date") {
                el.disabled = true;
            } else if (el.id === "grave_code") {
                el.disabled = !editable;
            } else {
                el.disabled = !editable;
            }
        });

        const controlNo = modalEl.querySelector("#control_no");
        if (controlNo) {
            controlNo.readOnly = !editable;
        }

        updateBurialTypePlaceholder();
    }

    async function handleSubmit(e) {
        e.preventDefault();

        const phoneRaw = modalEl.querySelector("#req_phone")?.value.trim() || "";
        const phoneDigits = phoneRaw.replace(/\D/g, "").replace(/^63/, "");
        if (phoneDigits.length !== 10) {
            if (typeof window.showAlertTOP === "function") {
                window.showAlertTOP(
                    "Phone number must be in the format +63 XXX XXX XXXX (10 digits after +63).",
                    "error"
                );
            }
            return;
        }

        const controlNoField = modalEl.querySelector("#control_no");
        const controlNo = (controlNoField?.value || "").trim().toUpperCase();

        if (!/^CTRL-\d{4}-\d{3}$/.test(controlNo)) {
            if (typeof window.showAlertTOP === "function") {
                window.showAlertTOP(
                    "Control No. must follow the format CTRL-YYYY-NNN (e.g., CTRL-2026-001).",
                    "error"
                );
            }
            controlNoField?.focus();
            return;
        }
        if (controlNoExists(controlNo)) {
            if (typeof window.showAlertTOP === "function") {
                window.showAlertTOP(
                    `Control No. "${controlNo}" is already used by another record.`,
                    "error"
                );
            }
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
            if (typeof window.showAlertTOP === "function") {
                window.showAlertTOP("Please select a Block.", "error");
            }
            blockField?.focus();
            return;
        }

        updateSelectedSlotFromGraveSelect();

        const graveSelect = modalEl.querySelector("#grave_code");
        const graveCode = (graveSelect?.value || "").trim();

        if (!graveCode || !selectedSlot || !selectedSlot.grave_id) {
            if (typeof window.showAlertTOP === "function") {
                window.showAlertTOP(
                    "Please select a Grave Code for this block.",
                    "error"
                );
            }
            graveSelect?.focus();
            return;
        }

        if (currentMode === "edit" && originalData) {
            const originalStatus = String(originalData.status || "").trim();
            const currentStatus = String(
                modalEl.querySelector("#status")?.value || "Active"
            ).trim();

            const isInactiveOriginal = originalStatus === "Inactive";
            const isStillInactive = currentStatus !== "Active";

            if (isInactiveOriginal && isStillInactive) {
                const originalBlockName = pick(
                    originalData.block,
                    originalData.blockName,
                    originalData.block_name
                );
                const originalGraveId =
                    Number(pick(originalData.current_grave_id, originalData.grave_id)) || 0;
                const newGraveId = Number(selectedSlot.grave_id) || 0;

                const blockChanged =
                    String(originalBlockName).trim() !== String(blockName).trim();
                const graveChanged = originalGraveId !== newGraveId;

                if (blockChanged || graveChanged) {
                    if (typeof window.showAlertTOP === "function") {
                        window.showAlertTOP(
                            "Please activate the record before assigning a Block and Grave Code.",
                            "warning"
                        );
                    } else {
                        console.warn(
                            "Please activate the record before assigning a Block and Grave Code."
                        );
                    }
                    return;
                }
            }
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
            contact_person_email: modalEl.querySelector("#req_email")?.value.trim() || "",
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

            status: modalEl.querySelector("#status")?.value || "Active"
        };

        const submitMode = currentMode;
        const saveBtn = modalEl.querySelector(".paperSaveBtn");
        if (saveBtn) saveBtn.disabled = true;

        const reEnableSave = () => {
            if (!modalEl) return;
            const btn = modalEl.querySelector(".paperSaveBtn");
            if (btn) btn.disabled = false;
        };

        document.dispatchEvent(new CustomEvent("burial_modal:save", {
            detail: {
                mode: submitMode,
                data: payload,
                onSuccess: (updatedData) => {
                    reEnableSave();
                    if (submitMode === "add") {
                        close();
                    } else {
                        applySavedData(updatedData);
                    }
                },
                onError: () => {
                    reEnableSave();
                }
            }
        }));
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