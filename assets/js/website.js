// Sample Mock Data
const mockRecords = [
    {
        id: 1,
        name: "Sample Name 1",
        dateOfBirth: "2000-01-01",
        dateOfDeath: "2026-01-01",
        block: "1",
        row: "1",
        column: "2",
        graveType: "Bone Chamber"
    },
    {
        id: 2,
        name: "Sample Name 2",
        dateOfBirth: "2000-01-01",
        dateOfDeath: "2026-01-01",
        block: "3",
        row: "2",
        column: "5",
        graveType: "Niche"
    },
    {
        id: 3,
        name: "Sample Name 3",
        dateOfBirth: "2000-01-01",
        dateOfDeath: "2026-01-01",
        block: "4",
        row: "2",
        column: "2",
        graveType: "Ground / Lawn"
    },
    {
        id: 4,
        name: "Sample Name 4",
        dateOfBirth: "2000-01-01",
        dateOfDeath: "2026-01-01",
        block: "5",
        row: "3",
        column: "4",
        graveType: "Niche"
    },
    {
        id: 5,
        name: "Sample Name 5",
        dateOfBirth: "2000-01-01",
        dateOfDeath: "2026-01-01",
        block: "2",
        row: "6",
        column: "1",
        graveType: "Niche"
    }
];

const PH_PREFIX = "+63 ";

document.addEventListener("DOMContentLoaded", () => {
    initNavigation();
    initMobileNav();   
    initHomeView();
    initSearchView();
    initPaymentView();
    initHoursModal();
    initRecordModal();
    initGlobalAccessibility();
});

function showView(targetId) {
    const pageSections = document.querySelectorAll('.pageSection');
    const navLinks = document.querySelectorAll('nav .navLink');

    pageSections.forEach(section => {
        section.classList.toggle('active', section.id === targetId);
    });

    navLinks.forEach(link => {
        const href = link.getAttribute('href')?.replace('#', '');
        link.classList.toggle('active', href === targetId);
    });
}

function handleHashChange() {
    const hash = window.location.hash.replace('#', '') || 'home';
    showView(hash);
}

function initNavigation() {
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
}

function initMobileNav() {
    const toggle = document.getElementById("nav_toggle");
    const nav = document.getElementById("main_nav");
    if (!toggle || !nav) return;

    const closeNav = () => {
        nav.classList.remove("open");
        toggle.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
    };

    toggle.addEventListener("click", () => {
        const isOpen = nav.classList.toggle("open");
        toggle.classList.toggle("open", isOpen);
        toggle.setAttribute("aria-expanded", String(isOpen));
    });

    // Close menu after choosing a destination
    nav.querySelectorAll(".navLink").forEach(link => {
        link.addEventListener("click", closeNav);
    });

    // Close on resize back to desktop
    window.addEventListener("resize", () => {
        if (window.innerWidth > 900) closeNav();
    });

    // Close when tapping outside
    document.addEventListener("click", (e) => {
        if (!nav.classList.contains("open")) return;
        if (nav.contains(e.target) || toggle.contains(e.target)) return;
        closeNav();
    });
}

function initHomeView() {
    const findLovedOneBtn = document.querySelector(".findLovedOneBtn");
    if (findLovedOneBtn) {
        findLovedOneBtn.addEventListener("click", () => {
            window.location.hash = "#search";
        });
    }

    const cemeteryMapBtns = document.querySelectorAll(".cemeteryMapBtn");
    cemeteryMapBtns.forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            window.location.hash = "#map";
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
    });

    const cards = document.querySelectorAll(".cardGrid .card");
    cards.forEach(card => {
        card.addEventListener("click", () => {
            const title = card.querySelector("h4")?.textContent.trim();

            if (title === "Search") {
                window.location.hash = "#search";
            } else if (title === "Cemetery Map") {
                window.location.hash = "#map";
                window.scrollTo({ top: 0, behavior: "smooth" });
            } else if (title === "Payments") {
                window.location.hash = "#payment";
                window.scrollTo({ top: 0, behavior: "smooth" });
            } else if (title === "Burial Requirements") {
                window.location.hash = "#home";

                setTimeout(() => {
                    const section = document.getElementById("burial_requirements");
                    if (section) {
                        section.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                }, 0);
            }
        });
    });
}

function initSearchView() {
    const searchForm = document.querySelector("#search form");
    const recordsGrid = document.querySelector(".recordsCardGrid");
    const searchInput = searchForm?.querySelector("input");

    if (!searchForm || !recordsGrid || !searchInput) return;

    searchForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const query = searchInput.value.toLowerCase().trim();

        if (!query) {
            recordsGrid.innerHTML = "";
            return;
        }

        const results = mockRecords.filter(record =>
            record.name.toLowerCase().includes(query)
        );

        renderRecords(results, recordsGrid);
    });
}

function formatDate(dateString) {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;

    return date.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric"
    });
}

function renderRecords(records, container) {
    container.innerHTML = "";

    if (records.length === 0) {
        const emptyMsg = document.createElement("p");
        emptyMsg.className = "emptySearchMessage";
        emptyMsg.textContent = "No matching records found.";
        container.appendChild(emptyMsg);
        return;
    }

    records.forEach(record => {
        const card = document.createElement("div");
        card.className = "card";

        card.innerHTML = `
            <h4>${record.name}</h4>
            <p><strong>Born:</strong> ${formatDate(record.dateOfBirth)}</p>
            <p><strong>Died:</strong> ${formatDate(record.dateOfDeath)}</p>
        `;

        card.addEventListener("click", () => openRecordModal(record));
        container.appendChild(card);
    });
}

function initPaymentView() {
    const paymentForm = document.getElementById("payment_form");
    const payPurposeSelect = document.getElementById("pay_purpose");
    const otherWrapper = document.getElementById("other_purpose_wrapper");
    const otherInput = document.getElementById("pay_other_purpose");

    const payNameInput = document.getElementById("pay_name");
    const payDeceasedNameInput = document.getElementById("pay_deceased_name");
    const payContactInput = document.getElementById("pay_contact");
    const payEmailInput = document.getElementById("pay_email");
    const payAmountInput = document.getElementById("pay_amount");

    [payNameInput, payDeceasedNameInput].forEach(input => {
        if (!input) return;
        input.addEventListener("input", (e) => {
            e.target.value = e.target.value.replace(/[0-9]/g, "");
        });
    });

    if (payContactInput) {
        const formatPhContact = () => {
            let value = payContactInput.value;

            let body = value;
            if (body.startsWith("+63 ")) body = body.slice(4);
            else if (body.startsWith("+63")) body = body.slice(3);
            else if (body.startsWith("+6")) body = body.slice(2);
            else if (body.startsWith("+")) body = body.slice(1);

            let digits = body.replace(/\D/g, "");

            if (digits.startsWith("63") && digits.length > 10) digits = digits.slice(2);

            if (digits.startsWith("0")) digits = digits.slice(1);

            digits = digits.slice(0, 10);

            let formatted = "+63";
            if (digits.length > 0) {
                formatted += " " + digits.slice(0, 3);
                if (digits.length > 3) formatted += " " + digits.slice(3, 6);
                if (digits.length > 6) formatted += " " + digits.slice(6, 10);
            } else {
                formatted += " ";
            }

            payContactInput.value = formatted;
        };

        payContactInput.value = PH_PREFIX;

        payContactInput.addEventListener("input", formatPhContact);

        payContactInput.addEventListener("focus", () => {
            if (!payContactInput.value) {
                payContactInput.value = PH_PREFIX;
            }
        });

        payContactInput.addEventListener("keypress", (e) => {
            const allowed = /[0-9+\s]/;
            if (!allowed.test(e.key) && e.key.length === 1) {
                e.preventDefault();
            }
        });

        payContactInput.addEventListener("keydown", (e) => {
            const caret = payContactInput.selectionStart;
            const selectionEnd = payContactInput.selectionEnd;

            if ((e.key === "Backspace" || e.key === "Delete")) {
                if (e.key === "Backspace" && caret <= PH_PREFIX.length && caret === selectionEnd) {
                    e.preventDefault();
                } else if (e.key === "Delete" && caret < PH_PREFIX.length) {
                    e.preventDefault();
                }
            }
        });
    }

    if (payAmountInput) {
        payAmountInput.addEventListener("input", (e) => {
            let val = e.target.value.replace(/[^0-9.]/g, "");
            const parts = val.split(".");
            if (parts.length > 2) {
                val = parts[0] + "." + parts.slice(1).join("");
            }
            if (parts[1] && parts[1].length > 2) {
                val = parts[0] + "." + parts[1].substring(0, 2);
            }
            e.target.value = val;
        });
    }

    if (payPurposeSelect && otherWrapper && otherInput) {
        payPurposeSelect.addEventListener("change", (e) => {
            if (e.target.value === "Others") {
                otherWrapper.classList.remove("hidden");
                otherInput.setAttribute("required", "true");
            } else {
                otherWrapper.classList.add("hidden");
                otherInput.removeAttribute("required");
                otherInput.value = "";
            }
        });
    }

    if (paymentForm) {
        paymentForm.addEventListener("submit", (e) => {
            let subscriberDigits = payContactInput
                ? payContactInput.value.replace(/\D/g, "")
                : "";

            if (subscriberDigits.startsWith("63")) subscriberDigits = subscriberDigits.slice(2);
            if (subscriberDigits.startsWith("0")) subscriberDigits = subscriberDigits.slice(1);

            const isValidPhMobile =
                subscriberDigits.length === 10 && subscriberDigits.startsWith("9");

            if (!isValidPhMobile) {
                e.preventDefault();
                alert("Please enter a valid Philippine mobile number (e.g. +63 917 123 4567).");
                payContactInput?.focus();
                return;
            }

            if (payEmailInput && !payEmailInput.value.includes("@")) {
                e.preventDefault();
                alert("Please enter a valid email address containing '@'.");
                payEmailInput.focus();
                return;
            }

            e.preventDefault();

            const formData = new FormData(paymentForm);
            const data = Object.fromEntries(formData.entries());

            data.contact = "+63" + subscriberDigits;

            console.log("Payment Record Submitted:", data);
            alert("Thank you! Your payment details have been successfully submitted for verification.");

            paymentForm.reset();
            if (otherWrapper) {
                otherWrapper.classList.add("hidden");
            }

            if (payContactInput) payContactInput.value = PH_PREFIX;
        });
    }
}

function closeHoursModal() {
    const hoursModal = document.getElementById("hours_modal");
    if (hoursModal) {
        hoursModal.classList.add("hidden");
    }
}

function initHoursModal() {
    const hoursModal = document.getElementById("hours_modal");
    const triggers = document.querySelectorAll(".officeHoursTrigger");
    const closeBtn = document.getElementById("close_hours_btn");

    updateCurrentDayHighlight();

    triggers.forEach(trigger => {
        trigger.addEventListener("click", () => {
            if (hoursModal) {
                hoursModal.classList.remove("hidden");
                updateCurrentDayHighlight();
            }
        });
    });

    if (closeBtn) {
        closeBtn.addEventListener("click", closeHoursModal);
    }

    if (hoursModal) {
        hoursModal.addEventListener("click", (e) => {
            if (e.target === hoursModal) closeHoursModal();
        });
    }
}

function updateCurrentDayHighlight() {
    const now = new Date();
    const day = now.getDay();
    const currentHour = now.getHours();

    document.querySelectorAll(".hoursItem").forEach(item => item.classList.remove("activeDay"));

    const dayElement = document.getElementById(`day_${day}`);
    if (dayElement) {
        dayElement.classList.add("activeDay");
    }

    const isOpen = (day >= 1 && day <= 6 && currentHour >= 8 && currentHour < 17);
    const statusTextElements = document.querySelectorAll(".modalStatusText");

    statusTextElements.forEach(el => {
        if (isOpen) {
            el.textContent = "Open Now";
            el.classList.remove("closed");
            el.classList.add("open");
        } else {
            el.textContent = "Closed Now";
            el.classList.remove("open");
            el.classList.add("closed");
        }
    });
}

function initRecordModal() {
    const recordModal = document.getElementById("record_modal");
    const closeBtn = document.getElementById("close_modal_btn");

    if (!recordModal || !closeBtn) return;

    closeBtn.addEventListener("click", closeRecordModal);
    recordModal.addEventListener("click", (e) => {
        if (e.target === recordModal) closeRecordModal();
    });
}

function openRecordModal(record) {
    const recordModal = document.getElementById("record_modal");
    if (!recordModal) return;

    document.getElementById("modal_name").textContent = record.name;

    const tiles = recordModal.querySelectorAll(".infoTile .tileValue");
    if (tiles[0]) tiles[0].textContent = formatDate(record.dateOfBirth);
    if (tiles[1]) tiles[1].textContent = formatDate(record.dateOfDeath);
    if (tiles[2]) tiles[2].textContent = `Block ${record.block}, Row ${record.row}, Column ${record.column}`;
    if (tiles[3]) tiles[3].textContent = record.graveType || "N/A";

    recordModal.classList.remove("hidden");
}

function closeRecordModal() {
    const recordModal = document.getElementById("record_modal");
    if (recordModal) {
        recordModal.classList.add("hidden");
    }
}

function initGlobalAccessibility() {
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeHoursModal();
            closeRecordModal();
        }
    });
}