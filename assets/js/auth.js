document.addEventListener('DOMContentLoaded', function () {

    function readErrorMessage(data, fallback) {
        if (!data) return fallback;
        return data.message || data.error || fallback;
    }

    const ROLE_REDIRECTS = {
        'Administrator': 'admin.html',
        'Grounds Staff': 'grounds.html',
        'Office Staff': 'office.html'
    };

    var openContactBtn = document.getElementById('open_contact_btn');
    var contactModal = document.getElementById('contact_modal');
    var closeContactBtn = document.getElementById('close_contact_modal');

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

    if (termsModal && termsLink && closeTermsBtn && acceptBtn && termsCheckbox) {
        var termsAction = acceptBtn.closest('.termsAction');
        var termsContent = termsModal.querySelector('.termsContent');
        var SCROLL_TOLERANCE = 5;
        var hasReachedBottom = false;

        var isAtBottom = function () {
            if (!termsContent) return true;
            return (termsContent.scrollTop + termsContent.clientHeight >= termsContent.scrollHeight - SCROLL_TOLERANCE);
        };

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

    var fullNameInputs = document.querySelectorAll('input[placeholder="Fullname"]');
    fullNameInputs.forEach(function (input) {
        input.addEventListener('input', function () {
            var cleaned = this.value.replace(/[^\p{L}\s]/gu, '');
            if (this.value !== cleaned) this.value = cleaned;
        });
    });

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

    var loginForm = document.querySelector('.loginBtn')?.closest('form');
    if (loginForm) {
        loginForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            const usernameInput = loginForm.querySelector('input[type="text"]');
            const passwordInput = loginForm.querySelector('input[type="password"]');
            if (!usernameInput || !passwordInput) return;

            const username = usernameInput.value.trim();
            const password = passwordInput.value;

            if (!username || !password) {
                alert('Please enter username and password.');
                return;
            }

            const submitBtn = loginForm.querySelector('.loginBtn');
            if (submitBtn) submitBtn.disabled = true;

            try {
                const res = await fetch('api/auth.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (!res.ok) {
                    alert(readErrorMessage(data, 'Login failed'));
                    return;
                }

                const payload = (data && data.data) ? data.data : data;
                const role = payload && payload.role;

                const target = ROLE_REDIRECTS[role];
                if (target) {
                    localStorage.setItem('justLoggedIn', '1');
                    window.location.href = target;
                } else {
                    alert('Login succeeded, but the account role is not recognized. Please contact an administrator.');
                }
            } catch (err) {
                console.error(err);
                alert('An error occurred. Please try again.');
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }

    var signupForm = document.querySelector('.signupBtn')?.closest('form');
    if (signupForm) {
        signupForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const nameInput = signupForm.querySelector('input[placeholder="Fullname"]');
            const usernameInput = signupForm.querySelector('input[placeholder="Username"]');
            const emailInput = signupForm.querySelector('input[type="email"]');
            const phoneInput = signupForm.querySelector('input[type="tel"]');
            const passwordInput = signupForm.querySelector('input[type="password"]');
            const termsCheckbox = signupForm.querySelector('.termsConditions input[type="checkbox"]');

            if (!termsCheckbox.checked) {
                alert('You must agree to the terms and conditions.');
                return;
            }

            const name = nameInput.value.trim();
            const username = usernameInput.value.trim();
            const email = emailInput.value.trim();
            const phone = phoneInput.value.trim();
            const password = passwordInput.value;

            if (!name || !username || !email || !phone || !password) {
                alert('All fields are required.');
                return;
            }

            if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_]+$/.test(username)) {
                alert('Username must be 3-20 characters and contain only letters, numbers, and underscores.');
                return;
            }
            if (password.length < 6 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
                alert('Password must be at least 6 characters and include an uppercase letter, a lowercase letter, and a number.');
                return;
            }

            const submitBtn = signupForm.querySelector('.signupBtn');
            if (submitBtn) submitBtn.disabled = true;

            try {
                const res = await fetch('api/users.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        username: username,
                        email: email,
                        phone_number: phone,
                        password: password
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    alert(readErrorMessage(data, 'Registration failed'));
                    return;
                }
                alert(readErrorMessage(data, 'Registration successful. Please wait for admin verification.'));
                window.location.href = 'login.html';
            } catch (err) {
                console.error(err);
                alert('An error occurred. Please try again.');
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }

    var resetForm = document.querySelector('.resetBtn')?.closest('form');
    if (resetForm) {
        resetForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const nameInput = resetForm.querySelector('input[placeholder="Fullname"]');
            const usernameInput = resetForm.querySelector('input[placeholder="Username"]');
            const emailInput = resetForm.querySelector('input[type="email"]');
            const phoneInput = resetForm.querySelector('input[type="tel"]');
            const passwordInput = resetForm.querySelector('input[type="password"]');

            const name = nameInput.value.trim();
            const username = usernameInput.value.trim();
            const email = emailInput.value.trim();
            const phone = phoneInput.value.trim();
            const newPassword = passwordInput.value;

            if (!name || !username || !email || !phone || !newPassword) {
                alert('All fields are required.');
                return;
            }

            if (newPassword.length < 6 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
                alert('Password must be at least 6 characters and include an uppercase letter, a lowercase letter, and a number.');
                return;
            }

            const submitBtn = resetForm.querySelector('.resetBtn');
            if (submitBtn) submitBtn.disabled = true;

            try {
                const res = await fetch('api/users.php/forgot-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        username: username,
                        email: email,
                        phone_number: phone,
                        password: newPassword
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    alert(readErrorMessage(data, 'Password reset failed'));
                    return;
                }
                alert(readErrorMessage(data, 'Password reset successful. You can now log in.'));
                window.location.href = 'login.html';
            } catch (err) {
                console.error(err);
                alert('An error occurred. Please try again.');
            } finally {
                if (submitBtn) submitBtn.disabled = false;
            }
        });
    }
});