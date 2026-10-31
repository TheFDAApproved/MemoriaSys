(function () {
    'use strict';

    // Configuration
    const API_URL = 'api/logs.php';
    const PER_PAGE = 10;
    const SEARCH_MIN_LEN = 3;
    const SEARCH_DEBOUNCE_MS = 350;
    const PAGINATION_WINDOW = 5;
    const DEBUG = true;

    // Application state
    const state = {
        allLogs: [],
        filtered: [],
        page: 1,
        totalPages: 1,
        search: '',
        date: '',
        loading: false,
    };

    // Cached DOM elements
    const el = {
        search: document.getElementById('log_search'),
        date: document.getElementById('filter_date'),
        tbody: document.getElementById('logsTableBody'),
        noData: document.getElementById('logsNoData'),
        currentPage: document.getElementById('current_page_num'),
        totalPages: document.getElementById('total_pages_num'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
    };

    if (!el.tbody) {
        console.warn('[logs] #logsTableBody not found; aborting.');
        return;
    }

    // Small helper functions
    // Escape special characters so values are safe to insert as HTML
    const escapeHtml = (v) => {
        if (v === null || v === undefined) return '';
        return String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    // Delay a function call until the user stops typing for `wait` ms
    const debounce = (fn, wait) => {
        let t;
        return function (...a) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, a), wait);
        };
    };

    // Show a message to the user, using the shared alert if available
    const notify = (message, type) => {
        try {
            if (typeof window.showAlertTOP === 'function') {
                window.showAlertTOP(message, type);
                return;
            }
        } catch (_) { }
        if (type === 'error') console.error(message);
        else console.log(message);
    };

    const GENERIC_ERROR = 'Something went wrong. Please try again.';

    // Check if a message looks like a raw technical error that should be hidden
    const looksRawMessage = (text) => {
        if (!text) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;
        if (/ERR_NGROK_|ngrok/i.test(t)) return true;
        if (/^HTTP\s+\d{3}/i.test(t)) return true;
        if (/^Request failed \(HTTP \d{3}\)$/i.test(t)) return true;
        if (/non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(t)) return true;
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
        if (/^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(t)) return true;
        if (t.length > 200) return true;
        return false;
    };

    // Replace technical errors with a friendly message for the user
    const friendlyMessage = (raw, fallback) => {
        if (!raw) return fallback || GENERIC_ERROR;
        const s = String(raw).trim();
        if (!s || looksRawMessage(s)) return fallback || GENERIC_ERROR;
        return s;
    };

    // Injected styles for the search clear button
    function injectStyles() {
        if (document.getElementById('logsSearchStyles')) return;
        const style = document.createElement('style');
        style.id = 'logsSearchStyles';
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

    // Data extraction and parsing
    // Try common JSON response shapes and return the array of logs
    const extractArray = (json) => {
        if (!json) return [];
        if (Array.isArray(json)) return json;
        if (Array.isArray(json.data)) return json.data;
        if (Array.isArray(json.logs)) return json.logs;
        if (Array.isArray(json.records)) return json.records;
        if (json.data) {
            if (Array.isArray(json.data.logs)) return json.data.logs;
            if (Array.isArray(json.data.records)) return json.data.records;
        }
        return [];
    };

    // Parse a single log entry written as plain text
    const parseLogString = (str) => {
        if (typeof str !== 'string') return null;
        const s = str.trim();

        const m = s.match(
            /^\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\]\s*(.*?)(?:\s*\(User ID:\s*(\d*)\))?\s*$/
        );

        if (!m) {
            return {
                created_at: '',
                description: s,
                user_id: '',
                username: '',
                activity: 'General',
            };
        }

        const created_at = m[1];
        const description = m[2] || '';
        const user_id = m[3] || '';

        return {
            created_at,
            description,
            user_id,
            username: extractUsername(description),
            activity: deriveActivity(description),
        };
    };

    // Find a username inside a log description, if present
    const extractUsername = (desc) => {
        if (!desc) return '';
        let m = desc.match(/\s\(([^\s():]+)\)\s/);
        if (m) return m[1];
        m = desc.match(/username:\s*([^\s(]+)/i);
        if (m) return m[1];
        return '';
    };

    // Guess an event type based on keywords in the description
    const deriveActivity = (desc) => {
        if (!desc) return 'General';
        const t = desc.toLowerCase();
        if (t.includes('failed login')) return 'Failed Login';
        if (t.includes('logged in') || t.includes('login success')) return 'Login';
        if (t.includes('logged out') || t.includes('logout')) return 'Logout';
        if (t.includes('created')) return 'Create';
        if (t.includes('updated') || t.includes('edited') || t.includes('confirmed')) return 'Update';
        if (t.includes('deleted') || t.includes('removed')) return 'Delete';
        if (t.includes('retrieved') || t.includes('viewed') || t.includes('listed')) return 'View';
        if (t.includes('upload')) return 'Upload';
        return 'General';
    };

    // Convert any log row (object or string) into one consistent shape
    const normalize = (row) => {
        if (row && typeof row === 'object') {
            return {
                created_at: row.created_at || row.timestamp || row.logged_at || '',
                description: row.description || row.message || '',
                user_id: row.user_id || '',
                username: row.username || row.user || '',
                activity: row.activity_type || row.activity || row.event || 'General',
            };
        }
        return parseLogString(row) || {
            created_at: '', description: '', user_id: '', username: '', activity: 'General',
        };
    };

    // Date helpers
    const formatDateTime = (v) => {
        if (!v) return '—';
        const d = new Date(String(v).replace(' ', 'T'));
        if (Number.isNaN(d.getTime())) return String(v);
        try {
            return d.toLocaleString('en-PH', {
                year: 'numeric', month: 'short', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: true,
            });
        } catch (_) {
            return d.toISOString().replace('T', ' ').slice(0, 19);
        }
    };

    const asDate = (v) => {
        if (!v) return null;
        const d = new Date(String(v).replace(' ', 'T'));
        return Number.isNaN(d.getTime()) ? null : d;
    };

    // Format a date as YYYY-MM-DD [matches the date input value]
    const ymd = (d) => {
        if (!d) return '';
        return d.getFullYear() + '-'
            + String(d.getMonth() + 1).padStart(2, '0') + '-'
            + String(d.getDate()).padStart(2, '0');
    };

    // Empty-state helpers
    function hideNoData() {
        if (!el.noData) return;
        el.noData.hidden = true;
        el.noData.style.display = 'none';
    }

    function showNoData(msg) {
        if (!el.noData) return;
        el.noData.hidden = false;
        el.noData.style.display = '';
        el.noData.innerHTML = '<i class="fas fa-inbox"></i> ' + escapeHtml(msg || 'No logs found');
    }

    // Skeleton loading rows
    function showSkeleton() {
        hideNoData();
        let html = '';
        for (let i = 0; i < 6; i++) {
            html += '<tr class="logsSkeletonRow">'
                + '<td><span class="logsSkeleton logsSkeleton--w60"></span></td>'
                + '<td><span class="logsSkeleton logsSkeleton--w40"></span></td>'
                + '<td><span class="logsSkeleton logsSkeleton--w60"></span></td>'
                + '<td><span class="logsSkeleton logsSkeleton--w80"></span></td>'
                + '</tr>';
        }
        el.tbody.innerHTML = html;
    }

    // Rendering
    // Draw the rows for the current page of filtered logs
    function renderPage() {
        el.tbody.innerHTML = '';

        if (state.filtered.length === 0) {
            state.totalPages = 1;
            state.page = 1;

            showNoData('No logs found');
            renderPagination();
            return;
        }
        hideNoData();

        const total = Math.max(1, Math.ceil(state.filtered.length / PER_PAGE));
        state.totalPages = total;
        if (state.page > total) state.page = total;

        const start = (state.page - 1) * PER_PAGE;
        const rows = state.filtered.slice(start, start + PER_PAGE);

        const frag = document.createDocumentFragment();
        rows.forEach((log) => {
            const tr = document.createElement('tr');

            const userCell = log.username
                ? log.username
                : (log.user_id ? 'User #' + log.user_id : '—');

            tr.innerHTML =
                '<td>' + escapeHtml(formatDateTime(log.created_at)) + '</td>' +
                '<td>' + escapeHtml(userCell) + '</td>' +
                '<td>' + escapeHtml(log.activity || 'General') + '</td>' +
                '<td class="logDesc">' + escapeHtml(log.description || '') + '</td>';
            frag.appendChild(tr);
        });

        el.tbody.appendChild(frag);
        renderPagination();
    }

    // Update page numbers and the visible pagination window
    function renderPagination() {
        const total = Math.max(1, state.totalPages);
        const current = state.page;

        if (el.currentPage) el.currentPage.textContent = String(current);
        if (el.totalPages) el.totalPages.textContent = String(total);
        if (el.prevBtn) el.prevBtn.disabled = current <= 1;
        if (el.nextBtn) el.nextBtn.disabled = current >= total;

        if (!el.carouselTrack) return;
        el.carouselTrack.innerHTML = '';

        // Show a small window of page buttons centered on the current page
        const WINDOW = PAGINATION_WINDOW;
        let start = Math.max(1, current - Math.floor(WINDOW / 2));
        let end = Math.min(total, start + WINDOW - 1);
        start = Math.max(1, end - WINDOW + 1);

        for (let i = start; i <= end; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pageNavBtn' + (i === current ? ' active' : '');
            btn.textContent = String(i);
            if (i === current) btn.setAttribute('aria-current', 'page');
            btn.addEventListener('click', () => {
                if (i === state.page) return;
                state.page = i;
                renderPage();
                const wrap = el.tbody.closest('.tableScrollWrapper');
                if (wrap) wrap.scrollTop = 0;
            });
            el.carouselTrack.appendChild(btn);
        }
    }

    // Filtering
    // Apply search text and date filter, then show page 1
    function applyFilters() {
        const term = (el.search?.value || '').trim().toLowerCase();
        const dateValue = el.date?.value || '';
        const useTerm = term.length >= SEARCH_MIN_LEN;

        state.filtered = state.allLogs.filter((log) => {
            if (useTerm) {
                const hay = [
                    log.username, log.description, log.activity, String(log.user_id || ''),
                ].join(' ').toLowerCase();
                if (hay.indexOf(term) === -1) return false;
            }
            if (dateValue) {
                const d = asDate(log.created_at);
                if (!d || ymd(d) !== dateValue) return false;
            }
            return true;
        });

        state.page = 1;
        renderPage();
    }

    // Search clear button
    // Add a small "x" button inside the search input wrapper
    function setupSearchClearButton() {
        const input = el.search;
        if (!input) return;

        const parent = input.parentElement;
        if (!parent) return;

        if (window.getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }

        input.style.paddingRight = '30px';
        input.classList.add('pmSearchInputWithClear');

        const existing = parent.querySelector('.pmSearchClearBtn');
        if (existing) existing.remove();

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'pmSearchClearBtn';
        clearBtn.setAttribute('aria-label', 'Clear search');
        clearBtn.title = 'Clear search';
        clearBtn.innerHTML = '<i class="fas fa-times"></i>';

        const updateVisibility = () => {
            clearBtn.classList.toggle('is-visible', input.value.length > 0);
        };

        clearBtn.addEventListener('click', () => {
            const hadTerm = input.value.trim().length > 0;
            input.value = '';
            updateVisibility();
            if (hadTerm) applyFilters();
            input.focus();
        });

        input.addEventListener('input', updateVisibility);

        parent.appendChild(clearBtn);
        updateVisibility();
    }

    // Loading logs from the API
    async function loadLogs() {
        if (state.loading) return;
        state.loading = true;
        showSkeleton();

        try {
            const res = await fetch(API_URL, {
                method: 'GET',
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' },
                cache: 'no-store',
            });
            const json = await res.json().catch(() => null);

            if (DEBUG) console.log('[logs] raw API response:', json);

            if (!res.ok || (json && json.success === false)) {
                const msg = (json && (json.message || json.error))
                    || ('Request failed (HTTP ' + res.status + ')');
                throw new Error(msg);
            }

            const arr = extractArray(json);
            state.allLogs = arr.map(normalize);

            if (DEBUG) console.log('[logs] normalized first row:', state.allLogs[0]);

            applyFilters();
        } catch (err) {
            console.error('[logs] load error:', err);
            el.tbody.innerHTML = '';
            showNoData(friendlyMessage(err && err.message, 'Unable to load logs.'));
            renderPagination();
        } finally {
            state.loading = false;
        }
    }

    // Event binding
    let eventsBound = false;
    function bindEvents() {
        if (eventsBound) return;
        eventsBound = true;

        if (el.search) {
            el.search.addEventListener('input', debounce(applyFilters, SEARCH_DEBOUNCE_MS));
            el.search.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const v = el.search.value.trim();
                if (v.length > 0 && v.length < SEARCH_MIN_LEN) {
                    notify('Too short to search', 'warning');
                    return;
                }
                applyFilters();
            });
        }

        if (el.date) {
            el.date.addEventListener('change', applyFilters);
        }

        if (el.prevBtn) {
            el.prevBtn.addEventListener('click', () => {
                if (state.page <= 1) return;
                state.page -= 1;
                renderPage();
                const wrap = el.tbody.closest('.tableScrollWrapper');
                if (wrap) wrap.scrollTop = 0;
            });
        }

        if (el.nextBtn) {
            el.nextBtn.addEventListener('click', () => {
                if (state.page >= state.totalPages) return;
                state.page += 1;
                renderPage();
                const wrap = el.tbody.closest('.tableScrollWrapper');
                if (wrap) wrap.scrollTop = 0;
            });
        }
    }

    // Start up
    injectStyles();
    hideNoData();
    setupSearchClearButton();
    bindEvents();
    loadLogs();
})();