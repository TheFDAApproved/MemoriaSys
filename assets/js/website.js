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

document.addEventListener("DOMContentLoaded", () => {
    initNavigation();
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
                const section = document.getElementById("burialrequirements");
                if (section) {
                    section.scrollIntoView({ behavior: "smooth", block: "start" });
                }
            }
        });
    });
}

function initSearchView() {
    const searchForm = document.querySelector("#search form");
    const recordsGrid = document.querySelector(".recordsCardGrid");
    const searchInput = searchForm?.querySelector("input");

    if (!searchForm || !recordsGrid) return;

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
    const paymentForm = document.getElementById("paymentForm");
    const payPurposeSelect = document.getElementById("payPurpose");
    const otherWrapper = document.getElementById("otherPurposeWrapper");
    const otherInput = document.getElementById("payOtherPurpose");

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
            e.preventDefault();

            const formData = new FormData(paymentForm);
            const data = Object.fromEntries(formData.entries());

            console.log("Payment Record Submitted:", data);
            alert("Thank you! Your payment details have been successfully submitted for verification.");

            paymentForm.reset();
            if (otherWrapper) {
                otherWrapper.classList.add("hidden");
            }
        });
    }
}

function closeHoursModal() {
    const hoursModal = document.getElementById("hoursModal");
    if (hoursModal) {
        hoursModal.classList.add("hidden");
    }
}

function initHoursModal() {
    const hoursModal = document.getElementById("hoursModal");
    const triggers = document.querySelectorAll(".officeHoursTrigger");
    const closeBtn = document.getElementById("closeHoursBtn");

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
    const recordModal = document.getElementById("recordModal");
    const closeBtn = document.getElementById("closeModalBtn");

    if (!recordModal || !closeBtn) return;

    closeBtn.addEventListener("click", closeRecordModal);
    recordModal.addEventListener("click", (e) => {
        if (e.target === recordModal) closeRecordModal();
    });
}

function openRecordModal(record) {
    const recordModal = document.getElementById("recordModal");
    if (!recordModal) return;

    document.getElementById("modalName").textContent = record.name;
    document.getElementById("modalBorn").textContent = formatDate(record.dateOfBirth);
    document.getElementById("modalDied").textContent = formatDate(record.dateOfDeath);

    const locationStr = `Block ${record.block}, Row ${record.row}, Column ${record.column}`;
    document.getElementById("modalLocation").textContent = locationStr;
    document.getElementById("modalGraveType").textContent = record.graveType || "N/A";

    recordModal.classList.remove("hidden");
}

function closeRecordModal() {
    const recordModal = document.getElementById("recordModal");
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