document.addEventListener('DOMContentLoaded', () => {
    const termsLink = document.getElementById('termsLink');
    const terms = document.getElementById('terms');
    const btnClose = document.getElementById('btnClose');
    const btnTermAccept = document.getElementById('btnTermAccept');
    const termsCheckbox = document.querySelector('.termsConditions input[type="checkbox"]');
    const termsContent = document.querySelector('.termsContent');

    const contactAdmin = document.getElementById("contactAdmin");
    const btnOpenContact = document.getElementById("btnOpenContact");
    const btnCancelContact = document.getElementById("btnCancelContact");

    function openContainer(e) {
        e.preventDefault();
        if (terms) {
            terms.classList.remove('hidden');
            document.body.style.overflow = 'hidden';

            if (termsCheckbox && termsCheckbox.checked) {
                if (btnTermAccept) btnTermAccept.classList.add('hidden');
            } else {
                if (btnTermAccept) {
                    btnTermAccept.classList.remove('hidden');
                    btnTermAccept.disabled = true;
                }
                if (termsContent) termsContent.scrollTop = 0;
            }
        }
    }

    function closeContainer() {
        if (terms) {
            terms.classList.add('hidden');
            document.body.style.overflow = '';
        }
    }

    if (termsContent && btnTermAccept) {
        termsContent.addEventListener('scroll', () => {
            if (termsCheckbox && termsCheckbox.checked) return;

            const { scrollTop, scrollHeight, clientHeight } = termsContent;
            if (scrollTop + clientHeight >= scrollHeight - 5) {
                btnTermAccept.disabled = false;
            }
        });
    }

    if (termsLink) termsLink.addEventListener('click', openContainer);
    if (btnClose) btnClose.addEventListener('click', closeContainer);

    if (btnTermAccept) {
        btnTermAccept.addEventListener('click', () => {
            if (termsCheckbox) termsCheckbox.checked = true;
            closeContainer();
        });
    }

    if (terms) {
        terms.addEventListener('click', (e) => {
            if (e.target === terms) {
                closeContainer();
            }
        });
    }

    if (btnOpenContact && contactAdmin) {
        btnOpenContact.onclick = function () {
            contactAdmin.style.display = "flex";
        };
    }

    if (btnCancelContact && contactAdmin) {
        btnCancelContact.onclick = function () {
            contactAdmin.style.display = "none";
        };
    }

    window.addEventListener('click', (event) => {
        if (contactAdmin && event.target == contactAdmin) {
            contactAdmin.style.display = "none";
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (terms && !terms.classList.contains('hidden')) {
                closeContainer();
            }
            if (contactAdmin && contactAdmin.style.display === "flex") {
                contactAdmin.style.display = "none";
            }
        }
    });
});