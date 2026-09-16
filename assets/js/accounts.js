document.addEventListener('DOMContentLoaded', function () {
    const MAX_PAGE_BUTTONS = 5;
    const API_URL = 'api/users.php';

    const state = {
        data: [],
        page: 1,
        totalPages: 1,
        appliedSearch: '',
        appliedStatus: 'all',
        appliedRole: 'all',
        editingId: null,
        requestId: 0,
        lastRenderKey: ''
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

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'searchClearBtn';
    closeBtn.setAttribute('aria-label', 'Clear search');
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    els.searchBox.appendChild(closeBtn);

    function toDisplayRole(dbRole) {
        return dbRole === 'Grounds Staff' ? 'Ground Staff' : dbRole;
    }
    function toDbRole(displayRole) {
        return displayRole === 'Ground Staff' ? 'Grounds Staff' : displayRole;
    }

    async function fetchAccounts(options) {
        const opts = options || {};
        const silent = !!opts.silent;
        const reqId = ++state.requestId;

        const params = new URLSearchParams();
        params.set('page', state.page);
        if (state.appliedSearch) params.set('search_term', state.appliedSearch);
        if (state.appliedRole && state.appliedRole !== 'all') params.set('role', state.appliedRole);
        if (state.appliedStatus && state.appliedStatus !== 'all') params.set('status', state.appliedStatus);

        try {
            const res = await fetch(API_URL + '?' + params.toString());
            const text = await res.text();

            let data;
            try {
                data = JSON.parse(text);
            } catch (parseErr) {
                throw new Error('Server returned non-JSON (status ' + res.status + '): ' + text.slice(0, 300));
            }

            if (!res.ok) {
                throw new Error(data.message || data.error || ('HTTP ' + res.status));
            }

            if (reqId !== state.requestId) return;

            const payload = data.data || data;
            const users = Array.isArray(payload.users) ? payload.users : [];
            const pagination = payload.pagination || {};

            state.data = users.map(function (u) {
                return {
                    user_id: u.user_id,
                    name: u.name,
                    username: u.username,
                    email: u.email,
                    phone_number: u.phone_number,
                    role: toDisplayRole(u.role),
                    status: u.status
                };
            });
            state.page = pagination.current_page || 1;
            state.totalPages = pagination.total_pages || 1;

            renderTable(silent);
            renderPagination(silent);
        } catch (e) {
            if (reqId !== state.requestId) return;
            console.error('[accounts] failed to load accounts:', e);
        }
    }

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
        if (state.data.length === 0) return 'empty:' + state.editingId;
        return state.data.map(function (u) {
            return u.user_id + '|' + u.role + '|' + u.status;
        }).join(',') + ':' + state.editingId;
    }

    function renderTable(silent) {
        const rows = state.data;

        if (rows.length === 0) {
            if (state.lastRenderKey !== 'empty:' + state.editingId) {
                els.tableBody.innerHTML = '';
                state.lastRenderKey = 'empty:' + state.editingId;
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

            const roleCell = isEditing
                ? '<select class="cellSelect" data-field="role">' + buildOptions(ROLE_OPTIONS, user.role) + '</select>'
                : escapeHtml(user.role);

            const statusCell = isEditing
                ? '<select class="cellSelect" data-field="status">' + buildOptions(STATUS_OPTIONS, user.status) + '</select>'
                : escapeHtml(user.status);

            const actions = isEditing
                ? '<button type="button" class="actionBtn save-action" data-action="save" title="Save"><i class="fas fa-check"></i></button>' +
                '<button type="button" class="actionBtn delete-action" data-action="delete" title="Delete"><i class="fas fa-trash"></i></button>'
                : '<button type="button" class="actionBtn edit-action" data-action="edit" title="Edit"><i class="fas fa-pen"></i></button>' +
                '<button type="button" class="actionBtn delete-action" data-action="delete" title="Delete"><i class="fas fa-trash"></i></button>';

            return '<tr data-user-id="' + escapeHtml(user.user_id) + '">' +
                '<td>' + escapeHtml(user.name) + '</td>' +
                '<td>' + escapeHtml(user.username) + '</td>' +
                '<td>' + escapeHtml(user.email) + '</td>' +
                '<td>' + escapeHtml(user.phone_number) + '</td>' +
                '<td>' + roleCell + '</td>' +
                '<td>' + statusCell + '</td>' +
                '<td>' + escapeHtml(user.user_id) + '</td>' +
                '<td>' + actions + '</td>' +
                '</tr>';
        }).join('');

        if (!silent) {
            els.tableBody.classList.remove('animate');
            void els.tableBody.offsetWidth;
            els.tableBody.classList.add('animate');
        }

        if (els.tableScrollWrapper && prevScroll > 0) {
            els.tableScrollWrapper.scrollTop = prevScroll;
        }
    }

    function renderPagination(silent) {
        const total = state.totalPages;

        if (state.page > total) state.page = total;
        if (state.page < 1) state.page = 1;

        els.currentPageNum.textContent = state.page;
        els.totalPagesNum.textContent = total;

        els.prevBtn.disabled = state.page <= 1;
        els.nextBtn.disabled = state.page >= total;

        let startPage, endPage;

        if (total <= MAX_PAGE_BUTTONS) {
            startPage = 1;
            endPage = total;
        } else {
            const half = Math.floor(MAX_PAGE_BUTTONS / 2);
            startPage = state.page - half;
            endPage = startPage + MAX_PAGE_BUTTONS - 1;

            if (startPage < 1) {
                startPage = 1;
                endPage = MAX_PAGE_BUTTONS;
            }

            if (endPage > total) {
                endPage = total;
                startPage = total - MAX_PAGE_BUTTONS + 1;
            }
        }

        const existingButtons = els.carouselTrack.querySelectorAll('button');
        const existingValues = Array.from(existingButtons).map(function (b) { return b.textContent; });
        const newValues = [];
        for (let i = startPage; i <= endPage; i++) newValues.push(String(i));

        const sameSet = existingValues.length === newValues.length &&
            existingValues.every(function (v, i) { return v === newValues[i]; });

        if (sameSet) {
            existingButtons.forEach(function (btn, i) {
                const pageNum = startPage + i;
                btn.classList.toggle('active', pageNum === state.page);
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
            btn.addEventListener('click', function () { goToPage(i); });
            els.carouselTrack.appendChild(btn);
        }

        centerActivePage();
    }

    function centerActivePage() {
        const active = els.carouselTrack.querySelector('button.active');
        if (!active) {
            els.carouselTrack.style.transform = 'translateX(0)';
            return;
        }

        const vw = els.carouselViewport.clientWidth;
        const tw = els.carouselTrack.scrollWidth;
        if (tw <= vw) {
            els.carouselTrack.style.transform = 'translateX(0)';
            return;
        }

        const center = active.offsetLeft + active.offsetWidth / 2;
        let t = center - vw / 2;
        const max = tw - vw;
        if (t < 0) t = 0;
        if (t > max) t = max;
        els.carouselTrack.style.transform = 'translateX(' + (-t) + 'px)';
    }

    function goToPage(page) {
        if (page < 1 || page > state.totalPages) return;
        state.page = page;
        fetchAccounts();
    }

    function updateCloseButton() {
        const hasText = els.searchInput.value.length > 0;
        closeBtn.classList.toggle('is-visible', hasText);
        els.searchInput.style.paddingRight = hasText ? '36px' : '';
    }

    els.tableBody.addEventListener('click', async function (e) {
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
            return;
        }

        if (action === 'save') {
            const roleSel = row.querySelector('select[data-field="role"]');
            const statusSel = row.querySelector('select[data-field="status"]');
            if (!roleSel || !statusSel) return;

            try {
                const res = await fetch(API_URL + '/' + userId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        role: toDbRole(roleSel.value),
                        status: statusSel.value
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || data.error || 'Update failed');

                state.editingId = null;
                state.lastRenderKey = '';
                fetchAccounts();
            } catch (err) {
                console.error('[accounts] update failed:', err);
                alert(err.message || 'Update failed');
            }
            return;
        }

        if (action === 'delete') {
            if (!confirm('Delete this account? This action can be undone by restoring from database.')) return;

            try {
                const res = await fetch(API_URL + '/' + userId, { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || data.error || 'Delete failed');

                if (state.editingId === userId) state.editingId = null;
                state.lastRenderKey = '';
                fetchAccounts();
            } catch (err) {
                console.error('[accounts] delete failed:', err);
                alert(err.message || 'Delete failed');
            }
        }
    });

    els.searchInput.addEventListener('input', function () {
        updateCloseButton();

        els.statusFilter.value = 'all';
        els.roleFilter.value = 'all';
        state.appliedStatus = 'all';
        state.appliedRole = 'all';

        const val = els.searchInput.value;
        // API requires search_term >= 3 chars. Skip 1-2 char keystrokes.
        if (val.length === 1 || val.length === 2) return;

        state.appliedSearch = val;
        state.page = 1;
        fetchAccounts({ silent: true });
    });

    els.searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') e.preventDefault();
    });

    els.searchBox.addEventListener('click', function (e) {
        if (e.target === closeBtn || closeBtn.contains(e.target)) return;
        els.searchInput.focus();
    });

    closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        els.searchInput.value = '';
        state.appliedSearch = '';
        updateCloseButton();
        state.page = 1;
        fetchAccounts({ silent: true });
        els.searchInput.focus();
    });

    els.filterBtn.addEventListener('click', function () {
        state.appliedStatus = els.statusFilter.value;
        state.appliedRole = els.roleFilter.value;
        state.appliedSearch = els.searchInput.value;
        state.page = 1;
        fetchAccounts();
    });

    els.prevBtn.addEventListener('click', function () { goToPage(state.page - 1); });
    els.nextBtn.addEventListener('click', function () { goToPage(state.page + 1); });

    window.addEventListener('resize', centerActivePage);

    (function init() {
        updateCloseButton();
        fetchAccounts();
    })();
});