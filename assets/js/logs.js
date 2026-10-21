/**
 * Memoria – System Logs page controller
 *
 * Reads from api/logs.php (GET, ADMIN-only). The response is:
 *   { success: true, status: 200, message: "...", data: [ "STRING", ... ] }
 * where each STRING is: "TIMESTAMP] DESCRIPTION (User ID: N)".
 *
 * This controller parses those strings into structured rows, then does
 * search / date filter / pagination client-side.
 *
 * No PHP changes. No dummy data. XSS-safe rendering.
 */
(function () {
    'use strict';

    const API_URL = 'api/logs.php';
    const PER_PAGE = 10;
    const SEARCH_MIN_LEN = 3;
    const SEARCH_DEBOUNCE_MS = 350;
    const PAGINATION_WINDOW = 5;
    const DEBUG = true;

    const state = {
        allLogs: [],
        filtered: [],
        page: 1,
        totalPages: 1,
        search: '',
        date: '',
        loading: false,
    };

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

    // ------------------------------------------------------------------ helpers
    const escapeHtml = (v) => {
        if (v === null || v === undefined) return '';
        return String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    const debounce = (fn, wait) => {
        let t;
        return function (...a) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, a), wait);
        };
    };

    // ---- raw-error sanitization ----
    // Prevent ngrok/proxy HTML pages, bare HTTP status codes, JSON parse
    // failures, and network failures from reaching the empty-state block.
    const GENERIC_ERROR = 'Something went wrong. Please try again.';

    const looksRawMessage = (text) => {
        if (!text) return true;
        const t = String(text).trim();
        if (!t) return true;
        if (/<\s*[a-z!][\s\S]*>/i.test(t)) return true;                          // HTML body
        if (/ERR_NGROK_|ngrok/i.test(t)) return true;                            // ngrok
        if (/^HTTP\s+\d{3}/i.test(t)) return true;                               // bare "HTTP 502"
        if (/^Request failed \(HTTP \d{3}\)$/i.test(t)) return true;             // our own fallback
        if (/non-JSON|Unexpected token|is not valid JSON|Unexpected end of JSON/i.test(t)) return true;
        if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return true;
        if (/^(TypeError|SyntaxError|ReferenceError|RangeError|DOMException)\b/i.test(t)) return true;
        if (t.length > 200) return true;                                          // giant dumps
        return false;
    };

    const friendlyMessage = (raw, fallback) => {
        if (!raw) return fallback || GENERIC_ERROR;
        const s = String(raw).trim();
        if (!s || looksRawMessage(s)) return fallback || GENERIC_ERROR;
        return s;
    };

    // ------------------------------------------------------------------ response parsing
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

    // "2026-10-15 22:43:42] Manual interment 2 created with status Active (User ID: 1)"
    const parseLogString = (str) => {
        if (typeof str !== 'string') return null;
        const s = str.trim();

        // [optional [ ] TIMESTAMP ] <description> (User ID: N)?
        const m = s.match(
            /^\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\]\s*(.*?)(?:\s*\(User ID:\s*(\d*)\))?\s*$/
        );

        if (!m) {
            // Fallback: treat the whole string as a description.
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

    // Pull a username out of "(admin)" or "username: admin" patterns.
    const extractUsername = (desc) => {
        if (!desc) return '';
        // (admin) — short, no spaces or colons; excludes "(User ID: 1)".
        let m = desc.match(/\s\(([^\s():]+)\)\s/);
        if (m) return m[1];
        // username: admin
        m = desc.match(/username:\s*([^\s(]+)/i);
        if (m) return m[1];
        return '';
    };

    // Classify the description into a coarse activity type.
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

    const normalize = (row) => {
        // If the API ever starts returning objects instead of strings,
        // fall back to a field-mapped shape.
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

    // ------------------------------------------------------------------ formatting
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

    const ymd = (d) => {
        if (!d) return '';
        return d.getFullYear() + '-'
            + String(d.getMonth() + 1).padStart(2, '0') + '-'
            + String(d.getDate()).padStart(2, '0');
    };

    // ------------------------------------------------------------------ rendering
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

    function renderPagination() {
        const total = Math.max(1, state.totalPages);
        const current = state.page;

        if (el.currentPage) el.currentPage.textContent = String(current);
        if (el.totalPages) el.totalPages.textContent = String(total);
        if (el.prevBtn) el.prevBtn.disabled = current <= 1;
        if (el.nextBtn) el.nextBtn.disabled = current >= total;

        if (!el.carouselTrack) return;
        el.carouselTrack.innerHTML = '';

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

    // ------------------------------------------------------------------ filtering
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

    // ------------------------------------------------------------------ load
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
            // Raw-error sanitization: html/ngrok/bare-status text → generic message.
            showNoData(friendlyMessage(err && err.message, 'Unable to load logs.'));
            renderPagination();
        } finally {
            state.loading = false;
        }
    }

    // ------------------------------------------------------------------ events
    let eventsBound = false;
    function bindEvents() {
        if (eventsBound) return;
        eventsBound = true;

        if (el.search) {
            el.search.addEventListener('input', debounce(applyFilters, SEARCH_DEBOUNCE_MS));
            el.search.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
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

    // ------------------------------------------------------------------ init
    hideNoData();
    bindEvents();
    loadLogs();
})();