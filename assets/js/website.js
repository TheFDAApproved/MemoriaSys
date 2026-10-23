const PH_PREFIX = "+63 ";
const SEARCH_MIN_DELAY_MS = 700;
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

function handleHashChange() {
  const hash = window.location.hash.replace("#", "") || "home";
  showView(hash);
}

function initNavigation() {
  handleHashChange();
  window.addEventListener("hashchange", handleHashChange);
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

  nav.querySelectorAll(".navLink").forEach((link) => {
    link.addEventListener("click", closeNav);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) closeNav();
  });

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
  cemeteryMapBtns.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      window.location.hash = "#map";
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

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
  const submitBtn =
    searchForm?.querySelector(
      'button[type="submit"], .searchBtn, input[type="submit"]',
    ) || searchForm?.querySelector("button");

  if (!searchForm || !recordsGrid || !searchInput) return;

  initSearchClearButton({ searchForm, searchInput, recordsGrid, submitBtn });

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();

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

function ensureMinimumDelay(startedAt, minMs) {
  const elapsed = Date.now() - startedAt;
  const remaining = minMs - elapsed;
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, remaining));
}

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

  const syncVisibility = () => {
    const hasText = searchInput.value.length > 0;
    clearBtn.style.display = hasText ? "block" : "none";
    searchInput.style.paddingRight = hasText ? "44px" : "";
  };

  searchInput.addEventListener("input", syncVisibility);

  clearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    searchRequestId++;

    searchInput.value = "";
    syncVisibility();
    searchInput.focus();

    if (recordsGrid) recordsGrid.innerHTML = "";
    setSearchBusy(searchForm, submitBtn, false);
  });

  syncVisibility();
}

function setSearchBusy(form, submitBtn, isBusy) {
  if (form) {
    form.classList.toggle("isLoading", isBusy);
    form.setAttribute("aria-busy", String(isBusy));
  }
  if (submitBtn) {
    submitBtn.disabled = isBusy;
  }
}

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

function renderNoResults(query, container) {
  container.innerHTML = "";
  const emptyMsg = document.createElement("p");
  emptyMsg.className = "emptySearchMessage";
  emptyMsg.textContent = `No records found for "${query}".`;
  container.appendChild(emptyMsg);
}

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

  [payNameInput, payDeceasedNameInput].forEach((input) => {
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

    payContactInput.addEventListener("keypress", (e) => {
      const allowed = /[0-9+\s]/;
      if (!allowed.test(e.key) && e.key.length === 1) {
        e.preventDefault();
      }
    });

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

  paymentForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (paymentForm.classList.contains("isLoading")) return;

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

    // Disable every input + show spinner on the button.
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
      } catch (_) {}

      if (!response.ok || !payload || payload.success === false) {
        // If the API returned a usable message, treat it as user-facing.
        const apiMessage =
          payload && typeof payload.message === "string"
            ? payload.message.trim()
            : "";

        const err = new Error(
          apiMessage || `Payment submission failed (HTTP ${response.status})`,
        );
        // Only API-provided messages may be shown in the UI.
        err.isApiMessage = !!apiMessage;
        throw err;
      }

      const successMsg =
        (payload && typeof payload.message === "string" && payload.message) ||
        "Payment proof submitted successfully. Pending office review.";

      // Disabled controls are ignored by form.reset(), so clear fields
      // manually to keep the form frozen while the dialog is up.
      resetPaymentFormFields(paymentForm);
      if (payContactInput) payContactInput.value = PH_PREFIX;

      // Success: OK-only dialog that can only be dismissed by tapping the
      // button (no cancel, no backdrop, no Esc).
      await confirm_ui(
        successMsg,
        { title: "Payment Submitted" },
        false,
        true,
        true,
      );
    } catch (error) {
      // Real error stays in the console for debugging.
      console.error("Payment submission failed:", error);

      // Show the API's message when it provided one; otherwise fall back
      // to a generic message so raw JS / network errors never leak.
      if (error && error.isApiMessage && error.message) {
        showAlertTOP(error.message, "error");
      } else {
        showAlertTOP("Sorry, something went wrong. Please try again.", "error");
      }
    } finally {
      // Re-enable inputs and restore the original button markup.
      setPaymentBusy(paymentForm, submitBtn, false);
    }
  });
}

// One-time injection for the submit-button spinner.
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

// Clears every form control. Mirrors native form.reset(), but works even
// when the controls are disabled (native reset skips disabled controls).
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
          /* some browsers refuse; ignore */
        }
      } else if (type === "checkbox" || type === "radio") {
        el.checked = el.defaultChecked;
      } else if (
        type === "submit" ||
        type === "button" ||
        type === "reset" ||
        type === "image"
      ) {
        /* skip buttons */
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

function setPaymentBusy(form, submitBtn, isBusy) {
  if (form) {
    form.classList.toggle("isLoading", isBusy);
    form.setAttribute("aria-busy", String(isBusy));

    // Disable every form control while submitting (inputs, selects,
    // textareas, buttons). Remember which ones were already disabled so
    // we can restore them faithfully.
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

  document
    .querySelectorAll(".hoursItem")
    .forEach((item) => item.classList.remove("activeDay"));

  const dayElement = document.getElementById(`day_${day}`);
  if (dayElement) {
    dayElement.classList.add("activeDay");
  }

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

function initGlobalAccessibility() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeHoursModal();
      closeRecordModal();
    }
  });
}
