(() => {
    "use strict";

    const API_URL = "api/reserve.php";
    const DEFAULT_LIMIT = 100;
    const MIN_SEARCH_LENGTH = 3;
    const SEARCH_DEBOUNCE_MS = 350;
    const PAGINATION_WINDOW = 3;

    const state = {
        page: 1,
        limit: DEFAULT_LIMIT,
        search: "",
        status: "all",
        totalPages: 1,
        totalRecords: 0,
        items: [],
        loading: false,
        controller: null,
        requestId: 0,
    };

    // DOM references
    const els = {
        tbody: document.getElementById("reservation"),
        noData: document.getElementById("reservation_no_data"),
        searchInput: document.getElementById("user_search"),
        statusFilter: document.getElementById("status_filter"),
        filterBtn: document.getElementById("filter_btn"),
        currentPageLabel: document.getElementById("current_page_num"),
        totalPagesLabel: document.getElementById("total_pages_num"),
        prevBtn: document.getElementById("prev_page_btn"),
        nextBtn: document.getElementById("next_page_btn"),
        carouselTrack: document.getElementById("carousel_track"),
    };

    if (!els.tbody) {
        console.error("[grounds_reserve.js] Target tbody #reservation not found.");
        return;
    }

    // Data helpers
    function flattenItem(raw) {
        if (!raw || typeof raw !== "object") return null;

        const isFlat = raw.grave === undefined && raw.grave_id !== undefined;
        const g = isFlat ? raw : raw.grave || {};
        const i = isFlat ? raw : raw.interment || null;
        const hasI = isFlat
            ? raw.interment_id != null
            : !!(i && i.interment_id != null);

        const pickVal = (obj, key) => (obj && obj[key] != null ? obj[key] : null);

        return {
            type: raw.type || null,

            grave_id: pickVal(g, "grave_id"),
            grave_code: pickVal(g, "grave_code"),
            row_num: pickVal(g, "row_num"),
            col_num: pickVal(g, "col_num"),
            grave_status: pickVal(g, "grave_status"),
            grave_remarks: pickVal(g, "grave_remarks"),
            block_id: pickVal(g, "block_id"),
            block_name: pickVal(g, "block_name"),
            block_type: pickVal(g, "block_type"),

            interment_id: hasI ? i.interment_id : null,
            control_number: hasI ? i.control_number : null,
            deceased_name: hasI ? i.deceased_name : null,
            deceased_sex: hasI ? i.deceased_sex : null,
            last_known_address: hasI ? i.last_known_address : null,
            death_certificate: hasI ? i.death_certificate : null,
            deceased_date_of_birth: hasI ? i.deceased_date_of_birth : null,
            deceased_date_of_death: hasI ? i.deceased_date_of_death : null,
            current_grave_id: hasI ? i.current_grave_id : null,
            contact_person_name: hasI ? i.contact_person_name : null,
            contact_person_phone_number: hasI ? i.contact_person_phone_number : null,
            contact_person_email: hasI ? i.contact_person_email : null,
            contact_person_address: hasI ? i.contact_person_address : null,
            contact_person_address_barangay: hasI ? i.contact_person_address_barangay : null,
            assistance_type: hasI ? i.assistance_type : null,
            burial_permit_number: hasI ? i.burial_permit_number : null,
            burial_permit_date: hasI ? i.burial_permit_date : null,
            transfer_permit_number: hasI ? i.transfer_permit_number : null,
            transfer_permit_issued_by: hasI ? i.transfer_permit_issued_by : null,
            transfer_permit_date: hasI ? i.transfer_permit_date : null,
            exhumation_permit_number: hasI ? i.exhumation_permit_number : null,
            exhumation_permit_date: hasI ? i.exhumation_permit_date : null,
            date_buried: hasI ? i.date_buried : null,
            date_exhumed: hasI ? i.date_exhumed : null,
            burial_clearance_date: hasI ? i.burial_clearance_date : null,
            lease_expiration_date: hasI ? i.lease_expiration_date : null,
            interment_status: hasI ? (i.interment_status || i.status) : null,
            interment_remarks: hasI ? (i.interment_remarks || i.remarks) : null,
        };
    }

    // Returns the display label for a status type (used by the status pill)
    function getStatusLabel(type) {
        switch (type) {
            case "vacant":
                return "Available";
            case "expiring":
                return "Expiring";
            case "expired":
                return "Expired";
            default:
                return "-";
        }
    }

    // Escapes HTML special characters so values can be safely inserted into the DOM
    const escapeHtml = (value) => {
        if (value === null || value === undefined) return "";
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    };

    const formatDate = (value) => {
        if (!value) return "-";
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return escapeHtml(value);
        return d.toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "2-digit",
        });
    };

    // Prefers interment remarks, falls back to grave remarks
    const getRemarks = (item) => {
        if (item.interment_remarks && String(item.interment_remarks).trim() !== "") {
            return item.interment_remarks;
        }
        if (item.grave_remarks && String(item.grave_remarks).trim() !== "") {
            return item.grave_remarks;
        }
        return "";
    };

    // Renders the contact number as plain text [no SMS link in the grounds view]
    function renderPhoneCell(item) {
        const raw = item ? item.contact_person_phone_number : "";
        if (raw === null || raw === undefined) return "-";
        const s = String(raw).trim();
        if (s === "") return "-";
        return escapeHtml(s);
    }

    // Error handling
    const GENERIC_ERROR = "Something went wrong. Please try again.";

    const looksRawMessage = (text) => {
        if (!text) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;
        if (/ERR_NGROK_|ngrok/i.test(t)) return true;
        if (/^HTTP\s+\d{3}/i.test(t)) return true;
        if (/^Request failed \(\d{3}\)$/i.test(t)) return true;
        if (
            /non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(
                t,
            )
        )
            return true;
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
        if (
            /^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(
                t,
            )
        )
            return true;
        if (t.length > 200) return true;
        return false;
    };

    function notify(kind, message) {
        if (!message) return;
        const rawText = String(message);
        const displayText =
            kind === "error" && looksRawMessage(rawText) ? GENERIC_ERROR : rawText;

        if (typeof window.showAlertTOP === "function") {
            const type =
                kind === "success"
                    ? "success"
                    : kind === "error"
                        ? "error"
                        : kind === "warning"
                            ? "warning"
                            : "info";
            window.showAlertTOP(displayText, type);
            return;
        }

        if (kind === "error") console.error("[grounds_reserve.js]", rawText);
        else console.log("[grounds_reserve.js]", rawText);
    }

    function warnSearchTooShort(value) {
        const min = MIN_SEARCH_LENGTH;
        const len = String(value || "").trim().length;
        notify(
            "warning",
            `Please enter at least ${min} characters to search — ` +
            `you've only typed ${len}.`,
        );
    }

    // Search clear button
    function injectSearchClearStyles() {
        if (document.getElementById("groundsReserveSearchStyles")) return;
        const style = document.createElement("style");
        style.id = "groundsReserveSearchStyles";
        style.textContent = `
      .pmSearchClearBtn {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        display: none;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        margin: 0;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: #9ca3af;
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
        z-index: 5;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .pmSearchClearBtn:hover {
        background: #f3f4f6;
        color: #4b5563;
      }
      .pmSearchClearBtn:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.30);
      }
      .pmSearchClearBtn.is-visible {
        display: inline-flex;
      }
      .pmSearchInputWithClear::-webkit-search-cancel-button,
      .pmSearchInputWithClear::-webkit-search-decoration {
        -webkit-appearance: none;
        appearance: none;
      }
    `;
        document.head.appendChild(style);
    }

    let searchClearBtn = null;

    function setupSearchClearButton() {
        const input = els.searchInput;
        if (!input) return;

        const parent = input.parentElement;
        if (!parent) return;

        if (window.getComputedStyle(parent).position === "static") {
            parent.style.position = "relative";
        }

        input.style.paddingRight = "30px";
        input.classList.add("pmSearchInputWithClear");

        const existing = parent.querySelector(".pmSearchClearBtn");
        if (existing) existing.remove();

        searchClearBtn = document.createElement("button");
        searchClearBtn.type = "button";
        searchClearBtn.className = "pmSearchClearBtn";
        searchClearBtn.setAttribute("aria-label", "Clear search");
        searchClearBtn.title = "Clear search";
        searchClearBtn.innerHTML = '<i class="fas fa-times"></i>';

        searchClearBtn.addEventListener("click", () => {
            const hadSearch = state.search !== "";
            input.value = "";
            toggleSearchClear("");
            if (hadSearch) {
                state.search = "";
                state.page = 1;
                fetchSpaces();
            }
            input.focus();
        });

        input.addEventListener("input", () => toggleSearchClear(input.value));

        parent.appendChild(searchClearBtn);
        toggleSearchClear(input.value);
    }

    function toggleSearchClear(value) {
        if (!searchClearBtn) return;
        searchClearBtn.classList.toggle(
            "is-visible",
            String(value || "").length > 0,
        );
    }

    // Loading and state helpers
    const setLoading = (isLoading) => {
        state.loading = isLoading;

        const wrapper = els.tbody.closest(".tableWrapper");
        if (wrapper) wrapper.classList.toggle("isLoading", isLoading);

        if (isLoading && els.noData) els.noData.style.display = "none";
        if (els.prevBtn) els.prevBtn.disabled = isLoading || state.page <= 1;
        if (els.nextBtn)
            els.nextBtn.disabled = isLoading || state.page >= state.totalPages;
    };

    function showEmptyState() {
        if (!els.noData) return;
        els.noData.innerHTML = '<i class="fas fa-inbox"></i> No data found';
        els.noData.style.display = "";
    }

    function showError(message) {
        if (!els.noData) return;
        const display =
            message && !looksRawMessage(message) ? message : GENERIC_ERROR;
        els.noData.innerHTML = `<i class="fas fa-triangle-exclamation"></i> ${escapeHtml(display)}`;
        els.noData.style.display = "";
    }

    // Fetching data
    async function fetchSpaces() {
        if (state.controller) state.controller.abort();
        state.controller = new AbortController();

        const params = new URLSearchParams();
        params.set("page", String(state.page));
        params.set("limit", String(state.limit));
        if (state.search) params.set("search_term", state.search);
        if (state.status && state.status !== "all")
            params.set("status", state.status);

        const reqId = ++state.requestId;
        setLoading(true);

        let loadError = null;

        try {
            const response = await fetch(`${API_URL}?${params.toString()}`, {
                method: "GET",
                headers: { Accept: "application/json" },
                credentials: "same-origin",
                signal: state.controller.signal,
            });

            if (reqId !== state.requestId) return;

            const json = await response.json().catch(() => null);

            if (!response.ok) {
                const msg =
                    (json && (json.message || json.error)) ||
                    `Request failed (${response.status})`;
                throw new Error(msg);
            }
            if (json && json.success === false) {
                throw new Error(json.message || "Request failed.");
            }

            const payload = json && json.data ? json.data : json || {};
            const rawItems = Array.isArray(payload.items) ? payload.items : [];
            state.items = rawItems.map(flattenItem).filter(Boolean);

            const pg = payload.pagination || {};
            state.page = Number(pg.current_page) || state.page;
            state.totalPages = Math.max(1, Number(pg.total_pages) || 1);
            state.totalRecords = Number(pg.total_records) || state.items.length;
        } catch (err) {
            if (err.name === "AbortError") return;
            if (reqId !== state.requestId) return;
            loadError = err;
        }

        if (reqId !== state.requestId) return;

        setLoading(false);

        if (loadError) {
            state.items = [];
            state.totalPages = 1;
            state.totalRecords = 0;
            render();
            showError(loadError.message || "Failed to load burial spaces.");
        } else {
            render();
        }
    }

    // Rendering
    function render() {
        renderRows();
        renderPagination();
    }

    function renderRows() {
        els.tbody.innerHTML = "";

        if (!state.items.length) {
            if (els.noData) {
                if (state.loading) {
                    els.noData.style.display = "none";
                } else {
                    showEmptyState();
                }
            }
            return;
        }

        if (els.noData) els.noData.style.display = "none";

        const fragment = document.createDocumentFragment();

        state.items.forEach((item) => {
            const tr = document.createElement("tr");
            tr.dataset.graveId = item.grave_id;
            tr.dataset.type = item.type;

            const nameCell = escapeHtml(item.deceased_name || "-");

            const blockParts = [item.block_name, item.grave_code].filter(Boolean);
            const blockCell = blockParts.length
                ? escapeHtml(blockParts.join(" - "))
                : "-";

            const expirationCell = formatDate(item.lease_expiration_date);
            const contactPerson = escapeHtml(item.contact_person_name || "-");
            const phoneCell = renderPhoneCell(item);
            const remarksCell = escapeHtml(getRemarks(item) || "-");

            const statusLabel = getStatusLabel(item.type);
            const statusClass = `statusPill status-${item.type || "unknown"}`;

            tr.innerHTML = `
                <td><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
                <td>${nameCell}</td>
                <td>${blockCell}</td>
                <td>${expirationCell}</td>
                <td>${contactPerson}</td>
                <td>${phoneCell}</td>
                <td class="remarksCell">${remarksCell}</td>
            `;

            fragment.appendChild(tr);
        });

        els.tbody.appendChild(fragment);
    }

    function renderPagination() {
        els.currentPageLabel.textContent = state.page;
        els.totalPagesLabel.textContent = state.totalPages;

        els.prevBtn.disabled = state.loading || state.page <= 1;
        els.nextBtn.disabled = state.loading || state.page >= state.totalPages;

        if (!els.carouselTrack) return;
        els.carouselTrack.innerHTML = "";

        const total = state.totalPages;
        if (total < 1) return;

        const windowSize = PAGINATION_WINDOW;
        let start = Math.max(1, state.page - Math.floor(windowSize / 2));
        let end = Math.min(total, start + windowSize - 1);
        start = Math.max(1, end - windowSize + 1);

        if (start > 1) {
            els.carouselTrack.appendChild(makePageBtn(1));
            if (start > 2) els.carouselTrack.appendChild(makeEllipsis());
        }
        for (let p = start; p <= end; p++) {
            els.carouselTrack.appendChild(makePageBtn(p));
        }
        if (end < total) {
            if (end < total - 1) els.carouselTrack.appendChild(makeEllipsis());
            els.carouselTrack.appendChild(makePageBtn(total));
        }
    }

    function makePageBtn(pageNum) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pageNumBtn" + (pageNum === state.page ? " active" : "");
        btn.textContent = String(pageNum);
        btn.dataset.page = String(pageNum);
        if (pageNum === state.page) btn.setAttribute("aria-current", "page");
        btn.addEventListener("click", () => goToPage(pageNum));
        return btn;
    }

    function makeEllipsis() {
        const span = document.createElement("span");
        span.className = "pageEllipsis";
        span.textContent = "…";
        span.setAttribute("aria-hidden", "true");
        return span;
    }

    // Page navigation
    function goToPage(page) {
        const target = Math.min(Math.max(1, page), state.totalPages);
        if (target === state.page || state.loading) return;
        state.page = target;
        fetchSpaces();
    }

    // Event handlers
    let searchTimer = null;

    if (els.searchInput) {
        els.searchInput.addEventListener("input", () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const value = els.searchInput.value.trim();

                if (value.length === 0) {
                    if (state.search !== "") {
                        state.search = "";
                        state.page = 1;
                        fetchSpaces();
                    }
                    return;
                }

                if (value.length < MIN_SEARCH_LENGTH) return;
                if (value === state.search) return;

                state.search = value;
                state.page = 1;
                fetchSpaces();
            }, SEARCH_DEBOUNCE_MS);
        });

        els.searchInput.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            clearTimeout(searchTimer);

            const value = els.searchInput.value.trim();

            if (value.length > 0 && value.length < MIN_SEARCH_LENGTH) {
                warnSearchTooShort(value);
                return;
            }

            state.search = value;
            state.page = 1;
            fetchSpaces();
        });
    }

    if (els.filterBtn) {
        els.filterBtn.addEventListener("click", (event) => {
            event.preventDefault();
            clearTimeout(searchTimer);

            if (els.searchInput) {
                const value = els.searchInput.value.trim();

                if (value.length > 0 && value.length < MIN_SEARCH_LENGTH) {
                    warnSearchTooShort(value);
                    return;
                }

                state.search = value;
            }
            if (els.statusFilter) {
                state.status = els.statusFilter.value || "all";
            }

            state.page = 1;
            fetchSpaces();
        });
    }

    if (els.prevBtn) {
        els.prevBtn.addEventListener("click", () => goToPage(state.page - 1));
    }
    if (els.nextBtn) {
        els.nextBtn.addEventListener("click", () => goToPage(state.page + 1));
    }

    // Public API for other scripts
    window.GroundsReserveTable = {
        refresh: () => fetchSpaces(),
        reload: () => fetchSpaces(),
        setStatus(status) {
            state.status = status || "all";
            if (els.statusFilter) els.statusFilter.value = state.status;
            state.page = 1;
            return fetchSpaces();
        },
        setSearch(term) {
            state.search = String(term || "").trim();
            if (els.searchInput) els.searchInput.value = state.search;
            toggleSearchClear(state.search);
            state.page = 1;
            return fetchSpaces();
        },
        goToPage,
        getItem(graveId) {
            return (
                state.items.find(
                    (row) => Number(row.grave_id) === Number(graveId),
                ) || null
            );
        },
        getState() {
            return { ...state };
        },
    };

    // Initialization
    injectSearchClearStyles();
    setupSearchClearButton();

    if (els.statusFilter && els.statusFilter.value) {
        state.status = els.statusFilter.value || "all";
    }
    if (els.searchInput && els.searchInput.value) {
        const v = els.searchInput.value.trim();
        if (v.length === 0 || v.length >= MIN_SEARCH_LENGTH) state.search = v;
        toggleSearchClear(v);
    }

    if (els.noData) els.noData.style.display = "none";

    fetchSpaces();
})();