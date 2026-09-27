(function (global) {
    'use strict';

    const MODAL_ID = 'deleteModalOverlay';

    let modalEl = null;
    let busy = false;
    let lastFocused = null;
    let currentOnConfirm = null;
    let currentRecord = null;
    let keydownHandler = null;

    function buildModalHtml() {
        return `
      <div class="deleteModalOverlay" id="${MODAL_ID}"
           role="dialog" aria-modal="true"
           aria-labelledby="deleteModalTitle"
           aria-describedby="deleteModalMessage">

        <div class="deleteModalCard" role="document">

          <button type="button" class="deleteModalClose"
                  aria-label="Close dialog" title="Close">
            <i class="fas fa-times"></i>
          </button>

          <div class="deleteModalIcon" aria-hidden="true">
            <i class="fas fa-times"></i>
          </div>

          <h2 class="deleteModalTitle" id="deleteModalTitle">Delete Record</h2>

          <p class="deleteModalMessage" id="deleteModalMessage">
            Do you really want to delete this record?
          </p>

          <div class="deleteModalInfo" id="deleteModalInfo">
            <div class="deleteModalInfoRow">
              <span class="deleteModalInfoLabel">Control No.</span>
              <span class="deleteModalInfoValue" data-field="controlNo">—</span>
            </div>
            <div class="deleteModalInfoRow">
              <span class="deleteModalInfoLabel">Name</span>
              <span class="deleteModalInfoValue" data-field="deceasedName">—</span>
            </div>
            <div class="deleteModalInfoRow">
              <span class="deleteModalInfoLabel">Block</span>
              <span class="deleteModalInfoValue" data-field="blockName">—</span>
            </div>
            <div class="deleteModalInfoRow">
              <span class="deleteModalInfoLabel">Grave Code</span>
              <span class="deleteModalInfoValue" data-field="graveCode">—</span>
            </div>
          </div>

          <div class="deleteModalError" id="deleteModalError" role="alert" style="display:none"></div>

          <div class="deleteModalActions">
            <button type="button" class="deleteModalBtn deleteModalCancel" data-action="cancel">
              Cancel
            </button>
            <button type="button" class="deleteModalBtn deleteModalConfirm" data-action="confirm">
              <i class="fas fa-trash" aria-hidden="true"></i>
              <span>Delete</span>
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

        const closeBtn = modalEl.querySelector('.deleteModalClose');
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

        currentRecord = {
            controlNo: options.controlNo ?? '',
            deceasedName: options.deceasedName ?? '',
            blockName: options.blockName ?? '',
            graveCode: options.graveCode ?? '',
        };
        currentOnConfirm = typeof options.onConfirm === 'function'
            ? options.onConfirm
            : null;

        const info = modalEl.querySelector('#deleteModalInfo');
        if (info) {
            info.querySelectorAll('[data-field]').forEach((el) => {
                const key = el.dataset.field;
                const val = currentRecord[key];
                const hasVal = val !== null && val !== undefined && String(val).trim() !== '';
                el.textContent = hasVal ? String(val) : '—';
                el.classList.toggle('muted', !hasVal);
            });
        }

        busy = false;
        setLoading(false);
        hideError();

        modalEl.classList.add('active');

        modalEl.offsetWidth;
        modalEl.classList.add('visible');

        const cancelBtn = modalEl.querySelector('[data-action="cancel"]');
        if (cancelBtn) setTimeout(() => { try { cancelBtn.focus(); } catch (_) { } }, 0);

        document.body.style.overflow = 'hidden';

        keydownHandler = (e) => {
            if (e.key === 'Escape' && !busy) {
                e.preventDefault();
                close(false);
            }
        };
        document.addEventListener('keydown', keydownHandler);
    }

    function close(result) {
        if (!modalEl) return;
        if (busy) return;

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
        currentRecord = null;

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
            await currentOnConfirm(currentRecord);
            busy = false;
            setLoading(false);
            close(true);
        } catch (err) {
            busy = false;
            setLoading(false);
            showError(
                err && err.message
                    ? err.message
                    : 'Failed to delete record. Please try again.'
            );
        }
    }

    function setLoading(isLoading) {
        if (!modalEl) return;

        const okBtn = modalEl.querySelector('[data-action="confirm"]');
        const cancelBtn = modalEl.querySelector('[data-action="cancel"]');
        const closeBtn = modalEl.querySelector('.deleteModalClose');

        if (okBtn) {
            okBtn.disabled = !!isLoading;
            okBtn.innerHTML = isLoading
                ? '<span class="spinner" aria-hidden="true"></span><span>Deleting…</span>'
                : '<i class="fas fa-trash" aria-hidden="true"></i><span>Delete</span>';
        }
        if (cancelBtn) cancelBtn.disabled = !!isLoading;
        if (closeBtn) closeBtn.disabled = !!isLoading;
    }

    function showError(message) {
        if (!modalEl) return;
        const box = modalEl.querySelector('#deleteModalError');
        if (!box) return;
        box.textContent = message || '';
        box.style.display = message ? '' : 'none';
    }

    function hideError() { showError(''); }

    global.DeleteModal = {
        open,
        close: () => close(false),
        isOpen: () => !!(modalEl && modalEl.classList.contains('visible')),
    };

})(window);