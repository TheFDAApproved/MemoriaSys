document.addEventListener('DOMContentLoaded', function () {
    const MAX_PAGE_BUTTONS = 5;
    const PER_PAGE = 10;
    const MAX_SERVER_PAGES = 200;
    const API_URL = 'api/users.php';

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

    function formatPhoneDisplay(phone) {
        if (!phone) return '';
        var digits = String(phone).replace(/\D/g, '');

        if (digits.length >= 12 && digits.slice(0, 2) === '63') {
            digits = digits.slice(2);
        } else if (digits.length === 11 && digits.charAt(0) === '0') {
            digits = digits.slice(1);
        }

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
        digits = digits.replace(/^0/, '').replace(/^63/, '');
        digits = digits.slice(0, 10);

        var formatted = '+63';
        if (digits.length > 0) formatted += ' ' + digits.slice(0, 3);
        if (digits.length > 3) formatted += ' ' + digits.slice(3, 6);
        if (digits.length > 6) formatted += ' ' + digits.slice(6, 10);
        return formatted;
    }

    function formatPhoneForDb(displayValue) {
        var digits = String(displayValue).replace(/\D/g, '');
        if (digits.length === 12 && digits.slice(0, 2) === '63') {
            return '+' + digits;
        }
        if (digits.length === 11 && digits.charAt(0) === '0') {
            return '+63' + digits.slice(1);
        }
        if (digits.length === 10) {
            return '+63' + digits;
        }
        return null;
    }

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
            try {
                data = JSON.parse(text);
            } catch (parseErr) {
                throw new Error('Server returned non-JSON (status ' + res.status + '): ' + text.slice(0, 300));
            }

            if (!res.ok) {
                throw new Error(data.message || data.error || ('HTTP ' + res.status));
            }

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

            applyPage();
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
        if (state.data.length === 0) return 'empty:' + state.editingId + ':' + state.page;
        return state.data.map(function (u) {
            return u.user_id + '|' + u.role + '|' + u.status + '|' + (u.phone_number || '');
        }).join(',') + ':' + state.editingId + ':' + state.page;
    }

    function renderTable(silent) {
        const rows = state.data;

        if (rows.length === 0) {
            const emptyKey = 'empty:' + state.editingId + ':' + state.page;
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

            const roleCell = isEditing
                ? '<select class="cellSelect" data-field="role">' + buildOptions(ROLE_OPTIONS, user.role) + '</select>'
                : escapeHtml(user.role);

            const statusCell = isEditing
                ? '<select class="cellSelect" data-field="status">' + buildOptions(STATUS_OPTIONS, user.status) + '</select>'
                : escapeHtml(user.status);

            const phoneCell = isEditing
                ? '<input type="tel" class="cellSelect" data-field="phone_number" ' +
                'value="' + escapeHtml(formatPhoneDisplay(user.phone_number)) + '" ' +
                'placeholder="+63 912 345 6789" maxlength="16" autocomplete="off" ' +
                'inputmode="numeric" ' +
                'style="background-image:none;padding-right:10px;">'
                : escapeHtml(formatPhoneDisplay(user.phone_number));

            const actions = isEditing
                ? '<button type="button" class="actionBtn save-action" data-action="save" title="Save"><i class="fas fa-check"></i></button>' +
                '<button type="button" class="actionBtn delete-action" data-action="delete" title="Delete"><i class="fas fa-trash"></i></button>'
                : '<button type="button" class="actionBtn edit-action" data-action="edit" title="Edit"><i class="fas fa-pen"></i></button>' +
                '<button type="button" class="actionBtn delete-action" data-action="delete" title="Delete"><i class="fas fa-trash"></i></button>';

            return '<tr data-user-id="' + escapeHtml(user.user_id) + '">' +
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
        const existingValues = Array.prototype.map.call(existingButtons, function (b) { return b.textContent; });
        const newValues = [];
        for (let i = startPage; i <= endPage; i++) newValues.push(String(i));

        const sameSet = existingValues.length === newValues.length &&
            existingValues.every(function (v, i) { return v === newValues[i]; });

        if (sameSet) {
            Array.prototype.forEach.call(existingButtons, function (btn, i) {
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
            btn.addEventListener('click', (function (pageNum) {
                return function () { goToPage(pageNum); };
            })(i));
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

    els.tableBody.addEventListener('input', function (e) {
        const input = e.target;
        if (input && input.matches && input.matches('input[data-field="phone_number"]')) {
            input.value = formatPhoneInput(input.value);
        }
    });

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
            const phoneInput = row.querySelector('input[data-field="phone_number"]');
            if (phoneInput) setTimeout(function () { phoneInput.focus(); }, 30);
            return;
        }

        if (action === 'save') {
            const roleSel = row.querySelector('select[data-field="role"]');
            const statusSel = row.querySelector('select[data-field="status"]');
            const phoneInput = row.querySelector('input[data-field="phone_number"]');
            if (!roleSel || !statusSel) return;

            const body = {
                role: toDbRole(roleSel.value),
                status: statusSel.value
            };

            if (phoneInput) {
                const trimmed = phoneInput.value.trim();
                if (trimmed !== '' && trimmed !== '+63' && trimmed !== '+63 ') {
                    const forDb = formatPhoneForDb(trimmed);
                    if (forDb === null) {
                        alert('Please enter a valid Philippine mobile number (10 digits after +63).');
                        return;
                    }
                    body.phone_number = forDb;
                }
            }

            btn.disabled = true;

            try {
                const res = await fetch(API_URL + '/' + userId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || data.error || 'Update failed');

                state.editingId = null;
                state.lastRenderKey = '';

                await loadUsers();
            } catch (err) {
                console.error('[accounts] update failed:', err);
                alert(err.message || 'Update failed');
                btn.disabled = false;
            }
            return;
        }

        if (action === 'delete') {
            if (!confirm('Delete this account? This action can be undone by restoring from database.')) return;

            btn.disabled = true;
            try {
                const res = await fetch(API_URL + '/' + userId, { method: 'DELETE' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || data.error || 'Delete failed');

                if (state.editingId === userId) state.editingId = null;
                state.lastRenderKey = '';
                await loadUsers();
            } catch (err) {
                console.error('[accounts] delete failed:', err);
                alert(err.message || 'Delete failed');
                btn.disabled = false;
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
        if (val.length === 1 || val.length === 2) return;

        state.appliedSearch = val;
        state.page = 1;
        loadUsers({ silent: true });
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
        loadUsers({ silent: true });
        els.searchInput.focus();
    });

    els.filterBtn.addEventListener('click', function () {
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