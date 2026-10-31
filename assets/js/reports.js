const API_ENDPOINT = "api/reports.php";
const SETTINGS_ENDPOINT = "api/settings.php";
const DEBOUNCE_MS = 350;
const LOADER_SHOW_DELAY_MS = 1000;
const LOADER_MIN_VISIBLE_MS = 1000;
const DEFAULT_PER_PAGE = 500;

const RESOURCE_PATHS = {
    capacity: "cemetery_capacity",
    expirations: "lease_expirations",
    interments: "interments",
    graves: "graves",
    payments: "payments",
};

// Runtime State
const requestTokens = Object.create(null);
const loaderShowTimers = Object.create(null);
const loaderShownAt = Object.create(null);
const loaderVisible = Object.create(null);

let currentReportScope = "interments";
let filterOptionsCache = null;

// Settings loaded from the server [cemetery name, signatories, etc.]
const settingsMap = Object.create(null);

// Current filter values for each report type
const filterState = {
    interments: {
        address: "",
        gender: "",
        barangay: "",
        start_date: "",
        end_date: "",
        contact: "",
    },
    expirations: {
        start_date: "",
        end_date: "",
        days: "",
        show: "",
    },
    graves: {
        status: "",
    },
    payments: {
        purpose: "",
        channel: "",
        status: "",
        start_date: "",
        end_date: "",
        minamount: "",
        maxamount: "",
        search: "",
    },
};

// Maps each "pill" [filter group toggle] to the filter keys it controls
// Used to clear state when a pill is turned off
const FILTER_GROUPS = {
    interments: {
        address: ["address"],
        gender: ["gender"],
        barangay: ["barangay"],
        date_range: ["start_date", "end_date"],
        contact: ["contact"],
    },
    expirations: {
        date_range: ["start_date", "end_date"],
        days: ["days"],
        show: ["show"],
    },
    graves: {
        status: ["status"],
    },
    payments: {
        purpose: ["purpose"],
        channel: ["channel"],
        status: ["status"],
        date_range: ["start_date", "end_date"],
        amount: ["minamount", "maxamount"],
        search: ["search"],
    },
};

// Maps a scope + pill name to the IDs of any hint/error <p> elements
const PILL_HINTS = {
    interments: {
        date_range: ["interments-date-hint"],
    },
    expirations: {
        date_range: ["expirations-date-hint"],
        days: ["expirations-days-hint"],
    },
    payments: {
        date_range: ["payments-date-hint"],
        amount: ["payments-amount-hint"],
    },
};

const paginationState = {
    interments: { page: 1 },
    expirations: { page: 1 },
    graves: { page: 1 },
    payments: { page: 1 },
};

// Pending debounce timers keyed by "scope:filterName"
const debounceTimers = new Map();

const GENERIC_ERROR = "Something went wrong. Please try again.";

// Utility; Error Message Sanitizing
// Returns true when a string looks like a raw technical error
// [HTML tags, stack traces, network messages, or just too long]
// Used to swap such messages for a friendly fallback
function looksRawMessage(text) {
    if (!text) return true;
    const t = String(text).trim();
    if (!t) return true;
    if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;
    if (/ERR_NGROK_|ngrok/i.test(t)) return true;
    if (/^HTTP\s+\d{3}/i.test(t)) return true;
    if (
        /non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(
            t,
        )
    )
        return true;
    if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
    if (
        /^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(t)
    )
        return true;
    if (t.length > 200) return true;
    return false;
}

function friendlyMessage(raw, fallback) {
    if (!raw) return fallback || GENERIC_ERROR;
    const s = String(raw).trim();
    if (!s || looksRawMessage(s)) return fallback || GENERIC_ERROR;
    return s;
}

// Utility formating
// Escape HTML special characters so user data can be safely injected into innerHTML templates
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

function resetPage(scope) {
    if (paginationState[scope]) paginationState[scope].page = 1;
}

// URL builder
function buildReportUrl(scope) {
    const path = RESOURCE_PATHS[scope] || scope;
    const params = new URLSearchParams();
    const state = filterState[scope] || {};

    if (scope === "expirations") {
        // Expirations need the "show" toggle translated into explicit expired/expiring flags
        const show = state.show || "";
        if (show === "expired") {
            params.set("expired", "true");
            params.set("expiring", "false");
        } else if (show === "expiring") {
            params.set("expired", "false");
            params.set("expiring", "true");
        }
        if (state.start_date) params.set("start_date", state.start_date);
        if (state.end_date) params.set("end_date", state.end_date);
        if (state.days !== "" && state.days !== null && state.days !== undefined) {
            params.set("days", state.days);
        }
    } else {
        for (const [key, value] of Object.entries(state)) {
            if (value !== "" && value !== null && value !== undefined) {
                params.set(key, value);
            }
        }
    }

    // Capacity has no pagination.
    if (scope !== "capacity") {
        const pag = paginationState[scope] || { page: 1 };
        params.set("page", String(pag.page || 1));
        params.set("limit", String(DEFAULT_PER_PAGE));
    }

    const qs = params.toString();
    return `${API_ENDPOINT}/${path}${qs ? "?" + qs : ""}`;
}

// Custom Dropdown [report type selector]
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

// Close when clicking outside the dropdown
window.addEventListener("click", (e) => {
    const dd = document.getElementById("customDropdown");
    if (!dd) return;
    if (!dd.contains(e.target)) closeDropdown();
});

// Close on Escape
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

    // Mirror the chosen row's label into the trigger button
    const content = element.querySelector(".optionContent");
    const target = document.getElementById("selectedOptionTarget");
    if (content && target) target.innerHTML = content.innerHTML;

    if (reportTitle) {
        const titleTarget = document.getElementById("report-dynamic-title");
        if (titleTarget) titleTarget.textContent = reportTitle;
    }

    closeDropdown();
    switchReport(value);
}

// Report switching
async function switchReport(reportId) {
    currentReportScope = reportId;

    document.querySelectorAll(".docSection").forEach((s) => {
        s.style.display = "none";
    });
    const activeSection = document.getElementById(reportId + "-content");
    if (activeSection) activeSection.style.display = "block";

    document.querySelectorAll(".paginationBar").forEach((bar) => {
        bar.style.display = "none";
    });

    document
        .querySelectorAll(".filterEngineContainer")
        .forEach((p) => p.classList.remove("visible"));
    const panel = document.getElementById("filter-panel-" + reportId);
    if (panel) panel.classList.add("visible");

    await loadReportData(reportId, { immediate: true });
}

// Hint [inline error] helpers
function setHint(id, message) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
}

function hideHintsForPill(scope, pillName) {
    const ids = (PILL_HINTS[scope] || {})[pillName] || [];
    for (const id of ids) setHint(id, "");
}

function hideAllHints(scope) {
    const map = PILL_HINTS[scope] || {};
    for (const ids of Object.values(map)) {
        for (const id of ids) setHint(id, "");
    }
}

// Filter validation
function validateDateRange(scope) {
    const startEl = document.getElementById(`${scope}-input-start_date`);
    const endEl = document.getElementById(`${scope}-input-end_date`);
    const hintId = `${scope}-date-hint`;
    if (!startEl || !endEl) return true;

    const s = startEl.value;
    const e = endEl.value;

    if (s && e && s > e) {
        setHint(hintId, "Start date cannot be after end date.");
        return false;
    }
    setHint(hintId, "");
    return true;
}

function validateExpirationDays() {
    const input = document.getElementById("expirations-input-days");
    if (!input) return true;
    const hintId = "expirations-days-hint";

    const raw = String(input.value).trim();
    if (raw === "") {
        setHint(hintId, "");
        return true;
    }

    if (!/^-?\d+$/.test(raw)) {
        setHint(hintId, "Days must be a whole number.");
        return false;
    }

    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) {
        setHint(hintId, "Days must be a whole number.");
        return false;
    }
    if (n < 0 || n > 365) {
        setHint(hintId, "Days must be between 0 and 365.");
        return false;
    }

    setHint(hintId, "");
    return true;
}

function checkPaymentsAmountValidity() {
    const minEl = document.getElementById("payments-input-minamount");
    const maxEl = document.getElementById("payments-input-maxamount");
    if (!minEl || !maxEl) return true;

    const minVal = parseFloat(minEl.value);
    const maxVal = parseFloat(maxEl.value);

    if (Number.isFinite(minVal) && Number.isFinite(maxVal) && minVal > maxVal) {
        setHint(
            "payments-amount-hint",
            "Minimum amount cannot be greater than maximum amount.",
        );
        return false;
    }
    setHint("payments-amount-hint", "");
    return true;
}

// Runs every validator that applies to a given report scope
function validateAllFilters(scope) {
    let ok = true;

    if (
        scope === "interments" ||
        scope === "expirations" ||
        scope === "payments"
    ) {
        if (!validateDateRange(scope)) ok = false;
    }

    if (scope === "expirations") {
        if (!validateExpirationDays()) ok = false;
    }

    if (scope === "payments") {
        if (!checkPaymentsAmountValidity()) ok = false;
    }

    return ok;
}

// Filter interactions
function resetCheckboxGroup(scope, pillName) {
    const grp = document.getElementById(`${scope}-${pillName}-checkboxes`);
    if (!grp) return;
    grp
        .querySelectorAll('input[type="checkbox"]')
        .forEach((cb) => (cb.checked = false));
}

// Toggles a pill on/off. When turned off, its filter state is cleared and the report reloads
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
            if (input) {
                if (input.type === "checkbox") input.checked = false;
                else input.value = "";
            }
        }
        resetCheckboxGroup(scope, pillName);
        hideHintsForPill(scope, pillName);
    }

    resetPage(scope);
    scheduleReload(scope, pillName);
}

// Called by text/number/date inputs. Selects and dates apply immediately; text and numbers go through the debounce path
function onFilterValueChange(scope, filterName, value) {
    const state = filterState[scope];
    if (!state) return;

    state[filterName] = value ?? "";

    // Any filter change goes back to page 1
    resetPage(scope);

    if (!validateAllFilters(scope)) return;

    const input = document.getElementById(`${scope}-input-${filterName}`);
    const immediate =
        input && (input.tagName === "SELECT" || input.type === "date");

    if (immediate) {
        cancelDebounce(scope, filterName);
        loadReportData(scope);
    } else {
        scheduleReload(scope, filterName);
    }
}

function onGravesStatusChange() {
    const grp = document.getElementById("graves-status-checkboxes");
    if (!grp) return;
    const checked = Array.from(
        grp.querySelectorAll('input[type="checkbox"]:checked'),
    ).map((el) => el.value);
    filterState.graves.status = checked.join(",");
    resetPage("graves");
    scheduleReload("graves", "status");
}

function onIntermentsGenderChange() {
    const grp = document.getElementById("interments-gender-checkboxes");
    if (!grp) return;
    const checked = Array.from(
        grp.querySelectorAll('input[type="checkbox"]:checked'),
    ).map((el) => el.value);
    filterState.interments.gender = checked.join(",");
    resetPage("interments");
    scheduleReload("interments", "gender");
}

function onIntermentsBarangayChange() {
    const grp = document.getElementById("interments-barangay-checkboxes");
    if (!grp) return;
    const checked = Array.from(
        grp.querySelectorAll('input[type="checkbox"]:checked'),
    ).map((el) => el.value);
    filterState.interments.barangay = checked.join(",");
    resetPage("interments");
    scheduleReload("interments", "barangay");
}

function onPageChange(scope, value) {
    const pag = paginationState[scope];
    if (!pag) return;

    if (!validateAllFilters(scope)) return;

    if (value === "prev") {
        pag.page = Math.max(1, pag.page - 1);
    } else if (value === "next") {
        pag.page = pag.page + 1;
    } else {
        const n = parseInt(value, 10);
        if (Number.isFinite(n) && n >= 1) pag.page = n;
    }

    loadReportData(scope);
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
            if (input) {
                if (input.type === "checkbox") input.checked = false;
                else input.value = "";
            }
        }
        resetCheckboxGroup(scope, pillName);
    }

    hideAllHints(scope);
    resetPage(scope);
    loadReportData(scope);
}

// Debounce helpers
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

// Applied filter summary
function formatDateRangeLabel(start, end) {
    if (start && end) {
        if (start === end) return `on ${fmtDate(start)}`;
        return `${fmtDate(start)} – ${fmtDate(end)}`;
    }
    if (start) return `from ${fmtDate(start)}`;
    return `up to ${fmtDate(end)}`;
}

function buildAppliedFilterParts(scope) {
    if (scope === "capacity") return [];

    const state = filterState[scope] || {};
    const parts = [];

    if (scope === "interments") {
        if (state.address) parts.push(`Address: "${state.address}"`);
        if (state.gender) {
            parts.push(
                `Gender: ${state.gender.split(",").filter(Boolean).join(", ")}`,
            );
        }
        if (state.barangay) {
            parts.push(
                `Barangay: ${state.barangay.split(",").filter(Boolean).join(", ")}`,
            );
        }
        if (state.start_date || state.end_date) {
            parts.push(
                `Burial date: ${formatDateRangeLabel(state.start_date, state.end_date)}`,
            );
        }
        if (state.contact === "has_contact") parts.push("Has contact person");
        else if (state.contact === "no_contact") parts.push("No contact person");
    }

    if (scope === "expirations") {
        if (state.start_date || state.end_date) {
            parts.push(
                `Expiration date: ${formatDateRangeLabel(state.start_date, state.end_date)}`,
            );
        } else if (
            state.days !== "" &&
            state.days !== null &&
            state.days !== undefined
        ) {
            const n = Number(state.days);
            if (Number.isFinite(n)) {
                if (n === 0) parts.push("Expiring today");
                else if (n === 1) parts.push("Expiring today and tomorrow");
                else parts.push(`Expiring within ${n} days`);
            }
        }
        if (state.show === "expired") parts.push("Only expired leases");
        else if (state.show === "expiring") parts.push("Only expiring leases");
    }

    if (scope === "graves") {
        if (state.status) {
            parts.push(
                `Category: ${state.status.split(",").filter(Boolean).join(", ")}`,
            );
        }
    }

    if (scope === "payments") {
        if (state.purpose) parts.push(`Purpose: ${state.purpose}`);
        if (state.channel) parts.push(`Channel: ${state.channel}`);
        if (state.status) {
            const label =
                { pending: "Pending", partial: "Partial", confirmed: "Confirmed" }[
                state.status
                ] || state.status;
            parts.push(`Status: ${label}`);
        }
        if (state.start_date || state.end_date) {
            parts.push(
                `Recorded: ${formatDateRangeLabel(state.start_date, state.end_date)}`,
            );
        }
        const minHas =
            state.minamount !== "" &&
            state.minamount !== null &&
            state.minamount !== undefined;
        const maxHas =
            state.maxamount !== "" &&
            state.maxamount !== null &&
            state.maxamount !== undefined;
        if (minHas && maxHas) {
            parts.push(
                `Amount: ${fmtPeso(state.minamount)} – ${fmtPeso(state.maxamount)}`,
            );
        } else if (minHas) {
            parts.push(`Amount: ≥ ${fmtPeso(state.minamount)}`);
        } else if (maxHas) {
            parts.push(`Amount: ≤ ${fmtPeso(state.maxamount)}`);
        }
        if (state.search) parts.push(`Search: "${state.search}"`);
    }

    return parts;
}

function updateAppliedFilters(scope) {
    const el = document.getElementById("applied-filters");
    if (!el) return;

    const parts = buildAppliedFilterParts(scope);
    if (parts.length === 0) {
        el.innerHTML = "";
        el.style.display = "none";
        return;
    }

    el.innerHTML = `<strong>Filters applied:</strong> ${parts
        .map((p) => esc(p))
        .join(" · ")}`;
    el.style.display = "block";
}

function hideAppliedFilters() {
    const el = document.getElementById("applied-filters");
    if (!el) return;
    el.innerHTML = "";
    el.style.display = "none";
}

// Data loading
async function loadReportData(scope, options = {}) {
    const container = document.getElementById(`${scope}-content`);
    if (!container) return;

    const immediate = options.immediate === true;
    const token = (requestTokens[scope] = (requestTokens[scope] || 0) + 1);

    // Reset any pending loader state for this scope.
    clearTimeout(loaderShowTimers[scope]);
    loaderShowTimers[scope] = null;
    loaderVisible[scope] = false;
    loaderShownAt[scope] = 0;

    const hasContent = container.classList.contains("has-content");

    if (!hasContent) {
        // First load: show a placeholder instead of an empty box
        container.innerHTML = `
      <div class="loadingPlaceholder">
        <i class="fas fa-spinner fa-spin"></i>
        <span>Loading report data…</span>
      </div>`;
        container.classList.remove("is-loading");
    } else if (immediate) {
        // Explicit refresh: dim existing content right away
        container.classList.add("is-loading");
        loaderShownAt[scope] = Date.now();
        loaderVisible[scope] = true;
    } else {
        // Debounced refresh: only show the loader if the request takes longer than LOADER_SHOW_DELAY_MS
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
                errorMessage = friendlyMessage(json?.message, "No data available.");
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

    // If the loader already appeared, keep it visible for at least LOADER_MIN_VISIBLE_MS to avoid a distracting flash
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
        hidePaginationBar(scope);
        hideAppliedFilters();
    } else {
        try {
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
            updateAppliedFilters(scope);

            if (payload && payload.pagination) {
                renderPaginationBar(
                    scope,
                    payload.pagination,
                    Number(payload.returned_records) || 0,
                );
            } else {
                hidePaginationBar(scope);
            }
        } catch (err) {
            console.error("Render failed:", err);
            container.innerHTML = `<div class="noDataFallbackMessage visible">Unable to display report data.</div>`;
            hidePaginationBar(scope);
            hideAppliedFilters();
        }
    }

    // Clean up loader state after rendering
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

// Pagination bar
function hidePaginationBar(scope) {
    const bar = document.getElementById(`${scope}-pagination`);
    if (bar) bar.style.display = "none";
}

function renderPaginationBar(scope, pagination, returnedRecords) {
    const bar = document.getElementById(`${scope}-pagination`);
    if (!bar) return;

    const total = Number(pagination?.total_records) || 0;
    if (total === 0) {
        bar.style.display = "none";
        return;
    }

    const currentPage = Number(pagination.current_page) || 1;
    const perPage = Number(pagination.per_page) || DEFAULT_PER_PAGE;
    const totalPages = Math.max(1, Number(pagination.total_pages) || 1);

    const rangeStart = returnedRecords > 0 ? (currentPage - 1) * perPage + 1 : 0;
    const rangeEnd = Math.min(total, rangeStart + returnedRecords - 1);

    const startEl = bar.querySelector(".paginationRangeStart");
    const endEl = bar.querySelector(".paginationRangeEnd");
    const totalEl = bar.querySelector(".paginationTotalRecords");
    const pagesEl = bar.querySelector(".paginationTotalPages");
    if (startEl) startEl.textContent = String(rangeStart);
    if (endEl) endEl.textContent = String(rangeEnd);
    if (totalEl) totalEl.textContent = String(total);
    if (pagesEl) pagesEl.textContent = String(totalPages);

    const select = bar.querySelector(".pageSelect");
    if (select) {
        let html = "";
        for (let i = 1; i <= totalPages; i++) {
            html += `<option value="${i}"${i === currentPage ? " selected" : ""}>${i}</option>`;
        }
        select.innerHTML = html;
        select.disabled = totalPages <= 1;
    }

    const prevBtn = bar.querySelector(".pagePrevBtn");
    const nextBtn = bar.querySelector(".pageNextBtn");
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;

    bar.style.display = "flex";
}

// Chart helpers
const reportCharts = Object.create(null);

function destroyReportCharts(...keys) {
    for (const key of keys) {
        if (reportCharts[key]) {
            try {
                reportCharts[key].destroy();
            } catch (_) { }
            delete reportCharts[key];
        }
    }
}

const CATEGORY_ORDER = [
    "Vacant",
    "Occupied",
    "Expiring",
    "Expired",
    "Reserved",
    "Other",
];

const CATEGORY_COLORS = {
    Vacant: "#10b981",
    Occupied: "#6366f1",
    Expiring: "#f59e0b",
    Expired: "#ef4444",
    Reserved: "#8b5cf6",
    Other: "#64748b",
};

// Renderers
// Capacity Summary
function renderCapacity(data, container) {
    destroyReportCharts("capacityPie", "capacityLine");

    const summary = data.summary || {};
    const total = Number(summary.total_graves) || 0;
    const occupied = Number(summary.occupied) || 0;
    const vacant = Number(summary.vacant) || 0;
    const expiring = Number(summary.expiring) || 0;
    const expired = Number(summary.expired) || 0;
    const reserved = Number(summary.reserved) || 0;
    const other = Number(summary.other) || 0;

    const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : "0.0");

    let html = `
    <div class="docBlockHeader">Overall Cemetery Status</div>
    <table class="cleanTable">
      <thead>
        <tr><th>Metric</th><th>Count</th><th>Share</th></tr>
      </thead>
      <tbody>
        <tr><td><strong>Total Graves</strong></td><td>${total}</td><td>100.0%</td></tr>
        <tr><td><strong>Occupied</strong></td><td>${occupied}</td><td>${pct(occupied)}%</td></tr>
        <tr><td><strong>Vacant</strong></td><td>${vacant}</td><td>${pct(vacant)}%</td></tr>
        <tr><td><strong>Expiring (within 30 days)</strong></td><td>${expiring}</td><td>${pct(expiring)}%</td></tr>
        <tr><td><strong>Expired</strong></td><td>${expired}</td><td>${pct(expired)}%</td></tr>
        <tr><td><strong>Reserved</strong></td><td>${reserved}</td><td>${pct(reserved)}%</td></tr>
        <tr><td><strong>Other</strong></td><td>${other}</td><td>${pct(other)}%</td></tr>
      </tbody>
    </table>

    <div class="docBlockHeader">Grave Status Distribution</div>
    <div style="display:grid;grid-template-columns:minmax(220px,1fr) minmax(280px,2fr);gap:16px;align-items:stretch;margin-bottom:16px;">
      <div style="position:relative;min-height:260px;"><canvas id="capacity-status-pie"></canvas></div>
      <div style="position:relative;min-height:260px;"><canvas id="capacity-monthly-line"></canvas></div>
    </div>

    <div class="docBlockHeader">Breakdown by Block</div>
    <table class="cleanTable">
      <thead>
        <tr>
          <th>Block</th><th>Type</th><th>Total</th><th>Occupied</th><th>Vacant</th>
          <th>Expiring</th><th>Expired</th><th>Reserved</th><th>Other</th>
        </tr>
      </thead>
      <tbody>`;

    const blocks = Array.isArray(data.by_block) ? data.by_block : [];
    if (blocks.length === 0) {
        html += `<tr><td colspan="9" style="text-align:center;color:#94a3b8;">No blocks on record.</td></tr>`;
    } else {
        for (const b of blocks) {
            html += `<tr>
        <td><strong>${esc(b.block_name)}</strong></td>
        <td>${esc(b.block_type)}</td>
        <td>${Number(b.total_graves) || 0}</td>
        <td>${Number(b.occupied) || 0}</td>
        <td>${Number(b.vacant) || 0}</td>
        <td>${Number(b.expiring) || 0}</td>
        <td>${Number(b.expired) || 0}</td>
        <td>${Number(b.reserved) || 0}</td>
        <td>${Number(b.other) || 0}</td>
      </tr>`;
        }
    }
    html += `</tbody></table>`;

    container.innerHTML = html;
    renderCapacityPieChart(data.grave_status_distribution || {});
    renderCapacityBarChart(data.monthly_lease_expiration || {});
}

function renderCapacityPieChart(distribution) {
    const canvas = document.getElementById("capacity-status-pie");
    if (!canvas) return;
    const wrap = canvas.parentElement;

    if (typeof Chart === "undefined") {
        if (wrap)
            wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:220px;color:#94a3b8;font-size:12px;text-align:center;padding:12px;">Charts require Chart.js.</div>`;
        return;
    }

    const labels = [];
    const values = [];
    const colors = [];
    for (const key of CATEGORY_ORDER) {
        const n = Number(distribution[key]) || 0;
        if (n > 0) {
            labels.push(key);
            values.push(n);
            colors.push(CATEGORY_COLORS[key] || "#cbd5e1");
        }
    }

    if (labels.length === 0) {
        if (wrap)
            wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:220px;color:#94a3b8;font-size:12px;">No grave status data available.</div>`;
        return;
    }

    reportCharts.capacityPie = new Chart(canvas.getContext("2d"), {
        type: "pie",
        data: {
            labels,
            datasets: [
                {
                    data: values,
                    backgroundColor: colors,
                    borderColor: "#ffffff",
                    borderWidth: 2,
                    hoverOffset: 8,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: {
                    position: "bottom",
                    labels: {
                        boxWidth: 12,
                        boxHeight: 12,
                        padding: 10,
                        font: { size: 11 },
                    },
                },
                tooltip: {
                    callbacks: {
                        label(ctx) {
                            const v = Number(ctx.parsed) || 0;
                            const sum = values.reduce((s, x) => s + x, 0) || 0;
                            const p = sum ? ((v / sum) * 100).toFixed(1) : "0.0";
                            return ` ${ctx.label}: ${v} (${p}%)`;
                        },
                    },
                },
            },
        },
    });
}

function renderCapacityBarChart(monthly) {
    const canvas = document.getElementById("capacity-monthly-line");
    if (!canvas) return;
    const wrap = canvas.parentElement;

    if (typeof Chart === "undefined") {
        if (wrap)
            wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:220px;color:#94a3b8;font-size:12px;text-align:center;padding:12px;">Charts require Chart.js.</div>`;
        return;
    }

    const keys = Object.keys(monthly || {}).sort();
    if (keys.length === 0) {
        if (wrap)
            wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:220px;color:#94a3b8;font-size:12px;">No monthly lease data available.</div>`;
        return;
    }

    const labels = keys.map((k) => {
        const [y, m] = k.split("-");
        const yN = Number(y);
        const mN = Number(m);
        if (!yN || !mN) return k;
        return new Date(yN, mN - 1, 1).toLocaleString("en-US", { month: "short" });
    });
    const values = keys.map((k) => Number(monthly[k]) || 0);
    const hasAny = values.some((v) => v > 0);

    const now = new Date();
    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const isPastKey = (k) => k < currentKey;

    const COLOR_EXPIRED = "#ef4444";
    const COLOR_EXPIRED_DARK = "#dc2626";
    const COLOR_EXPIRING = "#f59e0b";
    const COLOR_EXPIRING_DARK = "#d97706";

    // Bars before the current month are colored as overdue; current and future months are colored as upcoming
    const backgroundColors = keys.map((k) =>
        isPastKey(k) ? COLOR_EXPIRED : COLOR_EXPIRING,
    );
    const borderColors = keys.map((k) =>
        isPastKey(k) ? COLOR_EXPIRED_DARK : COLOR_EXPIRING_DARK,
    );

    const describeKey = (k) => {
        if (k < currentKey) return "overdue";
        if (k === currentKey) return "this month";
        return "upcoming";
    };

    reportCharts.capacityLine = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Lease Expirations",
                    data: values,
                    backgroundColor: backgroundColors,
                    borderColor: borderColors,
                    borderWidth: 1,
                    borderRadius: 6,
                    borderSkipped: false,
                    maxBarThickness: 32,
                    hoverBackgroundColor: borderColors.slice(),
                    hoverBorderColor: borderColors.slice(),
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: { display: false },
                title: hasAny
                    ? undefined
                    : {
                        display: true,
                        text: "No expirations scheduled this year",
                        color: "#94a3b8",
                        font: { size: 11, weight: "600" },
                    },
                subtitle: hasAny
                    ? {
                        display: true,
                        text: "Red = overdue  •  Amber = current & upcoming",
                        color: "#64748b",
                        font: { size: 10, weight: "500" },
                        padding: { top: 6 },
                        position: "bottom",
                    }
                    : undefined,
                tooltip: {
                    callbacks: {
                        label: (ctx) =>
                            ` ${Number(ctx.parsed.y) || 0} expiring (${describeKey(keys[ctx.dataIndex])})`,
                    },
                },
            },
            interaction: { mode: "index", intersect: false },
            scales: {
                x: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        color: "#94a3b8",
                        font: { size: 11, weight: "600" },
                        maxRotation: 0,
                        autoSkip: false,
                    },
                },
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: "#94a3b8",
                        font: { size: 11 },
                        precision: 0,
                        stepSize: 1,
                    },
                    grid: { color: "#f1f5f9" },
                    border: { display: false },
                },
            },
        },
    });
}

// Lease expirations
function renderExpirations(data, container) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (rows.length === 0) {
        container.innerHTML = `<div class="noDataFallbackMessage visible">No lease expirations match the current filters.</div>`;
        return;
    }

    const filtered = data.filtered_by || {};
    const hasDateRange = Boolean(filtered.start_date || filtered.end_date);

    // Split rows into already-expired and still-expiring buckets
    const expired = rows.filter(
        (r) => r.bucket === "expired" || r.is_expired === true,
    );
    const expiring = rows.filter(
        (r) => r.bucket === "expiring" || r.is_expired === false,
    );

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

    if (hasDateRange) {
        const parts = [];
        if (filtered.start_date) parts.push(fmtDate(filtered.start_date));
        if (filtered.end_date) parts.push(fmtDate(filtered.end_date));
        const label = parts.join(" → ");
        html += `<p style="color:#64748b;font-size:12px;margin:0 0 12px;">Filtered to <strong>${esc(label)}</strong>.</p>`;
    }

    if (expired.length > 0) {
        html += `<div class="docBlockHeader danger">Already Expired</div>`;
        html += expired.map(renderRow).join("");
    }
    if (expiring.length > 0) {
        const daysEcho =
            filtered.days === null || filtered.days === undefined
                ? null
                : Number(filtered.days);

        // Heading reflects whichever window the user applied
        let heading;
        if (hasDateRange) {
            heading = "Upcoming Expirations";
        } else if (daysEcho === 0) {
            heading = "Expiring Today";
        } else if (daysEcho === 1) {
            heading = "Expiring Today and Tomorrow";
        } else if (Number.isFinite(daysEcho)) {
            heading = `Expiring Within ${daysEcho} Days`;
        } else {
            heading = "Expiring Soon";
        }

        html += `<div class="docBlockHeader warning">${esc(heading)}</div>`;
        html += expiring.map(renderRow).join("");
    }

    container.innerHTML = html;
}

// Interment directory
function renderInterments(data, container) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (rows.length === 0) {
        container.innerHTML = `<div class="noDataFallbackMessage visible">No records match the selected filters.</div>`;
        return;
    }

    // Group records by burial month for readability
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

// All grave registry
function renderGraves(data, container) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (rows.length === 0) {
        container.innerHTML = `<div class="noDataFallbackMessage visible">No grave records match the selected filters.</div>`;
        return;
    }

    const total = Number(data.total_records) || rows.length;

    // Count how many graves fall into each category for the chip row
    const counts = Object.create(null);
    for (const it of rows) {
        const cat = it.category || it.status || "Other";
        counts[cat] = (counts[cat] || 0) + 1;
    }
    const chipOrder = [
        "Expired",
        "Expiring",
        "Occupied",
        "Reserved",
        "Vacant",
        "Other",
    ];
    const presentCats = chipOrder.filter((c) => counts[c]);

    let chipsHtml = "";
    if (presentCats.length > 0) {
        chipsHtml =
            `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px;">` +
            presentCats
                .map((c) => {
                    const color = CATEGORY_COLORS[c] || "#64748b";
                    return `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:${color}15;color:${color};font-size:11px;font-weight:600;border:1px solid ${color}40;letter-spacing:0.02em;">
            <span style="width:8px;height:8px;border-radius:50%;background:${color};"></span>
            ${esc(c)}: ${counts[c]}
          </span>`;
                })
                .join("") +
            `</div>`;
    }

    let html = `<div class="docBlockHeader">Grave Registry — ${rows.length} of ${total} record${total === 1 ? "" : "s"}</div>`;
    html += chipsHtml;

    for (const it of rows) {
        const cat = it.category || it.status || "Other";
        const color = CATEGORY_COLORS[cat] || "#64748b";

        const blockLine =
            it.block_name && it.block_name !== "N/A"
                ? `${esc(it.block_name)} (${esc(it.block_type || "N/A")})`
                : "Unassigned block";

        const position =
            it.row_num !== null || it.col_num !== null
                ? `Row ${it.row_num ?? "—"} / Column ${it.col_num ?? "—"}`
                : null;

        let leaseLine = "";
        if (it.min_lease_expiration) {
            const days = it.days_until_expiration;
            let daysLabel = "";
            if (typeof days === "number" && Number.isFinite(days)) {
                if (days < 0) {
                    const d = Math.abs(days);
                    daysLabel = ` (${d} day${d === 1 ? "" : "s"} overdue)`;
                } else if (days === 0) {
                    daysLabel = " (today)";
                } else {
                    daysLabel = ` (${days} day${days === 1 ? "" : "s"} left)`;
                }
            }
            leaseLine = `<strong>Earliest Lease Expiration:</strong> ${fmtDate(it.min_lease_expiration)}${esc(daysLabel)}<br />`;
        }

        const activeCount = Number(it.active_interments_count) || 0;
        const coLine =
            activeCount > 1
                ? `<strong>Active Interments:</strong> ${activeCount} (co-interment grave)<br />`
                : "";

        const reservedLine = it.has_active_reservation
            ? `<strong>Reservation:</strong> Active reservation on file<br />`
            : "";

        html += `<div class="bulletItem">
      <strong>Grave Code: ${esc(it.grave_code || "N/A")}</strong>
      <div class="itemDetailBlock">
        <strong>Status:</strong> <span style="color:${color};font-weight:600;">${esc(cat)}</span><br />
        <strong>Block Section:</strong> ${blockLine}<br />
        ${position ? `<strong>Position:</strong> ${esc(position)}<br />` : ""}
        ${leaseLine}
        ${coLine}
        ${reservedLine}
        <strong>Remarks in the graves:</strong> ${esc(it.remarks || "None on file")}
      </div>
    </div>`;
    }

    container.innerHTML = html;
}

// Payment ledger
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

        // Only include remark lines that are actually set
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

// Settings / branding
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
        // Always apply whatever was loaded [or fallbacks] to the UI
        bindReportSignatories(settingsMap);
        applyBarangayOptions();
    }
}

// Fills the four signature slots with names/titles from settings
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

// The barangay setting can be a JSON array string or a plain array
function parseBarangayList(raw) {
    if (Array.isArray(raw)) {
        return raw.filter((x) => typeof x === "string" && x.trim() !== "");
    }
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.filter((x) => typeof x === "string" && x.trim() !== "");
        }
    } catch (_) { }
    return [];
}

// Rebuilds the barangay checkbox list from settings
function applyBarangayOptions() {
    const container = document.getElementById("interments-barangay-checkboxes");
    if (!container) return;

    const list = parseBarangayList(settingsMap["barangay_options"]);

    if (list.length === 0) {
        container.innerHTML = `<p style="color:#94a3b8;font-size:12px;margin:0;">No barangays configured in settings.</p>`;
        return;
    }

    const current = (filterState.interments.barangay || "")
        .split(",")
        .filter(Boolean);

    container.innerHTML = list
        .map(
            (b) => `
    <label class="checkboxItem">
      <input type="checkbox" value="${esc(b)}"${current.includes(b) ? " checked" : ""
                } onchange="onIntermentsBarangayChange()" />
      <span>${esc(b)}</span>
    </label>`,
        )
        .join("");
}

// Filter options [dynamic payment purpose / channel]
async function loadFilterOptions() {
    try {
        const res = await fetch(`${API_ENDPOINT}/populate_filters`, {
            cache: "no-store",
        });
        if (!res.ok) throw new Error("HTTP " + res.status);

        const json = await res.json();
        if (!json || json.status !== 200 || !json.data) {
            throw new Error("Invalid filter options payload");
        }

        filterOptionsCache = json.data;
        applyFilterOptions(filterOptionsCache);
        return filterOptionsCache;
    } catch (err) {
        console.warn("Filter options unavailable.", err);
        return null;
    }
}

function applyFilterOptions(opts) {
    const purposeSelect = document.getElementById("payments-input-purpose");
    const channelSelect = document.getElementById("payments-input-channel");

    const purposes = Array.isArray(opts?.payments?.purposes)
        ? opts.payments.purposes
        : [];
    const channels = Array.isArray(opts?.payments?.channels)
        ? opts.payments.channels
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
}

// Initialization
document.addEventListener("DOMContentLoaded", () => {
    const initialContainer = document.getElementById("interments-content");
    if (initialContainer) {
        initialContainer.innerHTML = `
      <div class="loadingPlaceholder">
        <i class="fas fa-spinner fa-spin"></i>
        <span>Loading report data…</span>
      </div>`;
        initialContainer.classList.remove("is-loading");
    }

    loadReportBranding();
    loadFilterOptions();

    const reportLoad = switchReport("interments");
    reportLoad.catch((err) => console.error("Initial report load failed:", err));
});

// Print preparation
const PRINT_MIN_PAINT_MS = 120;
const PRINT_MAX_WAIT_MS = 4000;

function printCurrentReport() {
    if (!validateAllFilters(currentReportScope)) {
        return;
    }

    const btn = document.getElementById("printReportBtn");
    if (btn && btn.dataset.busy === "1") return;

    // Prevent double-clicks while printing is being prepared
    if (btn) {
        btn.dataset.busy = "1";
        btn.disabled = true;
        const label = btn.querySelector(".printBtnLabel");
        if (label) label.textContent = "Preparing…";
    }

    // Cancel any pending debounced reloads so a stale request doesn't overwrite the freshly rendered print content
    for (const [key, timer] of debounceTimers.entries()) {
        clearTimeout(timer);
        debounceTimers.delete(key);
    }

    loadReportBranding()
        .then(() => loadReportData(currentReportScope, { immediate: true }))
        .then(() => waitForPaintAndAssets())
        .then(() => {
            window.print();
        })
        .catch((err) => {
            console.error("Print prep failed:", err);
            window.print();
        })
        .finally(() => {
            if (btn) {
                btn.dataset.busy = "0";
                btn.disabled = false;
                const label =
                    btn.querySelector(".btnLabel") || btn.querySelector(".printBtnLabel");
                if (label) label.textContent = "Export / Print PDF";
            }
        });
}

// Waits until images and fonts are ready (or a hard timeout), then resolves so the caller can open the print dialog
function waitForPaintAndAssets() {
    const start = Date.now();

    return new Promise((resolve) => {
        const finish = () => resolve();

        const check = () => {
            if (Date.now() - start > PRINT_MAX_WAIT_MS) return finish();

            const card = document.getElementById("master-report-card");
            const imgs = card ? Array.from(card.querySelectorAll("img")) : [];
            const imagesReady = imgs.every(
                (img) => img.complete && img.naturalWidth > 0,
            );

            const fontsReady = !document.fonts || document.fonts.status === "loaded";

            if (
                imagesReady &&
                fontsReady &&
                Date.now() - start >= PRINT_MIN_PAINT_MS
            ) {
                // Double rAF gives the browser two frames to paint before the print dialog takes its snapshot
                requestAnimationFrame(() => requestAnimationFrame(finish));
            } else {
                setTimeout(check, 50);
            }
        };

        requestAnimationFrame(() => check());
    });
}