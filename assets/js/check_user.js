(function () {
    "use strict";

    // Where to send users who are not logged in
    var LOGIN_PAGE = "login.html";

    // Pages that can be viewed without being logged in
    // If a logged-in user opens one of these, they are sent to their dashboard
    var AUTH_PAGES = ["login.html", "signup.html", "forgot_password.html"];

    // The main "shell" page for each role
    var ROLE_PAGE = {
        Administrator: "admin.html",
        "Grounds Staff": "grounds.html",
        "Office Staff": "office.html",
    };

    // Reverse lookup: page name → role it belongs to
    // Used to check if the current page is a shell page
    var PAGE_ROLE = (function () {
        var map = {};
        for (var role in ROLE_PAGE) {
            if (Object.prototype.hasOwnProperty.call(ROLE_PAGE, role)) {
                map[ROLE_PAGE[role].toLowerCase()] = role;
            }
        }
        return map;
    })();

    // Which sub-pages each role is allowed to open
    // An empty list means "no restriction" for that role
    var ROLE_PAGES = {
        Administrator: [
            "accounts.html",
            "admin.html",
            "dashboard.html",
            "logs.html",
            "map.html",
            "monitor.html",
            "payments.html",
            "records.html",
            "reports.html",
            "reserve.html",
            "settings.html",
            "site_content.html",
        ],
        "Grounds Staff": [
            "dashboard.html",
            "grounds_payments.html",
            "grounds_reserve.html",
            "grounds.html",
            "user_profile.html",
        ],
        "Office Staff": [
            "dashboard.html",
            "map.html",
            "monitor.html",
            "office_payments.html",
            "office.html",
            "records.html",
            "reports.html",
            "reserve.html",
            "site_content.html",
            "user_profile.html",
        ],
    };

    // Sub-pages that may be opened directly [not inside the shell iframe]
    // Empty list = no restriction. A list with items = only those pages are allowed
    var NAKED_ALLOWED = [""];

    // Navigation Helpers
    // Turn a page name into a full URL
    function resolveUrl(page) {
        try {
            return new URL(page, window.location.href).href;
        } catch (e) {
            return page;
        }
    }

    // Redirect the top-most window to a page
    // Works even when the current document is loaded inside an iframe
    function navigateTop(page) {
        var absolute = resolveUrl(page);

        // 1. Try same-origin / sandbox-friendly redirect
        try {
            window.top.location.replace(absolute);
            return;
        } catch (e) {
            // Cross-origin or sandboxed without allow-top-navigation. Fall through.
        }

        // 2. Ask the parent window to redirect instead
        try {
            window.top.postMessage({ type: "auth:redirect", url: absolute }, "*");
        } catch (e) {
            // Very rare. Fall through to the safety net.
        }

        // 3. Fallback: redirect just this frame after a short delay
        setTimeout(function () {
            try {
                window.location.replace(absolute);
            } catch (e) {
                // Nothing more can be done.
            }
        }, 500);
    }

    // Build two-letter initials from a username
    function getInitials(username) {
        var words = String(username || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);

        if (words.length === 0) return "--";
        if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
        return (words[0][0] + words[1][0]).toUpperCase();
    }

    // Page Context
    // Current page name from the URL
    var current = (
        location.pathname.replace(/\/+$/, "").split("/").pop() || ""
    ).toLowerCase();

    var isAuthPage = AUTH_PAGES.indexOf(current) !== -1;
    var requiredRole = PAGE_ROLE[current] || null;

    // A shell page is one of admin.html / grounds.html / office.html
    var isShellPage = !!requiredRole;

    // Naked means this document is the top-level page, not inside an iframe
    var isNaked = window.self === window.top;

    // Visibility Helpers
    // Hide protected pages until the auth check finishes so content does not flash for users who will be redirected to login
    // Auth pages stay visible so the form can show immediately
    if (!isAuthPage) {
        document.documentElement.style.visibility = "hidden";
    }

    function allow() {
        document.documentElement.style.visibility = "";
    }

    function deny(page) {
        navigateTop(page || LOGIN_PAGE);
    }

    // Auth Check
    fetch("api/auth.php", { credentials: "same-origin" })
        .then(function (res) {
            if (!res.ok) throw new Error("unauthenticated");
            return res.json();
        })
        .then(function (body) {
            var payload = body && body.data ? body.data : body;
            var role = payload && payload.role;

            // 1. Not authenticated
            if (!payload || !role) {
                if (isAuthPage) {
                    allow();
                } else {
                    deny(LOGIN_PAGE);
                }
                return;
            }

            // 2. Authenticated
            var homePage = ROLE_PAGE[role];

            // Already logged in and on an auth page -> go to their dashboard
            if (isAuthPage) {
                if (homePage) {
                    deny(homePage);
                } else {
                    allow();
                }
                return;
            }

            // On a role-locked shell page but the wrong role -> send to own dashboard
            if (requiredRole && role !== requiredRole) {
                deny(homePage || LOGIN_PAGE);
                return;
            }

            // 3. Per-role page whitelist
            // Sub-pages only. Blocked pages are bounced without being saved, to prevent a redirect loop with the shell
            if (!isShellPage) {
                var allowedPages = ROLE_PAGES[role] || [];
                if (allowedPages.length > 0 && allowedPages.indexOf(current) === -1) {
                    deny(homePage || LOGIN_PAGE);
                    return;
                }
            }

            // 4. Naked-URL whitelist 
            // Sub-pages opened directly (not in the shell). Blocked pages are saved so the shell can reopen them after redirecting
            if (
                !isShellPage &&
                isNaked &&
                NAKED_ALLOWED.length > 0 &&
                NAKED_ALLOWED.indexOf(current) === -1
            ) {
                try {
                    localStorage.setItem("activePage", current);
                } catch (e) { }
                deny(homePage || LOGIN_PAGE);
                return;
            }

            // 5. Fill the sidebar user card 
            // Only shell pages have these elements
            if (isShellPage) {
                var nameEl = document.getElementById("user_name");
                var roleEl = document.getElementById("user_role");
                var avatarEl = document.getElementById("user_avatar");

                var displayName = payload.username || payload.name || "";
                if (nameEl) nameEl.textContent = displayName;

                var roleLabel =
                    payload.role === "Grounds Staff"
                        ? "Ground Staff"
                        : payload.role === "Office Staff"
                            ? "Office Staff"
                            : payload.role === "Administrator"
                                ? "Administrator"
                                : payload.role || "";
                if (roleEl) roleEl.textContent = roleLabel;

                if (avatarEl) avatarEl.textContent = getInitials(displayName);
            }

            allow();
        })
        .catch(function () {
            // Auth check failed - treat the user as logged out
            if (isAuthPage) {
                allow();
            } else {
                deny(LOGIN_PAGE);
            }
        });
})();