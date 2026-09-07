import os
import sqlite3
from datetime import datetime, timezone, timedelta
from flask import Flask, jsonify, request, send_from_directory

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

# Serve Frontend
@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(".", path)

# Server Time API (Indian Standard Time)
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

# Get Today's Attendance Status
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
            # If checked in but not checked out, calculate live elapsed seconds
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

# Check In Endpoint
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
        # Check if already checked in today and not yet checked out
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

        # Insert new check-in
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

# Check Out Endpoint
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

        # Calculate working duration
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

# History Endpoint
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

if __name__ == "__main__":
    # Host on 0.0.0.0 so it can run locally or on any cloud server
    port = int(os.environ.get("PORT", 5000))
    print(f"Starting Attendance Server on port {port} (Timezone: IST UTC+05:30)...")
    app.run(host="0.0.0.0", port=port, debug=True)
