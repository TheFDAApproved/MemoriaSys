(function () {
    'use strict';

    if (window.TableSkeleton && window.TableSkeleton.__memoria) return;

    var MIN_SHOW_MS = 300;
    var STYLE_ID = 'memoriaTableSkeletonStyles';
    var ROW_CLASS = 'skeleton-row';
    var LINE_CLASS = 'skeleton-line';
    var LOADING_CLASS = 'table-loading';
    var TARGET_CLASS = 'skeleton-target';

    var PAGES = [
        {
            key: 'records',
            match: /\/records(?:\.html|\.php)?\/?$/i,
            apiRe: /records\.php(?:\?|$)/i,
            tbodyId: 'burial_table_body',
            cols: 14,
            rows: 10
        },
        {
            key: 'reserve',
            match: /\/reserve(?:\.html|\.php)?\/?$/i,
            apiRe: /reserve\.php(?:\?|$)/i,
            tbodyId: 'reservation',
            cols: 7,
            rows: 10
        },
        {
            key: 'monitor',
            match: /\/monitor(?:\.html|\.php)?\/?$/i,
            apiRe: /monitor\.php(?:\?|$)/i,
            tbodyId: 'reservation',
            cols: 12,
            rows: 10
        }
    ];

    var pathname = '';
    try { pathname = (location.pathname || '').toLowerCase(); } catch (e) { }

    var page = null;
    for (var i = 0; i < PAGES.length; i++) {
        if (PAGES[i].match.test(pathname)) { page = PAGES[i]; break; }
    }
    if (!page) return;

    var CSS = [
        '@keyframes memoriaTableShimmer {',
        '    0%   { background-position: 200% 0; }',
        '    100% { background-position: -200% 0; }',
        '}',

        'html.' + LOADING_CLASS + ' {',
        '    cursor: progress;',
        '}',

        '.' + ROW_CLASS + ' > td {',
        '    padding: 12px 14px;',
        '    vertical-align: middle;',
        '    pointer-events: none;',
        '}',

        '.' + LINE_CLASS + ' {',
        '    display: block;',
        '    height: 12px;',
        '    border-radius: 6px;',
        '    background: linear-gradient(90deg, #eef1f5 0%, #f7f9fb 50%, #eef1f5 100%);',
        '    background-size: 200% 100%;',
        '    animation: memoriaTableShimmer 1.4s ease-in-out infinite;',
        '    will-change: background-position;',
        '}',

        '.' + ROW_CLASS + ' > td:nth-child(1)     .' + LINE_CLASS + ' { width: 55%; }',
        '.' + ROW_CLASS + ' > td:nth-child(2)     .' + LINE_CLASS + ' { width: 70%; }',
        '.' + ROW_CLASS + ' > td:nth-child(3n)    .' + LINE_CLASS + ' { width: 60%; }',
        '.' + ROW_CLASS + ' > td:nth-child(3n+1)  .' + LINE_CLASS + ' { width: 80%; }',
        '.' + ROW_CLASS + ' > td:nth-child(3n+2)  .' + LINE_CLASS + ' { width: 65%; }',
        '.' + ROW_CLASS + ' > td:last-child       .' + LINE_CLASS + ' { width: 45%; }',

        'html.' + LOADING_CLASS + ' tbody.' + TARGET_CLASS + ' {',
        '    pointer-events: none;',
        '}',

        'html.' + LOADING_CLASS + ' tbody.' + TARGET_CLASS + ' tr:not(.' + ROW_CLASS + ') > td {',
        '    visibility: hidden;',
        '    position: relative;',
        '}',

        'html.' + LOADING_CLASS + ' tbody.' + TARGET_CLASS + ' tr:not(.' + ROW_CLASS + ') > td::after {',
        '    content: "";',
        '    visibility: visible;',
        '    position: absolute;',
        '    top: 50%;',
        '    left: 14px;',
        '    right: 14px;',
        '    height: 12px;',
        '    border-radius: 6px;',
        '    background: linear-gradient(90deg, #eef1f5 0%, #f7f9fb 50%, #eef1f5 100%);',
        '    background-size: 200% 100%;',
        '    animation: memoriaTableShimmer 1.4s ease-in-out infinite;',
        '    transform: translateY(-50%);',
        '    pointer-events: none;',
        '    will-change: background-position;',
        '}',

        '@media (prefers-reduced-motion: reduce) {',
        '    .' + LINE_CLASS + ',',
        '    html.' + LOADING_CLASS + ' tbody.' + TARGET_CLASS + ' tr:not(.' + ROW_CLASS + ') > td::after {',
        '        animation: none;',
        '    }',
        '}'
    ].join('\n');

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    injectStyles();

    var root = document.documentElement;
    var showing = false;
    var shownAt = 0;
    var pending = 0;
    var hideTimer = null;
    var hidePending = false;

    function getTbody() {
        return document.getElementById(page.tbodyId);
    }

    function ensureTarget() {
        var tbody = getTbody();
        if (!tbody) return null;
        if (!tbody.classList.contains(TARGET_CLASS)) {
            tbody.classList.add(TARGET_CLASS);
        }
        return tbody;
    }

    function getNoData() {
        var tbody = getTbody();
        if (!tbody) return null;
        var scope = tbody.closest('.tableWrapper, .tableScrollWrapper, table') || document;
        return scope.querySelector('.noData');
    }

    function buildSkeletonFragment() {
        var frag = document.createDocumentFragment();
        for (var r = 0; r < page.rows; r++) {
            var tr = document.createElement('tr');
            tr.className = ROW_CLASS;
            tr.setAttribute('aria-hidden', 'true');
            for (var c = 0; c < page.cols; c++) {
                var td = document.createElement('td');
                var line = document.createElement('span');
                line.className = LINE_CLASS;
                td.appendChild(line);
                tr.appendChild(td);
            }
            frag.appendChild(tr);
        }
        return frag;
    }

    function cancelPendingHide() {
        hidePending = false;
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function forceHide() {
        cancelPendingHide();
        showing = false;
        shownAt = 0;
        root.classList.remove(LOADING_CLASS);

        var tbody = getTbody();
        if (!tbody) return;
        var rows = tbody.querySelectorAll('tr.' + ROW_CLASS);
        for (var k = 0; k < rows.length; k++) rows[k].remove();
    }

    function showSkeleton() {
        cancelPendingHide();

        var tbody = ensureTarget();
        if (!tbody) return;

        if (!showing) shownAt = Date.now();
        showing = true;
        root.classList.add(LOADING_CLASS);

        var noData = getNoData();
        if (noData) noData.style.display = 'none';

        var hasReal = tbody.querySelector('tr:not(.' + ROW_CLASS + ')');
        var hasPlaceholders = tbody.querySelector('tr.' + ROW_CLASS);

        if (!hasReal && !hasPlaceholders) {
            tbody.appendChild(buildSkeletonFragment());
        }
    }

    function hideSkeleton() {
        if (!showing) return;

        var remaining = MIN_SHOW_MS - (Date.now() - shownAt);
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

    function extractUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return String(input || '');
    }

    function extractMethod(input, init) {
        if (init && typeof init.method === 'string') return init.method.toUpperCase();
        if (input && typeof input === 'object' && typeof input.method === 'string') {
            return input.method.toUpperCase();
        }
        return 'GET';
    }

    function settle() {
        if (pending > 0) return;
        hideSkeleton();
    }

    if (typeof window.fetch === 'function') {
        var _fetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
            var url = extractUrl(input);
            var method = extractMethod(input, init);

            if (method !== 'GET' || !page.apiRe.test(url)) {
                return _fetch(input, init);
            }

            pending++;
            showSkeleton();

            return _fetch(input, init).then(
                function (res) { pending--; settle(); return res; },
                function (err) { pending--; settle(); throw err; }
            );
        };
    }

    window.TableSkeleton = {
        __memoria: true,
        MIN_SHOW_MS: MIN_SHOW_MS,
        page: page.key,

        show: showSkeleton,
        hide: hideSkeleton,
        isVisible: function () { return showing; },

        showDuring: function (promise) {
            showSkeleton();
            if (promise && typeof promise.finally === 'function') {
                promise.finally(function () { hideSkeleton(); });
            }
            return promise;
        },

        reset: function () {
            cancelPendingHide();
            forceHide();
        }
    };
})();