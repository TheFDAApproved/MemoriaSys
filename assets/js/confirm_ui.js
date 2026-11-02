(function (global) {
    "use strict";

    var STYLE_ID = "confirmUiStyles";

    var CSS = [
        // Makes padding and borders count inside an element's width
        ".confirmUi-overlay,.confirmUi-overlay *,.confirmUi-overlay *::before,.confirmUi-overlay *::after{box-sizing:border-box;}",

        // Full-screen backdrop that scrolls if the dialog is taller than the screen
        ".confirmUi-overlay{",
        "position:fixed;inset:0;",
        "background:rgba(0,0,0,.55);",
        "display:flex;align-items:flex-start;justify-content:center;",
        "overflow-x:hidden;overflow-y:auto;",
        "-webkit-overflow-scrolling:touch;",
        "overscroll-behavior:contain;",
        "z-index:99999;",
        "opacity:0;transition:opacity .2s ease-out;",
        "font-family:Arial,sans-serif;",
        "padding:clamp(12px,3vh,24px);",
        "}",
        ".confirmUi-overlay.is-visible{opacity:1;}",

        // The dialog card itself. Stays within the viewport at any zoom level
        ".confirmUi-dialog{",
        "width:320px;max-width:100%;",
        "background:#fff;",
        "border-radius:14px;",
        "padding:clamp(16px,4vw,20px);",
        "box-shadow:0 10px 30px rgba(0,0,0,.2);",
        "transform:scale(.95);",
        "transition:transform .2s ease-out;",
        "margin:auto;",
        "overflow-wrap:break-word;",
        "}",
        ".confirmUi-overlay.is-visible .confirmUi-dialog{transform:scale(1);}",
        ".confirmUi-dialog:focus{outline:none;}",

        // Title and message text
        ".confirmUi-title{",
        "font-size:clamp(16px,4.5vw,18px);font-weight:600;",
        "margin:0 0 8px;color:#222;",
        "overflow-wrap:anywhere;",
        "}",
        ".confirmUi-message{",
        "font-size:clamp(13px,3.8vw,14px);color:#555;",
        "margin:0 0 18px;line-height:1.5;white-space:pre-line;",
        "overflow-wrap:anywhere;",
        "}",

        // Button row
        ".confirmUi-actions{display:flex;justify-content:flex-end;gap:clamp(8px,2.5vw,10px);flex-wrap:wrap;}",

        // Shared button styles
        ".confirmUi-btn{",
        "border:none;padding:clamp(7px,2vw,8px) clamp(12px,3.5vw,14px);border-radius:8px;",
        "cursor:pointer;font-size:clamp(12.5px,3.6vw,13px);font-family:inherit;",
        "transition:.2s ease;",
        "display:inline-flex;align-items:center;justify-content:center;gap:6px;",
        "min-width:0;max-width:100%;",
        "overflow-wrap:anywhere;",
        "}",
        ".confirmUi-btn:focus-visible{outline:2px solid #3498db;outline-offset:2px;}",

        // Button variants
        ".confirmUi-btn--cancel{background:#eee;color:#333;}",
        ".confirmUi-btn--cancel:hover{background:#ddd;}",

        ".confirmUi-btn--confirm{background:#3498db;color:#fff;}",
        ".confirmUi-btn--confirm:hover{background:#2980b9;}",

        ".confirmUi-btn--danger{background:#e74c3c;color:#fff;}",
        ".confirmUi-btn--danger:hover{background:#c0392b;}",

        // Disabled / loading look for buttons
        ".confirmUi-btn[disabled]{cursor:default;pointer-events:none;}",
        ".confirmUi-btn--cancel[disabled]{opacity:.5;}",
        ".confirmUi-btn--confirm[disabled],.confirmUi-btn--danger[disabled]{opacity:.85;}",

        // Loading spinner shown inside the confirm button
        ".confirmUi-spinner{",
        "width:14px;height:14px;flex:0 0 auto;",
        "border:2px solid rgba(255,255,255,.35);",
        "border-top-color:#fff;",
        "border-radius:50%;",
        "animation:confirmUiSpin 1.5s linear infinite;",
        "}",
        "@keyframes confirmUiSpin{to{transform:rotate(360deg);}}",

        // On very small screens, stack buttons so they stay fully visible
        "@media (max-width:360px){",
        ".confirmUi-actions{flex-direction:column;align-items:stretch;}",
        ".confirmUi-btn{width:100%;}",
        "}",

        // Respect users who prefer reduced motion
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

    // State
    var activeOverlay = null;
    var activeResolve = null;
    var lastFocused = null;

    // Busy state: dialog cannot be dismissed while loading
    function isLocked(overlay) {
        return overlay && overlay.dataset.locked === "1";
    }

    // Pinned state: only the button may close the dialog
    function isPinned(overlay) {
        return overlay && overlay.dataset.pinned === "1";
    }

    // Open / Close
    function close(result) {
        if (!activeOverlay) return;
        var overlay = activeOverlay;
        var resolve = activeResolve;
        activeOverlay = null;
        activeResolve = null;

        overlay.style.pointerEvents = "none";
        overlay.classList.remove("is-visible");
        document.removeEventListener("keydown", onKeydown, true);

        // Remove the overlay after the fade-out finishes
        setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);

            // Restore focus only if no other dialog opened in the meantime
            if (!activeOverlay) {
                if (lastFocused && typeof lastFocused.focus === "function") {
                    try {
                        lastFocused.focus();
                    } catch (e) {
                    }
                }
                lastFocused = null;
            }
        }, 200);

        if (resolve) resolve(!!result);
    }

    // Keyboard Handling
    function onKeydown(e) {
        if (!activeOverlay) return;

        // While loading, block Tab and do not allow Esc to close
        if (isLocked(activeOverlay)) {
            if (e.key === "Tab") e.preventDefault();
            return;
        }

        if (e.key === "Escape") {
            // Pinned dialogs must be closed by the button
            if (isPinned(activeOverlay)) {
                e.preventDefault();
                return;
            }
            e.preventDefault();
            close(false);
            return;
        }

        // Keep focus cycling inside the dialog
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

    // Loading State
    // Turns the dialog into a non-dismissable "working" state
    function enterLoadingState(
        overlay,
        dialog,
        confirmBtn,
        cancelBtn,
        loadingText,
    ) {
        overlay.dataset.locked = "1";

        // Keep button width steady when text is replaced by a spinner
        var w = confirmBtn.offsetWidth;
        if (w > 0) confirmBtn.style.minWidth = w + "px";

        confirmBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;

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
        }
    }

    // Public API
    function confirm_ui(
        message,
        options,
        keepOpen,
        nocancelbutton,
        taptheokbuttontoexit,
    ) {
        injectStyles();

        var opts = options || {};
        var title = opts.title === undefined ? "Confirm" : opts.title;
        var showTitle = opts.showTitle !== false && title !== null && title !== "";
        var danger = !!opts.danger;
        var loadingText = opts.loadingText == null ? "" : String(opts.loadingText);

        // Positional arguments take priority; opts.* are alternatives
        var stayOpen = keepOpen === undefined ? !!opts.keepOpen : !!keepOpen;
        var hideCancel =
            nocancelbutton === undefined
                ? !!(opts.noCancelButton || opts.hideCancelButton)
                : !!nocancelbutton;
        var mustTapButton =
            taptheokbuttontoexit === undefined
                ? !!opts.taptheokbuttontoexit
                : !!taptheokbuttontoexit;

        var confirmText = opts.confirmText || (hideCancel ? "OK" : "Confirm");
        var cancelText = opts.cancelText || "Cancel";

        // Only one dialog can be open at a time.
        if (activeOverlay) close(false);

        return new Promise(function (resolve) {
            lastFocused = document.activeElement;

            var overlay = document.createElement("div");
            overlay.className = "confirmUi-overlay";
            overlay.setAttribute("role", "dialog");
            overlay.setAttribute("aria-modal", "true");
            if (mustTapButton) overlay.dataset.pinned = "1";

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

            // Optional cancel button.
            var cancelBtn = null;
            if (!hideCancel) {
                cancelBtn = document.createElement("button");
                cancelBtn.type = "button";
                cancelBtn.className = "confirmUi-btn confirmUi-btn--cancel";
                cancelBtn.textContent = cancelText;
                actions.appendChild(cancelBtn);
            }

            var confirmBtn = document.createElement("button");
            confirmBtn.type = "button";
            confirmBtn.className =
                "confirmUi-btn " +
                (danger ? "confirmUi-btn--danger" : "confirmUi-btn--confirm");
            confirmBtn.textContent = confirmText;

            actions.appendChild(confirmBtn);
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            activeOverlay = overlay;
            activeResolve = resolve;

            if (cancelBtn) {
                cancelBtn.addEventListener("click", function () {
                    if (isLocked(overlay)) return;
                    close(false);
                });
            }

            confirmBtn.addEventListener("click", function () {
                if (isLocked(overlay)) return;

                if (!stayOpen) {
                    close(true);
                    return;
                }

                // Keep-open mode: lock the UI, show the spinner, and resolve right away so the caller can redirect or start async work
                enterLoadingState(overlay, dialog, confirmBtn, cancelBtn, loadingText);
                activeResolve = null;
                resolve(true);
            });

            // Backdrop click closes the dialog unless it is locked or pinned
            overlay.addEventListener("mousedown", function (e) {
                if (e.target !== overlay) return;
                if (isLocked(overlay)) return;
                if (isPinned(overlay)) return;
                close(false);
            });

            document.addEventListener("keydown", onKeydown, true);

            requestAnimationFrame(function () {
                overlay.classList.add("is-visible");
                confirmBtn.focus();
            });
        });
    }

    confirm_ui.close = function (result) {
        close(result === undefined ? false : result);
    };

    confirm_ui.isOpen = function () {
        return !!activeOverlay;
    };

    global.confirm_ui = confirm_ui;
})(window);