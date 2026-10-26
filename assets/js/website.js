const PH_PREFIX = "+63 ";
const SEARCH_MIN_DELAY_MS = 700;

// Used to ignore older search responses when the user searches again quickly
let searchRequestId = 0;

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

// Page Navigation [Single-page switching via hash]
// Show only the section that matches the target id and mark its nav link active
function showView(targetId) {
    const pageSections = document.querySelectorAll(".pageSection");
    const navLinks = document.querySelectorAll("nav .navLink");

    pageSections.forEach((section) => {
        section.classList.toggle("active", section.id === targetId);
    });

    navLinks.forEach((link) => {
        const href = link.getAttribute("href")?.replace("#", "");
        link.classList.toggle("active", href === targetId);
    });
}

// Read the #hash from the URL and show the matching section
function handleHashChange() {
    const hash = window.location.hash.replace("#", "") || "home";
    showView(hash);
}

function initNavigation() {
    handleHashChange();
    window.addEventListener("hashchange", handleHashChange);
}

// Mobile Nav [Hamburger Menu]
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

    // Close the menu after picking a link
    nav.querySelectorAll(".navLink").forEach((link) => {
        link.addEventListener("click", closeNav);
    });

    // Close on resize back to desktop
    window.addEventListener("resize", () => {
        if (window.innerWidth > 900) closeNav();
    });

    // Close when clicking outside the menu
    document.addEventListener("click", (e) => {
        if (!nav.classList.contains("open")) return;
        if (nav.contains(e.target) || toggle.contains(e.target)) return;
        closeNav();
    });
}

// Home Page Interactions
function initHomeView() {
    // "Find Loved One" banner button > go to search
    const findLovedOneBtn = document.querySelector(".findLovedOneBtn");
    if (findLovedOneBtn) {
        findLovedOneBtn.addEventListener("click", () => {
            window.location.hash = "#search";
        });
    }

    // All "Cemetery Map" buttons > go to map and scroll to top
    const cemeteryMapBtns = document.querySelectorAll(".cemeteryMapBtn");
    cemeteryMapBtns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            window.location.hash = "#map";
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
    });

    // Service cards > route to the right section
    const cards = document.querySelectorAll(".cardGrid .card");
    cards.forEach((card) => {
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

                // Scroll to the burial requirements subsection after the page changes
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

// Search
function initSearchView() {
    const searchForm = document.querySelector("#search form");
    const recordsGrid = document.querySelector(".recordsCardGrid");
    const searchInput = searchForm?.querySelector("input");
    const submitBtn =
        searchForm?.querySelector(
            'button[type="submit"], .searchBtn, input[type="submit"]',
        ) || searchForm?.querySelector("button");

    if (!searchForm || !recordsGrid || !searchInput) return;

    initSearchClearButton({ searchForm, searchInput, recordsGrid, submitBtn });

    searchForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        // Don't send another request while one is already running
        if (searchForm.classList.contains("isLoading")) return;

        const query = searchInput.value.trim();

        if (!query) {
            recordsGrid.innerHTML = "";
            return;
        }

        const requestId = ++searchRequestId;
        const startedAt = Date.now();

        renderLoadingState(recordsGrid, query);
        setSearchBusy(searchForm, submitBtn, true);

        try {
            const response = await fetch(
                `api/search?q=${encodeURIComponent(query)}`,
                {
                    method: "GET",
                    headers: { Accept: "application/json" },
                },
            );

            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }

            const payload = await response.json();

            if (!payload || payload.success === false) {
                throw new Error(payload?.message || "Search was not successful");
            }

            const results = Array.isArray(payload.data) ? payload.data : [];

            // Show the spinner for at least a short while so it doesn't flicker
            await ensureMinimumDelay(startedAt, SEARCH_MIN_DELAY_MS);
            if (requestId !== searchRequestId) return;

            if (results.length === 0) {
                renderNoResults(query, recordsGrid);
                return;
            }

            renderRecords(results.map(mapApiRecord), recordsGrid);
        } catch (error) {
            console.error("Search request failed:", error);

            await ensureMinimumDelay(startedAt, SEARCH_MIN_DELAY_MS);
            if (requestId !== searchRequestId) return;

            renderNoResults(query, recordsGrid);
        } finally {
            if (requestId === searchRequestId) {
                setSearchBusy(searchForm, submitBtn, false);
            }
        }
    });
}

// Wait until a minimum amount of time has passed [used for loading delay]
function ensureMinimumDelay(startedAt, minMs) {
    const elapsed = Date.now() - startedAt;
    const remaining = minMs - elapsed;
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, remaining));
}

// Adds the small "×" clear button inside the search input
function initSearchClearButton({
    searchForm,
    searchInput,
    recordsGrid,
    submitBtn,
}) {
    if (!searchInput || searchInput.dataset.clearInit === "true") return;
    searchInput.dataset.clearInit = "true";

    const parent = searchInput.parentElement;
    if (!parent) return;

    // Make sure the parent can position the button absolutely
    if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
    }

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "searchClearBtn";
    clearBtn.setAttribute("aria-label", "Clear search");
    clearBtn.textContent = "×";

    clearBtn.style.position = "absolute";
    clearBtn.style.right = "16px";
    clearBtn.style.top = "50%";
    clearBtn.style.transform = "translateY(-50%)";
    clearBtn.style.background = "transparent";
    clearBtn.style.border = "none";
    clearBtn.style.fontSize = "24px";
    clearBtn.style.color = "#94a3b8";
    clearBtn.style.cursor = "pointer";
    clearBtn.style.padding = "0";

    searchInput.insertAdjacentElement("afterend", clearBtn);

    // Only show the button when there's text
    const syncVisibility = () => {
        const hasText = searchInput.value.length > 0;
        clearBtn.style.display = hasText ? "block" : "none";
        searchInput.style.paddingRight = hasText ? "44px" : "";
    };

    searchInput.addEventListener("input", syncVisibility);

    clearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Cancel any in-flight search
        searchRequestId++;

        searchInput.value = "";
        syncVisibility();
        searchInput.focus();

        if (recordsGrid) recordsGrid.innerHTML = "";
        setSearchBusy(searchForm, submitBtn, false);
    });

    syncVisibility();
}

// Toggle a loading state on the search form and button
function setSearchBusy(form, submitBtn, isBusy) {
    if (form) {
        form.classList.toggle("isLoading", isBusy);
        form.setAttribute("aria-busy", String(isBusy));
    }
    if (submitBtn) {
        submitBtn.disabled = isBusy;
    }
}

// Show the "Searching..." spinner
function renderLoadingState(container, query) {
    container.innerHTML = "";

    const msg = document.createElement("p");
    msg.className = "emptySearchMessage searchLoadingMessage";
    msg.setAttribute("role", "status");
    msg.setAttribute("aria-live", "polite");

    const spinner = document.createElement("span");
    spinner.className = "searchSpinner";
    spinner.setAttribute("aria-hidden", "true");

    msg.appendChild(spinner);
    msg.appendChild(document.createTextNode(` Searching for "${query}"…`));

    container.appendChild(msg);
}

// Convert an API record into the shape the UI uses
function mapApiRecord(record) {
    return {
        id: record.id,
        name: record.name,
        dateOfBirth: record.date_of_birth,
        dateOfDeath: record.date_of_death,
        block: record.block,
        row: record.row,
        column: record.column,
        graveType: record.grave_type,
        graveCode: record.grave_code,
    };
}

// Show a "no records found" message
function renderNoResults(query, container) {
    container.innerHTML = "";
    const emptyMsg = document.createElement("p");
    emptyMsg.className = "emptySearchMessage";
    emptyMsg.textContent = `No records found for "${query}".`;
    container.appendChild(emptyMsg);
}

// Format a date string to "Month Day, Year"
function formatDate(dateString) {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;

    return date.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
    });
}

// Build the result cards from search results
function renderRecords(records, container) {
    container.innerHTML = "";

    if (records.length === 0) {
        const emptyMsg = document.createElement("p");
        emptyMsg.className = "emptySearchMessage";
        emptyMsg.textContent = "No matching records found.";
        container.appendChild(emptyMsg);
        return;
    }

    records.forEach((record) => {
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

// Payment Form
function initPaymentView() {
    const paymentForm = document.getElementById("payment_form");
    if (!paymentForm) return;

    const payNameInput = document.getElementById("pay_name");
    const payDeceasedNameInput = document.getElementById("pay_deceased_name");
    const payContactInput = document.getElementById("pay_contact");
    const payEmailInput = document.getElementById("pay_email");
    const payAmountInput = document.getElementById("pay_amount");
    const payImageInput = document.getElementById("pay_image");

    const submitBtn =
        paymentForm.querySelector(".submitPayBtn") ||
        paymentForm.querySelector('button[type="submit"], input[type="submit"]') ||
        paymentForm.querySelector("button");

    // Names should not contain numbers
    [payNameInput, payDeceasedNameInput].forEach((input) => {
        if (!input) return;
        input.addEventListener("input", (e) => {
            e.target.value = e.target.value.replace(/[0-9]/g, "");
        });
    });

    // Phone number formatting (+63 XXX XXX XXXX)
    if (payContactInput) {
        const formatPhContact = () => {
            let value = payContactInput.value;

            let body = value;
            if (body.startsWith("+63 ")) body = body.slice(4);
            else if (body.startsWith("+63")) body = body.slice(3);
            else if (body.startsWith("+6")) body = body.slice(2);
            else if (body.startsWith("+")) body = body.slice(1);

            let digits = body.replace(/\D/g, "");

            if (digits.startsWith("63") && digits.length > 10)
                digits = digits.slice(2);

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

        // Only allow numbers, plus, and spaces
        payContactInput.addEventListener("keypress", (e) => {
            const allowed = /[0-9+\s]/;
            if (!allowed.test(e.key) && e.key.length === 1) {
                e.preventDefault();
            }
        });

        // Don't let the user delete the "+63 " prefix
        payContactInput.addEventListener("keydown", (e) => {
            const caret = payContactInput.selectionStart;
            const selectionEnd = payContactInput.selectionEnd;

            if (e.key === "Backspace" || e.key === "Delete") {
                if (
                    e.key === "Backspace" &&
                    caret <= PH_PREFIX.length &&
                    caret === selectionEnd
                ) {
                    e.preventDefault();
                } else if (e.key === "Delete" && caret < PH_PREFIX.length) {
                    e.preventDefault();
                }
            }
        });
    }

    // Amount: only digits and one decimal point [Max 2 decimal places]
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

    // Submit handler
    paymentForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        if (paymentForm.classList.contains("isLoading")) return;

        // Normalize phone digits for validation
        let subscriberDigits = payContactInput
            ? payContactInput.value.replace(/\D/g, "")
            : "";

        if (subscriberDigits.startsWith("63"))
            subscriberDigits = subscriberDigits.slice(2);
        if (subscriberDigits.startsWith("0"))
            subscriberDigits = subscriberDigits.slice(1);

        const isValidPhMobile =
            subscriberDigits.length === 10 && subscriberDigits.startsWith("9");

        if (!isValidPhMobile) {
            showAlertTOP(
                "Please enter a valid Philippine mobile number (e.g. +63 917 123 4567).",
                "warning",
            );
            payContactInput?.focus();
            return;
        }

        if (payEmailInput && !payEmailInput.value.includes("@")) {
            showAlertTOP(
                "Please enter a valid email address containing '@'.",
                "warning",
            );
            payEmailInput.focus();
            return;
        }

        if (
            payImageInput &&
            (!payImageInput.files || payImageInput.files.length === 0)
        ) {
            showAlertTOP("Please attach an image proof of payment.", "warning");
            payImageInput.focus();
            return;
        }

        const formData = new FormData(paymentForm);
        formData.set("payers_phone_number", "+63" + subscriberDigits);

        if (payImageInput?.files?.[0]?.name) {
            formData.set("filename", payImageInput.files[0].name);
        }

        // Freeze the form while we submit
        setPaymentBusy(paymentForm, submitBtn, true);

        try {
            const response = await fetch("api/payments", {
                method: "POST",
                body: formData,
                headers: { Accept: "application/json" },
            });

            let payload = null;
            try {
                payload = await response.json();
            } catch (_) { }

            if (!response.ok || !payload || payload.success === false) {
                // Only trust messages that come from the API
                const apiMessage =
                    payload && typeof payload.message === "string"
                        ? payload.message.trim()
                        : "";

                const err = new Error(
                    apiMessage || `Payment submission failed (HTTP ${response.status})`,
                );
                err.isApiMessage = !!apiMessage;
                throw err;
            }

            const successMsg =
                (payload && typeof payload.message === "string" && payload.message) ||
                "Payment proof submitted successfully. Pending office review.";

            // Disabled controls are ignored by form.reset(), so clear manually
            resetPaymentFormFields(paymentForm);
            if (payContactInput) payContactInput.value = PH_PREFIX;

            // OK-only success dialog
            await confirm_ui(
                successMsg,
                { title: "Payment Submitted" },
                false,
                true,
                true,
            );
        } catch (error) {
            console.error("Payment submission failed:", error);

            // Show the API message if there is one, otherwise a generic message
            if (error && error.isApiMessage && error.message) {
                showAlertTOP(error.message, "error");
            } else {
                showAlertTOP("Sorry, something went wrong. Please try again.", "error");
            }
        } finally {
            // Unfreeze the form
            setPaymentBusy(paymentForm, submitBtn, false);
        }
    });
}

// One-time injection of the spinner animation used on the submit button
function injectPaymentSpinnerStyle() {
    if (document.getElementById("paymentSpinnerStyles")) return;
    const style = document.createElement("style");
    style.id = "paymentSpinnerStyles";
    style.textContent =
        "@keyframes payBtnSpin{to{transform:rotate(360deg)}}" +
        ".payBtnSpinner{" +
        "display:inline-block;width:14px;height:14px;" +
        "border:2px solid currentColor;border-top-color:transparent;" +
        "border-radius:50%;animation:payBtnSpin .8s linear infinite;" +
        "vertical-align:-2px;margin-right:6px;" +
        "}";
    document.head.appendChild(style);
}

// Clear every form control manually [works even when disabled]
function resetPaymentFormFields(form) {
    if (!form || !form.querySelectorAll) return;
    const controls = form.querySelectorAll("input, select, textarea");
    controls.forEach((el) => {
        const tag = el.tagName.toUpperCase();
        const type = (el.type || "").toLowerCase();

        if (tag === "INPUT") {
            if (type === "file") {
                try {
                    el.value = "";
                } catch (_) {
                    /* Some browsers refuse; ignore */
                }
            } else if (type === "checkbox" || type === "radio") {
                el.checked = el.defaultChecked;
            } else if (
                type === "submit" ||
                type === "button" ||
                type === "reset" ||
                type === "image"
            ) {
                /* Skip buttons */
            } else {
                el.value = el.defaultValue != null ? el.defaultValue : "";
            }
        } else if (tag === "TEXTAREA") {
            el.value = el.defaultValue != null ? el.defaultValue : "";
        } else if (tag === "SELECT") {
            const options = el.options;
            for (let i = 0; i < options.length; i++) {
                options[i].selected = options[i].defaultSelected;
            }
        }
    });
}

// Disable all controls + show spinner while submitting
function setPaymentBusy(form, submitBtn, isBusy) {
    if (form) {
        form.classList.toggle("isLoading", isBusy);
        form.setAttribute("aria-busy", String(isBusy));

        // Remember which controls were already disabled so we can restore them
        const controls = form.querySelectorAll("input, select, textarea, button");
        controls.forEach((el) => {
            if (isBusy) {
                if (el.dataset.origDisabled === undefined) {
                    el.dataset.origDisabled = el.disabled ? "1" : "0";
                }
                el.disabled = true;
            } else {
                el.disabled = el.dataset.origDisabled === "1";
                delete el.dataset.origDisabled;
            }
        });
    }

    if (submitBtn) {
        if (isBusy) {
            injectPaymentSpinnerStyle();
            if (!submitBtn.dataset.originalHtml) {
                submitBtn.dataset.originalHtml = submitBtn.innerHTML;
            }
            submitBtn.innerHTML =
                '<span class="payBtnSpinner" aria-hidden="true"></span>';
        } else if (submitBtn.dataset.originalHtml) {
            submitBtn.innerHTML = submitBtn.dataset.originalHtml;
            delete submitBtn.dataset.originalHtml;
        }
    }
}

// Office Hours Modal
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

    triggers.forEach((trigger) => {
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

    // Click on the dark background closes the modal
    if (hoursModal) {
        hoursModal.addEventListener("click", (e) => {
            if (e.target === hoursModal) closeHoursModal();
        });
    }
}

// Highlight today's row and update the Open or Closed status text
function updateCurrentDayHighlight() {
    const now = new Date();
    const day = now.getDay();
    const currentHour = now.getHours();

    document
        .querySelectorAll(".hoursItem")
        .forEach((item) => item.classList.remove("activeDay"));

    const dayElement = document.getElementById(`day_${day}`);
    if (dayElement) {
        dayElement.classList.add("activeDay");
    }

    // Mon-Sat, 8AM to 5PM
    const isOpen = day >= 1 && day <= 6 && currentHour >= 8 && currentHour < 17;
    const statusTextElements = document.querySelectorAll(".modalStatusText");

    statusTextElements.forEach((el) => {
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

// Record Details Modal
function initRecordModal() {
    const recordModal = document.getElementById("record_modal");
    const closeBtn = document.getElementById("close_modal_btn");

    if (!recordModal || !closeBtn) return;

    closeBtn.addEventListener("click", closeRecordModal);
    recordModal.addEventListener("click", (e) => {
        if (e.target === recordModal) closeRecordModal();
    });
}

// Fill in the modal with the selected record and show it
function openRecordModal(record) {
    const recordModal = document.getElementById("record_modal");
    if (!recordModal) return;

    document.getElementById("modal_name").textContent = record.name;

    const tiles = recordModal.querySelectorAll(".infoTile .tileValue");
    if (tiles[0]) tiles[0].textContent = formatDate(record.dateOfBirth);
    if (tiles[1]) tiles[1].textContent = formatDate(record.dateOfDeath);
    if (tiles[2])
        tiles[2].textContent = `Block ${record.block}, Row ${record.row}, Column ${record.column}`;
    if (tiles[3]) tiles[3].textContent = record.graveType || "N/A";

    recordModal.classList.remove("hidden");
}

function closeRecordModal() {
    const recordModal = document.getElementById("record_modal");
    if (recordModal) {
        recordModal.classList.add("hidden");
    }
}

// Global Accessibility [Esc closes modals]
function initGlobalAccessibility() {
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeHoursModal();
            closeRecordModal();
        }
    });
}