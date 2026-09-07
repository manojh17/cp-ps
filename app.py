import os
import csv
import io
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory, Response
from pymongo import MongoClient, DESCENDING
from bson.objectid import ObjectId

load_dotenv()

app = Flask(__name__, static_folder=".", static_url_path="")

# MongoDB Configuration
MONGO_URI = os.getenv("MONGO_URI", "mongodb+srv://test:28Z7TCRykBfpigiq@it.5yl39aq.mongodb.net/?appName=IT")
DB_NAME = os.getenv("DB_NAME", "attendance_db")

mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=8000)
db = mongo_client[DB_NAME]
attendance_col = db["attendance"]

# Create index for fast employee and date lookups
try:
    attendance_col.create_index([("employee_id", 1), ("date", 1)])
    attendance_col.create_index([("date", 1)])
except Exception as e:
    print("Index creation warning:", e)

# Helper to serialize MongoDB document to JSON-compatible dict
def serialize_record(doc):
    if not doc:
        return None
    record = dict(doc)
    record["id"] = str(record["_id"])
    del record["_id"]
    return record

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

# --- Employee Attendance APIs (MongoDB) ---
@app.route("/api/today", methods=["GET"])
def get_today_status():
    employee_id = request.args.get("employee_id", "EMP001")
    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    doc = attendance_col.find_one(
        {"employee_id": employee_id, "date": today_str},
        sort=[("_id", DESCENDING)]
    )

    if doc:
        record = serialize_record(doc)
        if record.get("check_in_iso") and not record.get("check_out_iso"):
            try:
                check_in_dt = datetime.fromisoformat(record["check_in_iso"])
                elapsed = max(0, int((now_ist - check_in_dt).total_seconds()))
                record["current_elapsed_seconds"] = elapsed
            except Exception:
                record["current_elapsed_seconds"] = 0
        else:
            record["current_elapsed_seconds"] = record.get("working_seconds", 0)

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

    # Prevent duplicate active check-in today
    existing = attendance_col.find_one(
        {"employee_id": employee_id, "date": today_str, "check_out_time": None},
        sort=[("_id", DESCENDING)]
    )
    if existing:
        return jsonify({
            "status": "error",
            "message": f"Already checked in today at {existing['check_in_time']} (IST).",
            "record": serialize_record(existing)
        }), 400

    new_doc = {
        "employee_id": employee_id,
        "employee_name": employee_name,
        "date": today_str,
        "check_in_time": check_in_time,
        "check_in_iso": check_in_iso,
        "check_out_time": None,
        "check_out_iso": None,
        "working_seconds": 0,
        "total_hours_formatted": "--",
        "status": "Present",
        "latitude": latitude,
        "longitude": longitude,
        "distance_meters": distance,
        "created_at": check_in_iso
    }

    result = attendance_col.insert_one(new_doc)
    created_doc = attendance_col.find_one({"_id": result.inserted_id})
    record = serialize_record(created_doc)
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

    doc = attendance_col.find_one(
        {"employee_id": employee_id, "date": today_str, "check_out_time": None},
        sort=[("_id", DESCENDING)]
    )

    if not doc:
        return jsonify({
            "status": "error",
            "message": "No active check-in found for today to check out."
        }), 400

    check_in_dt = datetime.fromisoformat(doc["check_in_iso"])
    working_seconds = max(0, int((now_ist - check_in_dt).total_seconds()))
    duration_formatted = format_duration(working_seconds)

    attendance_col.update_one(
        {"_id": doc["_id"]},
        {"$set": {
            "check_out_time": check_out_time,
            "check_out_iso": check_out_iso,
            "working_seconds": working_seconds,
            "total_hours_formatted": duration_formatted,
            "status": "Completed"
        }}
    )

    updated_doc = attendance_col.find_one({"_id": doc["_id"]})
    record = serialize_record(updated_doc)

    return jsonify({
        "status": "success",
        "message": f"Checked out successfully at {check_out_time} (IST). Total time: {duration_formatted}.",
        "record": record,
        "server_time_iso": check_out_iso
    })

@app.route("/api/history", methods=["GET"])
def get_history():
    employee_id = request.args.get("employee_id", "EMP001")
    limit = int(request.args.get("limit", 15))

    docs = list(attendance_col.find(
        {"employee_id": employee_id}
    ).sort("_id", DESCENDING).limit(limit))

    records = [serialize_record(d) for d in docs]

    return jsonify({
        "status": "success",
        "count": len(records),
        "records": records
    })

# =========================================================
# --- Admin Dashboard APIs (MongoDB) ---
# =========================================================

@app.route("/api/admin/stats", methods=["GET"])
def get_admin_stats():
    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    # Distinct employees
    total_employees = len(attendance_col.distinct("employee_id"))

    # Today's distinct present employees
    today_present = len(attendance_col.distinct("employee_id", {"date": today_str}))

    # Active shifts today (not checked out)
    active_shifts = attendance_col.count_documents({"date": today_str, "check_out_time": None})

    # Completed shifts today
    completed_shifts = attendance_col.count_documents({"date": today_str, "check_out_time": {"$ne": None}})

    # Average working duration for completed today
    pipeline = [
        {"$match": {"date": today_str, "check_out_time": {"$ne": None}}},
        {"$group": {"_id": None, "avg_seconds": {"$avg": "$working_seconds"}}}
    ]
    agg_result = list(attendance_col.aggregate(pipeline))
    avg_seconds = agg_result[0]["avg_seconds"] if agg_result else 0
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

    query = {}

    if date_filter == "today":
        query["date"] = today_str
    elif date_filter != "all" and date_filter:
        query["date"] = date_filter

    if search:
        query["$or"] = [
            {"employee_id": {"$regex": search, "$options": "i"}},
            {"employee_name": {"$regex": search, "$options": "i"}}
        ]

    if status_filter == "active":
        query["check_out_time"] = None
    elif status_filter == "completed":
        query["check_out_time"] = {"$ne": None}

    docs = list(attendance_col.find(query).sort("_id", DESCENDING))
    records = []

    for d in docs:
        r = serialize_record(d)
        if not r.get("check_out_time") and r.get("check_in_iso"):
            try:
                c_in = datetime.fromisoformat(r["check_in_iso"])
                elapsed = max(0, int((now_ist - c_in).total_seconds()))
                r["live_duration"] = format_duration(elapsed)
            except Exception:
                r["live_duration"] = "--"
        else:
            r["live_duration"] = r.get("total_hours_formatted", "--")
        records.append(r)

    return jsonify({
        "status": "success",
        "count": len(records),
        "records": records
    })

@app.route("/api/admin/force-checkout/<record_id>", methods=["POST"])
def admin_force_checkout(record_id):
    now_ist = get_ist_now()
    check_out_time = format_ist_time(now_ist)
    check_out_iso = now_ist.isoformat()

    try:
        obj_id = ObjectId(record_id)
    except Exception:
        return jsonify({"status": "error", "message": "Invalid record ID format."}), 400

    doc = attendance_col.find_one({"_id": obj_id})
    if not doc:
        return jsonify({"status": "error", "message": "Attendance record not found."}), 404

    if doc.get("check_out_time"):
        return jsonify({"status": "error", "message": "Employee is already checked out."}), 400

    check_in_dt = datetime.fromisoformat(doc["check_in_iso"])
    working_seconds = max(0, int((now_ist - check_in_dt).total_seconds()))
    duration_formatted = format_duration(working_seconds)

    attendance_col.update_one(
        {"_id": obj_id},
        {"$set": {
            "check_out_time": check_out_time,
            "check_out_iso": check_out_iso,
            "working_seconds": working_seconds,
            "total_hours_formatted": duration_formatted,
            "status": "Completed"
        }}
    )

    return jsonify({
        "status": "success",
        "message": f"Employee force checked out at {check_out_time} (IST). Duration: {duration_formatted}."
    })

@app.route("/api/admin/record/<record_id>", methods=["DELETE"])
def admin_delete_record(record_id):
    try:
        obj_id = ObjectId(record_id)
    except Exception:
        return jsonify({"status": "error", "message": "Invalid record ID format."}), 400

    result = attendance_col.delete_one({"_id": obj_id})
    if result.deleted_count == 0:
        return jsonify({"status": "error", "message": "Record not found."}), 404

    return jsonify({"status": "success", "message": "Attendance record deleted successfully."})

@app.route("/api/admin/export-csv", methods=["GET"])
def export_csv():
    date_filter = request.args.get("date", "all")
    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    query = {}
    if date_filter == "today":
        query["date"] = today_str
    elif date_filter != "all" and date_filter:
        query["date"] = date_filter

    docs = list(attendance_col.find(query).sort("_id", DESCENDING))

    output = io.StringIO()
    writer = csv.writer(output)

    # Headers
    writer.writerow([
        "Record ID", "Employee ID", "Employee Name", "Date (IST)",
        "Check-In (IST)", "Check-Out (IST)", "Working Duration",
        "Status", "Latitude", "Longitude", "Office Distance (m)", "Created At (IST)"
    ])

    for d in docs:
        r = serialize_record(d)
        writer.writerow([
            r["id"],
            r["employee_id"],
            r["employee_name"],
            r["date"],
            r["check_in_time"],
            r.get("check_out_time") or "Active",
            r.get("total_hours_formatted") if r.get("total_hours_formatted") != "--" else "In Progress",
            r["status"],
            r.get("latitude") or "",
            r.get("longitude") or "",
            round(r["distance_meters"], 1) if r.get("distance_meters") is not None else "",
            r.get("created_at") or ""
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
    print(f"Starting Attendance Server with MongoDB on port {port} (Timezone: IST UTC+05:30)...")
    app.run(host="0.0.0.0", port=port, debug=True)
