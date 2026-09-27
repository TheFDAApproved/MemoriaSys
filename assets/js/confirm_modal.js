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

    const CSS = `
    .confirmModalOverlay{
      position:fixed; inset:0;
      background:rgba(15,23,42,.35);
      backdrop-filter:blur(4px);
      -webkit-backdrop-filter:blur(4px);
      display:flex; align-items:center; justify-content:center;
      z-index:999998; padding:20px;
      opacity:0; pointer-events:none;
      transition:opacity .22s ease;
      font-family:Inter,Arial,sans-serif;
    }
    .confirmModalOverlay.active{ pointer-events:auto; }
    .confirmModalOverlay.visible{ opacity:1; }

    .confirmModalCard{
      position:relative;
      background:#ffffff;
      border-radius:20px;
      width:100%;
      max-width:480px;
      box-shadow:0 20px 55px rgba(15,23,42,.18);
      padding:32px 30px 26px;
      transform:translateY(12px) scale(.97);
      transition:transform .25s ease;
      text-align:center;
    }
    .confirmModalOverlay.visible .confirmModalCard{
      transform:translateY(0) scale(1);
    }

    .confirmModalClose{
      position:absolute; top:14px; right:16px;
      width:28px; height:28px;
      background:transparent; border:0; cursor:pointer;
      color:#cbd5e1; font-size:18px; line-height:1;
      display:flex; align-items:center; justify-content:center;
      transition:.15s ease;
    }
    .confirmModalClose:hover{ color:#94a3b8; }
    .confirmModalClose:disabled{ opacity:.5; cursor:not-allowed; }

    .confirmModalIcon{
      width:58px; height:58px; margin:2px auto 16px;
      border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      font-size:22px;
      border:2.5px solid #dc2626;
      color:#dc2626;
      background:#ffffff;
    }
    .confirmModalOverlay.primary .confirmModalIcon{
      border-color:#1e3a8a;
      color:#1e3a8a;
    }

    .confirmModalTitle{
      margin:0 0 8px;
      font-size:19px; font-weight:700;
      color:#0f172a; letter-spacing:-.01em;
    }

    .confirmModalMessage{
      margin:0 0 4px;
      font-size:14px; color:#64748b; line-height:1.5;
    }

    .confirmModalInfo{
      margin:20px 0 4px;
      background:#f8fafc;
      border-radius:12px;
      padding:6px 20px;
      text-align:left;
    }
    .confirmModalInfoRow{
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
      padding:11px 0;
      border-bottom:1px solid #e2e8f0;
      font-size:14px;
    }
    .confirmModalInfoRow:last-child{ border-bottom:0; }
    .confirmModalInfoLabel{ color:#64748b; flex-shrink:0; }
    .confirmModalInfoValue{
      color:#0f172a; font-weight:500;
      text-align:right; word-break:break-word;
    }
    .confirmModalInfoValue.muted{ color:#cbd5e1; font-weight:400; }

    .confirmModalError{
      margin-top:14px;
      padding:10px 14px;
      border-radius:10px;
      background:#fef2f2;
      border:1px solid #fecaca;
      color:#b91c1c;
      font-size:13px;
      text-align:left;
    }

    .confirmModalActions{
      display:flex; gap:14px;
      margin-top:24px;
    }

    .confirmModalBtn{
      flex:1 1 0;
      padding:14px 20px;
      border-radius:10px;
      font-size:14.5px; font-weight:600;
      cursor:pointer; font-family:inherit;
      border:0;
      display:inline-flex; align-items:center; justify-content:center;
      gap:9px;
      transition:.15s ease;
      min-height:48px;
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

    .confirmModalBtn .spinner{
      width:14px; height:14px;
      border:2px solid rgba(255,255,255,.45);
      border-top-color:#ffffff;
      border-radius:50%;
      animation:cmSpin .7s linear infinite;
    }
    @keyframes cmSpin{ to { transform:rotate(360deg); } }
  `;

    (function injectCss() {
        if (document.getElementById('confirmModalStyles')) return;
        const s = document.createElement('style');
        s.id = 'confirmModalStyles';
        s.textContent = CSS;
        document.head.appendChild(s);
    })();

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function buildModalHtml() {
        return `
      <div class="confirmModalOverlay" id="${MODAL_ID}"
           role="dialog" aria-modal="true"
           aria-labelledby="confirmModalTitle"
           aria-describedby="confirmModalMessage">

        <div class="confirmModalCard" role="document">

          <button type="button" class="confirmModalClose"
                  aria-label="Close dialog" title="Close">
            <i class="fas fa-times"></i>
          </button>

          <div class="confirmModalIcon" aria-hidden="true">
            <i class="fas fa-times"></i>
          </div>

          <h2 class="confirmModalTitle" id="confirmModalTitle">Confirm</h2>

          <p class="confirmModalMessage" id="confirmModalMessage"></p>

          <div class="confirmModalInfo" id="confirmModalInfo" style="display:none"></div>

          <div class="confirmModalError" id="confirmModalError" role="alert" style="display:none"></div>

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

    function bindStaticEvents() {
        if (!modalEl) return;

        const closeBtn = modalEl.querySelector('.confirmModalClose');
        const cancelBtn = modalEl.querySelector('[data-action="cancel"]');
        const okBtn = modalEl.querySelector('[data-action="confirm"]');

        if (closeBtn) closeBtn.addEventListener('click', () => close(false));
        if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
        if (okBtn) okBtn.addEventListener('click', onConfirmClick);

        modalEl.addEventListener('click', (e) => {
            if (e.target === modalEl) close(false);
        });
    }

    function open(options = {}) {
        ensureMounted();

        lastFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        currentOptions = options;
        currentOnConfirm = typeof options.onConfirm === 'function'
            ? options.onConfirm
            : null;

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

        busy = false;
        setLoading(false);
        hideError();

        modalEl.classList.add('active');
        modalEl.offsetWidth;
        modalEl.classList.add('visible');

        if (cancelBtn) {
            setTimeout(() => { try { cancelBtn.focus(); } catch (_) { } }, 0);
        }

        document.body.style.overflow = 'hidden';

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

    function close(result) {
        if (!modalEl) return result;
        if (busy) return result;

        modalEl.classList.remove('visible');

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

    async function onConfirmClick() {
        if (busy) return;

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

    function showError(message) {
        if (!modalEl) return;
        const box = modalEl.querySelector('#confirmModalError');
        if (!box) return;
        box.textContent = message || '';
        box.style.display = message ? '' : 'none';
    }

    function hideError() { showError(''); }

    global.ConfirmModal = {
        open,
        close: () => close(false),
        isOpen: () => !!(modalEl && modalEl.classList.contains('visible')),
    };

    global.showConfirmModal = open;

})(window);