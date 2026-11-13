// autosave.js — saves form input and suggests saved drafts

// This is a drop-in script, so it does not need changes in the existing JS.

// - Only saves when the user actually types or changes a field.
// - Ignores values filled in by code, wizard steps, or default values.
// - Shows saved drafts in a small popup, but never fills the fields automatically.
// - While the popup is open, empty fields can show their saved value as a placeholder.
// - The popup moves with the field when the page scrolls.
// - Deletes drafts after a successful POST, PUT, or DELETE request.
// - Keeps the draft if the request fails.

// Suggestion rules:
// - In #burial_modal_overlay, skip fields that were already filled when the modal opened.
// - Everywhere else, skip fields that already have enough text.

// Drafts are saved in localStorage for 30 days.
// It keeps a maximum of 20 drafts and removes the oldest ones first

//ONLY FOR INDEX (PAYMENTS) RECORDS RESERVE AND MONITOR CURRENTLY :>>> :<<
(function () {
  "use strict";

  var CONFIG = {
    PREFIX: "autosave:v1:",
    TTL_MS: 30 * 24 * 60 * 60 * 1000,
    MAX_DRAFTS: 20,
    DEBOUNCE_MS: 400,
    MIN_POPUP_WIDTH: 240,
    MAX_POPUP_WIDTH: 340,
    SELECT_WAIT_MS: 4000,
    MIN_POPULATED_LENGTH: 5,
    API_SUBMIT_PATTERN:
      /api\/(payments|records\.php|reserve\.php|monitor\.php)(\?|$|\/)/,
  };

  // Storage
  var store = (function () {
    try {
      var t = "__autosave_t__";
      window.localStorage.setItem(t, "1");
      window.localStorage.removeItem(t);
      return window.localStorage;
    } catch (e) {
      return null;
    }
  })();

  function readIndex() {
    if (!store) return {};
    try {
      var raw = store.getItem(CONFIG.PREFIX + "index");
      if (!raw) return {};
      var data = JSON.parse(raw);
      var now = Date.now();
      var out = {};
      Object.keys(data).forEach(function (k) {
        var entry = data[k];
        if (entry && entry.savedAt && now - entry.savedAt < CONFIG.TTL_MS)
          out[k] = entry;
      });
      return out;
    } catch (e) {
      return {};
    }
  }

  function writeIndex(idx) {
    if (!store) return;
    try {
      var keys = Object.keys(idx);
      if (keys.length > CONFIG.MAX_DRAFTS) {
        keys.sort(function (a, b) {
          return (idx[b].savedAt || 0) - (idx[a].savedAt || 0);
        });
        keys.slice(CONFIG.MAX_DRAFTS).forEach(function (k) {
          delete idx[k];
        });
      }
      store.setItem(CONFIG.PREFIX + "index", JSON.stringify(idx));
    } catch (e) {}
  }

  function getDraft(ctxKey) {
    var idx = readIndex();
    var d = idx[ctxKey];
    return d && d.fields ? d : null;
  }

  function setDraft(ctxKey, fields) {
    var idx = readIndex();
    idx[ctxKey] = { savedAt: Date.now(), fields: fields };
    writeIndex(idx);
  }

  function clearPageDrafts() {
    var prefix = location.pathname + "::";
    var idx = readIndex();
    var changed = false;
    Object.keys(idx).forEach(function (k) {
      if (k.indexOf(prefix) === 0) {
        delete idx[k];
        changed = true;
      }
    });
    if (changed) writeIndex(idx);
  }

  // Field identity
  function pageKey() {
    return location.pathname + "::";
  }

  function stepKey(field) {
    var modal = field.closest ? field.closest("#burial_modal_overlay") : null;
    if (!modal || !modal.classList.contains("active")) return "single";
    var hasWizard = !!(
      modal.querySelector(".paperNextBtn") ||
      modal.querySelector(".paperBackBtn")
    );
    if (!hasWizard) return "single";
    var nextBtn = modal.querySelector(".paperNextBtn");
    var saveBtn = modal.querySelector(".paperSaveBtn");
    if (nextBtn && nextBtn.style.display !== "none") return "old";
    if (saveBtn && saveBtn.style.display !== "none") return "new";
    return "single";
  }

  function fieldKey(field) {
    var type = (field.type || "").toLowerCase();
    var id =
      type === "radio" || type === "checkbox"
        ? field.name || field.id
        : field.id || field.name;
    if (!id) return null;
    return pageKey() + stepKey(field) + "::" + id;
  }

  function contextKey(field) {
    return pageKey() + stepKey(field);
  }

  // Trackable
  function isTrackable(field) {
    if (!field || !field.tagName) return false;
    var tag = field.tagName.toUpperCase();
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
    var type = (field.type || "").toLowerCase();
    if (
      [
        "password",
        "file",
        "hidden",
        "submit",
        "button",
        "reset",
        "image",
      ].indexOf(type) !== -1
    )
      return false;
    if (field.disabled || field.readOnly) return false;
    if (field.closest && field.closest("[data-no-autosave]")) return false;
    if (!(field.id || field.name)) return false;
    return true;
  }

  // "Empty-ish" = nothing meaningful stored. The +63 phone prefix counts
  // as empty so add-mode phone fields still get suggestions.
  function isEffectivelyEmpty(field, value) {
    var v = String(value == null ? "" : value).trim();
    if (v === "") return true;
    if (v === "+63") return true;
    return false;
  }

  //  Modal snapshot
  // When #burial_modal_overlay gets the 'active' class, we snapshot every
  // field's value. Any field that still matches the snapshot later was
  // filled by the system (edit-mode prefill) then skip suggestion hehe
  var modalSnapshot = {};

  function snapshotActiveModal() {
    var modal = document.getElementById("burial_modal_overlay");
    if (!modal || !modal.classList.contains("active")) return;
    modalSnapshot = {};
    var fields = modal.querySelectorAll("input, select, textarea");
    for (var i = 0; i < fields.length; i++) {
      var k = fieldKey(fields[i]);
      if (k) modalSnapshot[k] = fields[i].value;
    }
  }

  function setupModalObserver() {
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.attributeName !== "class") continue;
        var wasActive =
          (m.oldValue || "").split(/\s+/).indexOf("active") !== -1;
        var isActive = m.target.classList.contains("active");
        if (!wasActive && isActive) {
          // 50ms gives the modal's populateFields() time to settle
          setTimeout(snapshotActiveModal, 50);
        } else if (wasActive && !isActive) {
          modalSnapshot = {};
        }
      }
    });

    function attach(modal) {
      if (!modal || modal._autosaveObserved) return;
      modal._autosaveObserved = true;
      obs.observe(modal, {
        attributes: true,
        attributeFilter: ["class"],
        attributeOldValue: true,
      });
    }

    var existing = document.getElementById("burial_modal_overlay");
    if (existing) attach(existing);

    // Modal is injected on first open — watch for it
    var bodyObs = new MutationObserver(function () {
      var m = document.getElementById("burial_modal_overlay");
      if (m) attach(m);
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }

  // Skip rule
  function shouldSkipSuggestion(field) {
    var inModal = !!(field.closest && field.closest("#burial_modal_overlay"));

    if (inModal) {
      // Snapshot rule: same as open-time value AND non-empty-ish → skip
      var fk = fieldKey(field);
      if (fk && fk in modalSnapshot) {
        var snapVal = modalSnapshot[fk];
        if (
          field.value === snapVal &&
          !isEffectivelyEmpty(field, field.value)
        ) {
          return true;
        }
      }
      return false;
    }

    // Non-modal rule: length heuristic
    var tag = field.tagName.toUpperCase();
    var type = (field.type || "").toLowerCase();
    if (tag === "SELECT" || type === "checkbox" || type === "radio")
      return false;
    return String(field.value || "").length >= CONFIG.MIN_POPULATED_LENGTH;
  }

  // ---------- Value helpers ----------
  function getValue(field) {
    var type = (field.type || "").toLowerCase();
    if (type === "checkbox") return !!field.checked;
    if (type === "radio") {
      if (!field.name) return field.checked ? field.value : null;
      var group = document.getElementsByName(field.name);
      for (var i = 0; i < group.length; i++)
        if (group[i].checked) return group[i].value;
      return null;
    }
    return field.value;
  }

  function isEmptyField(field) {
    var type = (field.type || "").toLowerCase();
    if (type === "checkbox") return !field.checked;
    if (type === "radio") {
      if (!field.name) return !field.checked;
      var group = document.getElementsByName(field.name);
      for (var i = 0; i < group.length; i++) if (group[i].checked) return false;
      return true;
    }
    return !field.value;
  }

  function hasSuggestion(field, value) {
    if (value === null || value === undefined) return false;
    if (value === "") return false;
    var type = (field.type || "").toLowerCase();
    if (type === "checkbox") return value === true;
    return true;
  }

  function dispatchChange(field) {
    try {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (e) {}
    try {
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {}
  }

  function applyValue(field, value) {
    var type = (field.type || "").toLowerCase();
    var tag = field.tagName.toUpperCase();

    if (type === "checkbox") {
      field.checked = !!value;
      dispatchChange(field);
      return true;
    }
    if (type === "radio") {
      if (!field.name) {
        if (field.value === value) {
          field.checked = true;
          dispatchChange(field);
          return true;
        }
        return false;
      }
      var group = document.getElementsByName(field.name);
      for (var i = 0; i < group.length; i++) {
        if (group[i].value === value) {
          group[i].checked = true;
          dispatchChange(group[i]);
          return true;
        }
      }
      return false;
    }
    if (tag === "SELECT") {
      for (var j = 0; j < field.options.length; j++) {
        if (field.options[j].value === value) {
          field.value = value;
          dispatchChange(field);
          return true;
        }
      }
      return false;
    }
    field.value = value;
    dispatchChange(field);
    return true;
  }

  function waitForOption(field, value, cb) {
    var start = Date.now();
    function check() {
      if (!document.body.contains(field)) {
        cb(false);
        return;
      }
      if (Date.now() - start > CONFIG.SELECT_WAIT_MS) {
        cb(false);
        return;
      }
      for (var i = 0; i < field.options.length; i++) {
        if (field.options[i].value === value) {
          cb(true);
          return;
        }
      }
      setTimeout(check, 150);
    }
    check();
  }

  // ---------- Save (debounced) ----------
  var saveTimers = new Map();

  function saveField(field) {
    if (!isTrackable(field)) return;
    var fk = fieldKey(field);
    if (!fk) return;
    var ctx = contextKey(field);
    var draft = getDraft(ctx) || { fields: {} };
    draft.fields[fk] = { value: getValue(field), savedAt: Date.now() };
    setDraft(ctx, draft.fields);
  }

  function scheduleSave(field) {
    if (!isTrackable(field)) return;
    var prev = saveTimers.get(field);
    if (prev) clearTimeout(prev);
    saveTimers.set(
      field,
      setTimeout(function () {
        saveTimers.delete(field);
        saveField(field);
      }, CONFIG.DEBOUNCE_MS),
    );
  }

  document.addEventListener(
    "input",
    function (e) {
      if (isTrackable(e.target)) scheduleSave(e.target);
    },
    true,
  );
  document.addEventListener(
    "change",
    function (e) {
      if (isTrackable(e.target)) scheduleSave(e.target);
    },
    true,
  );
  window.addEventListener("pagehide", function () {
    saveTimers.forEach(function (timer, field) {
      clearTimeout(timer);
      saveField(field);
    });
    saveTimers.clear();
  });

  // Styles
  function injectStyles() {
    if (document.getElementById("autosaveStyles")) return;
    var s = document.createElement("style");
    s.id = "autosaveStyles";
    s.textContent = [
      ".autosave-preview::placeholder {",
      "    color: #6366f1 !important;",
      "    font-style: italic !important;",
      "    opacity: 0.6 !important;",
      "    animation: autosavePulse 1.6s ease-in-out infinite !important;",
      "}",
      "input.autosave-preview,",
      "textarea.autosave-preview {",
      "    border-color: #a5b4fc !important;",
      "    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12) !important;",
      "}",
      "@keyframes autosavePulse {",
      "    0%, 100% { opacity: 0.35; }",
      "    50% { opacity: 0.9; }",
      "}",
      ".autosave-popup button:hover { background: #f3f4f6 !important; }",
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---------- Preview ----------
  var previewState = [];

  function activatePreview(anchorField) {
    revertPreview();
    var ctx = contextKey(anchorField);
    var draft = getDraft(ctx);
    if (!draft) return;
    var anchorForm = anchorField.closest ? anchorField.closest("form") : null;

    Object.keys(draft.fields).forEach(function (fk) {
      var el = findFieldByKey(fk);
      if (!el) return;
      if (el === anchorField) return;
      if (!isEmptyField(el)) return;
      if (anchorForm && !anchorForm.contains(el)) return;
      var tag = el.tagName.toUpperCase();
      var type = (el.type || "").toLowerCase();
      if (tag === "SELECT") return;
      if (type === "checkbox" || type === "radio") return;
      var saved = draft.fields[fk];
      if (!saved || saved.value === "" || saved.value == null) return;

      previewState.push({
        field: el,
        originalPlaceholder: el.placeholder || "",
      });
      el.placeholder = String(saved.value);
      el.classList.add("autosave-preview");
    });
  }

  function revertPreview() {
    for (var i = 0; i < previewState.length; i++) {
      var p = previewState[i];
      p.field.placeholder = p.originalPlaceholder;
      p.field.classList.remove("autosave-preview");
    }
    previewState = [];
  }

  // Field lookup
  function findFieldByKey(fk) {
    var parts = fk.split("::");
    if (parts.length < 3) return null;
    var id = parts[parts.length - 1];
    var safe = id.replace(/["\\]/g, "\\$&");
    var nodes = [];
    try {
      nodes = document.querySelectorAll('[id="' + safe + '"]');
    } catch (e) {}
    for (var i = 0; i < nodes.length; i++) {
      if (fieldKey(nodes[i]) === fk) return nodes[i];
    }
    try {
      nodes = document.querySelectorAll('[name="' + safe + '"]');
    } catch (e) {
      return null;
    }
    for (var j = 0; j < nodes.length; j++) {
      if (fieldKey(nodes[j]) === fk) return nodes[j];
    }
    return null;
  }

  // ---------- Popup ----------
  var popupEl = null;
  var activeField = null;

  function ensurePopup() {
    if (popupEl) return popupEl;
    popupEl = document.createElement("div");
    popupEl.className = "autosave-popup";
    popupEl.setAttribute("role", "dialog");
    popupEl.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "background:#fff",
      "border:1px solid #d1d5db",
      "border-radius:8px",
      "box-shadow:0 8px 24px rgba(0,0,0,0.12)",
      "min-width:" + CONFIG.MIN_POPUP_WIDTH + "px",
      "max-width:" + CONFIG.MAX_POPUP_WIDTH + "px",
      "font-family:inherit",
      "font-size:14px",
      "color:#111827",
      "padding:4px",
      "display:none",
    ].join(";");
    document.body.appendChild(popupEl);
    return popupEl;
  }

  // Anchored to the field; no vertical clamping so the popup travels
  // off-screen with the field during a scroll.
  function positionPopup(field) {
    var rect = field.getBoundingClientRect();
    var pH = popupEl.offsetHeight || 100;
    var pW = popupEl.offsetWidth || CONFIG.MIN_POPUP_WIDTH;
    var vh = window.innerHeight;
    var vw = window.innerWidth;
    var below = vh - rect.bottom;
    var above = rect.top;
    var top =
      below >= pH + 8 || below >= above ? rect.bottom + 6 : rect.top - pH - 6;
    var left = rect.left;
    if (left + pW > vw - 10) left = vw - pW - 10;
    if (left < 10) left = 10;
    popupEl.style.top = top + "px";
    popupEl.style.left = left + "px";
  }

  function previewText(field, value) {
    var type = (field.type || "").toLowerCase();
    if (type === "checkbox") return value ? "Checked" : "Unchecked";
    if (type === "radio") return String(value);
    if (field.tagName.toUpperCase() === "SELECT") {
      for (var i = 0; i < field.options.length; i++) {
        if (field.options[i].value === value)
          return field.options[i].textContent;
      }
      return String(value);
    }
    var s = String(value);
    return s.length > 44 ? s.slice(0, 41) + "…" : s;
  }

  function countRestorable(anchorField) {
    var ctx = contextKey(anchorField);
    var draft = getDraft(ctx);
    if (!draft) return 0;
    var anchorForm = anchorField.closest ? anchorField.closest("form") : null;
    var n = 0;
    Object.keys(draft.fields).forEach(function (fk) {
      var el = findFieldByKey(fk);
      if (!el) return;
      if (!isEmptyField(el)) return;
      if (anchorForm && !anchorForm.contains(el)) return;
      var saved = draft.fields[fk];
      if (!saved) return;
      if (el.tagName.toUpperCase() === "SELECT") {
        var has = false;
        for (var i = 0; i < el.options.length; i++) {
          if (el.options[i].value === saved.value) {
            has = true;
            break;
          }
        }
        if (!has) return;
      }
      n++;
    });
    return n;
  }

  function renderPopup(field) {
    var fk = fieldKey(field);
    if (!fk) return false;
    var ctx = contextKey(field);
    var draft = getDraft(ctx);
    if (!draft) return false;
    var saved = draft.fields[fk];
    if (!saved) return false;
    if (!hasSuggestion(field, saved.value)) return false;
    if (shouldSkipSuggestion(field)) return false;

    var current = getValue(field);
    if (!isEmptyField(field) && String(current) === String(saved.value))
      return false;

    var totalCount = countRestorable(field);
    var showRestoreAll = totalCount >= 2;

    ensurePopup();
    popupEl.innerHTML = "";

    var row1 = document.createElement("button");
    row1.type = "button";
    row1.tabIndex = -1;
    row1.setAttribute("data-role", "one");
    row1.style.cssText =
      "display:block;width:100%;text-align:left;padding:10px 12px;background:transparent;border:none;border-radius:6px;cursor:pointer;font:inherit;color:#111827;font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    row1.textContent = previewText(field, saved.value);
    row1.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      restoreSingle(field, saved.value);
      hidePopup();
    });
    popupEl.appendChild(row1);

    if (showRestoreAll) {
      var divider = document.createElement("div");
      divider.style.cssText = "height:1px;background:#e5e7eb;margin:4px 0";
      popupEl.appendChild(divider);

      var row2 = document.createElement("button");
      row2.type = "button";
      row2.tabIndex = -1;
      row2.setAttribute("data-role", "all");
      row2.style.cssText =
        "display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:10px 12px;background:transparent;border:none;border-radius:6px;cursor:pointer;font:inherit;color:#111827;font-weight:500;font-size:14px";
      row2.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">' +
        '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>' +
        "</svg>" +
        "<span>Restore " +
        totalCount +
        " fields</span>";
      row2.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        restoreAll(field);
        hidePopup();
      });
      popupEl.appendChild(row2);
    }

    popupEl.style.display = "block";
    positionPopup(field);
    if (showRestoreAll) activatePreview(field);
    return true;
  }

  function showPopup(field) {
    if (!renderPopup(field)) hidePopup();
    else activeField = field;
  }

  function hidePopup() {
    if (popupEl) popupEl.style.display = "none";
    revertPreview();
    activeField = null;
  }

  // ---------- Restore ----------
  function restoreSingle(field, value) {
    if (field.tagName.toUpperCase() === "SELECT") {
      var has = false;
      for (var i = 0; i < field.options.length; i++) {
        if (field.options[i].value === value) {
          has = true;
          break;
        }
      }
      if (has) applyValue(field, value);
      else
        waitForOption(field, value, function (ok) {
          if (ok) applyValue(field, value);
        });
    } else {
      applyValue(field, value);
    }
  }

  function restoreAll(anchorField) {
    var ctx = contextKey(anchorField);
    var draft = getDraft(ctx);
    if (!draft) return;
    var anchorForm = anchorField.closest ? anchorField.closest("form") : null;

    var textItems = [];
    var selectItems = [];

    Object.keys(draft.fields).forEach(function (fk) {
      var el = findFieldByKey(fk);
      if (!el) return;
      if (!isEmptyField(el)) return;
      if (anchorForm && !anchorForm.contains(el)) return;
      var saved = draft.fields[fk];
      if (!saved) return;
      var item = { field: el, value: saved.value };
      if (el.tagName.toUpperCase() === "SELECT") selectItems.push(item);
      else textItems.push(item);
    });

    textItems.forEach(function (p) {
      applyValue(p.field, p.value);
    });
    selectItems.forEach(function (p) {
      var has = false;
      for (var i = 0; i < p.field.options.length; i++) {
        if (p.field.options[i].value === p.value) {
          has = true;
          break;
        }
      }
      if (has) applyValue(p.field, p.value);
      else
        waitForOption(p.field, p.value, function (ok) {
          if (ok) applyValue(p.field, p.value);
        });
    });
  }

  // Popup events
  document.addEventListener(
    "focusin",
    function (e) {
      if (popupEl && popupEl.contains(e.target)) return;
      if (!isTrackable(e.target)) {
        hidePopup();
        return;
      }
      revertPreview();
      setTimeout(function () {
        showPopup(e.target);
      }, 10);
    },
    true,
  );

  document.addEventListener(
    "input",
    function (e) {
      if (!e.isTrusted) return;
      if (popupEl && popupEl.style.display !== "none") hidePopup();
    },
    true,
  );

  document.addEventListener(
    "mousedown",
    function (e) {
      if (!popupEl || popupEl.style.display === "none") return;
      if (popupEl.contains(e.target)) return;
      if (e.target === activeField) return;
      hidePopup();
    },
    true,
  );

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hidePopup();
  });

  // Reposition on scroll/resize, throttled to one paint frame.
  var positionRaf = null;
  function requestPosition() {
    if (positionRaf) return;
    positionRaf = requestAnimationFrame(function () {
      positionRaf = null;
      if (activeField && popupEl && popupEl.style.display !== "none") {
        positionPopup(activeField);
      }
    });
  }
  window.addEventListener("scroll", requestPosition, true);
  window.addEventListener("resize", requestPosition);

  // Safety net: hide when the field is unmounted or hidden by CSS
  setInterval(function () {
    if (!popupEl || popupEl.style.display === "none") return;
    if (
      !activeField ||
      !document.body.contains(activeField) ||
      activeField.offsetParent === null
    ) {
      hidePopup();
    }
  }, 500);

  // Fetch interception
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var promise = origFetch.apply(this, arguments);
      try {
        var url =
          typeof input === "string" ? input : (input && input.url) || "";
        var method = (init && init.method ? init.method : "GET").toUpperCase();
        var isSubmit =
          CONFIG.API_SUBMIT_PATTERN.test(url) &&
          ["POST", "PUT", "DELETE"].indexOf(method) !== -1;
        if (isSubmit) {
          promise
            .then(function (res) {
              if (!res || !res.ok) return;
              try {
                res
                  .clone()
                  .json()
                  .then(function (body) {
                    if (!body || body.success !== false) clearPageDrafts();
                  })
                  .catch(function () {
                    clearPageDrafts();
                  });
              } catch (e) {
                clearPageDrafts();
              }
            })
            .catch(function () {});
        }
      } catch (e) {}
      return promise;
    };
  }

  // Init
  injectStyles();
  setupModalObserver();

  window.AutoSaveForm = {
    clear: clearPageDrafts,
    clearAll: function () {
      if (!store) return;
      try {
        store.removeItem(CONFIG.PREFIX + "index");
      } catch (e) {}
    },
  };
})();
