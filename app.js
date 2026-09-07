// Configuration & Office Geofence
const OFFICE_LOCATION = {
    latitude: 12.9130596,
    longitude: 79.1330797,
    radius: 100 // meters
};

const EMPLOYEE = {
    id: "EMP001",
    name: "Manojh"
};

let userCoordinates = null;
let workingTimerInterval = null;
let checkInDateTime = null;
let serverTimeOffsetMs = 0; // Offset between client clock and server IST clock

// --- Toast Notification System ---
function showToast(message, type = "info", duration = 4000) {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const icon = type === "success" ? "✅" : type === "error" ? "❌" : "ℹ️";

    toast.innerHTML = `
        <span style="font-size: 16px;">${icon}</span>
        <div class="toast-message">${message}</div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// --- Live Clock (Indian Standard Time) ---
function updateLiveClock() {
    // Current time adjusted with server offset to maintain IST accuracy
    const now = new Date(Date.now() + serverTimeOffsetMs);

    // Format strictly for Indian Standard Time (en-IN)
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

// Sync server time to guarantee IST precision regardless of client device time
async function syncServerTime() {
    try {
        const res = await fetch("/api/time");
        if (res.ok) {
            const data = await res.json();
            const serverMs = new Date(data.iso).getTime();
            serverTimeOffsetMs = serverMs - Date.now();
            const badge = document.getElementById("serverStatusText");
            if (badge) badge.textContent = "Server Synced (IST)";
        }
    } catch (e) {
        console.warn("Time sync error:", e);
    }
}

// --- Haversine Distance Calculation ---
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
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

// --- Working Time Live Counter ---
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

// --- Location Detection ---
function initLocationWatcher() {
    const locationStatus = document.getElementById("location-status");
    const badgeText = document.getElementById("locationBadgeText");
    const dot = document.getElementById("locationDot");

    if (!navigator.geolocation) {
        if (locationStatus) locationStatus.textContent = "Geolocation not supported by browser.";
        if (badgeText) badgeText.textContent = "GPS Unavailable";
        if (dot) dot.className = "location-dot red";
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            const acc = position.coords.accuracy;

            userCoordinates = { latitude: lat, longitude: lon, accuracy: acc };

            document.getElementById("latitude").textContent = lat.toFixed(6);
            document.getElementById("longitude").textContent = lon.toFixed(6);
            document.getElementById("accuracy").textContent = `±${acc.toFixed(0)}m`;

            const distance = calculateDistance(
                lat, lon,
                OFFICE_LOCATION.latitude, OFFICE_LOCATION.longitude
            );

            userCoordinates.distance = distance;
            document.getElementById("distanceVal").textContent = `${distance.toFixed(0)} m`;

            const isInside = distance <= OFFICE_LOCATION.radius;
            if (isInside) {
                if (locationStatus) locationStatus.textContent = `Within office perimeter (${distance.toFixed(0)}m away)`;
                if (badgeText) badgeText.textContent = "Inside Office";
                if (dot) dot.className = "location-dot green";
            } else {
                if (locationStatus) locationStatus.textContent = `Outside office bounds (${distance.toFixed(0)}m from office)`;
                if (badgeText) badgeText.textContent = "Outside Radius";
                if (dot) dot.className = "location-dot orange";
            }
        },
        (error) => {
            console.warn("Location error:", error);
            if (locationStatus) locationStatus.textContent = "Unable to fetch GPS. You can enable Test Mode to simulate.";
            if (badgeText) badgeText.textContent = "GPS Off / Denied";
            if (dot) dot.className = "location-dot red";
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
}

// --- Fetch Today's Attendance Status from Server ---
async function loadTodayStatus(notify = false) {
    try {
        const res = await fetch(`/api/today?employee_id=${EMPLOYEE.id}`);
        const data = await res.json();

        if (res.ok && data.status === "success") {
            renderTodayStatus(data.record);
            if (notify) showToast("Attendance status refreshed from server (IST).", "info");
        }
    } catch (e) {
        console.error("Failed to load today status:", e);
        if (notify) showToast("Failed to connect to server.", "error");
    }

    loadHistory();
}

// --- Render Today's Attendance State ---
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
        // No attendance marked yet today
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

    // Has checked in
    checkInTimeEl.textContent = record.check_in_time;
    checkInDateEl.textContent = `${record.date} (IST)`;

    if (record.check_out_time) {
        // Already checked out (Completed for the day)
        checkInBtn.disabled = true;
        checkOutBtn.disabled = true;
        attendanceStatus.textContent = "Completed (Checked Out)";
        attendanceStatus.className = "status-text completed";
        checkOutTimeEl.textContent = record.check_out_time;
        checkOutDateEl.textContent = `${record.date} (IST)`;
        totalHoursEl.textContent = record.total_hours_formatted || "--";
        dayStatusEl.textContent = "Completed";

        // Display final working duration in timer box
        const totalSec = record.working_seconds || 0;
        const hours = String(Math.floor(totalSec / 3600)).padStart(2, "0");
        const minutes = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
        const seconds = String(totalSec % 60).padStart(2, "0");
        document.getElementById("workingTime").textContent = `${hours}:${minutes}:${seconds}`;
        stopWorkingTimer();
    } else {
        // Currently Checked In & Working
        checkInBtn.disabled = true;
        checkOutBtn.disabled = false;
        attendanceStatus.textContent = "Currently Checked In";
        attendanceStatus.className = "status-text active";
        checkOutTimeEl.textContent = "--:--";
        checkOutDateEl.textContent = "Active Shift";
        totalHoursEl.textContent = "In Progress";
        dayStatusEl.textContent = "Present";

        // Start live ticking timer from check-in ISO
        startWorkingTimer(record.check_in_iso);
    }
}

// --- Check In Action ---
async function handleCheckIn() {
    const isDemoMode = document.getElementById("demoModeToggle").checked;

    // Check geofence
    if (userCoordinates && userCoordinates.distance > OFFICE_LOCATION.radius && !isDemoMode) {
        showToast(`You are ${userCoordinates.distance.toFixed(0)}m away. Attendance requires being inside 100m office area (or turn on Test Mode).`, "warning", 6000);
        return;
    }

    const payload = {
        employee_id: EMPLOYEE.id,
        employee_name: EMPLOYEE.name,
        latitude: userCoordinates ? userCoordinates.latitude : OFFICE_LOCATION.latitude,
        longitude: userCoordinates ? userCoordinates.longitude : OFFICE_LOCATION.longitude,
        distance: userCoordinates ? userCoordinates.distance : 0
    };

    const checkInBtn = document.getElementById("checkInBtn");
    checkInBtn.disabled = true;
    checkInBtn.textContent = "Processing...";

    try {
        const res = await fetch("/api/check-in", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.status === "success") {
            showToast(`✅ Checked in at ${data.record.check_in_time} (IST)`, "success");
            renderTodayStatus(data.record);
            loadHistory();
        } else {
            showToast(data.message || "Failed to check in.", "error");
            loadTodayStatus();
        }
    } catch (e) {
        console.error("Check-in request error:", e);
        showToast("Server connection error during check-in.", "error");
        checkInBtn.disabled = false;
    } finally {
        checkInBtn.innerHTML = '<span class="btn-icon">⚡</span> CHECK IN';
    }
}

// --- Check Out Action ---
async function handleCheckOut() {
    const checkOutBtn = document.getElementById("checkOutBtn");
    checkOutBtn.disabled = true;
    checkOutBtn.textContent = "Processing...";

    try {
        const res = await fetch("/api/check-out", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ employee_id: EMPLOYEE.id })
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
        console.error("Check-out request error:", e);
        showToast("Server connection error during check-out.", "error");
        checkOutBtn.disabled = false;
    } finally {
        checkOutBtn.innerHTML = '<span class="btn-icon">🏁</span> CHECK OUT';
    }
}

// --- Load Recent Attendance History ---
async function loadHistory() {
    try {
        const res = await fetch(`/api/history?employee_id=${EMPLOYEE.id}`);
        if (!res.ok) return;

        const data = await res.json();
        const records = data.records || [];

        const tbody = document.getElementById("historyTableBody");
        const countBadge = document.getElementById("recordsCount");
        if (countBadge) countBadge.textContent = `${records.length} Record${records.length === 1 ? '' : 's'}`;

        if (!tbody) return;

        if (records.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No attendance records found yet. Check in to create your first record!</td></tr>`;
            return;
        }

        tbody.innerHTML = records.map(r => {
            const statusClass = r.status === "Completed" ? "completed" : "present";
            const distText = r.distance_meters !== null ? `${Math.round(r.distance_meters)}m` : "Verified";

            return `
                <tr>
                    <td><strong>${r.date}</strong></td>
                    <td class="time-cell">${r.check_in_time} <span style="font-size:10px;color:#64748b;">IST</span></td>
                    <td class="time-cell">${r.check_out_time ? `${r.check_out_time} <span style="font-size:10px;color:#64748b;">IST</span>` : '<span style="color:#f59e0b;">In Progress...</span>'}</td>
                    <td><strong>${r.total_hours_formatted || '--'}</strong></td>
                    <td><span class="history-badge-status ${statusClass}">${r.status}</span></td>
                    <td>📍 <span style="font-size: 12px; color: #475569;">${distText}</span></td>
                </tr>
            `;
        }).join("");
    } catch (e) {
        console.error("Failed to load history:", e);
    }
}

// --- Initialization on page load ---
document.addEventListener("DOMContentLoaded", () => {
    // Start live clock and sync with server IST
    updateLiveClock();
    setInterval(updateLiveClock, 1000);
    syncServerTime();

    // Init GPS location
    initLocationWatcher();

    // Load initial today attendance and history
    loadTodayStatus();
});