const ReserveBurialModal = (() => {
  let modalEl = null;
  let loadPromise = null;
  let currentMode = "view";

  let activeGraveId = null;
  let activeOldIntermentId = null;
  let activeOriginalValues = {};

  let takenControlNos = [];

  let addOriginalBlock = "";
  let addOriginalGraveCode = "";
  let addOriginalGraveId = null;
  let addOriginalOldIntermentId = null;

  let viewSnapshot = {};
  let burialTypePlaceholderText = null;

  const ADD_READONLY_FIELDS = ["block", "grave_code", "status", "burial_block"];
  const LEASE_YEARS = 5;

  let blocksPromise = null;
  let blockOptions = [];
  let selectedSlot = null;

  let blockChangeTimer = null;
  let gravesToken = 0;

  const BLOCK_CHANGE_DEBOUNCE_MS = 250;
  const BLOCKS_API = "api/blocks.php";
  const GRAVES_API = "api/graves.php";

  // ---------- wizard state ----------
  let wizardMode = null;
  let oldOccupantOriginal = null;
  let oldModeSnapshot = null;
  let newModeSnapshot = null;
  let oldTargetContext = null;
  let locationHeaderEl = null;
  let nextBtn = null;
  let backBtn = null;

  // ---------- post-success lock ----------
  let submissionSucceeded = false;

  // ==================================================================
  // utilities
  // ==================================================================
  function warn(message) {
    if (!message) return;
    if (typeof window.showAlertTOP === "function") {
      window.showAlertTOP(String(message), "warning");
      return;
    }
    console.warn("[reserve_modal]", message);
  }

  function pick(...values) {
    for (const v of values) {
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (s !== "" && s !== "N/A") return s;
    }
    return "";
  }

  function sliceDate(val) {
    if (val === null || val === undefined) return "";
    const s = String(val).trim();
    if (!s) return "";
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
    return m ? m[1] : s;
  }

  function controlNoExists(value) {
    const v = String(value || "")
      .trim()
      .toUpperCase();
    return takenControlNos.some((n) => String(n).trim().toUpperCase() === v);
  }

  function isOwnControlNo(value) {
    if (!viewSnapshot) return false;
    const own = String(
      viewSnapshot.control_number || viewSnapshot.control_no || "",
    )
      .trim()
      .toUpperCase();
    return (
      own !== "" &&
      own ===
        String(value || "")
          .trim()
          .toUpperCase()
    );
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

  function controlNoField() {
    if (!modalEl) return null;
    return (
      modalEl.querySelector("#control_number") ||
      modalEl.querySelector("#control_no") ||
      modalEl.querySelector('[name="control_number"]') ||
      modalEl.querySelector('[name="control_no"]')
    );
  }

  function todayISO() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().split("T")[0];
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

  function addYearsISO(isoDate, years) {
    if (!isoDate) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate).trim());
    if (!m) return "";
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12) return "";
    if (d < 1 || d > 31) return "";
    const probe = new Date(y, mo - 1, d);
    if (
      probe.getFullYear() !== y ||
      probe.getMonth() !== mo - 1 ||
      probe.getDate() !== d
    )
      return "";
    const tY = y + years;
    const tM = mo - 1;
    const lastDay = new Date(tY, tM + 1, 0).getDate();
    const tD = Math.min(d, lastDay);
    const r = new Date(tY, tM, tD);
    const yy = r.getFullYear();
    const mm = String(r.getMonth() + 1).padStart(2, "0");
    const dd = String(r.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  const INTERMENT_FIELD_IDS = ["date_buried", "date_interment"];
  const EXPIRATION_FIELD_IDS = ["lease_expiration_date", "expiration_date"];

  function getIntermentField() {
    if (!modalEl) return null;
    for (const id of INTERMENT_FIELD_IDS) {
      const el = modalEl.querySelector("#" + id);
      if (el) return el;
    }
    return null;
  }

  function getExpirationField() {
    if (!modalEl) return null;
    for (const id of EXPIRATION_FIELD_IDS) {
      const el = modalEl.querySelector("#" + id);
      if (el) return el;
    }
    return null;
  }

  function recalcExpirationFromInterment() {
    if (!modalEl) return;
    const intermentInput = getIntermentField();
    const expirationInput = getExpirationField();
    if (!intermentInput || !expirationInput) return;
    const raw = (intermentInput.value || "").trim();
    expirationInput.value = raw ? addYearsISO(raw, LEASE_YEARS) : "";
  }

  function detectMode(data) {
    if (!data || typeof data !== "object") return "add";
    const type = String(data.type || "").toLowerCase();
    if (type === "expired" || type === "expiring") return "view";
    if (data.interment_id && type !== "vacant") return "view";
    return "add";
  }

  function normalizeType(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    if (/niche|wall/i.test(s)) return "Niche";
    if (/bone/i.test(s)) return "Bone Chamber";
    if (/lawn|ground|standard/i.test(s)) return "Lawn/Grounds";
    if (/unmapped/i.test(s)) return "Unmapped Area";
    if (/private|owned/i.test(s)) return "Private";
    if (/mausoleum/i.test(s)) return "Mausoleum";
    if (/mass/i.test(s)) return "Mass Grave";
    if (/cluster/i.test(s)) return "Cluster";
    if (/^block\b/i.test(s)) return "Block";
    return s;
  }

  function blocksMatchingType(typeLabel) {
    const norm = normalizeType(typeLabel);
    if (!norm) return blockOptions;
    return blockOptions.filter((b) => normalizeType(b.type) === norm);
  }

  function currentBurialType() {
    const select = modalEl ? modalEl.querySelector("#burial_block") : null;
    return select ? select.value || "" : "";
  }

  function setBurialTypeFromBlockType(blockType) {
    if (!modalEl) return;
    const select = modalEl.querySelector("#burial_block");
    if (!select || select.tagName !== "SELECT") return;
    const raw = String(blockType || "").trim();
    if (!raw) {
      select.value = "";
      return;
    }
    const norm = normalizeType(raw);

    let matched = Array.from(select.options).find(
      (o) => o.value !== "" && normalizeType(o.value) === norm,
    );
    if (!matched)
      matched = Array.from(select.options).find((o) => o.value === raw);
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
    const isReadOnly = currentMode === "view" && wizardMode !== "old";
    const hasValue = !!select.value;
    placeholder.textContent =
      isReadOnly && !hasValue ? "" : burialTypePlaceholderText;
  }

  function selectGraveByCode(code, graveId) {
    if (!code) return;
    const select = modalEl?.querySelector("#grave_code");
    if (!select) return;

    let opt = Array.from(select.options).find((o) => o.value === code);
    if (!opt) {
      opt = document.createElement("option");
      opt.value = code;
      opt.textContent = code;
      if (graveId != null) opt.dataset.graveId = String(graveId);
      opt.dataset.pinned = "true";
      select.appendChild(opt);
    } else if (graveId != null && !opt.dataset.graveId) {
      opt.dataset.graveId = String(graveId);
    }

    select.value = code;
    updateSelectedSlotFromGraveSelect();
  }

  // ------------------------------------------------------------------
  // Apply burial type from a snapshot value. FIX: no fallback —
  // snapshot is the source of truth. Empty snapshot = empty dropdown.
  // ------------------------------------------------------------------
  function applyBurialTypeFromSnapshot(snapshotValue) {
    const typeEl = modalEl?.querySelector("#burial_block");
    if (!typeEl) return;

    const raw = pick(snapshotValue);
    if (raw) {
      setBurialTypeFromBlockType(raw);
    } else {
      typeEl.value = "";
    }
  }

  // ------------------------------------------------------------------
  // Bulletproof field restore for old occupant.
  // ------------------------------------------------------------------
  function forceRestoreOldOccupantFields() {
    if (!modalEl) return;
    const src = oldOccupantOriginal || {};
    const snap = oldModeSnapshot || {};

    const V = (key) => {
      if (key in snap && snap[key] !== "" && snap[key] != null)
        return snap[key];
      return src[key];
    };

    const setOne = (id, val) => {
      const el = modalEl.querySelector("#" + id);
      if (!el) return;
      el.value = val === null || val === undefined ? "" : String(val);
    };
    const setOneDate = (id, val) => setOne(id, sliceDate(val));

    const cField = controlNoField();
    if (cField) cField.value = pick(src.control_number, src.control_no);

    setOneDate("burial_clearance_date", V("burial_clearance_date"));
    setOneDate("deceased_date_of_birth", V("deceased_date_of_birth"));
    setOneDate("deceased_date_of_death", V("deceased_date_of_death"));
    setOneDate("burial_permit_date", V("burial_permit_date"));
    setOneDate("transfer_permit_date", V("transfer_permit_date"));
    setOneDate("exhumation_permit_date", V("exhumation_permit_date"));
    setOneDate("date_buried", V("date_buried"));
    setOneDate("lease_expiration_date", V("lease_expiration_date"));

    setOne("contact_person_name", V("contact_person_name"));
    setOne("contact_person_email", V("contact_person_email"));
    const rawPhone = V("contact_person_phone_number");
    setOne(
      "contact_person_phone_number",
      rawPhone ? formatPhoneValue(rawPhone) : "+63",
    );
    setOne("contact_person_address", V("contact_person_address"));
    setOne(
      "contact_person_address_barangay",
      pick(V("contact_person_address_barangay"))
        .replace(/^(Barangay|Brgy\.\s*)/i, "")
        .trim(),
    );

    const rawAssist = pick(V("assistance_type"));
    let mappedAssist = rawAssist;
    if (/burial/i.test(rawAssist)) mappedAssist = "Burial";
    else if (/transfer|exhumation/i.test(rawAssist))
      mappedAssist = "Transfer the remains of the late";
    else if (/^other/i.test(rawAssist)) mappedAssist = "Other";
    setOne("assistance_type", mappedAssist);

    setOne("deceased_name", V("deceased_name"));
    setOne("deceased_sex", V("deceased_sex"));
    setOne("last_known_address", V("last_known_address"));
    setOne("death_certificate", V("death_certificate"));

    setOne("burial_permit_number", V("burial_permit_number"));
    setOne("transfer_permit_number", V("transfer_permit_number"));
    setOne("transfer_permit_issued_by", V("transfer_permit_issued_by"));
    setOne("exhumation_permit_number", V("exhumation_permit_number"));

    setOne("remarks", pick(V("remarks"), V("interment_remarks")));

    setOne("status", V("status") || "Active");

    // FIX: no fallback. If snapshot's burial_block is empty (e.g.
    // user set O to Inactive), leave the dropdown empty.
    applyBurialTypeFromSnapshot(snap.burial_block);
  }

  // ------------------------------------------------------------------
  // Bulletproof field restore for new occupant.
  // ------------------------------------------------------------------
  function forceRestoreNewOccupantFields() {
    if (!modalEl) return;
    const snap = newModeSnapshot || {};

    const setOne = (id, val) => {
      const el = modalEl.querySelector("#" + id);
      if (!el) return;
      el.value = val === null || val === undefined ? "" : String(val);
    };
    const setOneDate = (id, val) => setOne(id, sliceDate(val));

    if (!Object.keys(snap).length) return;

    setOne("contact_person_name", snap.contact_person_name);
    setOne("contact_person_email", snap.contact_person_email);
    const rawPhone = snap.contact_person_phone_number;
    setOne(
      "contact_person_phone_number",
      rawPhone ? formatPhoneValue(rawPhone) : "+63",
    );
    setOne("contact_person_address", snap.contact_person_address);
    setOne(
      "contact_person_address_barangay",
      snap.contact_person_address_barangay,
    );
    setOne("assistance_type", snap.assistance_type || "Burial");

    setOne("deceased_name", snap.deceased_name);
    setOne("deceased_sex", snap.deceased_sex);
    setOneDate("deceased_date_of_birth", snap.deceased_date_of_birth);
    setOneDate("deceased_date_of_death", snap.deceased_date_of_death);
    setOne("last_known_address", snap.last_known_address);
    setOne("death_certificate", snap.death_certificate);

    setOne("burial_permit_number", snap.burial_permit_number);
    setOneDate("burial_permit_date", snap.burial_permit_date);
    setOne("transfer_permit_number", snap.transfer_permit_number);
    setOne("transfer_permit_issued_by", snap.transfer_permit_issued_by);
    setOneDate("transfer_permit_date", snap.transfer_permit_date);
    setOne("exhumation_permit_number", snap.exhumation_permit_number);
    setOneDate("exhumation_permit_date", snap.exhumation_permit_date);

    setOneDate("burial_clearance_date", snap.burial_clearance_date);
    setOneDate("date_buried", snap.date_buried);
    setOneDate("lease_expiration_date", snap.lease_expiration_date);
    setOne("remarks", snap.remarks);

    const cField = controlNoField();
    if (cField) cField.value = pick(snap.control_number);

    setOne("status", snap.status || "Pending");

    // FIX: snapshot only. If user set N to Inactive, burial type stays empty.
    applyBurialTypeFromSnapshot(snap.burial_block);
  }

  // ------------------------------------------------------------------
  // Header helpers.
  // ------------------------------------------------------------------
  function refreshOldOccupantHeader() {
    if (!modalEl) return;
    const nameEl = modalEl.querySelector("#deceased_name");
    const fromField = (nameEl?.value || "").trim();
    const name =
      fromField ||
      pick(
        oldOccupantOriginal?.deceased_name,
        oldModeSnapshot?.deceased_name,
      ) ||
      "this occupant";

    const srcBlock = pick(
      oldOccupantOriginal?.block_name,
      activeOriginalValues.block_name,
    );
    const srcGrave = pick(
      oldOccupantOriginal?.grave_code,
      activeOriginalValues.grave_code,
    );
    const info =
      srcBlock || srcGrave ? `${srcBlock || "—"} / ${srcGrave || "—"}` : "";

    updateLocationHeaderText(name, info);
  }

  function refreshNewOccupantHeader() {
    if (!modalEl) return;
    const nameEl = modalEl.querySelector("#deceased_name");
    const fromField = (nameEl?.value || "").trim();
    const name =
      fromField ||
      pick(newModeSnapshot?.deceased_name) ||
      "the incoming person";
    updateLocationHeaderText(name, "");
  }

  // ------------------------------------------------------------------
  // STATUS OPTIONS
  // ------------------------------------------------------------------
  function removePendingFromStatus() {
    if (!modalEl) return;
    const sel = modalEl.querySelector("#status");
    if (!sel || sel.tagName !== "SELECT") return;
    Array.from(sel.options).forEach((o) => {
      if (String(o.value).toLowerCase() === "pending") o.remove();
    });
    if (String(sel.value).toLowerCase() === "pending") sel.value = "Inactive";
  }

  function ensurePendingInStatus() {
    if (!modalEl) return;
    const sel = modalEl.querySelector("#status");
    if (!sel || sel.tagName !== "SELECT") return;
    const hasPending = Array.from(sel.options).some(
      (o) => String(o.value).toLowerCase() === "pending",
    );
    if (hasPending) return;
    const opt = document.createElement("option");
    opt.value = "Pending";
    opt.textContent = "Pending";
    sel.appendChild(opt);
  }

  function syncStatusOptionsForWizard() {
    if (wizardMode === "new") ensurePendingInStatus();
    else removePendingFromStatus();
  }

  async function handleStatusChange() {
    if (!modalEl) return;
    const statusSelect = modalEl.querySelector("#status");
    if (!statusSelect) return;

    if (wizardMode === "old") {
      if (statusSelect.value !== "Active") {
        const blockEl = modalEl.querySelector("#block");
        if (blockEl) blockEl.value = "";
        const graveEl = modalEl.querySelector("#grave_code");
        if (graveEl) graveEl.value = "";
        resetGraveSelectUI();
        const typeEl = modalEl.querySelector("#burial_block");
        if (typeEl) typeEl.value = "";
      } else {
        await loadBlocks();
        renderBlockOptions("");
      }
      updateBurialTypePlaceholder();
      return;
    }

    if (statusSelect.value === "Inactive") {
      const blockEl = modalEl.querySelector("#block");
      if (blockEl) blockEl.value = "";
      const burialTypeEl = modalEl.querySelector("#burial_block");
      if (burialTypeEl) burialTypeEl.selectedIndex = 0;
      resetGraveSelectUI();
      updateBurialTypePlaceholder();
      return;
    }
    resetGraveSelectUI();
    await loadBlocks();
    renderBlockOptions("");
    updateBurialTypePlaceholder();
  }

  function guardBlockGraveWhenInactive(event) {
    if (!modalEl) return;
    if (wizardMode === "old") return;
    if (currentMode !== "view") return;
    if (event && typeof event.preventDefault === "function")
      event.preventDefault();
    if (event && typeof event.stopPropagation === "function")
      event.stopPropagation();
  }

  function clearBlockChangeTimer() {
    if (blockChangeTimer) {
      clearTimeout(blockChangeTimer);
      blockChangeTimer = null;
    }
  }

  async function fetchBlocks() {
    const res = await fetch(BLOCKS_API, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    return json.data;
  }

  async function loadBlocks() {
    if (blocksPromise) return blocksPromise;
    blocksPromise = (async () => {
      try {
        const list = await fetchBlocks();
        blockOptions = list
          .map((block) => ({
            id:
              block && (block.block_id ?? block.id) != null
                ? (block.block_id ?? block.id)
                : null,
            name: String(
              (block && (block.block_name ?? block.name)) || "",
            ).trim(),
            type: String((block && block.block_type) || "").trim(),
            status: String(
              (block && (block.block_status ?? block.status)) || "",
            ).trim(),
          }))
          .filter((b) => b.name !== "");
      } catch (err) {
        console.warn("[reserve_modal] Unable to load blocks:", err);
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
    if (!select || select.tagName !== "SELECT") return;

    const isView = currentMode === "view" && wizardMode !== "old";
    const current = keepValue !== undefined ? keepValue : select.value;
    const list = filterType ? blocksMatchingType(filterType) : blockOptions;

    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    if (isView) placeholder.textContent = "";
    else if (filterType && list.length === 0)
      placeholder.textContent = "No blocks for this Burial Type";
    else placeholder.textContent = "Select Block...";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);

    list.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.name;
      opt.textContent = b.name;
      if (b.id != null) opt.dataset.blockId = String(b.id);
      if (b.type) opt.dataset.blockType = b.type;
      select.appendChild(opt);
    });

    if (current) {
      const exists = Array.from(select.options).some(
        (o) => o.value === current,
      );
      if (!exists) {
        const match = blockOptions.find((b) => b.name === current);
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

  async function fetchGravesForBlock(blockId) {
    const url = `${GRAVES_API}?block_id=${encodeURIComponent(blockId)}&status=vacant`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const data =
      json && typeof json === "object" && "data" in json ? json.data : json;
    return data && Array.isArray(data.graves) ? data.graves : [];
  }

  function renderGraveOptions(graves, selectedGraveId) {
    const select = modalEl ? modalEl.querySelector("#grave_code") : null;
    if (!select || select.tagName !== "SELECT") return;

    const isView = currentMode === "view" && wizardMode !== "old";
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = isView
      ? ""
      : graves.length
        ? "Select Grave Code..."
        : "No available grave codes";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);

    const seen = new Set();
    for (const g of graves || []) {
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
        (o) => o.dataset.graveId && Number(o.dataset.graveId) === selId,
      );
      if (match) select.value = match.value;
    }
    updateSelectedSlotFromGraveSelect();
  }

  function updateSelectedSlotFromGraveSelect() {
    const select = modalEl ? modalEl.querySelector("#grave_code") : null;
    if (!select || select.tagName !== "SELECT") {
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
    const hint = modalEl.querySelector("#grave_code_hint");
    if (!hint) return;
    hint.textContent = message || "";
    hint.classList.toggle("error", !!isError);
    hint.classList.toggle("visible", !!message);
  }

  function resetGraveSelectUI() {
    const select = modalEl ? modalEl.querySelector("#grave_code") : null;
    if (!select || select.tagName !== "SELECT") return;
    const isView = currentMode === "view" && wizardMode !== "old";
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

  async function loadGraveOptions(
    blockId,
    blockName,
    pinnedGraveId,
    pinnedGraveCode,
  ) {
    const select = modalEl ? modalEl.querySelector("#grave_code") : null;
    if (!select || select.tagName !== "SELECT") return;

    clearBlockChangeTimer();
    const token = ++gravesToken;

    if (currentMode === "view" && wizardMode !== "old") {
      if (pinnedGraveId) {
        renderGraveOptions(
          [
            {
              grave_id: Number(pinnedGraveId),
              grave_code: pinnedGraveCode || "",
              _pinned: true,
            },
          ],
          pinnedGraveId,
        );
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
      console.warn("[reserve_modal] Unable to fetch graves:", fetchError);
      setGraveCodeHint("Unable to load grave codes. Please try again.", true);
      renderGraveOptions([], null);
      return;
    }

    if (pinnedGraveId || pinnedGraveCode) {
      const pinId = pinnedGraveId != null ? Number(pinnedGraveId) : null;
      const pinCode = String(pinnedGraveCode || "").trim();
      const exists = graves.some((g) => {
        if (pinId != null && Number(g.grave_id) === pinId) return true;
        if (pinCode && String(g.grave_code || "").trim() === pinCode)
          return true;
        return false;
      });
      if (!exists) {
        graves.unshift({
          grave_id: pinId != null ? pinId : null,
          grave_code: pinCode,
          status: "occupied",
          _pinned: true,
        });
      }
    }

    if (!graves.length)
      setGraveCodeHint("No available grave codes in this block.", true);
    else setGraveCodeHint("");

    renderGraveOptions(graves, pinnedGraveId);

    if (pinnedGraveCode) selectGraveByCode(pinnedGraveCode, pinnedGraveId);
  }

  function onBlockChange() {
    const blockSelect = modalEl ? modalEl.querySelector("#block") : null;
    if (!blockSelect) return;
    const opt = blockSelect.options[blockSelect.selectedIndex];
    const blockId = opt ? opt.dataset.blockId : null;
    const blockName = (blockSelect.value || "").trim();
    const blockType = opt ? opt.dataset.blockType || "" : "";
    if (blockName && blockType) setBurialTypeFromBlockType(blockType);

    if (currentMode === "add" && wizardMode !== "old" && addOriginalBlock) {
      if (blockName === addOriginalBlock) {
        restoreOriginalAddContext();
        return;
      }
      activeOldIntermentId = null;
      activeGraveId = null;
    }

    if (!blockId || !blockName) {
      renderGraveOptions([], null);
      setGraveCodeHint("");
      return;
    }

    let pinnedGraveId = null;
    let pinnedGraveCode = null;

    if (wizardMode !== "old") {
      const origBlock = String(
        pick(activeOriginalValues.block_name) || "",
      ).trim();
      const origGraveId = Number(pick(activeOriginalValues.grave_id)) || null;
      const origGraveCode = pick(activeOriginalValues.grave_code);
      if (origBlock && origBlock === blockName && origGraveId) {
        pinnedGraveId = origGraveId;
        pinnedGraveCode = origGraveCode;
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
    const burialType = currentBurialType();
    const blockSelect = modalEl.querySelector("#block");
    const blockIsEditable =
      blockSelect &&
      !blockSelect.disabled &&
      blockSelect.style.pointerEvents !== "none";
    if (blockIsEditable) {
      blockSelect.value = "";
      resetGraveSelectUI();
      renderBlockOptions("", burialType);
    }
    updateBurialTypePlaceholder();
  }

  function restoreOriginalAddContext() {
    if (!modalEl) return;
    activeGraveId = addOriginalGraveId;
    activeOldIntermentId = addOriginalOldIntermentId;
    const select = modalEl.querySelector("#grave_code");
    if (select && select.tagName === "SELECT") {
      const selId = Number(addOriginalGraveId) || null;
      if (selId && addOriginalGraveCode) {
        let match = Array.from(select.options).find(
          (o) => o.dataset.graveId && Number(o.dataset.graveId) === selId,
        );
        if (!match) {
          const opt = document.createElement("option");
          opt.value = addOriginalGraveCode;
          opt.textContent = addOriginalGraveCode;
          opt.dataset.graveId = String(selId);
          opt.dataset.pinned = "true";
          select.appendChild(opt);
          match = opt;
        }
        select.value = match.value;
        updateSelectedSlotFromGraveSelect();
      } else {
        select.value = "";
        selectedSlot = null;
      }
    }
    setGraveCodeHint("");
  }

  // ==================================================================
  // styles
  // ==================================================================
  function injectWizardStyles() {
    if (document.getElementById("reserveWizardMiniStyles")) return;
    const style = document.createElement("style");
    style.id = "reserveWizardMiniStyles";
    style.textContent = `
            #burial_modal_overlay .wizardLocationHeader {
                margin: 12px 0 6px;
                padding: 6px 10px;
                background: #f4f8ff;
                border-left: 3px solid #2b6cd4;
                border-radius: 4px;
                font-size: 0.95rem;
                font-weight: 600;
                color: #1f2a3d;
                width: 25%;
            }
            #burial_modal_overlay .wizardLocationHeader .locName { color: #2b6cd4; }
            #burial_modal_overlay .wizardLocationHeader .locCurrent {
                font-weight: 400;
                font-size: 0.85rem;
                color: #56637a;
            }

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

  function ensureLocationHeader() {
    if (!modalEl) return;
    injectWizardStyles();
    const burialBlock = modalEl.querySelector("#burial_block");
    if (!burialBlock) return;
    const wrapper = burialBlock.closest(".col") || burialBlock.parentElement;
    if (!wrapper) return;

    const stray = modalEl.querySelector(".wizardLocationHeader");
    if (stray && stray !== locationHeaderEl) stray.remove();

    if (!locationHeaderEl || !document.body.contains(locationHeaderEl)) {
      const h = document.createElement("div");
      h.className = "wizardLocationHeader";
      h.innerHTML = `Where will <span class="locName">this person</span> go? <span class="locCurrent"></span>`;
      wrapper.parentNode.insertBefore(h, wrapper);
      locationHeaderEl = h;
    }
  }

  function ensureWizardButtons() {
    if (!modalEl) return;
    injectWizardStyles();
    const actions = modalEl.querySelector(".paperFormActions");
    if (!actions) return;

    const existingNext = actions.querySelectorAll(".paperNextBtn");
    existingNext.forEach((el, i) => {
      if (i > 0) el.remove();
    });
    const existingBack = actions.querySelectorAll(".paperBackBtn");
    existingBack.forEach((el, i) => {
      if (i > 0) el.remove();
    });

    let n = actions.querySelector(".paperNextBtn");
    if (!n) {
      n = document.createElement("button");
      n.type = "button";
      n.className = "paperNextBtn";
      n.textContent = "Next (New Occupant) →";
      n.style.display = "none";
      n.addEventListener("click", handleNextClick);
      actions.appendChild(n);
    }
    nextBtn = n;

    let b = actions.querySelector(".paperBackBtn");
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "paperBackBtn";
      b.textContent = "← Back (Old Occupant)";
      b.style.display = "none";
      b.addEventListener("click", handleBackClick);
      actions.appendChild(b);
    }
    backBtn = b;
  }

  function updateLocationHeaderText(name, currentInfo) {
    ensureLocationHeader();
    const span = locationHeaderEl?.querySelector(".locName");
    if (span) span.textContent = name || "this person";

    const cur = locationHeaderEl?.querySelector(".locCurrent");
    if (cur) {
      if (currentInfo) cur.textContent = ` (currently at ${currentInfo})`;
      else cur.textContent = "(Locked, going into this assigned grave)";
    }
  }

  function updateWizardButtons() {
    ensureWizardButtons();
    const saveBtn = modalEl.querySelector(".paperSaveBtn");
    const cancelBtn = modalEl.querySelector(".paperCancelBtn");
    const isReplace = !!activeOldIntermentId;

    if (submissionSucceeded) {
      if (wizardMode === "old") {
        if (nextBtn) nextBtn.style.display = "inline-block";
        if (backBtn) backBtn.style.display = "none";
      } else {
        if (nextBtn) nextBtn.style.display = "none";
        if (backBtn)
          backBtn.style.display = isReplace ? "inline-block" : "none";
      }

      if (cancelBtn) cancelBtn.style.display = "none";
      if (saveBtn) {
        saveBtn.style.display = "inline-block";
        saveBtn.textContent = "Close";
        saveBtn.disabled = false;
        saveBtn.type = "button";
      }
      return;
    }

    if (wizardMode === "old") {
      if (saveBtn) saveBtn.style.display = "none";
      if (nextBtn) nextBtn.style.display = "inline-block";
      if (backBtn) backBtn.style.display = "none";
      if (cancelBtn) {
        cancelBtn.style.display = "";
        cancelBtn.textContent = "Cancel";
      }
    } else if (wizardMode === "new") {
      if (saveBtn) {
        saveBtn.style.display = "inline-block";
        saveBtn.textContent = "Save";
        saveBtn.disabled = false;
      }
      if (nextBtn) nextBtn.style.display = "none";
      if (backBtn) backBtn.style.display = isReplace ? "inline-block" : "none";
      if (cancelBtn) {
        cancelBtn.style.display = "";
        cancelBtn.textContent = "Cancel";
      }
    } else {
      if (saveBtn) saveBtn.style.display = "none";
      if (nextBtn) nextBtn.style.display = "none";
      if (backBtn) backBtn.style.display = "none";
      if (cancelBtn) {
        cancelBtn.style.display = "";
        cancelBtn.textContent = "Close";
      }
    }
  }

  function lockFieldsOnly() {
    if (!modalEl) return;
    modalEl.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el.closest(".paperFormActions")) return;
      el.disabled = true;
      el.readOnly = true;
      if (el.tagName === "SELECT") el.style.pointerEvents = "none";
      el.style.cursor = "not-allowed";
    });
  }

  function unlockFields() {
    if (!modalEl) return;
    modalEl.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el.closest(".paperFormActions")) return;
      el.disabled = false;
      el.readOnly = false;
      el.style.pointerEvents = "";
      el.style.cursor = "";
    });
  }

  function lockAfterSuccess() {
    submissionSucceeded = true;

    lockFieldsOnly();

    const saveBtn = modalEl.querySelector(".paperSaveBtn");
    if (saveBtn) {
      saveBtn.textContent = "Close";
      saveBtn.disabled = false;
      saveBtn.type = "button";
      saveBtn.style.display = "inline-block";
    }

    const cancelBtn = modalEl.querySelector(".paperCancelBtn");
    if (cancelBtn) cancelBtn.style.display = "none";

    updateWizardButtons();

    console.log("[reserve_modal] submission succeeded — modal locked.");
  }

  // ==================================================================
  // form value read/write
  // ==================================================================
  function readAllFormFields() {
    const out = {};
    if (!modalEl) return out;
    modalEl.querySelectorAll("input, select, textarea").forEach((el) => {
      if (!el.id) return;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" && (el.type === "button" || el.type === "submit"))
        return;
      out[el.id] = el.value;
    });
    return out;
  }

  function applyFormFields(values) {
    if (!modalEl || !values) return;
    Object.keys(values).forEach((id) => {
      const el = modalEl.querySelector("#" + id);
      if (!el) return;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" && (el.type === "button" || el.type === "submit"))
        return;

      const raw = values[id];
      const val = raw === null || raw === undefined ? "" : String(raw);

      if (tag === "select") {
        const has = Array.from(el.options).some((o) => o.value === val);
        if (!has && val !== "") {
          const opt = document.createElement("option");
          opt.value = val;
          opt.textContent = val;
          opt.dataset.pinned = "true";
          el.appendChild(opt);
        }
        el.value = val;
      } else {
        el.value = val;
      }
    });
  }

  function setIfPresent(id, value) {
    const el = modalEl.querySelector("#" + id);
    if (!el) return false;
    el.value = value === null || value === undefined ? "" : String(value);
    return true;
  }

  function setDateIfPresent(id, value) {
    return setIfPresent(id, sliceDate(value));
  }

  function populateOldOccupantForm(data) {
    const src = data || {};

    const cField = controlNoField();
    if (cField) cField.value = pick(src.control_number, src.control_no);

    setDateIfPresent("burial_clearance_date", src.burial_clearance_date);
    setDateIfPresent("deceased_date_of_birth", src.deceased_date_of_birth);
    setDateIfPresent("deceased_date_of_death", src.deceased_date_of_death);
    setDateIfPresent("burial_permit_date", src.burial_permit_date);
    setDateIfPresent("transfer_permit_date", src.transfer_permit_date);
    setDateIfPresent("exhumation_permit_date", src.exhumation_permit_date);
    setDateIfPresent("date_buried", src.date_buried);
    setDateIfPresent("lease_expiration_date", src.lease_expiration_date);

    setIfPresent("contact_person_name", src.contact_person_name);
    setIfPresent("contact_person_email", src.contact_person_email);
    setIfPresent(
      "contact_person_phone_number",
      src.contact_person_phone_number
        ? formatPhoneValue(src.contact_person_phone_number)
        : "+63",
    );
    setIfPresent("contact_person_address", src.contact_person_address);
    setIfPresent(
      "contact_person_address_barangay",
      pick(src.contact_person_address_barangay)
        .replace(/^(Barangay|Brgy\.\s*)/i, "")
        .trim(),
    );

    const rawAssist = pick(src.assistance_type);
    let mappedAssist = rawAssist;
    if (/burial/i.test(rawAssist)) mappedAssist = "Burial";
    else if (/transfer|exhumation/i.test(rawAssist))
      mappedAssist = "Transfer the remains of the late";
    else if (/^other/i.test(rawAssist)) mappedAssist = "Other";
    setIfPresent("assistance_type", mappedAssist);

    setIfPresent("deceased_name", src.deceased_name);
    setIfPresent("deceased_sex", src.deceased_sex);
    setIfPresent("last_known_address", src.last_known_address);
    setIfPresent("death_certificate", src.death_certificate);

    setIfPresent("burial_permit_number", src.burial_permit_number);
    setIfPresent("transfer_permit_number", src.transfer_permit_number);
    setIfPresent("transfer_permit_issued_by", src.transfer_permit_issued_by);
    setIfPresent("exhumation_permit_number", src.exhumation_permit_number);

    const oldBaseRemarks = pick(src.interment_remarks, src.remarks);
    setIfPresent(
      "remarks",
      oldBaseRemarks ? `${oldBaseRemarks} [Replace]` : "[Replace]",
    );

    setIfPresent("status", "Active");
    setIfPresent("block", "");
    setIfPresent("grave_code", "");

    resetGraveSelectUI();
    renderBlockOptions("");

    const currentBlock = pick(src.block_name, src.plan_block_name);
    const currentGrave = pick(src.grave_code, src.plan_grave_code);
    const currentInfo =
      currentBlock || currentGrave
        ? `${currentBlock || "—"} / ${currentGrave || "—"}`
        : "";

    updateLocationHeaderText(
      pick(src.deceased_name, "this occupant"),
      currentInfo,
    );
  }

  function populateNewOccupantForm(target) {
    const blockNameForType = pick(target.block_name);
    const matchedBlock = blockOptions.find((b) => b.name === blockNameForType);
    const blockTypeFromDB = matchedBlock ? matchedBlock.type : "";
    const rawType = pick(blockTypeFromDB, target.block_type);

    modalEl.querySelectorAll("input, select, textarea").forEach((el) => {
      if (!el.id) return;
      const tag = (el.tagName || "").toLowerCase();
      if (tag === "input" && (el.type === "button" || el.type === "submit"))
        return;
      if (
        el.id === "block" ||
        el.id === "grave_code" ||
        el.id === "burial_block"
      )
        return;
      if (el.id === "status") return;
      if (el.id === "current_grave_id") return;
      if (el.tagName === "SELECT") el.selectedIndex = 0;
      else el.value = "";
    });

    const cField = controlNoField();
    if (cField) cField.value = generateControlNo();

    setIfPresent("burial_clearance_date", todayISO());
    setIfPresent("contact_person_phone_number", "+63");

    ensurePendingInStatus();
    setIfPresent("status", "Pending");

    if (activeOldIntermentId) {
      // Replacing an existing occupant.
      const oldName = pick(
        oldOccupantOriginal?.deceased_name,
        oldOccupantDraft?.current?.deceased_name,
        viewSnapshot?.deceased_name,
        "previous occupant",
      );
      const oldGrave = pick(
        oldOccupantOriginal?.grave_code,
        activeOriginalValues.grave_code,
        viewSnapshot?.grave_code,
        viewSnapshot?.plan_grave_code,
      );
      const atPart = oldGrave ? ` at grave ${oldGrave}` : "";
      setIfPresent("remarks", `Replace: ${oldName}${atPart}`);
    } else {
      // Vacant grave — no old occupant to replace.
      const vacantGrave = pick(
        target.grave_code,
        addOriginalGraveCode,
        viewSnapshot?.grave_code,
        activeOriginalValues.grave_code,
      );
      setIfPresent(
        "remarks",
        vacantGrave ? `Assign at: ${vacantGrave}` : "Assign",
      );
    }

    if (rawType) setBurialTypeFromBlockType(rawType);
    setIfPresent("block", blockNameForType);

    const expField = getExpirationField();
    if (expField) expField.value = "";

    updateLocationHeaderText("the incoming person", "");
  }

  function captureOldOccupant() {
    const read = (id) => {
      const el = modalEl.querySelector("#" + id);
      return el ? String(el.value || "").trim() : "";
    };

    const assistRaw = read("assistance_type");
    let assistance = "Other";
    if (/^burial/i.test(assistRaw)) assistance = "Burial";
    else if (/transfer/i.test(assistRaw))
      assistance = "Transfer the remains of the late";

    return {
      deceased_name: read("deceased_name"),
      deceased_sex: read("deceased_sex"),
      deceased_date_of_birth: read("deceased_date_of_birth") || null,
      deceased_date_of_death: read("deceased_date_of_death") || null,
      last_known_address: read("last_known_address"),
      death_certificate: read("death_certificate"),
      contact_person_name: read("contact_person_name"),
      contact_person_phone_number: read("contact_person_phone_number"),
      contact_person_email: read("contact_person_email"),
      contact_person_address: read("contact_person_address"),
      contact_person_address_barangay: read("contact_person_address_barangay"),
      assistance_type: assistance,
      burial_permit_number: read("burial_permit_number"),
      exhumation_permit_number: read("exhumation_permit_number"),
      transfer_permit_number: read("transfer_permit_number"),
      burial_clearance_date: read("burial_clearance_date") || null,
      remarks: read("remarks"),
      old_new_status: read("status") || "Inactive",
      old_new_grave_code: read("grave_code"),
    };
  }

  function computeOldDiff(current, original) {
    const diff = {};
    if (!original) return diff;

    const DATE_KEYS = new Set([
      "deceased_date_of_birth",
      "deceased_date_of_death",
      "burial_permit_date",
      "transfer_permit_date",
      "exhumation_permit_date",
      "date_exhumed",
      "burial_clearance_date",
    ]);
    const SKIP = new Set([
      "old_new_status",
      "old_new_grave_code",
      "assistance_type",
    ]);

    Object.keys(current).forEach((key) => {
      if (SKIP.has(key)) return;
      let c =
        current[key] === null || current[key] === undefined
          ? ""
          : String(current[key]).trim();
      let o = pick(original[key]);
      if (DATE_KEYS.has(key) && o) o = String(o).slice(0, 10);
      if (c === "") {
        if (o === "") return;
        diff[key] = null;
        return;
      }
      if (c !== o) diff[key] = c;
    });

    return diff;
  }

  // ==================================================================
  // MODE SWITCHING
  // ==================================================================
  function enterOldMode(data) {
    wizardMode = "old";
    syncStatusOptionsForWizard();

    oldOccupantOriginal = {
      interment_id: activeOldIntermentId,
      control_number: pick(data.control_number),
      block_name: pick(data.block_name, data.plan_block_name),
      grave_code: pick(data.grave_code, data.plan_grave_code),
      block_type: pick(data.block_type, data.burial_block),
      deceased_name: pick(data.deceased_name),
      deceased_sex: pick(data.deceased_sex),
      deceased_date_of_birth: pick(data.deceased_date_of_birth),
      deceased_date_of_death: pick(data.deceased_date_of_death),
      last_known_address: pick(data.last_known_address),
      death_certificate: pick(data.death_certificate),
      contact_person_name: pick(data.contact_person_name),
      contact_person_phone_number: pick(data.contact_person_phone_number),
      contact_person_email: pick(data.contact_person_email),
      contact_person_address: pick(data.contact_person_address),
      contact_person_address_barangay: pick(
        data.contact_person_address_barangay,
      ),
      assistance_type: pick(data.assistance_type),
      burial_permit_number: pick(data.burial_permit_number),
      transfer_permit_number: pick(data.transfer_permit_number),
      exhumation_permit_number: pick(data.exhumation_permit_number),
      transfer_permit_issued_by: pick(data.transfer_permit_issued_by),
      burial_permit_date: pick(data.burial_permit_date),
      transfer_permit_date: pick(data.transfer_permit_date),
      exhumation_permit_date: pick(data.exhumation_permit_date),
      date_buried: pick(data.date_buried),
      date_exhumed: pick(data.date_exhumed),
      burial_clearance_date: pick(data.burial_clearance_date),
      lease_expiration_date: pick(data.lease_expiration_date),
      remarks: pick(data.interment_remarks, data.remarks),
    };

    populateOldOccupantForm(oldOccupantOriginal);

    const typeEl = modalEl.querySelector("#burial_block");
    if (typeEl) typeEl.value = "";

    setEditable("old");
    updateWizardButtons();

    oldModeSnapshot = readAllFormFields();

    const nameEl = modalEl.querySelector("#deceased_name");
    if (nameEl && !nameEl.dataset.wzOldNameBound) {
      nameEl.dataset.wzOldNameBound = "true";
      nameEl.addEventListener("input", (e) => {
        if (wizardMode !== "old") return;
        const v = (e.target.value || "").trim() || "this occupant";
        updateLocationHeaderText(
          v,
          (() => {
            const b = pick(oldOccupantOriginal?.block_name);
            const g = pick(oldOccupantOriginal?.grave_code);
            return b || g ? `${b || "—"} / ${g || "—"}` : "";
          })(),
        );
      });
    }
  }

  function enterNewModeFresh(target) {
    wizardMode = "new";
    syncStatusOptionsForWizard();

    populateNewOccupantForm(target);

    const statusEl = modalEl.querySelector("#status");
    if (statusEl) statusEl.value = "Pending";

    setEditable("new");
    updateWizardButtons();

    const nameEl = modalEl.querySelector("#deceased_name");
    if (nameEl && !nameEl.dataset.wzNewNameBound) {
      nameEl.dataset.wzNewNameBound = "true";
      nameEl.addEventListener("input", (e) => {
        if (wizardMode !== "new") return;
        const v = (e.target.value || "").trim() || "the incoming person";
        updateLocationHeaderText(v, "");
      });
    }
  }

  function handleNextClick() {
    if (wizardMode !== "old") return;

    // After success, Next just re-shows the new-occupant view (read-only).
    if (submissionSucceeded) {
      wizardMode = "new";
      syncStatusOptionsForWizard();

      unlockFields();
      forceRestoreNewOccupantFields();

      resetGraveSelectUI();
      const blockSelect = modalEl.querySelector("#block");
      const targetBlockName = pick(
        oldTargetContext?.block_name,
        activeOriginalValues.block_name,
        addOriginalBlock,
      );
      const targetGraveId =
        activeGraveId ||
        Number(pick(activeOriginalValues.grave_id)) ||
        Number(pick(addOriginalGraveId)) ||
        null;
      const targetGraveCode = pick(
        activeOriginalValues.grave_code,
        addOriginalGraveCode,
      );

      if (blockSelect && targetBlockName) {
        const exists = Array.from(blockSelect.options).some(
          (o) => o.value === targetBlockName,
        );
        if (!exists) {
          const match = blockOptions.find((b) => b.name === targetBlockName);
          const opt = document.createElement("option");
          opt.value = targetBlockName;
          opt.textContent = targetBlockName;
          opt.dataset.pinned = "true";
          if (match && match.id != null) opt.dataset.blockId = String(match.id);
          if (match && match.type) opt.dataset.blockType = match.type;
          blockSelect.appendChild(opt);
        }
        blockSelect.value = targetBlockName;
        const opt = blockSelect.options[blockSelect.selectedIndex];
        const blockId = opt ? opt.dataset.blockId : null;
        if (blockId) {
          loadGraveOptions(
            blockId,
            targetBlockName,
            targetGraveId,
            targetGraveCode,
          ).then(() => {
            selectGraveByCode(targetGraveCode, targetGraveId);
            lockFieldsOnly();
            updateWizardButtons();
          });
        }
      }

      lockFieldsOnly();
      updateBurialTypePlaceholder();
      updateWizardButtons();
      refreshNewOccupantHeader();
      return;
    }

    const phoneEl = modalEl.querySelector("#contact_person_phone_number");
    const rawPhone = (phoneEl?.value || "").trim();
    if (rawPhone && rawPhone !== "+63") {
      const digits = rawPhone.replace(/\D/g, "").replace(/^63/, "");
      if (digits.length !== 10) {
        warn("Old occupant phone must be in the format +63 XXX XXX XXXX.");
        phoneEl?.focus();
        return;
      }
    }

    const statusEl = modalEl.querySelector("#status");
    if (statusEl?.value === "Active") {
      const typeEl = modalEl.querySelector("#burial_block");
      const blockEl = modalEl.querySelector("#block");
      const graveEl = modalEl.querySelector("#grave_code");

      const hasBlock = !!(blockEl?.value || "").trim();
      const hasGrave = !!(graveEl?.value || "").trim();

      if (!hasBlock && !hasGrave) {
        warn(
          "Status is set to Active, but no destination was chosen. " +
            "Please pick a Burial Type, Block, and Grave Code for the old occupant, " +
            "or set their status to Inactive.",
        );
        (typeEl || blockEl || graveEl)?.focus();
        return;
      }
      if (!hasBlock || !hasGrave) {
        warn(
          "Please complete the destination location (Burial Type, Block, and Grave Code) " +
            "for the old occupant, or set their status to Inactive.",
        );
        (hasBlock ? graveEl : blockEl)?.focus();
        return;
      }
    }

    oldModeSnapshot = readAllFormFields();

    oldOccupantDraft = {
      grave_id: activeGraveId,
      interment_id: activeOldIntermentId,
      original: oldOccupantOriginal,
      current: captureOldOccupant(),
      confirmed: true,
    };

    oldTargetContext = {
      block_name: pick(activeOriginalValues.block_name, addOriginalBlock),
      block_type: pick(activeOriginalValues.block_type),
      grave_id: activeGraveId,
    };

    const previousN = newModeSnapshot ? { ...newModeSnapshot } : null;

    enterNewModeFresh(oldTargetContext);

    if (previousN) {
      const SKIP = new Set([
        "block",
        "grave_code",
        "burial_block",
        "status",
        "lease_expiration_date",
      ]);
      const toRestore = {};
      Object.keys(previousN).forEach((k) => {
        if (SKIP.has(k)) return;
        toRestore[k] = previousN[k];
      });
      applyFormFields(toRestore);
      recalcExpirationFromInterment();
    }

    newModeSnapshot = readAllFormFields();

    resetGraveSelectUI();
    const blockSelect = modalEl.querySelector("#block");
    if (blockSelect && oldTargetContext.block_name) {
      const exists = Array.from(blockSelect.options).some(
        (o) => o.value === oldTargetContext.block_name,
      );
      if (!exists) {
        const match = blockOptions.find(
          (b) => b.name === oldTargetContext.block_name,
        );
        const opt = document.createElement("option");
        opt.value = oldTargetContext.block_name;
        opt.textContent = oldTargetContext.block_name;
        opt.dataset.pinned = "true";
        if (match && match.id != null) opt.dataset.blockId = String(match.id);
        if (match && match.type) opt.dataset.blockType = match.type;
        blockSelect.appendChild(opt);
      }
      blockSelect.value = oldTargetContext.block_name;
      const opt = blockSelect.options[blockSelect.selectedIndex];
      const blockId = opt ? opt.dataset.blockId : null;

      const targetGraveId =
        activeGraveId ||
        Number(pick(activeOriginalValues.grave_id)) ||
        Number(pick(addOriginalGraveId)) ||
        null;
      const targetGraveCode = pick(
        oldOccupantOriginal?.grave_code,
        activeOriginalValues.grave_code,
        addOriginalGraveCode,
      );

      if (blockId) {
        loadGraveOptions(
          blockId,
          oldTargetContext.block_name,
          targetGraveId,
          targetGraveCode,
        ).then(() => selectGraveByCode(targetGraveCode, targetGraveId));
      } else if (targetGraveCode) {
        selectGraveByCode(targetGraveCode, targetGraveId);
      }
    }
  }

  async function handleBackClick() {
    if (wizardMode !== "new") return;

    // After success, Back re-shows the old-occupant view (read-only).
    if (submissionSucceeded) {
      wizardMode = "old";
      syncStatusOptionsForWizard();

      unlockFields();
      forceRestoreOldOccupantFields();

      const savedBlock = oldModeSnapshot?.block || "";
      const savedGrave = oldModeSnapshot?.grave_code || "";

      const blockEl = modalEl.querySelector("#block");
      if (blockEl && savedBlock) {
        let opt = Array.from(blockEl.options).find(
          (o) => o.value === savedBlock,
        );
        if (!opt) {
          const match = blockOptions.find((b) => b.name === savedBlock);
          opt = document.createElement("option");
          opt.value = savedBlock;
          opt.textContent = savedBlock;
          opt.dataset.pinned = "true";
          if (match && match.id != null) opt.dataset.blockId = String(match.id);
          if (match && match.type) opt.dataset.blockType = match.type;
          blockEl.appendChild(opt);
        }
        blockEl.value = savedBlock;

        const blockId = opt ? opt.dataset.blockId : null;
        if (blockId) {
          await loadGraveOptions(blockId, savedBlock, null, null);
        }
      } else if (blockEl) {
        blockEl.value = "";
      }

      const graveEl = modalEl.querySelector("#grave_code");
      if (graveEl && savedGrave) {
        selectGraveByCode(savedGrave, null);
      } else if (graveEl) {
        graveEl.value = "";
        updateSelectedSlotFromGraveSelect();
      }

      lockFieldsOnly();
      updateBurialTypePlaceholder();
      updateWizardButtons();
      refreshOldOccupantHeader();
      return;
    }

    newModeSnapshot = readAllFormFields();

    wizardMode = "old";
    syncStatusOptionsForWizard();

    renderBlockOptions("");
    resetGraveSelectUI();

    const savedBlock = oldModeSnapshot?.block || "";
    const savedGrave = oldModeSnapshot?.grave_code || "";

    // Apply everything except block/grave (handled separately).
    if (oldModeSnapshot) {
      const toApply = { ...oldModeSnapshot };
      delete toApply.block;
      delete toApply.grave_code;
      delete toApply.burial_block;
      applyFormFields(toApply);
    }

    // FIX: burial type from snapshot only. If O was set to Inactive,
    // snapshot.burial_block is '' → dropdown stays empty.
    applyBurialTypeFromSnapshot(oldModeSnapshot?.burial_block);

    const blockEl = modalEl.querySelector("#block");
    if (blockEl && savedBlock) {
      let opt = Array.from(blockEl.options).find((o) => o.value === savedBlock);
      if (!opt) {
        const match = blockOptions.find((b) => b.name === savedBlock);
        opt = document.createElement("option");
        opt.value = savedBlock;
        opt.textContent = savedBlock;
        opt.dataset.pinned = "true";
        if (match && match.id != null) opt.dataset.blockId = String(match.id);
        if (match && match.type) opt.dataset.blockType = match.type;
        blockEl.appendChild(opt);
      }
      blockEl.value = savedBlock;

      const blockId = opt ? opt.dataset.blockId : null;
      if (blockId) {
        await loadGraveOptions(blockId, savedBlock, null, null);
      }
    }

    if (savedGrave) selectGraveByCode(savedGrave, null);

    setEditable("old");
    updateWizardButtons();

    refreshOldOccupantHeader();
  }

  // ==================================================================
  // load & bind
  // ==================================================================
  async function ensureLoaded() {
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
        if (res.ok) {
          html = await res.text();
          break;
        }
      } catch (_) {}
    }
    if (!html) {
      console.error("Failed to load burial_modal.html.");
      return;
    }
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const fragment = parsed.getElementById("burial_modal_overlay");
    if (!fragment) {
      console.error("burial_modal.html missing #burial_modal_overlay.");
      return;
    }
    document.body.appendChild(document.adoptNode(fragment));
  }

  function bindEvents() {
    if (!modalEl || modalEl.dataset.reserveBound === "true") return;
    modalEl.dataset.reserveBound = "true";

    const cancelBtn = modalEl.querySelector(".paperCancelBtn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", (e) => {
        e.preventDefault();
        handleCancel();
      });
    }

    const saveBtnEl = modalEl.querySelector(".paperSaveBtn");
    if (saveBtnEl) {
      saveBtnEl.addEventListener("click", (e) => {
        if (submissionSucceeded) {
          e.preventDefault();
          handleCancel();
        }
      });
    }

    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) handleCancel();
    });

    const form = modalEl.querySelector("#burial_clearance_form");
    if (form) form.addEventListener("submit", handleSubmit);

    const controlNo = controlNoField();
    if (controlNo) {
      controlNo.removeAttribute("placeholder");
      controlNo.setAttribute("autocomplete", "off");
    }

    const isPhoneField = (el) => el && el.id === "contact_person_phone_number";

    modalEl.addEventListener("input", (e) => {
      if (submissionSucceeded) return;
      if (!isPhoneField(e.target)) return;
      const formatted = formatPhoneValue(e.target.value);
      if (e.target.value !== formatted) e.target.value = formatted;
    });

    modalEl.addEventListener("focusout", (e) => {
      if (submissionSucceeded) return;
      if (!isPhoneField(e.target)) return;
      if (!e.target.value) e.target.value = "+63";
    });

    ["contact_person_name", "deceased_name"].forEach((id) => {
      const field = modalEl.querySelector(`#${id}`);
      if (field) {
        field.addEventListener("input", (e) => {
          if (submissionSucceeded) return;
          e.target.value = formatNameValue(e.target.value);
        });
      }
    });

    const blockSelect = modalEl.querySelector("#block");
    if (blockSelect) {
      blockSelect.addEventListener("change", () => {
        if (submissionSucceeded) return;
        if (!blockSelect.disabled) onBlockChange();
      });
      blockSelect.addEventListener("mousedown", guardBlockGraveWhenInactive);
    }

    const graveSelect = modalEl.querySelector("#grave_code");
    if (graveSelect) {
      graveSelect.addEventListener("change", () => {
        if (submissionSucceeded) return;
        updateSelectedSlotFromGraveSelect();
        setGraveCodeHint("");
      });
      graveSelect.addEventListener("mousedown", guardBlockGraveWhenInactive);
    }

    INTERMENT_FIELD_IDS.forEach((id) => {
      const el = modalEl.querySelector("#" + id);
      if (!el) return;
      el.addEventListener("input", () => {
        if (!submissionSucceeded) recalcExpirationFromInterment();
      });
      el.addEventListener("change", () => {
        if (!submissionSucceeded) recalcExpirationFromInterment();
      });
      el.addEventListener("blur", () => {
        if (!submissionSucceeded) recalcExpirationFromInterment();
      });
    });

    const statusSelect = modalEl.querySelector("#status");
    if (statusSelect)
      statusSelect.addEventListener("change", () => {
        if (submissionSucceeded) return;
        handleStatusChange();
      });

    const burialTypeSelect = modalEl.querySelector("#burial_block");
    if (burialTypeSelect) {
      burialTypeSelect.addEventListener(
        "mousedown",
        guardBlockGraveWhenInactive,
      );
      burialTypeSelect.addEventListener("change", () => {
        if (submissionSucceeded) return;
        onBurialTypeChange();
      });
    }
  }

  function handleCancel() {
    oldOccupantDraft = null;
    oldOccupantOriginal = null;
    oldModeSnapshot = null;
    newModeSnapshot = null;
    close();
  }

  // ==================================================================
  // open
  // ==================================================================
  async function open(a, b, c) {
    let mode, rawData, options;

    if (
      typeof a === "string" &&
      (a === "view" || a === "add" || a === "edit-old")
    ) {
      mode = a;
      rawData = b && typeof b === "object" ? b : {};
      options = c && typeof c === "object" ? c : {};
    } else if (a && typeof a === "object") {
      rawData = a;
      options = b && typeof b === "object" ? b : {};
    } else {
      mode = "add";
      rawData = {};
      options = {};
    }

    let data = { ...rawData };
    if (rawData.grave && typeof rawData.grave === "object") {
      Object.assign(data, rawData.grave);
    }
    if (rawData.interment && typeof rawData.interment === "object") {
      Object.assign(data, rawData.interment);
    }

    if (!mode) mode = detectMode(data);

    await ensureLoaded();
    if (!modalEl) return;

    const sameSession =
      modalEl.classList.contains("active") &&
      activeOldIntermentId &&
      oldOccupantOriginal &&
      wizardMode;

    currentMode = mode === "edit-old" ? "add" : mode;

    if (!sameSession) {
      activeOldIntermentId = data.old_interment_id || data.interment_id || null;
      oldOccupantDraft = null;
      oldModeSnapshot = null;
      newModeSnapshot = null;
      oldTargetContext = null;
      wizardMode = null;
      submissionSucceeded = false;
    }

    unlockFields();

    activeGraveId = Number(data.grave_id) || null;

    takenControlNos = Array.isArray(options.takenControlNos)
      ? options.takenControlNos.map((v) => String(v).trim().toUpperCase())
      : [];

    const form = modalEl.querySelector("#burial_clearance_form");
    if (form && !sameSession) form.reset();

    if (form) {
      if (currentMode === "view") form.setAttribute("novalidate", "novalidate");
      else form.removeAttribute("novalidate");
    }

    modalEl.classList.toggle("view-mode", currentMode === "view");

    ensureGraveCodeSelect();
    ensureLocationHeader();
    ensureWizardButtons();

    blocksPromise = null;
    await loadBlocks();

    const d = { ...data };

    addOriginalBlock = pick(data.block_name, data.block);
    addOriginalGraveCode = pick(data.grave_code);
    addOriginalGraveId = Number(data.grave_id) || null;
    addOriginalOldIntermentId =
      data.old_interment_id || data.interment_id || null;

    activeOriginalValues = {
      block_name: pick(data.plan_block_name, data.block_name, data.block),
      grave_code: pick(data.plan_grave_code, data.grave_code),
      grave_id: pick(data.grave_id, data.current_grave_id),
      block_type: pick(
        data.plan_burial_type,
        data.block_type,
        data.burial_block,
      ),
      assistance_type: pick(data.assistance_type),
      remarks: pick(data.interment_remarks, data.remarks),
      date_buried: pick(
        data.plan_date_interment,
        data.date_buried,
        data.date_interment,
      ),
      lease_expiration_date: pick(
        data.plan_expiration_date,
        data.lease_expiration_date,
        data.expiration_date,
      ),
    };

    viewSnapshot = { ...d };

    if (mode === "edit-old") {
      enterOldMode(data);
    } else if (mode === "view") {
      wizardMode = null;
      populateFields(d);
      setEditable("view");
      updateWizardButtons();
      updateLocationHeaderText(pick(data.deceased_name, "this person"), "");
    } else {
      if (!sameSession) {
        const target = {
          block_name: pick(data.block_name, data.block),
          block_type: pick(data.block_type, data.burial_block),
          grave_id: activeGraveId,
        };
        enterNewModeFresh(target);
        newModeSnapshot = readAllFormFields();
      } else {
        wizardMode = "new";
        syncStatusOptionsForWizard();
        setEditable("new");
        updateWizardButtons();
      }

      resetGraveSelectUI();
      const blockSelect = modalEl.querySelector("#block");
      if (blockSelect && blockSelect.value) {
        const opt = blockSelect.options[blockSelect.selectedIndex];
        const blockId = opt ? opt.dataset.blockId : null;
        const blockName = blockSelect.value;
        const pinnedGraveId =
          Number(pick(activeOriginalValues.grave_id)) || null;
        const pinnedGraveCode = pick(activeOriginalValues.grave_code);

        if (blockId) {
          await loadGraveOptions(
            blockId,
            blockName,
            pinnedGraveId,
            pinnedGraveCode,
          );
          selectGraveByCode(pinnedGraveCode, pinnedGraveId);
        } else if (pinnedGraveCode) {
          selectGraveByCode(pinnedGraveCode, pinnedGraveId);
        }
      } else {
        renderGraveOptions([], null);
      }
    }

    modalEl.style.display = "block";
    modalEl.classList.add("active");
  }

  function populateFields(data) {
    const setV = (id, value) => {
      const field = modalEl.querySelector(`#${id}`);
      if (!field) return;
      const strValue = pick(value);
      if (field.tagName === "SELECT") {
        const stale = field.querySelector('option[data-placeholder="true"]');
        if (stale) stale.remove();
        let matched = Array.from(field.options).find(
          (opt) => opt.value === strValue || opt.text === strValue,
        );
        if (!matched && strValue) {
          const lower = strValue.toLowerCase();
          matched = Array.from(field.options).find(
            (opt) =>
              opt.value !== "" &&
              (opt.value.toLowerCase() === lower ||
                opt.text.toLowerCase() === lower ||
                opt.text.toLowerCase().includes(lower) ||
                lower.includes(opt.value.toLowerCase())),
          );
        }
        if (matched) field.value = matched.value;
        else if (strValue) {
          const opt = document.createElement("option");
          opt.value = strValue;
          opt.textContent = strValue;
          field.appendChild(opt);
          field.value = strValue;
        } else field.selectedIndex = 0;
      } else {
        field.value = strValue;
      }
    };

    const cField = controlNoField();
    if (cField) cField.value = pick(data.control_number, data.control_no);

    setV("burial_clearance_date", sliceDate(data.burial_clearance_date));
    setV("contact_person_name", data.contact_person_name);
    setV("contact_person_email", data.contact_person_email);
    setV(
      "contact_person_phone_number",
      pick(data.contact_person_phone_number)
        ? formatPhoneValue(data.contact_person_phone_number)
        : "",
    );
    setV("contact_person_address", data.contact_person_address);
    setV(
      "contact_person_address_barangay",
      data.contact_person_address_barangay,
    );

    const rawAssist = pick(data.assistance_type);
    let mappedAssist = rawAssist;
    if (/burial/i.test(rawAssist)) mappedAssist = "Burial";
    else if (/transfer|exhumation/i.test(rawAssist))
      mappedAssist = "Transfer the remains of the late";
    else if (/^other/i.test(rawAssist)) mappedAssist = "Other";
    setV("assistance_type", mappedAssist);

    setV("deceased_name", data.deceased_name);
    setV("deceased_sex", data.deceased_sex);
    setV("deceased_date_of_birth", sliceDate(data.deceased_date_of_birth));
    setV("deceased_date_of_death", sliceDate(data.deceased_date_of_death));
    setV("last_known_address", data.last_known_address);
    setV("death_certificate", data.death_certificate);
    setV("burial_permit_number", data.burial_permit_number);
    setV("burial_permit_date", sliceDate(data.burial_permit_date));
    setV("transfer_permit_number", data.transfer_permit_number);
    setV("transfer_permit_issued_by", data.transfer_permit_issued_by);
    setV("transfer_permit_date", sliceDate(data.transfer_permit_date));
    setV("exhumation_permit_number", data.exhumation_permit_number);
    setV("exhumation_permit_date", sliceDate(data.exhumation_permit_date));

    const rawType = pick(
      data.plan_burial_type,
      data.block_type,
      data.burial_block,
    );
    if (rawType) setBurialTypeFromBlockType(rawType);
    setV("block", pick(data.plan_block_name, data.block_name, data.block));
    setV(
      "date_buried",
      sliceDate(
        pick(data.plan_date_interment, data.date_buried, data.date_interment),
      ),
    );
    setV(
      "lease_expiration_date",
      sliceDate(
        pick(
          data.plan_expiration_date,
          data.lease_expiration_date,
          data.expiration_date,
        ),
      ),
    );
    setV(
      "remarks",
      pick(data.plan_remarks, data.interment_remarks, data.remarks),
    );

    const statusForView = pick(
      data.plan_status,
      data.interment_status,
      data.status,
      "Pending",
    );
    const statusSel = modalEl.querySelector("#status");
    if (statusSel && statusSel.tagName === "SELECT") {
      const hasStatus = Array.from(statusSel.options).some(
        (o) => String(o.value).toLowerCase() === statusForView.toLowerCase(),
      );
      if (!hasStatus && statusForView) {
        const opt = document.createElement("option");
        opt.value = statusForView;
        opt.textContent = statusForView;
        statusSel.appendChild(opt);
      }
    }
    setV("status", statusForView);
  }

  function applyAddReadonlySelect(field) {
    if (!field || field.tagName !== "SELECT") return;
    field.disabled = false;
    field.removeAttribute("disabled");
    field.tabIndex = -1;
    field.setAttribute("aria-readonly", "true");
    field.style.pointerEvents = "none";
    field.style.cursor = "default";
  }

  function setEditable(mode) {
    if (submissionSucceeded) {
      lockFieldsOnly();
      updateBurialTypePlaceholder();
      updateWizardButtons();
      return;
    }

    const fields = modalEl.querySelectorAll("input, select, textarea");
    fields.forEach((field) => {
      if (field.closest(".paperFormActions")) return;

      if (field.tagName === "SELECT") {
        field.style.pointerEvents = "";
        field.style.cursor = "";
        field.removeAttribute("tabindex");
        field.removeAttribute("aria-readonly");
      }

      if (EXPIRATION_FIELD_IDS.includes(field.id)) {
        field.disabled = true;
        field.readOnly = true;
        field.setAttribute("aria-readonly", "true");
        field.style.background = "#eef2f8";
        field.style.color = "#475569";
        field.style.cursor = "not-allowed";
        return;
      }

      if (field.id === "control_number" || field.id === "control_no") {
        field.readOnly = mode === "view" || mode === "old";
        field.disabled = false;
        if (field.hasAttribute("placeholder"))
          field.removeAttribute("placeholder");
        return;
      }

      if (mode === "old") {
        field.disabled = false;
        field.readOnly = false;
        return;
      }

      if (mode === "new") {
        if (ADD_READONLY_FIELDS.includes(field.id)) {
          if (field.tagName === "SELECT") applyAddReadonlySelect(field);
          else field.readOnly = true;
          field.disabled = false;
          return;
        }
        field.disabled = false;
        field.readOnly = false;
        return;
      }

      if (mode === "view") {
        if (field.tagName === "SELECT") field.disabled = true;
        else field.readOnly = true;
        return;
      }
    });

    updateBurialTypePlaceholder();
    updateWizardButtons();
  }

  function handleSubmit(event) {
    event.preventDefault();

    if (submissionSucceeded) {
      handleCancel();
      return;
    }

    if (wizardMode === "old") return;
    if (currentMode === "view") {
      close();
      return;
    }

    const isReplace = !!activeOldIntermentId;

    if (isReplace && (!oldOccupantDraft || !oldOccupantDraft.confirmed)) {
      warn(
        "The old occupant has not been reviewed yet. Assign a new grave for the old occupant please" +
          '"← Back" to do it now.',
      );
      return;
    }

    const phoneRaw =
      modalEl.querySelector("#contact_person_phone_number")?.value.trim() || "";
    const phoneDigits = phoneRaw.replace(/\D/g, "").replace(/^63/, "");
    if (phoneDigits.length !== 10) {
      warn("Phone number must be in the format +63 XXX XXX XXXX.");
      return;
    }

    const cField = controlNoField();
    const controlNo = (cField?.value || "").trim();
    if (!controlNo) {
      warn("Control No. cannot be empty.");
      cField?.focus();
      return;
    }
    if (controlNoExists(controlNo) && !isOwnControlNo(controlNo)) {
      warn(`Control No. "${controlNo}" is already used by another record.`);
      cField?.focus();
      return;
    }

    const intermentEl = getIntermentField();
    const dateBuried = (intermentEl?.value || "").trim();
    if (!dateBuried) {
      warn("Date of Interment is required.");
      intermentEl?.focus();
      return;
    }

    const assistRaw = modalEl.querySelector("#assistance_type")?.value || "";
    let assistance = "Other";
    if (/^burial/i.test(assistRaw)) assistance = "Burial";
    else if (/transfer/i.test(assistRaw))
      assistance = "Transfer the remains of the late";

    const blockName = (modalEl.querySelector("#block")?.value || "").trim();
    if (!blockName) {
      warn("Block is missing.");
      return;
    }

    updateSelectedSlotFromGraveSelect();

    const currentStatus = (
      modalEl.querySelector("#status")?.value || ""
    ).trim();
    const isInactive = currentStatus === "Inactive";

    let graveCode = (modalEl.querySelector("#grave_code")?.value || "")
      .trim()
      .toUpperCase();
    const targetGraveId =
      (selectedSlot && selectedSlot.grave_id) ||
      activeGraveId ||
      addOriginalGraveId ||
      null;

    if (!graveCode && !isInactive) {
      graveCode = pick(activeOriginalValues.grave_code, addOriginalGraveCode);
    }

    if (!isInactive && !graveCode) {
      warn("Grave Code is missing.");
      return;
    }

    recalcExpirationFromInterment();

    const expirationDate = getExpirationField()?.value || null;

    const payload = {
      control_number: controlNo,
      deceased_name:
        modalEl.querySelector("#deceased_name")?.value.trim() || "",
      deceased_sex: modalEl.querySelector("#deceased_sex")?.value || "",
      deceased_date_of_birth:
        modalEl.querySelector("#deceased_date_of_birth")?.value || null,
      deceased_date_of_death:
        modalEl.querySelector("#deceased_date_of_death")?.value || null,
      last_known_address:
        modalEl.querySelector("#last_known_address")?.value.trim() || "",
      death_certificate:
        modalEl.querySelector("#death_certificate")?.value.trim() || "",
      contact_person_name:
        modalEl.querySelector("#contact_person_name")?.value.trim() || "",
      contact_person_phone_number: phoneRaw,
      contact_person_email:
        modalEl.querySelector("#contact_person_email")?.value.trim() ||
        "noemail@reserve.local",
      contact_person_address:
        modalEl.querySelector("#contact_person_address")?.value.trim() || "",
      contact_person_address_barangay:
        modalEl.querySelector("#contact_person_address_barangay")?.value || "",
      assistance_type: assistance,
      burial_permit_number:
        modalEl.querySelector("#burial_permit_number")?.value.trim() || "",
      exhumation_permit_number:
        modalEl.querySelector("#exhumation_permit_number")?.value.trim() || "",
      transfer_permit_number:
        modalEl.querySelector("#transfer_permit_number")?.value.trim() || "",
      burial_clearance_date:
        modalEl.querySelector("#burial_clearance_date")?.value || null,
      date_buried: dateBuried,
      lease_expiration_date: expirationDate,
      remarks: modalEl.querySelector("#remarks")?.value.trim() || "",
      block_name: blockName,
      block_type: modalEl.querySelector("#burial_block")?.value || "",
    };

    if (isReplace) {
      const cur = oldOccupantDraft.current || {};
      payload.old_interment_id = activeOldIntermentId;
      payload.old_new_status = cur.old_new_status || "Inactive";
      if (payload.old_new_status === "Active") {
        payload.old_new_grave_code = (cur.old_new_grave_code || "").trim();
      }
      const diff = computeOldDiff(cur, oldOccupantDraft.original);
      if (Object.keys(diff).length) payload.old_edited_fields = diff;
    } else if (isInactive) {
      payload.grave_code = null;
    } else if (targetGraveId) {
      payload.grave_id = targetGraveId;
      payload.grave_code = graveCode;
    } else {
      warn("No target grave could be determined. Please reopen the modal.");
      return;
    }

    newModeSnapshot = readAllFormFields();

    const saveBtn = modalEl.querySelector(".paperSaveBtn");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
    }

    const reEnableSave = () => {
      const btn = modalEl.querySelector(".paperSaveBtn");
      if (btn && !submissionSucceeded) {
        btn.disabled = false;
        btn.textContent = "Save";
      }
    };

    document.dispatchEvent(
      new CustomEvent("reserve_burial_modal:save", {
        detail: {
          mode: "add",
          data: payload,
          onSuccess: () => {
            oldOccupantDraft = null;
            lockAfterSuccess();
          },
          onError: () => reEnableSave(),
        },
      }),
    );
  }

  function close() {
    if (!modalEl) return;

    modalEl.style.display = "none";
    modalEl.classList.remove("active");

    clearBlockChangeTimer();
    gravesToken++;

    selectedSlot = null;
    viewSnapshot = {};

    addOriginalBlock = "";
    addOriginalGraveCode = "";
    addOriginalGraveId = null;
    addOriginalOldIntermentId = null;

    wizardMode = null;
    oldOccupantOriginal = null;
    oldModeSnapshot = null;
    newModeSnapshot = null;
    oldTargetContext = null;

    submissionSucceeded = false;

    unlockFields();

    if (locationHeaderEl && locationHeaderEl.parentNode) {
      locationHeaderEl.parentNode.removeChild(locationHeaderEl);
    }
    locationHeaderEl = null;

    const actions = modalEl.querySelector(".paperFormActions");
    if (actions) {
      actions.querySelectorAll(".paperNextBtn").forEach((n) => n.remove());
      actions.querySelectorAll(".paperBackBtn").forEach((b) => b.remove());
    }
    nextBtn = null;
    backBtn = null;

    const form = modalEl.querySelector("#burial_clearance_form");
    if (form) form.style.display = "";

    const saveBtn = modalEl.querySelector(".paperSaveBtn");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      saveBtn.type = "submit";
      saveBtn.style.display = "";
    }

    const cancelBtn = modalEl.querySelector(".paperCancelBtn");
    if (cancelBtn) {
      cancelBtn.style.display = "";
      cancelBtn.textContent = "Cancel";
    }

    removePendingFromStatus();
  }

  return { open, close };
})();

window.ReserveBurialModal = ReserveBurialModal;
window.closeReserveBurialModal = () => ReserveBurialModal.close();

window.openReserveBurialModal = (item, options) =>
  ReserveBurialModal.open("add", item, options);
window.openViewBurialModal = (item, options) =>
  ReserveBurialModal.open("view", item, options);
window.openEditOldOccupantModal = (item, options) =>
  ReserveBurialModal.open("edit-old", item, options);
