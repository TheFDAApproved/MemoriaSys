(function () {
  "use strict";

  var LOGIN_PAGE = "login.html";

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

  var AUTH_PAGES = ["login.html", "signup.html", "forgot_password.html"];

  var ROLE_PAGE = {
    Administrator: "admin.html",
    "Grounds Staff": "grounds.html",
    "Office Staff": "office.html",
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
       PER-ROLE PAGE WHITELIST  (NEW)
       -------------------------------------------------------------
       Empty array  → all sub-pages allowed for that role (today's
                      behavior — nothing is restricted).
       Non-empty    → only the listed sub-pages can be viewed by that
                      role. Any other sub-page the user opens (inside
                      the iframe OR as a naked URL) is redirected to
                      the user's own shell.

       Notes:
         - Shell pages (admin.html / grounds.html / office.html) are
           NOT listed here. They are always allowed for their own role
           (via the existing requiredRole check) and always denied for
           other roles (same check). Whitelists only affect sub-pages.
         - This is a UX guard, not a security boundary. The real
           security is api/auth.php (server-side session check). A
           user with devtools can bypass this; a user without a valid
           session cannot bypass the server.

       Example — restrict Administrator to just two pages:
           'Administrator': ['payments.html', 'accounts.html']
       ================================================================= */
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

  /* =================================================================
       NAKED-URL WHITELIST  (NEW)
       -------------------------------------------------------------
       Empty array  → every sub-page may be opened directly (top-level,
                      no shell) — today's behavior.
       Non-empty    → only the listed sub-pages may be opened naked.
                      Any other naked sub-page URL is redirected to the
                      user's shell, with the intended page preserved
                      via localStorage.activePage so it loads in the
                      iframe after the redirect.

       Notes:
         - Auth pages (login/signup/forgot) are exempt — they are
           meant to be top-level.
         - Shell pages are exempt — they are the shell.
         - Putting a shell or auth page in this list is a no-op; they
           never reach the naked check.

       Example — only a printable receipt may be naked:
           var NAKED_ALLOWED = ['receipt_print.html'];
       ================================================================= */
  var NAKED_ALLOWED = [""]; //so far nothing is allowed

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
      window.top.postMessage({ type: "auth:redirect", url: absolute }, "*");
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
    var words = String(username || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return "--";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  /* =================================================================
       FIGURE OUT WHERE WE ARE
       ================================================================= */

  var current = (
    location.pathname.replace(/\/+$/, "").split("/").pop() || ""
  ).toLowerCase();

  var isAuthPage = AUTH_PAGES.indexOf(current) !== -1;
  var requiredRole = PAGE_ROLE[current] || null;

  /* A "shell page" is one of admin.html / grounds.html / office.html —
       the pages that own the sidebar + iframe. Identified by being a
       key in PAGE_ROLE. Shell pages are the destination of a redirect,
       never the thing being guarded against a naked-URL whitelist. */
  var isShellPage = !!requiredRole;

  /* Naked = this document is the top-level window, not an iframe.
       Sub-pages inside the shell have window.self !== window.top. */
  var isNaked = window.self === window.top;

  /* Hide protected pages while the auth check is in flight so we
       never flash dashboard content to a user who's about to be
       bounced to login. Auth pages are left visible — showing the
       login form for ~100 ms before a redirect is far less jarring
       than a blank white page. */
  if (!isAuthPage) {
    document.documentElement.style.visibility = "hidden";
  }

  function allow() {
    document.documentElement.style.visibility = "";
  }

  function deny(page) {
    navigateTop(page || LOGIN_PAGE);
  }

  fetch("api/auth.php", { credentials: "same-origin" })
    .then(function (res) {
      if (!res.ok) throw new Error("unauthenticated");
      return res.json();
    })
    .then(function (body) {
      var payload = body && body.data ? body.data : body;
      var role = payload && payload.role;

      /* ---------- 1. Not authenticated ---------- */
      if (!payload || !role) {
        if (isAuthPage) {
          allow(); // stay on login / signup / forgot
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

      /* ---------- 3. Per-role page whitelist (NEW) ---------- *
       * Applies to sub-pages only. Empty list = no restriction.
       * If the list is non-empty and the current page isn't in
       * it, bounce the user to their own shell.
       *
       * This runs before the naked-URL check on purpose: if a
       * page is blocked by role, we deny without preserving it
       * in activePage (preserving it would just cause a loop
       * — the shell would restore it, the iframe would reload
       * it, and the role check would bounce again).
       * ----------------------------------------------------- */
      if (!isShellPage) {
        var allowedPages = ROLE_PAGES[role] || [];
        if (allowedPages.length > 0 && allowedPages.indexOf(current) === -1) {
          deny(homePage || LOGIN_PAGE);
          return;
        }
      }

      /* ---------- 4. Naked-URL whitelist (NEW) ---------- *
       * Applies to sub-pages viewed as the top-level window.
       * Empty list = every page can be naked (today).
       * Non-empty list = only listed pages can be naked; any
       * other naked sub-page is redirected into the shell,
       * with the intended page preserved so the iframe restores
       * it after the redirect.
       *
       * By the time we reach here, the role-whitelist check
       * above has already passed (or ROLE_PAGES is empty), so
       * preserving the page in activePage is safe — the iframe
       * will accept it on reload.
       * ----------------------------------------------------- */
      if (
        !isShellPage &&
        isNaked &&
        NAKED_ALLOWED.length > 0 &&
        NAKED_ALLOWED.indexOf(current) === -1
      ) {
        try {
          localStorage.setItem("activePage", current);
        } catch (e) {}
        deny(homePage || LOGIN_PAGE);
        return;
      }

      /* ---------- 5. Populate the sidebar user card ---------- *
       * Runs only on the shell pages. Auth pages return above,
       * and sub-pages don't have these DOM ids so the guards
       * no-op even if we got here (which we don't, because
       * isShellPage is false for them).
       * ----------------------------------------------------- */
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
      /* Auth endpoint failed — fail closed, treat as logged out.
               Auth pages stay visible; protected pages bounce to login. */
      if (isAuthPage) {
        allow();
      } else {
        deny(LOGIN_PAGE);
      }
    });
})();
