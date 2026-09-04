// csv.js

// --- 1. EXPORT (GET request) ---
function exportCSV() {
  // Since the PHP returns a file download, just redirect the browser window to the endpoint.
  // The browser will automatically download the file.
  window.location.href = "api/csv.php"; // Adjust the path to your PHP file
  // Note: The browser handles the file download natively. No fetch() needed for downloads.
}

// Attach this to your "Download CSV" button
document
  .getElementById("download-csv-btn")
  .addEventListener("click", exportCSV);

// --- 2. IMPORT (POST request with file upload) ---
async function importCSV(fileInputElement) {
  const file = fileInputElement.files[0];

  if (!file) {
    alert("Please select a CSV file first.");
    return;
  }

  // Optional: Quick client-side validation (matches your PHP checks)
  const fileSizeMB = file.size / (1024 * 1024);
  if (fileSizeMB > 100) {
    alert("File is too large. Maximum is 100MB.");
    return;
  }
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension !== "csv") {
    alert("Only .csv files are allowed.");
    return;
  }

  // Build FormData
  const formData = new FormData();
  formData.append("csv_file", file); // MUST match the PHP key: $_FILES['csv_file']

  try {
    // Show loading state (disable button, change text)
    const uploadBtn = document.getElementById("upload-csv-btn");
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading...";

    const response = await fetch("api/csv.php", {
      method: "POST",
      body: formData,
      // IMPORTANT: Do NOT set 'Content-Type' header. The browser sets it automatically with the boundary for FormData.
    });

    const result = await response.json(); // Your PHP returns JSON via Response::success/error

    if (!response.ok) {
      throw new Error(result.message || "Upload failed.");
    }

    // Success!
    alert("Import successful!");
    // Optionally refresh the table to show new data
    location.reload();
  } catch (error) {
    alert("Import Error: " + error.message);
  } finally {
    // Reset button
    const uploadBtn = document.getElementById("upload-csv-btn");
    uploadBtn.disabled = false;
    uploadBtn.textContent = "Upload CSV";
    // Clear the file input so the user can upload another
    fileInputElement.value = "";
  }
}

// Attach this to your "Upload" button
document
  .getElementById("upload-csv-btn")
  .addEventListener("click", function () {
    const fileInput = document.getElementById("csv-file-input");
    importCSV(fileInput);
  });
