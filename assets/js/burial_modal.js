const BurialModal = (() => {
    let modalEl = null;
    let loadPromise = null;
    let currentMode = "view";
    let activeRecordId = null;
    let takenControlNos = [];

    function isValidControlNo(value) {
        const v = String(value || "").trim().toUpperCase();
        return v.length > 0 && /^[A-Z0-9-]+$/.test(v);
    }

    function controlNoExists(value) {
        const v = String(value || "").trim().toUpperCase();
        return takenControlNos.some(n => String(n).trim().toUpperCase() === v);
    }

    function generateControlNo() {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        for (let attempt = 0; attempt < 1000; attempt++) {
            let code = "";
            for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * 26)];
            code += "-";
            for (let i = 0; i < 4; i++) code += Math.floor(Math.random() * 10);
            if (!controlNoExists(code)) return code;
        }
        return "";
    }

    function formatControlNoInput(value) {
        return String(value || "").toUpperCase();
    }

    function generateGraveCode() {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const letter = letters[Math.floor(Math.random() * 26)];
        const num = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0");
        return `${letter}-${num}`;
    }

    function formatGraveCodeInput(value) {
        return String(value || "").toUpperCase();
    }

    function todayISO() {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return local.toISOString().split("T")[0];
    }

    function addYears(isoDate, years) {
        if (!isoDate || isoDate === "N/A" || isoDate === "Pending") return "";
        const d = new Date(`${isoDate}T00:00:00`);
        if (Number.isNaN(d.getTime())) return "";
        d.setFullYear(d.getFullYear() + years);
        return d.toISOString().split("T")[0];
    }

    function formatPhoneValue(raw) {
        let digits = String(raw || "").replace(/\D/g, "");
        if (digits.startsWith("63")) digits = digits.slice(2);
        if (digits.startsWith("0")) digits = digits.slice(1);
        digits = digits.slice(0, 10);

        let out = "+63";
        if (digits.length > 0) out += " " + digits.slice(0, 3);
        if (digits.length > 3) out += " " + digits.slice(3, 6);
        if (digits.length > 6) out += " " + digits.slice(6, 10);
        return out;
    }

    function formatNameValue(raw) {
        if (!raw) return "";
        return raw.replace(/[^\p{L}\s'.-]/gu, "");
    }

    function pick(...values) {
        for (const v of values) {
            if (v === null || v === undefined) continue;
            const s = String(v).trim();
            if (s !== "" && s !== "N/A") return s;
        }
        return "";
    }

    async function ensureLoaded() {
        modalEl = document.getElementById("burial_modal_overlay");
        if (modalEl) {
            bindEvents();
            return;
        }

        if (!loadPromise) loadPromise = loadModalHtml();
        await loadPromise;

        modalEl = document.getElementById("burial_modal_overlay");
        if (modalEl) bindEvents();
    }

    async function loadModalHtml() {
        const paths = ["burial_modal.html", "assets/html/burial_modal.html"];
        let html = null;

        for (const path of paths) {
            try {
                const res = await fetch(path);
                if (res.ok) { html = await res.text(); break; }
            } catch (_) {}
        }

        if (!html) {
            console.error("Failed to load burial_modal.html.");
            return;
        }

        const parsed = new DOMParser().parseFromString(html, "text/html");
        const fragment = parsed.getElementById("burial_modal_overlay");
        if (!fragment) {
            console.error("burial_modal.html did not contain #burial_modal_overlay.");
            return;
        }

        document.body.appendChild(document.adoptNode(fragment));
    }

    function bindEvents() {
        if (!modalEl || modalEl.dataset.bound === "true") return;
        modalEl.dataset.bound = "true";

        const cancelBtn = modalEl.querySelector(".paperCancelBtn");
        if (cancelBtn) cancelBtn.addEventListener("click", close);

        modalEl.addEventListener("click", (e) => {
            if (e.target === modalEl) close();
        });

        const form = modalEl.querySelector("#burial_clearance_form");
        if (form) form.addEventListener("submit", handleSubmit);

        const dateInterment = modalEl.querySelector("#date_interment");
        if (dateInterment) {
            dateInterment.addEventListener("change", () => {
                const exp = modalEl.querySelector("#expiration_date");
                if (exp) exp.value = addYears(dateInterment.value, 5);
            });
        }

        const phone = modalEl.querySelector("#req_phone");
        if (phone) {
            phone.addEventListener("input", (e) => {
                e.target.value = formatPhoneValue(e.target.value);
            });
            phone.addEventListener("blur", (e) => {
                if (!e.target.value) e.target.value = "+63";
            });
        }

        ["req_name", "deceased_name"].forEach((id) => {
            const field = modalEl.querySelector(`#${id}`);
            if (field) {
                field.addEventListener("input", (e) => {
                    e.target.value = formatNameValue(e.target.value);
                });
            }
        });

        const controlNo = modalEl.querySelector("#control_no");
        if (controlNo) {
            controlNo.addEventListener("input", (e) => {
                e.target.value = formatControlNoInput(e.target.value);
            });
        }

        const graveCode = modalEl.querySelector("#grave_code");
        if (graveCode) {
            graveCode.addEventListener("input", (e) => {
                e.target.value = formatGraveCodeInput(e.target.value);
            });
        }
    }

    async function open(mode = "view", data = {}, options = {}) {
        await ensureLoaded();
        if (!modalEl) return;

        currentMode = mode;
        activeRecordId = data.id || null;
        takenControlNos = Array.isArray(options.takenControlNos)
            ? options.takenControlNos.map(n => String(n).trim().toUpperCase())
            : [];

        const form = modalEl.querySelector("#burial_clearance_form");
        if (form) form.reset();

        modalEl.classList.toggle("view-mode", mode === "view");

        const d = { ...data };
        if (mode === "add") {
            if (!pick(d.control_no, d.controlNo)) d.control_no = generateControlNo();
            if (!pick(d.clearance_date, d.clearanceDate)) d.clearance_date = todayISO();
            if (!pick(d.grave_code, d.graveCode)) d.grave_code = generateGraveCode();
            if (!pick(d.req_phone, d.contactPhone)) d.req_phone = "+63";
        }

        populateFields(d);
        setEditable(mode !== "view");

        modalEl.style.display = "block";
        modalEl.classList.add("active");
    }

    function populateFields(data) {
        const isView = currentMode === "view";

        const setFieldValue = (id, val) => {
            const field = modalEl.querySelector(`#${id}`);
            if (!field) return;

            let strVal = pick(val);

            if (isView && strVal === "") strVal = "-";

            if (field.tagName === "SELECT") {
                const stale = field.querySelector('option[data-placeholder="true"]');
                if (stale) stale.remove();

                let matched = Array.from(field.options).find(
                    opt => opt.value === strVal || opt.text === strVal
                );
                if (!matched && strVal) {
                    const lower = strVal.toLowerCase();
                    matched = Array.from(field.options).find(opt =>
                        opt.value.toLowerCase() === lower ||
                        opt.text.toLowerCase().includes(lower) ||
                        lower.includes(opt.value.toLowerCase())
                    );
                }
                if (matched) {
                    field.value = matched.value;
                } else if (strVal) {
                    const opt = document.createElement("option");
                    opt.value = strVal;
                    opt.textContent = strVal;
                    if (strVal === "-") opt.dataset.placeholder = "true";
                    field.appendChild(opt);
                    field.value = strVal;
                }
            } else {
                field.value = strVal;
            }
        };

        setFieldValue("clearance_date", pick(data.clearance_date, data.clearanceDate, data.control_date));
        setFieldValue("control_no",     pick(data.control_no,     data.controlNo));

        setFieldValue("req_name", pick(data.req_name, data.contactName, data.applicant_full_name));

        const rawPhone = pick(data.req_phone, data.contactPhone, data.phone_number);
        if (rawPhone) {
            setFieldValue("req_phone", formatPhoneValue(rawPhone));
        } else {
            setFieldValue("req_phone", isView ? "" : "+63");
        }

        const rawBrgy = pick(data.barangay, data.barangay_address, data.requesting_barangay);
        setFieldValue("requesting_barangay", rawBrgy.replace(/^(Barangay|Brgy\.)\s*/i, "").trim());

        if (pick(data.purokStreet, data.purok_zone_street)) {
            setFieldValue("req_street", pick(data.purokStreet, data.purok_zone_street));
        } else if (pick(data.contactAddress, data.req_street)) {
            const parts = pick(data.contactAddress, data.req_street).split(",");
            setFieldValue("req_street", parts[0].trim());
        } else {
            setFieldValue("req_street", "");
        }

        const rawAssist = pick(data.assistance, data.assistance_type, data.req_assistance);
        let mappedAssist = rawAssist;
        if (/burial/i.test(rawAssist)) mappedAssist = "Burial of the late";
        else if (/transfer|exhumation/i.test(rawAssist))
            mappedAssist = "Transfer the remains of the late to the bone chamber";
        setFieldValue("req_assistance", mappedAssist);

        setFieldValue("deceased_name",    pick(data.deceased_name, data.name));
        setFieldValue("deceased_sex",     pick(data.deceased_sex,  data.sex));
        setFieldValue("deceased_dob",     pick(data.deceased_dob,  data.dob, data.deceased_date_of_birth));
        setFieldValue("deceased_bod",     pick(data.deceased_bod,  data.dod, data.deceased_date_of_death));
        setFieldValue("deceased_address", pick(data.deceased_address, data.address, data.last_known_address));
        setFieldValue("deceased_cert",    pick(data.deceased_cert, data.certNo, data.death_certificate_no));

        setFieldValue("permit_burial",     pick(data.permit_burial,     data.permitBurial,     data.burial_permit_no));
        setFieldValue("permit_exhumation", pick(data.permit_exhumation, data.permitExhumation, data.exhumation_permit_no));
        setFieldValue("permit_transfer",   pick(data.permit_transfer,   data.permitTransfer,   data.transfer_permit_no));

        const rawType = pick(data.burialType, data.burial_type, data.burial_block);
        let mappedType = rawType;
        if (/niche|wall/i.test(rawType)) mappedType = "Niche Wall";
        else if (/bone/i.test(rawType)) mappedType = "Bone Chamber";
        else if (/lawn|ground|standard/i.test(rawType)) mappedType = "Lawn / Grounds";
        setFieldValue("burial_block", mappedType);

        setFieldValue("block",            pick(data.block, data.blockName));
        setFieldValue("grave_code",       pick(data.grave_code, data.graveCode));
        setFieldValue("date_interment",   pick(data.date_interment, data.dateInterment, data.date_of_interment));
        setFieldValue("expiration_date",  pick(data.expiration_date, data.expiration));
        setFieldValue("deceased_remarks", pick(data.deceased_remarks, data.remarks));
    }

    function setEditable(editable) {
        const inputs = modalEl.querySelectorAll("input, select, textarea");
        inputs.forEach((el) => {
            if (el.id === "expiration_date") {
                el.disabled = true;
            } else {
                el.disabled = !editable;
            }
        });

        const controlNo = modalEl.querySelector("#control_no");
        if (controlNo) {
            controlNo.readOnly = !editable;
        }

        const saveBtn = modalEl.querySelector(".paperSaveBtn");
        if (saveBtn) saveBtn.style.display = editable ? "inline-block" : "none";

        const cancelBtn = modalEl.querySelector(".paperCancelBtn");
        if (cancelBtn) cancelBtn.textContent = editable ? "Cancel" : "Close";
    }

    function handleSubmit(e) {
        e.preventDefault();

        const phoneRaw = modalEl.querySelector("#req_phone")?.value.trim() || "";
        const phoneDigits = phoneRaw.replace(/\D/g, "").replace(/^63/, "");
        if (phoneDigits.length !== 10) {
            alert("Phone number must be in the format +63 XXX XXX XXXX (10 digits after +63).");
            return;
        }

        const controlNoField = modalEl.querySelector("#control_no");
        const controlNo = (controlNoField?.value || "").trim().toUpperCase();
        if (!isValidControlNo(controlNo)) {
            alert("Please enter a valid Control No. (letters, numbers and dashes only).");
            controlNoField?.focus();
            return;
        }

        if (controlNoExists(controlNo)) {
            alert(`Control No. "${controlNo}" is already used by another record. Please enter a different one.`);
            controlNoField?.focus();
            return;
        }

        const street   = modalEl.querySelector("#req_street")?.value.trim() || "";
        const barangay = modalEl.querySelector("#requesting_barangay")?.value || "";
        const contactAddr = barangay ? `${street}, Brgy. ${barangay}` : street;

        const formData = {
            id: activeRecordId,
            clearance_date:      modalEl.querySelector("#clearance_date")?.value || "",
            control_no:          controlNo,
            req_name:            modalEl.querySelector("#req_name")?.value.trim() || "",
            req_phone:           phoneRaw,
            req_street:          street,
            requesting_barangay: barangay,
            contactAddress:      contactAddr,
            req_assistance:      modalEl.querySelector("#req_assistance")?.value || "",

            deceased_name:    modalEl.querySelector("#deceased_name")?.value.trim() || "",
            deceased_sex:     modalEl.querySelector("#deceased_sex")?.value || "",
            deceased_dob:     modalEl.querySelector("#deceased_dob")?.value || "",
            deceased_address: modalEl.querySelector("#deceased_address")?.value.trim() || "",
            deceased_bod:     modalEl.querySelector("#deceased_bod")?.value || "",
            deceased_cert:    modalEl.querySelector("#deceased_cert")?.value.trim() || "",
            deceased_remarks: modalEl.querySelector("#deceased_remarks")?.value.trim() || "",

            permit_burial:     modalEl.querySelector("#permit_burial")?.value.trim() || "",
            permit_exhumation: modalEl.querySelector("#permit_exhumation")?.value.trim() || "",
            permit_transfer:   modalEl.querySelector("#permit_transfer")?.value.trim() || "",

            burial_type:   modalEl.querySelector("#burial_block")?.value || "",
            block:         modalEl.querySelector("#block")?.value.trim() || "",
            grave_code:    modalEl.querySelector("#grave_code")?.value.trim() || "",
            date_interment:  modalEl.querySelector("#date_interment")?.value || "",
            expiration_date: modalEl.querySelector("#expiration_date")?.value || "",
        };

        document.dispatchEvent(new CustomEvent("burial_modal:save", {
            detail: { mode: currentMode, data: formData },
        }));

        close();
    }

    function close() {
        if (!modalEl) return;
        modalEl.style.display = "none";
        modalEl.classList.remove("active");
    }

    return { open, close };
})();

window.BurialModal = BurialModal;
window.closeSeamlessModal = () => BurialModal.close();