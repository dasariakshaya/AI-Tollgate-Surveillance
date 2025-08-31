document.addEventListener("DOMContentLoaded", () => {
    // --- FORM & INPUT ELEMENTS ---
    const verifyForm = document.getElementById("verifyForm");
    const dlImageInput = document.getElementById("dlImageFile");
    const rcImageInput = document.getElementById("rcImageFile");
    const dlNumberInput = document.getElementById("dlNumber");
    const rcNumberInput = document.getElementById("rcNumber");
    
    // --- UI FEEDBACK ELEMENTS ---
    const dlSpinner = document.getElementById("dlSpinner");
    const rcSpinner = document.getElementById("rcSpinner");
    const dlResultDiv = document.getElementById("dlResult");
    const rcResultDiv = document.getElementById("rcResult");
    const driverResultDiv = document.getElementById("driverResult");
    const suspiciousDiv = document.getElementById("suspiciousAlert");
    const dlUsageInfoDiv = document.getElementById("dlUsageInfo");
    
    // --- OCR PROCESSING ---
    // This function handles the immediate OCR when a file is selected.
    async function handleImageUploadForOCR(file, endpoint, numberInput, spinner) {
        if (!file) return;
  
        spinner.style.display = 'block';
        numberInput.value = 'Extracting...';
        numberInput.disabled = true;
  
        const formData = new FormData();
        const fieldName = endpoint.includes('/dl') ? 'dlImage' : 'rcImage';
        formData.append(fieldName, file);
  
        try {
            const res = await fetch(`http://localhost:3000${endpoint}`, {
                method: 'POST',
                body: formData,
            });
  
            const data = await res.json();
  
            if (res.ok && data.extracted_text) {
                numberInput.value = data.extracted_text;
            } else {
                numberInput.value = '';
                alert(data.message || 'Could not extract text. Please enter manually.');
            }
        } catch (err) {
            console.error(`Error during OCR processing for ${fieldName}:`, err);
            numberInput.value = '';
            alert('An error occurred while communicating with the OCR service.');
        } finally {
            spinner.style.display = 'none';
            numberInput.disabled = false;
        }
    }
  
    // Add event listeners to file inputs to trigger OCR.
    if (dlImageInput) {
        dlImageInput.addEventListener('change', () => {
            handleImageUploadForOCR(dlImageInput.files[0], '/api/ocr/dl', dlNumberInput, dlSpinner);
        });
    }
  
    if (rcImageInput) {
        rcImageInput.addEventListener('change', () => {
            handleImageUploadForOCR(rcImageInput.files[0], '/api/ocr/rc', rcNumberInput, rcSpinner);
        });
    }
  
    // --- FINAL VERIFICATION ---
    // This handles the final form submission with user-corrected data.
    if (verifyForm) {
        verifyForm.addEventListener("submit", async (e) => {
            e.preventDefault();
  
            // Clear previous results
            dlResultDiv.style.display = 'none';
            rcResultDiv.style.display = 'none';
            driverResultDiv.style.display = 'none';
            suspiciousDiv.style.display = 'none';
            dlUsageInfoDiv.style.display = 'none';
  
            const dlNumber = dlNumberInput.value.trim();
            const rcNumber = rcNumberInput.value.trim();
  
            if (!dlNumber && !rcNumber) {
                alert("Please provide a DL number or a Vehicle number to verify.");
                return;
            }
  
            const verifyBtn = verifyForm.querySelector('button[type="submit"]');
            verifyBtn.textContent = 'Verifying...';
            verifyBtn.disabled = true;
  
            try {
                const res = await fetch("http://localhost:3000/api/verify", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    // Send the final text values, not the images
                    body: JSON.stringify({
                        dl_number: dlNumber,
                        rc_number: rcNumber,
                        location: 'Toll-Plaza-1', // Example location data
                        tollgate: 'Gate-A'
                    }),
                });
  
                const result = await res.json();
                displayResults(result.dlData, result.rcData, result.suspicious);
  
            } catch (err) {
                console.error("Verification error:", err);
                alert("An error occurred during verification. Please check the server.");
            } finally {
                verifyBtn.textContent = 'Verify Information';
                verifyBtn.disabled = false;
                // Clear file inputs for the next scan
                dlImageInput.value = '';
                rcImageInput.value = '';
            }
        });
    }
  
    // --- DISPLAY RESULTS ---
    function displayResults(dlData, rcData, suspicious) {
        if (dlData) {
            const statusClass = dlData.status ? dlData.status.toLowerCase() : 'unknown';
            dlResultDiv.innerHTML = `
                <h3>Driving License Details</h3>
                <p><strong>Status:</strong> <span class="status-${statusClass}">${dlData.status.replace(/_/g, ' ').toUpperCase()}</span></p>
                <p><strong>Number:</strong> ${dlData.licenseNumber || 'N/A'}</p>
                <p><strong>Name:</strong> ${dlData.name || 'N/A'}</p>
                <p><strong>Validity:</strong> ${dlData.validity || 'N/A'}</p>`;
            dlResultDiv.style.display = 'block';
        }

        if (rcData) {
            const statusClass = rcData.status ? rcData.status.toLowerCase() : 'unknown';
            rcResultDiv.innerHTML = `
                <h3>Vehicle RC Details</h3>
                <p><strong>Status:</strong> <span class="status-${statusClass}">${rcData.status.replace(/_/g, ' ').toUpperCase()}</span></p>
                <p><strong>Number:</strong> ${rcData.regn_number || 'N/A'}</p>
                <p><strong>Owner:</strong> ${rcData.owner_name || 'N/A'}</p>`;
            rcResultDiv.style.display = 'block';
        }

        if (suspicious) {
            suspiciousDiv.textContent = '⚠️ Alert: Suspicious activity has been detected with this DL.';
            suspiciousDiv.style.display = 'block';
        }
    }
});

