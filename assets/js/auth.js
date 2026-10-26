document.addEventListener('DOMContentLoaded', function () {

    // Minimum time the loading spinner stays visible
    var MIN_LOADING_MS = 700;

    // Time a flagged field stays red
    var SHAKE_HIGHLIGHT_MS = 1500;

    // Time the login success message shows before redirecting
    var LOGIN_SUCCESS_REDIRECT_MS = 3500;

    // Gets the error message from a response, or returns the fallback
    function readErrorMessage(data, fallback) {
        if (!data) return fallback;
        return data.message || data.error || fallback;
    }

    // Stores the active shake state for each field
    var shakeState = new WeakMap();

    // Removes the shake animation and its listeners from a field
    function clearShake(field) {
        if (!field) return;
        var state = shakeState.get(field);
        if (!state) return;
        if (state.timer) clearTimeout(state.timer);
        if (state.cleanup) state.cleanup();
        if (state.target) state.target.classList.remove('shake-anim');
        shakeState.delete(field);
    }

    // Shakes a field to show an error and adds a red highlight
    function shakeField(field, targetOverride) {
        if (!field) return;

        clearShake(field);

        var target = targetOverride || field._pwWrapper || field;
        void target.offsetWidth; // restart the animation
        target.classList.add('shake-anim');

        var timer = setTimeout(function () { clearShake(field); }, SHAKE_HIGHLIGHT_MS);

        // Stops the shake as soon as the user interacts with the field
        var onInteract = function () { clearShake(field); };
        field.addEventListener('input', onInteract);
        field.addEventListener('focus', onInteract);
        field.addEventListener('click', onInteract);

        var cleanup = function () {
            field.removeEventListener('input', onInteract);
            field.removeEventListener('focus', onInteract);
            field.removeEventListener('click', onInteract);
        };

        shakeState.set(field, { timer: timer, cleanup: cleanup, target: target });
    }

    // Shakes the fields named in an error message
    function shakeFieldsByMessage(message, fields) {
        if (!message || !fields) return;
        var text = String(message).toLowerCase();

        if (text.indexOf('username') !== -1 || text.indexOf('user name') !== -1) {
            shakeField(fields.username);
        } else if (text.indexOf('name') !== -1) {
            shakeField(fields.name);
        }
        if (text.indexOf('email') !== -1) shakeField(fields.email);

        // Word boundary check so "numbers" doesn't match the phone field
        if (/\b(phone|mobile|contact)\b/.test(text) || /\bnumber\b/.test(text)) {
            shakeField(fields.phone);
        }

        if (text.indexOf('password') !== -1) shakeField(fields.password);
        if (text.indexOf('terms') !== -1) {
            shakeField(
                fields.terms,
                fields.terms && fields.terms.closest
                    ? fields.terms.closest('.termsConditions')
                    : null
            );
        }
    }

    // Shakes every field in the group
    function shakeAllFields(fields) {
        if (!fields) return;
        ['name', 'username', 'email', 'phone', 'password', 'terms'].forEach(function (key) {
            var field = fields[key];
            if (!field) return;
            shakeField(
                field,
                key === 'terms' && field.closest
                    ? field.closest('.termsConditions')
                    : null
            );
        });
    }

    // Removes shakes from every field inside a form
    function clearAllShakesInForm(form) {
        if (!form || !form.elements) return;
        Array.from(form.elements).forEach(function (el) {
            clearShake(el);
        });
    }

    // Tracks which forms are currently loading
    var busyState = new WeakMap();

    var busyStylesInjected = false;

    // Adds the spinner CSS to the page once
    function injectBusyStyles() {
        if (busyStylesInjected) return;
        busyStylesInjected = true;

        var style = document.createElement('style');
        style.id = 'form-busy-spinner-styles';
        style.textContent = [
            '.btn-spinner { display: inline-block; width: 1.15em; height: 1.15em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: btnSpin 1s linear infinite; vertical-align: -0.2em; }',
            '@keyframes btnSpin { to { transform: rotate(360deg); } }',
            '@media (prefers-reduced-motion: reduce) { .btn-spinner { animation-duration: 2s; } }',
            '.btn-spinner-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // Locks the button size so the layout doesn't shift when the spinner shows
    function freezeButtonSize(btn) {
        var rect = btn.getBoundingClientRect();
        if (!rect.width && !rect.height) return;

        var cs = window.getComputedStyle(btn);
        var w = rect.width;
        var h = rect.height;

        // Convert to content-box sizes when needed
        if (cs.boxSizing !== 'border-box') {
            w -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) +
                (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
            h -= (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) +
                (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
        }

        if (w > 0) btn.style.minWidth = w + 'px';
        if (h > 0) btn.style.minHeight = h + 'px';
    }

    // Replaces the button content with a spinner and saves the original content
    function lockSubmitButton(btn, loadingLabel) {
        injectBusyStyles();

        // Move the original child nodes into a fragment so they can be restored later
        var fragment = document.createDocumentFragment();
        while (btn.firstChild) fragment.appendChild(btn.firstChild);

        var snapshot = {
            content: fragment,
            ariaBusy: btn.getAttribute('aria-busy'),
            disabled: btn.disabled,
            minWidth: btn.style.minWidth,
            minHeight: btn.style.minHeight
        };

        freezeButtonSize(btn);
        btn.setAttribute('aria-busy', 'true');

        var spinner = document.createElement('span');
        spinner.className = 'btn-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        btn.appendChild(spinner);

        // Hidden label so screen readers still announce the loading state
        var label = document.createElement('span');
        label.className = 'btn-spinner-sr';
        label.textContent = loadingLabel || 'Loading...';
        btn.appendChild(label);

        btn.disabled = true;

        return snapshot;
    }

    // Restores the button's original content and state
    function unlockSubmitButton(btn, snapshot) {
        btn.textContent = '';
        btn.appendChild(snapshot.content);

        if (snapshot.ariaBusy === null) {
            btn.removeAttribute('aria-busy');
        } else {
            btn.setAttribute('aria-busy', snapshot.ariaBusy);
        }

        btn.style.minWidth = snapshot.minWidth;
        btn.style.minHeight = snapshot.minHeight;
        btn.disabled = snapshot.disabled;
    }

    // Turns the loading state on or off for a form
    function setFormBusy(form, submitBtn, busy, loadingLabel) {
        if (!form) return;

        if (busy) {
            // Ignore if the form is already busy
            if (busyState.has(form)) return;

            var state = { disabledEls: [], button: submitBtn || null, snapshot: null };
            busyState.set(form, state);

            // Disable all form controls except the submit button
            Array.from(form.elements).forEach(function (el) {
                if (el === submitBtn) return;
                if (el.type === 'hidden') return;
                if (el.tagName === 'INPUT' || el.tagName === 'BUTTON' ||
                    el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
                    if (el.disabled) return;
                    el.disabled = true;
                    state.disabledEls.push(el);
                }
            });

            if (submitBtn) {
                state.snapshot = lockSubmitButton(submitBtn, loadingLabel);
            }
        } else {
            var locked = busyState.get(form);
            if (!locked) return;
            busyState.delete(form);

            // Re-enable the controls that were disabled
            locked.disabledEls.forEach(function (el) { el.disabled = false; });

            if (locked.button && locked.snapshot) {
                unlockSubmitButton(locked.button, locked.snapshot);
            }
        }
    }

    // Sends a POST request and keeps the spinner visible for at least minMs
    async function authFetch(url, payload, minMs) {
        var start = Date.now();
        var result = null;
        var error = null;

        try {
            var res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            var data = await res.json();
            result = { ok: res.ok, data: data };
        } catch (err) {
            error = err;
        }

        // Wait the remaining time so the spinner doesn't flash
        var elapsed = Date.now() - start;
        if (elapsed < minMs) {
            await new Promise(function (resolve) {
                setTimeout(resolve, minMs - elapsed);
            });
        }

        if (error) throw error;
        return result;
    }

    // Cached references to the success modal elements
    var successModalEls = null;

    // Creates the success modal and adds it to the page [runs once]
    function ensureSuccessModal() {
        if (successModalEls) return successModalEls;

        var style = document.createElement('style');
        style.id = 'auth-success-modal-styles';
        style.textContent = [
            '.auth-success-overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, .55); display: flex; align-items: center; justify-content: center; z-index: 99999; padding: 20px; }',
            '.auth-success-overlay.hidden { display: none; }',
            '.auth-success-card { background: #fff; border-radius: 16px; padding: 28px 24px; max-width: 420px; width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.25); animation: authSuccessIn .3s ease; }',
            '@keyframes authSuccessIn { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }',
            '.auth-success-icon { width: 60px; height: 60px; margin: 0 auto 16px; border-radius: 50%; background: #dcfce7; color: #16a34a; display: flex; align-items: center; justify-content: center; font-size: 30px; font-weight: 700; }',
            '.auth-success-title { margin: 0 0 8px; font-size: 20px; color: #0f172a; }',
            '.auth-success-message { margin: 0 0 20px; color: #475569; font-size: 15px; line-height: 1.5; white-space: pre-line; }',
            '.auth-success-btn { background: #16a34a; color: #fff; border: none; border-radius: 10px; padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer; width: 100%; transition: background .15s ease; }',
            '.auth-success-btn:hover { background: #15803d; }'
        ].join('\n');
        document.head.appendChild(style);

        var overlay = document.createElement('div');
        overlay.className = 'auth-success-overlay hidden';
        overlay.innerHTML =
            '<div class="auth-success-card" role="dialog" aria-modal="true" aria-labelledby="auth-success-title">' +
            '<div class="auth-success-icon" aria-hidden="true">\u2713</div>' +
            '<h3 class="auth-success-title" id="auth-success-title">Success</h3>' +
            '<p class="auth-success-message"></p>' +
            '<button type="button" class="auth-success-btn">Continue to Log In</button>' +
            '</div>';
        document.body.appendChild(overlay);

        var messageEl = overlay.querySelector('.auth-success-message');
        var btn = overlay.querySelector('.auth-success-btn');

        successModalEls = { overlay: overlay, messageEl: messageEl, btn: btn };
        return successModalEls;
    }

    // Shows the success modal and redirects when the user clicks the button
    function showSuccessThenRedirect(message, redirectUrl) {
        var els = ensureSuccessModal();
        els.messageEl.textContent = message || 'Success.';
        els.overlay.classList.remove('hidden');

        var done = false;
        var close = function () {
            if (done) return;
            done = true;
            els.overlay.classList.add('hidden');
            window.location.href = redirectUrl;
        };

        // Only the button closes the modal and triggers the redirect
        els.btn.onclick = close;

        els.btn.focus();
    }

    // SVG icons for the password toggle [closed eye and open eye]
    var EYE_OFF_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    var EYE_OPEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

    var passwordStylesInjected = false;

    // Adds the CSS for the password toggle and shake animation [runs once]
    function injectPasswordStyles() {
        if (passwordStylesInjected) return;
        passwordStylesInjected = true;

        var style = document.createElement('style');
        style.id = 'password-toggle-styles';
        style.textContent = [
            '.password-field { position: relative; display: block; width: 100%; }',
            '.password-field > input { width: 100%; box-sizing: border-box; transition: 0.3s; }',
            '.password-toggle-btn { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: none; border-radius: 50%; background: transparent; color: #6b7280; cursor: pointer; opacity: .75; transition: opacity .15s ease, background-color .15s ease; }',
            '.password-toggle-btn:hover { opacity: 1; background: rgba(0, 0, 0, .06); }',
            '.password-toggle-btn:disabled { cursor: not-allowed; opacity: .4; }',
            '.password-field.pw-visible .password-toggle-btn { display: flex; }',
            '.shake-anim { animation: inputShake .45s cubic-bezier(.36, .07, .19, .97) both; }',
            'input.shake-anim, .shake-anim > input { transition: 0.5s; border-color: red; box-shadow: red 0px 0px 8px; }',
            '@keyframes inputShake {',
            '  0%, 100% { transform: translateX(0); }',
            '  25% { transform: translateX(-2px); }',
            '  50% { transform: translateX(2px); }',
            '  75% { transform: translateX(-1px); }',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    }

    // Adds an eye button to a password input to show or hide the password
    function setupPasswordToggle(input) {
        if (!input || input.dataset.pwToggleReady === '1') return;
        input.dataset.pwToggleReady = '1';
        input.dataset.pwField = '1'; // marks the field so form handlers can find it

        injectPasswordStyles();

        var wrapper = document.createElement('span');
        wrapper.className = 'password-field';
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);

        // Adds padding on the right so text doesn't go under the eye button
        var currentPadding = parseFloat(window.getComputedStyle(input).paddingRight) || 0;
        if (currentPadding < 42) input.style.paddingRight = '42px';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'password-toggle-btn';
        btn.setAttribute('aria-label', 'Show password');
        btn.innerHTML = EYE_OPEN_SVG;
        wrapper.appendChild(btn);

        input._pwWrapper = wrapper;
        input._pwToggleBtn = btn;

        // Keeps focus on the input when clicking the eye button
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });

        btn.addEventListener('click', function () {
            var isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            btn.innerHTML = isHidden ? EYE_OFF_SVG : EYE_OPEN_SVG;
            btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');

            input.focus();
            var end = input.value.length;
            try { input.setSelectionRange(end, end); } catch (err) { }
        });

        // Shows the eye button only when the field is focused or has text
        var syncVisibility = function () {
            var shouldShow = document.activeElement === input || input.value.length > 0;
            wrapper.classList.toggle('pw-visible', shouldShow);
        };

        input.addEventListener('focus', syncVisibility);
        input.addEventListener('input', syncVisibility);
        input.addEventListener('blur', function () { window.setTimeout(syncVisibility, 0); });

        syncVisibility();
    }

    // Adds the eye button to every password field on the page
    document.querySelectorAll('input[type="password"]').forEach(setupPasswordToggle);

    // Page to redirect to after login, based on the user's role
    var ROLE_REDIRECTS = {
        'Administrator': 'admin.html',
        'Grounds Staff': 'grounds.html',
        'Office Staff': 'office.html'
    };

    var openContactBtn = document.getElementById('open_contact_btn');
    var contactModal = document.getElementById('contact_modal');
    var closeContactBtn = document.getElementById('close_contact_modal');

    // Handles opening and closing the contact modal
    if (openContactBtn && contactModal && closeContactBtn) {
        var openContactModal = function () { contactModal.classList.add('open'); };
        var closeContactModal = function () { contactModal.classList.remove('open'); };

        openContactBtn.addEventListener('click', function (e) {
            e.preventDefault();
            openContactModal();
        });
        closeContactBtn.addEventListener('click', closeContactModal);
        contactModal.addEventListener('click', function (e) {
            if (e.target === contactModal) closeContactModal();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && contactModal.classList.contains('open')) closeContactModal();
        });
    }

    var termsModal = document.getElementById('terms');
    var termsLink = document.getElementById('terms_link');
    var closeTermsBtn = document.getElementById('close_btn');
    var acceptBtn = document.getElementById('term_accept_btn');
    var termsCheckbox = document.querySelector('.termsConditions input[type="checkbox"]');

    // Terms modal: the Accept button unlocks only after scrolling to the bottom
    if (termsModal && termsLink && closeTermsBtn && acceptBtn && termsCheckbox) {
        var termsAction = acceptBtn.closest('.termsAction');
        var termsContent = termsModal.querySelector('.termsContent');
        var SCROLL_TOLERANCE = 5;
        var hasReachedBottom = false;

        // Checks if the terms content has been scrolled to the bottom
        var isAtBottom = function () {
            if (!termsContent) return true;
            return (termsContent.scrollTop + termsContent.clientHeight >= termsContent.scrollHeight - SCROLL_TOLERANCE);
        };

        // Updates the Accept button based on the checkbox and scroll position
        var updateAcceptBtn = function () {
            if (termsCheckbox.checked) {
                acceptBtn.disabled = true;
                if (termsAction) termsAction.classList.add('hidden');
                return;
            }
            if (termsAction) termsAction.classList.remove('hidden');
            acceptBtn.disabled = !hasReachedBottom;
        };

        var openTermsModal = function () {
            termsModal.classList.remove('hidden');
            if (termsContent) termsContent.scrollTop = 0;
            if (termsCheckbox.checked) { updateAcceptBtn(); return; }
            hasReachedBottom = false;
            updateAcceptBtn();
            requestAnimationFrame(function () {
                // Content may already fit without scrolling
                if (isAtBottom()) { hasReachedBottom = true; updateAcceptBtn(); }
            });
        };

        var closeTermsModal = function () { termsModal.classList.add('hidden'); };

        termsLink.addEventListener('click', function (e) { e.preventDefault(); openTermsModal(); });
        closeTermsBtn.addEventListener('click', closeTermsModal);
        termsModal.addEventListener('click', function (e) { if (e.target === termsModal) closeTermsModal(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !termsModal.classList.contains('hidden')) closeTermsModal();
        });

        if (termsContent) {
            termsContent.addEventListener('scroll', function () {
                hasReachedBottom = isAtBottom();
                updateAcceptBtn();
            });
        }

        acceptBtn.addEventListener('click', function () {
            if (acceptBtn.disabled) return;
            termsCheckbox.checked = true;
            termsCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
            closeTermsModal();
        });

        termsCheckbox.addEventListener('change', function () {
            if (!termsCheckbox.checked) hasReachedBottom = false;
            updateAcceptBtn();
        });

        updateAcceptBtn();
    }

    // Fullname input: allows only letters and spaces
    var fullNameInputs = document.querySelectorAll('input[placeholder="Fullname"]');
    fullNameInputs.forEach(function (input) {
        input.addEventListener('input', function () {
            var cleaned = this.value.replace(/[^\p{L}\s]/gu, '');
            if (this.value !== cleaned) this.value = cleaned;
        });
    });

    // Email input: shows a message when the email format is invalid
    var emailInputs = document.querySelectorAll('input[type="email"]');
    emailInputs.forEach(function (input) {
        var validateEmail = function () {
            var value = input.value.trim();
            var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (value === '') input.setCustomValidity('');
            else if (!emailRegex.test(value)) input.setCustomValidity('Please enter a valid email address.');
            else input.setCustomValidity('');
        };
        input.addEventListener('input', validateEmail);
        input.addEventListener('blur', validateEmail);
    });

    // Phone input: formats the value as +63 XXX XXX XXXX while typing
    var phoneInputs = document.querySelectorAll('input[type="tel"]');
    var PH_PREFIX = '+63';
    var formatPhone = function (value) {
        var raw = value.replace(/^\+63\s*/, '');
        var digits = raw.replace(/\D/g, '');
        digits = digits.replace(/^0/, '').replace(/^63/, '');
        digits = digits.slice(0, 10);
        var formatted = PH_PREFIX;
        if (digits.length > 0) formatted += ' ' + digits.slice(0, 3);
        if (digits.length > 3) formatted += ' ' + digits.slice(3, 6);
        if (digits.length > 6) formatted += ' ' + digits.slice(6, 10);
        return formatted;
    };

    phoneInputs.forEach(function (input) {
        input.addEventListener('input', function () { this.value = formatPhone(this.value); });
        input.addEventListener('focus', function () {
            if (this.value === '' || this.value === PH_PREFIX) this.value = PH_PREFIX + ' ';
        });
        input.addEventListener('blur', function () {
            if (this.value === PH_PREFIX + ' ' || this.value === PH_PREFIX) {
                this.value = '';
                this.setCustomValidity('');
            }
        });
        if (input.value) input.value = formatPhone(input.value);
    });

    // Login form
    var loginForm = document.querySelector('.loginBtn')?.closest('form');
    if (loginForm) {
        loginForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const submitBtn = loginForm.querySelector('.loginBtn');
            if (submitBtn && submitBtn.disabled) return;

            clearAllShakesInForm(loginForm);

            // Skip the password field even when it's shown as text
            const usernameInput = loginForm.querySelector('input[type="text"]:not([data-pw-field="1"])');
            const passwordInput = loginForm.querySelector('input[data-pw-field="1"]') ||
                loginForm.querySelector('input[type="password"]');
            if (!usernameInput || !passwordInput) return;

            const username = usernameInput.value.trim();
            const password = passwordInput.value;

            if (!username || !password) {
                if (!username) shakeField(usernameInput);
                if (!password) shakeField(passwordInput);
                showAlertTOP('Please enter username and password.', 'warning');
                return;
            }

            setFormBusy(loginForm, submitBtn, true, 'Logging In...');

            let success = false;
            try {
                const { ok, data } = await authFetch('api/auth.php', { username, password }, MIN_LOADING_MS);

                if (!ok) {
                    const message = readErrorMessage(data, 'Login failed');
                    shakeField(passwordInput);
                    if (/username|user name|account/i.test(message)) shakeField(usernameInput);
                    showAlertTOP(message, 'error');
                    return;
                }

                const payload = (data && data.data) ? data.data : data;
                const role = payload && payload.role;
                const target = ROLE_REDIRECTS[role];

                if (target) {
                    success = true;
                    localStorage.setItem('justLoggedIn', '1');

                    // Uses the API display name, or the typed username as a fallback
                    const displayName = (payload && payload.name) ? payload.name : username;

                    showAlertTOP(
                        'Greetings ' + displayName + '! You are now logged in. Redirecting...',
                        'success',
                        LOGIN_SUCCESS_REDIRECT_MS
                    );

                    setTimeout(function () {
                        window.location.href = target;
                    }, LOGIN_SUCCESS_REDIRECT_MS);
                } else {
                    showAlertTOP('Login succeeded, but the account role is not recognized. Please contact an administrator.', 'error');
                }
            } catch (err) {
                console.error(err);
                showAlertTOP('An error occurred. Please try again.', 'error');
            } finally {
                // Unlocks the form only when login did not succeed
                if (!success) setFormBusy(loginForm, submitBtn, false);
            }
        });
    }

    // Signup Form
    var signupForm = document.querySelector('.signupBtn')?.closest('form');
    if (signupForm) {
        signupForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const submitBtn = signupForm.querySelector('.signupBtn');
            if (submitBtn && submitBtn.disabled) return;

            clearAllShakesInForm(signupForm);

            const nameInput = signupForm.querySelector('input[placeholder="Fullname"]');
            const usernameInput = signupForm.querySelector('input[placeholder="Username"]');
            const emailInput = signupForm.querySelector('input[type="email"]');
            const phoneInput = signupForm.querySelector('input[type="tel"]');
            const passwordInput = signupForm.querySelector('input[data-pw-field="1"]') ||
                signupForm.querySelector('input[type="password"]');
            const termsCheckbox = signupForm.querySelector('.termsConditions input[type="checkbox"]');

            const fields = {
                name: nameInput,
                username: usernameInput,
                email: emailInput,
                phone: phoneInput,
                password: passwordInput,
                terms: termsCheckbox
            };

            if (!termsCheckbox.checked) {
                shakeField(termsCheckbox, termsCheckbox.closest('.termsConditions'));
                showAlertTOP('You must agree to the terms and conditions.', 'warning');
                return;
            }

            const name = nameInput.value.trim();
            const username = usernameInput.value.trim();
            const email = emailInput.value.trim();
            const phone = phoneInput.value.trim();
            const password = passwordInput.value;

            // Checks that no field is empty
            if (!name || !username || !email || !phone || !password) {
                [nameInput, usernameInput, emailInput, phoneInput, passwordInput].forEach(function (input) {
                    if (input && !input.value.trim()) shakeField(input);
                });
                showAlertTOP('All fields are required.', 'warning');
                return;
            }

            // Username: 3-20 characters, letters/numbers/underscores only
            if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_]+$/.test(username)) {
                shakeField(usernameInput);
                showAlertTOP('Username must be 3-20 characters and contain only letters, numbers, and underscores.', 'warning');
                return;
            }
            // Password: 6+ characters with upper, lower, and a number
            if (password.length < 6 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
                shakeField(passwordInput);
                showAlertTOP('Password must be at least 6 characters and include an uppercase letter, a lowercase letter, and a number.', 'warning');
                return;
            }

            setFormBusy(signupForm, submitBtn, true, 'Signing Up...');

            let success = false;
            try {
                const { ok, data } = await authFetch('api/users.php', {
                    name: name,
                    username: username,
                    email: email,
                    phone_number: phone,
                    password: password
                }, MIN_LOADING_MS);

                if (!ok) {
                    const message = readErrorMessage(data, 'Registration failed');
                    shakeFieldsByMessage(message, fields);
                    showAlertTOP(message, 'error');
                    return;
                }

                success = true;
                const successMessage = readErrorMessage(data, 'Registration successful. Please wait for admin verification.');
                showSuccessThenRedirect(successMessage, 'login.html');
            } catch (err) {
                console.error(err);
                showAlertTOP('An error occurred. Please try again.', 'error');
            } finally {
                if (!success) setFormBusy(signupForm, submitBtn, false);
            }
        });
    }

    // Forgot Password or Reset Form
    var resetForm = document.querySelector('.resetBtn')?.closest('form');
    if (resetForm) {
        resetForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const submitBtn = resetForm.querySelector('.resetBtn');
            if (submitBtn && submitBtn.disabled) return;

            clearAllShakesInForm(resetForm);

            const nameInput = resetForm.querySelector('input[placeholder="Fullname"]');
            const usernameInput = resetForm.querySelector('input[placeholder="Username"]');
            const emailInput = resetForm.querySelector('input[type="email"]');
            const phoneInput = resetForm.querySelector('input[type="tel"]');
            const passwordInput = resetForm.querySelector('input[data-pw-field="1"]') ||
                resetForm.querySelector('input[type="password"]');

            const fields = {
                name: nameInput,
                username: usernameInput,
                email: emailInput,
                phone: phoneInput,
                password: passwordInput
            };

            const name = nameInput.value.trim();
            const username = usernameInput.value.trim();
            const email = emailInput.value.trim();
            const phone = phoneInput.value.trim();
            const newPassword = passwordInput.value;

            if (!name || !username || !email || !phone || !newPassword) {
                [nameInput, usernameInput, emailInput, phoneInput, passwordInput].forEach(function (input) {
                    if (input && !input.value.trim()) shakeField(input);
                });
                showAlertTOP('All fields are required.', 'warning');
                return;
            }

            // Uses the same password rules as sign up
            if (newPassword.length < 6 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
                shakeField(passwordInput);
                showAlertTOP('Password must be at least 6 characters and include an uppercase letter, a lowercase letter, and a number.', 'warning');
                return;
            }

            setFormBusy(resetForm, submitBtn, true, 'Resetting...');

            let success = false;
            try {
                const { ok, data } = await authFetch('api/users.php/forgot-password', {
                    name: name,
                    username: username,
                    email: email,
                    phone_number: phone,
                    password: newPassword
                }, MIN_LOADING_MS);

                if (!ok) {
                    const message = readErrorMessage(data, 'Password reset failed');

                    // Shakes all fields when the account can't be matched
                    if (/not found|could not reset|credentials|details are correct/i.test(message)) {
                        shakeAllFields(fields);
                    } else {
                        shakeFieldsByMessage(message, fields);
                    }

                    showAlertTOP(message, 'error');
                    return;
                }

                success = true;
                const successMessage = readErrorMessage(data, 'Password reset successful. You can now log in.');
                showSuccessThenRedirect(successMessage, 'login.html');
            } catch (err) {
                console.error(err);
                showAlertTOP('An error occurred. Please try again.', 'error');
            } finally {
                if (!success) setFormBusy(resetForm, submitBtn, false);
            }
        });
    }
});