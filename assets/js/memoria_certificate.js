/**
 * Generates and prints a compact, single-page Memoria Certificate.
 * @param {number|string} id - The Interment ID or Record ID.
 */
async function memoria_certificate(id) {
  try {
    // 1. Fetch data in parallel
    const [recordRes, settingsRes] = await Promise.all([
      fetch(`api/records/${id}`),
      fetch(`api/settings`),
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

    // 5. Build the signatory list (skip entries with no name)
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

    // 6. Build HTML & CSS String
    const htmlContent = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Memoria Certificate — ${val(record.control_number)}</title>
        <style>
          /* =========================================================
             TUNING KNOBS  (adjust these first if it spills to page 2)
             =========================================================
             .print-header-spacer / .print-footer-spacer
                 -> must match the ACTUAL rendered height of the images
             body font-size   -> drop to 11.5px if still too tall
             .docBody padding -> left/right page margins
             ========================================================= */

          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');

          *, *::before, *::after { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; }

          body {
            font-family: 'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
            font-size: 12px;
            line-height: 1.45;
            color: #1f2937;
            background: #fff;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          /* ---------- print pagination mechanics ---------- */
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

          /* -------------------- layout -------------------- */
          .docBody { padding: 0 72px; }

          /* -------------------- heading ------------------- */
          .certTitle {
            font-family: Georgia, 'Times New Roman', serif;
            font-size: 28px;
            font-weight: 700;
            letter-spacing: 5px;
            text-transform: uppercase;
            text-align: center;
            color: #0f172a;
            margin: 0;
          }
          .certRule {
            border: 0;
            border-top: 3px double #94a3b8;
            margin: 8px 0 14px;
          }

          /* --------------- control / issued --------------- */
          .certMeta {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            font-size: 14px;
            color: #475569;
            letter-spacing: 0.3px;
            margin-bottom: 14px;
          }
          .certMeta strong { color: #0f172a; font-weight: 600; }

          /* ------------------ body text ------------------- */
          .certText { margin: 0 0 12px; }

          /* ----------------- data blocks ------------------ */
          .dataGrid {
            display: grid;
            grid-template-columns: 148px 1fr;
            column-gap: 14px;
            row-gap: 2px;
            padding: 8px 14px;
            background: #f8fafc;
            border-left: 3px solid #cbd5e1;
            margin-bottom: 11px;
            page-break-inside: avoid;
          }
          .dataLabel { color: #64748b; font-weight: 600; }
          .dataValue { color: #0f172a; font-weight: 600; }

          .sectionTitle {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 1.6px;
            text-transform: uppercase;
            color: #334155;
            margin: 0 0 4px;
          }

          /* ------------------ signatures ------------------ */
          .sigIntro { margin: 16px 0 0; }
          .signatorySection {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            column-gap: 8%;
            row-gap: 22px;
            margin-top: 26px;
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

        <!-- FIXED HEADER -->
        <header class="print-fixed-header">
          <img class="reportHeaderImage" src="api/images/header.png" onerror="this.style.display='none'" />
        </header>

        <!-- MAIN TABLE (keeps header/footer on every printed page) -->
        <table class="printPaginationTable">
          <thead><tr><td><div class="print-header-spacer"></div></td></tr></thead>

          <tbody>
            <tr>
              <td>
                <div class="docBody">

                  <h1 class="certTitle">Memoria Certificate</h1>
                  <hr class="certRule" />

                  <div class="certMeta">
                    <span><strong>Control Number:</strong> ${val(record.control_number)}</span>
                  </div>

                  <p class="certText">
                    <strong>To Whom It May Concern,</strong><br />
                    This is to certify that the records of this office contain an entry for the interment of:
                  </p>

                  <div class="dataGrid">
                    <span class="dataLabel">Name of Deceased</span>
                    <span class="dataValue">${val(record.deceased_name)}</span>
                    <span class="dataLabel">Date of Birth</span>
                    <span class="dataValue">${formatDate(record.deceased_date_of_birth)}</span>
                    <span class="dataLabel">Date of Death</span>
                    <span class="dataValue">${formatDate(record.deceased_date_of_death)}</span>
                    <span class="dataLabel">Sex</span>
                    <span class="dataValue">${val(record.deceased_sex)}</span>
                  </div>

                  <div class="sectionTitle">Place of Burial</div>
                  <div class="dataGrid">
                    <span class="dataLabel">Block / Section</span>
                    <span class="dataValue">${val(record.block_name)}</span>
                    <span class="dataLabel">Grave Code</span>
                    <span class="dataValue">${val(record.grave_code)}</span>
                  </div>

                  <div class="sectionTitle">Burial Details</div>
                  <div class="dataGrid">
                    <span class="dataLabel">Date Buried</span>
                    <span class="dataValue">${formatDate(record.date_buried)}</span>
                    <span class="dataLabel">Status</span>
                    <span class="dataValue">${val(record.status)}</span>
                  </div>

                  <div class="sectionTitle">Next of Kin / Contact Person</div>
                  <div class="dataGrid">
                    <span class="dataLabel">Name</span>
                    <span class="dataValue">${val(record.contact_person_name)}</span>
                    <span class="dataLabel">Contact Number</span>
                    <span class="dataValue">${val(record.contact_person_phone_number)}</span>
                  </div>

                  <p class="certText" style="margin-top:14px;">
                    <em>This certificate is not a legal death certificate. It is simply a confirmation that the above details are recorded in our system.</em>
                  </p>
                  <p class="certText">
                    Issued this <strong>${issuedDateStr}</strong> at <strong>${sMap["cemetery_name"] ?? "Mandaue City Public Cemetery"}</strong>.
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

        <!-- FIXED FOOTER -->
        <footer class="print-fixed-footer">
          <img class="reportFooterImage" src="api/images/footer.png" onerror="this.style.display='none'" />
        </footer>

        <!-- AUTO-PRINT -->
        <script>
          window.onload = function () {
            setTimeout(function () {
              window.focus();
              window.print();
            }, 300);
          };
        <\/script>
      </body>
      </html>
    `;

    // 7. Create hidden iframe and inject the compiled HTML
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(htmlContent);
    doc.close();

    // 8. Cleanup the iframe after printing
    const cleanup = () => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };
    iframe.contentWindow.onafterprint = cleanup;
    // Safety net for browsers that never fire onafterprint
    setTimeout(cleanup, 120000);
  } catch (error) {
    console.error("Error generating Memoria Certificate:", error);
    alert(
      "An error occurred while generating the certificate. Please try again.",
    );
  }
}
