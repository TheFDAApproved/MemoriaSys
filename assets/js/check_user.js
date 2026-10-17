(function () {
    'use strict';

    var LOGIN_PAGE = 'login.html';

    var PUBLIC_PAGES = [
        'login.html',
        'signup.html',
        'forgot_password.html'
    ];

    var ROLE_PAGE = {
        'Administrator': 'admin.html',
        'Grounds Staff': 'grounds.html',
        'Office Staff':   'office.html'
    };

    var PAGE_ROLE = (function () {
        var map = {};
        for (var role in ROLE_PAGE) {
            if (Object.prototype.hasOwnProperty.call(ROLE_PAGE, role)) {
                map[ROLE_PAGE[role].toLowerCase()] = role;
            }
        }
        return map;
    })();

    /* =================================================================
       IFRAME-AWARE NAVIGATION
       -------------------------------------------------------------
       The auth guard can run inside an <iframe> whose src is a
       protected page. In that case `location.replace(...)` only swaps
       the iframe's document — the browser URL bar never changes.
       We want the *top* window to leave the app for login.html.

       Three-tier strategy:
         1. window.top.location.replace(...)   (same-origin / sandbox-ok)
         2. window.top.postMessage(...)        (cross-origin handshake)
         3. window.location.replace(...)       (500 ms safety net so the
                                                user still sees a login
                                                form if #2 is ignored)

       PARENT REQUIREMENTS for tier 2 (cross-origin only — if the
       iframe and the shell share an origin, tier 1 always wins and
       you can skip this). Add ONCE to the parent page:

           window.addEventListener('message', function (ev) {
               // In production, also check ev.origin is the iframe's origin
               if (ev.data && ev.data.type === 'auth:redirect' &&
                   typeof ev.data.url === 'string') {
                   window.location.replace(ev.data.url);
               }
           });

       And ensure the <iframe> tag allows top navigation if sandboxed:

           sandbox="allow-scripts allow-same-origin allow-top-navigation"
       ================================================================= */

    function resolveUrl(page) {
        // Resolve against THIS document's URL, not the parent's, so
        // "login.html" lands next to the current page even when the
        // shell lives at a different path.
        try {
            return new URL(page, window.location.href).href;
        } catch (e) {
            return page; // shouldn't happen for a real http(s) page
        }
    }

    function navigateTop(page) {
        var absolute = resolveUrl(page);

        // ---- 1. Same-origin / sandbox-ok: drive the top directly ----
        try {
            window.top.location.replace(absolute);
            return;
        } catch (e) {
            // Cross-origin, or sandboxed without allow-top-navigation.
            // Fall through.
        }

        // ---- 2. Ask the parent to do it ------------------------------
        try {
            window.top.postMessage(
                { type: 'auth:redirect', url: absolute },
                '*'
            );
        } catch (e) {
            // Extremely rare; fall through to safety net below.
        }

        // ---- 3. Safety net -------------------------------------------
        // If the top hasn't navigated away within 500 ms, the parent
        // probably has no listener. Navigate *this* frame so the user
        // at least sees the login form instead of a blank panel.
        // If the top DOES navigate, this iframe is torn down first and
        // the timer never fires — no double navigation.
        setTimeout(function () {
            try {
                window.location.replace(absolute);
            } catch (e) {
                /* nothing more we can do */
            }
        }, 500);
    }

    /* =================================================================
       FIGURE OUT WHERE WE ARE
       -------------------------------------------------------------
       Strip trailing slashes so:
         /app/settings/    → "settings"
         /app/settings.html → "settings.html"
         /                  → ""
       The old code promoted "" to "login.html" and then matched it
       against PUBLIC_PAGES — which silently allowed any trailing-slash
       URL. We deliberately do NOT promote it any more: an empty page
       name falls through to the auth check, which is the safe default.
       ================================================================= */

    var current = (
        location.pathname.replace(/\/+$/, '').split('/').pop() || ''
    ).toLowerCase();

    // Public pages: no auth check, nothing to hide. The old code relied
    // on documentElement never having been set to visibility:hidden for
    // these pages — keep it that way.
    if (PUBLIC_PAGES.indexOf(current) !== -1) return;

    // Unknown pages (including "" for the root) get requiredRole = null,
    // meaning "any authenticated user is fine". If you want to lock down
    // unknown pages, change this to deny() instead of allow() below.
    var requiredRole = PAGE_ROLE[current] || null;

    document.documentElement.style.visibility = 'hidden';

    function allow() {
        document.documentElement.style.visibility = '';
    }

    function deny(page) {
        navigateTop(page || LOGIN_PAGE);
    }

    fetch('api/auth.php', { credentials: 'same-origin' })
        .then(function (res) {
            if (!res.ok) throw new Error('unauthenticated');
            return res.json();
        })
        .then(function (body) {
            var payload = (body && body.data) ? body.data : body;
            var role = payload && payload.role;

            if (!payload || !role) {
                deny(LOGIN_PAGE);
                return;
            }

            if (requiredRole && role !== requiredRole) {
                deny(ROLE_PAGE[role] || LOGIN_PAGE);
                return;
            }

            allow();
        })
        .catch(function () {
            deny(LOGIN_PAGE);
        });
})();