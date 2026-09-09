// Office Attendance Application Logic

let OFFICE_CONFIG = {
    radius: 200 // meters
};

let currentEmployee = {
    id: "EMP1001",
    name: "Staff Member",
    role: "Employee",
    monthly_salary: 0
};

let employeeToken = localStorage.getItem("employee_token") || "";
let userCoordinates = null;
let workingTimerInterval = null;
let checkInDateTime = null;
let serverTimeOffsetMs = 0;

// Auth Header Helper for Employee Token
function getAuthHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (employeeToken) {
        headers["Authorization"] = `Bearer ${employeeToken}`;
        headers["X-Employee-Token"] = employeeToken;
    }
    return headers;
}

// Fetch office location config from database (radius only for employee)
async function fetchOfficeLocation() {
    try {
        const res = await fetch("/api/office-location");
        if (res.ok) {
            const data = await res.json();
            if (data.location && data.location.radius) {
                OFFICE_CONFIG.radius = Number(data.location.radius);
            }
            if (userCoordinates) {
                evaluateGeofence(userCoordinates);
            }
        }
    } catch (e) {
        console.warn("Could not fetch office config:", e);
    }
}

// Toast notification helper
function showToast(message, type = "info", duration = 4000) {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const icon = type === "success" ? "✅" : type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";

    toast.innerHTML = `
        <span style="font-size: 16px;">${icon}</span>
        <div>${message}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Haversine Distance Formula
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Live IST Clock
function updateLiveClock() {
    const now = new Date(Date.now() + serverTimeOffsetMs);

    const dateStr = now.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric"
    });

    const timeStr = now.toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true
    });

    const dateElem = document.getElementById("date");
    const timeElem = document.getElementById("time");

    if (dateElem) dateElem.textContent = dateStr;
    if (timeElem) timeElem.textContent = `${timeStr} IST`;
}

async function syncServerTime() {
    try {
        const res = await fetch("/api/time");
        if (res.ok) {
            const data = await res.json();
            const serverMs = new Date(data.iso).getTime();
            serverTimeOffsetMs = serverMs - Date.now();
            const badge = document.getElementById("serverStatusText");
            if (badge) badge.textContent = "IST Synced";
        }
    } catch (e) {
        console.warn("Time sync error:", e);
    }
}

// --- Persistent One-Time Authentication Management ---
async function checkEmployeeAuth() {
    if (!employeeToken) {
        showEmployeeLoginModal();
        return;
    }

    try {
        const res = await fetch("/api/employee/me", {
            headers: getAuthHeaders()
        });
        const data = await res.json();

        if (res.ok && data.status === "success" && data.employee) {
            onEmployeeAuthSuccess(data.employee, employeeToken);
        } else {
            // Token invalid or revoked
            localStorage.removeItem("employee_token");
            localStorage.removeItem("cached_employee");
            employeeToken = "";
            showEmployeeLoginModal();
        }
    } catch (e) {
        console.warn("Auth check connection error, attempting cached profile:", e);
        const cached = localStorage.getItem("cached_employee");
        if (cached) {
            try {
                onEmployeeAuthSuccess(JSON.parse(cached), employeeToken, false);
            } catch (err) {
                showEmployeeLoginModal();
            }
        } else {
            showEmployeeLoginModal();
        }
    }
}

function showEmployeeLoginModal() {
    const modal = document.getElementById("employeeLoginModal");
    const badge = document.getElementById("employeeUserBadge");
    if (modal) modal.style.display = "flex";
    if (badge) badge.style.display = "none";
    const idInput = document.getElementById("loginEmpId");
    if (idInput) idInput.focus();
}

function hideEmployeeLoginModal() {
    const modal = document.getElementById("employeeLoginModal");
    if (modal) modal.style.display = "none";
}

async function handleEmployeeLogin(event) {
    event.preventDefault();
    const idInput = document.getElementById("loginEmpId");
    const passInput = document.getElementById("loginEmpPassword");
    const errorMsg = document.getElementById("employeeLoginErrorMsg");
    const btnSubmit = document.getElementById("btnEmpLoginSubmit");

    const employee_id = idInput.value.trim().toUpperCase();
    const password = passInput.value.trim();

    if (!employee_id || !password) return;

    btnSubmit.disabled = true;
    btnSubmit.textContent = "Verifying...";
    if (errorMsg) errorMsg.style.display = "none";

    try {
        const res = await fetch("/api/employee/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ employee_id, password })
        });

        const data = await res.json();

        if (res.ok && data.status === "success") {
            employeeToken = data.token;
            localStorage.setItem("employee_token", employeeToken);
            localStorage.setItem("cached_employee", JSON.stringify(data.employee));
            showToast(data.message || "Signed in successfully.", "success");
            passInput.value = "";
            onEmployeeAuthSuccess(data.employee, employeeToken);
        } else {
            if (errorMsg) {
                errorMsg.textContent = data.message || "Invalid Employee ID or password.";
                errorMsg.style.display = "block";
            }
            passInput.value = "";
            passInput.focus();
        }
    } catch (err) {
        console.error("Login error:", err);
        if (errorMsg) {
            errorMsg.textContent = "Unable to connect to server. Please try again.";
            errorMsg.style.display = "block";
        }
    } finally {
        btnSubmit.disabled = false;
        btnSubmit.textContent = "⚡ Sign In";
    }
}

async function handleEmployeeLogout() {
    try {
        await fetch("/api/employee/logout", {
            method: "POST",
            headers: getAuthHeaders()
        });
    } catch (e) {
        console.warn("Logout notification error:", e);
    }

    employeeToken = "";
    localStorage.removeItem("employee_token");
    localStorage.removeItem("cached_employee");
    stopWorkingTimer();
    showToast("You have been signed out.", "info");

    renderTodayStatus(null);
    const tbody = document.getElementById("historyTableBody");
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Please sign in to view attendance records.</td></tr>`;

    showEmployeeLoginModal();
}

function onEmployeeAuthSuccess(emp, token, shouldLoadStatus = true) {
    hideEmployeeLoginModal();
    setCurrentEmployee(emp);

    const badge = document.getElementById("employeeUserBadge");
    const headerName = document.getElementById("headerEmpName");
    const headerId = document.getElementById("headerEmpId");

    if (badge) badge.style.display = "flex";
    if (headerName) headerName.textContent = emp.name;
    if (headerId) headerId.textContent = emp.employee_id;

    if (shouldLoadStatus) {
        loadTodayStatus();
    }
}

function setCurrentEmployee(emp) {
    currentEmployee = {
        id: emp.employee_id,
        name: emp.name,
        role: emp.role || "Staff Member",
        monthly_salary: emp.monthly_salary || 0
    };

    const nameEl = document.getElementById("displayEmpName");
    const roleEl = document.getElementById("displayEmpRole");
    const salEl = document.getElementById("displayEmpSalary");

    if (nameEl) nameEl.textContent = currentEmployee.name;
    if (roleEl) roleEl.textContent = `${currentEmployee.role} • #${currentEmployee.id}`;
    if (salEl) {
        const salaryFormatted = Number(currentEmployee.monthly_salary).toLocaleString("en-IN");
        salEl.textContent = `Salary: ₹${salaryFormatted} / mo`;
    }
}

// Live Working Timer
function startWorkingTimer(startTimeIso) {
    stopWorkingTimer();
    checkInDateTime = new Date(startTimeIso);

    function tick() {
        if (!checkInDateTime) return;
        const now = new Date(Date.now() + serverTimeOffsetMs);
        const diffMs = Math.max(0, now.getTime() - checkInDateTime.getTime());
        const totalSec = Math.floor(diffMs / 1000);

        const hours = String(Math.floor(totalSec / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
        const seconds = String(totalSec % 60).padStart(2, "0");

        const el = document.getElementById("workingTime");
        if (el) el.textContent = `${hours}:${minutes}:${seconds}`;
    }

    tick();
    workingTimerInterval = setInterval(tick, 1000);
}

function stopWorkingTimer() {
    if (workingTimerInterval) {
        clearInterval(workingTimerInterval);
        workingTimerInterval = null;
    }
}

// Accuracy Level Formatter (High / Medium / Low)
function formatAccuracyLevel(accuracyMeters) {
    if (accuracyMeters === null || accuracyMeters === undefined || isNaN(accuracyMeters)) {
        return { text: "Detecting...", badgeClass: "acc-unknown" };
    }
    const acc = Number(accuracyMeters);
    if (acc <= 25) {
        return { text: "High", badgeClass: "acc-high" };
    } else if (acc <= 70) {
        return { text: "Medium", badgeClass: "acc-medium" };
    } else {
        return { text: "Low", badgeClass: "acc-low" };
    }
}

// Fast & Accurate Geolocation Acquisition
function getFreshCoordinates(timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error("Geolocation not supported by browser."));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            pos => {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;
                const acc = pos.coords.accuracy;

                const coords = { latitude: lat, longitude: lon, accuracy: acc };
                userCoordinates = coords;
                updateLocationUI(coords);
                resolve(coords);
            },
            err => {
                reject(err);
            },
            {
                enableHighAccuracy: true,
                timeout: timeoutMs,
                maximumAge: 0 // Force fresh reading
            }
        );
    });
}

async function evaluateGeofence(coords) {
    const locationStatus = document.getElementById("location-status");
    const badgeText = document.getElementById("locationBadgeText");
    const dot = document.getElementById("locationDot");
    const perimeterStatus = document.getElementById("perimeterStatus");

    try {
        const res = await fetch("/api/check-geofence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ latitude: coords.latitude, longitude: coords.longitude })
        });
        const data = await res.json();

        if (res.ok && data.is_inside) {
            if (locationStatus) locationStatus.textContent = "Within designated office premises.";
            if (badgeText) badgeText.textContent = "Inside Office";
            if (dot) dot.className = "status-dot green";
            if (perimeterStatus) {
                perimeterStatus.textContent = "In Range";
                perimeterStatus.style.color = "var(--success)";
            }
        } else {
            if (locationStatus) locationStatus.textContent = "Outside designated office premises. Punch-in allowed only within office.";
            if (badgeText) badgeText.textContent = "Outside Office";
            if (dot) dot.className = "status-dot orange";
            if (perimeterStatus) {
                perimeterStatus.textContent = "Out of Range";
                perimeterStatus.style.color = "var(--warning)";
            }
        }
    } catch (e) {
        console.warn("Geofence evaluation warning:", e);
    }
}

function updateLocationUI(coords) {
    const gpsStatus = document.getElementById("gpsStatus");
    const accEl = document.getElementById("accuracyBadge");

    if (gpsStatus) {
        gpsStatus.textContent = "Active";
        gpsStatus.style.color = "var(--success)";
    }

    if (accEl && coords.accuracy !== null && coords.accuracy !== undefined) {
        const lvl = formatAccuracyLevel(coords.accuracy);
        accEl.textContent = lvl.text;
        accEl.className = `acc-badge ${lvl.badgeClass}`;
    }

    evaluateGeofence(coords);
}

function initLocationWatcher() {
    getFreshCoordinates().catch(err => {
        console.warn("Initial GPS acquisition notice:", err.message);
        const locationStatus = document.getElementById("location-status");
        const badgeText = document.getElementById("locationBadgeText");
        const dot = document.getElementById("locationDot");
        const gpsStatus = document.getElementById("gpsStatus");
        const accEl = document.getElementById("accuracyBadge");

        if (gpsStatus) {
            gpsStatus.textContent = "Pending Permission";
            gpsStatus.style.color = "var(--warning)";
        }
        if (accEl) accEl.textContent = "--";
        if (locationStatus) locationStatus.textContent = "GPS permission required. Please enable location on your device to punch in.";
        if (badgeText) badgeText.textContent = "GPS Pending";
        if (dot) dot.className = "status-dot orange";
    });
}

// Fetch Today's Attendance State
async function loadTodayStatus(notify = false) {
    if (!employeeToken) return;

    try {
        const res = await fetch(`/api/today?employee_id=${currentEmployee.id}`, {
            headers: getAuthHeaders()
        });
        const data = await res.json();

        if (res.ok && data.status === "success") {
            renderTodayStatus(data.record);
            if (notify) showToast("Status refreshed from server.", "info");
        }
    } catch (e) {
        console.error("Failed to load today status:", e);
        if (notify) showToast("Failed to connect to server.", "error");
    }

    loadHistory();
}

function renderTodayStatus(record) {
    const checkInBtn = document.getElementById("checkInBtn");
    const checkOutBtn = document.getElementById("checkOutBtn");
    const attendanceStatus = document.getElementById("attendanceStatus");
    const checkInTimeEl = document.getElementById("checkInTime");
    const checkOutTimeEl = document.getElementById("checkOutTime");
    const totalHoursEl = document.getElementById("totalHours");
    const dayStatusEl = document.getElementById("dayStatus");
    const checkInDateEl = document.getElementById("checkInDate");
    const checkOutDateEl = document.getElementById("checkOutDate");

    if (!record) {
        checkInBtn.disabled = false;
        checkOutBtn.disabled = true;
        attendanceStatus.textContent = "Not Checked In";
        attendanceStatus.className = "status-text not-checked";
        checkInTimeEl.textContent = "--:--";
        checkOutTimeEl.textContent = "--:--";
        totalHoursEl.textContent = "--";
        dayStatusEl.textContent = "Pending";
        checkInDateEl.textContent = "Pending";
        checkOutDateEl.textContent = "Pending";
        document.getElementById("workingTime").textContent = "00:00:00";
        stopWorkingTimer();
        return;
    }

    checkInTimeEl.textContent = record.check_in_time;
    checkInDateEl.textContent = `${record.date} (IST)`;

    if (record.check_out_time) {
        checkInBtn.disabled = true;
        checkOutBtn.disabled = true;
        attendanceStatus.textContent = "Completed (Checked Out)";
        attendanceStatus.className = "status-text completed";
        checkOutTimeEl.textContent = record.check_out_time;
        checkOutDateEl.textContent = `${record.date} (IST)`;
        totalHoursEl.textContent = record.total_hours_formatted || "--";
        dayStatusEl.textContent = "Completed";

        const totalSec = record.working_seconds || 0;
        const hours = String(Math.floor(totalSec / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
        const seconds = String(totalSec % 60).padStart(2, "0");
        document.getElementById("workingTime").textContent = `${hours}:${minutes}:${seconds}`;
        stopWorkingTimer();
    } else {
        checkInBtn.disabled = true;
        checkOutBtn.disabled = false;
        attendanceStatus.textContent = "Currently Checked In";
        attendanceStatus.className = "status-text active";
        checkOutTimeEl.textContent = "--:--";
        checkOutDateEl.textContent = "Active Shift";
        totalHoursEl.textContent = "In Progress";
        dayStatusEl.textContent = "Present";

        startWorkingTimer(record.check_in_iso);
    }
}

// Punch In Handler (Live Level: Strict GPS & Geofence Verification)
async function handleCheckIn() {
    if (!employeeToken) {
        showEmployeeLoginModal();
        return;
    }

    const checkInBtn = document.getElementById("checkInBtn");
    checkInBtn.disabled = true;
    checkInBtn.innerHTML = `<span>⏳</span> Acquiring GPS...`;

    let coords = null;
    try {
        coords = await getFreshCoordinates(6000);
    } catch (e) {
        console.warn("GPS capture error:", e);
        showToast("GPS location is required to punch in. Please enable location on your device.", "warning", 5000);
        checkInBtn.disabled = false;
        checkInBtn.innerHTML = `<span>⚡</span> PUNCH IN`;
        return;
    }

    if (!coords || coords.latitude === null || coords.longitude === null) {
        showToast("Unable to obtain GPS coordinates. Please ensure location is enabled.", "warning", 5000);
        checkInBtn.disabled = false;
        checkInBtn.innerHTML = `<span>⚡</span> PUNCH IN`;
        return;
    }

    const payload = {
        employee_id: currentEmployee.id,
        employee_name: currentEmployee.name,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy
    };

    checkInBtn.innerHTML = `<span>⏳</span> Verifying Location...`;

    try {
        const res = await fetch("/api/check-in", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.status === "success") {
            showToast(`✅ Checked in successfully at ${data.record.check_in_time} (IST)`, "success");
            renderTodayStatus(data.record);
            loadHistory();
        } else {
            showToast(data.message || "Failed to check in.", "error", 5000);
            loadTodayStatus();
        }
    } catch (e) {
        console.error("Check-in error:", e);
        showToast("Server connection error during check-in.", "error");
        checkInBtn.disabled = false;
    } finally {
        checkInBtn.innerHTML = `<span>⚡</span> PUNCH IN`;
    }
}

// Punch Out Handler (Live Level: Records Fresh GPS & Finalizes Shift)
async function handleCheckOut() {
    if (!employeeToken) {
        showEmployeeLoginModal();
        return;
    }

    const checkOutBtn = document.getElementById("checkOutBtn");
    checkOutBtn.disabled = true;
    checkOutBtn.innerHTML = `<span>⏳</span> Acquiring GPS...`;

    let coords = null;
    try {
        coords = await getFreshCoordinates(5000);
    } catch (e) {
        console.warn("GPS capture warning during punch out:", e);
    }

    const payload = {
        employee_id: currentEmployee.id,
        latitude: coords ? coords.latitude : null,
        longitude: coords ? coords.longitude : null,
        accuracy: coords ? coords.accuracy : null
    };

    checkOutBtn.innerHTML = `<span>⏳</span> Punching Out...`;

    try {
        const res = await fetch("/api/check-out", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.status === "success") {
            showToast(`🏁 Checked out at ${data.record.check_out_time} (IST). Worked: ${data.record.total_hours_formatted}`, "success", 5000);
            renderTodayStatus(data.record);
            loadHistory();
        } else {
            showToast(data.message || "Failed to check out.", "error");
            loadTodayStatus();
        }
    } catch (e) {
        console.error("Check-out error:", e);
        showToast("Server connection error during check-out.", "error");
        checkOutBtn.disabled = false;
    } finally {
        checkOutBtn.innerHTML = `<span>🏁</span> PUNCH OUT`;
    }
}

// Attendance History Loader (Employee View: Privacy Protected)
async function loadHistory() {
    if (!employeeToken) return;

    try {
        const res = await fetch(`/api/history?employee_id=${currentEmployee.id}`, {
            headers: getAuthHeaders()
        });
        if (!res.ok) return;

        const data = await res.json();
        const records = data.records || [];

        const tbody = document.getElementById("historyTableBody");
        const countBadge = document.getElementById("recordsCount");
        if (countBadge) countBadge.textContent = `${records.length} Record${records.length === 1 ? '' : 's'}`;

        if (!tbody) return;

        if (records.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No attendance records found yet for ${currentEmployee.name}. Punch in to start!</td></tr>`;
            return;
        }

        tbody.innerHTML = records.map(r => {
            const isCompleted = r.status === "Completed";
            const statusBadgeClass = isCompleted ? "badge-success" : "badge-warning";

            // In accuracy level
            const pIn = r.punch_in || {};
            const inAccLevel = pIn.accuracy_level || (pIn.accuracy ? formatAccuracyLevel(pIn.accuracy).text : "Standard");
            const inAccClass = inAccLevel.toLowerCase() === "high" ? "badge-success" : (inAccLevel.toLowerCase() === "medium" ? "badge-warning" : "badge-info");

            // Out accuracy level
            const pOut = r.punch_out || {};
            const outAccLevel = pOut.accuracy_level || (pOut.accuracy ? formatAccuracyLevel(pOut.accuracy).text : "Standard");
            const outAccClass = outAccLevel.toLowerCase() === "high" ? "badge-success" : (outAccLevel.toLowerCase() === "medium" ? "badge-warning" : "badge-info");

            return `
                <tr>
                    <td><strong>${r.date}</strong></td>
                    <td>
                        <div><strong>${r.check_in_time}</strong> <span style="font-size: 10px; color: var(--text-light);">IST</span></div>
                        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
                            <span class="badge ${inAccClass}" style="font-size: 10px; padding: 2px 6px;">Accuracy: ${inAccLevel}</span>
                        </div>
                    </td>
                    <td>
                        ${r.check_out_time ? `
                            <div><strong>${r.check_out_time}</strong> <span style="font-size: 10px; color: var(--text-light);">IST</span></div>
                            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
                                <span class="badge ${outAccClass}" style="font-size: 10px; padding: 2px 6px;">Accuracy: ${outAccLevel}</span>
                            </div>
                        ` : `<span class="badge badge-warning">Active In Progress</span>`}
                    </td>
                    <td><strong>${r.total_hours_formatted || '--'}</strong></td>
                    <td><span class="badge ${statusBadgeClass}">${r.status}</span></td>
                </tr>
            `;
        }).join("");

    } catch (e) {
        console.error("Failed to load history:", e);
    }
}

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", () => {
    fetchOfficeLocation();
    updateLiveClock();
    setInterval(updateLiveClock, 1000);
    syncServerTime();

    checkEmployeeAuth();
    initLocationWatcher();
});