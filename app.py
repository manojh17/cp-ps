import os
import csv
import io
import math
import secrets
from functools import wraps
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory, Response, session
from pymongo import MongoClient, DESCENDING
from bson.objectid import ObjectId
from werkzeug.security import generate_password_hash, check_password_hash

load_dotenv()

app = Flask(__name__, static_folder=".", static_url_path="")
app.secret_key = os.getenv("SECRET_KEY", "attendance-secret-key-2026")

# Admin Security Configuration
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
DEFAULT_EMPLOYEE_PASSWORD = os.getenv("DEFAULT_EMPLOYEE_PASSWORD", "emp123")

# MongoDB Configuration
MONGO_URI = os.getenv("MONGO_URI", "mongodb+srv://test:28Z7TCRykBfpigiq@it.5yl39aq.mongodb.net/?appName=IT")
DB_NAME = os.getenv("DB_NAME", "attendance_db")

mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=8000)
db = mongo_client[DB_NAME]
attendance_col = db["attendance"]
settings_col = db["settings"]
employees_col = db["employees"]

# Office Location Configuration (Configured from DB / .env)
DEFAULT_OFFICE_LAT = float(os.getenv("OFFICE_LAT", 12.912985))
DEFAULT_OFFICE_LON = float(os.getenv("OFFICE_LON", 79.132010))
DEFAULT_OFFICE_RADIUS = float(os.getenv("OFFICE_RADIUS", 200))

def get_office_location():
    """
    Retrieves office location from MongoDB settings collection.
    If not yet initialized in DB, seeds it from .env variables or defaults.
    """
    try:
        doc = settings_col.find_one({"_id": "office_location"})
        if doc:
            return {
                "latitude": float(doc.get("latitude", DEFAULT_OFFICE_LAT)),
                "longitude": float(doc.get("longitude", DEFAULT_OFFICE_LON)),
                "radius": float(doc.get("radius", DEFAULT_OFFICE_RADIUS)),
                "name": doc.get("name", "Office")
            }
        else:
            initial_config = {
                "_id": "office_location",
                "name": "Main Office",
                "latitude": DEFAULT_OFFICE_LAT,
                "longitude": DEFAULT_OFFICE_LON,
                "radius": DEFAULT_OFFICE_RADIUS,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            settings_col.insert_one(initial_config)
            return {
                "latitude": DEFAULT_OFFICE_LAT,
                "longitude": DEFAULT_OFFICE_LON,
                "radius": DEFAULT_OFFICE_RADIUS,
                "name": "Main Office"
            }
    except Exception as e:
        print("Error fetching office location from DB:", e)
        return {
            "latitude": DEFAULT_OFFICE_LAT,
            "longitude": DEFAULT_OFFICE_LON,
            "radius": DEFAULT_OFFICE_RADIUS,
            "name": "Main Office"
        }

def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371000  # Earth radius in meters
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

# Indexes for fast querying
try:
    attendance_col.create_index([("employee_id", 1), ("date", 1)])
    attendance_col.create_index([("date", 1)])
    employees_col.create_index([("employee_id", 1)], unique=True)
    employees_col.create_index([("auth_token", 1)], sparse=True)
except Exception as e:
    print("Index creation warning:", e)

# Helper to serialize MongoDB document to JSON-compatible dict (excluding sensitive auth data)
def serialize_record(doc):
    if not doc:
        return None
    record = dict(doc)
    record["id"] = str(record["_id"])
    del record["_id"]
    # Never leak password hash or internal auth token in public API responses
    record.pop("password_hash", None)
    record.pop("auth_token", None)
    return record

# Indian Standard Time (IST is UTC +05:30)
def get_ist_now():
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

# Auto-generate next employee ID
def get_next_employee_id():
    try:
        docs = list(employees_col.find({}, {"employee_id": 1}))
        max_num = 1000
        for d in docs:
            emp_id = str(d.get("employee_id", ""))
            if emp_id.startswith("EMP"):
                num_str = emp_id[3:]
                if num_str.isdigit():
                    max_num = max(max_num, int(num_str))
        return f"EMP{max_num + 1}"
    except Exception as e:
        print("Error generating next employee id:", e)
        return "EMP1001"

# Seed default employee and migrate any unhashed employee accounts
def seed_default_employee():
    try:
        now_ist = get_ist_now()

        # Schema migration: Ensure any existing employees without password_hash get the default hashed password
        unhashed = list(employees_col.find({"password_hash": {"$exists": False}}))
        for emp in unhashed:
            employees_col.update_one(
                {"_id": emp["_id"]},
                {"$set": {
                    "password_hash": generate_password_hash(DEFAULT_EMPLOYEE_PASSWORD),
                    "password_updated_at": now_ist.isoformat(),
                    "auth_token": None,
                    "token_created_at": None,
                    "last_login_at": None
                }}
            )
            print(f"Migrated default password for existing employee: {emp.get('employee_id')}")

        # If completely empty, insert default employee
        if employees_col.count_documents({}) == 0:
            default_emp = {
                "employee_id": "EMP1001",
                "name": "Manojh",
                "role": "Lead Engineer",
                "monthly_salary": 75000.0,
                "status": "Active",
                "password_hash": generate_password_hash(DEFAULT_EMPLOYEE_PASSWORD),
                "auth_token": None,
                "token_created_at": None,
                "last_login_at": None,
                "password_updated_at": now_ist.isoformat(),
                "created_at": now_ist.isoformat(),
                "created_at_display": now_ist.strftime("%d %b %Y, %I:%M %p")
            }
            employees_col.insert_one(default_emp)
            print("Seeded default employee: EMP1001 with default password")
    except Exception as e:
        print("Employee seeding/migration warning:", e)

seed_default_employee()

# Admin Authentication Decorator
def is_admin_authenticated():
    if session.get("admin_logged_in"):
        return True
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header.split("Bearer ", 1)[1].strip()
        if token == ADMIN_PASSWORD:
            return True
    if request.headers.get("X-Admin-Password") == ADMIN_PASSWORD:
        return True
    return False

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not is_admin_authenticated():
            return jsonify({
                "status": "error",
                "message": "Admin authorization required. Please login."
            }), 401
        return f(*args, **kwargs)
    return decorated_function

# Employee Authentication Helper
def get_authenticated_employee():
    """
    Extracts Bearer token or X-Employee-Token from request headers.
    Returns the employee document from MongoDB if token matches and employee is Active.
    """
    token = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header.split("Bearer ", 1)[1].strip()
    if not token:
        token = request.headers.get("X-Employee-Token", "").strip()

    if not token or token == ADMIN_PASSWORD:
        return None

    emp = employees_col.find_one({"auth_token": token, "status": "Active"})
    return emp

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

# --- Admin Authentication APIs ---
@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    data = request.get_json() or {}
    password = data.get("password", "").strip()

    if password == ADMIN_PASSWORD:
        session["admin_logged_in"] = True
        return jsonify({
            "status": "success",
            "message": "Admin logged in successfully.",
            "token": ADMIN_PASSWORD
        })
    else:
        return jsonify({
            "status": "error",
            "message": "Incorrect admin password."
        }), 401

@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("admin_logged_in", None)
    return jsonify({
        "status": "success",
        "message": "Logged out successfully."
    })

@app.route("/api/admin/check-auth", methods=["GET"])
def admin_check_auth():
    return jsonify({
        "status": "success",
        "authenticated": is_admin_authenticated()
    })

# --- Employee Authentication APIs (One-Time Login & Persistent Token) ---
@app.route("/api/employee/login", methods=["POST"])
def employee_login():
    data = request.get_json() or {}
    employee_id = data.get("employee_id", "").strip().upper()
    password = data.get("password", "").strip()

    if not employee_id or not password:
        return jsonify({
            "status": "error",
            "message": "Please provide both Employee ID and password."
        }), 400

    emp = employees_col.find_one({"employee_id": employee_id})
    if not emp:
        return jsonify({
            "status": "error",
            "message": "Invalid Employee ID or password."
        }), 401

    if emp.get("status") != "Active":
        return jsonify({
            "status": "error",
            "message": "This employee account is inactive. Please contact admin."
        }), 403

    pwd_hash = emp.get("password_hash")
    # If unhashed legacy account, migrate it with DEFAULT_EMPLOYEE_PASSWORD
    if not pwd_hash:
        pwd_hash = generate_password_hash(DEFAULT_EMPLOYEE_PASSWORD)
        employees_col.update_one({"_id": emp["_id"]}, {"$set": {"password_hash": pwd_hash}})

    if not check_password_hash(pwd_hash, password):
        return jsonify({
            "status": "error",
            "message": "Invalid Employee ID or password."
        }), 401

    # Issue persistent session token
    token = secrets.token_hex(32)
    now_ist = get_ist_now().isoformat()

    employees_col.update_one(
        {"_id": emp["_id"]},
        {"$set": {
            "auth_token": token,
            "token_created_at": now_ist,
            "last_login_at": now_ist
        }}
    )

    safe_emp = serialize_record(emp)
    return jsonify({
        "status": "success",
        "message": f"Welcome back, {emp.get('name')}!",
        "token": token,
        "employee": safe_emp
    })

@app.route("/api/employee/me", methods=["GET"])
def employee_me():
    emp = get_authenticated_employee()
    if not emp:
        return jsonify({
            "status": "error",
            "message": "Invalid or expired session token."
        }), 401

    return jsonify({
        "status": "success",
        "employee": serialize_record(emp)
    })

@app.route("/api/employee/logout", methods=["POST"])
def employee_logout():
    token = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header.split("Bearer ", 1)[1].strip()
    if not token:
        token = request.headers.get("X-Employee-Token", "").strip()

    if token:
        employees_col.update_one(
            {"auth_token": token},
            {"$set": {"auth_token": None}}
        )

    return jsonify({
        "status": "success",
        "message": "Logged out successfully."
    })

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

def get_accuracy_level(accuracy_val):
    try:
        if accuracy_val is None:
            return "Unknown"
        acc = float(accuracy_val)
        if acc <= 25.0:
            return "High"
        elif acc <= 70.0:
            return "Medium"
        else:
            return "Low"
    except Exception:
        return "Unknown"

# --- Office Location API ---
@app.route("/api/office-location", methods=["GET", "POST"])
def office_location():
    if request.method == "POST":
        if not is_admin_authenticated():
            return jsonify({"status": "error", "message": "Admin authentication required."}), 401

        data = request.get_json() or {}
        lat = float(data.get("latitude", DEFAULT_OFFICE_LAT))
        lon = float(data.get("longitude", DEFAULT_OFFICE_LON))
        radius = float(data.get("radius", DEFAULT_OFFICE_RADIUS))
        name = data.get("name", "Main Office")

        settings_col.update_one(
            {"_id": "office_location"},
            {"$set": {
                "latitude": lat,
                "longitude": lon,
                "radius": radius,
                "name": name,
                "updated_at": get_ist_now().isoformat()
            }},
            upsert=True
        )
        return jsonify({
            "status": "success",
            "message": "Office location updated successfully.",
            "location": get_office_location()
        })

    # GET request: Hide exact office coordinates from employee portal for security
    if is_admin_authenticated():
        return jsonify({
            "status": "success",
            "location": get_office_location()
        })

    loc = get_office_location()
    return jsonify({
        "status": "success",
        "location": {
            "name": loc.get("name", "Main Office"),
            "radius": loc.get("radius", DEFAULT_OFFICE_RADIUS)
        }
    })

# Employee Geofence Validation Endpoint (Coordinates stay private on server)
@app.route("/api/check-geofence", methods=["POST"])
def check_geofence():
    data = request.get_json() or {}
    lat = data.get("latitude")
    lon = data.get("longitude")
    if lat is None or lon is None:
        return jsonify({"status": "error", "message": "Coordinates required"}), 400
    try:
        lat_f = float(lat)
        lon_f = float(lon)
        office = get_office_location()
        dist = calculate_distance(lat_f, lon_f, office["latitude"], office["longitude"])
        is_inside = dist <= office["radius"]
        return jsonify({
            "status": "success",
            "is_inside": is_inside
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400

# =========================================================
# --- Employee Management APIs ---
# =========================================================

@app.route("/api/employees", methods=["GET"])
def get_employees():
    docs = list(employees_col.find().sort("employee_id", 1))
    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    employees = []
    for d in docs:
        emp = serialize_record(d)
        emp_id = emp["employee_id"]

        # Calculate attendance statistics
        total_present_days = attendance_col.count_documents({"employee_id": emp_id})
        today_record = attendance_col.find_one(
            {"employee_id": emp_id, "date": today_str},
            sort=[("_id", DESCENDING)]
        )

        emp["total_present_days"] = total_present_days
        if today_record:
            emp["today_status"] = "Completed" if today_record.get("check_out_time") else "Active"
            emp["today_check_in"] = today_record.get("check_in_time")
            emp["today_check_out"] = today_record.get("check_out_time")
        else:
            emp["today_status"] = "Not Checked In"
            emp["today_check_in"] = None
            emp["today_check_out"] = None

        employees.append(emp)

    return jsonify({
        "status": "success",
        "count": len(employees),
        "employees": employees
    })

@app.route("/api/employees/next-id", methods=["GET"])
def next_employee_id():
    return jsonify({
        "status": "success",
        "next_id": get_next_employee_id()
    })

@app.route("/api/employees", methods=["POST"])
@admin_required
def add_employee():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    role = data.get("role", "").strip()
    salary_raw = data.get("monthly_salary", 0)
    password = data.get("password", "").strip()
    if not password:
        password = DEFAULT_EMPLOYEE_PASSWORD

    if not name:
        return jsonify({"status": "error", "message": "Employee name is required."}), 400
    if not role:
        return jsonify({"status": "error", "message": "Employee role is required."}), 400

    try:
        monthly_salary = float(salary_raw)
        if monthly_salary < 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"status": "error", "message": "Monthly salary must be a valid non-negative number."}), 400

    # Auto-generate or validate custom employee ID
    emp_id = data.get("employee_id", "").strip().upper()
    if not emp_id:
        emp_id = get_next_employee_id()

    # Check if ID already exists
    if employees_col.find_one({"employee_id": emp_id}):
        return jsonify({"status": "error", "message": f"Employee ID '{emp_id}' already exists."}), 400

    now_ist = get_ist_now()
    new_emp = {
        "employee_id": emp_id,
        "name": name,
        "role": role,
        "monthly_salary": monthly_salary,
        "status": "Active",
        "password_hash": generate_password_hash(password),
        "auth_token": None,
        "token_created_at": None,
        "last_login_at": None,
        "password_updated_at": now_ist.isoformat(),
        "created_at": now_ist.isoformat(),
        "created_at_display": now_ist.strftime("%d %b %Y, %I:%M %p")
    }

    employees_col.insert_one(new_emp)
    created = serialize_record(employees_col.find_one({"employee_id": emp_id}))

    return jsonify({
        "status": "success",
        "message": f"Employee {name} ({emp_id}) added successfully.",
        "employee": created
    }), 201

# Admin-Only: Change Employee Password
@app.route("/api/admin/employees/<emp_id>/change-password", methods=["POST"])
@admin_required
def admin_change_employee_password(emp_id):
    emp = employees_col.find_one({"employee_id": emp_id})
    if not emp:
        return jsonify({"status": "error", "message": "Employee not found."}), 404

    data = request.get_json() or {}
    new_password = data.get("new_password", "").strip()

    if not new_password or len(new_password) < 4:
        return jsonify({
            "status": "error",
            "message": "New password must be at least 4 characters long."
        }), 400

    now_ist = get_ist_now().isoformat()
    employees_col.update_one(
        {"employee_id": emp_id},
        {"$set": {
            "password_hash": generate_password_hash(new_password),
            "password_updated_at": now_ist
        }}
    )

    return jsonify({
        "status": "success",
        "message": f"Password for {emp.get('name')} ({emp_id}) updated successfully."
    })

@app.route("/api/employees/<emp_id>", methods=["GET"])
def get_employee_profile(emp_id):
    emp = employees_col.find_one({"employee_id": emp_id})
    if not emp:
        return jsonify({"status": "error", "message": "Employee not found."}), 404

    history_docs = list(attendance_col.find({"employee_id": emp_id}).sort("_id", DESCENDING))
    history = [serialize_record(d) for d in history_docs]

    emp_data = serialize_record(emp)
    emp_data["attendance_history"] = history
    emp_data["total_records"] = len(history)

    return jsonify({
        "status": "success",
        "employee": emp_data
    })

@app.route("/api/employees/<emp_id>", methods=["DELETE"])
@admin_required
def delete_employee(emp_id):
    emp = employees_col.find_one({"employee_id": emp_id})
    if not emp:
        return jsonify({"status": "error", "message": "Employee not found."}), 404

    employees_col.delete_one({"employee_id": emp_id})
    return jsonify({
        "status": "success",
        "message": f"Employee '{emp.get('name')}' ({emp_id}) removed successfully."
    })

# =========================================================
# --- Employee Attendance APIs (MongoDB) ---
# =========================================================

@app.route("/api/today", methods=["GET"])
def get_today_status():
    auth_emp = get_authenticated_employee()
    if auth_emp:
        employee_id = auth_emp["employee_id"]
    else:
        employee_id = request.args.get("employee_id", "EMP1001")

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
    auth_emp = get_authenticated_employee()
    if auth_emp:
        employee_id = auth_emp["employee_id"]
        emp_doc = auth_emp
    else:
        employee_id = data.get("employee_id", "EMP1001")
        emp_doc = employees_col.find_one({"employee_id": employee_id})

    latitude = data.get("latitude")
    longitude = data.get("longitude")
    accuracy = data.get("accuracy")

    if latitude is None or longitude is None:
        return jsonify({
            "status": "error",
            "message": "Accurate GPS coordinates are required to punch in. Please enable device location."
        }), 400

    try:
        lat_f = float(latitude)
        lon_f = float(longitude)
    except (ValueError, TypeError):
        return jsonify({
            "status": "error",
            "message": "Invalid GPS coordinates received."
        }), 400

    office = get_office_location()
    computed_dist = calculate_distance(lat_f, lon_f, office["latitude"], office["longitude"])
    distance = computed_dist

    # Live Production Geofence Check: Must be within designated office radius
    if computed_dist > office["radius"]:
        return jsonify({
            "status": "error",
            "message": "Punch-in failed: You are outside the designated office premises."
        }), 400

    acc_level = get_accuracy_level(accuracy)

    employee_name = emp_doc.get("name") if emp_doc else data.get("employee_name", "Staff Member")
    employee_role = emp_doc.get("role") if emp_doc else "Employee"
    monthly_salary = emp_doc.get("monthly_salary") if emp_doc else 0

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

    punch_in_maps_url = f"https://www.google.com/maps?q={lat_f},{lon_f}"

    punch_in_info = {
        "time": check_in_time,
        "iso": check_in_iso,
        "latitude": lat_f,
        "longitude": lon_f,
        "accuracy": accuracy,
        "accuracy_level": acc_level,
        "distance_meters": distance,
        "maps_url": punch_in_maps_url
    }

    new_doc = {
        "employee_id": employee_id,
        "employee_name": employee_name,
        "role": employee_role,
        "monthly_salary": monthly_salary,
        "date": today_str,
        "check_in_time": check_in_time,
        "check_in_iso": check_in_iso,
        "punch_in": punch_in_info,
        "check_out_time": None,
        "check_out_iso": None,
        "punch_out": None,
        "working_seconds": 0,
        "total_hours_formatted": "--",
        "status": "Present",
        "accuracy_level": acc_level,
        # Backward compatibility fields
        "latitude": lat_f,
        "longitude": lon_f,
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
    auth_emp = get_authenticated_employee()
    if auth_emp:
        employee_id = auth_emp["employee_id"]
    else:
        employee_id = data.get("employee_id", "EMP1001")

    latitude = data.get("latitude")
    longitude = data.get("longitude")
    accuracy = data.get("accuracy")
    distance = data.get("distance")

    office = get_office_location()
    lat_out = None
    lon_out = None
    if latitude is not None and longitude is not None:
        try:
            lat_out = float(latitude)
            lon_out = float(longitude)
            computed_dist = calculate_distance(lat_out, lon_out, office["latitude"], office["longitude"])
            if distance is None:
                distance = computed_dist
        except Exception:
            if distance is None:
                distance = 0
    elif distance is None:
        distance = 0

    acc_level_out = get_accuracy_level(accuracy)

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

    punch_out_maps_url = f"https://www.google.com/maps?q={lat_out},{lon_out}" if (lat_out is not None and lon_out is not None) else None

    punch_out_info = {
        "time": check_out_time,
        "iso": check_out_iso,
        "latitude": lat_out,
        "longitude": lon_out,
        "accuracy": accuracy,
        "accuracy_level": acc_level_out,
        "distance_meters": distance,
        "maps_url": punch_out_maps_url
    }

    attendance_col.update_one(
        {"_id": doc["_id"]},
        {"$set": {
            "check_out_time": check_out_time,
            "check_out_iso": check_out_iso,
            "punch_out": punch_out_info,
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
    auth_emp = get_authenticated_employee()
    if auth_emp:
        employee_id = auth_emp["employee_id"]
    else:
        employee_id = request.args.get("employee_id", "EMP1001")

    limit = int(request.args.get("limit", 20))

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

    # Total staff registered
    total_staff = employees_col.count_documents({})
    if total_staff == 0:
        total_staff = len(attendance_col.distinct("employee_id"))

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
        "total_employees": total_staff,
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
    emp_filter = request.args.get("employee_id", "").strip()

    now_ist = get_ist_now()
    today_str = format_ist_date(now_ist)

    query = {}

    if emp_filter and emp_filter != "all":
        query["employee_id"] = emp_filter

    if date_filter == "today":
        query["date"] = today_str
    elif date_filter != "all" and date_filter:
        query["date"] = date_filter

    if search:
        query["$or"] = [
            {"employee_id": {"$regex": search, "$options": "i"}},
            {"employee_name": {"$regex": search, "$options": "i"}},
            {"role": {"$regex": search, "$options": "i"}}
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
@admin_required
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

    punch_out_info = {
        "time": check_out_time,
        "iso": check_out_iso,
        "latitude": None,
        "longitude": None,
        "accuracy": None,
        "distance_meters": None,
        "note": "Admin forced checkout"
    }

    attendance_col.update_one(
        {"_id": obj_id},
        {"$set": {
            "check_out_time": check_out_time,
            "check_out_iso": check_out_iso,
            "punch_out": punch_out_info,
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
@admin_required
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
@admin_required
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

    # Headers with punch in and punch out locations & salary
    writer.writerow([
        "Record ID", "Employee ID", "Employee Name", "Role", "Monthly Salary (INR)", "Date (IST)",
        "Punch-In Time (IST)", "Punch-In Lat", "Punch-In Lon", "Punch-In Distance (m)",
        "Punch-Out Time (IST)", "Punch-Out Lat", "Punch-Out Lon", "Punch-Out Distance (m)",
        "Working Duration", "Status"
    ])

    for d in docs:
        r = serialize_record(d)
        p_in = r.get("punch_in") or {}
        p_out = r.get("punch_out") or {}

        in_lat = p_in.get("latitude") or r.get("latitude") or ""
        in_lon = p_in.get("longitude") or r.get("longitude") or ""
        in_dist = p_in.get("distance_meters") if p_in.get("distance_meters") is not None else r.get("distance_meters", "")

        out_lat = p_out.get("latitude") or ""
        out_lon = p_out.get("longitude") or ""
        out_dist = p_out.get("distance_meters") if p_out.get("distance_meters") is not None else ""

        writer.writerow([
            r["id"],
            r["employee_id"],
            r["employee_name"],
            r.get("role") or "",
            r.get("monthly_salary") or "",
            r["date"],
            r["check_in_time"],
            in_lat,
            in_lon,
            round(in_dist, 1) if in_dist != "" and in_dist is not None else "",
            r.get("check_out_time") or "Active",
            out_lat,
            out_lon,
            round(out_dist, 1) if out_dist != "" and out_dist is not None else "",
            r.get("total_hours_formatted") if r.get("total_hours_formatted") != "--" else "In Progress",
            r["status"]
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
