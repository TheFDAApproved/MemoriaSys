(function (global) {
    'use strict';

    const STYLE_ID = 'smsNotificationStyles';
    const SCROLL_LOCK_CLASS = 'smsNotification--open';
    const ID_PREFIX = 'sms_';
    const FALLBACK_CEMETERY_NAME = 'Memoria Cemetery';

    let activeInstance = null;

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        if (!document.head) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
html.smsNotification--open,
html.smsNotification--open body {
    overflow: hidden;
}

.smsModal {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(15, 18, 28, 0.5);
    -webkit-backdrop-filter: blur(2px);
    backdrop-filter: blur(2px);
    z-index: 9999;
    opacity: 0;
    transition: opacity .2s ease;
    font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

.smsModal.is-active {
    opacity: 1;
}

.smsModal__card {
    background: #ffffff;
    color: #111827;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    box-shadow:
        0 20px 50px rgba(15, 18, 28, 0.18),
        0 2px 6px rgba(15, 18, 28, 0.06);
    width: min(92vw, 460px);
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transform: translateY(10px);
    opacity: 0;
    transition: transform .25s ease, opacity .25s ease;
}

.smsModal__card.is-open {
    transform: translateY(0);
    opacity: 1;
}

.smsModal__header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px 22px;
    background: transparent;
    color: inherit;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: .1px;
    border-bottom: 1px solid #eef0f3;
}

.smsModal__header i {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 9px;
    background: rgba(99, 102, 241, 0.12);
    color: var(--mainColor);
    font-size: 14px;
    flex: 0 0 auto;
}

.smsModal__body {
    padding: 18px 22px 20px;
    overflow-y: auto;
}

.smsModal__label {
    display: block;
    margin: 0 0 6px;
    font-size: 12.5px;
    font-weight: 500;
    color: #6b7280;
    letter-spacing: .1px;
}

.smsModal__label:not(:first-of-type) {
    margin-top: 16px;
}

.smsModal__input,
.smsModal__textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #e5e7eb;
    background: #ffffff;
    color: #111827;
    font-family: inherit;
    font-size: 14px;
    line-height: 1.45;
    outline: none;
    transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}

.smsModal__input::placeholder,
.smsModal__textarea::placeholder {
    color: #9ca3af;
}

.smsModal__input:hover:not([readonly]),
.smsModal__textarea:hover {
    border-color: #d1d5db;
}

.smsModal__input:focus,
.smsModal__textarea:focus {
    border-color: var(--mainColor);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}

.smsModal__input[readonly] {
    background: #f9fafb;
    color: #374151;
    cursor: default;
}

.smsModal__input[readonly]:focus {
    border-color: #e5e7eb;
    box-shadow: none;
}

.smsModal__textarea {
    min-height: 110px;
    resize: vertical;
}

.smsModal__checkboxRow {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #374151;
    cursor: pointer;
    user-select: none;
}

.smsModal__checkboxRow input[type="checkbox"] {
    width: 16px;
    height: 16px;
    margin: 0;
    flex: 0 0 auto;
    accent-color: var(--mainColor);
    cursor: pointer;
}

.smsModal__actions {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid #eef0f3;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    flex-wrap: wrap;
}

.smsModal__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 9px 16px;
    min-height: 38px;
    border-radius: 10px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    border: 1px solid transparent;
    transition:
        background .15s ease,
        border-color .15s ease,
        color .15s ease,
        filter .15s ease,
        transform .05s ease,
        box-shadow .15s ease;
}

.smsModal__btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
}

.smsModal__btn:disabled {
    cursor: not-allowed;
    opacity: .65;
    filter: grayscale(0.05);
}

.smsModal__btn--ghost {
    background: #ffffff;
    color: #374151;
    border-color: #d1d5db;
}

.smsModal__btn--ghost:hover:not(:disabled) {
    background: #f9fafb;
    border-color: #c7cbd1;
}

.smsModal__btn--primary {
    background: var(--mainColor);
    color: #ffffff;
    border-color: var(--mainColor);
    box-shadow: 0 1px 2px rgba(15, 18, 28, 0.08);
}

.smsModal__btn--primary:hover:not(:disabled) {
    filter: brightness(1.05);
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.25);
}

.smsModal__btn--primary:active:not(:disabled) {
    transform: translateY(1px);
    box-shadow: 0 1px 2px rgba(15, 18, 28, 0.08);
}

.smsModal__btn.is-loading {
    pointer-events: none;
}

.smsPhoneLink {
    display: inline;
    color: var(--mainColor);
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
    cursor: pointer;
    transition: text-decoration-color .12s ease;
}

.smsPhoneLink:hover {
    text-decoration-color: currentColor;
}

.smsPhoneLink:focus-visible {
    outline: 2px solid var(--mainColor);
    outline-offset: 2px;
    border-radius: 3px;
}

@media (max-width: 480px) {
    .smsModal__header { padding: 16px 18px; }
    .smsModal__body   { padding: 16px 18px 18px; }
    .smsModal__actions { flex-direction: column-reverse; }
    .smsModal__btn     { width: 100%; }
}
        `;
        document.head.appendChild(style);
    }

    function notify(message, type) {
        if (!message) return;
        if (typeof global.showAlertTOP === 'function') {
            global.showAlertTOP(String(message), type || 'info');
            return;
        }
        if (type === 'error' || type === 'warning') console.warn('[sms]', message);
        else console.log('[sms]', message);
    }

    function buildFinalMessage(rawMessage, includeCemeteryName) {
        const msg = String(rawMessage || '').trim();
        if (!msg) return '';
        if (!includeCemeteryName) return msg;

        const name = String(global.CEMETERY_NAME || FALLBACK_CEMETERY_NAME).trim();
        if (!name) return msg;

        if (msg.toLowerCase().indexOf(name.toLowerCase()) !== -1) return msg;
        return msg + '\n\n\u2014 ' + name;
    }

    function destroyInstance(instance) {
        if (!instance || instance.destroyed) return;
        instance.destroyed = true;

        if (instance.onKey) {
            document.removeEventListener('keydown', instance.onKey, true);
            instance.onKey = null;
        }

        if (instance.modal && instance.modal.parentNode) {
            try { instance.modal.remove(); } catch (_) {}
        }

        if (activeInstance === instance) {
            activeInstance = null;
            document.documentElement.classList.remove(SCROLL_LOCK_CLASS);
        }
    }

    function closeModal(instance) {
        if (!instance || instance.destroyed) return;
        const { modal, card } = instance;

        card.classList.remove('is-open');
        modal.classList.remove('is-active');

        clearTimeout(instance.closeTimer);
        instance.closeTimer = setTimeout(() => destroyInstance(instance), 220);
    }

    function openSmsModal(phoneNumber, message) {
        if (global.openSmsModal !== openSmsModal) {
            global.openSmsModal = openSmsModal;
        }

        if (activeInstance) destroyInstance(activeInstance);

        injectStyles();

        const instanceId =
            ID_PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
        const phone = String(phoneNumber || '').trim();

        const modal = document.createElement('div');
        modal.className = 'smsModal';
        modal.id = instanceId + '_modal';
        modal.setAttribute('role', 'presentation');
        modal.innerHTML = `
            <div class="smsModal__card" role="dialog" aria-modal="true"
                 aria-labelledby="${instanceId}_title">
                <div class="smsModal__header" id="${instanceId}_title">
                    <i class="fas fa-comment-sms" aria-hidden="true"></i>
                    <span>Send SMS Notification</span>
                </div>

                <div class="smsModal__body">
                    <label class="smsModal__label"
                           for="${instanceId}_phone">Recipient Phone Number</label>
                    <input
                        id="${instanceId}_phone"
                        class="smsModal__input"
                        type="text"
                        readonly
                        aria-readonly="true"
                    />

                    <label class="smsModal__label"
                           for="${instanceId}_message">Message Content</label>
                    <textarea
                        id="${instanceId}_message"
                        class="smsModal__textarea"
                        rows="5"
                    ></textarea>

                    <label class="smsModal__checkboxRow"
                           for="${instanceId}_include">
                        <input
                            id="${instanceId}_include"
                            type="checkbox"
                            checked
                        />
                        <span>Include cemetery name in the SMS</span>
                    </label>

                    <div class="smsModal__actions">
                        <button
                            id="${instanceId}_cancel"
                            type="button"
                            class="smsModal__btn smsModal__btn--ghost"
                        >Cancel</button>
                        <button
                            id="${instanceId}_send"
                            type="button"
                            class="smsModal__btn smsModal__btn--primary"
                        >
                            <i class="fas fa-paper-plane" aria-hidden="true"></i>
                            <span>Send SMS</span>
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const card         = modal.querySelector('.smsModal__card');
        const phoneInput   = modal.querySelector('#' + instanceId + '_phone');
        const messageInput = modal.querySelector('#' + instanceId + '_message');
        const includeBox   = modal.querySelector('#' + instanceId + '_include');
        const cancelBtn    = modal.querySelector('#' + instanceId + '_cancel');
        const sendBtn      = modal.querySelector('#' + instanceId + '_send');

        phoneInput.value = phone;
        messageInput.value = String(message || '');

        const instance = {
            modal,
            card,
            onKey: null,
            closeTimer: null,
            destroyed: false,
        };
        activeInstance = instance;

        const onKey = (e) => {
            if (e.key === 'Escape') closeModal(instance);
        };
        instance.onKey = onKey;
        document.addEventListener('keydown', onKey, true);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal(instance);
        });

        cancelBtn.addEventListener('click', () => closeModal(instance));

        sendBtn.addEventListener('click', async () => {
            const phoneVal  = phoneInput.value.trim();
            const rawMsg    = messageInput.value.trim();
            const includeNm = includeBox.checked;

            if (!phoneVal) {
                notify('No valid phone number to send to.', 'error');
                phoneInput.focus();
                return;
            }
            if (!rawMsg) {
                notify('Message cannot be empty.', 'error');
                messageInput.focus();
                return;
            }

            const finalMessage = buildFinalMessage(rawMsg, includeNm);
            const originalHtml = sendBtn.innerHTML;

            sendBtn.innerHTML =
                '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>' +
                '<span>Sending...</span>';
            sendBtn.disabled = true;
            sendBtn.classList.add('is-loading');
            cancelBtn.disabled = true;

            try {
                if (typeof global.sendSms === 'function') {
                    await global.sendSms(phoneVal, finalMessage, includeNm);
                } else {
                    const response = await fetch('api/sendsms', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({
                            phone_number: phoneVal,
                            message: finalMessage,
                            include_cemetery_name: includeNm,
                        }),
                    });

                    let result = null;
                    try { result = await response.json(); } catch (_) {}

                    if (!response.ok || !result || !result.success) {
                        const msg = (result && (result.message || result.error))
                            || ('Failed to send SMS (HTTP ' + response.status + ')');
                        throw new Error(msg);
                    }
                }

                notify('SMS sent successfully!', 'success');
                closeModal(instance);
            } catch (err) {
                console.error('[sms] send failed:', err);
                notify(
                    (err && err.message) || 'An error occurred while sending the SMS.',
                    'error'
                );

                sendBtn.innerHTML = originalHtml;
                sendBtn.disabled = false;
                sendBtn.classList.remove('is-loading');
                cancelBtn.disabled = false;
            }
        });

        document.documentElement.classList.add(SCROLL_LOCK_CLASS);

        requestAnimationFrame(() => {
            modal.classList.add('is-active');
            card.classList.add('is-open');
        });

        setTimeout(() => {
            messageInput.focus();
            const end = messageInput.value.length;
            try { messageInput.setSelectionRange(end, end); } catch (_) {}
        }, 80);
    }

    injectStyles();
    global.openSmsModal = openSmsModal;

    global.addEventListener('beforeunload', () => {
        if (activeInstance) destroyInstance(activeInstance);
    });
})(window);