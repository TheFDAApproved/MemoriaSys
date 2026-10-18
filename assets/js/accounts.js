document.addEventListener('DOMContentLoaded', function () {
    const MAX_PAGE_BUTTONS = 5;
    const PER_PAGE = 10;
    const MAX_SERVER_PAGES = 200;
    const API_URL = 'api/users.php';
    const MIN_SEARCH_LENGTH = 3;   // minimum characters required to search

    const state = {
        allUsers: [],
        data: [],
        page: 1,
        totalPages: 1,
        appliedSearch: '',
        appliedStatus: 'all',
        appliedRole: 'all',
        editingId: null,
        requestId: 0,
        lastRenderKey: '',
        isLoading: false,
        pendingAction: null   // { type: 'save' | 'delete', userId: number } | null
    };

    const els = {
        searchBox: document.querySelector('.searchBox'),
        searchInput: document.getElementById('user_search'),
        statusFilter: document.getElementById('status_filter'),
        roleFilter: document.getElementById('role_filter'),
        filterBtn: document.getElementById('filter_btn'),
        tableBody: document.getElementById('accounts_table_body'),
        noData: document.getElementById('burial_no_data'),
        currentPageNum: document.getElementById('current_page_num'),
        totalPagesNum: document.getElementById('total_pages_num'),
        prevBtn: document.getElementById('prev_page_btn'),
        nextBtn: document.getElementById('next_page_btn'),
        carouselTrack: document.getElementById('carousel_track'),
        carouselViewport: document.getElementById('carousel_viewport'),
        tableScrollWrapper: document.querySelector('.tableScrollWrapper')
    };

    /* -------- injected styles (self-contained) -------- */
    (function injectStyles() {
        const css = [
            '.actionBtn.is-loading { pointer-events: none; opacity: 0.9; }',
            '.actionBtn.is-loading .fa-spinner { color: #0d6efd; }',
            '.actionBtn[disabled] { cursor: not-allowed; opacity: 0.6; }',
            'tr.is-pending { opacity: 0.75; }',
            'tr.is-pending td { background: rgba(13,110,253,0.03); }',
            'tr.loadingRow td { text-align: center; padding: 24px; color: #666; }',
            'tr.loadingRow .fa-spinner { margin-right: 8px; color: #0d6efd; }'
        ].join('\n');
        const s = document.createElement('style');
        s.id = 'accountsLoadingStyles';
        s.textContent = css;
        document.head.appendChild(s);
    })();

    /* -------- clear-search button -------- */
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'searchClearBtn';
    closeBtn.setAttribute('aria-label', 'Clear search');
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    els.searchBox.appendChild(closeBtn);

    /* -------- alert helper (always forwards the type) -------- */
    function notify(message, type) {
        const t = type || 'success';
        if (typeof showAlertTOP === 'function') {
            showAlertTOP(message, t);
            return;
        }
        if (t === 'error') console.error('[accounts] ' + message);
        else console.log('[accounts][' + t + '] ' + message);
    }

    /* -------- confirm helper (uses confirm_ui.js when available) -------- */
    async function askConfirm(message, opts) {
        if (typeof confirm_ui === 'function') {
            return !!(await confirm_ui(message, opts));
        }
        // graceful fallback if confirm_ui.js isn't loaded
        return window.confirm(message);
    }

    /* -------- pending-action helpers -------- */
    function setPending(type, userId) {
        state.pendingAction = { type: type, userId: Number(userId) };
        state.lastRenderKey = '';
    }
    function clearPending() {
        state.pendingAction = null;
        state.lastRenderKey = '';
    }
    function isPending() { return !!state.pendingAction; }
    function rowIsPending(userId) {
        return !!state.pendingAction &&
            Number(state.pendingAction.userId) === Number(userId);
    }
    function pendingKey() {
        return state.pendingAction
            ? state.pendingAction.type + ':' + state.pendingAction.userId
            : '';
    }

    /* -------- role helpers -------- */
    function toDisplayRole(dbRole) {
        return dbRole === 'Grounds Staff' ? 'Ground Staff' : dbRole;
    }
    function toDbRole(displayRole) {
        return displayRole === 'Ground Staff' ? 'Grounds Staff' : displayRole;
    }

    /* -------- phone helpers -------- */
    function formatPhoneDisplay(phone) {
        if (!phone) return '';
        var digits = String(phone).replace(/\D/g, '');
        if (digits.length >= 12 && digits.slice(0, 2) === '63') digits = digits.slice(2);
        else if (digits.length === 11 && digits.charAt(0) === '0') digits = digits.slice(1);
        digits = digits.slice(0, 10);
        if (digits.length === 0) return '';
        var out = '+63';
        if (digits.length > 0) out += ' ' + digits.slice(0, 3);
        if (digits.length > 3) out += ' ' + digits.slice(3, 6);
        if (digits.length > 6) out += ' ' + digits.slice(6, 10);
        return out;
    }
    function formatPhoneInput(value) {
        var raw = String(value).replace(/^\+63\s*/, '');
        var digits = raw.replace(/\D/g, '');
        digits = digits.replace(/^0/, '').replace(/^63/, '').slice(0, 10);
        var formatted = '+63';
        if (digits.length > 0) formatted += ' ' + digits.slice(0, 3);
        if (digits.length > 3) formatted += ' ' + digits.slice(3, 6);
        if (digits.length > 6) formatted += ' ' + digits.slice(6, 10);
        return formatted;
    }
    function formatPhoneForDb(displayValue) {
        var digits = String(displayValue).replace(/\D/g, '');
        if (digits.length === 12 && digits.slice(0, 2) === '63') return '+' + digits;
        if (digits.length === 11 && digits.charAt(0) === '0') return '+63' + digits.slice(1);
        if (digits.length === 10) return '+63' + digits;
        return null;
    }

    /* -------- fetch -------- */
    async function fetchAllMatchingUsers() {
        const all = [];
        let serverPage = 1;
        let totalServerPages = 1;

        while (serverPage <= totalServerPages && serverPage <= MAX_SERVER_PAGES) {
            const params = new URLSearchParams();
            params.set('page', serverPage);
            if (state.appliedSearch) params.set('search_term', state.appliedSearch);
            if (state.appliedRole && state.appliedRole !== 'all') params.set('role', state.appliedRole);
            if (state.appliedStatus && state.appliedStatus !== 'all') params.set('status', state.appliedStatus);

            const res = await fetch(API_URL + '?' + params.toString());
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); }
            catch (parseErr) {
                throw new Error('Server returned non-JSON (status ' + res.status + '): ' + text.slice(0, 300));
            }
            if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));

            const payload = data.data || data;
            const users = Array.isArray(payload.users) ? payload.users : [];
            const pagination = payload.pagination || {};

            for (let i = 0; i < users.length; i++) all.push(users[i]);
            totalServerPages = Math.max(1, parseInt(pagination.total_pages, 10) || 1);
            serverPage++;
        }
        return all;
    }

    function sortUsers(users) {
        const rank = function (s) { return s === 'Unverified' ? 0 : 1; };
        return users.slice().sort(function (a, b) {
            const ra = rank(a.status);
            const rb = rank(b.status);
            if (ra !== rb) return ra - rb;
            return (Number(a.user_id) || 0) - (Number(b.user_id) || 0);
        });
    }

    function applyPage() {
        state.totalPages = Math.max(1, Math.ceil(state.allUsers.length / PER_PAGE));
        if (state.page > state.totalPages) state.page = state.totalPages;
        if (state.page < 1) state.page = 1;
        const start = (state.page - 1) * PER_PAGE;
        state.data = state.allUsers.slice(start, start + PER_PAGE);
    }

    async function loadUsers(opts) {
        const silent = !!(opts && opts.silent);
        const reqId = ++state.requestId;

        state.isLoading = true;

        if (state.allUsers.length === 0) renderTable(silent);

        try {
            const raw = await fetchAllMatchingUsers();
            if (reqId !== state.requestId) return;

            state.allUsers = sortUsers(raw.map(function (u) {
                return {
                    user_id: u.user_id,
                    name: u.name,
                    username: u.username,
                    email: u.email,
                    phone_number: u.phone_number,
                    role: toDisplayRole(u.role),
                    status: u.status
                };
            }));

            state.isLoading = false;
            state.lastRenderKey = '';
            applyPage();
            renderTable(silent);
            renderPagination(silent);
        } catch (e) {
            if (reqId !== state.requestId) return;
            state.isLoading = false;
            state.lastRenderKey = '';
            console.error('[accounts] failed to load accounts:', e);
            renderTable(false);
            notify('Failed to load accounts. Please try again.', 'error');
        }
    }

    /* -------- utils -------- */
    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function buildOptions(options, selected) {
        return options.map(function (opt) {
            return '<option value="' + escapeHtml(opt) + '"' +
                (opt === selected ? ' selected' : '') + '>' +
                escapeHtml(opt) + '</option>';
        }).join('');
    }

    const ROLE_OPTIONS = ['Ground Staff', 'Office Staff', 'Administrator'];
    const STATUS_OPTIONS = ['Verified', 'Unverified'];

    function buildRenderKey() {
        const pk = pendingKey();
        if (state.data.length === 0) {
            return 'empty:' + state.editingId + ':' + state.page + ':' + pk;
        }
        return state.data.map(function (u) {
            return u.user_id + '|' + u.role + '|' + u.status + '|' + (u.phone_number || '');
        }).join(',') + ':' + state.editingId + ':' + state.page + ':' + pk;
    }

    function renderLoadingRow(message) {
        els.noData.style.display = 'none';
        els.tableBody.innerHTML =
            '<tr class="loadingRow"><td colspan="8">' +
                '<i class="fas fa-spinner fa-spin"></i>' +
                escapeHtml(message || 'Loading…') +
            '</td></tr>';
        state.lastRenderKey = 'loading';
    }

    function renderActions(user, isEditing, rowPending) {
        if (rowPending && state.pendingAction.type === 'save') {
            return '<button type="button" class="actionBtn save-action is-loading" disabled title="Verifying via SMS…"><i class="fas fa-spinner fa-spin"></i></button>' +
                   '<button type="button" class="actionBtn cancel-action" disabled title="Please wait"><i class="fas fa-times"></i></button>' +
                   '<button type="button" class="actionBtn delete-action" disabled title="Please wait"><i class="fas fa-trash"></i></button>';
        }
        if (rowPending && state.pendingAction.type === 'delete') {
            return '<button type="button" class="actionBtn edit-action" disabled><i class="fas fa-pen"></i></button>' +
                   '<button type="button" class="actionBtn delete-action is-loading" disabled title="Deleting…"><i class="fas fa-spinner fa-spin"></i></button>';
        }
        if (isEditing) {
            return '<button type="button" class="actionBtn save-action" data-action="save" title="Save"><i class="fas fa-check"></i></button>' +
                   '<button type="button" class="actionBtn cancel-action" data-action="cancel" title="Cancel"><i class="fas fa-times"></i></button>' +
                   '<button type="button" class="actionBtn delete-action" data-action="delete" title="Delete"><i class="fas fa-trash"></i></button>';
        }
        return '<button type="button" class="actionBtn edit-action" data-action="edit" title="Edit"><i class="fas fa-pen"></i></button>' +
               '<button type="button" class="actionBtn delete-action" data-action="delete" title="Delete"><i class="fas fa-trash"></i></button>';
    }

    function renderTable(silent) {
        if (state.isLoading && state.allUsers.length === 0) {
            if (state.lastRenderKey !== 'loading') renderLoadingRow('Loading accounts…');
            return;
        }

        const rows = state.data;

        if (rows.length === 0) {
            const emptyKey = 'empty:' + state.editingId + ':' + state.page + ':' + pendingKey();
            if (state.lastRenderKey !== emptyKey) {
                els.tableBody.innerHTML = '';
                state.lastRenderKey = emptyKey;
            }
            els.noData.style.display = 'flex';
            return;
        }

        els.noData.style.display = 'none';

        const key = buildRenderKey();
        if (key === state.lastRenderKey) return;
        state.lastRenderKey = key;

        const prevScroll = els.tableScrollWrapper ? els.tableScrollWrapper.scrollTop : 0;

        els.tableBody.innerHTML = rows.map(function (user) {
            const isEditing = state.editingId === user.user_id;
            const rowPending = rowIsPending(user.user_id);
            const disableSelects = rowPending ? ' disabled' : '';

            const roleCell = isEditing
                ? '<select class="cellSelect" data-field="role"' + disableSelects + '>' + buildOptions(ROLE_OPTIONS, user.role) + '</select>'
                : escapeHtml(user.role);

            const statusCell = isEditing
                ? '<select class="cellSelect" data-field="status"' + disableSelects + '>' + buildOptions(STATUS_OPTIONS, user.status) + '</select>'
                : escapeHtml(user.status);

            const phoneCell = escapeHtml(formatPhoneDisplay(user.phone_number));
            const actions = renderActions(user, isEditing, rowPending);

            return '<tr data-user-id="' + escapeHtml(user.user_id) + '"' +
                    (rowPending ? ' class="is-pending"' : '') + '>' +
                '<td>' + escapeHtml(user.name) + '</td>' +
                '<td>' + escapeHtml(user.username) + '</td>' +
                '<td>' + escapeHtml(user.email) + '</td>' +
                '<td>' + phoneCell + '</td>' +
                '<td>' + roleCell + '</td>' +
                '<td>' + statusCell + '</td>' +
                '<td>' + escapeHtml(user.user_id) + '</td>' +
                '<td>' + actions + '</td>' +
                '</tr>';
        }).join('');

        if (els.tableScrollWrapper && prevScroll > 0) {
            els.tableScrollWrapper.scrollTop = prevScroll;
        }
    }

    function renderPagination(silent) {
        const total = state.totalPages;
        els.currentPageNum.textContent = state.page;
        els.totalPagesNum.textContent = total;
        els.prevBtn.disabled = state.page <= 1 || isPending();
        els.nextBtn.disabled = state.page >= total || isPending();

        let startPage, endPage;
        if (total <= MAX_PAGE_BUTTONS) {
            startPage = 1; endPage = total;
        } else {
            const half = Math.floor(MAX_PAGE_BUTTONS / 2);
            startPage = state.page - half;
            endPage = startPage + MAX_PAGE_BUTTONS - 1;
            if (startPage < 1) { startPage = 1; endPage = MAX_PAGE_BUTTONS; }
            if (endPage > total) { endPage = total; startPage = total - MAX_PAGE_BUTTONS + 1; }
        }

        const existingButtons = els.carouselTrack.querySelectorAll('button');
        const existingValues = Array.prototype.map.call(existingButtons, function (b) { return b.textContent; });
        const newValues = [];
        for (let i = startPage; i <= endPage; i++) newValues.push(String(i));

        const sameSet = existingValues.length === newValues.length &&
            existingValues.every(function (v, i) { return v === newValues[i]; });

        if (sameSet) {
            Array.prototype.forEach.call(existingButtons, function (btn, i) {
                const pageNum = startPage + i;
                btn.classList.toggle('active', pageNum === state.page);
                btn.disabled = isPending();
            });
            centerActivePage();
            return;
        }

        els.carouselTrack.innerHTML = '';
        for (let i = startPage; i <= endPage; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = i;
            if (i === state.page) btn.classList.add('active');
            btn.disabled = isPending();
            btn.addEventListener('click', (function (pageNum) {
                return function () { goToPage(pageNum); };
            })(i));
            els.carouselTrack.appendChild(btn);
        }
        centerActivePage();
    }

    function centerActivePage() {
        const active = els.carouselTrack.querySelector('button.active');
        if (!active) { els.carouselTrack.style.transform = 'translateX(0)'; return; }
        const vw = els.carouselViewport.clientWidth;
        const tw = els.carouselTrack.scrollWidth;
        if (tw <= vw) { els.carouselTrack.style.transform = 'translateX(0)'; return; }
        const center = active.offsetLeft + active.offsetWidth / 2;
        let t = center - vw / 2;
        const max = tw - vw;
        if (t < 0) t = 0;
        if (t > max) t = max;
        els.carouselTrack.style.transform = 'translateX(' + (-t) + 'px)';
    }

    function goToPage(page) {
        if (isPending()) return;
        if (page < 1 || page > state.totalPages) return;
        if (page === state.page) return;

        state.page = page;
        state.editingId = null;
        state.lastRenderKey = '';
        applyPage();
        renderTable(false);
        renderPagination(false);
        if (els.tableScrollWrapper) els.tableScrollWrapper.scrollTop = 0;
    }

    function updateCloseButton() {
        const hasText = els.searchInput.value.length > 0;
        closeBtn.classList.toggle('is-visible', hasText);
        els.searchInput.style.paddingRight = hasText ? '36px' : '';
    }

    function cancelEdit() {
        if (state.editingId === null) return;
        if (isPending()) return;
        state.editingId = null;
        state.lastRenderKey = '';
        renderTable(false);
    }

    /* -------- local state helpers -------- */
    function findLocalUser(userId) {
        for (let i = 0; i < state.allUsers.length; i++) {
            if (Number(state.allUsers[i].user_id) === Number(userId)) return state.allUsers[i];
        }
        return null;
    }
    function matchesActiveFilters(user) {
        if (!user) return false;
        if (state.appliedStatus && state.appliedStatus !== 'all' && user.status !== state.appliedStatus) return false;
        if (state.appliedRole && state.appliedRole !== 'all') {
            const filter = String(state.appliedRole);
            if (user.role !== filter && toDbRole(user.role) !== filter) return false;
        }
        return true;
    }
    function refreshFromLocalState() {
        state.lastRenderKey = '';
        applyPage();
        renderTable(false);
        renderPagination(false);
    }

    /* -------- outside-click cancels edit (not while pending) -------- */
    document.addEventListener('mousedown', function (e) {
        if (state.editingId === null) return;
        if (isPending()) return;
        if (e.target.closest('button[data-action]')) return;
        const editingRow = els.tableBody.querySelector(
            'tr[data-user-id="' + state.editingId + '"]'
        );
        if (editingRow && editingRow.contains(e.target)) return;
        cancelEdit();
    });

    /* -------- row actions -------- */
    els.tableBody.addEventListener('click', async function (e) {
        if (isPending()) return;

        const btn = e.target.closest('button[data-action]');
        if (!btn) return;

        const row = btn.closest('tr');
        if (!row) return;

        const userId = Number(row.getAttribute('data-user-id'));
        const action = btn.getAttribute('data-action');

        if (action === 'edit') {
            state.editingId = userId;
            state.lastRenderKey = '';
            renderTable(false);
            const roleSelect = els.tableBody.querySelector(
                'tr[data-user-id="' + userId + '"] select[data-field="role"]'
            );
            if (roleSelect) setTimeout(function () { roleSelect.focus(); }, 30);
            return;
        }

        if (action === 'cancel') { cancelEdit(); return; }

        if (action === 'save') {
            const roleSel = row.querySelector('select[data-field="role"]');
            const statusSel = row.querySelector('select[data-field="status"]');
            if (!roleSel || !statusSel) return;

            const newRole = roleSel.value;
            const newStatus = statusSel.value;
            const original = findLocalUser(userId);

            const oldRole = original ? original.role : null;
            const oldStatus = original ? original.status : null;

            if (original && original.role === newRole && original.status === newStatus) {
                state.editingId = null;
                refreshFromLocalState();
                notify('No changes were made.', 'warning');
                return;
            }

            if (original) {
                original.role = newRole;
                original.status = newStatus;
            }

            setPending('save', userId);
            renderTable(false);

            try {
                const res = await fetch(API_URL + '/' + userId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role: toDbRole(newRole), status: newStatus })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || data.error || 'Update failed');

                state.editingId = null;

                const serverMsg = (data && (data.message || data.msg)) || null;

                if (original && !matchesActiveFilters(original)) {
                    state.allUsers = state.allUsers.filter(function (u) {
                        return Number(u.user_id) !== userId;
                    });
                    clearPending();
                    refreshFromLocalState();
                    notify(serverMsg || 'Account updated. It no longer matches the current filters.', 'warning');
                } else {
                    clearPending();
                    refreshFromLocalState();
                    notify(serverMsg || 'Account updated successfully.', 'success');
                }
            } catch (err) {
                if (original) {
                    original.role = oldRole;
                    original.status = oldStatus;
                }
                clearPending();
                renderTable(false);
                console.error('[accounts] update failed:', err);
                notify(err.message || 'Update failed', 'error');
            }
            return;
        }

        if (action === 'delete') {
            const confirmed = await askConfirm(
                'This action can be undone by restoring from the database.',
                {
                    title: 'Delete account?',
                    confirmText: 'Delete',
                    cancelText: 'Cancel',
                    danger: true
                }
            );
            if (!confirmed) return;
            if (isPending()) return; // safety net after await

            setPending('delete', userId);
            renderTable(false);

            try {
                const res = await fetch(API_URL + '/' + userId, { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || data.error || 'Delete failed');

                state.allUsers = state.allUsers.filter(function (u) {
                    return Number(u.user_id) !== userId;
                });
                if (state.editingId === userId) state.editingId = null;

                clearPending();
                refreshFromLocalState();
                notify((data && (data.message || data.msg)) || 'Account deleted successfully.', 'success');
            } catch (err) {
                clearPending();
                renderTable(false);
                console.error('[accounts] delete failed:', err);
                notify(err.message || 'Delete failed', 'error');
            }
        }
    });

    /* -------- search / filters -------- */
    els.searchInput.addEventListener('input', function () {
        if (isPending()) return;
        updateCloseButton();

        els.statusFilter.value = 'all';
        els.roleFilter.value = 'all';
        state.appliedStatus = 'all';
        state.appliedRole = 'all';

        const val = els.searchInput.value;
        // 1–2 characters is below the minimum: wait until it's 3+ (or empty)
        if (val.length > 0 && val.length < MIN_SEARCH_LENGTH) return;

        state.appliedSearch = val;
        state.page = 1;
        loadUsers({ silent: true });
    });

    els.searchInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (isPending()) return;

        const term = els.searchInput.value.trim();

        // 1–2 characters typed → warn, do not search
        if (term.length > 0 && term.length < MIN_SEARCH_LENGTH) {
            if (typeof showAlertTOP === 'function') {
                showAlertTOP('Search term too short', 'warning');
            } else {
                notify('Search term too short', 'warning');
            }
            return;
        }

        // valid term (3+ chars, or empty = show all) → apply search + filters
        state.appliedStatus = els.statusFilter.value;
        state.appliedRole = els.roleFilter.value;
        state.appliedSearch = els.searchInput.value;
        state.page = 1;
        loadUsers();
    });

    els.searchBox.addEventListener('click', function (e) {
        if (e.target === closeBtn || closeBtn.contains(e.target)) return;
        if (isPending()) return;
        els.searchInput.focus();
    });

    closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (isPending()) return;
        els.searchInput.value = '';
        state.appliedSearch = '';
        updateCloseButton();
        state.page = 1;
        loadUsers({ silent: true });
        els.searchInput.focus();
    });

    els.filterBtn.addEventListener('click', function () {
        if (isPending()) return;
        state.appliedStatus = els.statusFilter.value;
        state.appliedRole = els.roleFilter.value;
        state.appliedSearch = els.searchInput.value;
        state.page = 1;
        loadUsers();
    });

    els.prevBtn.addEventListener('click', function () { goToPage(state.page - 1); });
    els.nextBtn.addEventListener('click', function () { goToPage(state.page + 1); });

    window.addEventListener('resize', centerActivePage);

    updateCloseButton();
    loadUsers();
});