document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("loginForm");
  const verifyForm = document.getElementById("verifyForm");
  const logoutBtn = document.getElementById("logoutBtn");

  const dlResult = document.getElementById("dlResult");
  const rcResult = document.getElementById("rcResult");
  const suspiciousDiv = document.getElementById("suspiciousAlert");
  const dlUsageInfoDiv = document.getElementById("dlUsageInfo");

  // 🌍 Get user location
  async function getLocation() {
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            coordinates: `${pos.coords.latitude},${pos.coords.longitude}`,
            toll_gate: "Tollgate-1"
          });
        },
        () => {
          resolve({
            coordinates: "unknown",
            toll_gate: "unknown"
          });
        }
      );
    });
  }

  // 🔐 LOGIN
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;

      try {
        const res = await fetch("http://localhost:3000/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        });

        const data = await res.json();

        if (res.ok) {
          alert("✅ Login successful");
          localStorage.setItem("userId", data.userId);
          localStorage.setItem("userRole", data.role);
          localStorage.setItem("userName", data.name);
          localStorage.setItem("roleLabel", data.roleLabel);

          // Redirect
          window.location.href = data.role === "superadmin"
            ? "user-management.html"
            : "scan.html";
        } else {
          alert(data.message || "❌ Login failed");
        }
      } catch (err) {
        console.error("Login error:", err);
        alert("Something went wrong. Try again.");
      }
    });

    const showPassCheckbox = document.getElementById("showPassword");
    if (showPassCheckbox) {
      showPassCheckbox.addEventListener("change", () => {
        const passInput = document.getElementById("password");
        passInput.type = showPassCheckbox.checked ? "text" : "password";
      });
    }
  }

  // 🚪 LOGOUT
  if (logoutBtn) {
    logoutBtn.addEventListener("click", logoutUser);
  }

  window.logoutUser = function () {
    const userId = localStorage.getItem("userId");
    if (userId) {
      fetch(`http://localhost:3000/api/logout/${userId}`, {
        method: "POST"
      })
        .then(res => res.json())
        .then(data => {
          alert(data.message || "✅ Logged out");
          localStorage.clear();
          window.location.href = "index.html";
        })
        .catch(err => {
          console.error("Logout error:", err);
          alert("Logout failed");
        });
    } else {
      localStorage.clear();
      window.location.href = "index.html";
    }
  };

  // ✅ Verification
  if (verifyForm) {
    verifyForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const dlImage = document.getElementById("dlImage").files[0];
      const rcImage = document.getElementById("rcImage").files[0];
      const dl_number = document.getElementById("dlNumber").value.trim();
      const rc_number = document.getElementById("rcNumber").value.trim();

      if (!dlImage && !rcImage && !dl_number && !rc_number) {
        dlResult.innerHTML = `<p style="color:red;">❌ Provide at least one DL/RC input.</p>`;
        rcResult.innerHTML = "";
        suspiciousDiv.style.display = "none";
        dlUsageInfoDiv.style.display = "none";
        document.getElementById("resultSection").style.display = "flex";
        return;
      }

      const loc = await getLocation();
      const formData = new FormData();
      if (dlImage) formData.append("dlImage", dlImage);
      if (rcImage) formData.append("rcImage", rcImage);
      if (dl_number) formData.append("dl_number", dl_number);
      if (rc_number) formData.append("rc_number", rc_number);
      formData.append("location", loc.coordinates);
      formData.append("tollgate", loc.toll_gate);

      dlResult.innerHTML = "⏳ Verifying...";
      rcResult.innerHTML = "";
      suspiciousDiv.style.display = "none";
      suspiciousDiv.innerHTML = "";
      dlUsageInfoDiv.style.display = "none";
      dlUsageInfoDiv.innerHTML = "";
      document.getElementById("resultSection").style.display = "flex";

      try {
        const res = await fetch("http://localhost:3000/api/verify", {
          method: "POST",
          body: formData
        });

        const data = await res.json();

        // DL Results
        if (data.dlData && data.dlData.status) {
          const color = data.dlData.status === "blacklisted" ? "red" : "green";
          dlResult.innerHTML = `
            <div style="border: 1px solid ${color}; padding: 10px; border-radius: 5px; color: black;">
              <strong>${data.dlData.licenseNumber || 'N/A'}</strong> -
              <span style="color: ${color};">${data.dlData.status.toUpperCase()}</span><br><br>
              <b>Name:</b> ${data.dlData.name || 'N/A'}<br>
              <b>Validity:</b> ${data.dlData.validity || 'N/A'}<br>
              <b>Phone:</b> ${data.dlData.phone_number || 'N/A'}
            </div>
          `;

          const usageRes = await fetch(`http://localhost:3000/api/dl-usage/${data.dlData.licenseNumber}`);
          const logs = await usageRes.json();

          if (logs.length > 0) {
            dlUsageInfoDiv.innerHTML = `
              <div style="border: 1px solid #ccc; padding: 10px; border-radius: 5px; color: black;">
                <h4>DL Usage Logs:</h4>
                <ul>
                  ${logs.map(log => `<li><b>${log.vehicle_number}</b> at ${new Date(log.timestamp).toLocaleString()}</li>`).join("")}
                </ul>
              </div>
            `;
            dlUsageInfoDiv.style.display = "block";
          }
        } else {
          dlResult.innerHTML = `<p style="color:red;">❌ No DL data found.</p>`;
        }

        // RC Results
        if (data.rcData && data.rcData.status) {
          const color = data.rcData.status === "blacklisted" ? "red" : "green";
          rcResult.innerHTML = `
            <div style="border: 1px solid ${color}; padding: 10px; border-radius: 5px; color: black;">
              <strong>${data.rcData.regn_number || 'N/A'}</strong> -
              <span style="color: ${color};">${data.rcData.status.toUpperCase()}</span><br><br>
              <b>Owner:</b> ${data.rcData.owner_name || 'N/A'}<br>
              <b>Vehicle Class:</b> ${data.rcData.vehicle_class || 'N/A'}<br>
              <b>Chassis No:</b> ${data.rcData.chassis_number || 'N/A'}<br>
              <b>Engine No:</b> ${data.rcData.engine_number || 'N/A'}<br>
              <b>Valid Upto:</b> ${data.rcData.valid_upto || 'N/A'}
            </div>
          `;
        } else {
          rcResult.innerHTML = `<p style="color:red;">❌ No RC data found.</p>`;
        }

        // Suspicious alert
        if (data.suspicious || data.dlData?.status === "blacklisted" || data.rcData?.status === "blacklisted") {
          const reasons = [];
          if (data.dlData?.status === "blacklisted") reasons.push("DL is blacklisted");
          if (data.rcData?.status === "blacklisted") reasons.push("RC is blacklisted");
          if (data.suspicious) reasons.push("DL used with 3+ vehicles in last 2 days");

          suspiciousDiv.innerHTML = `
            <div style="border: 2px solid red; padding: 12px; margin-top: 15px; border-radius: 6px; color: red; background: #ffe6e6;">
              <h4>⚠️ Suspicious Activity Detected</h4>
              <ul>${reasons.map(r => `<li>${r}</li>`).join("")}</ul>
            </div>
          `;
          suspiciousDiv.style.display = "block";
          suspiciousDiv.scrollIntoView({ behavior: "smooth" });
        }

      } catch (err) {
        console.error("Verification error:", err);
        dlResult.innerHTML = `<p style="color:red;">❌ Verification failed. Check console.</p>`;
      }
    });
  }

  // 🔎 DL input blur = fetch DL logs
  const dlNumberInput = document.getElementById("dlNumber");
  if (dlNumberInput) {
    dlNumberInput.addEventListener("blur", async () => {
      const dl_number = dlNumberInput.value.trim();
      if (!dl_number) return;

      try {
        const res = await fetch(`http://localhost:3000/api/dl-usage/${dl_number}`);
        const logs = await res.json();

        if (logs.length > 0) {
          dlUsageInfoDiv.innerHTML = `
            <div style="border: 1px solid #ccc; padding: 10px; border-radius: 5px; color: black;">
              <h4>DL Usage Logs:</h4>
              <ul>
                ${logs.map(log => `<li><b>${log.vehicle_number}</b> at ${new Date(log.timestamp).toLocaleString()}</li>`).join("")}
              </ul>
            </div>
          `;
          dlUsageInfoDiv.style.display = "block";
        } else {
          dlUsageInfoDiv.innerHTML = ''; // Clear if no logs
          dlUsageInfoDiv.style.display = 'none'; // Hide if no logs
        }
      } catch (err) {
        console.error("Usage fetch error:", err);
        dlUsageInfoDiv.innerHTML = `<p style="color:red;">❌ Error fetching DL usage logs.</p>`;
        dlUsageInfoDiv.style.display = 'block';
      }
    });
  }

  // Sidebar toggle
  window.toggleSidebar = function () {
    document.getElementById("sidebar").classList.toggle("collapsed");
    document.getElementById("mainContainer").classList.toggle("collapsed");
  };
});