document.addEventListener("DOMContentLoaded", () => {
    // --- FORM & INPUT ELEMENTS ---
    const verifyForm = document.getElementById("verifyForm");
    const dlImageInput = document.getElementById("dlImageFile");
    const rcImageInput = document.getElementById("rcImageFile");
    const driverImageInput = document.getElementById("driverImage");
    const dlNumberInput = document.getElementById("dlNumber");
    const rcNumberInput = document.getElementById("rcNumber");
    
    // --- UI FEEDBACK ELEMENTS ---
    const dlSpinner = document.getElementById("dlSpinner");
    const rcSpinner = document.getElementById("rcSpinner");
    const summaryResultDiv = document.getElementById("summaryResult");
    
    // --- Add references to the original detail boxes ---
    const dlResultDiv = document.getElementById("dlResult");
    const rcResultDiv = document.getElementById("rcResult");
    const driverResultDiv = document.getElementById("driverResult");
    
    // --- OCR PROCESSING ---
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
    if (verifyForm) {
        verifyForm.addEventListener("submit", async (e) => {
            e.preventDefault();
  
            // Clear previous results
            summaryResultDiv.style.display = 'none';
            dlResultDiv.style.display = 'none';
            rcResultDiv.style.display = 'none';
            driverResultDiv.style.display = 'none';
  
            const dlNumber = dlNumberInput.value.trim();
            const rcNumber = rcNumberInput.value.trim();
  
            if (!dlNumber && !rcNumber && !driverImageInput.files[0]) {
                alert("Please provide a DL number, a Vehicle number, or a Driver Image to verify.");
                return;
            }
  
            const verifyBtn = verifyForm.querySelector('button[type="submit"]');
            verifyBtn.textContent = 'Verifying...';
            verifyBtn.disabled = true;
  
            try {
                const formData = new FormData();
                formData.append('dl_number', dlNumber);
                formData.append('rc_number', rcNumber);
                formData.append('location', 'Toll-Plaza-1');
                formData.append('tollgate', 'Gate-A');

                if (driverImageInput.files[0]) {
                    formData.append('driverImage', driverImageInput.files[0]);
                }

                const res = await fetch("http://localhost:3000/api/verify", {
                    method: "POST",
                    body: formData, 
                });
  
                const result = await res.json();
                displayResults(result.dlData, result.rcData, result.suspicious, result.driverData);
  
            } catch (err) {
                console.error("Verification error:", err);
                alert("An error occurred during verification. Please check the server.");
            } finally {
                verifyBtn.textContent = 'Verify Information';
                verifyBtn.disabled = false;
                if (dlImageInput) dlImageInput.value = '';
                if (rcImageInput) rcImageInput.value = '';
                if (driverImageInput) driverImageInput.value = '';
            }
        });
    }
  
    // --- DISPLAY BOTH DETAILED AND SUMMARY RESULTS ---
    function displayResults(dlData, rcData, suspicious, driverData) {
        
        // --- 1. DISPLAY DETAILED BOXES (The original view) ---

        if (dlData && dlData.status !== 'no_data_provided') {
            const statusClass = (dlData.status || 'unknown').toLowerCase().replace(/\s/g, '_');
            dlResultDiv.innerHTML = `
                <h3>Driving License Details</h3>
                <p><strong>Status:</strong> <span class="status-${statusClass}">${(dlData.status || 'unknown').replace(/_/g, ' ').toUpperCase()}</span></p>
                <p><strong>Number:</strong> ${dlData.licenseNumber || 'N/A'}</p>
                <p><strong>Name:</strong> ${dlData.name || 'N/A'}</p>
                <p><strong>Validity:</strong> ${dlData.validity || 'N/A'}</p>`;
            dlResultDiv.style.display = 'block';
        }

        if (rcData && rcData.status !== 'no_data_provided') {
            const statusClass = (rcData.status || 'unknown').toLowerCase().replace(/\s/g, '_');
            let crimeInfoHtml = '';
            if (rcData.status === 'blacklisted' && rcData.crime_involved && rcData.crime_involved.toLowerCase() !== 'n/a' && rcData.crime_involved.toLowerCase() !== 'not specified') {
                crimeInfoHtml = `<p><strong>Crime Involved:</strong> <span style="color: red; font-weight: bold;">${rcData.crime_involved}</span></p>`;
            }
            rcResultDiv.innerHTML = `
                <h3>Vehicle RC Details</h3>
                <p><strong>Status:</strong> <span class="status-${statusClass}">${(rcData.status || 'unknown').replace(/_/g, ' ').toUpperCase()}</span></p>
                <p><strong>Number:</strong> ${rcData.regn_number || 'N/A'}</p>
                <p><strong>Owner:</strong> ${rcData.owner_name || 'N/A'}</p>
                ${crimeInfoHtml}`;
            rcResultDiv.style.display = 'block';
        }

        if (driverData) {
            let driverHtml = '<h3>Driver Verification</h3>';
            let statusClass = 'status-unknown';
            let statusText = 'Verification could not be completed.';

            switch (driverData.status) {
                case 'ALERT':
                    statusClass = 'status-alert';
                    statusText = `SUSPECT IDENTIFIED: ${driverData.name}`;
                    break;
                case 'CLEAR':
                    statusClass = 'status-clear';
                    statusText = 'Driver status: CLEAR';
                    break;
                case 'NO_FACE_DETECTED':
                    statusClass = 'status-no_face_detected';
                    statusText = 'No face was detected in the photo.';
                    break;
            }
            driverHtml += `<p><strong>Status:</strong> <span class="${statusClass}">${statusText}</span></p>`;
            if (driverData.confidence) {
                 driverHtml += `<p><strong>Confidence:</strong> ${driverData.confidence}</p>`;
            }
            driverResultDiv.innerHTML = driverHtml;
            driverResultDiv.style.display = 'block';
        }

        // --- 2. DISPLAY VERIFICATION SUMMARY ---
        
        let summaryHtml = '<h3>Verification Summary</h3>';
        let isAlert = false;
        
        // --- Driving License Section ---
        if (dlData && dlData.status !== 'no_data_provided') {
            const statusClass = (dlData.status || 'unknown').toLowerCase().replace(/\s/g, '_');
            let statusText = (dlData.status === 'valid') ? 'Verified' : (dlData.status || 'unknown').replace(/_/g, ' ').toUpperCase();
            if (dlData.status === 'blacklisted') {
                statusText = 'BLACKLISTED';
                isAlert = true;
            }
            summaryHtml += `
                <div class="summary-line">
                    <strong>Driving License Number:</strong>
                    <span class="status-${statusClass}">${statusText}</span>
                </div>`;
        }

        // --- Vehicle RC Section ---
        if (rcData && rcData.status !== 'no_data_provided') {
            const statusClass = (rcData.status || 'unknown').toLowerCase().replace(/\s/g, '_');
            let statusText = (rcData.status === 'valid') ? 'Verified' : (rcData.status || 'unknown').replace(/_/g, ' ').toUpperCase();
            let crimeHtml = '';

            if (rcData.status === 'blacklisted') {
                 statusText = 'BLACKLISTED';
                 isAlert = true;
                 if(rcData.crime_involved && rcData.crime_involved.toLowerCase() !== 'n/a' && rcData.crime_involved.toLowerCase() !== 'not specified') {
                    crimeHtml = `<span class="crime">Crime Involved: ${rcData.crime_involved}</span>`;
                 }
            }
            summaryHtml += `
                <div class="summary-line">
                    <strong>Vehicle Registration Number:</strong>
                    <span class="status-${statusClass}">${statusText}</span>
                    ${crimeHtml}
                </div>`;
        }

        // --- Face Matching Section ---
        if (driverData) {
            let statusClass = 'status-unknown';
            let statusText = 'Verification could not be completed.';
            switch (driverData.status) {
                case 'ALERT':
                    statusClass = 'status-alert';
                    // MODIFIED: Combine "SUSPECT FOUND:" and the name into a single line
                    statusText = `SUSPECT FOUND: ${driverData.name}`;
                    isAlert = true;
                    break;
                case 'CLEAR':
                    statusClass = 'status-clear';
                    statusText = 'Clear - No match found in suspect list.';
                    break;
                case 'NO_FACE_DETECTED':
                    statusClass = 'status-no_face_detected';
                    statusText = 'No face was detected in the photo.';
                    break;
            }
            summaryHtml += `
                <div class="summary-line">
                    <strong>Face Matching:</strong>
                    <span class="${statusClass}">${statusText}</span>
                </div>`;
        }
        
        if (suspicious && !isAlert) {
             isAlert = true;
        }

        if (isAlert) {
            summaryResultDiv.className = "summary-result-box alert-box";
        } else {
             summaryResultDiv.className = "summary-result-box";
        }

        summaryResultDiv.innerHTML = summaryHtml;
        summaryResultDiv.style.display = 'block';
    }
});

