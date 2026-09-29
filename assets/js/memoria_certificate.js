/**
 * Generates and prints a compact, single-page Memoria Certificate.
 * Cross-browser safe (Chrome, Firefox, Safari, Edge).
 * @param {number|string} id - The Interment ID or Record ID.
 */
async function memoria_certificate(id) {
  try {
    // 1. Fetch data in parallel
    const [recordRes, settingsRes] = await Promise.all([
      fetch(`api/records/${id}`, { cache: "no-store" }),
      fetch(`api/settings`, { cache: "no-store" }),
    ]);

    if (!recordRes.ok || !settingsRes.ok) {
      throw new Error("Failed to fetch API data.");
    }

    const recordJson = await recordRes.json();
    const settingsJson = await settingsRes.json();

    if (!recordJson.success || !recordJson.data.interments.length) {
      alert("Interment record not found.");
      return;
    }

    // 2. Parse Record Data (fallback to em-dash)
    const record = recordJson.data.interments[0];
    const val = (v) => (v !== null && v !== undefined && v !== "" ? v : "—");

    // 3. Parse Settings Data
    const sMap = {};
    if (settingsJson.success && Array.isArray(settingsJson.data)) {
      settingsJson.data.forEach((s) => {
        sMap[s.setting_key] = s.setting_value;
      });
    }
    const cemeteryName =
      (sMap["cemetery_name"] || "").trim() || "Mandaue City Public Cemetery";

    // 4. Date Formatters
    const formatDate = (dateStr) => {
      if (!dateStr || dateStr === "-") return "—";
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    };

    const today = new Date();
    const day = today.getDate();
    const getOrdinal = (n) => {
      if (n > 3 && n < 21) return "th";
      switch (n % 10) {
        case 1:
          return "st";
        case 2:
          return "nd";
        case 3:
          return "rd";
        default:
          return "th";
      }
    };
    const month = today.toLocaleDateString("en-US", { month: "long" });
    const year = today.getFullYear();
    const issuedDateStr = `${day}${getOrdinal(day)} day of ${month}, ${year}`;

    // 5. Derived / Combined fields
    const contactAddress =
      [record.contact_person_address, record.contact_person_address_barangay]
        .filter(Boolean)
        .join(", ") || "—";

    const remarksText =
      [record.remarks, record.grave_remarks]
        .map((r) => (r || "").trim())
        .filter(Boolean)
        .join(" • ") || "—";

    // 6. Optional permit rows
    const extraPermitRows = [];
    if (record.transfer_permit_number || record.transfer_permit_date) {
      extraPermitRows.push(`
        <span class="dataLabel">Transfer Permit</span>
        <span class="dataValue">${val(record.transfer_permit_number)}</span>
        <span class="dataLabel">Transfer Date</span>
        <span class="dataValue">${formatDate(record.transfer_permit_date)}</span>
      `);
    }
    if (record.exhumation_permit_number || record.exhumation_permit_date) {
      extraPermitRows.push(`
        <span class="dataLabel">Exhumation Permit</span>
        <span class="dataValue">${val(record.exhumation_permit_number)}</span>
        <span class="dataLabel">Exhumation Date</span>
        <span class="dataValue">${formatDate(record.exhumation_permit_date)}</span>
      `);
    }

    // 7. Build signatories
    const signatories = [1, 2, 3, 4]
      .map((i) => ({
        name: (sMap[`people_name_${i}`] || "").trim(),
        title: (sMap[`people_title_${i}`] || "").trim(),
      }))
      .filter((p) => p.name !== "");

    const signatoryHtml = signatories.length
      ? signatories
          .map(
            (p) => `
            <div class="sigContainer">
              <div class="sigName">${p.name}</div>
              <div class="sigTitle">${p.title}</div>
            </div>`,
          )
          .join("")
      : "";

    // 8. Build HTML (NO auto-print script inside — parent drives the print)
    const htmlContent = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Memoria Certificate — ${val(record.control_number)}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; }

          body {
            font-family: 'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
            font-size: 11.5px;
            line-height: 1.4;
            color: #1f2937;
            background: #fff;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          @page { size: letter portrait; margin: 0; }

          .print-fixed-header { position: fixed; top: 0; left: 0; width: 100%; z-index: 1000; }
          .print-fixed-footer { position: fixed; bottom: 0; left: 0; width: 100%; z-index: 1000; }
          .reportHeaderImage,
          .reportFooterImage { width: 100%; height: auto; display: block; }

          .printPaginationTable { width: 100%; border-collapse: collapse; }
          .printPaginationTable thead { display: table-header-group; }
          .printPaginationTable tfoot { display: table-footer-group; }

          .print-header-spacer { height: 95px; }
          .print-footer-spacer { height: 110px; }

          .docBody { padding: 0 72px; }

          .certTitle {
            font-family: Georgia, 'Times New Roman', serif;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: 4px;
            text-transform: uppercase;
            text-align: center;
            color: #0f172a;
            margin: 0;
          }
          .certRule {
            border: 0;
            border-top: 3px double #94a3b8;
            margin: 6px 0 10px;
          }

          .certMeta {
            font-size: 12px;
            color: #475569;
            letter-spacing: 0.3px;
            margin-bottom: 10px;
          }
          .certMeta strong { color: #0f172a; font-weight: 600; }

          .certText { margin: 0 0 10px; }

          .dataGrid {
            display: grid;
            grid-template-columns: 118px 1fr 118px 1fr;
            column-gap: 12px;
            row-gap: 2px;
            padding: 7px 12px;
            background: #f8fafc;
            border-left: 3px solid #cbd5e1;
            margin-bottom: 9px;
            page-break-inside: avoid;
            font-size: 11px;
          }
          .dataLabel { color: #64748b; font-weight: 600; }
          .dataValue { color: #0f172a; font-weight: 600; word-break: break-word; }
          .span-3 { grid-column: span 3; }

          .sectionTitle {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 1.6px;
            text-transform: uppercase;
            color: #334155;
            margin: 0 0 3px;
          }

          .sigIntro { margin: 14px 0 0; }
          .signatorySection {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            column-gap: 8%;
            row-gap: 20px;
            margin-top: 22px;
            page-break-inside: avoid;
          }
          .sigContainer { flex: 0 0 40%; text-align: center; }
          .sigName {
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            color: #0f172a;
            border-bottom: 1px solid #1e293b;
            padding-bottom: 2px;
            margin-bottom: 3px;
          }
          .sigTitle {
            font-size: 10px;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.6px;
          }
        </style>
      </head>
      <body>

        <header class="print-fixed-header">
          <img class="reportHeaderImage" src="api/images/header.png" onerror="this.style.display='none'" />
        </header>

        <table class="printPaginationTable">
          <thead><tr><td><div class="print-header-spacer"></div></td></tr></thead>

          <tbody>
            <tr>
              <td>
                <div class="docBody">

                  <h1 class="certTitle">Memoria Certificate</h1>
                  <hr class="certRule" />

                  <div class="certMeta">
                    <strong>Control Number:</strong> ${val(record.control_number)}
                  </div>

                  <p class="certText">
                    <strong>To Whom It May Concern,</strong><br />
                    This is to certify that the records of this office contain an entry for the interment of:
                  </p>

                  <div class="sectionTitle">Deceased Information</div>
                  <div class="dataGrid">
                    <span class="dataLabel">Name of Deceased</span>
                    <span class="dataValue span-3">${val(record.deceased_name)}</span>

                    <span class="dataLabel">Date of Birth</span>
                    <span class="dataValue">${formatDate(record.deceased_date_of_birth)}</span>
                    <span class="dataLabel">Sex</span>
                    <span class="dataValue">${val(record.deceased_sex)}</span>

                    <span class="dataLabel">Date of Death</span>
                    <span class="dataValue">${formatDate(record.deceased_date_of_death)}</span>
                    <span class="dataLabel">Death Cert. No.</span>
                    <span class="dataValue">${val(record.death_certificate)}</span>

                    <span class="dataLabel">Last Known Address</span>
                    <span class="dataValue span-3">${val(record.last_known_address)}</span>
                  </div>

                  <div class="sectionTitle">Interment Details</div>
                  <div class="dataGrid">
                    <span class="dataLabel">Block / Section</span>
                    <span class="dataValue">${val(record.block_name)}</span>
                    <span class="dataLabel">Grave Code</span>
                    <span class="dataValue">${val(record.grave_code)}</span>

                    <span class="dataLabel">Date Buried</span>
                    <span class="dataValue">${formatDate(record.date_buried)}</span>
                    <span class="dataLabel">Status</span>
                    <span class="dataValue">${val(record.status)}</span>

                    <span class="dataLabel">Burial Permit No.</span>
                    <span class="dataValue">${val(record.burial_permit_number)}</span>
                    <span class="dataLabel">Permit Date</span>
                    <span class="dataValue">${formatDate(record.burial_permit_date)}</span>

                    <span class="dataLabel">Clearance Date</span>
                    <span class="dataValue">${formatDate(record.burial_clearance_date)}</span>
                    <span class="dataLabel">Assistance</span>
                    <span class="dataValue">${val(record.assistance_type)}</span>

                    <span class="dataLabel">Lease Expiration</span>
                    <span class="dataValue span-3">${formatDate(record.lease_expiration_date)}</span>

                    <span class="dataLabel">Remarks</span>
                    <span class="dataValue span-3">${remarksText}</span>

                    ${extraPermitRows.join("")}
                  </div>

                  <div class="sectionTitle">Next of Kin / Contact Person</div>
                  <div class="dataGrid">
                    <span class="dataLabel">Name</span>
                    <span class="dataValue">${val(record.contact_person_name)}</span>
                    <span class="dataLabel">Contact No.</span>
                    <span class="dataValue">${val(record.contact_person_phone_number)}</span>

                    <span class="dataLabel">Email</span>
                    <span class="dataValue span-3">${val(record.contact_person_email)}</span>

                    <span class="dataLabel">Address</span>
                    <span class="dataValue span-3">${contactAddress}</span>
                  </div>

                  <p class="certText" style="margin-top:12px;">
                    <em>This certificate is not a legal death certificate. It is simply a confirmation that the above details are recorded in our system.</em>
                  </p>
                  <p class="certText">
                    Issued this <strong>${issuedDateStr}</strong> at <strong>${cemeteryName}</strong>.
                  </p>

                  ${
                    signatories.length
                      ? `<p class="certText sigIntro"><strong>Certified by:</strong></p>
                         <div class="signatorySection">${signatoryHtml}</div>`
                      : ""
                  }

                </div>
              </td>
            </tr>
          </tbody>

          <tfoot><tr><td><div class="print-footer-spacer"></div></td></tr></tfoot>
        </table>

        <footer class="print-fixed-footer">
          <img class="reportFooterImage" src="api/images/footer.png" onerror="this.style.display='none'" />
        </footer>

      </body>
      </html>
    `;

    // 9. Create hidden iframe — REAL dimensions, parked OFF-SCREEN
    //    (0x0 iframes are ignored by Firefox's print pipeline)
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("title", "Memoria Certificate Print Frame");
    iframe.style.cssText =
      "position:fixed;" +
      "left:-10000px;" +
      "top:0;" +
      "width:8.5in;" +
      "height:11in;" +
      "border:0;" +
      "visibility:hidden;";
    document.body.appendChild(iframe);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };

    // 10. Write content into the iframe
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    if (!doc) throw new Error("Unable to access iframe document.");

    doc.open();
    doc.write(htmlContent);
    doc.close();

    // 11. Wait for images + fonts, then print
    const waitForImages = () =>
      new Promise((resolve) => {
        const imgs = Array.from(doc.images || []);
        if (imgs.length === 0) return resolve();
        let pending = imgs.length;
        const done = () => {
          if (--pending <= 0) resolve();
        };
        imgs.forEach((img) => {
          if (img.complete) done();
          else {
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          }
        });
        // Safety timeout in case an image hangs
        setTimeout(resolve, 3000);
      });

    const waitForFonts = async () => {
      try {
        if (doc.fonts && doc.fonts.ready) await doc.fonts.ready;
      } catch (_) {
        /* ignore */
      }
    };

    await Promise.all([waitForImages(), waitForFonts()]);

    // 12. Small buffer for layout to settle, then focus + print
    await new Promise((r) => setTimeout(r, 250));

    const win = iframe.contentWindow;
    try {
      win.focus();
      win.print();
    } catch (err) {
      console.error("Iframe print failed, falling back to window print:", err);
      // Last-resort fallback: open in a new tab-like window
      const w = window.open("", "_blank");
      if (w) {
        w.document.write(htmlContent);
        w.document.close();
        w.focus();
        w.print();
      }
    }

    // 13. Cleanup — multiple fallbacks because onafterprint is unreliable
    win.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(cleanup, 120000);
  } catch (error) {
    console.error("Error generating Memoria Certificate:", error);
    alert(
      "An error occurred while generating the certificate. Please try again.",
    );
  }
}
