// Admin Dashboard Controller

let serverTimeOffsetMs = 0;
let currentDateFilter = "today";
let searchDebounceTimeout = null;
let officeConfig = { latitude: 12.912985, longitude: 79.132010, radius: 200 };
let adminEmployeesList = [];
let adminToken = sessionStorage.getItem("admin_token") || "";

// Auth Header Helper
function getAuthHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (adminToken) {
        headers["Authorization"] = `Bearer ${adminToken}`;
        headers["X-Admin-Password"] = adminToken;
    }
    return headers;
}

// Toast System
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

// --- Authentication Check & Handling ---
async function checkAdminAuth() {
    try {
        const res = await fetch("/api/admin/check-auth", {
            headers: getAuthHeaders()
        });
        const data = await res.json();

        if (res.ok && data.authenticated) {
            showAdminDashboard();
        } else {
            showLoginModal();
        }
    } catch (e) {
        console.error("Auth check failed:", e);
        showLoginModal();
    }
}

function showLoginModal() {
    const modal = document.getElementById("adminLoginModal");
    const app = document.getElementById("adminMainApp");
    if (modal) modal.style.display = "flex";
    if (app) app.style.display = "none";
    const passInput = document.getElementById("adminPasswordInput");
    if (passInput) passInput.focus();
}

function showAdminDashboard() {
    const modal = document.getElementById("adminLoginModal");
    const app = document.getElementById("adminMainApp");
    if (modal) modal.style.display = "none";
    if (app) app.style.display = "flex";

    loadAllAdminData();
}

async function handleAdminLogin(event) {
    event.preventDefault();
    const passInput = document.getElementById("adminPasswordInput");
    const errorMsg = document.getElementById("loginErrorMsg");
    const btnSubmit = document.getElementById("btnLoginSubmit");
    const password = passInput.value.trim();

    if (!password) return;

    btnSubmit.disabled = true;
    btnSubmit.textContent = "Verifying...";
    if (errorMsg) errorMsg.style.display = "none";

    try {
        const res = await fetch("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password })
        });

        const data = await res.json();

        if (res.ok && data.status === "success") {
            adminToken = data.token || password;
            sessionStorage.setItem("admin_token", adminToken);
            showToast("Admin portal unlocked successfully.", "success");
            showAdminDashboard();
        } else {
            if (errorMsg) {
                errorMsg.textContent = data.message || "Incorrect admin password.";
                errorMsg.style.display = "block";
            }
            passInput.value = "";
            passInput.focus();
        }
    } catch (e) {
        console.error("Login error:", e);
        if (errorMsg) {
            errorMsg.textContent = "Connection error. Please try again.";
            errorMsg.style.display = "block";
        }
    } finally {
        btnSubmit.disabled = false;
        btnSubmit.textContent = "Unlock Portal";
    }
}

async function handleAdminLogout() {
    try {
        await fetch("/api/admin/logout", {
            method: "POST",
            headers: getAuthHeaders()
        });
    } catch (e) {
        console.warn("Logout notification error:", e);
    }

    adminToken = "";
    sessionStorage.removeItem("admin_token");
    showToast("Admin logged out.", "info");
    showLoginModal();
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

            const dateInput = document.getElementById("adminDateFilter");
            if (dateInput && !dateInput.value) {
                dateInput.value = data.date;
            }
        }
    } catch (e) {
        console.warn("Time sync error:", e);
    }
}

// Fetch office location config from DB
async function fetchOfficeLocation() {
    try {
        const res = await fetch("/api/office-location");
        if (res.ok) {
            const data = await res.json();
            if (data.location) {
                officeConfig.latitude = Number(data.location.latitude);
                officeConfig.longitude = Number(data.location.longitude);
                officeConfig.radius = Number(data.location.radius);

                const coordsEl = document.getElementById("adminOfficeCoords");
                const radiusEl = document.getElementById("adminOfficeRadius");
                if (coordsEl) coordsEl.textContent = `${officeConfig.latitude.toFixed(6)}, ${officeConfig.longitude.toFixed(6)}`;
                if (radiusEl) radiusEl.textContent = `${officeConfig.radius.toFixed(0)} meters`;
            }
        }
    } catch (e) {
        console.warn("Could not fetch office location:", e);
    }
}

// --- Tab Navigation ---
function switchAdminTab(tab) {
    const tabEmployees = document.getElementById("tabContentEmployees");
    const tabAttendance = document.getElementById("tabContentAttendance");
    const btnEmployees = document.getElementById("tabBtnEmployees");
    const btnAttendance = document.getElementById("tabBtnAttendance");

    if (tab === "employees") {
        tabEmployees.style.display = "block";
        tabAttendance.style.display = "none";
        btnEmployees.classList.add("active");
        btnAttendance.classList.remove("active");
        loadEmployees();
    } else {
        tabEmployees.style.display = "none";
        tabAttendance.style.display = "block";
        btnAttendance.classList.add("active");
        btnEmployees.classList.remove("active");
        loadAdminRecords();
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

// =========================================================
// --- Employee Management ---
// =========================================================

async function loadEmployees() {
    try {
        const res = await fetch("/api/employees");
        if (!res.ok) return;

        const data = await res.json();
        adminEmployeesList = data.employees || [];
        renderEmployeesTable();
        populateEmployeeFilterDropdown();
    } catch (e) {
        console.error("Error loading employees:", e);
    }
}

function populateEmployeeFilterDropdown() {
    const filterEl = document.getElementById("adminEmployeeFilter");
    if (!filterEl) return;
    const currentVal = filterEl.value;
    filterEl.innerHTML = `<option value="all">👥 All Staff Members</option>` +
        adminEmployeesList.map(emp => `<option value="${emp.employee_id}">${emp.name} (${emp.employee_id})</option>`).join("");
    if (currentVal) filterEl.value = currentVal;
}

function renderEmployeesTable() {
    const tbody = document.getElementById("employeesTableBody");
    const countBadge = document.getElementById("empCountBadge");
    const query = (document.getElementById("empSearchInput")?.value || "").toLowerCase().trim();

    if (!tbody) return;

    const filtered = adminEmployeesList.filter(emp => {
        return (
            emp.name.toLowerCase().includes(query) ||
            emp.employee_id.toLowerCase().includes(query) ||
            (emp.role && emp.role.toLowerCase().includes(query))
        );
    });

    if (countBadge) countBadge.textContent = `${filtered.length} Employee${filtered.length === 1 ? '' : 's'}`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No staff members found matching search.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(emp => {
        const salaryFormatted = Number(emp.monthly_salary || 0).toLocaleString("en-IN");
        let todayStatusBadge = `<span class="badge" style="background:#f1f5f9; color:var(--text-light);">Not Checked In</span>`;
        if (emp.today_status === "Active") {
            todayStatusBadge = `<span class="badge badge-warning">Active Now (${emp.today_check_in})</span>`;
        } else if (emp.today_status === "Completed") {
            todayStatusBadge = `<span class="badge badge-success">Completed (${emp.today_check_in} - ${emp.today_check_out})</span>`;
        }

        return `
            <tr>
                <td><strong>${emp.employee_id}</strong></td>
                <td>
                    <div style="font-weight: 700; color: var(--text-main);">${emp.name}</div>
                    <div style="font-size: 11px; color: var(--text-light);">Joined ${emp.created_at_display || 'Active'}</div>
                </td>
                <td><span class="badge badge-info">${emp.role || 'Staff'}</span></td>
                <td><strong style="color: var(--primary);">₹${salaryFormatted}</strong> <span style="font-size: 11px; color: var(--text-light);">/ mo</span></td>
                <td><strong>${emp.total_present_days || 0}</strong> days</td>
                <td>${todayStatusBadge}</td>
                <td style="text-align: right;">
                    <button class="btn btn-secondary btn-sm" onclick="viewStaffHistory('${emp.employee_id}')" title="View Detailed Attendance Logs">
                        👤 History
                    </button>
                    <button class="btn btn-secondary btn-sm" style="color: var(--primary);" onclick="openChangePasswordModal('${emp.employee_id}', '${emp.name.replace(/'/g, "&#39;")}')" title="Change Employee Login Password">
                        🔑 Password
                    </button>
                    <button class="btn btn-secondary btn-sm" style="color: var(--danger);" onclick="deleteEmployee('${emp.employee_id}', '${emp.name}')" title="Remove Employee">
                        🗑️
                    </button>
                </td>
            </tr>
        `;
    }).join("");
}

// Add Employee Modal Handlers
async function openAddEmployeeModal() {
    const modal = document.getElementById("addEmployeeModal");
    const idInput = document.getElementById("newEmpId");
    const nameInput = document.getElementById("newEmpName");
    const roleInput = document.getElementById("newEmpRole");
    const salInput = document.getElementById("newEmpSalary");
    const pwdInput = document.getElementById("newEmpPassword");

    if (nameInput) nameInput.value = "";
    if (roleInput) roleInput.value = "";
    if (salInput) salInput.value = "";
    if (pwdInput) pwdInput.value = "";

    try {
        const res = await fetch("/api/employees/next-id");
        if (res.ok) {
            const data = await res.json();
            if (idInput) idInput.value = data.next_id || "EMP1002";
        }
    } catch (e) {
        if (idInput) idInput.value = "EMP1002";
    }

    if (modal) modal.style.display = "flex";
    if (nameInput) nameInput.focus();
}

function closeAddEmployeeModal() {
    const modal = document.getElementById("addEmployeeModal");
    if (modal) modal.style.display = "none";
}

async function handleCreateEmployee(e) {
    e.preventDefault();
    const idInput = document.getElementById("newEmpId");
    const nameInput = document.getElementById("newEmpName");
    const roleInput = document.getElementById("newEmpRole");
    const salInput = document.getElementById("newEmpSalary");
    const pwdInput = document.getElementById("newEmpPassword");
    const btnSave = document.getElementById("btnSaveEmp");

    const payload = {
        employee_id: idInput.value.trim(),
        name: nameInput.value.trim(),
        role: roleInput.value.trim(),
        monthly_salary: parseFloat(salInput.value) || 0,
        password: pwdInput ? pwdInput.value.trim() : ""
    };

    if (!payload.name || !payload.role) {
        showToast("Please fill in all required fields.", "warning");
        return;
    }

    btnSave.disabled = true;
    btnSave.textContent = "Saving...";

    try {
        const res = await fetch("/api/employees", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (res.ok && data.status === "success") {
            showToast(`Employee ${payload.name} (${payload.employee_id}) created. Default password: ${payload.password || 'emp123'}`, "success", 5000);
            closeAddEmployeeModal();
            loadEmployees();
            loadAdminStats();
        } else {
            showToast(data.message || "Failed to add employee.", "error");
        }
    } catch (err) {
        console.error("Create employee error:", err);
        showToast("Server error while saving employee.", "error");
    } finally {
        btnSave.disabled = false;
        btnSave.textContent = "Save Employee";
    }
}

async function deleteEmployee(empId, empName) {
    if (!confirm(`Are you sure you want to remove ${empName} (${empId}) from the system?`)) {
        return;
    }

    try {
        const res = await fetch(`/api/employees/${empId}`, {
            method: "DELETE",
            headers: getAuthHeaders()
        });

        const data = await res.json();

        if (res.ok && data.status === "success") {
            showToast(data.message, "info");
            loadEmployees();
            loadAdminStats();
        } else {
            showToast(data.message || "Failed to delete employee.", "error");
        }
    } catch (e) {
        console.error("Delete employee error:", e);
        showToast("Server error deleting employee.", "error");
    }
}

let _staffHistoryRecordsMap = {};

// Staff Attendance History Audit Modal
async function viewStaffHistory(empId) {
    const modal = document.getElementById("staffHistoryModal");
    const tbody = document.getElementById("staffHistoryTableBody");

    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading staff history...</td></tr>`;
    if (modal) modal.style.display = "flex";

    try {
        const res = await fetch(`/api/employees/${empId}`);
        const data = await res.json();

        if (res.ok && data.status === "success") {
            const emp = data.employee;
            const records = emp.attendance_history || [];
            _staffHistoryRecordsMap = {};

            document.getElementById("staffModalTitle").textContent = `Audit History: ${emp.name} (#${emp.employee_id})`;
            document.getElementById("staffModalName").textContent = `${emp.name} (#${emp.employee_id})`;
            document.getElementById("staffModalRole").textContent = `${emp.role || 'Staff Member'} • Joined ${emp.created_at ? emp.created_at.slice(0, 10) : 'Active'}`;
            document.getElementById("staffModalSalary").textContent = `₹${Number(emp.monthly_salary || 0).toLocaleString("en-IN")}`;
            document.getElementById("staffModalDays").textContent = `Total ${records.length} days recorded`;

            if (records.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No attendance records recorded for this staff member yet.</td></tr>`;
                return;
            }

            tbody.innerHTML = records.map((r, idx) => {
                const recKey = r.id || `hist_${idx}`;
                r.employee_name = r.employee_name || emp.name;
                r.employee_id = r.employee_id || emp.employee_id;
                _staffHistoryRecordsMap[recKey] = r;

                const isCompleted = r.status === "Completed";
                const badgeClass = isCompleted ? "badge-success" : "badge-warning";

                // In location
                const pIn = r.punch_in || {};
                const inLat = pIn.latitude !== undefined && pIn.latitude !== null ? pIn.latitude : r.latitude;
                const inLon = pIn.longitude !== undefined && pIn.longitude !== null ? pIn.longitude : r.longitude;
                const inAccLevel = pIn.accuracy_level || (pIn.accuracy ? (pIn.accuracy <= 25 ? 'High' : (pIn.accuracy <= 70 ? 'Medium' : 'Low')) : 'Standard');
                const inAccClass = inAccLevel.toLowerCase() === 'high' ? 'badge-success' : (inAccLevel.toLowerCase() === 'medium' ? 'badge-warning' : 'badge-info');

                let inLoc = `<span style="color:var(--text-light);">--</span>`;
                if (inLat && inLon) {
                    inLoc = `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
                        <span style="font-family:'JetBrains Mono', monospace; font-size:11px;">📍 ${Number(inLat).toFixed(4)}, ${Number(inLon).toFixed(4)}</span>
                        <div style="margin-top:3px; display:flex; align-items:center; gap:6px;">
                            <span class="badge ${inAccClass}" style="font-size:10px; padding:1px 5px;">${inAccLevel}</span>
                            <button class="btn btn-secondary btn-sm" style="padding:2px 7px; font-size:10px;" onclick="openAdminMapModalFromKey('${recKey}', 'staff', 'punch_in')">🗺️ View Map</button>
                        </div>
                    </div>`;
                }

                // Out location
                const pOut = r.punch_out || {};
                let outLoc = `<span class="badge badge-warning">Active In Progress</span>`;
                if (r.check_out_time) {
                    if (pOut.latitude && pOut.longitude) {
                        const outAccLevel = pOut.accuracy_level || (pOut.accuracy ? (pOut.accuracy <= 25 ? 'High' : (pOut.accuracy <= 70 ? 'Medium' : 'Low')) : 'Standard');
                        const outAccClass = outAccLevel.toLowerCase() === 'high' ? 'badge-success' : (outAccLevel.toLowerCase() === 'medium' ? 'badge-warning' : 'badge-info');
                        outLoc = `
                            <div><strong>${r.check_out_time}</strong> <span style="font-size:10px;color:var(--text-light);">IST</span></div>
                            <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
                                <span style="font-family:'JetBrains Mono', monospace; font-size:11px;">📍 ${Number(pOut.latitude).toFixed(4)}, ${Number(pOut.longitude).toFixed(4)}</span>
                                <div style="margin-top:3px; display:flex; align-items:center; gap:6px;">
                                    <span class="badge ${outAccClass}" style="font-size:10px; padding:1px 5px;">${outAccLevel}</span>
                                    <button class="btn btn-secondary btn-sm" style="padding:2px 7px; font-size:10px;" onclick="openAdminMapModalFromKey('${recKey}', 'staff', 'punch_out')">🗺️ View Map</button>
                                </div>
                            </div>
                        `;
                    } else {
                        outLoc = `<div><strong>${r.check_out_time}</strong> <span style="font-size:10px;color:var(--text-light);">IST</span></div>`;
                    }
                }

                return `
                    <tr>
                        <td><strong>${r.date}</strong></td>
                        <td>
                            <div><strong>${r.check_in_time}</strong> <span style="font-size:10px;color:var(--text-light);">IST</span></div>
                            ${inLoc}
                        </td>
                        <td>${outLoc}</td>
                        <td><strong>${r.total_hours_formatted || '--'}</strong></td>
                        <td><span class="badge ${badgeClass}">${r.status}</span></td>
                    </tr>
                `;
            }).join("");

        } else {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Failed to load employee details.</td></tr>`;
        }
    } catch (e) {
        console.error("Staff history error:", e);
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Error fetching attendance records.</td></tr>`;
    }
}

function closeStaffHistoryModal() {
    const modal = document.getElementById("staffHistoryModal");
    if (modal) modal.style.display = "none";
}

// =========================================================
// --- Admin Change Employee Password ---
// =========================================================

let _changePwdTargetId = null;

function openChangePasswordModal(empId, empName) {
    _changePwdTargetId = empId;
    const modal = document.getElementById("changePasswordModal");
    const nameEl = document.getElementById("changePwdEmpName");
    const idEl = document.getElementById("changePwdEmpId");
    const newPwdInput = document.getElementById("newPwdInput");
    const confirmPwdInput = document.getElementById("confirmPwdInput");
    const errorEl = document.getElementById("changePwdError");

    if (nameEl) nameEl.textContent = empName;
    if (idEl) idEl.textContent = empId;
    if (newPwdInput) newPwdInput.value = "";
    if (confirmPwdInput) confirmPwdInput.value = "";
    if (errorEl) errorEl.style.display = "none";
    if (modal) modal.style.display = "flex";
    if (newPwdInput) newPwdInput.focus();
}

function closeChangePasswordModal() {
    const modal = document.getElementById("changePasswordModal");
    if (modal) modal.style.display = "none";
    _changePwdTargetId = null;
}

async function handleChangePassword(e) {
    e.preventDefault();
    const newPwd = document.getElementById("newPwdInput").value.trim();
    const confirmPwd = document.getElementById("confirmPwdInput").value.trim();
    const errorEl = document.getElementById("changePwdError");
    const btnChange = document.getElementById("btnChangePwd");

    if (!newPwd || newPwd.length < 4) {
        if (errorEl) { errorEl.textContent = "Password must be at least 4 characters."; errorEl.style.display = "block"; }
        return;
    }
    if (newPwd !== confirmPwd) {
        if (errorEl) { errorEl.textContent = "Passwords do not match. Please try again."; errorEl.style.display = "block"; }
        return;
    }

    if (errorEl) errorEl.style.display = "none";
    btnChange.disabled = true;
    btnChange.textContent = "Updating...";

    try {
        const res = await fetch(`/api/admin/employees/${_changePwdTargetId}/change-password`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ new_password: newPwd })
        });

        const data = await res.json();

        if (res.ok && data.status === "success") {
            showToast(data.message, "success");
            closeChangePasswordModal();
        } else {
            if (errorEl) { errorEl.textContent = data.message || "Failed to update password."; errorEl.style.display = "block"; }
        }
    } catch (err) {
        console.error("Change password error:", err);
        if (errorEl) { errorEl.textContent = "Server error. Please try again."; errorEl.style.display = "block"; }
    } finally {
        btnChange.disabled = false;
        btnChange.textContent = "\ud83d\udd11 Update Password";
    }
}

// =========================================================
// --- Attendance Records Tab & Actions ---
// =========================================================

let _adminRecordsMap = {};

async function loadAdminRecords() {
    const searchVal = document.getElementById("adminSearchInput")?.value.trim() || "";
    const statusVal = document.getElementById("adminStatusFilter")?.value || "all";
    const empVal = document.getElementById("adminEmployeeFilter")?.value || "all";
    const dateInput = document.getElementById("adminDateFilter");

    let dateParam = currentDateFilter;
    if (currentDateFilter === "custom" && dateInput && dateInput.value) {
        dateParam = dateInput.value;
    }

    const url = `/api/admin/records?date=${encodeURIComponent(dateParam)}&search=${encodeURIComponent(searchVal)}&status=${encodeURIComponent(statusVal)}&employee_id=${encodeURIComponent(empVal)}`;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load records");

        const data = await res.json();
        renderAdminTable(data.records || []);
    } catch (e) {
        console.error("Error loading records:", e);
        const tbody = document.getElementById("adminTableBody");
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-state">Error loading records from server.</td></tr>`;
        }
    }
}

function selectEmployeeForRecords(empId) {
    const filterEl = document.getElementById("adminEmployeeFilter");
    if (filterEl) {
        filterEl.value = empId;
        handleFilterChange();
    }
}

function renderAdminTable(records) {
    const tbody = document.getElementById("adminTableBody");
    const countBadge = document.getElementById("adminRecordsCount");

    if (countBadge) {
        countBadge.textContent = `${records.length} Record${records.length === 1 ? '' : 's'}`;
    }

    if (!tbody) return;

    if (records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No matching attendance records found.</td></tr>`;
        return;
    }

    _adminRecordsMap = {};
    tbody.innerHTML = records.map(r => {
        _adminRecordsMap[r.id] = r;
        const isActive = !r.check_out_time;
        const statusBadgeClass = isActive ? "badge-warning" : "badge-success";
        const statusText = isActive ? "Active Shift" : "Completed";

        // In location
        const pIn = r.punch_in || {};
        const inLat = pIn.latitude !== undefined && pIn.latitude !== null ? pIn.latitude : r.latitude;
        const inLon = pIn.longitude !== undefined && pIn.longitude !== null ? pIn.longitude : r.longitude;
        const inAccLevel = pIn.accuracy_level || (pIn.accuracy ? (pIn.accuracy <= 25 ? 'High' : (pIn.accuracy <= 70 ? 'Medium' : 'Low')) : 'Standard');
        const inAccClass = inAccLevel.toLowerCase() === 'high' ? 'badge-success' : (inAccLevel.toLowerCase() === 'medium' ? 'badge-warning' : 'badge-info');

        let inLoc = `<span style="color:var(--text-light);">--</span>`;
        if (inLat && inLon) {
            inLoc = `<div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
                <span style="font-family:'JetBrains Mono', monospace; font-size:11px;">📍 ${Number(inLat).toFixed(4)}, ${Number(inLon).toFixed(4)}</span>
                <div style="margin-top:3px; display:flex; align-items:center; gap:6px;">
                    <span class="badge ${inAccClass}" style="font-size:10px; padding:1px 5px;">${inAccLevel}</span>
                    <button class="btn btn-secondary btn-sm" style="padding:2px 7px; font-size:10px;" onclick="openAdminMapModalFromKey('${r.id}', 'admin', 'punch_in')">🗺️ Map</button>
                </div>
            </div>`;
        }

        // Out location
        const pOut = r.punch_out || {};
        let outLoc = `<span class="badge badge-warning">Active Shift</span>`;
        if (r.check_out_time) {
            if (pOut.latitude && pOut.longitude) {
                const outAccLevel = pOut.accuracy_level || (pOut.accuracy ? (pOut.accuracy <= 25 ? 'High' : (pOut.accuracy <= 70 ? 'Medium' : 'Low')) : 'Standard');
                const outAccClass = outAccLevel.toLowerCase() === 'high' ? 'badge-success' : (outAccLevel.toLowerCase() === 'medium' ? 'badge-warning' : 'badge-info');
                outLoc = `
                    <div><strong>${r.check_out_time}</strong> <span style="font-size:10px;color:var(--text-light);">IST</span></div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
                        <span style="font-family:'JetBrains Mono', monospace; font-size:11px;">📍 ${Number(pOut.latitude).toFixed(4)}, ${Number(pOut.longitude).toFixed(4)}</span>
                        <div style="margin-top:3px; display:flex; align-items:center; gap:6px;">
                            <span class="badge ${outAccClass}" style="font-size:10px; padding:1px 5px;">${outAccLevel}</span>
                            <button class="btn btn-secondary btn-sm" style="padding:2px 7px; font-size:10px;" onclick="openAdminMapModalFromKey('${r.id}', 'admin', 'punch_out')">🗺️ Map</button>
                        </div>
                    </div>
                `;
            } else {
                outLoc = `<div><strong>${r.check_out_time}</strong> <span style="font-size:10px;color:var(--text-light);">IST</span></div>`;
            }
        }

        return `
            <tr>
                <td>
                    <div style="font-weight: 700; color: var(--text-main); cursor:pointer;" onclick="selectEmployeeForRecords('${r.employee_id}')" title="Filter by this staff member">
                        ${r.employee_name} <span style="font-size:10px; color:var(--primary); font-weight:600;">(Filter ↗)</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-light);">#${r.employee_id} • ${r.role || 'Staff'}</div>
                </td>
                <td><strong>${r.date}</strong></td>
                <td>
                    <div><strong>${r.check_in_time}</strong> <span style="font-size:10px;color:var(--text-light);">IST</span></div>
                    ${inLoc}
                </td>
                <td>${outLoc}</td>
                <td><strong>${r.live_duration || r.total_hours_formatted || '--'}</strong></td>
                <td><span class="badge ${statusBadgeClass}">${statusText}</span></td>
                <td style="text-align: right;">
                    <div style="display: inline-flex; gap: 6px;">
                        <button
                            class="btn btn-secondary btn-sm"
                            onclick="viewStaffHistory('${r.employee_id}')"
                            title="View Full History Audit"
                        >
                            👤 History
                        </button>
                        ${isActive ? `
                            <button
                                class="btn btn-secondary btn-sm"
                                onclick="forceCheckOut('${r.id}', '${r.employee_name}')"
                                title="Force Checkout Employee"
                            >
                                🏁 Out
                            </button>
                        ` : ''}
                        <button
                            class="btn btn-secondary btn-sm"
                            style="color: var(--danger);"
                            onclick="deleteRecord('${r.id}', '${r.employee_name}', '${r.date}')"
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

// Action Handlers
async function forceCheckOut(recordId, empName) {
    if (!confirm(`Are you sure you want to force check out ${empName} with current IST time?`)) {
        return;
    }

    try {
        const res = await fetch(`/api/admin/force-checkout/${recordId}`, {
            method: "POST",
            headers: getAuthHeaders()
        });
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
        const res = await fetch(`/api/admin/record/${recordId}`, {
            method: "DELETE",
            headers: getAuthHeaders()
        });
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

// Filter Controls
function setFilterDate(preset) {
    const btnToday = document.getElementById("btnTodayFilter");
    const btnAll = document.getElementById("btnAllFilter");
    const dateInput = document.getElementById("adminDateFilter");

    currentDateFilter = preset;

    if (preset === "today") {
        if (btnToday) btnToday.className = "btn btn-primary btn-sm";
        if (btnAll) btnAll.className = "btn btn-secondary btn-sm";
    } else if (preset === "all") {
        if (btnAll) btnAll.className = "btn btn-primary btn-sm";
        if (btnToday) btnToday.className = "btn btn-secondary btn-sm";
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
        if (btnToday) btnToday.className = "btn btn-secondary btn-sm";
        if (btnAll) btnAll.className = "btn btn-secondary btn-sm";
    }

    loadAdminRecords();
}

function handleSearchDebounce() {
    clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => {
        loadAdminRecords();
    }, 250);
}

// CSV Export
function exportCSV() {
    const dateInput = document.getElementById("adminDateFilter");
    let dateParam = currentDateFilter;

    if (currentDateFilter === "custom" && dateInput && dateInput.value) {
        dateParam = dateInput.value;
    }

    showToast("Generating CSV report with punch-in/out locations...", "info", 2000);
    window.location.href = `/api/admin/export-csv?date=${encodeURIComponent(dateParam)}`;
}

// =========================================================
// --- Interactive Admin Leaflet Map ---
// =========================================================

let _adminLeafletMap = null;
let _activeMapRecord = null;
let _activeMapViewType = 'punch_in';
let _mapMarkers = [];
let _officeCircle = null;

function initLeafletMapIfNeeded() {
    if (_adminLeafletMap) return _adminLeafletMap;
    const mapContainer = document.getElementById("adminLeafletMap");
    if (!mapContainer) return null;

    _adminLeafletMap = L.map('adminLeafletMap').setView([officeConfig.latitude || 12.912985, officeConfig.longitude || 79.132010], 15);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(_adminLeafletMap);

    return _adminLeafletMap;
}

function openAdminMapModalFromKey(key, source, viewType = 'punch_in') {
    const rec = source === 'staff' ? _staffHistoryRecordsMap[key] : _adminRecordsMap[key];
    if (rec) {
        openAdminMapModal(rec, viewType);
    }
}

function openAdminMapModal(record, viewType = 'punch_in') {
    _activeMapRecord = record;
    _activeMapViewType = viewType;

    const modal = document.getElementById("adminMapModal");
    if (modal) modal.style.display = "flex";

    const titleEl = document.getElementById("mapModalTitle");
    const subEl = document.getElementById("mapModalSubtitle");
    if (titleEl) titleEl.textContent = `🗺️ Attendance Map: ${record.employee_name} (${record.employee_id})`;
    if (subEl) subEl.textContent = `Shift Date: ${record.date} (IST) • Status: ${record.status || 'Active'}`;

    switchMapViewToggleState(viewType);

    setTimeout(() => {
        const map = initLeafletMapIfNeeded();
        if (map) {
            map.invalidateSize();
            renderMapContent();
        }
    }, 150);
}

function closeAdminMapModal() {
    const modal = document.getElementById("adminMapModal");
    if (modal) modal.style.display = "none";
}

function switchMapView(viewType) {
    _activeMapViewType = viewType;
    switchMapViewToggleState(viewType);
    renderMapContent();
}

function switchMapViewToggleState(viewType) {
    const btnIn = document.getElementById("btnShowPunchIn");
    const btnOut = document.getElementById("btnShowPunchOut");
    const btnAll = document.getElementById("btnShowAllPins");

    if (btnIn) btnIn.className = viewType === 'punch_in' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
    if (btnOut) btnOut.className = viewType === 'punch_out' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
    if (btnAll) btnAll.className = viewType === 'all' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
}

function renderMapContent() {
    if (!_adminLeafletMap || !_activeMapRecord) return;

    // Clear previous markers
    _mapMarkers.forEach(m => m.remove());
    _mapMarkers = [];
    if (_officeCircle) {
        _officeCircle.remove();
        _officeCircle = null;
    }

    const rec = _activeMapRecord;
    const bounds = [];

    // 1. Draw Office Geofence Circle (Purple)
    if (officeConfig.latitude && officeConfig.longitude) {
        _officeCircle = L.circle([officeConfig.latitude, officeConfig.longitude], {
            color: '#8b5cf6',
            fillColor: '#8b5cf6',
            fillOpacity: 0.12,
            weight: 2,
            dashArray: '5, 5',
            radius: officeConfig.radius || 200
        }).addTo(_adminLeafletMap);

        const officeMarker = L.circleMarker([officeConfig.latitude, officeConfig.longitude], {
            radius: 7,
            color: '#6d28d9',
            fillColor: '#8b5cf6',
            fillOpacity: 1,
            weight: 2
        }).addTo(_adminLeafletMap).bindPopup(`<strong>🏢 Main Office Location</strong><br>Radius: ${officeConfig.radius || 200}m`);

        _mapMarkers.push(officeMarker);
        bounds.push([officeConfig.latitude, officeConfig.longitude]);
    }

    // 2. Punch In Marker (Green)
    const pIn = rec.punch_in || {};
    const inLat = pIn.latitude !== undefined && pIn.latitude !== null ? pIn.latitude : rec.latitude;
    const inLon = pIn.longitude !== undefined && pIn.longitude !== null ? pIn.longitude : rec.longitude;
    let inMarker = null;

    if (inLat && inLon) {
        inMarker = L.circleMarker([inLat, inLon], {
            radius: 10,
            color: '#15803d',
            fillColor: '#22c55e',
            fillOpacity: 0.9,
            weight: 3
        }).addTo(_adminLeafletMap);

        inMarker.bindPopup(`
            <div style="font-size: 13px; line-height: 1.4;">
                <strong style="color: #16a34a; font-size: 14px;">🟢 PUNCH IN</strong><br>
                <strong>${rec.employee_name}</strong> (#${rec.employee_id})<br>
                <span>Time: <strong>${pIn.time || rec.check_in_time} IST</strong></span><br>
                <span>Coordinates: ${Number(inLat).toFixed(5)}, ${Number(inLon).toFixed(5)}</span><br>
                <span>Accuracy: <strong>${pIn.accuracy_level || 'High'}</strong></span><br>
                <span>Distance: <strong>${Math.round(pIn.distance_meters || 0)}m</strong> from office</span>
            </div>
        `);
        _mapMarkers.push(inMarker);
        bounds.push([inLat, inLon]);
    }

    // 3. Punch Out Marker (Blue)
    const pOut = rec.punch_out || {};
    let outMarker = null;
    if (pOut.latitude && pOut.longitude) {
        outMarker = L.circleMarker([pOut.latitude, pOut.longitude], {
            radius: 10,
            color: '#1d4ed8',
            fillColor: '#3b82f6',
            fillOpacity: 0.9,
            weight: 3
        }).addTo(_adminLeafletMap);

        outMarker.bindPopup(`
            <div style="font-size: 13px; line-height: 1.4;">
                <strong style="color: #2563eb; font-size: 14px;">🔵 PUNCH OUT</strong><br>
                <strong>${rec.employee_name}</strong> (#${rec.employee_id})<br>
                <span>Time: <strong>${pOut.time || rec.check_out_time} IST</strong></span><br>
                <span>Coordinates: ${Number(pOut.latitude).toFixed(5)}, ${Number(pOut.longitude).toFixed(5)}</span><br>
                <span>Accuracy: <strong>${pOut.accuracy_level || 'High'}</strong></span><br>
                <span>Distance: <strong>${Math.round(pOut.distance_meters || 0)}m</strong> from office</span>
            </div>
        `);
        _mapMarkers.push(outMarker);
        bounds.push([pOut.latitude, pOut.longitude]);
    }

    // Update Top Info Bar based on active view type
    const punchTypeEl = document.getElementById("mapPunchType");
    const timeEl = document.getElementById("mapTimestamp");
    const coordsEl = document.getElementById("mapCoordinates");
    const accEl = document.getElementById("mapAccuracy");
    const extLink = document.getElementById("externalMapsLink");

    if (_activeMapViewType === 'punch_in' && inLat && inLon) {
        if (punchTypeEl) punchTypeEl.innerHTML = `<span style="color:var(--success);">🟢 Punch In</span> (${rec.date})`;
        if (timeEl) timeEl.textContent = `Recorded at ${pIn.time || rec.check_in_time} IST`;
        if (coordsEl) coordsEl.textContent = `${Number(inLat).toFixed(5)}, ${Number(inLon).toFixed(5)}`;
        if (accEl) accEl.textContent = `Accuracy: ${pIn.accuracy_level || 'High'} • Distance: ${Math.round(pIn.distance_meters || 0)}m from office`;
        if (extLink) extLink.href = `https://www.google.com/maps?q=${inLat},${inLon}`;

        _adminLeafletMap.setView([inLat, inLon], 16);
        if (inMarker) inMarker.openPopup();

    } else if (_activeMapViewType === 'punch_out' && pOut.latitude && pOut.longitude) {
        if (punchTypeEl) punchTypeEl.innerHTML = `<span style="color:var(--primary);">🔵 Punch Out</span> (${rec.date})`;
        if (timeEl) timeEl.textContent = `Recorded at ${pOut.time || rec.check_out_time} IST`;
        if (coordsEl) coordsEl.textContent = `${Number(pOut.latitude).toFixed(5)}, ${Number(pOut.longitude).toFixed(5)}`;
        if (accEl) accEl.textContent = `Accuracy: ${pOut.accuracy_level || 'High'} • Distance: ${Math.round(pOut.distance_meters || 0)}m from office`;
        if (extLink) extLink.href = `https://www.google.com/maps?q=${pOut.latitude},${pOut.longitude}`;

        _adminLeafletMap.setView([pOut.latitude, pOut.longitude], 16);
        if (outMarker) outMarker.openPopup();

    } else {
        // All pins view or fallback
        if (punchTypeEl) punchTypeEl.textContent = `📍 Attendance Audit (${rec.date})`;
        if (timeEl) timeEl.textContent = `In: ${rec.check_in_time} IST | Out: ${rec.check_out_time || 'Active'}`;
        if (coordsEl) coordsEl.textContent = inLat && inLon ? `${Number(inLat).toFixed(5)}, ${Number(inLon).toFixed(5)}` : '--';
        if (accEl) accEl.textContent = `Office Perimeter: ${officeConfig.radius}m`;
        if (extLink && inLat && inLon) extLink.href = `https://www.google.com/maps?q=${inLat},${inLon}`;

        if (bounds.length > 0) {
            _adminLeafletMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        }
    }
}

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", () => {
    fetchOfficeLocation();
    updateAdminLiveClock();
    setInterval(updateAdminLiveClock, 1000);
    syncServerTime();

    checkAdminAuth();

    // Auto-refresh stats every 30 seconds
    setInterval(() => {
        if (document.getElementById("adminMainApp").style.display !== "none") {
            loadAdminStats();
        }
    }, 30000);
});
