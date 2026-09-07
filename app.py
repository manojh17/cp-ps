import os
import csv
import io
import sqlite3
from datetime import datetime, timezone, timedelta
from flask import Flask, jsonify, request, send_from_directory, Response

app = Flask(__name__, static_folder=".", static_url_path="")
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "attendance.db")

# Indian Standard Time (IST is UTC +05:30)
def get_ist_now():
    """
    Returns current datetime strictly in Indian Standard Time (IST, UTC+05:30).
    Works universally across any hosting provider, OS, or server location worldwide.
    """
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Asia/Kolkata"))
    except Exception:
        ist_tz = timezone(timedelta(hours=5, minutes=30), name="IST")
        return datetime.now(ist_tz)

def format_ist_time(dt):
    return dt.strftime("%I:%M:%S %p")

def format_ist_date(dt):
    return dt.strftime("%Y-%m-%d")

def format_duration(seconds):
    if seconds is None or seconds <= 0:
        return "0s"
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    if hours > 0:
        return f"{hours}h {minutes}m"
    elif minutes > 0:
        return f"{minutes}m {secs}s"
    else:
        return f"{secs}s"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_id TEXT NOT NULL,
                employee_name TEXT NOT NULL,
                date TEXT NOT NULL,
                check_in_time TEXT NOT NULL,
                check_in_iso TEXT NOT NULL,
                check_out_time TEXT,
                check_out_iso TEXT,
                working_seconds INTEGER DEFAULT 0,
                total_hours_formatted TEXT DEFAULT '--',
                status TEXT NOT NULL,
                latitude REAL,
                longitude REAL,
                distance_meters REAL,
                created_at TEXT NOT NULL
            )
        """)
        conn.commit()

init_db()

# --- Page Routes ---
@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/admin")
def admin_page():
    return send_from_directory(".", "admin.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(".", path)

# --- Common APIs ---
@app.route("/api/time", methods=["GET"])
def get_time():
    now_ist = get_ist_now()
    return jsonify({
        "status": "success",
        "timezone": "IST (UTC+05:30)",
        "iso": now_ist.isoformat(),
        "date": format_ist_date(now_ist),
        "date_display": now_ist.strftime("%A, %d %B %Y"),
        "time": format_ist_time(now_ist),
        "timestamp": int(now_ist.timestamp())
    })

# --- Employee Portal APIs ---
@app.route("/api/today", methods=["GET"])
def get_today_status():
    employee_id = request.args.get("employee_id", "EMP001")
    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM attendance WHERE employee_id = ? AND date = ? ORDER BY id DESC LIMIT 1",
            (employee_id, today_str)
        )
        row = cursor.fetchone()

        if row:
            record = dict(row)
            if record["check_in_iso"] and not record["check_out_iso"]:
                try:
                    check_in_dt = datetime.fromisoformat(record["check_in_iso"])
                    elapsed = max(0, int((now_ist - check_in_dt).total_seconds()))
                    record["current_elapsed_seconds"] = elapsed
                except Exception:
                    record["current_elapsed_seconds"] = 0
            else:
                record["current_elapsed_seconds"] = record["working_seconds"]

            return jsonify({
                "status": "success",
                "has_record": True,
                "record": record,
                "server_time_iso": now_ist.isoformat()
            })

    return jsonify({
        "status": "success",
        "has_record": False,
        "record": None,
        "server_time_iso": now_ist.isoformat()
    })

@app.route("/api/check-in", methods=["POST"])
def check_in():
    data = request.get_json() or {}
    employee_id = data.get("employee_id", "EMP001")
    employee_name = data.get("employee_name", "Manojh")
    latitude = data.get("latitude")
    longitude = data.get("longitude")
    distance = data.get("distance", 0)

    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)
    check_in_time = format_ist_time(now_ist)
    check_in_iso = now_ist.isoformat()

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM attendance WHERE employee_id = ? AND date = ? AND check_out_time IS NULL ORDER BY id DESC LIMIT 1",
            (employee_id, today_str)
        )
        existing = cursor.fetchone()
        if existing:
            return jsonify({
                "status": "error",
                "message": f"Already checked in today at {existing['check_in_time']} (IST).",
                "record": dict(existing)
            }), 400

        cursor.execute("""
            INSERT INTO attendance (
                employee_id, employee_name, date,
                check_in_time, check_in_iso, status,
                latitude, longitude, distance_meters, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            employee_id,
            employee_name,
            today_str,
            check_in_time,
            check_in_iso,
            "Present",
            latitude,
            longitude,
            distance,
            check_in_iso
        ))
        conn.commit()
        record_id = cursor.lastrowid

        cursor.execute("SELECT * FROM attendance WHERE id = ?", (record_id,))
        record = dict(cursor.fetchone())
        record["current_elapsed_seconds"] = 0

    return jsonify({
        "status": "success",
        "message": f"Checked in successfully at {check_in_time} (IST)",
        "record": record,
        "server_time_iso": check_in_iso
    })

@app.route("/api/check-out", methods=["POST"])
def check_out():
    data = request.get_json() or {}
    employee_id = data.get("employee_id", "EMP001")

    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)
    check_out_time = format_ist_time(now_ist)
    check_out_iso = now_ist.isoformat()

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM attendance WHERE employee_id = ? AND date = ? AND check_out_time IS NULL ORDER BY id DESC LIMIT 1",
            (employee_id, today_str)
        )
        record = cursor.fetchone()

        if not record:
            return jsonify({
                "status": "error",
                "message": "No active check-in found for today to check out."
            }), 400

        record_id = record["id"]
        check_in_iso = record["check_in_iso"]

        check_in_dt = datetime.fromisoformat(check_in_iso)
        working_seconds = max(0, int((now_ist - check_in_dt).total_seconds()))
        duration_formatted = format_duration(working_seconds)

        cursor.execute("""
            UPDATE attendance
            SET check_out_time = ?,
                check_out_iso = ?,
                working_seconds = ?,
                total_hours_formatted = ?,
                status = ?
            WHERE id = ?
        """, (
            check_out_time,
            check_out_iso,
            working_seconds,
            duration_formatted,
            "Completed",
            record_id
        ))
        conn.commit()

        cursor.execute("SELECT * FROM attendance WHERE id = ?", (record_id,))
        updated_record = dict(cursor.fetchone())

    return jsonify({
        "status": "success",
        "message": f"Checked out successfully at {check_out_time} (IST). Total time: {duration_formatted}.",
        "record": updated_record,
        "server_time_iso": check_out_iso
    })

@app.route("/api/history", methods=["GET"])
def get_history():
    employee_id = request.args.get("employee_id", "EMP001")
    limit = int(request.args.get("limit", 15))

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM attendance WHERE employee_id = ? ORDER BY id DESC LIMIT ?",
            (employee_id, limit)
        )
        records = [dict(row) for row in cursor.fetchall()]

    return jsonify({
        "status": "success",
        "count": len(records),
        "records": records
    })

# =========================================================
# --- Admin Dashboard APIs ---
# =========================================================

@app.route("/api/admin/stats", methods=["GET"])
def get_admin_stats():
    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    with get_db() as conn:
        cursor = conn.cursor()

        # Total distinct employees in database
        cursor.execute("SELECT COUNT(DISTINCT employee_id) FROM attendance")
        total_employees = cursor.fetchone()[0] or 0

        # Today's distinct present employees
        cursor.execute("SELECT COUNT(DISTINCT employee_id) FROM attendance WHERE date = ?", (today_str,))
        today_present = cursor.fetchone()[0] or 0

        # Currently active shifts today (not checked out)
        cursor.execute("SELECT COUNT(*) FROM attendance WHERE date = ? AND check_out_time IS NULL", (today_str,))
        active_shifts = cursor.fetchone()[0] or 0

        # Completed shifts today
        cursor.execute("SELECT COUNT(*) FROM attendance WHERE date = ? AND check_out_time IS NOT NULL", (today_str,))
        completed_shifts = cursor.fetchone()[0] or 0

        # Average working duration for completed today
        cursor.execute("SELECT AVG(working_seconds) FROM attendance WHERE date = ? AND check_out_time IS NOT NULL", (today_str,))
        avg_seconds = cursor.fetchone()[0] or 0
        avg_hours_str = format_duration(int(avg_seconds)) if avg_seconds else "--"

    return jsonify({
        "status": "success",
        "date": today_str,
        "date_display": now_ist.strftime("%A, %d %B %Y"),
        "time": format_ist_time(now_ist),
        "total_employees": max(total_employees, 1),
        "today_present": today_present,
        "active_shifts": active_shifts,
        "completed_shifts": completed_shifts,
        "avg_working_hours": avg_hours_str
    })

@app.route("/api/admin/records", methods=["GET"])
def get_admin_records():
    date_filter = request.args.get("date", "today")
    search = request.args.get("search", "").strip()
    status_filter = request.args.get("status", "all")

    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    query = "SELECT * FROM attendance WHERE 1=1"
    params = []

    if date_filter == "today":
        query += " AND date = ?"
        params.append(today_str)
    elif date_filter != "all" and date_filter:
        query += " AND date = ?"
        params.append(date_filter)

    if search:
        query += " AND (employee_id LIKE ? OR employee_name LIKE ?)"
        params.extend([f"%{search}%", f"%{search}%"])

    if status_filter == "active":
        query += " AND check_out_time IS NULL"
    elif status_filter == "completed":
        query += " AND check_out_time IS NOT NULL"

    query += " ORDER BY id DESC"

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        records = [dict(row) for row in cursor.fetchall()]

        # Compute live elapsed seconds for active records
        for r in records:
            if not r["check_out_time"] and r["check_in_iso"]:
                try:
                    c_in = datetime.fromisoformat(r["check_in_iso"])
                    elapsed = max(0, int((now_ist - c_in).total_seconds()))
                    r["live_duration"] = format_duration(elapsed)
                except Exception:
                    r["live_duration"] = "--"
            else:
                r["live_duration"] = r["total_hours_formatted"]

    return jsonify({
        "status": "success",
        "count": len(records),
        "records": records
    })

@app.route("/api/admin/force-checkout/<int:record_id>", methods=["POST"])
def admin_force_checkout(record_id):
    now_ist = get_ist_now()
    check_out_time = format_ist_time(now_ist)
    check_out_iso = now_ist.isoformat()

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM attendance WHERE id = ?", (record_id,))
        record = cursor.fetchone()

        if not record:
            return jsonify({"status": "error", "message": "Attendance record not found."}), 404

        if record["check_out_time"]:
            return jsonify({"status": "error", "message": "Employee is already checked out."}), 400

        check_in_dt = datetime.fromisoformat(record["check_in_iso"])
        working_seconds = max(0, int((now_ist - check_in_dt).total_seconds()))
        duration_formatted = format_duration(working_seconds)

        cursor.execute("""
            UPDATE attendance
            SET check_out_time = ?,
                check_out_iso = ?,
                working_seconds = ?,
                total_hours_formatted = ?,
                status = ?
            WHERE id = ?
        """, (
            check_out_time,
            check_out_iso,
            working_seconds,
            duration_formatted,
            "Completed",
            record_id
        ))
        conn.commit()

    return jsonify({
        "status": "success",
        "message": f"Employee force checked out at {check_out_time} (IST). Duration: {duration_formatted}."
    })

@app.route("/api/admin/record/<int:record_id>", methods=["DELETE"])
def admin_delete_record(record_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM attendance WHERE id = ?", (record_id,))
        conn.commit()
        if cursor.rowcount == 0:
            return jsonify({"status": "error", "message": "Record not found."}), 404

    return jsonify({"status": "success", "message": "Attendance record deleted successfully."})

@app.route("/api/admin/export-csv", methods=["GET"])
def export_csv():
    date_filter = request.args.get("date", "all")
    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    query = "SELECT * FROM attendance"
    params = []
    if date_filter == "today":
        query += " WHERE date = ?"
        params.append(today_str)
    elif date_filter != "all" and date_filter:
        query += " WHERE date = ?"
        params.append(date_filter)

    query += " ORDER BY id DESC"

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(query, params)
        records = cursor.fetchall()

    output = io.StringIO()
    writer = csv.writer(output)

    # Headers
    writer.writerow([
        "Record ID", "Employee ID", "Employee Name", "Date (IST)",
        "Check-In (IST)", "Check-Out (IST)", "Working Duration",
        "Status", "Latitude", "Longitude", "Office Distance (m)", "Created At (IST)"
    ])

    for r in records:
        writer.writerow([
            r["id"],
            r["employee_id"],
            r["employee_name"],
            r["date"],
            r["check_in_time"],
            r["check_out_time"] or "Active",
            r["total_hours_formatted"] if r["total_hours_formatted"] != "--" else "In Progress",
            r["status"],
            r["latitude"] or "",
            r["longitude"] or "",
            round(r["distance_meters"], 1) if r["distance_meters"] is not None else "",
            r["created_at"]
        ])

    csv_data = output.getvalue()
    filename = f"attendance_records_{date_filter}_{today_str}_IST.csv"

    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Starting Attendance Server on port {port} (Timezone: IST UTC+05:30)...")
    app.run(host="0.0.0.0", port=port, debug=True)
