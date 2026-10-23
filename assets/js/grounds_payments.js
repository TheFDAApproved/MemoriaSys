/**
 * grounds-payments.js
 *
 * Grounds Staff view of the Payments page.
 */
(() => {
  "use strict";

  const API_URL = "api/payments.php";
  const PER_PAGE = 10;
  const SEARCH_MIN_LEN = 3;
  const SEARCH_DEBOUNCE_MS = 350;
  const REQUEST_TIMEOUT_MS = 30000;
  const REMARK_MAX_LEN = 2000;
  const SEARCH_PLACEHOLDER = "Search...";

  const TABS = {
    pending_grounds: {
      key: "pending_grounds",
      status: "pending_grounds",
      canConfirm: true,
      confirmAction: "confirm_grounds",
      confirmPrompt: {
        title: "Confirm Grounds Completion?",
        message:
          'Mark the grounds work for this payment as completed? It will move to "Verified".',
        confirmText: "Confirm",
      },
    },
    pending_office: {
      key: "pending_office",
      status: "pending_office",
      canConfirm: false,
    },
    verified: {
      key: "verified",
      status: "verified",
      canConfirm: false,
      canUndo: true,
      undoAction: "unconfirm_grounds",
      undoPrompt: {
        title: "Undo Grounds Verification?",
        message:
          'Revert this payment back to "Pending – Grounds"? The office verification stays intact.',
        confirmText: "Undo",
        danger: true,
      },
    },
  };

  const state = {
    activeTab: "pending_grounds",
    page: 1,
    totalPages: 1,
    totalRecords: 0,
    search: "",
    loading: false,
    requestId: 0,
    remarksModal: null,
    proofModal: null,
    editingSection: null,
  };

  const el = {
    tabButtons: document.querySelectorAll(".subnavBtn[data-tab]"),
    search: document.getElementById("payment_search"),
    tbody: document.getElementById("payments_tbody"),
    noData: document.getElementById("no_data"),
    tableWrapper: document.getElementById("table_wrapper"),
    currentPage: document.getElementById("current_page_num"),
    totalPages: document.getElementById("total_pages_num"),
    totalRecords: document.getElementById("total_records"),
    prevBtn: document.getElementById("prev_page_btn"),
    nextBtn: document.getElementById("next_page_btn"),
    carouselTrack: document.getElementById("carousel_track"),
  };

  if (!el.tbody) return;

  const escapeHtml = (value) => {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  const formatMoney = (value) => {
    const n = Number(value) || 0;
    try {
      return n.toLocaleString("en-PH", { style: "currency", currency: "PHP" });
    } catch (_) {
      return "\u20B1" + n.toFixed(2);
    }
  };

  const truncate = (text, max) => {
    const s = String(text || "");
    return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
  };

  const friendlyMessage = (err, fallback) => {
    if (!err) return fallback || "Something went wrong.";
    const msg = err.message ? String(err.message).trim() : String(err).trim();
    if (!msg || msg.length > 200) return fallback || "Something went wrong.";
    return msg;
  };

  const notify = (message, type) => {
    try {
      if (typeof window.showAlertTOP === "function") {
        window.showAlertTOP(message, type);
        return;
      }
    } catch (_) {}
    type === "error" ? console.error(message) : console.log(message);
  };

  const debounce = (fn, wait) => {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  const isAbortError = (err) => !!(err && err.name === "AbortError");
  const unwrap = (json) =>
    (json && (json.data !== undefined ? json.data : json)) || {};

  async function fetchWithTimeout(url, options, ms) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ms || REQUEST_TIMEOUT_MS,
    );
    try {
      return await fetch(
        url,
        Object.assign({}, options || {}, { signal: controller.signal }),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function askConfirm(message, opts) {
    if (typeof window.confirm_ui === "function") {
      return !!(await window.confirm_ui(message, opts));
    }
    return window.confirm(message);
  }

  function currentTabCanConfirm() {
    return !!(TABS[state.activeTab] && TABS[state.activeTab].canConfirm);
  }

  function currentTabCanUndo() {
    return !!(TABS[state.activeTab] && TABS[state.activeTab].canUndo);
  }

  function canEditRemark(type) {
    return type === "grounds";
  }

  function enterRowBusy(btn) {
    if (!btn) return function noop() {};
    const row = btn.closest("tr");
    const group = btn.closest(".pmActionGroup");

    if (row) {
      row.classList.add("pmRowBusy");
      row.setAttribute("inert", "");
      row.setAttribute("aria-busy", "true");
    }

    if (!group) {
      const originalHtml = btn.innerHTML;
      const wasDisabled = btn.disabled;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      return function restore() {
        btn.innerHTML = originalHtml;
        btn.disabled = wasDisabled;
        if (row) {
          row.classList.remove("pmRowBusy");
          row.removeAttribute("inert");
          row.removeAttribute("aria-busy");
        }
      };
    }

    const buttons = Array.from(group.querySelectorAll("button"));
    const snapshot = buttons.map((b) => ({
      html: b.innerHTML,
      disabled: b.disabled,
    }));

    buttons.forEach((b) => {
      b.disabled = true;
    });
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    return function restore() {
      buttons.forEach((b, i) => {
        if (!snapshot[i]) return;
        b.innerHTML = snapshot[i].html;
        b.disabled = snapshot[i].disabled;
      });
      if (row) {
        row.classList.remove("pmRowBusy");
        row.removeAttribute("inert");
        row.removeAttribute("aria-busy");
      }
    };
  }

  function injectStyles() {
    if (document.getElementById("groundsPaymentsStyles")) return;
    const style = document.createElement("style");
    style.id = "groundsPaymentsStyles";
    style.textContent = `
      .pmStatusBadge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; line-height: 1; white-space: nowrap; border: 1px solid transparent; vertical-align: middle; }
      .pmStatusBadge i { font-size: 11px; }
      .pmStatus--pendingOffice { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
      .pmStatus--pendingGrounds { background: #ffedd5; color: #9a3412; border-color: #fed7aa; }
      .pmStatus--completed { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
      .pmActionGroup { display: inline-flex; align-items: center; gap: 6px; flex-wrap: nowrap; white-space: nowrap; line-height: 1; }
      .pmActionBtn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; margin: 0; font-size: 13px; font-family: inherit; color: #606770; background: transparent; border: 1px solid transparent; border-radius: 8px; cursor: pointer; flex: 0 0 auto; transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease; }
      .pmActionBtn i { line-height: 1; pointer-events: none; }
      .pmActionBtn:hover { background: #f8fafc; border-color: #e5e7eb; color: #1c1e21; }
      .pmActionBtn:active { transform: translateY(1px); }
      .pmActionBtn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.15); }
      .pmActionBtn--verify:hover, .pmActionBtn--verify:focus-visible { background: #eff6ff; border-color: #dbeafe; color: #2563eb; }
      .pmActionBtn--unverify:hover, .pmActionBtn--unverify:focus-visible { background: #fff7ed; border-color: #fed7aa; color: #d97706; }
      tr.pmRowBusy { opacity: 0.55; cursor: progress; user-select: none; transition: opacity 0.15s ease; }
      tr.pmRowBusy .pmActionGroup, tr.pmRowBusy .pmRemarksCell, tr.pmRowBusy .pmProofCell, tr.pmRowBusy .smsPhoneLink { pointer-events: none; }
      tr.pmRowBusy .pmActionBtn { cursor: progress; }
      .pmVerifiedPill { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 8px; font-size: 12.5px; font-weight: 600; line-height: 1; white-space: nowrap; background: #16a34a; color: #ffffff; cursor: default; user-select: none; flex: 0 0 auto; vertical-align: middle; border: 1px solid #16a34a; }
      .pmVerifiedPill i { font-size: 13px; line-height: 1; }
      .pmProofCell { display: inline-flex; align-items: center; justify-content: center; width: 60px; height: 60px; border-radius: 6px; overflow: hidden; cursor: pointer; background: #f1f5f9; border: 1px solid #e5e7eb; position: relative; vertical-align: middle; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
      .pmProofCell:hover { border-color: var(--mainColor, #2563eb); box-shadow: 0 2px 10px rgba(37, 99, 235, 0.20); }
      .pmProofCell:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.30); }
      .pmProofThumb { width: 100%; height: 100%; object-fit: cover; display: block; }
      .pmProofBroken { display: none; align-items: center; justify-content: center; flex-direction: column; gap: 3px; width: 100%; height: 100%; color: #dc2626; font-size: 16px; background: #fef2f2; }
      .pmProofBroken small { font-size: 8.5px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase; color: #b91c1c; }
      .pmProofCell.is-broken { border-color: #fecaca; background: #fef2f2; }
      .pmProofCell.is-broken:hover { border-color: #dc2626; box-shadow: 0 2px 10px rgba(220, 38, 38, 0.18); }
      .pmProofCell.is-broken .pmProofThumb { display: none; }
      .pmProofCell.is-broken .pmProofBroken { display: flex; }
      .smsPhoneLink { color: var(--mainColor, #2563eb); text-decoration: none; font-weight: 500; }
      .smsPhoneLink:hover { text-decoration: underline; }
      .pmRemarksCell { display: flex; flex-direction: column; gap: 3px; max-width: 280px; min-width: 200px; text-align: left; font-size: 12px; line-height: 1.35; }
      .pmRemarkRow { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 4px; cursor: pointer; transition: background 0.15s ease; white-space: nowrap; overflow: hidden; }
      .pmRemarkRow:hover { background: #f1f5f9; }
      .pmRemarkRow:focus-visible { outline: none; background: #eff6ff; box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.25); }
      .pmRemarkLabel { font-weight: 700; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.3px; flex: 0 0 auto; min-width: 52px; }
      .pmRemarkPreview { color: #1c1e21; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
      .pmRemarkPreview.is-empty { color: #9ca3af; font-style: italic; font-weight: 500; }
      .pmRemarksBackdrop { position: fixed; inset: 0; background: rgba(15, 18, 28, 0.5); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 9999; opacity: 0; transition: opacity 0.2s ease; }
      .pmRemarksBackdrop.pmVisible { opacity: 1; }
      .pmRemarksCard { width: 100%; max-width: 540px; max-height: calc(100vh - 40px); background: #ffffff; border: 1px solid #e5e7eb; border-radius: 14px; box-shadow: 0 20px 50px rgba(15, 18, 28, 0.20); display: flex; flex-direction: column; overflow: hidden; transform: translateY(10px) scale(0.98); transition: transform 0.2s ease; font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif; }
      .pmRemarksBackdrop.pmVisible .pmRemarksCard { transform: translateY(0) scale(1); }
      .pmRemarksHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; background: #f9fafb; border-bottom: 1px solid #eef0f3; }
      .pmRemarksTitle { display: inline-flex; align-items: center; gap: 10px; margin: 0; font-size: 15px; font-weight: 700; color: #111827; letter-spacing: 0.1px; }
      .pmRemarksClose { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 1px solid transparent; border-radius: 8px; background: transparent; color: #606770; font-size: 13px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
      .pmRemarksClose:hover { background: #fef2f2; border-color: #fee2e2; color: #dc2626; }
      .pmRemarksClose:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.15); }
      .pmRemarksBody { padding: 16px 20px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
      .pmRemarkSection { display: flex; flex-direction: column; gap: 8px; padding: 6px 2px; background: transparent; border: none; border-radius: 0; transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease; }
      .pmRemarkSection.is-editing { background: #ffffff; border-color: var(--mainColor, #2563eb); box-shadow: none; }
      .pmRemarkSectionHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .pmRemarkSectionLabel { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 700; color: #374151; text-transform: uppercase; letter-spacing: 0.5px; }
      .pmRemarkSectionValue { font-size: 13.5px; line-height: 1.55; color: #1c1e21; white-space: pre-wrap; word-break: break-word; }
      .pmRemarkSectionValue.is-empty { color: #9ca3af; font-style: italic; }
      .pmRemarkEditBtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #606770; font-size: 12px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
      .pmRemarkEditBtn:hover { background: #eff6ff; border-color: #dbeafe; color: #2563eb; }
      .pmRemarkEditBtn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.15); }
      .pmRemarkTextarea { width: 100%; min-height: 90px; resize: vertical; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; font-family: inherit; font-size: 13.5px; line-height: 1.5; color: #1c1e21; background: #ffffff; outline: none; box-sizing: border-box; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
      .pmRemarkTextarea:focus { border-color: var(--mainColor, #2563eb); box-shadow: none; }
      .pmRemarkEditActions { display: flex; justify-content: flex-end; gap: 8px; }
      .pmRemarkEditActions[hidden], .pmRemarkTextarea[hidden], .pmRemarkSectionValue[hidden] { display: none !important; }
      .pmRemarkBtn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; min-height: 34px; font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1; border-radius: 8px; border: 1px solid transparent; cursor: pointer; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, filter 0.15s ease; }
      .pmRemarkBtn--ghost { background: #ffffff; border-color: #e5e7eb; color: #4b5563; }
      .pmRemarkBtn--ghost:hover { background: #f3f4f6; border-color: #d1d5db; color: #1c1e21; }
      .pmRemarkBtn--primary { background: var(--mainColor, #2563eb); border-color: var(--mainColor, #2563eb); color: #ffffff; }
      .pmRemarkBtn--primary:hover { filter: brightness(0.94); }
      .pmRemarkBtn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.30); }
      .pmRemarkBtn:disabled { opacity: 0.6; cursor: not-allowed; }
      .pmProofBackdrop { position: fixed; inset: 0; background: rgba(15, 18, 28, 0.65); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 10000; opacity: 0; transition: opacity 0.2s ease; }
      .pmProofBackdrop.pmVisible { opacity: 1; }
      .pmProofCard { width: 100%; max-width: 720px; max-height: calc(100vh - 40px); background: #ffffff; border-radius: 14px; box-shadow: 0 20px 60px rgba(15, 18, 28, 0.40); display: flex; flex-direction: column; overflow: hidden; transform: scale(0.96); transition: transform 0.2s ease; font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif; }
      .pmProofBackdrop.pmVisible .pmProofCard { transform: scale(1); }
      .pmProofHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; background: #f9fafb; border-bottom: 1px solid #eef0f3; }
      .pmProofTitle { display: inline-flex; align-items: center; gap: 10px; margin: 0; font-size: 14.5px; font-weight: 700; color: #111827; }
      .pmProofTitle i { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; background: rgba(99, 102, 241, 0.12); color: var(--mainColor, #2563eb); font-size: 13px; }
      .pmProofImageWrap { display: flex; align-items: center; justify-content: center; padding: 14px; background: #0f172a; min-height: 220px; }
      .pmProofImageWrap img { max-width: 100%; max-height: 62vh; object-fit: contain; display: block; border-radius: 4px; }
      .pmProofSpinner { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 180px; color: #94a3b8; font-size: 26px; }
      .pmProofBrokenBig { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px 20px; text-align: center; width: 100%; }
      .pmProofBrokenBig i { font-size: 44px; color: #f87171; }
      .pmProofBrokenBig strong { color: #ffffff; font-size: 15px; font-weight: 700; }
      .pmProofBrokenBig span { color: #94a3b8; font-size: 12.5px; max-width: 380px; line-height: 1.5; }
      .pmProofUrlRow { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #f8fafc; border-top: 1px solid #eef0f3; }
      .pmProofUrlLabel { font-size: 10.5px; font-weight: 800; letter-spacing: 0.6px; text-transform: uppercase; color: #64748b; flex: 0 0 auto; }
      .pmProofUrlLink { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--mainColor, #2563eb); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 6px 10px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; transition: border-color 0.15s ease, background 0.15s ease; }
      .pmProofUrlLink:hover { text-decoration: underline; border-color: var(--mainColor, #2563eb); }
      .pmProofUrlLink:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25); }
      .pmProofCopyBtn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 0; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; color: #64748b; cursor: pointer; flex: 0 0 auto; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
      .pmProofCopyBtn:hover { background: #f1f5f9; color: #1c1e21; border-color: #cbd5e1; }
      .pmProofCopyBtn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25); }
      .pmProofCopyBtn.is-copied { color: #16a34a; border-color: #bbf7d0; background: #f0fdf4; }
      @media (max-width: 480px) { .pmRemarksHeader { padding: 14px 16px; } .pmRemarksBody { padding: 14px 16px 18px; } .pmRemarksCard, .pmProofCard { max-width: 100%; } .pmProofHeader { padding: 12px 14px; } .pmProofUrlRow { padding: 10px 12px; flex-wrap: wrap; } .pmProofImageWrap img { max-height: 50vh; } }

      /* ============================================================
         Search clear button
         ============================================================ */
      .pmSearchClearBtn {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        display: none;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        margin: 0;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: #9ca3af;
        font-size: 11px;
        line-height: 1;
        cursor: pointer;
        z-index: 5;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .pmSearchClearBtn:hover {
        background: #f3f4f6;
        color: #4b5563;
      }
      .pmSearchClearBtn:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.30);
      }
      .pmSearchClearBtn.is-visible {
        display: inline-flex;
      }
      .pmSearchInputWithClear::-webkit-search-cancel-button,
      .pmSearchInputWithClear::-webkit-search-decoration {
        -webkit-appearance: none;
        appearance: none;
      }
    `;
    document.head.appendChild(style);
  }

  function classifyStatus(p) {
    const office = !!p.office_confirmed;
    const grounds = !!p.grounds_confirmed;
    if (office && grounds) return "completed";
    if (office) return "pending_grounds";
    return "pending_office";
  }

  function buildStatusBadge(p) {
    const key = classifyStatus(p);
    if (key === "completed")
      return '<span class="pmStatusBadge pmStatus--completed"><i class="fas fa-circle-check"></i>Completed</span>';
    if (key === "pending_grounds")
      return '<span class="pmStatusBadge pmStatus--pendingGrounds"><i class="fas fa-clock"></i>Pending \u2013 Grounds</span>';
    return '<span class="pmStatusBadge pmStatus--pendingOffice"><i class="fas fa-clock"></i>Pending \u2013 Office</span>';
  }

  const remarkTypes = ["payer", "office", "grounds"];
  const remarkField = (type) => "remarks_" + type;
  const remarkLabelFor = (type) => type.charAt(0).toUpperCase() + type.slice(1);

  const readRemark = (payment, type) => {
    const v = payment && payment[remarkField(type)];
    return v === null || v === undefined ? "" : String(v);
  };

  function buildProofCell(p) {
    if (!p.image_link) return '<span style="opacity:.55;">\u2014</span>';
    const url = escapeHtml(p.image_link);
    return (
      '<div class="pmProofCell" data-action="proof" data-payment-id="' +
      escapeHtml(p.payment_id) +
      '" role="button" tabindex="0" title="View proof of payment"><img class="pmProofThumb" src="' +
      url +
      '" alt="Proof of payment" loading="lazy"><span class="pmProofBroken"><i class="fas fa-exclamation-triangle"></i><small>Invalid</small></span></div>'
    );
  }

  function buildPhoneCell(p) {
    const phone = escapeHtml((p.payers_phone_number || "").trim());
    if (!phone) return '<span style="opacity:.55;">\u2014</span>';
    return (
      '<a href="#" class="smsPhoneLink" data-action="sms" data-payment-id="' +
      escapeHtml(p.payment_id) +
      '" title="Send SMS notification">' +
      phone +
      "</a>"
    );
  }

  function buildRemarksCell(p) {
    const rows = remarkTypes
      .map((type) => {
        const value = readRemark(p, type);
        const empty = value.trim() === "";
        const preview = empty ? "\u2014" : truncate(value, 60);
        return (
          '<div class="pmRemarkRow is-' +
          type +
          (empty ? " is-empty" : "") +
          '" data-action="remark" data-type="' +
          type +
          '" role="button" tabindex="0" title="View ' +
          escapeHtml(remarkLabelFor(type)) +
          ' remark"><span class="pmRemarkLabel">' +
          escapeHtml(remarkLabelFor(type)) +
          '</span><span class="pmRemarkPreview' +
          (empty ? " is-empty" : "") +
          '">' +
          escapeHtml(preview) +
          "</span></div>"
        );
      })
      .join("");
    return (
      '<div class="pmRemarksCell" data-payment-id="' +
      escapeHtml(p.payment_id) +
      '">' +
      rows +
      "</div>"
    );
  }

  function makeIconBtn(iconClass, className, handler, title) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pmActionBtn " + (className || "");
    btn.title = title || "";
    btn.setAttribute("aria-label", title || "");
    btn.innerHTML = '<i class="' + iconClass + '"></i>';
    btn.addEventListener("click", handler);
    return btn;
  }

  function buildVerifiedPill(title) {
    const pill = document.createElement("span");
    pill.className = "pmVerifiedPill";
    pill.title = title || "Payment fully verified";
    pill.innerHTML = '<i class="fas fa-circle-check"></i><span>Verified</span>';
    return pill;
  }

  function buildActionsCell(p) {
    const wrap = document.createElement("div");
    wrap.className = "pmActionGroup";

    if (state.activeTab === "pending_grounds" && currentTabCanConfirm()) {
      wrap.appendChild(
        makeIconBtn(
          "fas fa-check",
          "pmActionBtn--verify",
          (ev) => runConfirm(p, ev.currentTarget, TABS[state.activeTab]),
          "Confirm grounds completion",
        ),
      );
    } else if (state.activeTab === "verified" && currentTabCanUndo()) {
      wrap.appendChild(buildVerifiedPill("Payment fully verified"));
      wrap.appendChild(
        makeIconBtn(
          "fas fa-undo",
          "pmActionBtn--unverify",
          (ev) => runUndo(p, ev.currentTarget, TABS[state.activeTab]),
          "Undo grounds verification (returns to Pending – Grounds)",
        ),
      );
    } else if (state.activeTab === "verified") {
      wrap.appendChild(buildVerifiedPill("Payment fully verified"));
    }

    return wrap;
  }

  function buildReadOnlyNoticeHtml() {
    if (state.activeTab === "pending_office") {
      return '<tr class="readOnlyNoticeRow is-office"><td colspan="11"><div class="readOnlyNotice"><i class="fas fa-lock"></i><span>These payments are still awaiting <strong>Administrator / Office Staff</strong> confirmation.</span></div></td></tr>';
    }
    return "";
  }

  function hideNoData() {
    if (el.noData) {
      el.noData.hidden = true;
      el.noData.style.display = "none";
    }
  }

  function showNoData(message) {
    if (!el.noData) return;
    el.noData.hidden = false;
    el.noData.style.display = "";
    el.noData.innerHTML =
      '<i class="fas fa-inbox"></i> ' +
      escapeHtml(message || "No records found");
  }

  function renderLoading() {
    hideNoData();
    el.tbody.innerHTML =
      '<tr><td colspan="12" style="text-align:center;padding:24px;opacity:.75;"><i class="fas fa-spinner fa-spin"></i> Loading payments\u2026</td></tr>';
  }

  function renderError(message) {
    el.tbody.innerHTML = "";
    showNoData(message || "Failed to load payment records.");
  }

  function renderRows(payments) {
    el.tbody.innerHTML = "";
    const noticeHtml = buildReadOnlyNoticeHtml();
    if (noticeHtml) el.tbody.insertAdjacentHTML("beforeend", noticeHtml);

    if (!Array.isArray(payments) || payments.length === 0) {
      showNoData("No records found");
      return;
    }

    hideNoData();
    const frag = document.createDocumentFragment();

    payments.forEach((p) => {
      const tr = document.createElement("tr");
      tr.dataset.paymentId = p.payment_id;
      tr.__payment = p;

      tr.innerHTML =
        "<td>" +
        escapeHtml(p.deceased_name || "\u2014") +
        "</td>" +
        "<td>" +
        escapeHtml(p.payers_name || "\u2014") +
        "</td>" +
        "<td>" +
        escapeHtml(p.payment_channel || "\u2014") +
        "</td>" +
        "<td>" +
        escapeHtml(p.reference_number || "\u2014") +
        "</td>" +
        "<td>" +
        formatMoney(p.amount) +
        "</td>" +
        "<td>" +
        buildPhoneCell(p) +
        "</td>" +
        "<td>" +
        escapeHtml(p.payers_email || "\u2014") +
        "</td>" +
        "<td>" +
        escapeHtml(p.purpose || "\u2014") +
        "</td>" +
        "<td>" +
        buildProofCell(p) +
        "</td>" +
        "<td>" +
        buildRemarksCell(p) +
        "</td>" +
        "<td>" +
        buildStatusBadge(p) +
        "</td>";

      const actionCell = document.createElement("td");
      actionCell.appendChild(buildActionsCell(p));
      tr.appendChild(actionCell);
      frag.appendChild(tr);
    });

    el.tbody.appendChild(frag);
  }

  function renderPagination(pagination) {
    const total = Math.max(1, Number(pagination.total_pages) || 1);
    const current = Math.min(
      Math.max(1, Number(pagination.current_page) || 1),
      total,
    );
    const records = Math.max(0, Number(pagination.total_records) || 0);

    state.totalPages = total;
    state.page = current;
    state.totalRecords = records;

    if (el.currentPage) el.currentPage.textContent = String(current);
    if (el.totalPages) el.totalPages.textContent = String(total);
    if (el.totalRecords) el.totalRecords.textContent = String(records);
    if (el.prevBtn) el.prevBtn.disabled = current <= 1;
    if (el.nextBtn) el.nextBtn.disabled = current >= total;

    if (!el.carouselTrack) return;
    el.carouselTrack.innerHTML = "";

    const WINDOW = 5;
    let start = Math.max(1, current - Math.floor(WINDOW / 2));
    let end = Math.min(total, start + WINDOW - 1);
    start = Math.max(1, end - WINDOW + 1);

    const addEllipsis = () => {
      const span = document.createElement("span");
      span.className = "pageEllipsis";
      span.textContent = "\u2026";
      span.setAttribute("aria-hidden", "true");
      el.carouselTrack.appendChild(span);
    };

    const addPageBtn = (page) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = page === current ? "active" : "";
      btn.textContent = String(page);
      btn.dataset.page = String(page);
      if (page === current) btn.setAttribute("aria-current", "page");
      btn.addEventListener("click", () => {
        if (page === state.page) return;
        state.page = page;
        loadTab();
      });
      el.carouselTrack.appendChild(btn);
    };

    if (start > 1) {
      addPageBtn(1);
      if (start > 2) addEllipsis();
    }
    for (let i = start; i <= end; i++) addPageBtn(i);
    if (end < total) {
      if (end < total - 1) addEllipsis();
      addPageBtn(total);
    }
  }

  function updateTabUI() {
    el.tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === state.activeTab;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    if (el.tableWrapper)
      el.tableWrapper.classList.toggle(
        "hideActionCol",
        state.activeTab === "pending_office",
      );
    if (el.search) el.search.placeholder = SEARCH_PLACEHOLDER;
  }

  function switchTab(tabId) {
    if (!TABS[tabId] || tabId === state.activeTab) return;
    state.activeTab = tabId;
    state.page = 1;
    state.search = "";
    if (el.search) el.search.value = "";
    // Hide the clear button since the input was cleared programmatically
    const clearBtn = document.querySelector(".pmSearchClearBtn");
    if (clearBtn) clearBtn.classList.remove("is-visible");
    updateTabUI();
    loadTab();
  }

  function buildQuery() {
    const tabCfg = TABS[state.activeTab];
    const params = new URLSearchParams();
    params.set("page", String(state.page));
    params.set("limit", String(PER_PAGE));
    params.set("status", tabCfg.status);
    if (state.search && state.search.length >= SEARCH_MIN_LEN)
      params.set("search_term", state.search);
    return params.toString();
  }

  async function loadTab() {
    const reqId = ++state.requestId;
    state.loading = true;
    renderLoading();
    try {
      const res = await fetchWithTimeout(API_URL + "?" + buildQuery(), {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (reqId !== state.requestId) return;
      const json = await res.json().catch(() => null);
      if (!res.ok || (json && json.success === false))
        throw new Error(
          (json && (json.message || json.error)) ||
            "Request failed (" + res.status + ")",
        );
      const payload = unwrap(json);
      renderRows(payload.payments || []);
      renderPagination(
        payload.pagination || {
          total_pages: 1,
          current_page: 1,
          total_records: 0,
        },
      );
    } catch (err) {
      if (reqId !== state.requestId) return;
      console.error("[grounds-payments] load error:", err);
      renderError(
        isAbortError(err)
          ? "Loading payments timed out. Please try again."
          : friendlyMessage(err, "Unable to load payment records."),
      );
    } finally {
      if (reqId === state.requestId) state.loading = false;
    }
  }

  async function loadTabCounts() {
    await Promise.allSettled(
      Object.keys(TABS).map(async (tabId) => {
        try {
          const res = await fetchWithTimeout(
            API_URL +
              "?status=" +
              encodeURIComponent(TABS[tabId].status) +
              "&page=1&limit=1",
            {
              method: "GET",
              credentials: "same-origin",
              headers: { Accept: "application/json" },
            },
          );
          const json = await res.json().catch(() => null);
          if (!json) return;
          const total = Number(unwrap(json).pagination?.total_records) || 0;
          const badge = document.querySelector(
            '[data-count-tab="' + tabId + '"]',
          );
          if (badge) badge.textContent = total > 0 ? String(total) : "";
        } catch (_) {}
      }),
    );
  }

  async function runConfirm(payment, btn, tabCfg) {
    if (!btn || btn.disabled || !tabCfg || !tabCfg.canConfirm) return;
    let ok = false;
    try {
      ok = await askConfirm(tabCfg.confirmPrompt.message, {
        title: tabCfg.confirmPrompt.title,
        confirmText: tabCfg.confirmPrompt.confirmText,
        cancelText: "Cancel",
      });
    } catch (_) {
      ok = false;
    }
    if (!ok) return;

    const restore = enterRowBusy(btn);
    let succeeded = false;
    try {
      const res = await fetchWithTimeout(
        API_URL + "?path_info=" + encodeURIComponent(payment.payment_id),
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ action: tabCfg.confirmAction }),
        },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || (json && json.success === false))
        throw new Error(
          (json && (json.message || json.error)) ||
            "Request failed (" + res.status + ")",
        );
      notify((json && json.message) || "Payment confirmed.", "success");
      succeeded = true;
      await loadTab();
      loadTabCounts();
    } catch (err) {
      console.error("[grounds-payments] confirm error:", err);
      notify(
        isAbortError(err)
          ? "Request timed out. Please try again."
          : friendlyMessage(err, "Confirm failed."),
        "error",
      );
    } finally {
      if (!succeeded) restore();
    }
  }

  async function runUndo(payment, btn, tabCfg) {
    if (!btn || btn.disabled || !tabCfg || !tabCfg.canUndo) return;
    let ok = false;
    try {
      ok = await askConfirm(tabCfg.undoPrompt.message, {
        title: tabCfg.undoPrompt.title,
        confirmText: tabCfg.undoPrompt.confirmText,
        cancelText: "Cancel",
        danger: !!tabCfg.undoPrompt.danger,
      });
    } catch (_) {
      ok = false;
    }
    if (!ok) return;

    const restore = enterRowBusy(btn);
    let succeeded = false;
    try {
      const res = await fetchWithTimeout(
        API_URL + "?path_info=" + encodeURIComponent(payment.payment_id),
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ action: tabCfg.undoAction }),
        },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || (json && json.success === false))
        throw new Error(
          (json && (json.message || json.error)) ||
            "Request failed (" + res.status + ")",
        );
      notify(
        (json && json.message) || "Grounds verification reverted.",
        "success",
      );
      succeeded = true;
      await loadTab();
      loadTabCounts();
    } catch (err) {
      console.error("[grounds-payments] undo error:", err);
      notify(
        isAbortError(err)
          ? "Request timed out. Please try again."
          : friendlyMessage(err, "Undo failed."),
        "error",
      );
    } finally {
      if (!succeeded) restore();
    }
  }

  function buildVerificationMessage(p) {
    const name = (p.payers_name || p.deceased_name || "valued client").trim();
    return (
      "Hello " +
      name +
      ", your payment with the reference number: " +
      (p.reference_number || "").trim() +
      " is now verified."
    );
  }

  function openSms(phone, message) {
    if (typeof window.openSmsModal === "function") {
      window.openSmsModal(phone, message);
      return;
    }
    if (!phone) {
      notify("No phone number available for this record.", "error");
      return;
    }
    try {
      window.location.href =
        "sms:" +
        encodeURIComponent(phone) +
        "&body=" +
        encodeURIComponent(message || "");
    } catch (_) {}
  }

  function closeRemarksModal() {
    const modal = state.remarksModal;
    if (!modal) return;
    modal.backdrop.classList.remove("pmVisible");
    setTimeout(() => {
      if (modal.backdrop.parentNode)
        modal.backdrop.parentNode.removeChild(modal.backdrop);
      if (state.remarksModal === modal) state.remarksModal = null;
    }, 200);
    document.removeEventListener("keydown", modal.onKey, false);
    state.editingSection = null;
  }

  function closeActiveEditor() {
    const section = state.editingSection;
    if (section && typeof section.__endEdit === "function") section.__endEdit();
  }

  async function saveRemark(payment, type, value) {
    try {
      const res = await fetchWithTimeout(
        API_URL + "?path_info=" + encodeURIComponent(payment.payment_id),
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            action: "edit_remark",
            remark_type: type,
            remark_value: value,
          }),
        },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || (json && json.success === false))
        throw new Error(
          (json && (json.message || json.error)) ||
            "Request failed (" + res.status + ")",
        );
      const v = (value || "").trim();
      payment[remarkField(type)] = v === "" ? null : v;
      notify(
        (json && json.message) || remarkLabelFor(type) + " remark saved.",
        "success",
      );
      return true;
    } catch (err) {
      console.error("[grounds-payments] save remark error:", err);
      notify(
        isAbortError(err)
          ? "Saving remark timed out. Please try again."
          : friendlyMessage(err, "Failed to save remark."),
        "error",
      );
      return false;
    }
  }

  function refreshRowRemarks(payment) {
    const row = el.tbody.querySelector(
      'tr[data-payment-id="' + CSS.escape(String(payment.payment_id)) + '"]',
    );
    if (!row) return;
    row.__payment = payment;
    const cells = row.querySelectorAll("td");
    const remarkCell = cells[cells.length - 3];
    if (remarkCell) remarkCell.innerHTML = buildRemarksCell(payment);
  }

  function buildRemarkSection(payment, type) {
    const canEdit = type !== "payer" && canEditRemark(type);
    const value = readRemark(payment, type);
    const section = document.createElement("section");
    section.className = "pmRemarkSection is-" + type;
    section.dataset.type = type;

    const header = document.createElement("div");
    header.className = "pmRemarkSectionHeader";
    const label = document.createElement("span");
    label.className = "pmRemarkSectionLabel";
    label.textContent = remarkLabelFor(type);
    header.appendChild(label);

    let editBtn = null;
    if (canEdit) {
      editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "pmRemarkEditBtn";
      editBtn.title = "Edit " + remarkLabelFor(type) + " remark";
      editBtn.setAttribute("aria-label", editBtn.title);
      editBtn.innerHTML = '<i class="fas fa-pen"></i>';
      editBtn.addEventListener("click", beginEdit);
      header.appendChild(editBtn);
    }
    section.appendChild(header);

    const view = document.createElement("div");
    view.className =
      "pmRemarkSectionValue" + (value.trim() === "" ? " is-empty" : "");
    view.textContent = value.trim() === "" ? "\u2014" : value;
    section.appendChild(view);

    if (!canEdit) return section;

    const textarea = document.createElement("textarea");
    textarea.className = "pmRemarkTextarea";
    textarea.maxLength = REMARK_MAX_LEN;
    textarea.placeholder = "Enter " + type + " remark\u2026";
    textarea.hidden = true;
    section.appendChild(textarea);

    const actions = document.createElement("div");
    actions.className = "pmRemarkEditActions";
    actions.hidden = true;

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "pmRemarkBtn pmRemarkBtn--ghost";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", endEdit);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "pmRemarkBtn pmRemarkBtn--primary";
    saveBtn.textContent = "Save";

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    section.appendChild(actions);

    let original = value;

    function beginEdit() {
      if (state.editingSection && state.editingSection !== section)
        closeActiveEditor();
      original = readRemark(payment, type);
      textarea.value = original;
      view.hidden = true;
      textarea.hidden = false;
      actions.hidden = false;
      if (editBtn) editBtn.style.display = "none";
      state.editingSection = section;
      section.__endEdit = endEdit;
      textarea.focus();
      try {
        textarea.setSelectionRange(
          textarea.value.length,
          textarea.value.length,
        );
      } catch (_) {}
    }

    function endEdit() {
      view.hidden = false;
      textarea.hidden = true;
      actions.hidden = true;
      if (editBtn) editBtn.style.display = "";
      textarea.value = original;
      view.textContent = original.trim() === "" ? "\u2014" : original;
      view.classList.toggle("is-empty", original.trim() === "");
      if (state.editingSection === section) {
        state.editingSection = null;
        delete section.__endEdit;
      }
    }

    saveBtn.addEventListener("click", async () => {
      const newValue = textarea.value;
      if (newValue === original) return endEdit();
      if (newValue.length > REMARK_MAX_LEN) {
        notify(
          "Remark is too long (max " + REMARK_MAX_LEN + " characters).",
          "error",
        );
        return textarea.focus();
      }

      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      const prevLabel = saveBtn.textContent;
      saveBtn.textContent = "Saving\u2026";
      const ok = await saveRemark(payment, type, newValue);
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = prevLabel;
      if (!ok) return;

      const current = readRemark(payment, type);
      view.textContent = current.trim() === "" ? "\u2014" : current;
      view.classList.toggle("is-empty", current.trim() === "");
      original = current;
      refreshRowRemarks(payment);
      endEdit();
    });

    return section;
  }

  function openRemarksModal(payment, focusType) {
    if (!payment) return;
    closeRemarksModal();
    const backdrop = document.createElement("div");
    backdrop.className = "pmRemarksBackdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "pmRemarksTitle");

    const card = document.createElement("div");
    card.className = "pmRemarksCard";
    backdrop.appendChild(card);

    const header = document.createElement("div");
    header.className = "pmRemarksHeader";
    header.innerHTML =
      '<h3 class="pmRemarksTitle" id="pmRemarksTitle"><span>Payment Remarks</span></h3>';
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pmRemarksClose";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    closeBtn.addEventListener("click", closeRemarksModal);
    header.appendChild(closeBtn);
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "pmRemarksBody";
    remarkTypes.forEach((type) =>
      body.appendChild(buildRemarkSection(payment, type)),
    );
    card.appendChild(body);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeRemarksModal();
    });
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        state.editingSection ? closeActiveEditor() : closeRemarksModal();
      }
    };

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("pmVisible"));
    state.remarksModal = { backdrop, card, onKey };
    document.addEventListener("keydown", onKey, false);

    setTimeout(() => {
      try {
        closeBtn.focus({ preventScroll: true });
      } catch (_) {
        closeBtn.focus();
      }
    }, 60);
    if (focusType === "grounds" && canEditRemark("grounds")) {
      setTimeout(() => {
        const section = body.querySelector(".pmRemarkSection.is-grounds");
        if (section) {
          const btn = section.querySelector(".pmRemarkEditBtn");
          if (btn) btn.click();
        }
      }, 120);
    }
  }

  function closeProofModal() {
    const modal = state.proofModal;
    if (!modal) return;
    modal.backdrop.classList.remove("pmVisible");
    setTimeout(() => {
      if (modal.backdrop.parentNode)
        modal.backdrop.parentNode.removeChild(modal.backdrop);
      if (state.proofModal === modal) state.proofModal = null;
    }, 200);
    document.removeEventListener("keydown", modal.onKey, false);
  }

  function openProofModal(payment) {
    if (!payment) return;
    closeProofModal();
    const url = String(payment.image_link || "").trim();
    if (!url) {
      notify("No proof image attached to this payment.", "error");
      return;
    }

    const backdrop = document.createElement("div");
    backdrop.className = "pmProofBackdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "pmProofTitle");

    const card = document.createElement("div");
    card.className = "pmProofCard";
    backdrop.appendChild(card);

    const header = document.createElement("div");
    header.className = "pmProofHeader";
    header.innerHTML =
      '<h3 class="pmProofTitle" id="pmProofTitle"><i class="fas fa-image"></i><span>Proof of Payment</span></h3>';
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pmRemarksClose";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    closeBtn.addEventListener("click", closeProofModal);
    header.appendChild(closeBtn);
    card.appendChild(header);

    const imgWrap = document.createElement("div");
    imgWrap.className = "pmProofImageWrap";
    const spinner = document.createElement("div");
    spinner.className = "pmProofSpinner";
    spinner.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    imgWrap.appendChild(spinner);

    const img = document.createElement("img");
    img.alt = "Proof of payment";
    img.style.display = "none";

    img.addEventListener(
      "load",
      () => {
        spinner.remove();
        img.style.display = "";
      },
      { once: true },
    );
    img.addEventListener(
      "error",
      () => {
        spinner.remove();
        img.remove();
        const broken = document.createElement("div");
        broken.className = "pmProofBrokenBig";
        broken.innerHTML =
          '<i class="fas fa-exclamation-triangle"></i><strong>Image failed to load</strong><span>The image at this URL could not be loaded. Check the URL below or open it in a new tab.</span>';
        imgWrap.appendChild(broken);
      },
      { once: true },
    );

    img.src = url;
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);

    const urlRow = document.createElement("div");
    urlRow.className = "pmProofUrlRow";
    urlRow.innerHTML =
      '<span class="pmProofUrlLabel">URL</span><a class="pmProofUrlLink" href="' +
      url +
      '" target="_blank" rel="noopener noreferrer" title="' +
      url +
      '">' +
      url +
      "</a>";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "pmProofCopyBtn";
    copyBtn.title = "Copy URL";
    copyBtn.setAttribute("aria-label", "Copy URL");
    copyBtn.innerHTML = '<i class="fas fa-copy"></i>';

    const flashCopied = () => {
      copyBtn.classList.add("is-copied");
      copyBtn.innerHTML = '<i class="fas fa-check"></i>';
      setTimeout(() => {
        copyBtn.classList.remove("is-copied");
        copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
      }, 1400);
    };

    copyBtn.addEventListener("click", async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          return flashCopied();
        }
      } catch (_) {}
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        flashCopied();
      } catch (_) {
        notify("Could not copy URL.", "error");
      }
    });

    urlRow.appendChild(copyBtn);
    card.appendChild(urlRow);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeProofModal();
    });
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeProofModal();
      }
    };

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("pmVisible"));
    state.proofModal = { backdrop, card, onKey };
    document.addEventListener("keydown", onKey, false);

    setTimeout(() => {
      try {
        closeBtn.focus({ preventScroll: true });
      } catch (_) {
        closeBtn.focus();
      }
    }, 60);
  }

  // ------------------------------------------------------------------ search clear button
  function setupSearchClearButton() {
    const input = el.search;
    if (!input) return;

    const parent = input.parentElement;
    if (!parent) return;

    // The button is positioned absolutely inside the input's wrapper,
    // so the wrapper must establish a positioning context.
    if (window.getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }

    // Reserve room so typed text never slides under the clear button.
    input.style.paddingRight = "30px";
    input.classList.add("pmSearchInputWithClear");

    // Avoid duplicating the button if init runs more than once.
    const existing = parent.querySelector(".pmSearchClearBtn");
    if (existing) existing.remove();

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "pmSearchClearBtn";
    clearBtn.setAttribute("aria-label", "Clear search");
    clearBtn.title = "Clear search";
    clearBtn.innerHTML = '<i class="fas fa-times"></i>';

    const updateVisibility = () => {
      if (input.value.length > 0) {
        clearBtn.classList.add("is-visible");
      } else {
        clearBtn.classList.remove("is-visible");
      }
    };

    clearBtn.addEventListener("click", () => {
      input.value = "";
      updateVisibility();

      const hadSearch = state.search !== "";
      state.search = "";
      state.page = 1;
      if (hadSearch) loadTab();

      input.focus();
    });

    input.addEventListener("input", updateVisibility);

    parent.appendChild(clearBtn);
    updateVisibility();
  }

  let eventsBound = false;
  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    el.tabButtons.forEach((btn) =>
      btn.addEventListener("click", () => switchTab(btn.dataset.tab)),
    );
    if (el.search) {
      el.search.addEventListener(
        "input",
        debounce(() => {
          const v = el.search.value.trim();
          // Live typing never triggers the "too short" warning — that
          // only fires on Enter. Here we just skip short input.
          if (v.length > 0 && v.length < SEARCH_MIN_LEN) return;
          if (v === state.search) return;
          state.search = v;
          state.page = 1;
          loadTab();
        }, SEARCH_DEBOUNCE_MS),
      );

      el.search.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const v = el.search.value.trim();
        if (v.length > 0 && v.length < SEARCH_MIN_LEN)
          return notify("Too short to search", "warning");
        state.search = v;
        state.page = 1;
        loadTab();
      });
    }

    if (el.prevBtn)
      el.prevBtn.addEventListener("click", () => {
        if (state.page > 1) {
          state.page -= 1;
          loadTab();
        }
      });
    if (el.nextBtn)
      el.nextBtn.addEventListener("click", () => {
        if (state.page < state.totalPages) {
          state.page += 1;
          loadTab();
        }
      });

    if (el.tbody) {
      el.tbody.addEventListener(
        "error",
        (e) => {
          const img = e.target;
          if (
            img &&
            img.tagName === "IMG" &&
            img.classList.contains("pmProofThumb")
          ) {
            const cell = img.closest(".pmProofCell");
            if (cell) cell.classList.add("is-broken");
          }
        },
        true,
      );

      el.tbody.addEventListener("click", (e) => {
        const proofCell = e.target.closest('[data-action="proof"]');
        if (proofCell && el.tbody.contains(proofCell)) {
          e.preventDefault();
          const row = proofCell.closest("tr");
          if (row && !row.classList.contains("pmRowBusy") && row.__payment)
            openProofModal(row.__payment);
          return;
        }
        const smsLink = e.target.closest('[data-action="sms"]');
        if (smsLink && el.tbody.contains(smsLink)) {
          e.preventDefault();
          const row = smsLink.closest("tr");
          if (row && !row.classList.contains("pmRowBusy") && row.__payment) {
            const phone = (row.__payment.payers_phone_number || "").trim();
            phone
              ? openSms(phone, buildVerificationMessage(row.__payment))
              : notify("This record has no phone number.", "error");
          }
          return;
        }
        const remarkRow = e.target.closest('[data-action="remark"]');
        if (remarkRow && el.tbody.contains(remarkRow)) {
          e.preventDefault();
          const row = remarkRow.closest("tr");
          if (row && !row.classList.contains("pmRowBusy") && row.__payment)
            openRemarksModal(row.__payment, remarkRow.dataset.type || "");
        }
      });

      el.tbody.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const proofCell = e.target.closest('[data-action="proof"]');
        if (proofCell && el.tbody.contains(proofCell)) {
          e.preventDefault();
          const row = proofCell.closest("tr");
          if (row && !row.classList.contains("pmRowBusy") && row.__payment)
            openProofModal(row.__payment);
          return;
        }
        const remarkRow = e.target.closest('[data-action="remark"]');
        if (remarkRow && el.tbody.contains(remarkRow)) {
          e.preventDefault();
          const row = remarkRow.closest("tr");
          if (row && !row.classList.contains("pmRowBusy") && row.__payment)
            openRemarksModal(row.__payment, remarkRow.dataset.type || "");
        }
      });
    }
  }

  function start() {
    injectStyles();
    setupSearchClearButton();
    bindEvents();
    updateTabUI();
    loadTab();
    loadTabCounts();
    setTimeout(() => {
      updateTabUI();
      loadTab();
    }, 500);
  }

  if (document.readyState === "complete") {
    start();
  } else {
    window.addEventListener("load", start);
  }
})();
