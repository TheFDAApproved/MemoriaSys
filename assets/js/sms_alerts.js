// assets/js/sms_alerts.js
// Dashboard SMS card + full-page modal for SMS automation alerts.
// - Search: auto-fetches only for 3+ chars (debounced); Enter also requires 3+
// - 1-2 char searches are rejected client-side with a warning toast —
//   the previously displayed data stays on screen.
// - The search input is NOT disabled during user-typing refreshes,
//   so focus and typed text are preserved while the fetch is in flight.
// - Uses showAlertTOP from alert.js and confirm_ui from confirm_ui.js
(function () {
  "use strict";

  const API_URL = "api/alertsms.php";
  const $ = (id) => document.getElementById(id);
  const $bulkBtn = (action) =>
    document.querySelector(`#smsBulkActions button[data-action="${action}"]`);

  function notify(message, type = "info", duration = 4000) {
    if (typeof window.showAlertTOP === "function") {
      window.showAlertTOP(message, type, duration);
    } else {
      console.log(`[${type.toUpperCase()}] ${message}`);
    }
  }

  // ============================================================
  // 1. STATE & HELPERS
  // ============================================================

  const state = {
    isOpen: false,
    isLoading: false,
    isMutating: false,
    filters: { status: "", stage: "", search: "", page: 1, per_page: 25 },
    permissions: { can_mutate: false, can_view: true, role: null },
    data: null,
    pollTimer: null,
    searchTimer: null,
  };

  let lastFocusedElement = null;
  let lastFetchError = null;

  function canAccessModal() {
    return Boolean(
      state.permissions.can_mutate || state.permissions.can_view !== false,
    );
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  // Full date + time (for "Sent At" / "Created")
  function formatDate(iso) {
    if (!iso) return "—";

    const d = new Date(iso.replace(" ", "T"));

    if (Number.isNaN(d.getTime())) return iso;

    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // Date-only formatter (for "Lease Expires")
  function formatShortDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function leaseRenewedBadge(row) {
    const snap = row.lease_expiration_date_at_send;
    const curr = row.current_lease_expiration_date;
    if (!snap || !curr || snap === curr) return "";
    return ` <span class="smsTagInfo" title="Lease renewed after this reminder was queued (now ${escapeHtml(curr)})">Renewed</span>`;
  }

  function stageLabel(stage) {
    if (stage === null || stage === undefined) return "Scheduled";
    const n = Number(stage);
    if (n === 30) return "30-day";
    if (n === 7) return "7-day";
    if (n === 0) return "Expiry day";
    if (n < 0) return "Expired";
    return n + "-day";
  }

  function statusBadge(status) {
    const cls =
      {
        Pending: "smsBadgePending",
        Sent: "smsBadgeSent",
        Failed: "smsBadgeFailed",
        Skipped: "smsBadgeSkipped",
      }[status] || "smsBadgeSkipped";
    return `<span class="smsBadge ${cls}">${escapeHtml(status)}</span>`;
  }

  function closeBulkMenu() {
    const menu = $("smsBulkMenu");
    const trigger = $("smsBulkMenuTrigger");
    if (menu) menu.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  function toggleBulkMenu(forceState) {
    const menu = $("smsBulkMenu");
    const trigger = $("smsBulkMenuTrigger");
    if (!menu || !trigger) return;
    const nextOpen = typeof forceState === "boolean" ? forceState : menu.hidden;
    menu.hidden = !nextOpen;
    trigger.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  }

  // ============================================================
  // 2. DASHBOARD CARD
  // ============================================================

  function setCardLoadingState() {
    const valueEl = $("stat_sms_alerts");
    if (valueEl && window.smsAlertsPendingCache === undefined) {
      valueEl.innerHTML = `<span class="statLoadingText" aria-hidden="true">-</span>`;
    }
    const badgeEl = $("sms_alerts_badge");
    if (badgeEl) {
      badgeEl.classList.remove("badgeWarning", "badgeSuccess", "badgeDanger");
      badgeEl.classList.add("badgeMuted");
      badgeEl.setAttribute("aria-label", "Syncing SMS status");
      badgeEl.title = "Syncing SMS status";
      badgeEl.innerHTML = `<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>`;
    }
  }

  function updateCardInteractivity() {
    const card = $("sms_alerts");
    if (!card) return;

    if (canAccessModal()) {
      card.classList.add("is-clickable");
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.title = state.permissions.can_mutate
        ? "Click to manage SMS automation queue"
        : "Click to view SMS automation queue (View only)";
    } else {
      card.classList.remove("is-clickable");
      card.removeAttribute("role");
      card.removeAttribute("tabindex");
      card.title = "SMS Automation status";
    }
  }

  async function loadSmsCard() {
    setCardLoadingState();

    try {
      const res = await fetch(API_URL + "?per_page=1", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error("Non-JSON response from " + API_URL);
      }
      if (!res.ok || json.success === false) {
        throw new Error(json.message || "HTTP " + res.status);
      }

      const data = json.data || json;
      const summary = data.summary || {};
      const byStatus = summary.by_status || {};
      const pending = Number(byStatus.Pending || 0);
      const failed = Number(byStatus.Failed || 0);
      const sent = Number(summary.sent_today || 0);
      const cap = Number(summary.daily_cap || 0);

      if (data.permissions) {
        state.permissions = data.permissions;
      }
      updateCardInteractivity();

      window.smsAlertsPendingCache = pending;

      const valueEl = $("stat_sms_alerts");
      if (valueEl) valueEl.textContent = pending;

      const badgeEl = $("sms_alerts_badge");
      if (badgeEl) {
        badgeEl.classList.remove(
          "badgeMuted",
          "badgeWarning",
          "badgeSuccess",
          "badgeDanger",
        );
        if (failed > 0) {
          badgeEl.textContent = failed + " failed";
          badgeEl.classList.add("badgeWarning");
          badgeEl.setAttribute("aria-label", `${failed} failed SMS alerts`);
        } else if (pending > 0) {
          badgeEl.textContent = "Pending";
          badgeEl.classList.add("badgeMuted");
          badgeEl.setAttribute("aria-label", `${pending} pending SMS alerts`);
        } else {
          badgeEl.textContent = "All clear";
          badgeEl.classList.add("badgeSuccess");
          badgeEl.setAttribute("aria-label", "All SMS alerts clear");
        }
        if (cap > 0) {
          badgeEl.title = `${sent} sent today / ${cap} daily cap`;
        }
      }
    } catch (err) {
      console.error("SMS card fetch failed:", err);
      window.smsAlertsPendingCache = null;

      const valueEl = $("stat_sms_alerts");
      if (valueEl) valueEl.textContent = "—";

      const badgeEl = $("sms_alerts_badge");
      if (badgeEl) {
        badgeEl.textContent = "Unavailable";
        badgeEl.classList.remove("badgeMuted", "badgeWarning", "badgeSuccess");
        badgeEl.classList.add("badgeDanger");
        badgeEl.setAttribute("aria-label", "SMS status unavailable");
      }
    }
  }

  // ============================================================
  // 3. MODAL RENDER & LOADING STATES
  // ============================================================

  function buildSkeletonRows(canMutate, rowCount = 6) {
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const actionCell = canMutate
        ? `<td class="col-actions smsActionsCol"><div class="skeletonBlock smsSkeletonCellBar" style="width: 100px;"></div></td>`
        : "";
      rows.push(`
        <tr class="smsSkeletonRow" aria-hidden="true">
          <td class="col-deceased"><div class="skeletonBlock smsSkeletonCellBar" style="width: 78%;"></div></td>
          <td class="col-lease smsColHideTablet"><div class="skeletonBlock smsSkeletonCellBar" style="width: 65%;"></div></td>
          <td class="col-recipient"><div class="skeletonBlock smsSkeletonCellBar" style="width: 72%;"></div></td>
          <td class="col-phone"><div class="skeletonBlock smsSkeletonCellBar" style="width: 82%;"></div></td>
          <td class="col-stage"><div class="skeletonBlock smsSkeletonCellBar" style="width: 58%;"></div></td>
          <td class="col-status"><div class="skeletonBlock smsSkeletonPill"></div></td>
          <td class="col-attempts"><div class="skeletonBlock smsSkeletonCellBar" style="width: 36%;"></div></td>
          <td class="col-created"><div class="skeletonBlock smsSkeletonCellBar" style="width: 70%;"></div></td>
          <td class="col-sent"><div class="skeletonBlock smsSkeletonCellBar" style="width: 70%;"></div></td>
          ${actionCell}
        </tr>
      `);
    }
    return rows.join("");
  }

  function setModalLoading(isLoading, options = {}) {
    const { keepInputs = false } = options;
    state.isLoading = isLoading;

    const refreshBtn = $("smsModalRefresh");
    if (refreshBtn) {
      refreshBtn.disabled = isLoading;
      const icon = refreshBtn.querySelector("i");
      if (icon) icon.classList.toggle("fa-spin", isLoading);
    }

    const isInitialLoad = !state.data;

    // Disable toolbar inputs ONLY during initial full-modal load
    if (!keepInputs && isInitialLoad) {
      const statusSelect = $("smsStatusFilter");
      if (statusSelect) statusSelect.disabled = isLoading;

      const stageSelect = $("smsStageFilter");
      if (stageSelect) stageSelect.disabled = isLoading;

      const searchInput = $("smsSearchInput");
      if (searchInput) searchInput.disabled = isLoading;

      const clearBtn = $("smsSearchClear");
      if (clearBtn) clearBtn.disabled = isLoading;
    } else if (!isLoading) {
      const statusSelect = $("smsStatusFilter");
      if (statusSelect) statusSelect.disabled = false;

      const stageSelect = $("smsStageFilter");
      if (stageSelect) stageSelect.disabled = false;

      const searchInput = $("smsSearchInput");
      if (searchInput) searchInput.disabled = false;

      const clearBtn = $("smsSearchClear");
      if (clearBtn) clearBtn.disabled = false;
    }

    const tableWrap = $("smsTableWrap");
    const viewport = $("smsTableViewport");

    if (state.data) {
      if (tableWrap) tableWrap.classList.toggle("is-loading", isLoading);
      if (viewport) viewport.classList.toggle("is-refreshing", isLoading);
    } else if (isLoading) {
      if (viewport) viewport.classList.remove("is-refreshing");
      const tbody = $("smsTableBody");
      if (tbody) {
        tbody.innerHTML = buildSkeletonRows(state.permissions.can_mutate, 6);
      }
    }
  }

  function renderSummary() {
    const s = state.data?.summary || {};
    const by = s.by_status || {};
    const pending = Number(by.Pending || 0);
    const failed = Number(by.Failed || 0);
    const skipped = Number(by.Skipped || 0);

    $("sms_sum_pending").textContent = pending;
    $("sms_sum_sent").textContent = Number(s.sent_today || 0);
    $("sms_sum_sent_sub").textContent = `of ${s.daily_cap || 0} daily cap`;
    $("sms_sum_failed").textContent = failed;
    $("sms_sum_skipped").textContent = skipped;

    const runNowCount = $("smsRunNowCount");
    if (runNowCount) runNowCount.textContent = pending;

    const retryFailedCount = $("smsRetryFailedCount");
    if (retryFailedCount) retryFailedCount.textContent = failed;

    const retrySkippedCount = $("smsRetrySkippedCount");
    if (retrySkippedCount) retrySkippedCount.textContent = skipped;

    const abortPendingCount = $("smsAbortPendingCount");
    if (abortPendingCount) abortPendingCount.textContent = pending;

    document
      .querySelectorAll(".smsSummaryTile[data-filter-status]")
      .forEach((tile) => {
        const isActive =
          state.filters.status !== "" &&
          tile.dataset.filterStatus === state.filters.status;
        tile.classList.toggle("is-active", isActive);
        tile.setAttribute("aria-pressed", isActive ? "true" : "false");
      });

    const statusSelect = $("smsStatusFilter");
    if (statusSelect && statusSelect.value !== state.filters.status) {
      statusSelect.value = state.filters.status;
    }

    // Disable bulk action buttons when there's nothing for them to do
    if (!state.isMutating) {
      const abortBtn = $bulkBtn("cancel_all_pending");
      if (abortBtn) {
        abortBtn.disabled = pending === 0;
        abortBtn.title =
          pending === 0
            ? "No pending SMS in queue to abort"
            : `Cancel all ${pending} pending SMS in queue`;
      }

      const retryFailedBtn = $bulkBtn("retry_all_failed");
      if (retryFailedBtn) {
        retryFailedBtn.disabled = failed === 0;
        retryFailedBtn.title =
          failed === 0
            ? "No failed SMS to retry"
            : `Re-queue all ${failed} failed SMS`;
      }

      const retrySkippedBtn = $bulkBtn("retry_all_skipped");
      if (retrySkippedBtn) {
        retrySkippedBtn.disabled = skipped === 0;
        retrySkippedBtn.title =
          skipped === 0
            ? "No skipped SMS to retry"
            : `Re-queue all ${skipped} skipped SMS`;
      }

      const runNowBtn = $bulkBtn("run_now");
      if (runNowBtn) {
        runNowBtn.disabled = pending === 0;
        runNowBtn.title =
          pending === 0
            ? "No pending SMS to send"
            : `Dispatch ${pending} pending SMS now`;
      }
    }

    const autoSendEnabled = s.auto_send_enabled !== false;
    const banner = $("smsAutoSendBanner");
    if (banner) {
      banner.style.display = autoSendEnabled ? "none" : "";
    }
  }

  function hasActiveFilters() {
    return Boolean(
      state.filters.status !== "" ||
      state.filters.stage !== "" ||
      state.filters.search !== "",
    );
  }

  function renderTable() {
    const tbody = $("smsTableBody");
    if (!tbody) return;

    const canMutate = Boolean(state.permissions.can_mutate);
    const colSpan = canMutate ? 10 : 9;

    // 1. Fetch Error State
    if (lastFetchError) {
      tbody.innerHTML = `
        <tr>
          <td colspan="${colSpan}" class="smsTableStateCell">
            <div class="smsStateCard smsStateError" role="alert">
              <div class="smsStateIcon" aria-hidden="true">
                <i class="fas fa-exclamation-triangle"></i>
              </div>
              <h3 class="smsStateTitle">Unable to load SMS notifications</h3>
              <p class="smsStateSub">${escapeHtml(lastFetchError)}</p>
              <button type="button" class="smsBtn smsBtnSecondary" data-state-action="retry-fetch">
                <i class="fas fa-redo-alt" aria-hidden="true"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    const rows = state.data?.rows || [];

    // 2. Empty States
    if (rows.length === 0) {
      if (hasActiveFilters()) {
        tbody.innerHTML = `
          <tr>
            <td colspan="${colSpan}" class="smsTableStateCell">
              <div class="smsStateCard smsStateFilteredEmpty">
                <div class="smsStateIcon" aria-hidden="true">
                  <i class="fas fa-filter"></i>
                </div>
                <h3 class="smsStateTitle">No notifications match your filters</h3>
                <p class="smsStateSub">Try adjusting your status, reminder stage, or search query.</p>
                <button type="button" class="smsBtn smsBtnSecondary" data-state-action="clear-filters">
                  <i class="fas fa-times" aria-hidden="true"></i>
                  <span>Clear filters</span>
                </button>
              </div>
            </td>
          </tr>
        `;
      } else {
        tbody.innerHTML = `
          <tr>
            <td colspan="${colSpan}" class="smsTableStateCell">
              <div class="smsStateCard smsStateZeroEmpty">
                <div class="smsStateIcon" aria-hidden="true">
                  <i class="fas fa-bell-slash"></i>
                </div>
                <h3 class="smsStateTitle">No SMS notifications yet</h3>
                <p class="smsStateSub">Reminders will appear here when leases approach expiry.</p>
              </div>
            </td>
          </tr>
        `;
      }
      return;
    }

    // 3. Populated Rows
    // Must match <thead>:
    // Deceased | Lease Expires | Recipient | Phone | Stage | Status | Attempts | Created | Sent | Actions
    tbody.innerHTML = rows
      .map((r) => {
        const rowId = String(r.notification_id);
        const attemptsVal = Number(r.attempt_count || 0);

        const createdAtVal = r.updated_at ? formatDate(r.updated_at) : "—";
        const sentAtVal = r.sent_at ? formatDate(r.sent_at) : "—";
        const deceasedVal = escapeHtml(r.deceased_name || "—");
        const recipientVal = escapeHtml(r.recipient_name || "—");
        const phoneVal = escapeHtml(r.recipient_phone_number || "—");

        let actionsCell = "";
        if (canMutate) {
          const canRetry = r.status === "Failed" || r.status === "Skipped";
          const canAbort = r.status === "Pending" || r.status === "Failed";

          let slotsHtml = "";
          if (!canRetry && !canAbort) {
            slotsHtml = `<span class="smsRowNoAction" title="No actions available for sent SMS">—</span>`;
          } else {
            const retrySlot = canRetry
              ? `<button type="button" class="smsRowBtn smsRowBtnPrimary" data-action="retry" data-id="${escapeHtml(rowId)}" title="Retry sending this SMS">
                  <i class="fas fa-redo-alt" aria-hidden="true"></i>
                </button>`
              : "";

            const abortSlot = canAbort
              ? `<button type="button" class="smsRowBtn smsRowBtnAbort" data-action="cancel" data-id="${escapeHtml(rowId)}" title="Abort this SMS notification">
                  <i class="fas fa-times" aria-hidden="true"></i>
                </button>`
              : "";

            slotsHtml = retrySlot + abortSlot;
          }

          actionsCell = `
            <td class="col-actions smsActionsCol" data-label="Actions">
              <div class="smsRowActionSlots">${slotsHtml}</div>
            </td>
          `;
        }

        return `
          <tr class="smsDataRow" data-row-id="${escapeHtml(rowId)}">
            <td class="col-deceased smsCellPrimary" data-label="Deceased" title="${deceasedVal}">${deceasedVal}</td>
            <td class="col-lease smsColHideTablet" data-label="Lease Expires">${formatShortDate(r.lease_expiration_date_at_send)}${leaseRenewedBadge(r)}</td>
            <td class="col-recipient" data-label="Recipient" title="${recipientVal}">${recipientVal}</td>
            <td class="col-phone smsCellMono" data-label="Phone" title="${phoneVal}">${phoneVal}</td>
            <td class="col-stage" data-label="Stage"><span class="smsStagePill">${stageLabel(r.days_before_expiry)}</span></td>
            <td class="col-status" data-label="Status">${statusBadge(r.status)}</td>
            <td class="col-attempts smsCellMono" data-label="Attempts">${attemptsVal} / 3</td>
            <td class="col-created" data-label="Created">${createdAtVal}</td>
            <td class="col-sent" data-label="Sent">${sentAtVal}</td>
            ${actionsCell}
          </tr>
        `;
      })
      .join("");
  }

  function renderPagination() {
    const p = state.data?.pagination || {};
    const page = p.page || 1;
    const pages = p.pages || 1;
    const total = p.total || 0;

    $("smsPageInfo").textContent = `Page ${page} of ${pages} (${total} total)`;
    $("smsPrevPage").disabled = page <= 1 || state.isLoading;
    $("smsNextPage").disabled = page >= pages || state.isLoading;
  }

  function applyPermissions() {
    const canMutate = Boolean(state.permissions.can_mutate);
    const bulk = $("smsBulkActions");
    if (bulk) bulk.style.display = canMutate ? "flex" : "none";

    const viewOnlyPill = $("smsViewOnlyPill");
    if (viewOnlyPill) viewOnlyPill.hidden = canMutate;

    const actionsHeader = $("smsActionsHeader");
    if (actionsHeader) actionsHeader.style.display = canMutate ? "" : "none";

    updateCardInteractivity();
  }

  function resetAllFilters() {
    state.filters.status = "";
    state.filters.stage = "";
    state.filters.search = "";
    state.filters.page = 1;

    const searchInput = $("smsSearchInput");
    if (searchInput) searchInput.value = "";
    const clearBtn = $("smsSearchClear");
    if (clearBtn) clearBtn.hidden = true;

    const statusSelect = $("smsStatusFilter");
    if (statusSelect) statusSelect.value = "";

    const stageSelect = $("smsStageFilter");
    if (stageSelect) stageSelect.value = "";
  }

  // ============================================================
  // 4. MODAL DATA & MUTATIONS
  // ============================================================

  async function refresh(options = {}) {
    const { silent = false, keepInputs = false } = options;

    if (state.filters.search !== "" && state.filters.search.length < 3) {
      notify(
        "Please type at least 3 characters to search, or clear the field to show all.",
        "warning",
      );
      return;
    }

    if (!silent) setModalLoading(true, { keepInputs });

    try {
      const params = new URLSearchParams();
      if (state.filters.status) params.set("status", state.filters.status);
      if (state.filters.stage !== "") params.set("stage", state.filters.stage);
      if (state.filters.search) params.set("search_term", state.filters.search);

      params.set("page", state.filters.page);
      params.set("per_page", state.filters.per_page);

      const res = await fetch(API_URL + "?" + params.toString(), {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error("Non-JSON response");
      }
      if (!res.ok || json.success === false) {
        throw new Error(json.message || json.error || "HTTP " + res.status);
      }

      lastFetchError = null;
      state.data = json.data || {};
      state.permissions = state.data.permissions || {
        can_mutate: false,
        can_view: true,
      };

      applyPermissions();
      renderSummary();
      renderTable();
      renderPagination();
      schedulePoll();
    } catch (err) {
      lastFetchError = err.message || "Failed to load notifications.";
      renderTable();
      notify("Failed to load SMS alerts: " + err.message, "error");
    } finally {
      setModalLoading(false, { keepInputs });
      renderPagination();
    }
  }

  async function postAction(
    payload,
    triggerBtn = null,
    loadingLabel = "Processing…",
  ) {
    if (state.isMutating) return false;
    state.isMutating = true;
    closeBulkMenu();

    let originalHtml = "";
    if (triggerBtn) {
      originalHtml = triggerBtn.innerHTML;
      triggerBtn.disabled = true;
      triggerBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> <span>${escapeHtml(loadingLabel)}</span>`;
    }

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) {
        notify(json.message || json.error || "Action failed", "error");
        return false;
      }
      notify(json.message || "Action completed successfully", "success");
      await refresh();
      loadSmsCard();
      return true;
    } catch (err) {
      notify("Network error: " + err.message, "error");
      return false;
    } finally {
      state.isMutating = false;
      if (triggerBtn) {
        triggerBtn.innerHTML = originalHtml;
        triggerBtn.disabled = false;
      }
      renderSummary();
    }
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (!state.isOpen) return;
    const pending = state.data?.summary?.by_status?.Pending || 0;
    if (pending === 0) return;
    state.pollTimer = setTimeout(() => refresh({ silent: true }), 5000);
  }

  // ============================================================
  // 5. MODAL OPEN / CLOSE & FOCUS MANAGEMENT
  // ============================================================

  function trapFocus(e) {
    if (!state.isOpen || e.key !== "Tab") return;
    const modal = $("smsAlertsModal");
    if (!modal) return;

    const focusableSelectors = [
      "button:not([disabled]):not([hidden])",
      "input:not([disabled]):not([hidden])",
      "select:not([disabled]):not([hidden])",
      '[tabindex]:not([tabindex="-1"]):not([disabled]):not([hidden])',
    ].join(",");

    const allFocusable = Array.from(
      modal.querySelectorAll(focusableSelectors),
    ).filter((el) => el.offsetParent !== null);

    if (allFocusable.length === 0) return;

    const first = allFocusable[0];
    const last = allFocusable[allFocusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function open() {
    if (!canAccessModal()) return;
    if (state.isOpen) return;

    lastFocusedElement = document.activeElement || $("sms_alerts");
    state.isOpen = true;
    closeBulkMenu();

    const modal = $("smsAlertsModal");
    if (!modal) return;

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    resetAllFilters();
    state.filters.per_page = 25;

    refresh();
  }

  function close() {
    if (!state.isOpen) return;
    state.isOpen = false;
    closeBulkMenu();

    const modal = $("smsAlertsModal");
    if (modal) {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "";
    clearTimeout(state.pollTimer);
    window.dispatchEvent(new Event("sms:changed"));

    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
      lastFocusedElement.focus();
    }
  }

  // ============================================================
  // 6. EVENT BINDINGS
  // ============================================================

  function bindCard() {
    const card = $("sms_alerts");
    if (!card) return;

    card.addEventListener("click", () => {
      if (!canAccessModal()) return;
      open();
    });

    card.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && canAccessModal()) {
        e.preventDefault();
        open();
      }
    });
  }

  function bindModal() {
    const modal = $("smsAlertsModal");
    if (!modal) return;

    modal.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1") {
        close();
        return;
      }

      const dropdown = $("smsBulkDropdown");
      if (dropdown && !dropdown.contains(e.target)) {
        closeBulkMenu();
      }
    });

    $("smsModalClose")?.addEventListener("click", close);
    $("smsModalRefresh")?.addEventListener("click", () => {
      refresh();
    });

    $("smsBulkMenuTrigger")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBulkMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (!state.isOpen) return;

      if (e.key === "Escape") {
        const menu = $("smsBulkMenu");
        if (menu && !menu.hidden) {
          e.stopPropagation();
          closeBulkMenu();
          $("smsBulkMenuTrigger")?.focus();
          return;
        }
        close();
        return;
      }

      trapFocus(e);
    });

    document
      .querySelectorAll(".smsSummaryTile[data-filter-status]")
      .forEach((tile) => {
        tile.addEventListener("click", () => {
          const targetStatus = tile.dataset.filterStatus || "";
          const nextStatus =
            state.filters.status === targetStatus ? "" : targetStatus;
          state.filters.status = nextStatus;
          state.filters.page = 1;

          const statusSelect = $("smsStatusFilter");
          if (statusSelect) statusSelect.value = nextStatus;

          refresh({ keepInputs: true });
        });
      });

    $("smsStatusFilter")?.addEventListener("change", (e) => {
      state.filters.status = e.target.value || "";
      state.filters.page = 1;
      refresh({ keepInputs: true });
    });

    $("smsStageFilter")?.addEventListener("change", (e) => {
      state.filters.stage = e.target.value;
      state.filters.page = 1;
      refresh({ keepInputs: true });
    });

    const searchInput = $("smsSearchInput");
    const clearBtn = $("smsSearchClear");

    searchInput?.addEventListener("input", (e) => {
      const val = e.target.value;
      if (clearBtn) clearBtn.hidden = val.length === 0;

      clearTimeout(state.searchTimer);

      const trimmed = val.trim();
      const len = trimmed.length;

      if (trimmed === state.filters.search) return;

      if (len > 0 && len < 3) return;

      state.searchTimer = setTimeout(() => {
        state.filters.search = trimmed;
        state.filters.page = 1;
        refresh({ keepInputs: true });
      }, 300);
    });

    searchInput?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();

      clearTimeout(state.searchTimer);

      const trimmed = e.target.value.trim();

      if (trimmed.length > 0 && trimmed.length < 3) {
        notify(
          "Please type at least 3 characters to search, or clear the field to show all.",
          "warning",
        );
        return;
      }

      if (trimmed === state.filters.search) return;

      state.filters.search = trimmed;
      state.filters.page = 1;
      refresh({ keepInputs: true });
    });

    clearBtn?.addEventListener("click", () => {
      if (!searchInput) return;
      searchInput.value = "";
      clearBtn.hidden = true;
      searchInput.focus();

      clearTimeout(state.searchTimer);
      if (state.filters.search !== "") {
        state.filters.search = "";
        state.filters.page = 1;
        refresh({ keepInputs: true });
      }
    });

    $("smsBulkActions")?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn || btn.disabled) return;

      const action = btn.dataset.action;
      closeBulkMenu();

      if (action === "run_now") {
        await postAction({ action: "run_now" }, btn, "Sending…");
      } else if (action === "cancel_all_pending") {
        const pending = state.data?.summary?.by_status?.Pending || 0;
        if (pending === 0) {
          notify("No pending SMS in queue to abort.", "info");
          return;
        }
        const confirmed = await confirm_ui(
          `Abort ${pending} pending SMS? They will NOT be sent.`,
          { title: "Abort Queue", danger: true, confirmText: "Yes, Abort" },
        );
        if (!confirmed) return;
        await postAction({ action: "cancel_all_pending" }, btn, "Aborting…");
      } else if (action === "retry_all_failed") {
        const failed = state.data?.summary?.by_status?.Failed || 0;
        if (failed === 0) {
          notify("No failed SMS to retry.", "info");
          return;
        }
        const confirmed = await confirm_ui(`Retry all ${failed} failed SMS?`, {
          title: "Retry Failed",
          confirmText: "Yes, Retry",
        });
        if (!confirmed) return;
        await postAction({ action: "retry_all_failed" }, btn, "Retrying…");
      } else if (action === "retry_all_skipped") {
        const skipped = state.data?.summary?.by_status?.Skipped || 0;
        if (skipped === 0) {
          notify("No aborted SMS to retry.", "info");
          return;
        }
        const confirmed = await confirm_ui(
          `Retry all ${skipped} aborted SMS? They will be queued again.`,
          { title: "Retry Aborted", confirmText: "Yes, Retry" },
        );
        if (!confirmed) return;
        await postAction({ action: "retry_all_skipped" }, btn, "Retrying…");
      }
    });

    $("smsTableBody")?.addEventListener("click", async (e) => {
      const stateBtn = e.target.closest("button[data-state-action]");
      if (stateBtn) {
        const stateAction = stateBtn.dataset.stateAction;
        if (stateAction === "clear-filters") {
          resetAllFilters();
          refresh({ keepInputs: true });
        } else if (stateAction === "retry-fetch") {
          refresh();
        }
        return;
      }

      const btn = e.target.closest("button[data-action]");
      if (!btn || btn.disabled) return;

      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === "cancel") {
        const confirmed = await confirm_ui("Abort this SMS notification?", {
          title: "Abort SMS",
          danger: true,
          confirmText: "Yes, Abort",
        });
        if (!confirmed) return;
        await postAction(
          { action: "cancel", notification_id: id },
          btn,
          "Aborting…",
        );
      } else if (action === "retry") {
        await postAction(
          { action: "retry", notification_id: id },
          btn,
          "Retrying…",
        );
      }
    });

    $("smsPrevPage")?.addEventListener("click", () => {
      if (state.filters.page > 1 && !state.isLoading) {
        state.filters.page--;
        refresh({ keepInputs: true });
      }
    });
    $("smsNextPage")?.addEventListener("click", () => {
      if (!state.isLoading) {
        state.filters.page++;
        refresh({ keepInputs: true });
      }
    });
  }

  // ============================================================
  // 7. INIT
  // ============================================================

  function init() {
    bindCard();
    bindModal();
    loadSmsCard();
  }

  document.addEventListener("DOMContentLoaded", init);

  window.addEventListener("sms:changed", loadSmsCard);
  window.addEventListener("dashboard:invalidated", loadSmsCard);

  window.openSmsAlertsModal = open;
  window.closeSmsAlertsModal = close;
  window.refreshSmsCard = loadSmsCard;
})();
