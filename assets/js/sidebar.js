document.addEventListener('DOMContentLoaded', async () => {
    const savedColor = localStorage.getItem('ui_main_color');
    if (savedColor) {
        document.documentElement.style.setProperty('--mainColor', savedColor);
        document.documentElement.style.setProperty('--primaryColor', savedColor);
        document.documentElement.style.setProperty('--primary-color', savedColor);
    }

    const logoToggle      = document.getElementById('logo_toggle');
    const sidebar         = document.getElementById('sidebar');
    const menuItems       = document.querySelectorAll('.sidebarNav .menu');
    const logoutBtn       = document.querySelector('.logout');
    const iframe          = document.querySelector('iframe[name="contentFrame"]');
    const frameLoader     = document.getElementById('frameLoader');
    const mobileHamburger = document.getElementById('mobileHamburger');
    const sidebarBackdrop = document.getElementById('sidebarBackdrop');

    if (sidebar) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                sidebar.classList.remove('no-transition');
            });
        });
    }

    /* ================================================================== *
     * MOBILE SIDEBAR — hamburger / backdrop / Escape / link-click
     * ------------------------------------------------------------------
     * Breakpoint MUST match the CSS media query in sidebar.css (1024px).
     * ================================================================== */
    const MOBILE_QUERY = '(max-width: 1024px)';
    const mobileMql    = window.matchMedia(MOBILE_QUERY);
    const isMobileView = () => mobileMql.matches;

    // Cache the <i> inside the button so we can swap bars <-> times.
    const hamburgerIcon = mobileHamburger
        ? mobileHamburger.querySelector('i')
        : null;

    const setHamburgerState = (open) => {
        if (!mobileHamburger) return;

        if (hamburgerIcon) {
            hamburgerIcon.classList.toggle('fa-bars',  !open);
            hamburgerIcon.classList.toggle('fa-times',  open);
        }

        mobileHamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
        mobileHamburger.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    };

    const openMobileSidebar = () => {
        if (!sidebar) return;
        sidebar.classList.remove('collapsed');
        sidebar.classList.add('mobile-open');
        if (sidebarBackdrop) sidebarBackdrop.classList.add('is-visible');
        setHamburgerState(true);
    };

    const closeMobileSidebar = () => {
        if (!sidebar) return;
        sidebar.classList.remove('mobile-open');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('is-visible');
        setHamburgerState(false);
    };

    const toggleMobileSidebar = () => {
        if (!sidebar) return;
        if (sidebar.classList.contains('mobile-open')) closeMobileSidebar();
        else openMobileSidebar();
    };

    if (mobileHamburger) {
        mobileHamburger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleMobileSidebar();
        });
    }

    if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', closeMobileSidebar);
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebar && sidebar.classList.contains('mobile-open')) {
            closeMobileSidebar();
        }
    });

    /* ---- Initial state: on a phone, always start closed and full-width. ---- */
    if (sidebar && isMobileView()) {
        sidebar.classList.remove('collapsed');
        closeMobileSidebar();
    }

    /* ---- React only when the breakpoint is actually crossed. ---- */
    let wasMobile = isMobileView();

    const syncSidebarToViewport = () => {
        if (!sidebar) return;

        if (isMobileView()) {
            closeMobileSidebar();
            sidebar.classList.remove('collapsed');
        } else {
            closeMobileSidebar();
            const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';
            sidebar.classList.toggle('collapsed', collapsed);
        }
    };

    const onBreakpointChange = () => {
        const nowMobile = isMobileView();
        if (nowMobile === wasMobile) return;
        wasMobile = nowMobile;
        syncSidebarToViewport();
    };

    if (typeof mobileMql.addEventListener === 'function') {
        mobileMql.addEventListener('change', onBreakpointChange);
    } else if (typeof mobileMql.addListener === 'function') {
        mobileMql.addListener(onBreakpointChange);
    }

    /* ------------------------------------------------------------------ *
     * Frame loader
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
     * Prefetch
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

            if (isMobileView()) closeMobileSidebar();

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
            if (isMobileView()) return;

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