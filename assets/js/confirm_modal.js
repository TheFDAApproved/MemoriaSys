(function (global) {
    'use strict';

    const MODAL_ID = 'confirmModalOverlay';

    let modalEl = null;
    let busy = false;
    let lastFocused = null;
    let currentOnConfirm = null;
    let currentOptions = null;
    let keydownHandler = null;
    let resolvePromise = null;

    // Styles
    const CSS = `
    .confirmModalOverlay,
    .confirmModalOverlay *,
    .confirmModalOverlay *::before,
    .confirmModalOverlay *::after{
      box-sizing:border-box;
    }

    /* Fullscreen overlay */
    .confirmModalOverlay{
      position:fixed; inset:0;
      background:rgba(15,23,42,.35);
      backdrop-filter:blur(4px);
      -webkit-backdrop-filter:blur(4px);
      display:flex;
      align-items:flex-start;
      justify-content:center;
      overflow-x:hidden;
      overflow-y:auto;
      overscroll-behavior:contain;
      -webkit-overflow-scrolling:touch;
      z-index:999998;
      padding:clamp(12px, 3vh, 20px);
      opacity:0; pointer-events:none;
      transition:opacity .22s ease;
      font-family:Inter,Arial,sans-serif;
    }
    .confirmModalOverlay.active{ pointer-events:auto; }
    .confirmModalOverlay.visible{ opacity:1; }

    /* Card container */
    .confirmModalCard{
      position:relative;
      background:#ffffff;
      border-radius:clamp(16px, 4vw, 20px);
      width:100%;
      max-width:480px;
      box-shadow:0 20px 55px rgba(15,23,42,.18);
      padding:clamp(20px, 5vw, 32px) clamp(16px, 5vw, 30px) clamp(18px, 4vw, 26px);
      margin:auto;
      transform:translateY(12px) scale(.97);
      transition:transform .25s ease;
      text-align:center;
      overflow-wrap:break-word;
    }
    .confirmModalOverlay.visible .confirmModalCard{
      transform:translateY(0) scale(1);
    }

    /* Close (×) button */
    .confirmModalClose{
      position:absolute;
      top:clamp(10px, 2vw, 14px);
      right:clamp(10px, 2vw, 16px);
      width:28px; height:28px;
      background:transparent; border:0; cursor:pointer;
      color:#cbd5e1; font-size:18px; line-height:1;
      display:flex; align-items:center; justify-content:center;
      transition:.15s ease;
    }
    .confirmModalClose:hover{ color:#94a3b8; }
    .confirmModalClose:disabled{ opacity:.5; cursor:not-allowed; }

    /* Icon circle (danger/primary variants) */
    .confirmModalIcon{
      width:clamp(50px, 14vw, 58px);
      height:clamp(50px, 14vw, 58px);
      margin:2px auto clamp(12px, 3vw, 16px);
      border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      font-size:clamp(19px, 5vw, 22px);
      border:2.5px solid #dc2626;
      color:#dc2626;
      background:#ffffff;
    }
    .confirmModalOverlay.primary .confirmModalIcon{
      border-color:#1e3a8a;
      color:#1e3a8a;
    }

    /* Title & message */
    .confirmModalTitle{
      margin:0 0 8px;
      font-size:clamp(17px, 4.5vw, 19px);
      font-weight:700;
      color:#0f172a;
      letter-spacing:-.01em;
      overflow-wrap:anywhere;
    }

    .confirmModalMessage{
      margin:0 0 4px;
      font-size:clamp(13px, 3.8vw, 14px);
      color:#64748b;
      line-height:1.5;
      overflow-wrap:anywhere;
    }

    /* Optional info rows block */
    .confirmModalInfo{
      margin:clamp(16px, 4vw, 20px) 0 4px;
      background:#f8fafc;
      border-radius:12px;
      padding:clamp(4px, 1.5vw, 6px) clamp(12px, 4vw, 20px);
      text-align:left;
    }
    .confirmModalInfoRow{
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:clamp(8px, 3vw, 16px);
      padding:clamp(9px, 2.5vw, 11px) 0;
      border-bottom:1px solid #e2e8f0;
      font-size:clamp(12.5px, 3.6vw, 14px);
    }
    .confirmModalInfoRow:last-child{ border-bottom:0; }
    .confirmModalInfoLabel{ color:#64748b; flex-shrink:0; }
    .confirmModalInfoValue{
      color:#0f172a; font-weight:500;
      text-align:right; word-break:break-word;
      overflow-wrap:anywhere;
      min-width:0;
    }
    .confirmModalInfoValue.muted{ color:#cbd5e1; font-weight:400; }

    /* Inline error box */
    .confirmModalError{
      margin-top:clamp(10px, 3vw, 14px);
      padding:clamp(8px, 2.5vw, 10px) clamp(10px, 3.5vw, 14px);
      border-radius:10px;
      background:#fef2f2;
      border:1px solid #fecaca;
      color:#b91c1c;
      font-size:clamp(12px, 3.4vw, 13px);
      text-align:left;
      overflow-wrap:anywhere;
    }

    /* Button row */
    .confirmModalActions{
      display:flex;
      flex-wrap:wrap;
      gap:clamp(10px, 2.5vw, 14px);
      margin-top:clamp(18px, 4vw, 24px);
    }

    /* Shared button styling */
    .confirmModalBtn{
      flex:1 1 150px;
      min-width:0;
      padding:clamp(12px, 2.5vw, 14px) clamp(14px, 4vw, 20px);
      border-radius:clamp(8px, 2vw, 10px);
      font-size:clamp(13.5px, 3.8vw, 14.5px);
      font-weight:600;
      cursor:pointer; font-family:inherit;
      border:0;
      display:inline-flex; align-items:center; justify-content:center;
      gap:9px;
      transition:.15s ease;
      min-height:clamp(44px, 7vw, 48px);
      overflow-wrap:anywhere;
    }
    .confirmModalBtn:disabled{ opacity:.6; cursor:not-allowed; }

    .confirmModalCancel{
      background:#f1f5f9;
      color:#334155;
    }
    .confirmModalCancel:hover:not(:disabled){
      background:#e2e8f0;
    }

    .confirmModalConfirm{
      background:#dc2626;
      color:#ffffff;
    }
    .confirmModalConfirm:hover:not(:disabled){
      background:#ef4444;
    }
    .confirmModalOverlay.primary .confirmModalConfirm{
      background:#1e3a8a;
    }
    .confirmModalOverlay.primary .confirmModalConfirm:hover:not(:disabled){
      background:#1d4ed8;
    }

    /* Spinner shown inside the confirm button while busy */
    .confirmModalBtn .spinner{
      width:14px; height:14px;
      border:2px solid rgba(255,255,255,.45);
      border-top-color:#ffffff;
      border-radius:50%;
      animation:cmSpin .7s linear infinite;
    }
    @keyframes cmSpin{ to { transform:rotate(360deg); } }

    /* Mobile tweaks */
    @media (max-width:420px){
      .confirmModalActions{
        flex-direction:column;
      }
      .confirmModalBtn{
        flex:1 1 auto;
        width:100%;
      }
      .confirmModalInfoRow{
        flex-direction:column;
        align-items:flex-start;
        gap:4px;
      }
      .confirmModalInfoValue{
        text-align:left;
      }
    }
  `;

    // Inject the stylesheet once, no matter how many times the module is loaded
    (function injectCss() {
        if (document.getElementById('confirmModalStyles')) return;
        const s = document.createElement('style');
        s.id = 'confirmModalStyles';
        s.textContent = CSS;
        document.head.appendChild(s);
    })();

    // Utilities
    // Escape user-provided text before inserting it into HTML
    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // HTML Template
    function buildModalHtml() {
        return `
      <div class="confirmModalOverlay" id="${MODAL_ID}"
           role="dialog" aria-modal="true"
           aria-labelledby="confirmModalTitle"
           aria-describedby="confirmModalMessage">

        <div class="confirmModalCard" role="document">

          <!-- Top-right close button -->
          <button type="button" class="confirmModalClose"
                  aria-label="Close dialog" title="Close">
            <i class="fas fa-times"></i>
          </button>

          <!-- Variant icon (check / cross) -->
          <div class="confirmModalIcon" aria-hidden="true">
            <i class="fas fa-times"></i>
          </div>

          <h2 class="confirmModalTitle" id="confirmModalTitle">Confirm</h2>

          <p class="confirmModalMessage" id="confirmModalMessage"></p>

          <!-- Optional label/value rows -->
          <div class="confirmModalInfo" id="confirmModalInfo" style="display:none"></div>

          <!-- Inline error message shown when the action fails -->
          <div class="confirmModalError" id="confirmModalError" role="alert" style="display:none"></div>

          <!-- Cancel / Confirm buttons -->
          <div class="confirmModalActions">
            <button type="button" class="confirmModalBtn confirmModalCancel" data-action="cancel">
              Cancel
            </button>
            <button type="button" class="confirmModalBtn confirmModalConfirm" data-action="confirm">
              <i class="fas fa-trash" aria-hidden="true"></i>
              <span>Confirm</span>
            </button>
          </div>

        </div>
      </div>
    `;
    }

    // Mounting
    // Create the overlay once and attach it to the body, then return it
    function ensureMounted() {
        if (modalEl && document.body.contains(modalEl)) return modalEl;

        modalEl = document.getElementById(MODAL_ID);
        if (modalEl) return modalEl;

        const wrapper = document.createElement('div');
        wrapper.innerHTML = buildModalHtml().trim();
        modalEl = wrapper.firstElementChild;
        document.body.appendChild(modalEl);

        bindStaticEvents();
        return modalEl;
    }

    // Static event bindings [run once when the modal is mounted]
    function bindStaticEvents() {
        if (!modalEl) return;

        const closeBtn = modalEl.querySelector('.confirmModalClose');
        const cancelBtn = modalEl.querySelector('[data-action="cancel"]');
        const okBtn = modalEl.querySelector('[data-action="confirm"]');

        if (closeBtn) closeBtn.addEventListener('click', () => close(false));
        if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
        if (okBtn) okBtn.addEventListener('click', onConfirmClick);

        // Clicking the dimmed backdrop also closes the dialog.
        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) close(false);
        });
    }

    // Open Flow
    // Open the dialog and return a Promise that resolves true/false
    function open(options = {}) {
        ensureMounted();

        // Remember the element that had focus so it can be restored on close
        lastFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        currentOptions = options;
        currentOnConfirm = typeof options.onConfirm === 'function'
            ? options.onConfirm
            : null;

        // Apply the danger / primary variant
        const variant = options.variant === 'primary' ? 'primary' : 'danger';
        modalEl.classList.toggle('primary', variant === 'primary');
        modalEl.classList.toggle('danger', variant === 'danger');

        const iconEl = modalEl.querySelector('.confirmModalIcon i');
        if (iconEl) {
            iconEl.className = variant === 'primary'
                ? 'fas fa-check'
                : 'fas fa-times';
        }

        const titleEl = modalEl.querySelector('#confirmModalTitle');
        if (titleEl) titleEl.textContent = options.title || 'Confirm';

        const msgEl = modalEl.querySelector('#confirmModalMessage');
        if (msgEl) {
            msgEl.textContent = options.message || '';
            msgEl.style.display = options.message ? '' : 'none';
        }

        // Build the optional info rows [label / value pairs]
        const infoEl = modalEl.querySelector('#confirmModalInfo');
        if (infoEl) {
            const rows = Array.isArray(options.rows) ? options.rows : [];
            if (rows.length) {
                infoEl.style.display = '';
                infoEl.innerHTML = rows.map(function (r) {
                    const raw = r.value;
                    const hasVal = raw !== null && raw !== undefined && String(raw).trim() !== '';
                    const value = hasVal ? escapeHtml(raw) : '—';
                    return `
            <div class="confirmModalInfoRow">
              <span class="confirmModalInfoLabel">${escapeHtml(r.label || '')}</span>
              <span class="confirmModalInfoValue ${hasVal ? '' : 'muted'}">${value}</span>
            </div>
          `;
                }).join('');
            } else {
                infoEl.style.display = 'none';
                infoEl.innerHTML = '';
            }
        }

        const cancelBtn = modalEl.querySelector('[data-action="cancel"]');
        if (cancelBtn) cancelBtn.textContent = options.cancelText || 'Cancel';

        const confirmBtn = modalEl.querySelector('[data-action="confirm"]');
        if (confirmBtn) {
            const iconCls = variant === 'primary' ? 'fa-check' : 'fa-trash';
            confirmBtn.innerHTML =
                `<i class="fas ${iconCls}" aria-hidden="true"></i>` +
                `<span>${escapeHtml(options.confirmText || 'Confirm')}</span>`;
        }

        // Reset transient UI state
        busy = false;
        setLoading(false);
        hideError();

        // Show with a transition
        modalEl.classList.add('active');
        modalEl.offsetWidth;
        modalEl.classList.add('visible');

        // Move focus into the dialog
        if (cancelBtn) {
            setTimeout(() => { try { cancelBtn.focus(); } catch (_) { } }, 0);
        }

        document.body.style.overflow = 'hidden';

        // ESC closes the dialog, but not while the action is running
        keydownHandler = (e) => {
            if (e.key === 'Escape' && !busy) {
                e.preventDefault();
                close(false);
            }
        };
        document.addEventListener('keydown', keydownHandler);

        return new Promise(function (resolve) {
            resolvePromise = resolve;
        });
    }

    // Close Flow
    // Close the dialog and resolve any pending Promise with the result
    function close(result) {
        if (!modalEl) return result;
        if (busy) return result;

        modalEl.classList.remove('visible');

        // Remove the "active" class once the fade-out finishes [or as a fallback]
        const onEnd = () => {
            modalEl.classList.remove('active');
            modalEl.removeEventListener('transitionend', onEnd);
        };
        modalEl.addEventListener('transitionend', onEnd);
        setTimeout(onEnd, 320);

        document.body.style.overflow = '';

        if (keydownHandler) {
            document.removeEventListener('keydown', keydownHandler);
            keydownHandler = null;
        }

        // Restore focus to wherever it was before opening
        if (lastFocused && typeof lastFocused.focus === 'function') {
            try { lastFocused.focus(); } catch (_) { }
        }
        lastFocused = null;

        currentOnConfirm = null;
        currentOptions = null;

        if (resolvePromise) {
            resolvePromise(!!result);
            resolvePromise = null;
        }

        return result;
    }

    // Confirm Action
    // Run the caller's onConfirm callback [if any] while showing loading UI
    async function onConfirmClick() {
        if (busy) return;

        // No callback provided: just close as confirmed
        if (typeof currentOnConfirm !== 'function') {
            close(true);
            return;
        }

        busy = true;
        setLoading(true);
        hideError();

        try {
            await currentOnConfirm(currentOptions);
            busy = false;
            setLoading(false);
            close(true);
        } catch (err) {
            busy = false;
            setLoading(false);
            showError(
                err && err.message
                    ? err.message
                    : 'Action failed. Please try again.'
            );
        }
    }

    // UI State Helpers
    // Toggle buttons and swap the confirm label for a spinner while busy
    function setLoading(isLoading) {
        if (!modalEl) return;

        const okBtn = modalEl.querySelector('[data-action="confirm"]');
        const cancelBtn = modalEl.querySelector('[data-action="cancel"]');
        const closeBtn = modalEl.querySelector('.confirmModalClose');

        const isPrimary = modalEl.classList.contains('primary');
        const iconCls = isPrimary ? 'fa-check' : 'fa-trash';
        const label = (currentOptions && currentOptions.confirmText) || 'Confirm';

        if (okBtn) {
            okBtn.disabled = !!isLoading;
            okBtn.innerHTML = isLoading
                ? `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(label)}…</span>`
                : `<i class="fas ${iconCls}" aria-hidden="true"></i><span>${escapeHtml(label)}</span>`;
        }
        if (cancelBtn) cancelBtn.disabled = !!isLoading;
        if (closeBtn) closeBtn.disabled = !!isLoading;
    }

    // Show or hide the inline error message
    function showError(message) {
        if (!modalEl) return;
        const box = modalEl.querySelector('#confirmModalError');
        if (!box) return;
        box.textContent = message || '';
        box.style.display = message ? '' : 'none';
    }

    function hideError() { showError(''); }

    // Public API
    global.ConfirmModal = {
        open,
        close: () => close(false),
        isOpen: () => !!(modalEl && modalEl.classList.contains('visible')),
    };

    global.showConfirmModal = open;

})(window);