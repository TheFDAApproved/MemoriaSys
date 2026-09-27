(function () {
    'use strict';

    if (window.DashboardSkeleton && window.DashboardSkeleton.__memoria) return;

    var SESSION_KEY = 'memoria_dashboard_skeleton_shown_v1';
    var DATA_KEY = 'memoria_dashboard_cache_v1';
    var DIRTY_KEY = 'memoria_dashboard_dirty_v1';

    var MIN_SHOW_MS = 300;

    var LOADING_CLASS = 'dashboard-loading';
    var STYLE_ID = 'memoriaSkeletonStyles';

    var LOGIN_RE = /(?:^|[\/?&#._-])(?:login|signin|sign-in|log-?in)(?:[\/?&#._=-]|$)/i;
    var LOGOUT_RE = /(?:^|[\/?&#._-])(?:logout|signout|sign-out|log-?out)(?:[\/?&#._=-]|$)/i;
    var GET_MUTATION_RE = /[?&](?:action|do|cmd)=(?:delete|remove|edit|update|create|insert|add|save|store)\b/i;

    var root = document.documentElement;
    var hideTimer = null;
    var hidePending = false;
    var shownAt = 0;

    var SKELETON_HTML = [
        '<div class="dashboardSkeleton" aria-hidden="true">',
        '<section class="statsGrid">',

        '<div class="skeletonStatCard">',
        '<div class="skeletonStatTop">',
        '<span class="skeletonBlock skeletonLine skeletonLineMd"></span>',
        '<span class="skeletonBlock skeletonIcon"></span>',
        '</div>',
        '<div class="skeletonStatBottom">',
        '<span class="skeletonBlock skeletonValue"></span>',
        '</div>',
        '</div>',

        '<div class="skeletonStatCard">',
        '<div class="skeletonStatTop">',
        '<span class="skeletonBlock skeletonLine skeletonLineMd"></span>',
        '<span class="skeletonBlock skeletonIcon"></span>',
        '</div>',
        '<div class="skeletonStatBottom">',
        '<span class="skeletonBlock skeletonValue"></span>',
        '</div>',
        '</div>',

        '<div class="skeletonStatCard">',
        '<div class="skeletonStatTop">',
        '<span class="skeletonBlock skeletonLine skeletonLineMd"></span>',
        '<span class="skeletonBlock skeletonIcon"></span>',
        '</div>',
        '<div class="skeletonStatBottom">',
        '<span class="skeletonBlock skeletonValue"></span>',
        '<span class="skeletonBlock skeletonBadge"></span>',
        '</div>',
        '</div>',

        '<div class="skeletonStatCard">',
        '<div class="skeletonStatTop">',
        '<span class="skeletonBlock skeletonLine skeletonLineMd"></span>',
        '<span class="skeletonBlock skeletonIcon"></span>',
        '</div>',
        '<div class="skeletonStatBottom">',
        '<span class="skeletonBlock skeletonValue"></span>',
        '<span class="skeletonBlock skeletonBadge"></span>',
        '</div>',
        '</div>',

        '</section>',

        '<section class="chartsGrid">',

        '<div class="skeletonChartCard">',
        '<div class="skeletonChartHeader">',
        '<span class="skeletonBlock skeletonLine skeletonLineLg"></span>',
        '<span class="skeletonBlock skeletonLine skeletonLineSm"></span>',
        '</div>',
        '<div class="skeletonPieBody">',
        '<div class="skeletonPieCircleWrap">',
        '<div class="skeletonBlock skeletonPieCircle"></div>',
        '</div>',
        '<div class="skeletonLegend">',
        '<span class="skeletonBlock skeletonLegendRow"></span>',
        '<span class="skeletonBlock skeletonLegendRow"></span>',
        '<span class="skeletonBlock skeletonLegendRow"></span>',
        '<span class="skeletonBlock skeletonLegendRow"></span>',
        '<span class="skeletonBlock skeletonLegendRow"></span>',
        '</div>',
        '</div>',
        '</div>',

        '<div class="skeletonChartCard">',
        '<div class="skeletonChartHeader">',
        '<span class="skeletonBlock skeletonLine skeletonLineLg"></span>',
        '<span class="skeletonBlock skeletonLine skeletonLineSm"></span>',
        '</div>',
        '<div class="skeletonBars">',
        '<span class="skeletonBlock skeletonBar" style="height: 45%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 65%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 35%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 80%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 55%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 70%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 40%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 85%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 60%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 50%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 75%;"></span>',
        '<span class="skeletonBlock skeletonBar" style="height: 30%;"></span>',
        '</div>',
        '</div>',

        '</section>',
        '</div>'
    ].join('');

    var SKELETON_CSS = [
        '@keyframes memoriaSkeletonShimmer {',
        '0%   { background-position: 200% 0; }',
        '100% { background-position: -200% 0; }',
        '}',

        '.dashboardSkeleton {',
        'position: absolute;',
        'inset: 0;',
        'padding: 24px;',
        'box-sizing: border-box;',
        'display: grid;',
        'grid-template-rows: auto minmax(0, 1fr);',
        'gap: 28px;',
        'background: #f8fafc;',
        'z-index: 5;',
        'opacity: 0;',
        'visibility: hidden;',
        'pointer-events: none;',
        'transition: none;',
        '}',

        'html.dashboard-loading .dashboardSkeleton {',
        'opacity: 1;',
        'visibility: visible;',
        'transition: opacity 0.2s ease;',
        '}',

        '.dashboardContent > .statsGrid,',
        '.dashboardContent > .chartsGrid {',
        'opacity: 1;',
        'transition: none;',
        '}',

        'html.dashboard-loading .dashboardContent > .statsGrid,',
        'html.dashboard-loading .dashboardContent > .chartsGrid {',
        'opacity: 0;',
        'pointer-events: none;',
        'user-select: none;',
        'transition: opacity 0.2s ease;',
        '}',

        '.skeletonBlock {',
        'display: block;',
        'background: linear-gradient(90deg, #eef1f5 0%, #f7f9fb 50%, #eef1f5 100%);',
        'background-size: 200% 100%;',
        'animation: memoriaSkeletonShimmer 1.4s ease-in-out infinite;',
        'border-radius: 6px;',
        '}',

        '.skeletonStatCard {',
        'background: #ffffff;',
        'border: 1px solid #e2e8f0;',
        'border-radius: 14px;',
        'padding: 20px;',
        'display: flex;',
        'flex-direction: column;',
        'justify-content: space-between;',
        'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);',
        'min-width: 0;',
        'min-height: 0;',
        '}',

        '.skeletonStatTop {',
        'display: flex;',
        'justify-content: space-between;',
        'align-items: center;',
        'gap: 12px;',
        '}',

        '.skeletonStatBottom {',
        'display: flex;',
        'align-items: baseline;',
        'justify-content: space-between;',
        'margin-top: 16px;',
        'gap: 8px;',
        '}',

        '.skeletonLine {',
        'height: 10px;',
        'border-radius: 6px;',
        'width: 100%;',
        '}',
        '.skeletonLineSm { width: 40%; height: 8px; }',
        '.skeletonLineMd { width: 60%; }',
        '.skeletonLineLg { width: 60%; height: 12px; }',

        '.skeletonIcon {',
        'width: 38px;',
        'height: 38px;',
        'border-radius: 10px;',
        'flex-shrink: 0;',
        '}',

        '.skeletonValue {',
        'height: 28px;',
        'width: 45%;',
        'border-radius: 8px;',
        '}',

        '.skeletonBadge {',
        'width: 68px;',
        'height: 22px;',
        'border-radius: 20px;',
        'flex-shrink: 0;',
        '}',

        '.skeletonChartCard {',
        'background: #ffffff;',
        'border: 1px solid #e2e8f0;',
        'border-radius: 14px;',
        'padding: 22px 24px;',
        'display: flex;',
        'flex-direction: column;',
        'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);',
        'min-width: 0;',
        'min-height: 0;',
        'overflow: hidden;',
        '}',

        '.skeletonChartHeader {',
        'display: flex;',
        'flex-direction: column;',
        'gap: 8px;',
        'margin-bottom: 18px;',
        'flex-shrink: 0;',
        '}',

        '.skeletonPieBody {',
        'flex: 1;',
        'display: flex;',
        'flex-direction: column;',
        'gap: 18px;',
        'min-height: 0;',
        '}',

        '.skeletonPieCircleWrap {',
        'flex: 1;',
        'min-height: 0;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        '}',

        '.skeletonPieCircle {',
        'height: 100%;',
        'aspect-ratio: 1 / 1;',
        'max-width: 100%;',
        'border-radius: 50%;',
        'flex-shrink: 0;',
        '}',

        '.skeletonLegend {',
        'display: flex;',
        'flex-direction: column;',
        'gap: 8px;',
        'flex-shrink: 0;',
        '}',

        '.skeletonLegendRow {',
        'height: 14px;',
        'width: 100%;',
        'border-radius: 6px;',
        '}',

        '.skeletonBars {',
        'flex: 1;',
        'min-height: 0;',
        'display: flex;',
        'align-items: flex-end;',
        'justify-content: space-between;',
        'gap: 6px;',
        'padding: 8px 0 24px;',
        '}',

        '.skeletonBar {',
        'flex: 1;',
        'min-height: 8px;',
        'border-radius: 6px 6px 0 0;',
        '}'
    ].join('\n');

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = SKELETON_CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    function injectSkeletonMarkup() {
        var container = document.querySelector('.dashboardContent');
        if (!container) return false;
        if (container.querySelector('.dashboardSkeleton')) return true;
        container.insertAdjacentHTML('afterbegin', SKELETON_HTML);
        return true;
    }

    function storageGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
    function storageSet(k, v) { try { sessionStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function storageDel(k) { try { sessionStorage.removeItem(k); } catch (e) { } }

    function cancelPendingHide() {
        hidePending = false;
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function forceHide() {
        cancelPendingHide();
        shownAt = 0;
        root.classList.remove(LOADING_CLASS);
    }

    function showSkeleton() {
        cancelPendingHide();

        injectSkeletonMarkup();

        if (root.classList.contains(LOADING_CLASS)) return;

        shownAt = Date.now();
        root.classList.add(LOADING_CLASS);
    }

    function hideSkeleton() {
        if (!root.classList.contains(LOADING_CLASS)) return;

        var elapsed = Date.now() - shownAt;
        var remaining = MIN_SHOW_MS - elapsed;

        if (remaining > 0) {
            hidePending = true;
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(function () {
                hideTimer = null;
                if (hidePending) forceHide();
            }, remaining);
            return;
        }

        forceHide();
    }

    function readCache() {
        var raw = storageGet(DATA_KEY);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }
    function writeCache(data) {
        try { return storageSet(DATA_KEY, JSON.stringify(data)); } catch (e) { return false; }
    }

    function markDirty() {
        storageSet(DIRTY_KEY, String(Date.now()));

        if (document.querySelector('.dashboardContent')) {
            try {
                window.dispatchEvent(new CustomEvent('dashboard:invalidated'));
            } catch (e) {
                try {
                    var ev = document.createEvent('Event');
                    ev.initEvent('dashboard:invalidated', true, true);
                    window.dispatchEvent(ev);
                } catch (_) { }
            }
        }
    }
    function isDirty() { return !!storageGet(DIRTY_KEY); }
    function clearDirty() { storageDel(DIRTY_KEY); }

    function clearSessionFlag() {
        storageDel(SESSION_KEY);
        storageDel(DATA_KEY);
        storageDel(DIRTY_KEY);
    }
    function urlLooksLikeLogout(url) { return !!url && LOGOUT_RE.test(String(url)); }

    function parseRequest(input, init) {
        var url = '', method = 'GET';
        try {
            if (typeof input === 'string') url = input;
            else if (input && typeof input === 'object' && input.url) url = input.url;
        } catch (e) { }
        try {
            if (init && init.method) method = String(init.method).toUpperCase();
            else if (input && input.method) method = String(input.method).toUpperCase();
        } catch (e) { }
        return { url: url, method: method };
    }

    function isDashboardRead(url) {
        return /api\/dashboard\.php/i.test(String(url || ''));
    }

    function requestLooksLikeMutation(req) {
        if (isDashboardRead(req.url)) return false;
        if (urlLooksLikeLogout(req.url)) return false;

        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
            return true;
        }
        return GET_MUTATION_RE.test(req.url || '');
    }

    if (typeof window.fetch === 'function') {
        var _fetch = window.fetch;
        window.fetch = function (input, init) {
            var req = parseRequest(input, init);

            if (urlLooksLikeLogout(req.url)) clearSessionFlag();

            var willMarkDirty = requestLooksLikeMutation(req);
            var promise = _fetch.apply(this, arguments);

            if (!willMarkDirty) return promise;

            return promise.then(function (res) {
                if (res && res.ok) markDirty();
                return res;
            });
        };
    }

    if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
        var _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            var req = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };

            if (urlLooksLikeLogout(req.url)) clearSessionFlag();

            if (requestLooksLikeMutation(req) && this.addEventListener) {
                var self = this;
                this.addEventListener('load', function () {
                    if (self.status >= 200 && self.status < 400) markDirty();
                });
            }
            return _open.apply(this, arguments);
        };
    }

    document.addEventListener('click', function (e) {
        var el = e.target;
        while (el && el !== document) {
            var href = el.getAttribute && el.getAttribute('href');
            var id = el.id || '';
            var cls = (el.className || '').toString();
            var data = el.dataset || {};
            if (urlLooksLikeLogout(href) ||
                LOGOUT_RE.test(id) || LOGOUT_RE.test(cls) ||
                (data.action && LOGOUT_RE.test(data.action)) ||
                (data.url && LOGOUT_RE.test(data.url))) {
                clearSessionFlag();
                return;
            }
            el = el.parentElement;
        }
    }, true);

    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (form && urlLooksLikeLogout(form.getAttribute('action') || '')) clearSessionFlag();
    }, true);

    window.DashboardSkeleton = {
        __memoria: true,
        MIN_SHOW_MS: MIN_SHOW_MS,

        show: showSkeleton,
        hide: hideSkeleton,
        isVisible: function () { return root.classList.contains(LOADING_CLASS); },

        showDuring: function (promise) {
            showSkeleton();
            if (promise && typeof promise.finally === 'function') {
                promise.finally(hideSkeleton);
            }
            return promise;
        },

        readCache: readCache,
        writeCache: writeCache,
        hasCache: function () { return !!readCache(); },
        isFirstLoad: function () { return !storageGet(SESSION_KEY); },

        isDirty: isDirty,
        invalidate: markDirty,
        consumeInvalidation: clearDirty,

        reset: function () {
            clearSessionFlag();
            cancelPendingHide();
            shownAt = 0;
            root.classList.remove(LOADING_CLASS);
        }
    };

    injectStyles();

    var onLoginPage = false;
    try {
        onLoginPage = LOGIN_RE.test(location.pathname) || LOGIN_RE.test(location.search);
    } catch (e) { }

    if (onLoginPage) {
        clearSessionFlag();
    } else {
        storageSet(SESSION_KEY, String(Date.now()));

        shownAt = Date.now();
        root.classList.add(LOADING_CLASS);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () {
                if (!injectSkeletonMarkup()) {
                    forceHide();
                }
            });
        } else {
            if (!injectSkeletonMarkup()) forceHide();
        }
    }
})();