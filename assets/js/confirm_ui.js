/* confirm_ui.js — reusable, promise-based confirmation dialog
 * Usage:
 *   const ok = await confirm_ui('Are you sure?');
 *   const ok = await confirm_ui('Delete this?', {
 *       title: 'Delete item?',
 *       confirmText: 'Delete',
 *       cancelText: 'Cancel',
 *       danger: true
 *   });
 *
 *   // "keep open" mode (3rd arg = true):
 *   // after clicking confirm the dialog STAYS on screen with a loading
 *   // spinner and cannot be dismissed (no Esc, no backdrop, no cancel).
 *   // The promise resolves immediately so you can redirect / await work.
 *   await confirm_ui('Log out now?', { confirmText: 'Log out' }, true);
 *   location.href = '/logout';
 *
 *   // If you ever need to bail out of keep-open mode manually:
 *   confirm_ui.close();
 *
 *   // opts.keepOpen: true is an equivalent alternative to the 3rd arg.
 *   // Optional: opts.loadingText adds a label next to the spinner.
 */
(function (global) {
  "use strict";

  var STYLE_ID = "confirmUiStyles";

  var CSS = [
    ".confirmUi-overlay{",
    "position:fixed;inset:0;",
    "background:rgba(0,0,0,.55);",
    "display:flex;align-items:center;justify-content:center;",
    "z-index:99999;",
    "opacity:0;transition:opacity .2s ease-out;",
    "font-family:Arial,sans-serif;",
    "}",
    ".confirmUi-overlay.is-visible{opacity:1;}",

    ".confirmUi-dialog{",
    "width:320px;max-width:calc(100% - 32px);",
    "background:#fff;",
    "border-radius:14px;",
    "padding:20px;",
    "box-shadow:0 10px 30px rgba(0,0,0,.2);",
    "transform:scale(.95);",
    "transition:transform .2s ease-out;",
    "}",
    ".confirmUi-overlay.is-visible .confirmUi-dialog{transform:scale(1);}",
    ".confirmUi-dialog:focus{outline:none;}",

    ".confirmUi-title{",
    "font-size:18px;font-weight:600;",
    "margin:0 0 8px;color:#222;",
    "}",
    ".confirmUi-message{",
    "font-size:14px;color:#555;",
    "margin:0 0 18px;line-height:1.5;white-space:pre-line;",
    "}",

    ".confirmUi-actions{display:flex;justify-content:flex-end;gap:10px;}",

    ".confirmUi-btn{",
    "border:none;padding:8px 14px;border-radius:8px;",
    "cursor:pointer;font-size:13px;font-family:inherit;",
    "transition:.2s ease;",
    "display:inline-flex;align-items:center;justify-content:center;gap:6px;",
    "}",
    ".confirmUi-btn:focus-visible{outline:2px solid #3498db;outline-offset:2px;}",

    ".confirmUi-btn--cancel{background:#eee;color:#333;}",
    ".confirmUi-btn--cancel:hover{background:#ddd;}",

    ".confirmUi-btn--confirm{background:#3498db;color:#fff;}",
    ".confirmUi-btn--confirm:hover{background:#2980b9;}",

    ".confirmUi-btn--danger{background:#e74c3c;color:#fff;}",
    ".confirmUi-btn--danger:hover{background:#c0392b;}",

    /* --- busy / loading state --- */
    ".confirmUi-btn[disabled]{cursor:default;pointer-events:none;}",
    ".confirmUi-btn--cancel[disabled]{opacity:.5;}",
    ".confirmUi-btn--confirm[disabled],.confirmUi-btn--danger[disabled]{opacity:.85;}",

    ".confirmUi-spinner{",
    "width:14px;height:14px;flex:0 0 auto;",
    "border:2px solid rgba(255,255,255,.35);",
    "border-top-color:#fff;",
    "border-radius:50%;",
    "animation:confirmUiSpin 1.5s linear infinite;",
    "}",
    "@keyframes confirmUiSpin{to{transform:rotate(360deg);}}",

    "@media (prefers-reduced-motion:reduce){",
    ".confirmUi-overlay,.confirmUi-dialog{transition:none;}",
    "}",
  ].join("");

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var activeOverlay = null;
  var activeResolve = null;
  var lastFocused = null;

  function isLocked(overlay) {
    return overlay && overlay.dataset.locked === "1";
  }

  function close(result) {
    if (!activeOverlay) return;
    var overlay = activeOverlay;
    var resolve = activeResolve;
    activeOverlay = null;
    activeResolve = null;

    overlay.style.pointerEvents = "none";
    overlay.classList.remove("is-visible");
    document.removeEventListener("keydown", onKeydown, true);

    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      // Only restore focus if no new dialog has opened in the meantime.
      if (!activeOverlay) {
        if (lastFocused && typeof lastFocused.focus === "function") {
          try {
            lastFocused.focus();
          } catch (e) {
            /* ignore */
          }
        }
        lastFocused = null;
      }
    }, 200);

    if (resolve) resolve(!!result);
  }

  function onKeydown(e) {
    if (!activeOverlay) return;

    // Busy: nothing may dismiss the dialog, and keep focus inside it.
    if (isLocked(activeOverlay)) {
      if (e.key === "Tab") e.preventDefault();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      close(false);
      return;
    }
    if (e.key === "Tab") {
      var focusables = activeOverlay.querySelectorAll(".confirmUi-btn");
      if (focusables.length === 0) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Turn the dialog into an undismissable "working" state.
  function enterLoadingState(
    overlay,
    dialog,
    confirmBtn,
    cancelBtn,
    loadingText,
  ) {
    overlay.dataset.locked = "1";

    // Freeze the button width so swapping text -> spinner doesn't jump.
    var w = confirmBtn.offsetWidth;
    if (w > 0) confirmBtn.style.minWidth = w + "px";

    confirmBtn.disabled = true;
    cancelBtn.disabled = true;

    confirmBtn.textContent = "";
    var spinner = document.createElement("span");
    spinner.className = "confirmUi-spinner";
    spinner.setAttribute("aria-hidden", "true");
    confirmBtn.appendChild(spinner);

    if (loadingText) {
      var label = document.createElement("span");
      label.textContent = loadingText;
      confirmBtn.appendChild(label);
    }

    confirmBtn.setAttribute("aria-label", loadingText || "Working…");
    dialog.setAttribute("aria-busy", "true");
    dialog.setAttribute("tabindex", "-1");
    try {
      dialog.focus();
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * @param {string} message
   * @param {object} [options]
   * @param {boolean} [keepOpen=false]  true => on confirm, stay open with a
   *                                    spinner instead of closing.
   * @returns {Promise<boolean>}
   */
  function confirm_ui(message, options, keepOpen) {
    injectStyles();

    var opts = options || {};
    var title = opts.title === undefined ? "Confirm" : opts.title;
    var showTitle = opts.showTitle !== false && title !== null && title !== "";
    var confirmText = opts.confirmText || "Confirm";
    var cancelText = opts.cancelText || "Cancel";
    var danger = !!opts.danger;
    var loadingText = opts.loadingText == null ? "" : String(opts.loadingText);

    // 3rd argument wins; opts.keepOpen is an equivalent alternative.
    var stayOpen = keepOpen === undefined ? !!opts.keepOpen : !!keepOpen;

    if (activeOverlay) close(false);

    return new Promise(function (resolve) {
      lastFocused = document.activeElement;

      var overlay = document.createElement("div");
      overlay.className = "confirmUi-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");

      var dialog = document.createElement("div");
      dialog.className = "confirmUi-dialog";

      if (showTitle) {
        var h = document.createElement("h3");
        h.className = "confirmUi-title";
        h.textContent = String(title);
        dialog.appendChild(h);
      }

      var p = document.createElement("p");
      p.className = "confirmUi-message";
      p.textContent = message == null ? "" : String(message);
      dialog.appendChild(p);

      var actions = document.createElement("div");
      actions.className = "confirmUi-actions";

      var cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "confirmUi-btn confirmUi-btn--cancel";
      cancelBtn.textContent = cancelText;

      var confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className =
        "confirmUi-btn " +
        (danger ? "confirmUi-btn--danger" : "confirmUi-btn--confirm");
      confirmBtn.textContent = confirmText;

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      activeOverlay = overlay;
      activeResolve = resolve;

      cancelBtn.addEventListener("click", function () {
        if (isLocked(overlay)) return;
        close(false);
      });

      confirmBtn.addEventListener("click", function () {
        if (isLocked(overlay)) return;

        if (!stayOpen) {
          close(true);
          return;
        }

        // Keep-open mode: lock the UI, show the spinner, and resolve right
        // away so the caller can redirect or start async work.
        enterLoadingState(overlay, dialog, confirmBtn, cancelBtn, loadingText);
        activeResolve = null; // close() must not resolve a second time
        resolve(true);
      });

      overlay.addEventListener("mousedown", function (e) {
        if (e.target === overlay && !isLocked(overlay)) close(false);
      });

      document.addEventListener("keydown", onKeydown, true);

      requestAnimationFrame(function () {
        overlay.classList.add("is-visible");
        confirmBtn.focus();
      });
    });
  }

  // Escape hatch: force-close the current dialog (useful if a keep-open
  // flow fails and you don't want to navigate away).
  confirm_ui.close = function (result) {
    close(result === undefined ? false : result);
  };

  confirm_ui.isOpen = function () {
    return !!activeOverlay;
  };

  global.confirm_ui = confirm_ui;
})(window);
