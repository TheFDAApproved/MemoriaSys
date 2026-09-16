document.addEventListener('DOMContentLoaded', async () => {
    const savedColor = localStorage.getItem('ui_main_color');
    if (savedColor) {
        document.documentElement.style.setProperty('--mainColor', savedColor);
        document.documentElement.style.setProperty('--primaryColor', savedColor);
        document.documentElement.style.setProperty('--primary-color', savedColor);
    }

    const logoToggle = document.getElementById('logo_toggle');
    const sidebar = document.getElementById('sidebar');
    const menuItems = document.querySelectorAll('.sidebarNav .menu');
    const logoutBtn = document.querySelector('.logout');
    const iframe = document.querySelector('iframe[name="contentFrame"]');

    if (sidebar) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                sidebar.classList.remove('no-transition');
            });
        });
    }

    const justLoggedIn = localStorage.getItem('justLoggedIn') === '1';
    if (justLoggedIn) {
        localStorage.removeItem('justLoggedIn');
        localStorage.removeItem('activePage');
        localStorage.removeItem('sidebarScrollTop');
    }

    const savedPage = localStorage.getItem('activePage');
    const defaultPage = iframe ? (iframe.getAttribute('src') || 'dashboard.html') : null;
    const targetPage = savedPage || defaultPage;

    if (targetPage && iframe) {
        let matched = false;

        menuItems.forEach(item => {
            const href = item.getAttribute('href');
            if (href === targetPage) {
                item.classList.add('active');
                matched = true;
            } else {
                item.classList.remove('active');
            }
        });

        if (!matched && menuItems.length > 0) {
            menuItems[0].classList.add('active');
        }

        if (savedPage && iframe.getAttribute('src') !== savedPage) {
            iframe.src = savedPage;
        }
    }

    const SIDEBAR_SCROLL_KEY = 'sidebarScrollTop';
    const ACTIVE_ITEM_PADDING = 12;

    const scrollEl = sidebar
        ? (sidebar.querySelector('.sidebarNav') || sidebar)
        : null;

    const saveSidebarScroll = () => {
        if (!scrollEl) return;
        try {
            localStorage.setItem(SIDEBAR_SCROLL_KEY, String(scrollEl.scrollTop));
        } catch (_) { }
    };

    const ensureActiveItemVisible = () => {
        if (!scrollEl) return;

        const activeItem = scrollEl.querySelector('.menu.active');
        if (!activeItem) return;

        const containerRect = scrollEl.getBoundingClientRect();
        const itemRect = activeItem.getBoundingClientRect();

        const itemTop = itemRect.top - containerRect.top;
        const itemBottom = itemRect.bottom - containerRect.top;

        let delta = 0;

        if (itemTop < ACTIVE_ITEM_PADDING) {
            delta = itemTop - ACTIVE_ITEM_PADDING;
        } else if (itemBottom > containerRect.height - ACTIVE_ITEM_PADDING) {
            delta = itemBottom - (containerRect.height - ACTIVE_ITEM_PADDING);
        }

        if (delta === 0) return;

        const target = scrollEl.scrollTop + delta;
        const max = scrollEl.scrollHeight - scrollEl.clientHeight;
        const clamped = Math.max(0, Math.min(target, max));

        scrollEl.scrollTo({ top: clamped, behavior: 'smooth' });
    };

    const restoreSidebarScroll = () => {
        if (!scrollEl) return;

        if (justLoggedIn) {
            scrollEl.scrollTop = 0;
            return;
        }

        const saved = parseInt(localStorage.getItem(SIDEBAR_SCROLL_KEY) || '0', 10) || 0;

        scrollEl.scrollTop = saved;

        requestAnimationFrame(() => {
            requestAnimationFrame(ensureActiveItemVisible);
        });
    };

    restoreSidebarScroll();

    window.addEventListener('beforeunload', saveSidebarScroll);
    window.addEventListener('pagehide', saveSidebarScroll);
    window.addEventListener('resize', () => {
        requestAnimationFrame(ensureActiveItemVisible);
    });

    menuItems.forEach(item => {
        item.addEventListener('click', function (e) {
            const pageUrl = this.getAttribute('href');
            if (!pageUrl || !iframe) return;

            if (iframe.getAttribute('src') === pageUrl) {
                e.preventDefault();
                return;
            }

            e.preventDefault();

            menuItems.forEach(i => i.classList.remove('active'));
            this.classList.add('active');
            localStorage.setItem('activePage', pageUrl);

            iframe.classList.add('fading');

            iframe.addEventListener('transitionend', function swap() {
                iframe.removeEventListener('transitionend', swap);
                iframe.src = pageUrl;
            }, { once: true });
        });
    });

    if (iframe) {
        iframe.addEventListener('load', () => {
            iframe.classList.remove('fading');
        });
    }

    if (logoToggle && sidebar) {
        logoToggle.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');

            const collapsed = sidebar.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', collapsed);

            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
            }, 300);
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to logout?')) return;

            try {
                await fetch('api/auth.php', { method: 'DELETE' });
            } catch (e) {
                console.error('Logout request failed', e);
            }

            localStorage.removeItem('activePage');
            localStorage.removeItem('sidebarCollapsed');
            localStorage.removeItem('sidebarScrollTop');
            window.location.href = 'login.html';
        });
    }

    try {
        const res = await fetch('api/auth.php');
        if (!res.ok) return;
        const body = await res.json();

        const payload = (body && body.data) ? body.data : body;
        if (!payload || (!payload.username && !payload.name)) return;

        const nameEl = document.getElementById('user_name');
        const roleEl = document.getElementById('user_role');
        const avatarEl = document.getElementById('user_avatar');

        const displayName = payload.username || payload.name || '';
        if (nameEl) nameEl.textContent = displayName;

        const roleLabel = payload.role === 'Grounds Staff' ? 'Ground Staff'
            : payload.role === 'Office Staff' ? 'Office Staff'
                : payload.role === 'Administrator' ? 'Administrator'
                    : payload.role || '';
        if (roleEl) roleEl.textContent = roleLabel;

        if (avatarEl) avatarEl.textContent = getInitials(displayName);
    } catch (err) {
        console.error('Failed to load sidebar user info:', err);
    }

    updateSidebarTime();
    setInterval(updateSidebarTime, 1000);
});

function getInitials(username) {
    const words = String(username || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '--';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

function updateSidebarTime() {
    const displayElement = document.getElementById('date_time_display');
    if (!displayElement) return;

    const now = new Date();
    const dateString = now.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    });
    const timeString = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
    });

    displayElement.textContent = `${dateString} | ${timeString}`;
}