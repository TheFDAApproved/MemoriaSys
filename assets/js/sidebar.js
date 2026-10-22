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
    const frameLoader = document.getElementById('frameLoader');

    if (sidebar) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                sidebar.classList.remove('no-transition');
            });
        });
    }

    /* ------------------------------------------------------------------ *
     * Frame loader — shows a branded spinner over the iframe while a page
     * is fetching/parsing, so the user never sees a blank white area.
     * ------------------------------------------------------------------ */
    const LOADER_DELAY       = 120;   // don't flash the spinner on fast loads
    const LOADER_MIN_VISIBLE = 250;   // avoid a 1-frame flicker
    const LOADER_MAX_WAIT    = 6000;  // safety: never trap the user behind the spinner

    let loaderShowTimer = null;
    let loaderHideTimer = null;
    let loaderMaxTimer  = null;
    let loaderShownAt   = Date.now();

    const showFrameLoader = (delay = LOADER_DELAY) => {
        if (!frameLoader) return;
        clearTimeout(loaderShowTimer);
        clearTimeout(loaderHideTimer);
        clearTimeout(loaderMaxTimer);

        const reveal = () => {
            loaderShownAt = Date.now();
            frameLoader.classList.add('is-visible');
        };

        if (delay > 0) loaderShowTimer = setTimeout(reveal, delay);
        else reveal();

        // If something hangs (slow image, broken API), reveal the partial page anyway
        loaderMaxTimer = setTimeout(hideFrameLoader, LOADER_MAX_WAIT);
    };

    const hideFrameLoader = () => {
        if (!frameLoader) return;
        clearTimeout(loaderShowTimer);
        clearTimeout(loaderMaxTimer);
        clearTimeout(loaderHideTimer);

        const elapsed = Date.now() - loaderShownAt;
        const wait = Math.max(0, LOADER_MIN_VISIBLE - elapsed);

        loaderHideTimer = setTimeout(() => {
            frameLoader.classList.remove('is-visible');
        }, wait);
    };

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
            showFrameLoader(0); // we're about to change src — cover the gap right away
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

    /* ------------------------------------------------------------------ *
     * Prefetch: warm the HTTP cache on hover/focus so the iframe paints
     * almost instantly when the user actually clicks.
     * ------------------------------------------------------------------ */
    const prefetched = new Set();

    const prefetchPage = (url) => {
        if (!url || prefetched.has(url)) return;
        prefetched.add(url);
        fetch(url, { credentials: 'same-origin', priority: 'low' })
            .catch(() => { /* ignore — this is an optimisation only */ });
    };

    menuItems.forEach(item => {
        const href = item.getAttribute('href');
        if (!href) return;
        item.addEventListener('pointerenter', () => prefetchPage(href), { passive: true });
        item.addEventListener('focus', () => prefetchPage(href));
    });

    menuItems.forEach(item => {
        item.addEventListener('click', function (e) {
            const pageUrl = this.getAttribute('href');
            if (!pageUrl || !iframe) return;

            e.preventDefault();

            if (iframe.getAttribute('src') === pageUrl) return;

            menuItems.forEach(i => i.classList.remove('active'));
            this.classList.add('active');
            localStorage.setItem('activePage', pageUrl);

            // Start the network request immediately — no waiting on animation.
            showFrameLoader();
            iframe.src = pageUrl;
        });
    });

    if (iframe) {
        iframe.addEventListener('load', () => {
            hideFrameLoader();
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
            const ok = await confirm_ui('Are you sure you want to logout?', {
                title: 'Log out?',
                confirmText: 'Log out',
                cancelText: 'Cancel',
                danger: true
            },true);
            if (!ok) return;

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

    updateSidebarTime();
    setInterval(updateSidebarTime, 1000);
});

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
    const frameLoader = document.getElementById('frameLoader');
    const hamburgerBtn = document.getElementById('mobileHamburger');
    const backdrop = document.getElementById('sidebarBackdrop');

    if (sidebar) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                sidebar.classList.remove('no-transition');
            });
        });
    }

    /* ------------------------------------------------------------------ *
     * Mobile sidebar (hamburger) state
     * ------------------------------------------------------------------ */
    const MOBILE_BREAKPOINT = 1024;
    const isMobile = () => window.innerWidth <= MOBILE_BREAKPOINT;

    function openMobileSidebar() {
        if (!sidebar) return;
        // Remember desktop collapse state so we can restore it later.
        sidebar.dataset.wasCollapsed = sidebar.classList.contains('collapsed') ? '1' : '0';
        sidebar.classList.remove('collapsed');
        sidebar.classList.add('mobile-open');
        if (backdrop) backdrop.classList.add('is-visible');
        if (hamburgerBtn) {
            hamburgerBtn.setAttribute('aria-expanded', 'true');
            hamburgerBtn.setAttribute('aria-label', 'Close navigation');
            const icon = hamburgerBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-times';
        }
    }

    function closeMobileSidebar() {
        if (!sidebar) return;
        sidebar.classList.remove('mobile-open');
        if (backdrop) backdrop.classList.remove('is-visible');
        if (hamburgerBtn) {
            hamburgerBtn.setAttribute('aria-expanded', 'false');
            hamburgerBtn.setAttribute('aria-label', 'Open navigation');
            const icon = hamburgerBtn.querySelector('i');
            if (icon) icon.className = 'fas fa-bars';
        }
        // Restore the desktop collapse state so nothing breaks when
        // the viewport is widened later.
        if (sidebar.dataset.wasCollapsed === '1') {
            sidebar.classList.add('collapsed');
        }
        delete sidebar.dataset.wasCollapsed;
    }

    if (hamburgerBtn) {
        hamburgerBtn.addEventListener('click', () => {
            if (!sidebar) return;
            if (sidebar.classList.contains('mobile-open')) closeMobileSidebar();
            else openMobileSidebar();
        });
    }

    if (backdrop) {
        backdrop.addEventListener('click', closeMobileSidebar);
    }

    // Close on Escape (a11y)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebar && sidebar.classList.contains('mobile-open')) {
            closeMobileSidebar();
        }
    });

    // Close the mobile drawer when a nav link is clicked
    menuItems.forEach(item => {
        item.addEventListener('click', () => {
            if (isMobile() && sidebar && sidebar.classList.contains('mobile-open')) {
                closeMobileSidebar();
            }
        });
    });

    // If the viewport grows past the breakpoint, drop the mobile drawer
    // so it doesn't leave a stale off-screen/on-screen state.
    window.addEventListener('resize', () => {
        if (!isMobile() && sidebar && sidebar.classList.contains('mobile-open')) {
            closeMobileSidebar();
        }
    });

    /* ------------------------------------------------------------------ *
     * Frame loader — shows a branded spinner over the iframe while a page
     * is fetching/parsing, so the user never sees a blank white area.
     * ------------------------------------------------------------------ */
    const LOADER_DELAY       = 120;
    const LOADER_MIN_VISIBLE = 250;
    const LOADER_MAX_WAIT    = 6000;

    let loaderShowTimer = null;
    let loaderHideTimer = null;
    let loaderMaxTimer  = null;
    let loaderShownAt   = Date.now();

    const showFrameLoader = (delay = LOADER_DELAY) => {
        if (!frameLoader) return;
        clearTimeout(loaderShowTimer);
        clearTimeout(loaderHideTimer);
        clearTimeout(loaderMaxTimer);

        const reveal = () => {
            loaderShownAt = Date.now();
            frameLoader.classList.add('is-visible');
        };

        if (delay > 0) loaderShowTimer = setTimeout(reveal, delay);
        else reveal();

        loaderMaxTimer = setTimeout(hideFrameLoader, LOADER_MAX_WAIT);
    };

    const hideFrameLoader = () => {
        if (!frameLoader) return;
        clearTimeout(loaderShowTimer);
        clearTimeout(loaderMaxTimer);
        clearTimeout(loaderHideTimer);

        const elapsed = Date.now() - loaderShownAt;
        const wait = Math.max(0, LOADER_MIN_VISIBLE - elapsed);

        loaderHideTimer = setTimeout(() => {
            frameLoader.classList.remove('is-visible');
        }, wait);
    };

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
            showFrameLoader(0);
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

    /* ------------------------------------------------------------------ *
     * Prefetch: warm the HTTP cache on hover/focus
     * ------------------------------------------------------------------ */
    const prefetched = new Set();

    const prefetchPage = (url) => {
        if (!url || prefetched.has(url)) return;
        prefetched.add(url);
        fetch(url, { credentials: 'same-origin', priority: 'low' })
            .catch(() => { });
    };

    menuItems.forEach(item => {
        const href = item.getAttribute('href');
        if (!href) return;
        item.addEventListener('pointerenter', () => prefetchPage(href), { passive: true });
        item.addEventListener('focus', () => prefetchPage(href));
    });

    menuItems.forEach(item => {
        item.addEventListener('click', function (e) {
            const pageUrl = this.getAttribute('href');
            if (!pageUrl || !iframe) return;

            e.preventDefault();

            if (iframe.getAttribute('src') === pageUrl) return;

            menuItems.forEach(i => i.classList.remove('active'));
            this.classList.add('active');
            localStorage.setItem('activePage', pageUrl);

            showFrameLoader();
            iframe.src = pageUrl;
        });
    });

    if (iframe) {
        iframe.addEventListener('load', () => {
            hideFrameLoader();
            iframe.classList.remove('fading');
        });
    }

    if (logoToggle && sidebar) {
        logoToggle.addEventListener('click', () => {
            // On mobile, tapping the logo closes the drawer — matching
            // the standard mobile-app pattern and avoiding a broken
            // "collapse-to-80px" state inside the drawer.
            if (isMobile()) {
                if (sidebar.classList.contains('mobile-open')) closeMobileSidebar();
                return;
            }

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
            const ok = await confirm_ui('Are you sure you want to logout?', {
                title: 'Log out?',
                confirmText: 'Log out',
                cancelText: 'Cancel',
                danger: true
            }, true);
            if (!ok) return;

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

    updateSidebarTime();
    setInterval(updateSidebarTime, 1000);
});

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