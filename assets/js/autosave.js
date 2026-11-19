// autosave.js — saves form drafts and restores them all at once.
// Fixed observer handling to prevent repeated DOM updates.
// Floating pop-in / auto-tuck Restore Draft UI with desktop hover preview
// and mobile two-tap peek-to-restore (core logic preserved).

(function () {
  "use strict";

  var CONFIG = {
    PREFIX: "autosave:v1:",
    TTL_MS: 30 * 24 * 60 * 60 * 1000,
    MAX_DRAFTS: 20,
    DEBOUNCE_MS: 400,
    SELECT_WAIT_MS: 4000,
    AUTO_TUCK_MS: 3200,
    RESTORED_TOAST_MS: 1800,
    API_SUBMIT_PATTERN:
      /(?:^|\/)api\/(payments|records\.php|reserve\.php)(\?|$|\/)/i,
  };

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  var store = (function () {
    try {
      var testKey = "__autosave_test__";
      window.localStorage.setItem(testKey, "1");
      window.localStorage.removeItem(testKey);
      return window.localStorage;
    } catch (error) {
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
      var validEntries = {};

      Object.keys(data).forEach(function (key) {
        var entry = data[key];

        if (
          entry &&
          entry.savedAt &&
          now - entry.savedAt < CONFIG.TTL_MS &&
          entry.fields
        ) {
          validEntries[key] = entry;
        }
      });

      return validEntries;
    } catch (error) {
      return {};
    }
  }

  function writeIndex(index) {
    if (!store) return;

    try {
      var keys = Object.keys(index);

      if (keys.length > CONFIG.MAX_DRAFTS) {
        keys.sort(function (a, b) {
          return (index[b].savedAt || 0) - (index[a].savedAt || 0);
        });

        keys.slice(CONFIG.MAX_DRAFTS).forEach(function (key) {
          delete index[key];
        });
      }

      store.setItem(CONFIG.PREFIX + "index", JSON.stringify(index));
    } catch (error) {
      // Storage can fail when the browser's quota is full or unavailable.
    }
  }

  function getDraft(context) {
    var index = readIndex();
    var draft = index[context];
    return draft && draft.fields ? draft : null;
  }

  function setDraft(context, fields) {
    var index = readIndex();
    index[context] = {
      savedAt: Date.now(),
      fields: fields,
    };
    writeIndex(index);
  }

  function clearPageDrafts() {
    var prefix = location.pathname + "::";
    var index = readIndex();
    var changed = false;

    Object.keys(index).forEach(function (key) {
      if (key.indexOf(prefix) === 0) {
        delete index[key];
        changed = true;
      }
    });

    if (changed) writeIndex(index);

    hasUserChanges = false;
    removeAllRestoreControls();
  }

  // ---------------------------------------------------------------------------
  // Field identity and wizard context
  // ---------------------------------------------------------------------------

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

    var nextButton = modal.querySelector(".paperNextBtn");
    var saveButton = modal.querySelector(".paperSaveBtn");

    if (nextButton && nextButton.style.display !== "none") return "old";
    if (saveButton && saveButton.style.display !== "none") return "new";

    return "single";
  }

  function fieldKey(field) {
    var type = (field.type || "").toLowerCase();
    var identifier =
      type === "radio" || type === "checkbox"
        ? field.name || field.id
        : field.id || field.name;

    if (!identifier) return null;

    return pageKey() + stepKey(field) + "::" + identifier;
  }

  function contextKey(field) {
    return pageKey() + stepKey(field);
  }

  // A form gets its own Restore Draft control. When fields are not inside a
  // form, the burial modal is used; otherwise the page is the fallback scope.
  function getRestoreScope(field) {
    return (
      (field.closest && field.closest("form")) ||
      (field.closest && field.closest("#burial_modal_overlay")) ||
      document.body
    );
  }

  // ---------------------------------------------------------------------------
  // Trackable fields and values
  // ---------------------------------------------------------------------------

  function isTrackable(field) {
    if (!field || !field.tagName) return false;

    var tag = field.tagName.toUpperCase();
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      return false;
    }

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
    ) {
      return false;
    }

    if (field.disabled || field.readOnly) return false;
    if (field.closest && field.closest("[data-no-autosave]")) return false;
    if (!(field.id || field.name)) return false;

    return true;
  }

  function getValue(field) {
    var type = (field.type || "").toLowerCase();

    if (type === "checkbox") return !!field.checked;

    if (type === "radio") {
      if (!field.name) return field.checked ? field.value : null;

      var group = document.getElementsByName(field.name);
      for (var i = 0; i < group.length; i++) {
        if (group[i].checked) return group[i].value;
      }

      return null;
    }

    return field.value;
  }

  function isFieldEmptyForRestore(field) {
    if (!field) return false;

    var type = (field.type || "").toLowerCase();
    var tag = field.tagName.toUpperCase();

    if (type === "checkbox") return !field.checked;

    if (type === "radio") {
      if (!field.name) return !field.checked;

      var group = document.getElementsByName(field.name);
      for (var i = 0; i < group.length; i++) {
        if (group[i].checked) return false;
      }

      return true;
    }

    if (tag === "SELECT") return !field.value;

    // A phone input containing only the country prefix is still empty.
    var value = String(field.value == null ? "" : field.value).trim();
    return value === "" || value === "+63";
  }

  function hasRestorableValue(field, value) {
    if (value === null || value === undefined || value === "") return false;

    var type = (field.type || "").toLowerCase();
    if (type === "checkbox") return value === true;

    if (type !== "radio" && field.tagName.toUpperCase() !== "SELECT") {
      var textValue = String(value).trim();
      if (textValue === "" || textValue === "+63") return false;
    }

    return true;
  }

  function dispatchChange(field) {
    try {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (error) {}

    try {
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (error) {}
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
        if (field.value !== value) return false;
        field.checked = true;
        dispatchChange(field);
        return true;
      }

      var radios = document.getElementsByName(field.name);
      for (var i = 0; i < radios.length; i++) {
        if (radios[i].value === value) {
          radios[i].checked = true;
          dispatchChange(radios[i]);
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

  function waitForOption(field, value, callback) {
    var startedAt = Date.now();

    function check() {
      if (!document.body.contains(field)) {
        callback(false);
        return;
      }

      if (Date.now() - startedAt > CONFIG.SELECT_WAIT_MS) {
        callback(false);
        return;
      }

      for (var i = 0; i < field.options.length; i++) {
        if (field.options[i].value === value) {
          callback(true);
          return;
        }
      }

      setTimeout(check, 150);
    }

    check();
  }

  // ---------------------------------------------------------------------------
  // Autosaving
  // ---------------------------------------------------------------------------

  var hasUserChanges = false;
  var saveTimers = new Map();

  function saveField(field) {
    if (!isTrackable(field)) return;

    var key = fieldKey(field);
    if (!key) return;

    var context = contextKey(field);
    var draft = getDraft(context) || { fields: {} };

    draft.fields[key] = {
      value: getValue(field),
      savedAt: Date.now(),
    };

    setDraft(context, draft.fields);
    renderRestoreControls();
  }

  function scheduleSave(field) {
    if (!isTrackable(field)) return;

    var previousTimer = saveTimers.get(field);
    if (previousTimer) clearTimeout(previousTimer);

    saveTimers.set(
      field,
      setTimeout(function () {
        saveTimers.delete(field);
        saveField(field);
      }, CONFIG.DEBOUNCE_MS),
    );
  }

  function handleUserFieldChange(event) {
    if (!isTrackable(event.target) || !event.isTrusted) return;

    // This stays true even after localStorage has saved the draft. The browser
    // will therefore still warn before a reload, tab close, or navigation.
    hasUserChanges = true;
    scheduleSave(event.target);
  }

  document.addEventListener("input", handleUserFieldChange, true);
  document.addEventListener("change", handleUserFieldChange, true);

  window.addEventListener("pagehide", function () {
    clearPreview();

    saveTimers.forEach(function (timer, field) {
      clearTimeout(timer);
      saveField(field);
    });

    saveTimers.clear();
  });

  // ---------------------------------------------------------------------------
  // Restore Draft UI (Floating Pop-In Dock + Live Field Preview + Mobile Peek)
  // ---------------------------------------------------------------------------

  var restoreControls = [];
  var restoreDock = null;
  var domObserver = null;
  var activePreview = null;

  function isCoarsePointer() {
    try {
      return (
        window.matchMedia &&
        window.matchMedia("(hover: none), (pointer: coarse)").matches
      );
    } catch (error) {
      return false;
    }
  }

  function flushObserverRecords() {
    if (domObserver) {
      try {
        domObserver.takeRecords();
      } catch (error) {}
    }
  }

  function ensureRestoreDock() {
    if (restoreDock && document.body.contains(restoreDock)) return restoreDock;

    var existing = document.getElementById("autosaveRestoreDock");
    if (existing) {
      restoreDock = existing;
      return restoreDock;
    }

    var dock = document.createElement("div");
    dock.id = "autosaveRestoreDock";
    dock.className = "autosave-restore-dock";
    dock.setAttribute("aria-live", "polite");
    document.body.appendChild(dock);

    restoreDock = dock;
    return restoreDock;
  }

  function isFieldVisible(field) {
    if (!field || !document.body.contains(field)) return false;
    if (field.getClientRects().length === 0) return false;

    var style = window.getComputedStyle(field);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    var modal = field.closest ? field.closest("#burial_modal_overlay") : null;
    if (modal) {
      var modalStyle = window.getComputedStyle(modal);
      if (
        modalStyle.display === "none" ||
        modalStyle.visibility === "hidden" ||
        parseFloat(modalStyle.opacity) === 0 ||
        modalStyle.pointerEvents === "none"
      ) {
        return false;
      }
    }

    return true;
  }

  function isFieldInViewport(field) {
    if (!isFieldVisible(field)) return false;

    var rect = field.getBoundingClientRect();
    var viewHeight =
      window.innerHeight || document.documentElement.clientHeight || 0;
    var viewWidth =
      window.innerWidth || document.documentElement.clientWidth || 0;

    return (
      rect.bottom > 0 &&
      rect.top < viewHeight &&
      rect.right > 0 &&
      rect.left < viewWidth
    );
  }

  function hasVisibleRestorableField(restorable) {
    for (var i = 0; i < restorable.length; i++) {
      if (isFieldVisible(restorable[i].field)) return true;
    }
    return false;
  }

  function applyControlCopy(control, mode, count) {
    var countWord = count === 1 ? "field" : "fields";

    if (mode === "touch") {
      control.label.textContent = "Tap to restore";
      control.count.textContent = "Previewing " + count + " " + countWord;
      return;
    }

    if (mode === "hover") {
      control.label.textContent = "Restore draft";
      control.count.textContent =
        "Previewing " + count + " " + countWord + " · Click";
      return;
    }

    control.label.textContent = "Restore draft";
    control.count.textContent =
      count === 1 ? "1 saved field" : count + " saved fields";
  }

  function clearPreview() {
    if (!activePreview) return;

    var preview = activePreview;
    activePreview = null;

    preview.entries.forEach(function (entry) {
      if (entry.kind === "radio") {
        entry.radios.forEach(function (item) {
          if (item.el && document.body.contains(item.el)) {
            item.el.checked = item.originalChecked;
            item.el.classList.remove("autosave-field-preview-check");
          }
        });
        return;
      }

      var field = entry.field;
      if (!field || !document.body.contains(field)) return;

      if (entry.kind === "checkbox") {
        field.checked = entry.originalChecked;
        field.classList.remove("autosave-field-preview-check");
      } else if (entry.kind === "select") {
        if (entry.changed) {
          field.value = entry.originalValue;
          if (field.value !== entry.originalValue) {
            field.selectedIndex = entry.originalSelectedIndex;
          }
        }
        field.classList.remove("autosave-field-preview");
        field.classList.remove("autosave-field-preview-pending");
      } else {
        field.value = entry.originalValue;
        field.classList.remove("autosave-field-preview");
      }
    });

    if (preview.control && preview.control.wrapper) {
      preview.control.wrapper.classList.remove("is-previewing");
      preview.control.wrapper.classList.remove("is-touch-preview");
      applyControlCopy(
        preview.control,
        "idle",
        preview.control.restorableCount || 0,
      );
    }

    flushObserverRecords();
  }

  function startPreview(control, isStickyTouch) {
    if (!control || !control.wrapper) return;

    if (activePreview) {
      if (activePreview.control === control) {
        if (isStickyTouch && !activePreview.sticky) {
          activePreview.sticky = true;
          control.wrapper.classList.add("is-touch-preview");
          applyControlCopy(control, "touch", activePreview.count);
        }
        return;
      }
      clearPreview();
    }

    var currentGroups = collectRestoreGroups();
    var liveGroup = null;

    for (var i = 0; i < currentGroups.length; i++) {
      if (
        currentGroups[i].scope === control.scope &&
        currentGroups[i].context === control.context
      ) {
        liveGroup = currentGroups[i];
        break;
      }
    }

    if (!liveGroup) return;

    var restorable = getRestorableFields(liveGroup);
    if (!restorable.length) return;

    var entries = [];
    var visiblePreviewFields = [];

    restorable.forEach(function (item) {
      var field = item.field;
      var value = item.value;
      var type = (field.type || "").toLowerCase();
      var tag = field.tagName.toUpperCase();

      if (type === "checkbox") {
        entries.push({
          kind: "checkbox",
          field: field,
          originalChecked: field.checked,
        });
        field.checked = !!value;
        field.classList.add("autosave-field-preview-check");
        if (isFieldVisible(field)) visiblePreviewFields.push(field);
        return;
      }

      if (type === "radio") {
        var groupNodes = field.name
          ? Array.prototype.slice.call(document.getElementsByName(field.name))
          : [field];
        var snapshot = [];
        var matchedRadio = null;

        groupNodes.forEach(function (radio) {
          snapshot.push({ el: radio, originalChecked: radio.checked });
          if (radio.value === value) matchedRadio = radio;
        });

        if (matchedRadio) {
          entries.push({
            kind: "radio",
            field: matchedRadio,
            radios: snapshot,
          });
          matchedRadio.checked = true;
          matchedRadio.classList.add("autosave-field-preview-check");
          if (isFieldVisible(matchedRadio)) {
            visiblePreviewFields.push(matchedRadio);
          }
        }
        return;
      }

      if (tag === "SELECT") {
        var optionExists = false;
        for (var j = 0; j < field.options.length; j++) {
          if (field.options[j].value === value) {
            optionExists = true;
            break;
          }
        }

        entries.push({
          kind: "select",
          field: field,
          originalValue: field.value,
          originalSelectedIndex: field.selectedIndex,
          changed: optionExists,
        });

        if (optionExists) {
          field.value = value;
          field.classList.add("autosave-field-preview");
        } else {
          field.classList.add("autosave-field-preview-pending");
        }

        if (isFieldVisible(field)) visiblePreviewFields.push(field);
        return;
      }

      entries.push({
        kind: "text",
        field: field,
        originalValue: field.value,
      });
      field.value = value;
      field.classList.add("autosave-field-preview");
      if (isFieldVisible(field)) visiblePreviewFields.push(field);
    });

    if (!entries.length) return;

    activePreview = {
      control: control,
      sticky: !!isStickyTouch,
      entries: entries,
      count: restorable.length,
    };

    control.wrapper.classList.add("is-previewing");
    if (isStickyTouch) {
      control.wrapper.classList.add("is-touch-preview");
      applyControlCopy(control, "touch", restorable.length);
    } else {
      applyControlCopy(control, "hover", restorable.length);
    }

    flushObserverRecords();

    // On touch devices, if none of the previewed fields are currently on
    // screen, gently scroll the first one into view so the preview is visible.
    if (isStickyTouch && visiblePreviewFields.length) {
      var anyInView = visiblePreviewFields.some(isFieldInViewport);
      if (
        !anyInView &&
        typeof visiblePreviewFields[0].scrollIntoView === "function"
      ) {
        try {
          visiblePreviewFields[0].scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        } catch (error) {
          visiblePreviewFields[0].scrollIntoView();
        }
      }
    }
  }

  function removeControl(control) {
    if (!control) return;
    if (activePreview && activePreview.control === control) {
      clearPreview();
    }
    if (control.tuckTimer) {
      clearTimeout(control.tuckTimer);
      control.tuckTimer = null;
    }
    if (control.wrapper && control.wrapper.parentNode) {
      control.wrapper.parentNode.removeChild(control.wrapper);
    }
  }

  function removeAllRestoreControls() {
    clearPreview();
    restoreControls.forEach(removeControl);
    restoreControls = [];
  }

  function showRestoredFeedback(restoredCount) {
    if (!document.body || !restoredCount) return;

    var dock = ensureRestoreDock();
    var toast = document.createElement("div");
    toast.className = "autosave-restore-row autosave-restored-toast";
    toast.setAttribute("role", "status");

    var icon = document.createElement("span");
    icon.className = "autosave-restored-check";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4.5 10.5l3.5 3.5 7.5-8"/>' +
      "</svg>";

    var text = document.createElement("span");
    text.textContent =
      "Restored " +
      restoredCount +
      (restoredCount === 1 ? " field" : " fields");

    toast.appendChild(icon);
    toast.appendChild(text);
    dock.appendChild(toast);

    setTimeout(function () {
      toast.classList.add("is-leaving");
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 240);
    }, CONFIG.RESTORED_TOAST_MS);
  }

  function collectRestoreGroups() {
    var fields = document.querySelectorAll("input, textarea, select");
    var groups = [];

    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (!isTrackable(field)) continue;

      var scope = getRestoreScope(field);
      var context = contextKey(field);
      var group = null;

      for (var j = 0; j < groups.length; j++) {
        if (groups[j].scope === scope && groups[j].context === context) {
          group = groups[j];
          break;
        }
      }

      if (!group) {
        group = {
          scope: scope,
          context: context,
          fields: [],
        };
        groups.push(group);
      }

      group.fields.push(field);
    }

    return groups;
  }

  function getRestorableFields(group) {
    var draft = getDraft(group.context);
    if (!draft) return [];

    var restorable = [];
    var seenKeys = {};

    group.fields.forEach(function (field) {
      var key = fieldKey(field);
      if (!key || seenKeys[key]) return;
      seenKeys[key] = true;

      var saved = draft.fields[key];
      if (!saved) return;
      if (!isFieldEmptyForRestore(field)) return;
      if (!hasRestorableValue(field, saved.value)) return;

      restorable.push({
        field: field,
        key: key,
        value: saved.value,
      });
    });

    return restorable;
  }

  function createRestoreControl(group) {
    var dock = ensureRestoreDock();

    var wrapper = document.createElement("div");
    wrapper.className = "autosave-restore-row";

    var cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "autosave-restore-cancel";
    cancelButton.setAttribute("aria-label", "Cancel draft preview");
    cancelButton.innerHTML =
      '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
      '<path d="M5 5l10 10M15 5L5 15"/>' +
      "</svg>";

    var button = document.createElement("button");
    button.type = "button";
    button.className = "autosave-restore-button";

    var icon = document.createElement("span");
    icon.className = "autosave-restore-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>' +
      '<path d="M3 3v5h5"/>' +
      "</svg>";

    var reveal = document.createElement("span");
    reveal.className = "autosave-restore-reveal";

    var content = document.createElement("span");
    content.className = "autosave-restore-content";

    var label = document.createElement("span");
    label.className = "autosave-restore-label";
    label.textContent = "Restore draft";

    var count = document.createElement("span");
    count.className = "autosave-restore-count";

    content.appendChild(label);
    content.appendChild(count);
    reveal.appendChild(content);

    var badge = document.createElement("span");
    badge.className = "autosave-restore-badge";
    badge.setAttribute("aria-hidden", "true");

    button.appendChild(icon);
    button.appendChild(reveal);
    button.appendChild(badge);

    var control = {
      scope: group.scope,
      context: group.context,
      wrapper: wrapper,
      button: button,
      cancelButton: cancelButton,
      label: label,
      count: count,
      badge: badge,
      group: group,
      restorableCount: 0,
      lastPointerType: "",
      tuckTimer: null,
    };

    cancelButton.addEventListener("click", function (event) {
      event.stopPropagation();
      clearPreview();
      wrapper.classList.add("is-compact");
      button.blur();
    });

    if (window.PointerEvent) {
      button.addEventListener("pointerdown", function (event) {
        control.lastPointerType = event.pointerType || "";
      });

      button.addEventListener("pointerenter", function (event) {
        if (event.pointerType === "touch") return;
        startPreview(control, false);
      });

      button.addEventListener("pointerleave", function (event) {
        if (event.pointerType === "touch") return;
        if (
          activePreview &&
          activePreview.control === control &&
          !activePreview.sticky
        ) {
          clearPreview();
        }
      });
    } else {
      button.addEventListener(
        "touchstart",
        function () {
          control.lastPointerType = "touch";
        },
        { passive: true },
      );

      button.addEventListener("mouseenter", function () {
        if (control.lastPointerType === "touch" || isCoarsePointer()) return;
        startPreview(control, false);
      });

      button.addEventListener("mouseleave", function () {
        if (
          activePreview &&
          activePreview.control === control &&
          !activePreview.sticky
        ) {
          clearPreview();
        }
      });
    }

    button.addEventListener("focus", function () {
      if (control.lastPointerType === "touch") return;

      var isKeyboardFocus = false;
      try {
        isKeyboardFocus = button.matches(":focus-visible");
      } catch (error) {
        isKeyboardFocus = !isCoarsePointer();
      }

      if (isKeyboardFocus) startPreview(control, false);
    });

    button.addEventListener("blur", function () {
      if (
        activePreview &&
        activePreview.control === control &&
        !activePreview.sticky
      ) {
        clearPreview();
      }
    });

    button.addEventListener("click", function () {
      var isTouchTap =
        control.lastPointerType === "touch" ||
        (!control.lastPointerType && isCoarsePointer());
      control.lastPointerType = "";

      // On touch devices, Tap 1 peeks/previews the saved fields; Tap 2 applies.
      if (
        isTouchTap &&
        !(
          activePreview &&
          activePreview.control === control &&
          activePreview.sticky
        )
      ) {
        startPreview(control, true);
        return;
      }

      clearPreview();
      restoreDraft(control.group);
    });

    wrapper.appendChild(cancelButton);
    wrapper.appendChild(button);
    dock.appendChild(wrapper);

    // Pop in expanded so the user immediately notices it, then tuck into a
    // compact corner button so it stays out of the way of forms.
    control.tuckTimer = setTimeout(function () {
      control.tuckTimer = null;
      if (document.body.contains(wrapper)) {
        wrapper.classList.add("is-compact");
      }
    }, CONFIG.AUTO_TUCK_MS);

    return control;
  }

  function renderRestoreControls() {
    if (!document.body || !store) return;

    // While a live field preview is active, the inputs temporarily hold ghost
    // values. Keep the control intact as long as its previewed fields remain
    // visible; otherwise clear the stale preview and re-render.
    if (activePreview) {
      var stillVisible = activePreview.entries.some(function (entry) {
        return isFieldVisible(entry.field);
      });
      if (stillVisible) return;
      clearPreview();
    }

    var groups = collectRestoreGroups();
    var activeControls = [];

    // Discard controls whose DOM nodes were removed externally.
    restoreControls = restoreControls.filter(function (control) {
      if (!document.body.contains(control.wrapper)) {
        if (control.tuckTimer) clearTimeout(control.tuckTimer);
        return false;
      }
      activeControls.push(control);
      return true;
    });

    groups.forEach(function (group) {
      var restorable = getRestorableFields(group);
      var visible =
        restorable.length > 0 && hasVisibleRestorableField(restorable);
      var control = null;

      for (var i = 0; i < activeControls.length; i++) {
        if (
          activeControls[i].scope === group.scope &&
          activeControls[i].context === group.context
        ) {
          control = activeControls[i];
          break;
        }
      }

      if (!visible) {
        if (control) {
          removeControl(control);
          restoreControls = restoreControls.filter(function (item) {
            return item !== control;
          });
        }
        return;
      }

      if (!control) {
        control = createRestoreControl(group);
        if (!control) return;
        restoreControls.push(control);
        activeControls.push(control);
      }

      control.group = group;
      control.restorableCount = restorable.length;

      // Avoid replacing text when it has not changed to prevent unnecessary
      // DOM mutations.
      var countText =
        restorable.length === 1
          ? "1 saved field"
          : restorable.length + " saved fields";
      if (control.count.textContent !== countText) {
        control.count.textContent = countText;
      }

      var badgeText = String(restorable.length);
      if (control.badge.textContent !== badgeText) {
        control.badge.textContent = badgeText;
      }

      var ariaLabel = "Restore draft: " + countText;
      if (control.button.getAttribute("aria-label") !== ariaLabel) {
        control.button.setAttribute("aria-label", ariaLabel);
      }
    });

    // Remove any control whose matching form/context no longer exists.
    restoreControls = restoreControls.filter(function (control) {
      var stillExists = groups.some(function (group) {
        return (
          group.scope === control.scope && group.context === control.context
        );
      });

      if (!stillExists) removeControl(control);

      return stillExists;
    });
  }

  function restoreDraft(group) {
    clearPreview();

    var currentFields = collectRestoreGroups();
    var liveGroup = null;

    for (var i = 0; i < currentFields.length; i++) {
      if (
        currentFields[i].scope === group.scope &&
        currentFields[i].context === group.context
      ) {
        liveGroup = currentFields[i];
        break;
      }
    }

    if (!liveGroup) return;

    var restorable = getRestorableFields(liveGroup);
    if (!restorable.length) {
      renderRestoreControls();
      return;
    }

    // Restoring a draft is an explicit user action. Keep the leave-page
    // warning active even when a saved select option needs time to load.
    hasUserChanges = true;
    var restoredAtLeastOne = false;
    var restoredCount = restorable.length;

    restorable.forEach(function (item) {
      var field = item.field;
      var value = item.value;

      if (field.tagName.toUpperCase() === "SELECT") {
        var optionExists = false;

        for (var j = 0; j < field.options.length; j++) {
          if (field.options[j].value === value) {
            optionExists = true;
            break;
          }
        }

        if (optionExists) {
          restoredAtLeastOne = applyValue(field, value) || restoredAtLeastOne;
        } else {
          waitForOption(field, value, function (available) {
            if (available) {
              applyValue(field, value);
              hasUserChanges = true;
              renderRestoreControls();
            }
          });
        }
      } else {
        restoredAtLeastOne = applyValue(field, value) || restoredAtLeastOne;
      }
    });

    if (restoredAtLeastOne) hasUserChanges = true;

    // The button disappears once the saved values have been restored.
    renderRestoreControls();
    showRestoredFeedback(restoredCount);
  }

  // Cancel any active preview immediately before outside interactions or submits.
  function dismissPreviewOnOutsideAction(event) {
    if (!activePreview) return;
    if (isInternalAutosaveNode(event.target)) return;

    var prevControl = activePreview.control;
    clearPreview();

    if (prevControl && prevControl.wrapper) {
      prevControl.wrapper.classList.add("is-compact");
    }
  }

  document.addEventListener("pointerdown", dismissPreviewOnOutsideAction, true);
  document.addEventListener("focusin", dismissPreviewOnOutsideAction, true);
  document.addEventListener(
    "submit",
    function () {
      if (activePreview) clearPreview();
    },
    true,
  );
  document.addEventListener("keydown", function (event) {
    if (!activePreview) return;
    if (event.key === "Escape" || event.key === "Esc") {
      var prevControl = activePreview.control;
      clearPreview();
      if (prevControl && prevControl.wrapper) {
        prevControl.wrapper.classList.add("is-compact");
        if (prevControl.button) prevControl.button.blur();
      }
    }
  });

  function injectStyles() {
    if (document.getElementById("autosaveRestoreStyles")) return;

    var style = document.createElement("style");
    style.id = "autosaveRestoreStyles";
    style.textContent = [
      "@keyframes autosavePopIn {",
      "  0% { opacity: 0; transform: translateY(16px) scale(0.65); }",
      "  70% { opacity: 1; transform: translateY(-2px) scale(1.04); }",
      "  100% { opacity: 1; transform: translateY(0) scale(1); }",
      "}",
      "@keyframes autosavePulseRing {",
      "  0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.58); }",
      "  100% { box-shadow: 0 0 0 14px rgba(99, 102, 241, 0); }",
      "}",
      "@keyframes autosaveToastIn {",
      "  0% { opacity: 0; transform: translateY(10px) scale(0.92); }",
      "  100% { opacity: 1; transform: translateY(0) scale(1); }",
      "}",
      ".autosave-restore-dock {",
      "  position: fixed;",
      "  right: 20px;",
      "  bottom: 20px;",
      "  z-index: 2147483600;",
      "  display: flex;",
      "  flex-direction: column;",
      "  align-items: flex-end;",
      "  gap: 10px;",
      "  pointer-events: none;",
      "  font-family: inherit;",
      "}",
      ".autosave-restore-row {",
      "  pointer-events: auto;",
      "  display: inline-flex;",
      "  align-items: center;",
      "  gap: 8px;",
      "  animation: autosavePopIn 420ms cubic-bezier(0.34, 1.56, 0.64, 1) both;",
      "}",
      ".autosave-restore-cancel {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  width: 0;",
      "  height: 36px;",
      "  padding: 0;",
      "  margin-right: -8px;",
      "  border: 0;",
      "  border-radius: 999px;",
      "  background: rgba(15, 23, 42, 0.84);",
      "  color: #ffffff;",
      "  cursor: pointer;",
      "  opacity: 0;",
      "  overflow: hidden;",
      "  pointer-events: none;",
      "  transform: scale(0.6);",
      "  box-shadow: 0 8px 18px -6px rgba(15, 23, 42, 0.45);",
      "  transition: width 220ms cubic-bezier(0.22, 1, 0.36, 1), margin-right 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), background 160ms ease;",
      "  -webkit-tap-highlight-color: transparent;",
      "}",
      ".autosave-restore-cancel:active {",
      "  transform: scale(0.92);",
      "}",
      ".autosave-restore-row.is-touch-preview .autosave-restore-cancel {",
      "  width: 36px;",
      "  margin-right: 0;",
      "  opacity: 1;",
      "  pointer-events: auto;",
      "  transform: scale(1);",
      "}",
      ".autosave-restore-button {",
      "  position: relative;",
      "  display: inline-flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  height: 46px;",
      "  min-width: 46px;",
      "  padding: 0 16px 0 12px;",
      "  border: 1px solid rgba(255, 255, 255, 0.22);",
      "  border-radius: 999px;",
      "  background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%);",
      "  color: #ffffff;",
      "  font: inherit;",
      "  cursor: pointer;",
      "  box-shadow: 0 10px 24px -6px rgba(67, 56, 202, 0.48), 0 4px 10px -4px rgba(15, 23, 42, 0.22);",
      "  transition: padding 260ms cubic-bezier(0.22, 1, 0.36, 1), transform 180ms ease, box-shadow 200ms ease, background 180ms ease;",
      "  -webkit-tap-highlight-color: transparent;",
      "}",
      ".autosave-restore-button::after {",
      "  content: '';",
      "  position: absolute;",
      "  inset: 0;",
      "  border-radius: inherit;",
      "  pointer-events: none;",
      "  animation: autosavePulseRing 1150ms cubic-bezier(0.22, 1, 0.36, 1) 250ms 2;",
      "}",
      ".autosave-restore-row.is-previewing .autosave-restore-button {",
      "  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);",
      "  box-shadow: 0 14px 28px -6px rgba(67, 56, 202, 0.56), 0 0 0 3px rgba(129, 140, 248, 0.34);",
      "}",
      ".autosave-restore-button:active {",
      "  transform: translateY(0) scale(0.96);",
      "}",
      ".autosave-restore-button:focus-visible {",
      "  outline: 3px solid rgba(99, 102, 241, 0.42);",
      "  outline-offset: 3px;",
      "}",
      ".autosave-restore-icon {",
      "  flex: 0 0 22px;",
      "  width: 22px;",
      "  height: 22px;",
      "  display: inline-flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "  transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1);",
      "}",
      ".autosave-restore-row.is-previewing .autosave-restore-icon {",
      "  transform: rotate(-28deg);",
      "}",
      ".autosave-restore-reveal {",
      "  display: grid;",
      "  grid-template-columns: 1fr;",
      "  margin-left: 9px;",
      "  opacity: 1;",
      "  transition: grid-template-columns 260ms cubic-bezier(0.22, 1, 0.36, 1), margin-left 260ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease;",
      "}",
      ".autosave-restore-content {",
      "  overflow: hidden;",
      "  min-width: 0;",
      "  display: flex;",
      "  flex-direction: column;",
      "  align-items: flex-start;",
      "  white-space: nowrap;",
      "  text-align: left;",
      "}",
      ".autosave-restore-label {",
      "  font-size: 13px;",
      "  font-weight: 600;",
      "  line-height: 1.2;",
      "  letter-spacing: 0.01em;",
      "}",
      ".autosave-restore-count {",
      "  font-size: 11px;",
      "  font-weight: 500;",
      "  line-height: 1.2;",
      "  color: rgba(224, 231, 255, 0.92);",
      "  margin-top: 1px;",
      "}",
      ".autosave-restore-badge {",
      "  position: absolute;",
      "  top: -5px;",
      "  right: -5px;",
      "  min-width: 20px;",
      "  height: 20px;",
      "  padding: 0 5px;",
      "  box-sizing: border-box;",
      "  border-radius: 999px;",
      "  border: 2px solid #ffffff;",
      "  background: #10b981;",
      "  color: #ffffff;",
      "  font-size: 11px;",
      "  font-weight: 700;",
      "  line-height: 16px;",
      "  text-align: center;",
      "  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.25);",
      "  transform: scale(0.4);",
      "  opacity: 0;",
      "  pointer-events: none;",
      "  transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 180ms ease;",
      "}",
      ".autosave-restore-row.is-compact:not(.is-previewing) .autosave-restore-button {",
      "  padding: 0 12px;",
      "}",
      ".autosave-restore-row.is-compact:not(.is-previewing) .autosave-restore-reveal {",
      "  grid-template-columns: 0fr;",
      "  margin-left: 0;",
      "  opacity: 0;",
      "}",
      ".autosave-restore-row.is-compact:not(.is-previewing) .autosave-restore-badge {",
      "  transform: scale(1);",
      "  opacity: 1;",
      "}",
      "@media (hover: hover) and (pointer: fine) {",
      "  .autosave-restore-button:hover {",
      "    background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);",
      "    transform: translateY(-2px);",
      "    box-shadow: 0 14px 28px -6px rgba(67, 56, 202, 0.56), 0 6px 14px -4px rgba(15, 23, 42, 0.24);",
      "  }",
      "  .autosave-restore-button:hover .autosave-restore-icon {",
      "    transform: rotate(-28deg);",
      "  }",
      "  .autosave-restore-row.is-compact:hover .autosave-restore-button {",
      "    padding: 0 16px 0 12px;",
      "  }",
      "  .autosave-restore-row.is-compact:hover .autosave-restore-reveal {",
      "    grid-template-columns: 1fr;",
      "    margin-left: 9px;",
      "    opacity: 1;",
      "  }",
      "  .autosave-restore-row.is-compact:hover .autosave-restore-badge {",
      "    transform: scale(0.4);",
      "    opacity: 0;",
      "  }",
      "}",
      ".autosave-field-preview {",
      "  background-color: rgba(99, 102, 241, 0.08) !important;",
      "  border-color: #6366f1 !important;",
      "  border-style: dashed !important;",
      "  color: #4338ca !important;",
      "  font-style: italic !important;",
      "  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.16) !important;",
      "  transition: background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, color 180ms ease !important;",
      "}",
      ".autosave-field-preview-pending {",
      "  border-color: #818cf8 !important;",
      "  border-style: dashed !important;",
      "  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.14) !important;",
      "}",
      ".autosave-field-preview-check {",
      "  accent-color: #6366f1 !important;",
      "  outline: 2px dashed #6366f1 !important;",
      "  outline-offset: 2px !important;",
      "  box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.18) !important;",
      "  opacity: 0.78 !important;",
      "}",
      ".autosave-restored-toast {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  gap: 7px;",
      "  padding: 9px 14px;",
      "  border-radius: 999px;",
      "  background: #059669;",
      "  color: #ffffff;",
      "  font-size: 13px;",
      "  font-weight: 600;",
      "  line-height: 1.2;",
      "  box-shadow: 0 10px 22px -6px rgba(5, 150, 105, 0.48), 0 4px 10px -4px rgba(15, 23, 42, 0.2);",
      "  animation: autosaveToastIn 240ms cubic-bezier(0.22, 1, 0.36, 1) both;",
      "  transition: opacity 220ms ease, transform 220ms ease;",
      "}",
      ".autosave-restored-toast.is-leaving {",
      "  opacity: 0;",
      "  transform: translateY(6px) scale(0.95);",
      "}",
      ".autosave-restored-check {",
      "  display: inline-flex;",
      "  align-items: center;",
      "  justify-content: center;",
      "}",
      "@media (max-width: 600px) {",
      "  .autosave-restore-dock {",
      "    right: 14px;",
      "    bottom: 14px;",
      "  }",
      "}",
      "@media (prefers-reduced-motion: reduce) {",
      "  .autosave-restore-row,",
      "  .autosave-restore-button::after,",
      "  .autosave-restored-toast {",
      "    animation: none;",
      "  }",
      "  .autosave-restore-button,",
      "  .autosave-restore-cancel,",
      "  .autosave-restore-icon,",
      "  .autosave-restore-reveal,",
      "  .autosave-restore-badge,",
      "  .autosave-field-preview,",
      "  .autosave-restored-toast {",
      "    transition: none;",
      "  }",
      "}",
    ].join("\n");

    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Warn before leaving the page
  // ---------------------------------------------------------------------------

  window.addEventListener("beforeunload", function (event) {
    if (!hasUserChanges) return;

    event.preventDefault();
    event.returnValue = "";
    return "";
  });

  // ---------------------------------------------------------------------------
  // Clear drafts after successful API submissions
  // ---------------------------------------------------------------------------

  var originalFetch = window.fetch;

  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      var promise = originalFetch.apply(this, arguments);

      try {
        var url =
          typeof input === "string" ? input : (input && input.url) || "";
        var requestMethod =
          (init && init.method) ||
          (input && typeof input !== "string" && input.method) ||
          "GET";
        var method = String(requestMethod).toUpperCase();

        var isSubmit =
          CONFIG.API_SUBMIT_PATTERN.test(url) &&
          ["POST", "PUT", "DELETE"].indexOf(method) !== -1;

        if (isSubmit) {
          promise
            .then(function (response) {
              if (!response || !response.ok) return;

              response
                .clone()
                .json()
                .then(function (body) {
                  if (!body || body.success !== false) clearPageDrafts();
                })
                .catch(function () {
                  clearPageDrafts();
                });
            })
            .catch(function () {});
        }
      } catch (error) {
        // Do not interfere with the original fetch request.
      }

      return promise;
    };
  }

  // ---------------------------------------------------------------------------
  // Initialization and dynamic forms/modals
  // ---------------------------------------------------------------------------

  function isInternalAutosaveNode(node) {
    if (!node) return false;
    if (node.nodeType === 3) node = node.parentElement;
    if (!node || !node.closest) return false;

    return !!(
      node.closest(".autosave-restore-dock") ||
      node.closest(".autosave-restore-row")
    );
  }

  function initialize() {
    injectStyles();
    ensureRestoreDock();
    renderRestoreControls();

    // Forms or modal contents may be inserted after this script runs.
    domObserver = new MutationObserver(function (mutations) {
      // Ignore mutations made inside our own Restore Draft UI. Otherwise an
      // update to the button can cause the observer to update that same
      // button repeatedly.
      var hasExternalMutation = mutations.some(function (mutation) {
        if (isInternalAutosaveNode(mutation.target)) return false;

        if (mutation.type === "childList") {
          var changedNodes = Array.prototype.slice
            .call(mutation.addedNodes)
            .concat(Array.prototype.slice.call(mutation.removedNodes));

          if (
            changedNodes.length &&
            changedNodes.every(isInternalAutosaveNode)
          ) {
            return false;
          }
        }

        return true;
      });

      if (hasExternalMutation) renderRestoreControls();
    });

    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
  }

  if (document.body) {
    initialize();
  } else {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  }

  // Public helpers retained for compatibility with existing code.
  window.AutoSaveForm = {
    clear: clearPageDrafts,
    clearAll: function () {
      if (!store) return;

      try {
        store.removeItem(CONFIG.PREFIX + "index");
      } catch (error) {}

      hasUserChanges = false;
      removeAllRestoreControls();
    },
  };
})();
