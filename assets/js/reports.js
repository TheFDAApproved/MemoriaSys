/* =========================================================================
   MEMORIA — Reports (Refactored Master Card Edition)
   Sections:
     1. Constants, helpers, filter state, filter groups
     2. Dropdown behavior
     3. Report switching
     4. Filter engine (toggle / change / clear / debounced reload)
     5. Data fetching
     6. Render functions
     7. Branding (settings, signatories, year options, payment options)
     8. Bootstrap
   ========================================================================= */

/* -------------------------------------------------------------------------
   1. CONSTANTS, HELPERS, FILTER STATE
   ------------------------------------------------------------------------- */

const API_ENDPOINT = "api/reports.php";
const SETTINGS_ENDPOINT = "api/settings.php";
const DEBOUNCE_MS = 350;

const LOADER_SHOW_DELAY_MS = 1000;
const LOADER_MIN_VISIBLE_MS = 1000;

const requestTokens = Object.create(null);
const loaderShowTimers = Object.create(null);
const loaderShownAt = Object.create(null);
const loaderVisible = Object.create(null);

let currentReportScope = "interments";
let paymentOptionsLoaded = false;
const settingsMap = Object.create(null);

const filterState = {
  interments: { address: "", gender: "", year: "", contact: "" },
  graves: { status: "" },
  payments: {
    purpose: "",
    channel: "",
    status: "",
    amount_min: "",
    amount_max: "",
    search: "",
  },
};

const FILTER_GROUPS = {
  interments: {
    address: ["address"],
    gender: ["gender"],
    year: ["year"],
    contact: ["contact"],
  },
  graves: {
    status: ["status"],
  },
  payments: {
    purpose: ["purpose"],
    channel: ["channel"],
    status: ["status"],
    amount: ["amount_min", "amount_max"],
    search: ["search"],
  },
};

const debounceTimers = new Map();

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return esc(value);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function fmtMonthYear(value) {
  if (!value) return "Unknown Date";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown Date";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function fmtPeso(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "₱0.00";
  return (
    "₱" +
    n.toLocaleString("en-PH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function activeFiltersFor(scope) {
  const state = filterState[scope] || {};
  const out = {};
  for (const [key, value] of Object.entries(state)) {
    if (value !== "" && value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function buildReportUrl(scope, overrideFilters) {
  const params = new URLSearchParams();
  params.set("report", scope);

  const filters = overrideFilters ?? activeFiltersFor(scope);
  for (const [key, value] of Object.entries(filters)) {
    params.set(`f[${key}]`, value);
  }
  return `${API_ENDPOINT}?${params.toString()}`;
}

/* -------------------------------------------------------------------------
   2. DROPDOWN BEHAVIOR
   ------------------------------------------------------------------------- */

function toggleDropdown() {
  const dd = document.getElementById("customDropdown");
  if (!dd) return;
  const open = dd.classList.toggle("open");
  const trigger = dd.querySelector(".customSelectTrigger");
  if (trigger) trigger.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeDropdown() {
  const dd = document.getElementById("customDropdown");
  if (!dd) return;
  dd.classList.remove("open");
  const trigger = dd.querySelector(".customSelectTrigger");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

window.addEventListener("click", (e) => {
  const dd = document.getElementById("customDropdown");
  if (!dd) return;
  if (!dd.contains(e.target)) closeDropdown();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDropdown();
});

function selectOption(element, reportTitle) {
  if (!element) return;
  const value = element.getAttribute("data-value");
  if (!value) return;

  document
    .querySelectorAll(".customOptionRow")
    .forEach((row) => row.classList.remove("active"));
  element.classList.add("active");

  const content = element.querySelector(".optionContent");
  const target = document.getElementById("selectedOptionTarget");
  if (content && target) target.innerHTML = content.innerHTML;

  // Update Master Card Title
  if (reportTitle) {
    const titleTarget = document.getElementById("report-dynamic-title");
    if (titleTarget) titleTarget.textContent = reportTitle;
  }

  closeDropdown();
  switchReport(value);
}

/* -------------------------------------------------------------------------
   3. REPORT SWITCHING
   ------------------------------------------------------------------------- */

async function switchReport(reportId) {
  currentReportScope = reportId;

  // 1. Swap visibility of inner report sections inside the master card
  document.querySelectorAll(".docSection").forEach((section) => {
    section.style.display = "none";
  });
  const activeSection = document.getElementById(reportId + "-content");
  if (activeSection) activeSection.style.display = "block";

  // 2. Toggle appropriate filter panels
  document
    .querySelectorAll(".filterEngineContainer")
    .forEach((panel) => panel.classList.remove("visible"));

  const panel = document.getElementById("filter-panel-" + reportId);
  if (panel) panel.classList.add("visible");

  // 3. Lazy-load payment options the first time the payments report opens
  if (reportId === "payments" && !paymentOptionsLoaded) {
    await loadPaymentOptions();
    paymentOptionsLoaded = true;
  }

  await loadReportData(reportId);
}

/* -------------------------------------------------------------------------
   4. FILTER ENGINE
   ------------------------------------------------------------------------- */

function toggleFilter(scope, pillName) {
  const state = filterState[scope];
  const groups = FILTER_GROUPS[scope];
  if (!state || !groups) return;

  const keys = groups[pillName] || [pillName];
  const pill = document.querySelector(
    `#${scope}-pills .filterPill[data-filter="${pillName}"]`,
  );
  const block = document.getElementById(`${scope}-filter-${pillName}`);

  if (!pill || !block) return;

  const isActive = pill.classList.toggle("active");
  block.classList.toggle("visible", isActive);

  if (!isActive) {
    for (const key of keys) {
      state[key] = "";
      cancelDebounce(scope, key);
      const input = document.getElementById(`${scope}-input-${key}`);
      if (input) input.value = "";
    }
  }

  scheduleReload(scope, pillName);
}

function onFilterValueChange(scope, filterName, value) {
  const state = filterState[scope];
  if (!state) return;

  state[filterName] = value ?? "";
  const input = document.getElementById(`${scope}-input-${filterName}`);
  const isTextInput = input && input.tagName === "INPUT";

  if (isTextInput) {
    scheduleReload(scope, filterName);
  } else {
    cancelDebounce(scope, filterName);
    loadReportData(scope);
  }
}

function clearAllFilters(scope) {
  const state = filterState[scope];
  const groups = FILTER_GROUPS[scope];
  if (!state || !groups) return;

  for (const [pillName, keys] of Object.entries(groups)) {
    const pill = document.querySelector(
      `#${scope}-pills .filterPill[data-filter="${pillName}"]`,
    );
    if (pill) pill.classList.remove("active");

    const block = document.getElementById(`${scope}-filter-${pillName}`);
    if (block) block.classList.remove("visible");

    for (const key of keys) {
      state[key] = "";
      cancelDebounce(scope, key);
      const input = document.getElementById(`${scope}-input-${key}`);
      if (input) input.value = "";
    }
  }

  loadReportData(scope);
}

function scheduleReload(scope, filterName) {
  const key = `${scope}:${filterName || "_"}`;
  cancelDebounce(scope, filterName);

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    loadReportData(scope);
  }, DEBOUNCE_MS);

  debounceTimers.set(key, timer);
}

function cancelDebounce(scope, filterName) {
  const key = `${scope}:${filterName || "_"}`;
  const existing = debounceTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    debounceTimers.delete(key);
  }
}

/* -------------------------------------------------------------------------
   5. DATA FETCHING
   ------------------------------------------------------------------------- */

async function loadReportData(scope) {
  const container = document.getElementById(`${scope}-content`);
  if (!container) return;

  const token = (requestTokens[scope] = (requestTokens[scope] || 0) + 1);

  clearTimeout(loaderShowTimers[scope]);
  loaderShowTimers[scope] = null;
  loaderVisible[scope] = false;
  loaderShownAt[scope] = 0;

  const hasContent = container.classList.contains("has-content");

  if (!hasContent) {
    container.innerHTML = `
      <div class="loadingPlaceholder">
        <i class="fas fa-spinner fa-spin"></i>
        <span>Loading report data…</span>
      </div>`;
    container.classList.remove("is-loading");
  } else {
    loaderShowTimers[scope] = setTimeout(() => {
      if (requestTokens[scope] !== token) return;
      if (!container.classList.contains("has-content")) return;

      container.classList.add("is-loading");
      loaderShownAt[scope] = Date.now();
      loaderVisible[scope] = true;
    }, LOADER_SHOW_DELAY_MS);
  }

  updateGenerationDate();

  const url = buildReportUrl(scope);
  let payload = null;
  let errorMessage = null;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (requestTokens[scope] !== token) return;

    if (res.status === 401 || res.status === 403) {
      errorMessage = "Session expired or unauthorized. Please log in again.";
    } else if (!res.ok) {
      throw new Error("HTTP " + res.status);
    } else {
      const json = await res.json();
      if (requestTokens[scope] !== token) return;

      if (!json || json.status !== 200) {
        errorMessage = json?.message || "No data available.";
      } else {
        payload = json.data || {};
      }
    }
  } catch (err) {
    if (requestTokens[scope] !== token) return;
    console.error("Report fetch failed:", err);
    errorMessage = "Connection error. Please try again later.";
  }

  if (requestTokens[scope] !== token) return;

  if (loaderVisible[scope]) {
    const elapsed = Date.now() - (loaderShownAt[scope] || 0);
    if (elapsed < LOADER_MIN_VISIBLE_MS) {
      await new Promise((r) => setTimeout(r, LOADER_MIN_VISIBLE_MS - elapsed));
      if (requestTokens[scope] !== token) return;
    }
  }

  if (errorMessage !== null) {
    container.innerHTML = `<div class="noDataFallbackMessage visible">${esc(errorMessage)}</div>`;
    container.classList.add("has-content");
  } else {
    switch (scope) {
      case "capacity":
        renderCapacity(payload, container);
        break;
      case "expirations":
        renderExpirations(payload, container);
        break;
      case "interments":
        renderInterments(payload, container);
        break;
      case "graves":
        renderGraves(payload, container);
        break;
      case "payments":
        renderPayments(payload, container);
        break;
      default:
        container.innerHTML = `<div class="noDataFallbackMessage visible">Unknown report scope.</div>`;
    }
    container.classList.add("has-content");
  }

  clearTimeout(loaderShowTimers[scope]);
  loaderShowTimers[scope] = null;
  loaderVisible[scope] = false;
  loaderShownAt[scope] = 0;
  container.classList.remove("is-loading");
}

function updateGenerationDate() {
  const meta = document.querySelector(".docMetaSummary");
  if (!meta) return;

  const name = settingsMap["cemetery_name"] || "Mandaue City Public Cemetery";
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  meta.textContent = `${name} • Generated on: ${dateStr}`;
}

/* -------------------------------------------------------------------------
   6. RENDER FUNCTIONS
   ------------------------------------------------------------------------- */

function renderCapacity(data, container) {
  const summary = data.summary || {};
  const total = Number(summary.total_graves) || 0;
  const occupied = Number(summary.occupied) || 0;
  const vacant = Number(summary.vacant) || 0;

  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : "0.0");

  let html = `
    <div class="docBlockHeader">Overall Cemetery Status</div>
    <table class="cleanTable">
      <thead>
        <tr>
          <th>Metric</th>
          <th>Count</th>
          <th>Share</th>
        </tr>
      </thead>
      <tbody>
        <tr><td><strong>Total Graves</strong></td><td>${total}</td><td>100.0%</td></tr>
        <tr><td><strong>Occupied</strong></td><td>${occupied}</td><td>${pct(occupied)}%</td></tr>
        <tr><td><strong>Vacant</strong></td><td>${vacant}</td><td>${pct(vacant)}%</td></tr>
      </tbody>
    </table>

    <div class="docBlockHeader">Breakdown by Block</div>
    <table class="cleanTable">
      <thead>
        <tr>
          <th>Block</th>
          <th>Type</th>
          <th>Total</th>
          <th>Occupied</th>
          <th>Vacant</th>
        </tr>
      </thead>
      <tbody>`;

  const blocks = Array.isArray(data.by_block) ? data.by_block : [];
  if (blocks.length === 0) {
    html += `<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No blocks on record.</td></tr>`;
  } else {
    for (const b of blocks) {
      html += `<tr>
        <td><strong>${esc(b.block_name)}</strong></td>
        <td>${esc(b.block_type)}</td>
        <td>${Number(b.total_graves) || 0}</td>
        <td>${Number(b.occupied) || 0}</td>
        <td>${Number(b.vacant) || 0}</td>
      </tr>`;
    }
  }

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function renderExpirations(data, container) {
  const expired = Array.isArray(data.expired) ? data.expired : [];
  const expiring = Array.isArray(data.expiring) ? data.expiring : [];
  const days = Number(data?.filters?.days) || 30;

  if (expired.length === 0 && expiring.length === 0) {
    container.innerHTML = `<div class="noDataFallbackMessage visible">No expired or expiring leases at this time.</div>`;
    return;
  }

  const renderRow = (it) => {
    const contactName = it.contact_person_name || "No contact person";
    const phone = it.contact_person_phone_number || "—";
    return `<div class="bulletItem">
      <strong>Grave ${esc(it.grave_code || "Unassigned")}</strong>
      <div class="itemDetailBlock">
        <strong>Deceased Name:</strong> ${esc(it.deceased_name || "Unknown")}<br />
        <strong>Lease Expiration Date:</strong> ${fmtDate(it.lease_expiration_date)}<br />
        <strong>Contact Person:</strong> ${esc(contactName)}<br />
        <strong>Contact Phone Number:</strong> ${esc(phone)}<br />
        <strong>Remarks:</strong> ${esc(it.remarks || "None on file")}
      </div>
    </div>`;
  };

  let html = "";
  if (expired.length > 0) {
    html += `<div class="docBlockHeader danger">Already Expired — Action Required</div>`;
    html += expired.map(renderRow).join("");
  }
  if (expiring.length > 0) {
    html += `<div class="docBlockHeader warning">Expiring Within ${days} Days</div>`;
    html += expiring.map(renderRow).join("");
  }

  container.innerHTML = html;
}

function renderInterments(data, container) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length === 0) {
    container.innerHTML = `<div class="noDataFallbackMessage visible">No records match the selected filters.</div>`;
    return;
  }

  const groups = new Map();
  for (const row of rows) {
    const key = fmtMonthYear(row.date_buried || row.date_of_death);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let html = "";
  for (const [monthYear, items] of groups.entries()) {
    html += `<div class="docBlockHeader">${esc(monthYear)}</div>`;

    for (const it of items) {
      const contactName = it.contact_person_name || "No contact person on file";
      const contactPhone = it.contact_person_phone || "";
      const contactEmail = it.contact_person_email || "";
      const contactAddressParts = [
        it.contact_person_barangay,
        it.contact_person_address,
      ].filter(Boolean);
      const contactAddress =
        contactAddressParts.length > 0
          ? contactAddressParts.join(", ")
          : "Not provided";
      const deceasedAddress = it.deceased_address || "Not provided";
      const location = it.location || it.grave_code || "Unassigned grave";
      const contactLine = contactPhone
        ? `${esc(contactName)} — ${esc(contactPhone)}`
        : esc(contactName);

      html += `<div class="bulletItem">
        <strong>${esc(it.deceased_name || "Unknown")}</strong>
        <div class="itemDetailBlock">
          <strong>Date of Birth:</strong> ${fmtDate(it.date_of_birth)}<br />
          <strong>Date of Death:</strong> ${fmtDate(it.date_of_death)}<br />
          <strong>Date Buried:</strong> ${fmtDate(it.date_buried)}<br />
          <strong>Gender:</strong> ${esc(it.gender || "Unknown")}<br />
          <strong>Grave Location:</strong> ${esc(location)}<br />
          <strong>Deceased's Last Known Address:</strong> ${esc(deceasedAddress)}<br />
          <strong>Contact Person:</strong> ${contactLine}<br />
          ${contactEmail ? `<strong>Contact Email:</strong> ${esc(contactEmail)}<br />` : ""}
          <strong>Contact Person Address:</strong> ${esc(contactAddress)}<br />
          <strong>Lease Expiration:</strong> ${fmtDate(it.lease_expiration_date)}<br />
          <strong>Status:</strong> ${esc(it.status || "Unknown")}
          ${it.remarks ? `<br /><strong>Remarks:</strong> ${esc(it.remarks)}` : ""}
        </div>
      </div>`;
    }
  }

  container.innerHTML = html;
}

function renderGraves(data, container) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length === 0) {
    container.innerHTML = `<div class="noDataFallbackMessage visible">No grave records match the selected filter.</div>`;
    return;
  }

  const colors = { Vacant: "#16a34a", Occupied: "#2563eb" };
  const total = Number(data.total_records) || rows.length;

  let html = `<div class="docBlockHeader">Grave Registry — ${rows.length} of ${total} record${total === 1 ? "" : "s"}</div>`;

  for (const it of rows) {
    const color = colors[it.status] || "#64748b";
    const blockLine =
      it.block_name && it.block_name !== "N/A"
        ? `${esc(it.block_name)} (${esc(it.block_type || "N/A")})`
        : "Unassigned block";

    const position =
      it.row_num !== null || it.col_num !== null
        ? `Row ${it.row_num ?? "—"} / Column ${it.col_num ?? "—"}`
        : null;

    html += `<div class="bulletItem">
      <strong>Grave Code: ${esc(it.grave_code || "N/A")}</strong>
      <div class="itemDetailBlock">
        <strong>Status:</strong> <span style="color:${color};font-weight:600;">${esc(it.status || "Unknown")}</span><br />
        <strong>Block Section:</strong> ${blockLine}<br />
        ${position ? `<strong>Position:</strong> ${esc(position)}<br />` : ""}
        <strong>Remarks:</strong> ${esc(it.remarks || "None on file")}
      </div>
    </div>`;
  }

  container.innerHTML = html;
}

function renderPayments(data, container) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const summary = data.summary || {};

  const totalPayments = Number(summary.total_payments) || 0;
  const totalAmount = Number(summary.total_amount) || 0;
  const pendingCount = Number(summary.pending_count) || 0;
  const partialCount = Number(summary.partial_count) || 0;
  const confirmedCount = Number(summary.confirmed_count) || 0;

  let html = `
    <div class="paymentSummaryGrid">
      <div class="paymentSummaryCell">
        <span class="cellLabel">Total Payments</span>
        <span class="cellValue">${totalPayments}</span>
        <span class="cellSub">${esc(fmtPeso(totalAmount))} collected</span>
      </div>
      <div class="paymentSummaryCell">
        <span class="cellLabel">Pending / Partial</span>
        <span class="cellValue">${pendingCount} / ${partialCount}</span>
        <span class="cellSub">Awaiting confirmations</span>
      </div>
      <div class="paymentSummaryCell">
        <span class="cellLabel">Confirmed</span>
        <span class="cellValue">${confirmedCount}</span>
        <span class="cellSub">Fully signed</span>
      </div>
    </div>`;

  if (rows.length === 0) {
    html += `<div class="noDataFallbackMessage visible">No payment records match the selected filters.</div>`;
    container.innerHTML = html;
    return;
  }

  html += `<div class="docBlockHeader">Payment Records (${rows.length} shown)</div>`;

  for (const it of rows) {
    const statusClass =
      it.status === "Confirmed"
        ? "statusConfirmed"
        : it.status === "Partial"
          ? "statusPartial"
          : "statusPending";
    const payerLine = it.payers_name
      ? esc(it.payers_name)
      : "No payer name on file";
    const payerContact = [it.payers_phone_number, it.payers_email]
      .filter(Boolean)
      .map(esc)
      .join(" — ");
    const officeBy = it.office_confirmer_name
      ? esc(it.office_confirmer_name)
      : "Not yet confirmed";
    const groundsBy = it.grounds_confirmer_name
      ? esc(it.grounds_confirmer_name)
      : "Not yet confirmed";

    const remarkLines = [];
    if (it.remarks_payer)
      remarkLines.push(
        `<strong>Payer Remarks:</strong> ${esc(it.remarks_payer)}`,
      );
    if (it.remarks_office)
      remarkLines.push(
        `<strong>Office Remarks:</strong> ${esc(it.remarks_office)}`,
      );
    if (it.remarks_grounds)
      remarkLines.push(
        `<strong>Grounds Remarks:</strong> ${esc(it.remarks_grounds)}`,
      );
    const remarksHtml = remarkLines.length
      ? `<br />${remarkLines.join("<br />")}`
      : "";

    html += `<div class="bulletItem">
      <strong>Ref. No. ${esc(it.reference_number || "—")}</strong>
      &nbsp;|&nbsp;
      <span class="${statusClass}">${esc(it.status)}</span>
      &nbsp;|&nbsp;
      <strong>${esc(fmtPeso(it.amount))}</strong>
      <div class="itemDetailBlock">
        <strong>Purpose:</strong> ${esc(it.purpose || "—")}<br />
        <strong>Payment Channel:</strong> ${esc(it.payment_channel || "—")}<br />
        <strong>Payer:</strong> ${payerLine}${payerContact ? ` (${payerContact})` : ""}<br />
        ${it.deceased_name ? `<strong>Deceased Name:</strong> ${esc(it.deceased_name)}<br />` : ""}
        <strong>Confirmed by Office Staff:</strong> ${officeBy}<br />
        <strong>Confirmed by Grounds Staff:</strong> ${groundsBy}<br />
        <strong>Recorded:</strong> ${fmtDate(it.created_at)}${remarksHtml}
      </div>
    </div>`;
  }

  container.innerHTML = html;
}

/* -------------------------------------------------------------------------
   7. BRANDING
   ------------------------------------------------------------------------- */

async function loadReportBranding() {
  try {
    const res = await fetch(SETTINGS_ENDPOINT, { cache: "no-store" });
    if (!res.ok) throw new Error("Settings unavailable");

    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];

    for (const setting of list) {
      if (setting && setting.setting_key) {
        settingsMap[setting.setting_key] = String(
          setting.setting_value || "",
        ).trim();
      }
    }
  } catch (err) {
    console.warn("Branding unavailable, using fallbacks.", err);
  } finally {
    bindReportSignatories(settingsMap);
  }
}

function bindReportSignatories(map) {
  document.querySelectorAll(".sigContainer").forEach((slot, index) => {
    const slotIndex = index % 4;
    const name = map[`people_name_${slotIndex + 1}`] || "";
    const title = map[`people_title_${slotIndex + 1}`] || "";

    const nameEl = slot.querySelector(".sigName");
    const titleEl = slot.querySelector(".sigTitle");
    if (nameEl) nameEl.textContent = name;
    if (titleEl) titleEl.textContent = title;
  });
}

async function loadYearOptions() {
  const select = document.getElementById("interments-input-year");
  if (!select) return;

  try {
    const res = await fetch(`${API_ENDPOINT}?report=years`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);

    const json = await res.json();
    const years = Array.isArray(json?.data?.years) ? json.data.years : [];
    if (years.length === 0) return;

    const previous = select.value;
    select.innerHTML =
      '<option value="">Any year</option>' +
      years.map((y) => `<option value="${esc(y)}">${esc(y)}</option>`).join("");

    if (years.map(String).includes(previous)) select.value = previous;
  } catch (err) {
    console.warn("Year options unavailable, keeping defaults.", err);
  }
}

async function loadPaymentOptions() {
  const purposeSelect = document.getElementById("payments-input-purpose");
  const channelSelect = document.getElementById("payments-input-channel");
  if (!purposeSelect && !channelSelect) return;

  try {
    const res = await fetch(`${API_ENDPOINT}?report=payment_options`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);

    const json = await res.json();
    const purposes = Array.isArray(json?.data?.purposes)
      ? json.data.purposes
      : [];
    const channels = Array.isArray(json?.data?.channels)
      ? json.data.channels
      : [];

    if (purposeSelect && purposes.length > 0) {
      const prev = purposeSelect.value;
      purposeSelect.innerHTML =
        '<option value="">Any purpose</option>' +
        purposes
          .map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)
          .join("");
      if (purposes.includes(prev)) purposeSelect.value = prev;
    }

    if (channelSelect && channels.length > 0) {
      const prev = channelSelect.value;
      channelSelect.innerHTML =
        '<option value="">Any channel</option>' +
        channels
          .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
          .join("");
      if (channels.includes(prev)) channelSelect.value = prev;
    }
  } catch (err) {
    console.warn("Payment options unavailable, keeping defaults.", err);
  }
}

/* -------------------------------------------------------------------------
   8. BOOTSTRAP
   ------------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
  await loadReportBranding();
  await loadYearOptions();
  await switchReport("interments");
});
