// Admin Dashboard Controller

let serverTimeOffsetMs = 0;
let currentDateFilter = "today";
let searchDebounceTimeout = null;

// --- Toast System ---
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

// --- Live Indian Standard Time (IST) Clock ---
function updateAdminLiveClock() {
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

    const dateElem = document.getElementById("adminDate");
    const timeElem = document.getElementById("adminTime");

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
            if (badge) badge.textContent = "Server Synced (IST)";

            // Set default date input value to today in IST
            const dateInput = document.getElementById("adminDateFilter");
            if (dateInput && !dateInput.value) {
                dateInput.value = data.date;
            }
        }
    } catch (e) {
        console.warn("Time sync error:", e);
    }
}

// --- Load Admin Stats ---
async function loadAdminStats() {
    try {
        const res = await fetch("/api/admin/stats");
        if (!res.ok) return;

        const data = await res.json();
        document.getElementById("metricTotalEmployees").textContent = data.total_employees;
        document.getElementById("metricTodayPresent").textContent = data.today_present;
        document.getElementById("metricActiveShifts").textContent = data.active_shifts;
        document.getElementById("metricCompletedShifts").textContent = data.completed_shifts;
        document.getElementById("metricAvgHours").textContent = data.avg_working_hours;
    } catch (e) {
        console.error("Error loading admin stats:", e);
    }
}

// --- Load Filtered Attendance Records ---
async function loadAdminRecords() {
    const searchVal = document.getElementById("adminSearchInput").value.trim();
    const statusVal = document.getElementById("adminStatusFilter").value;
    const dateInput = document.getElementById("adminDateFilter");

    let dateParam = currentDateFilter;
    if (currentDateFilter === "custom" && dateInput.value) {
        dateParam = dateInput.value;
    }

    const url = `/api/admin/records?date=${encodeURIComponent(dateParam)}&search=${encodeURIComponent(searchVal)}&status=${encodeURIComponent(statusVal)}`;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load records");

        const data = await res.json();
        renderAdminTable(data.records || []);
    } catch (e) {
        console.error("Error loading records:", e);
        const tbody = document.getElementById("adminTableBody");
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Error loading records from server.</td></tr>`;
        }
    }
}

// --- Render Table ---
function renderAdminTable(records) {
    const tbody = document.getElementById("adminTableBody");
    const countBadge = document.getElementById("adminRecordsCount");

    if (countBadge) {
        countBadge.textContent = `${records.length} Record${records.length === 1 ? '' : 's'}`;
    }

    if (!tbody) return;

    if (records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No matching attendance records found.</td></tr>`;
        return;
    }

    tbody.innerHTML = records.map(r => {
        const initials = (r.employee_name || "EM").split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
        const isActive = !r.check_out_time;
        const statusClass = isActive ? "present" : "completed";
        const statusText = isActive ? "Active Now" : "Completed";

        // Geofence status
        const isInside = r.distance_meters !== null && r.distance_meters <= 100;
        const distLabel = r.distance_meters !== null ? `${Math.round(r.distance_meters)}m` : "--";
        const geoPillClass = isInside ? "geo-inside" : "geo-outside";
        const geoText = isInside ? `Inside (${distLabel})` : `Outside (${distLabel})`;

        return `
            <tr>
                <td>
                    <div class="table-employee-cell">
                        <div class="table-avatar">${initials}</div>
                        <div>
                            <strong>${r.employee_name}</strong>
                            <span class="table-emp-id">#${r.employee_id}</span>
                        </div>
                    </div>
                </td>
                <td><strong>${r.date}</strong></td>
                <td class="time-cell">${r.check_in_time} <span class="tz-sub">IST</span></td>
                <td class="time-cell">
                    ${r.check_out_time ? `${r.check_out_time} <span class="tz-sub">IST</span>` : '<span class="pulse-tag active-shift">In Progress</span>'}
                </td>
                <td class="time-cell">
                    <strong>${r.live_duration || r.total_hours_formatted || '--'}</strong>
                </td>
                <td>
                    <span class="geo-badge ${geoPillClass}">
                        ${isInside ? '🟢' : '⚠️'} ${geoText}
                    </span>
                </td>
                <td>
                    <span class="history-badge-status ${statusClass}">
                        ${statusText}
                    </span>
                </td>
                <td style="text-align: right;">
                    <div class="row-actions">
                        ${isActive ? `
                            <button
                                class="action-btn force-checkout"
                                onclick="forceCheckOut(${r.id}, '${r.employee_name}')"
                                title="Check Out Employee Now"
                            >
                                🏁 Check Out
                            </button>
                        ` : ''}
                        <button
                            class="action-btn delete-btn"
                            onclick="deleteRecord(${r.id}, '${r.employee_name}', '${r.date}')"
                            title="Delete Record"
                        >
                            🗑️
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

// --- Action Handlers ---
async function forceCheckOut(recordId, empName) {
    if (!confirm(`Are you sure you want to force check out ${empName} with current IST time?`)) {
        return;
    }

    try {
        const res = await fetch(`/api/admin/force-checkout/${recordId}`, { method: "POST" });
        const data = await res.json();

        if (res.ok && data.status === "success") {
            showToast(data.message, "success");
            loadAllAdminData();
        } else {
            showToast(data.message || "Failed to check out.", "error");
        }
    } catch (e) {
        console.error("Force checkout error:", e);
        showToast("Server error during force check out.", "error");
    }
}

async function deleteRecord(recordId, empName, date) {
    if (!confirm(`Delete attendance record for ${empName} on ${date}? This cannot be undone.`)) {
        return;
    }

    try {
        const res = await fetch(`/api/admin/record/${recordId}`, { method: "DELETE" });
        const data = await res.json();

        if (res.ok && data.status === "success") {
            showToast("Attendance record deleted successfully.", "info");
            loadAllAdminData();
        } else {
            showToast(data.message || "Failed to delete record.", "error");
        }
    } catch (e) {
        console.error("Delete error:", e);
        showToast("Server error deleting record.", "error");
    }
}

// --- Filter Controls ---
function setFilterDate(preset) {
    const btnToday = document.getElementById("btnTodayFilter");
    const btnAll = document.getElementById("btnAllFilter");
    const dateInput = document.getElementById("adminDateFilter");

    currentDateFilter = preset;

    if (preset === "today") {
        btnToday.classList.add("active");
        btnAll.classList.remove("active");
    } else if (preset === "all") {
        btnAll.classList.add("active");
        btnToday.classList.remove("active");
        if (dateInput) dateInput.value = "";
    }

    loadAdminRecords();
}

function handleFilterChange() {
    const dateInput = document.getElementById("adminDateFilter");
    const btnToday = document.getElementById("btnTodayFilter");
    const btnAll = document.getElementById("btnAllFilter");

    if (dateInput && dateInput.value) {
        currentDateFilter = "custom";
        btnToday.classList.remove("active");
        btnAll.classList.remove("active");
    }

    loadAdminRecords();
}

function handleSearchDebounce() {
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => {
        loadAdminRecords();
    }, 250);
}

// --- CSV Export ---
function exportCSV() {
    const dateInput = document.getElementById("adminDateFilter");
    let dateParam = currentDateFilter;

    if (currentDateFilter === "custom" && dateInput && dateInput.value) {
        dateParam = dateInput.value;
    }

    showToast("Generating CSV report with IST timestamps...", "info", 2000);
    window.location.href = `/api/admin/export-csv?date=${encodeURIComponent(dateParam)}`;
}

// --- Aggregate Data Loader ---
function loadAllAdminData(notify = false) {
    loadAdminStats();
    loadAdminRecords();
    if (notify) showToast("Admin dashboard data refreshed.", "info");
}

// --- Init ---
document.addEventListener("DOMContentLoaded", () => {
    updateAdminLiveClock();
    setInterval(updateAdminLiveClock, 1000);
    syncServerTime();

    loadAllAdminData();

    // Auto-refresh stats every 30 seconds
    setInterval(() => {
        loadAdminStats();
    }, 30000);
});
