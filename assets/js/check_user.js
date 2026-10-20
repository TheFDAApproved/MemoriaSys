(function () {
    'use strict';

    var LOGIN_PAGE = 'login.html';

    /* =================================================================
       AUTH PAGES
       -------------------------------------------------------------
       Pages that are safe to view without being logged in.

       NOTE: this is no longer a "skip the auth check" list. The check
       runs on every page — this list only controls what we do when
       the user IS already authenticated:

         - on an auth page + logged in  → redirect to their dashboard
         - on an auth page + logged out → let them stay (form visible)

       Same page names as the old PUBLIC_PAGES list.
       ================================================================= */

    var AUTH_PAGES = [
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
        setTimeout(function () {
            try {
                window.location.replace(absolute);
            } catch (e) {
                /* nothing more we can do */
            }
        }, 500);
    }

    /* =================================================================
       SHARED HELPERS
       ================================================================= */

    function getInitials(username) {
        var words = String(username || '').trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) return '--';
        if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
        return (words[0][0] + words[1][0]).toUpperCase();
    }

    /* =================================================================
       FIGURE OUT WHERE WE ARE
       ================================================================= */

    var current = (
        location.pathname.replace(/\/+$/, '').split('/').pop() || ''
    ).toLowerCase();

    var isAuthPage   = AUTH_PAGES.indexOf(current) !== -1;
    var requiredRole = PAGE_ROLE[current] || null;

    /* Hide protected pages while the auth check is in flight so we
       never flash dashboard content to a user who's about to be
       bounced to login. Auth pages are left visible — showing the
       login form for ~100 ms before a redirect is far less jarring
       than a blank white page. */
    if (!isAuthPage) {
        document.documentElement.style.visibility = 'hidden';
    }

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
            var role    = payload && payload.role;

            /* ---------- 1. Not authenticated ---------- */
            if (!payload || !role) {
                if (isAuthPage) {
                    allow();          // stay on login / signup / forgot
                } else {
                    deny(LOGIN_PAGE); // protected page → login
                }
                return;
            }

            /* ---------- 2. Authenticated ---------- */
            // Where should this role go? May be null if the server
            // returned a role we don't have a page for.
            var homePage = ROLE_PAGE[role];

            if (isAuthPage) {
                /* Already logged in — send them to their dashboard.
                   If we don't know where that is (unknown role), leave
                   them on the auth page instead of bouncing them to
                   login.html, which would just bounce them back here. */
                if (homePage) {
                    deny(homePage);
                } else {
                    allow();
                }
                return;
            }

            /* On a protected page. If this page is role-locked and
               they don't match, send them to their own dashboard. */
            if (requiredRole && role !== requiredRole) {
                deny(homePage || LOGIN_PAGE);
                return;
            }

            /* ---------- 3. Populate the sidebar user card ---------- *
             * NEW: moved here from sidebar.js so the shell only makes
             * ONE call to api/auth.php instead of two. This runs only
             * on the shell pages (admin.html, grounds.html, office.html)
             * because:
             *
             *   - auth pages take the isAuthPage branch above and return
             *     before ever reaching this code, AND
             *   - sub-pages running inside the iframe don't have these
             *     DOM ids, so the getElementById guards no-op silently.
             *
             * Doing this BEFORE allow() means the user card is already
             * filled when the page is first revealed — no "--" flash,
             * no pop-in of name/role/initials on load.
             *
             * The `window.self === window.top` check is a cheap belt-
             * and-suspenders: it makes the "shell only" intent explicit
             * and skips three getElementById lookups when we're in the
             * iframe, even though the per-element guards would already
             * make it safe.
             * ------------------------------------------------------- */
            if (window.self === window.top) {
                var nameEl   = document.getElementById('user_name');
                var roleEl   = document.getElementById('user_role');
                var avatarEl = document.getElementById('user_avatar');

                var displayName = payload.username || payload.name || '';
                if (nameEl) nameEl.textContent = displayName;

                var roleLabel = payload.role === 'Grounds Staff' ? 'Ground Staff'
                    : payload.role === 'Office Staff' ? 'Office Staff'
                        : payload.role === 'Administrator' ? 'Administrator'
                            : payload.role || '';
                if (roleEl) roleEl.textContent = roleLabel;

                if (avatarEl) avatarEl.textContent = getInitials(displayName);
            }

            allow();
        })
        .catch(function () {
            /* Auth endpoint failed — fail closed, treat as logged out.
               Auth pages stay visible; protected pages bounce to login. */
            if (isAuthPage) {
                allow();
            } else {
                deny(LOGIN_PAGE);
            }
        });
})();