from __future__ import annotations

import json
import argparse
import sys
import shutil
import getpass
import hmac
import os
import secrets
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from functools import wraps
from pathlib import Path
from threading import Lock
from typing import Dict, List, Optional
from uuid import uuid4

from flask import Flask, jsonify, render_template, request, send_from_directory, session, g
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_FOLDER = BASE_DIR / "uploads"
UPLOAD_FOLDER.mkdir(exist_ok=True)
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "pdf"}
ALLOWED_MIME_TYPES = {
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
}
DATA_DIR = BASE_DIR / "data"
STORAGE_FILE = DATA_DIR / "storage.json"
MAX_FEEDBACK_LENGTH = 4000

app = Flask(__name__)

def resolve_secret_key() -> str:
  env_key = os.environ.get("SECRET_KEY") or os.environ.get("FLASK_SECRET_KEY")
  if env_key:
    return env_key

  DATA_DIR.mkdir(parents=True, exist_ok=True)
  secret_path = DATA_DIR / ".secret_key"
  if secret_path.exists():
    key = secret_path.read_text(encoding="utf-8").strip()
    if key:
      return key

  key = secrets.token_hex(32)
  try:
    secret_path.write_text(key, encoding="utf-8")
    secret_path.chmod(0o600)
  except OSError:
    app.logger.warning("Unable to persist generated SECRET_KEY; using in-memory key for this run.")
  return key


app.config["SECRET_KEY"] = resolve_secret_key()

app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
app.config.setdefault("SESSION_COOKIE_SAMESITE", os.environ.get("SESSION_COOKIE_SAMESITE", "Lax"))
secure_cookie_env = os.environ.get("SESSION_COOKIE_SECURE", "0").strip().lower()
app.config.setdefault("SESSION_COOKIE_SECURE", secure_cookie_env in {"1", "true", "yes"})

app.config["UPLOAD_FOLDER"] = str(UPLOAD_FOLDER)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 MB

CATEGORIES: tuple[str, ...] = ("water", "electric", "internet")
EXPENSE_FIELDS: tuple[str, ...] = (*CATEGORIES, "rent")
MAX_WORKSPACE_NAME_LENGTH = 120
SUPERADMIN_TENANT_ID = 0
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def generate_csrf_token() -> str:
  token = session.get("csrf_token")
  if not token:
    token = secrets.token_hex(32)
    session["csrf_token"] = token
  return token


def validate_csrf_token() -> bool:
  if request.method in SAFE_METHODS:
    return True
  expected = session.get("csrf_token")
  provided = request.headers.get("X-CSRF-Token")
  if not expected or not provided:
    return False
  try:
    return hmac.compare_digest(expected, provided)
  except TypeError:
    return False


@dataclass
class User:
  id: int
  name: str
  various_credit: float = 0.0
  mineral_credit: float = 0.0


@dataclass
class OutRecord:
  id: int
  user_id: int
  start: date
  end: date


@dataclass
class FixedCharge:
  id: int
  name: str
  category: str
  amount: float


@dataclass
class Receipt:
  id: int
  user_id: int
  filename: str
  original_name: str
  uploaded_at: datetime


@dataclass
class Feedback:
  id: int
  account_id: int
  tenant_id: Optional[int]
  role: str
  username: str
  message: str
  contact: Optional[str]
  context: Optional[str]
  workspace_name: Optional[str]
  created_at: datetime


@dataclass
class Account:
  id: int
  username: str
  password_hash: str
  role: str  # "admin", "renter", or "superadmin"
  tenant_id: int
  last_active_at: Optional[datetime] = None
  resident_user_id: Optional[int] = None


storage_lock = Lock()
accounts: Dict[int, Account] = {}
tenants: Dict[int, Dict[str, object]] = {}
next_account_id = 1
next_tenant_id = 1
feedback_entries: List[Feedback] = []
next_feedback_id = 1


def generate_invite_token() -> str:
  return uuid4().hex


def make_default_tenant_state() -> Dict[str, object]:
  return {
    "users": [],
    "outs": [],
    "fixed": [],
    "receipts": [],
    "next_id": 1,
    "next_out_id": 1,
    "next_fixed_id": 1,
    "next_receipt_id": 1,
    "billing_period": None,
    "expenses": {
      "water": 120.0,
      "electric": 180.0,
      "internet": 90.0,
      "rent": 0.0,
    },
  }


def get_tenant_upload_folder(tenant_id: int) -> Path:
  folder = UPLOAD_FOLDER / f"tenant_{tenant_id}"
  folder.mkdir(parents=True, exist_ok=True)
  return folder


def get_account() -> Optional[Account]:
  account_id = session.get("account_id")
  if account_id is None:
    return None
  return accounts.get(account_id)


def get_state() -> Dict[str, object]:
  tenant = getattr(g, "tenant", None)
  if not tenant:
    raise RuntimeError("Tenant context missing.")
  return tenant["state"]


def require_auth(role: Optional[str] = None):
  def decorator(function):
    @wraps(function)
    def wrapper(*args, **kwargs):
      account_id = session.get("account_id")
      account = accounts.get(account_id) if account_id is not None else None
      if account is None:
        session.pop("account_id", None)
        return jsonify({"message": "Authentication required."}), 401

      g.account = account

      if role and account.role != role:
        message = "Admin privileges required." if role == "admin" else "Super admin privileges required."
        return jsonify({"message": message}), 403

      tenant = None
      if account.role != "superadmin":
        tenant = tenants.get(account.tenant_id)
        if tenant is None:
          return jsonify({"message": "Tenant not found."}), 404

      g.tenant = tenant

      if not validate_csrf_token():
        return jsonify({"message": "Invalid or missing CSRF token."}), 403

      now = datetime.utcnow()
      last_seen = account.last_active_at
      account.last_active_at = now
      should_persist = last_seen is None or (now - last_seen) >= timedelta(minutes=1)
      if should_persist and getattr(function, "__name__", "") != "persist_state":
        persist_state()

      return function(*args, **kwargs)

    return wrapper

  return decorator


def normalise_workspace_name(name: Optional[str], tenant_id: int) -> str:
  resolved = (name or "").strip()
  if not resolved:
    return f"Dorm #{tenant_id}"
  if len(resolved) > MAX_WORKSPACE_NAME_LENGTH:
    resolved = resolved[:MAX_WORKSPACE_NAME_LENGTH].strip()
  return resolved


def create_tenant(name: Optional[str] = None) -> Dict[str, object]:
  global next_tenant_id
  tenant_id = next_tenant_id
  resolved_name = normalise_workspace_name(name, tenant_id)
  lookup = normalise_workspace_key(resolved_name)
  if lookup and get_tenant_by_name(resolved_name):
    raise ValueError("Dorm name already in use.")
  next_tenant_id += 1
  tenant_state = make_default_tenant_state()
  tenant_record = {
    "id": tenant_id,
    "state": tenant_state,
    "invite_token": generate_invite_token(),
    "name": resolved_name,
  }
  tenants[tenant_id] = tenant_record
  get_tenant_upload_folder(tenant_id)
  persist_state()
  return tenant_record


def create_account(
  username: str,
  password: str,
  role: str,
  tenant_id: int,
  resident_user_id: Optional[int] = None,
  *,
  persist_change: bool = True,
) -> Account:
  global next_account_id
  account_id = next_account_id
  next_account_id += 1
  now = datetime.utcnow()
  account = Account(
    id=account_id,
    username=username,
    password_hash=generate_password_hash(password, method="pbkdf2:sha256"),
    role=role,
    tenant_id=tenant_id,
    last_active_at=now,
    resident_user_id=resident_user_id,
  )
  accounts[account_id] = account
  if persist_change:
    persist_state()
  return account


def rotate_invite_token(tenant: Dict[str, object]) -> str:
  token = generate_invite_token()
  tenant["invite_token"] = token
  persist_state()
  return token


def get_account_by_username(
  username: str, tenant_id: Optional[int] = None, role: Optional[str] = None
) -> Optional[Account]:
  lowered = username.strip().lower()
  for account in accounts.values():
    if account.username.lower() != lowered:
      continue
    if tenant_id is not None and account.tenant_id != tenant_id:
      continue
    if role and account.role != role:
      continue
    return account
  return None


def get_tenant_by_token(token: str) -> Optional[Dict[str, object]]:
  if not token:
    return None
  for tenant in tenants.values():
    if tenant.get("invite_token") == token:
      return tenant
  return None


def normalise_workspace_key(name: Optional[str]) -> str:
  if not name:
    return ""
  resolved = name.strip()
  if not resolved:
    return ""
  if len(resolved) > MAX_WORKSPACE_NAME_LENGTH:
    resolved = resolved[:MAX_WORKSPACE_NAME_LENGTH].strip()
  return resolved.lower()


def get_tenant_by_name(name: Optional[str]) -> Optional[Dict[str, object]]:
  lookup = normalise_workspace_key(name)
  if not lookup:
    return None
  for tenant in tenants.values():
    existing = normalise_workspace_key(tenant.get("name"))
    if existing == lookup:
      return tenant
  return None


def account_payload(account: Account) -> Dict[str, object]:
  data = {
    "id": account.id,
    "username": account.username,
    "role": account.role,
    "tenant_id": account.tenant_id,
    "last_active_at": account.last_active_at.isoformat() if account.last_active_at else None,
    "resident_user_id": account.resident_user_id,
  }
  return data


def calculate_default_period(today: Optional[date] = None) -> tuple[date, date]:
  today = today or date.today()
  if today.day >= 15:
    start = date(today.year, today.month, 15)
    next_year = today.year + (1 if today.month == 12 else 0)
    next_month = 1 if today.month == 12 else today.month + 1
    end = date(next_year, next_month, 14)
  else:
    prev_year = today.year - (1 if today.month == 1 else 0)
    prev_month = 12 if today.month == 1 else today.month - 1
    start = date(prev_year, prev_month, 15)
    end = date(today.year, today.month, 14)
  return start, end

def get_billing_period() -> tuple[date, date]:
  tenant_state = get_state()
  override = tenant_state.get("billing_period")
  if override and override.get("start") and override.get("end"):
    try:
      start = datetime.strptime(override["start"], "%Y-%m-%d").date()
      end = datetime.strptime(override["end"], "%Y-%m-%d").date()
      return start, end
    except ValueError:
      pass
  return calculate_default_period()


def calculate_category_totals(expenses: Dict[str, float]) -> Dict[str, float]:
  return {category: expenses.get(category, 0.0) for category in CATEGORIES}


def calculate_totals(expenses: Dict[str, float]) -> Dict[str, float]:
  category_totals = calculate_category_totals(expenses)
  totals = {**category_totals}
  rent_total = expenses.get("rent", 0.0)
  totals["rent"] = rent_total
  totals["grand"] = sum(category_totals.values()) + rent_total
  return totals


def calculate_days_out(record: OutRecord, period_start: date, period_end: date) -> int:
  if record.end < record.start:
    return 0
  if record.end < period_start or record.start > period_end:
    return 0

  overlap_start = max(record.start, period_start)
  overlap_end = min(record.end, period_end)
  return (overlap_end - overlap_start).days + 1


def calculate_user_share(
  category_totals: Dict[str, float],
  fixed_totals: Dict[str, float],
  days_present: int,
  total_days: int,
  user_count: int,
) -> tuple[Dict[str, float], Dict[str, Dict[str, float]]]:
  share: Dict[str, float] = {}
  detail: Dict[str, Dict[str, float]] = {}

  for category in CATEGORIES:
    fixed_total = max(fixed_totals.get(category, 0.0), 0.0)
    fixed_share = fixed_total / user_count if user_count > 0 else 0.0

    category_total = max(category_totals.get(category, 0.0), 0.0)
    variable_pool = max(category_total - fixed_total, 0.0)
    per_day_rate = variable_pool / total_days if total_days > 0 else 0.0
    variable_share = 0.0
    if total_days > 0 and days_present > 0:
      variable_share = per_day_rate * days_present

    amount = fixed_share + variable_share
    share[category] = amount
    detail[category] = {
      "amount": amount,
      "fixed_total": fixed_total,
      "fixed_portion": fixed_share,
      "variable_pool": variable_pool,
      "variable_portion": variable_share,
      "per_day_rate": per_day_rate,
      "total_days": total_days,
      "days_charged": days_present,
      "resident_count": user_count,
      "category_total": category_total,
    }

  share["total"] = sum(share[category] for category in CATEGORIES)
  detail["utilities_total"] = {"amount": share["total"]}
  return share, detail


def iter_out_days(records: List[OutRecord], period_start: date, period_end: date):
  for record in records:
    if record.end < record.start:
      continue
    if record.end < period_start or record.start > period_end:
      continue
    overlap_start = max(record.start, period_start)
    overlap_end = min(record.end, period_end)
    current = overlap_start
    while current <= overlap_end:
      yield current
      current += timedelta(days=1)


def serialise_out(record: OutRecord, period_start: date, period_end: date) -> Dict[str, object]:
  return {
    "id": record.id,
    "user_id": record.user_id,
    "start": record.start.isoformat(),
    "end": record.end.isoformat(),
    "days": calculate_days_out(record, period_start, period_end),
  }


def serialise_receipt(receipt: Receipt) -> Dict[str, object]:
  return {
    "id": receipt.id,
    "user_id": receipt.user_id,
    "original_name": receipt.original_name,
    "uploaded_at": receipt.uploaded_at.isoformat(),
    "url": f"/uploads/{receipt.filename}",
  }


def serialise_fixed(charge: FixedCharge) -> Dict[str, object]:
  return {
    "id": charge.id,
    "name": charge.name,
    "category": charge.category,
    "amount": charge.amount,
  }


def serialise_account_summary(account: Account) -> Dict[str, object]:
  return {
    "id": account.id,
    "username": account.username,
    "role": account.role,
    "tenant_id": account.tenant_id,
    "last_active_at": account.last_active_at.isoformat() if account.last_active_at else None,
    "resident_user_id": account.resident_user_id,
  }


def iter_accounts_by_role(role: str) -> List[Account]:
  return [account for account in accounts.values() if account.role == role]


def tenant_overview(tenant: Dict[str, object]) -> Dict[str, object]:
  tenant_id = tenant["id"]
  tenant_name = tenant.get("name") or f"Dorm #{tenant_id}"
  admins = [
    serialise_account_summary(account)
    for account in accounts.values()
    if account.role == "admin" and account.tenant_id == tenant_id
  ]
  resident_accounts = [
    serialise_account_summary(account)
    for account in accounts.values()
    if account.role == "renter" and account.tenant_id == tenant_id
  ]
  last_active_dt = None
  for account in accounts.values():
    if account.tenant_id == tenant_id and account.last_active_at:
      if last_active_dt is None or account.last_active_at > last_active_dt:
        last_active_dt = account.last_active_at

  return {
    "id": tenant_id,
    "name": tenant_name,
    "resident_count": len(resident_accounts),
    "residents": resident_accounts,
    "admins": admins,
    "admin_count": len(admins),
    "last_active_at": last_active_dt.isoformat() if last_active_dt else None,
  }


def current_state() -> Dict[str, object]:
  tenant = g.tenant
  tenant_state = get_state()
  users: List[User] = tenant_state["users"]
  outs: List[OutRecord] = tenant_state["outs"]
  fixed: List[FixedCharge] = tenant_state["fixed"]
  receipts: List[Receipt] = tenant_state["receipts"]
  expenses = tenant_state["expenses"]
  period_start, period_end = get_billing_period()
  category_totals = calculate_category_totals(expenses)

  total_days_present = 0
  total_period_days = (period_end - period_start).days + 1
  user_data: Dict[int, Dict[str, object]] = {}
  fixed_totals = {category: 0.0 for category in CATEGORIES}
  rent_total = expenses.get("rent", 0.0)

  for charge in fixed:
    if charge.category in fixed_totals:
      fixed_totals[charge.category] += max(charge.amount, 0.0)

  for user in users:
    user_outs = [record for record in outs if record.user_id == user.id]
    out_days = len(set(iter_out_days(user_outs, period_start, period_end)))
    days_present = max(total_period_days - out_days, 0)
    user_data[user.id] = {"outs": user_outs, "days_present": days_present, "days_out": out_days}
    total_days_present += days_present

  user_entries = []
  for user in users:
    data = user_data[user.id]
    user_receipts = [receipt for receipt in receipts if receipt.user_id == user.id]
    share, share_detail = calculate_user_share(
      category_totals,
      fixed_totals,
      data["days_present"],
      total_days_present,
      len(users),
    )
    general_credit = max(user.various_credit, 0.0)
    mineral_credit = max(user.mineral_credit, 0.0)
    rent_share = rent_total / len(users) if users else 0.0
    rent_detail = {
      "total_rent": rent_total,
      "resident_count": len(users),
      "share": rent_share,
    }
    gross_total = share["total"] + rent_share
    net_total = gross_total - general_credit - mineral_credit
    user_entries.append(
      {
        "id": user.id,
        "name": user.name,
        "days_present": data["days_present"],
        "days_out": data["days_out"],
        "share": share,
        "share_detail": share_detail,
        "rent_share": rent_share,
        "rent_detail": rent_detail,
        "gross_total": gross_total,
        "abono_credit": general_credit,
        "mineral_credit": mineral_credit,
        "various_credit": general_credit,
        "net_total": net_total,
        "out_records": [
          serialise_out(record, period_start, period_end)
          for record in data["outs"]
        ],
        "receipts": [serialise_receipt(receipt) for receipt in user_receipts],
      }
    )

  totals = calculate_totals(expenses)
  abono_total = sum(max(user.various_credit, 0.0) for user in users)
  mineral_abono_total = sum(max(user.mineral_credit, 0.0) for user in users)
  totals["abono_general"] = abono_total
  totals["abono_mineral"] = mineral_abono_total
  totals["abono"] = abono_total + mineral_abono_total
  totals["grand"] = totals["grand"] - abono_total - mineral_abono_total

  return {
    "users": user_entries,
    "expenses": expenses,
    "totals": totals,
    "fixed": [serialise_fixed(charge) for charge in fixed],
    "period": {
      "start": period_start.isoformat(),
      "end": period_end.isoformat(),
      "total_days": (period_end - period_start).days + 1,
      "total_occupancy_days": total_days_present,
    },
    "meta": {
      "total_residents": len(users),
      "fixed_totals": fixed_totals,
    },
    "workspace": {
      "name": tenant.get("name") or f"Dorm #{tenant['id']}",
    },
  }


def find_user(user_id: int) -> Optional[User]:
  tenant_state = get_state()
  for user in tenant_state["users"]:
    if user.id == user_id:
      return user
  return None


def find_out(record_id: int) -> Optional[OutRecord]:
  tenant_state = get_state()
  for record in tenant_state["outs"]:
    if record.id == record_id:
      return record
  return None


def find_fixed(fixed_id: int) -> Optional[FixedCharge]:
  tenant_state = get_state()
  for charge in tenant_state["fixed"]:
    if charge.id == fixed_id:
      return charge
  return None


def find_receipt(receipt_id: int) -> Optional[Receipt]:
  tenant_state = get_state()
  for receipt in tenant_state["receipts"]:
    if receipt.id == receipt_id:
      return receipt
  return None


def resolve_account_resident(account: Account, tenant_state: Dict[str, object]) -> Optional[User]:
  users: List[User] = tenant_state["users"]
  if account.resident_user_id is not None:
    for user in users:
      if user.id == account.resident_user_id:
        return user

  username = account.username.strip().lower()
  if not username:
    return None

  for user in users:
    if user.name.strip().lower() == username:
      account.resident_user_id = user.id
      persist_state()
      return user
  return None


def account_can_manage_user(account: Account, tenant_state: Dict[str, object], user_id: int) -> bool:
  if account.role == "admin":
    return True
  if account.role != "renter":
    return False
  resident = resolve_account_resident(account, tenant_state)
  if resident is None:
    return False
  return resident.id == user_id


def parse_date_field(value: Optional[str]) -> Optional[date]:
  if value in (None, "", "null"):
    return None
  try:
    return datetime.strptime(value, "%Y-%m-%d").date()
  except ValueError as exc:
    raise ValueError("invalid-date") from exc


def validate_out_bounds(
  start: Optional[date],
  end: Optional[date],
  period_start: date,
  period_end: date,
) -> Optional[str]:
  if start is None or end is None:
    return "Start and end dates are required."
  if start > end:
    return "Start date cannot be after end date."
  if start < period_start or start > period_end:
    return "Start date must fall within the billing period."
  if end < period_start or end > period_end:
    return "End date must fall within the billing period."
  return None


def allowed_file(filename: str) -> bool:
  return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def set_billing_period_override(start: Optional[date], end: Optional[date]) -> None:
  tenant_state = get_state()
  if start and end:
    tenant_state["billing_period"] = {"start": start.isoformat(), "end": end.isoformat()}
  else:
    tenant_state["billing_period"] = None
  persist_state()


def serialise_period(period: tuple[date, date]) -> Dict[str, str]:
  start, end = period
  return {"start": start.isoformat(), "end": end.isoformat()}


@app.get("/api/auth/session")
def api_auth_session():
  account = get_account()
  if not account:
    return jsonify({"authenticated": False})

  tenant = tenants.get(account.tenant_id)
  response: Dict[str, object] = {
    "authenticated": True,
    "account": account_payload(account),
  }
  response["csrf_token"] = generate_csrf_token()
  if tenant:
    response["workspace"] = {"name": tenant.get("name") or f"Dorm #{tenant['id']}"}
    if account.role == "admin":
      response["invite_token"] = tenant.get("invite_token")
  return jsonify(response)


@app.post("/api/auth/logout")
@require_auth()
def api_auth_logout():
  session.clear()
  return ("", 204)


@app.post("/api/auth/login")
def api_auth_login():
  payload = request.get_json(silent=True) or {}
  username = (payload.get("username") or "").strip()
  password = payload.get("password") or ""
  dorm_name = (payload.get("dorm_name") or "").strip()

  if not username or not password:
    return jsonify({"message": "Username and password are required."}), 400

  account: Optional[Account] = None
  tenant: Optional[Dict[str, object]] = None

  if not dorm_name:
    account = get_account_by_username(username, role="superadmin")
    if account is None:
      return jsonify({"message": "Dorm name is required."}), 400
    if not check_password_hash(account.password_hash, password):
      return jsonify({"message": "Invalid credentials."}), 401
  else:
    tenant = get_tenant_by_name(dorm_name)
    if tenant is None:
      return jsonify({"message": "Invalid credentials."}), 401
    account = get_account_by_username(username, tenant_id=tenant["id"])
    if account is None or not check_password_hash(account.password_hash, password):
      return jsonify({"message": "Invalid credentials."}), 401

  if account.role != "superadmin":
    if tenant is None:
      tenant = tenants.get(account.tenant_id)
    if tenant is None:
      return jsonify({"message": "Tenant not found."}), 404
  else:
    tenant = tenants.get(account.tenant_id)

  session["account_id"] = account.id
  account.last_active_at = datetime.utcnow()
  persist_state()
  response: Dict[str, object] = {"account": account_payload(account)}
  if account.role == "admin" and tenant:
    response["invite_token"] = tenant.get("invite_token")
  response["csrf_token"] = generate_csrf_token()
  return jsonify(response)


@app.post("/api/auth/register")
def api_auth_register():
  payload = request.get_json(silent=True) or {}
  username = (payload.get("username") or "").strip()
  password = payload.get("password") or ""
  dorm_name = (payload.get("dorm_name") or "").strip()

  if not username or not password or not dorm_name:
    return jsonify({"message": "Username, password, and dorm name are required."}), 400

  if len(dorm_name) > MAX_WORKSPACE_NAME_LENGTH:
    return jsonify({"message": "Dorm name is too long."}), 400

  if get_tenant_by_name(dorm_name):
    return jsonify({"message": "Dorm name already in use."}), 409

  try:
    tenant = create_tenant(dorm_name)
  except ValueError:
    return jsonify({"message": "Dorm name already in use."}), 409
  account = create_account(username, password, "admin", tenant["id"])
  session["account_id"] = account.id
  response: Dict[str, object] = {
    "account": account_payload(account),
    "invite_token": tenant.get("invite_token"),
    "workspace": {"name": tenant.get("name")},
  }
  response["csrf_token"] = generate_csrf_token()
  return jsonify(response), 201


@app.post("/api/auth/renter-register")
def api_auth_renter_register():
  payload = request.get_json(silent=True) or {}
  token = (payload.get("token") or "").strip()
  username = (payload.get("username") or "").strip()
  password = payload.get("password") or ""

  if not token or not username or not password:
    return jsonify({"message": "Invite token, username, and password are required."}), 400

  tenant = get_tenant_by_token(token)
  if tenant is None:
    return jsonify({"message": "Invalid invite token."}), 400

  if get_account_by_username(username, tenant_id=tenant["id"]):
    return jsonify({"message": "Username already taken."}), 409

  tenant_state = tenant["state"]
  new_user_id = tenant_state["next_id"]
  account = create_account(
    username,
    password,
    "renter",
    tenant["id"],
    resident_user_id=new_user_id,
    persist_change=False,
  )
  new_user = User(id=new_user_id, name=username)
  tenant_state["next_id"] += 1
  tenant_state["users"].append(new_user)
  persist_state()
  session["account_id"] = account.id
  return jsonify({"account": account_payload(account), "csrf_token": generate_csrf_token()}), 201


@app.get("/api/auth/invite")
@require_auth("admin")
def api_auth_invite():
  tenant = g.tenant
  return jsonify({"invite_token": tenant.get("invite_token")})


@app.post("/api/auth/invite/rotate")
@require_auth("admin")
def api_auth_invite_rotate():
  tenant = g.tenant
  token = rotate_invite_token(tenant)
  return jsonify({"invite_token": token})


def build_superadmin_state() -> Dict[str, object]:
  tenant_entries = [tenant_overview(tenant) for tenant in tenants.values()]
  tenant_entries.sort(key=lambda entry: entry["name"].lower())
  admin_accounts = [serialise_account_summary(account) for account in iter_accounts_by_role("admin")]
  resident_accounts = [serialise_account_summary(account) for account in iter_accounts_by_role("renter")]
  feedback_items = [serialise_feedback_entry(entry) for entry in feedback_entries]
  feedback_items.sort(key=lambda entry: entry.get("created_at", ""), reverse=True)
  stats = {
    "tenant_count": len(tenant_entries),
    "admin_count": len(admin_accounts),
    "resident_count": len(resident_accounts),
    "feedback_count": len(feedback_items),
  }
  return {
    "tenants": tenant_entries,
    "admins": admin_accounts,
    "residents": resident_accounts,
    "stats": stats,
    "feedbacks": feedback_items,
  }


def delete_accounts_by(predicate) -> int:
  removed = []
  for account_id, account in list(accounts.items()):
    if predicate(account):
      removed.append(account_id)
      accounts.pop(account_id, None)
  return len(removed)


def purge_tenant(tenant_id: int) -> bool:
  tenant = tenants.pop(tenant_id, None)
  if tenant is None:
    return False
  delete_accounts_by(lambda acct: acct.tenant_id == tenant_id)
  tenant_folder = UPLOAD_FOLDER / f"tenant_{tenant_id}"
  shutil.rmtree(tenant_folder, ignore_errors=True)
  global feedback_entries
  feedback_entries = [entry for entry in feedback_entries if entry.tenant_id != tenant_id]
  persist_state()
  return True


@app.get("/api/super/state")
@require_auth("superadmin")
def api_super_state():
  return jsonify(build_superadmin_state())


@app.delete("/api/super/tenants/<int:tenant_id>")
@require_auth("superadmin")
def api_super_tenant_delete(tenant_id: int):
  if tenant_id == SUPERADMIN_TENANT_ID:
    return jsonify({"message": "Invalid tenant id."}), 400
  if not purge_tenant(tenant_id):
    return jsonify({"message": "Tenant not found."}), 404
  return ("", 204)


@app.delete("/api/super/admins/<int:account_id>")
@require_auth("superadmin")
def api_super_admin_delete(account_id: int):
  account = accounts.get(account_id)
  if account is None or account.role != "admin":
    return jsonify({"message": "Admin not found."}), 404
  accounts.pop(account_id, None)
  persist_state()
  return ("", 204)


@app.delete("/api/super/renters/<int:account_id>")
@require_auth("superadmin")
def api_super_renter_delete(account_id: int):
  account = accounts.get(account_id)
  if account is None or account.role != "renter":
    return jsonify({"message": "Renter not found."}), 404
  accounts.pop(account_id, None)
  persist_state()
  return ("", 204)


@app.post("/api/feedback")
@require_auth()
def api_feedback_submit():
  payload = request.get_json(silent=True) or {}
  message = str(payload.get("message") or "").strip()
  if not message:
    return jsonify({"message": "Feedback message is required."}), 400
  if len(message) > MAX_FEEDBACK_LENGTH:
    return jsonify({"message": "Feedback message is too long."}), 400

  contact_raw = payload.get("contact")
  contact = str(contact_raw).strip() if isinstance(contact_raw, str) else None
  if contact and len(contact) > 200:
    contact = contact[:200]

  context_raw = payload.get("context")
  context = str(context_raw).strip() if isinstance(context_raw, str) else None
  if context and len(context) > 200:
    context = context[:200]

  account = g.account
  tenant = g.tenant
  tenant_id = tenant.get("id") if tenant else None
  workspace_name = None
  if tenant_id is not None:
    workspace_name = tenant.get("name") or f"Dorm #{tenant_id}"
  else:
    workspace_name = payload.get("workspace_name")
    if isinstance(workspace_name, str):
      workspace_name = workspace_name.strip() or None
    if not workspace_name:
      workspace_name = "Super Admin"

  global next_feedback_id
  entry = Feedback(
    id=next_feedback_id,
    account_id=account.id,
    tenant_id=tenant_id,
    role=account.role,
    username=account.username,
    message=message,
    contact=contact,
    context=context,
    workspace_name=workspace_name,
    created_at=datetime.utcnow(),
  )
  next_feedback_id += 1
  feedback_entries.append(entry)
  persist_state()
  return jsonify({"feedback": serialise_feedback_entry(entry)}), 201


@app.patch("/api/workspace")
@require_auth("admin")
def api_workspace_update():
  payload = request.get_json(silent=True) or {}
  name = (payload.get("name") or "").strip()
  if not name:
    return jsonify({"message": "Dorm name is required."}), 400
  if len(name) > MAX_WORKSPACE_NAME_LENGTH:
    return jsonify({"message": "Dorm name is too long."}), 400
  tenant = g.tenant
  resolved_name = normalise_workspace_name(name, tenant["id"])
  existing = get_tenant_by_name(resolved_name)
  if existing and existing.get("id") != tenant["id"]:
    return jsonify({"message": "Dorm name already in use."}), 409
  tenant["name"] = resolved_name
  persist_state()
  return jsonify({"workspace": {"name": tenant["name"]}})


@app.get("/")
def index():
  return render_template("index.html")


@app.get("/uploads/<path:filename>")
@require_auth()
def uploaded_file(filename: str):
  tenant_id = g.account.tenant_id
  allowed_prefix = f"tenant_{tenant_id}/"
  if not filename.startswith(allowed_prefix):
    return jsonify({"message": "File not found."}), 404
  return send_from_directory(app.config["UPLOAD_FOLDER"], filename)


@app.get("/api/state")
@require_auth()
def api_state():
  return jsonify(current_state())


@app.post("/api/users")
@require_auth("admin")
def api_users_create():
  payload = request.get_json(silent=True) or {}
  name = (payload.get("name") or "").strip()

  if not name:
    return jsonify({"message": "Name is required."}), 400

  tenant_state = get_state()
  new_user = User(id=tenant_state["next_id"], name=name)
  tenant_state["next_id"] += 1
  tenant_state["users"].append(new_user)
  persist_state()

  return jsonify(current_state()), 201


@app.patch("/api/users/<int:user_id>")
@require_auth()
def api_users_update(user_id: int):
  payload = request.get_json(silent=True) or {}
  user = find_user(user_id)
  if user is None:
    return jsonify({"message": "User not found."}), 404

  account = g.account
  tenant_state = get_state()
  if not account_can_manage_user(account, tenant_state, user.id):
    return jsonify({"message": "You can only modify your own records."}), 403

  is_admin = account.role == "admin"

  if "name" in payload:
    if not is_admin:
      return jsonify({"message": "Admin privileges required to rename users."}), 403
    new_name = (payload.get("name") or "").strip()
    if not new_name:
      return jsonify({"message": "Name is required."}), 400
    user.name = new_name

  if "various_credit" in payload:
    try:
      credit_value = float(payload.get("various_credit"))
    except (TypeError, ValueError):
      return jsonify({"message": "Various credit must be a number."}), 400
    if credit_value < 0:
      return jsonify({"message": "Various credit cannot be negative."}), 400
    user.various_credit = credit_value

  if "mineral_credit" in payload:
    try:
      mineral_value = float(payload.get("mineral_credit"))
    except (TypeError, ValueError):
      return jsonify({"message": "Mineral credit must be a number."}), 400
    if mineral_value < 0:
      return jsonify({"message": "Mineral credit cannot be negative."}), 400
    user.mineral_credit = mineral_value

  persist_state()
  return jsonify(current_state())


@app.delete("/api/users/<int:user_id>")
@require_auth("admin")
def api_users_delete(user_id: int):
  tenant_state = get_state()
  users: List[User] = tenant_state["users"]
  for index, user in enumerate(users):
    if user.id == user_id:
      users.pop(index)
      tenant_state["outs"] = [record for record in tenant_state["outs"] if record.user_id != user_id]
      removed_receipts = [receipt for receipt in tenant_state["receipts"] if receipt.user_id == user_id]
      tenant_state["receipts"] = [
        receipt for receipt in tenant_state["receipts"] if receipt.user_id != user_id
      ]
      tenant_folder = get_tenant_upload_folder(g.account.tenant_id)
      for receipt in removed_receipts:
        try:
          (tenant_folder / Path(receipt.filename).name).unlink(missing_ok=True)
        except OSError:
          pass
      tenant_id = g.tenant["id"] if g.tenant else g.account.tenant_id
      for account in accounts.values():
        if account.tenant_id == tenant_id and account.resident_user_id == user_id:
          account.resident_user_id = None
      persist_state()
      return ("", 204)

  return jsonify({"message": "User not found."}), 404


@app.post("/api/users/<int:user_id>/receipts")
@require_auth()
def api_receipts_create(user_id: int):
  user = find_user(user_id)
  if user is None:
    return jsonify({"message": "User not found."}), 404

  if "file" not in request.files:
    return jsonify({"message": "No file provided."}), 400

  file = request.files["file"]

  if file.filename == "":
    return jsonify({"message": "No selected file."}), 400

  if not allowed_file(file.filename):
    return jsonify({"message": "File type not allowed."}), 400

  if file.mimetype not in ALLOWED_MIME_TYPES:
    return jsonify({"message": "File type not allowed."}), 400

  tenant_state = get_state()
  account = g.account
  if not account_can_manage_user(account, tenant_state, user.id):
    return jsonify({"message": "You can only manage your own records."}), 403
  tenant_id = g.account.tenant_id
  tenant_folder = get_tenant_upload_folder(tenant_id)

  original_name = file.filename
  extension = original_name.rsplit(".", 1)[1].lower()
  receipt_id = tenant_state["next_receipt_id"]
  filename = secure_filename(f"receipt_{tenant_id}_{user_id}_{receipt_id}.{extension}")
  filepath = tenant_folder / filename
  file.save(filepath)
  relative_path = f"tenant_{tenant_id}/{filename}"

  receipt = Receipt(
    id=receipt_id,
    user_id=user_id,
    filename=relative_path,
    original_name=original_name,
    uploaded_at=datetime.utcnow(),
  )

  tenant_state["receipts"].append(receipt)
  tenant_state["next_receipt_id"] += 1
  persist_state()

  return jsonify(serialise_receipt(receipt)), 201


@app.delete("/api/users/<int:user_id>/receipts/<int:receipt_id>")
@require_auth()
def api_receipts_delete(user_id: int, receipt_id: int):
  user = find_user(user_id)
  if user is None:
    return jsonify({"message": "User not found."}), 404

  receipt = find_receipt(receipt_id)
  if receipt is None or receipt.user_id != user_id:
    return jsonify({"message": "Receipt not found."}), 404

  tenant_state = get_state()
  account = g.account
  if not account_can_manage_user(account, tenant_state, user.id):
    return jsonify({"message": "You can only manage your own records."}), 403

  try:
    (Path(app.config["UPLOAD_FOLDER"]) / receipt.filename).unlink(missing_ok=True)
  except OSError:
    pass

  tenant_state["receipts"] = [entry for entry in tenant_state["receipts"] if entry.id != receipt_id]
  persist_state()

  return ("", 204)


@app.patch("/api/billing-period")
@require_auth("admin")
def api_billing_period_update():
  payload = request.get_json(silent=True) or {}

  if payload.get("use_current"):
    start, end = calculate_default_period()
    set_billing_period_override(start, end)
    return jsonify({"period": serialise_period((start, end))})

  start = parse_date_field(payload.get("start"))
  end = parse_date_field(payload.get("end"))

  if not start or not end:
    return jsonify({"message": "Start and end dates are required."}), 400
  if start > end:
    return jsonify({"message": "Start date cannot be after end date."}), 400

  set_billing_period_override(start, end)
  return jsonify({"period": serialise_period((start, end))})


@app.post("/api/outs")
@require_auth()
def api_outs_create():
  payload = request.get_json(silent=True) or {}
  user_id = payload.get("user_id")
  if not isinstance(user_id, int):
    return jsonify({"message": "A valid user_id is required."}), 400

  tenant_state = get_state()
  users: List[User] = tenant_state["users"]
  user = next((entry for entry in users if entry.id == user_id), None)
  if user is None:
    return jsonify({"message": "User not found."}), 404

  account = g.account
  if not account_can_manage_user(account, tenant_state, user.id):
    return jsonify({"message": "You can only manage your own records."}), 403

  try:
    start = parse_date_field(payload.get("start"))
    end = parse_date_field(payload.get("end"))
  except ValueError:
    return jsonify({"message": "Invalid date format. Use YYYY-MM-DD."}), 400

  period_start, period_end = get_billing_period()
  error_message = validate_out_bounds(start, end, period_start, period_end)
  if error_message:
    return jsonify({"message": error_message}), 400

  new_record = OutRecord(
    id=tenant_state["next_out_id"],
    user_id=user.id,
    start=start,
    end=end,
  )
  tenant_state["next_out_id"] += 1
  tenant_state["outs"].append(new_record)
  persist_state()

  return jsonify(current_state()), 201


@app.patch("/api/outs/<int:out_id>")
@require_auth()
def api_outs_update(out_id: int):
  payload = request.get_json(silent=True) or {}
  record = find_out(out_id)
  if record is None:
    return jsonify({"message": "Out record not found."}), 404

  tenant_state = get_state()
  account = g.account
  if not account_can_manage_user(account, tenant_state, record.user_id):
    return jsonify({"message": "You can only manage your own records."}), 403

  period_start, period_end = get_billing_period()

  start = record.start
  end = record.end

  try:
    if "start" in payload:
      parsed_start = parse_date_field(payload.get("start"))
      if parsed_start is None:
        return jsonify({"message": "Start date is required."}), 400
      start = parsed_start

    if "end" in payload:
      parsed_end = parse_date_field(payload.get("end"))
      if parsed_end is None:
        return jsonify({"message": "End date is required."}), 400
      end = parsed_end
  except ValueError:
    return jsonify({"message": "Invalid date format. Use YYYY-MM-DD."}), 400

  error_message = validate_out_bounds(start, end, period_start, period_end)
  if error_message:
    return jsonify({"message": error_message}), 400

  record.start = start
  record.end = end
  persist_state()
  return jsonify(current_state())


@app.delete("/api/outs/<int:out_id>")
@require_auth()
def api_outs_delete(out_id: int):
  tenant_state = get_state()
  records: List[OutRecord] = tenant_state["outs"]
  for index, record in enumerate(records):
    if record.id == out_id:
      account = g.account
      if not account_can_manage_user(account, tenant_state, record.user_id):
        return jsonify({"message": "You can only manage your own records."}), 403
      records.pop(index)
      persist_state()
      return ("", 204)

  return jsonify({"message": "Out record not found."}), 404


@app.patch("/api/expenses")
@require_auth("admin")
def api_expenses_update():
  payload = request.get_json(silent=True) or {}
  tenant_state = get_state()
  expenses = tenant_state["expenses"]

  for category in EXPENSE_FIELDS:
    if category not in payload:
      continue
    try:
      value = float(payload[category])
    except (TypeError, ValueError):
      return jsonify({"message": f"Invalid amount for {category}."}), 400
    if value < 0:
      return jsonify({"message": f"{category.title()} expense cannot be negative."}), 400
    expenses[category] = value

  persist_state()
  return jsonify(current_state())


@app.post("/api/fixed")
@require_auth("admin")
def api_fixed_create():
  payload = request.get_json(silent=True) or {}
  name = (payload.get("name") or "").strip()
  category = payload.get("category")
  amount = payload.get("amount")

  if not name:
    return jsonify({"message": "Name is required."}), 400
  if category not in CATEGORIES:
    return jsonify({"message": "Category is invalid."}), 400
  try:
    amount_value = float(amount)
  except (TypeError, ValueError):
    return jsonify({"message": "Amount must be a number."}), 400
  if amount_value < 0:
    return jsonify({"message": "Amount cannot be negative."}), 400

  tenant_state = get_state()
  charge = FixedCharge(
    id=tenant_state["next_fixed_id"],
    name=name,
    category=category,
    amount=amount_value,
  )
  tenant_state["next_fixed_id"] += 1
  tenant_state["fixed"].append(charge)
  persist_state()

  return jsonify(serialise_fixed(charge)), 201


@app.patch("/api/fixed/<int:fixed_id>")
@require_auth("admin")
def api_fixed_update(fixed_id: int):
  charge = find_fixed(fixed_id)
  if charge is None:
    return jsonify({"message": "Fixed charge not found."}), 404

  payload = request.get_json(silent=True) or {}

  if "name" in payload:
    new_name = (payload.get("name") or "").strip()
    if not new_name:
      return jsonify({"message": "Name is required."}), 400
    charge.name = new_name

  if "category" in payload:
    new_category = payload.get("category")
    if new_category not in CATEGORIES:
      return jsonify({"message": "Category is invalid."}), 400
    charge.category = new_category

  if "amount" in payload:
    try:
      amount_value = float(payload.get("amount"))
    except (TypeError, ValueError):
      return jsonify({"message": "Amount must be a number."}), 400
    if amount_value < 0:
      return jsonify({"message": "Amount cannot be negative."}), 400
    charge.amount = amount_value
  persist_state()

  return jsonify(serialise_fixed(charge))


@app.delete("/api/fixed/<int:fixed_id>")
@require_auth("admin")
def api_fixed_delete(fixed_id: int):
  tenant_state = get_state()
  charges: List[FixedCharge] = tenant_state["fixed"]
  for index, charge in enumerate(charges):
    if charge.id == fixed_id:
      charges.pop(index)
      persist_state()
      return ("", 204)

  return jsonify({"message": "Fixed charge not found."}), 404


def get_superadmin_accounts() -> List[Account]:
  return iter_accounts_by_role("superadmin")


def clear_superadmin_accounts() -> int:
  removed = delete_accounts_by(lambda account: account.role == "superadmin")
  if removed:
    persist_state()
  return removed


def set_superadmin_credentials(username: str, password: str) -> Account:
  existing = get_account_by_username(username, role="superadmin")
  if existing:
    existing.password_hash = generate_password_hash(password, method="pbkdf2:sha256")
    existing.last_active_at = datetime.utcnow()
    persist_state()
    return existing

  clear_superadmin_accounts()
  account = create_account(username, password, "superadmin", SUPERADMIN_TENANT_ID)
  return account


def serialise_user_obj(user: User) -> Dict[str, object]:
  return {
    "id": user.id,
    "name": user.name,
    "various_credit": user.various_credit,
    "mineral_credit": user.mineral_credit,
  }


def deserialise_user_obj(data: Dict[str, object]) -> User:
  return User(
    id=int(data["id"]),
    name=str(data["name"]),
    various_credit=float(data.get("various_credit", 0.0)),
    mineral_credit=float(data.get("mineral_credit", 0.0)),
  )


def serialise_out_obj(record: OutRecord) -> Dict[str, object]:
  return {
    "id": record.id,
    "user_id": record.user_id,
    "start": record.start.isoformat(),
    "end": record.end.isoformat(),
  }


def deserialise_out_obj(data: Dict[str, object]) -> OutRecord:
  return OutRecord(
    id=int(data["id"]),
    user_id=int(data["user_id"]),
    start=datetime.strptime(data["start"], "%Y-%m-%d").date(),
    end=datetime.strptime(data["end"], "%Y-%m-%d").date(),
  )


def serialise_fixed_obj(charge: FixedCharge) -> Dict[str, object]:
  return {
    "id": charge.id,
    "name": charge.name,
    "category": charge.category,
    "amount": charge.amount,
  }


def deserialise_fixed_obj(data: Dict[str, object]) -> FixedCharge:
  return FixedCharge(
    id=int(data["id"]),
    name=str(data["name"]),
    category=str(data["category"]),
    amount=float(data.get("amount", 0.0)),
  )


def serialise_receipt_obj(receipt: Receipt) -> Dict[str, object]:
  return {
    "id": receipt.id,
    "user_id": receipt.user_id,
    "filename": receipt.filename,
    "original_name": receipt.original_name,
    "uploaded_at": receipt.uploaded_at.isoformat(),
  }


def deserialise_receipt_obj(data: Dict[str, object]) -> Receipt:
  uploaded_at_raw = data.get("uploaded_at")
  uploaded_at = datetime.fromisoformat(uploaded_at_raw) if uploaded_at_raw else datetime.utcnow()
  return Receipt(
    id=int(data["id"]),
    user_id=int(data["user_id"]),
    filename=str(data["filename"]),
    original_name=str(data.get("original_name", "")),
    uploaded_at=uploaded_at,
  )


def serialise_feedback_entry(entry: Feedback) -> Dict[str, object]:
  return {
    "id": entry.id,
    "account_id": entry.account_id,
    "tenant_id": entry.tenant_id,
    "role": entry.role,
    "username": entry.username,
    "message": entry.message,
    "contact": entry.contact,
    "context": entry.context,
    "workspace_name": entry.workspace_name,
    "created_at": entry.created_at.isoformat(),
  }


def deserialise_feedback_entry(data: Dict[str, object]) -> Feedback:
  created_raw = data.get("created_at")
  created_at = datetime.fromisoformat(created_raw) if isinstance(created_raw, str) else datetime.utcnow()
  return Feedback(
    id=int(data["id"]),
    account_id=int(data.get("account_id", 0)),
    tenant_id=int(data["tenant_id"]) if data.get("tenant_id") is not None else None,
    role=str(data.get("role", "")),
    username=str(data.get("username", "")),
    message=str(data.get("message", "")),
    contact=str(data.get("contact")) if data.get("contact") not in (None, "") else None,
    context=str(data.get("context")) if data.get("context") not in (None, "") else None,
    workspace_name=str(data.get("workspace_name")) if data.get("workspace_name") not in (None, "") else None,
    created_at=created_at,
  )


def serialise_state(state: Dict[str, object]) -> Dict[str, object]:
  return {
    "users": [serialise_user_obj(user) for user in state["users"]],
    "outs": [serialise_out_obj(record) for record in state["outs"]],
    "fixed": [serialise_fixed_obj(charge) for charge in state["fixed"]],
    "receipts": [serialise_receipt_obj(receipt) for receipt in state["receipts"]],
    "next_id": state["next_id"],
    "next_out_id": state["next_out_id"],
    "next_fixed_id": state["next_fixed_id"],
    "next_receipt_id": state["next_receipt_id"],
    "billing_period": state["billing_period"],
    "expenses": state["expenses"],
  }


def deserialise_state(data: Dict[str, object]) -> Dict[str, object]:
  if data is None:
    return make_default_tenant_state()
  return {
    "users": [deserialise_user_obj(entry) for entry in data.get("users", [])],
    "outs": [deserialise_out_obj(entry) for entry in data.get("outs", [])],
    "fixed": [deserialise_fixed_obj(entry) for entry in data.get("fixed", [])],
    "receipts": [deserialise_receipt_obj(entry) for entry in data.get("receipts", [])],
    "next_id": int(data.get("next_id", 1)),
    "next_out_id": int(data.get("next_out_id", 1)),
    "next_fixed_id": int(data.get("next_fixed_id", 1)),
    "next_receipt_id": int(data.get("next_receipt_id", 1)),
    "billing_period": data.get("billing_period"),
    "expenses": {
      "water": float(data.get("expenses", {}).get("water", 0.0)),
      "electric": float(data.get("expenses", {}).get("electric", 0.0)),
      "internet": float(data.get("expenses", {}).get("internet", 0.0)),
      "rent": float(data.get("expenses", {}).get("rent", 0.0)),
    },
  }


def serialise_tenant_record(tenant: Dict[str, object]) -> Dict[str, object]:
  return {
    "id": tenant["id"],
    "invite_token": tenant.get("invite_token"),
    "name": tenant.get("name"),
    "state": serialise_state(tenant["state"]),
  }


def sync_resident_links() -> None:
  updated = False
  for account in accounts.values():
    if account.role != "renter" or account.resident_user_id is not None:
      continue
    tenant = tenants.get(account.tenant_id)
    if tenant is None:
      continue
    username = account.username.strip().lower()
    if not username:
      continue
    for user in tenant["state"]["users"]:
      if user.name.strip().lower() == username:
        account.resident_user_id = user.id
        updated = True
        break
  if updated:
    save_storage()


def save_storage() -> None:
  DATA_DIR.mkdir(parents=True, exist_ok=True)
  payload = {
    "next_account_id": next_account_id,
    "next_tenant_id": next_tenant_id,
    "next_feedback_id": next_feedback_id,
    "accounts": [
      {
        "id": account.id,
        "username": account.username,
        "password_hash": account.password_hash,
        "role": account.role,
        "tenant_id": account.tenant_id,
        "last_active_at": account.last_active_at.isoformat() if account.last_active_at else None,
        "resident_user_id": account.resident_user_id,
      }
      for account in accounts.values()
    ],
    "tenants": [serialise_tenant_record(tenant) for tenant in tenants.values()],
    "feedbacks": [serialise_feedback_entry(entry) for entry in feedback_entries],
  }
  with storage_lock, STORAGE_FILE.open("w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)


def load_storage() -> None:
  global accounts, tenants, next_account_id, next_tenant_id, feedback_entries, next_feedback_id
  if not STORAGE_FILE.exists():
    accounts = {}
    tenants = {}
    next_account_id = 1
    next_tenant_id = 1
    feedback_entries = []
    next_feedback_id = 1
    return

  with STORAGE_FILE.open("r", encoding="utf-8") as handle:
    payload = json.load(handle)

  next_account_id = int(payload.get("next_account_id", 1))
  next_tenant_id = int(payload.get("next_tenant_id", 1))
  next_feedback_id = int(payload.get("next_feedback_id", 1))

  accounts = {}
  for entry in payload.get("accounts", []):
    last_active_raw = entry.get("last_active_at")
    last_active = None
    if last_active_raw:
      try:
        last_active = datetime.fromisoformat(last_active_raw)
      except ValueError:
        last_active = None
    resident_user_id_raw = entry.get("resident_user_id")
    resident_user_id = None
    if resident_user_id_raw is not None:
      try:
        resident_user_id = int(resident_user_id_raw)
      except (TypeError, ValueError):
        resident_user_id = None
    account = Account(
      id=int(entry["id"]),
      username=str(entry["username"]),
      password_hash=str(entry["password_hash"]),
      role=str(entry.get("role", "renter")),
      tenant_id=int(entry["tenant_id"]),
      last_active_at=last_active,
      resident_user_id=resident_user_id,
    )
    accounts[account.id] = account

  tenants = {}
  for entry in payload.get("tenants", []):
    tenant_id = int(entry["id"])
    tenant_state = deserialise_state(entry.get("state"))
    tenants[tenant_id] = {
      "id": tenant_id,
      "invite_token": entry.get("invite_token"),
      "state": tenant_state,
      "name": normalise_workspace_name(entry.get("name"), tenant_id),
    }
    get_tenant_upload_folder(tenant_id)

  feedback_entries = [deserialise_feedback_entry(entry) for entry in payload.get("feedbacks", [])]
  sync_resident_links()


def persist_state() -> None:
  save_storage()


load_storage()


def parse_cli_args():
  parser = argparse.ArgumentParser(description="Dorm Expense Tracker application")
  subparsers = parser.add_subparsers(dest="command")

  superadmin_parser = subparsers.add_parser(
    "superadmin", help="Create, update, or clear super admin credentials."
  )
  superadmin_parser.add_argument(
    "--set",
    metavar="USERNAME",
    help="Username for the super admin account (omit to prompt).",
  )
  superadmin_parser.add_argument(
    "--password",
    help="Password for the super admin account (omit to prompt securely).",
  )
  superadmin_parser.add_argument(
    "--clear",
    action="store_true",
    help="Remove all existing super admin credentials.",
  )

  return parser.parse_args()


def handle_superadmin_cli(args) -> int:
  if args.clear:
    removed = clear_superadmin_accounts()
    print(f"Removed {removed} super admin account(s).")
    return 0

  username = args.set
  if not username:
    username = input("Enter super admin username: ").strip()
  if not username:
    print("Username is required.", file=sys.stderr)
    return 1

  password = args.password
  if not password:
    password = getpass.getpass("Enter super admin password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
      print("Passwords do not match.", file=sys.stderr)
      return 1
  if not password:
    print("Password is required.", file=sys.stderr)
    return 1

  try:
    account = set_superadmin_credentials(username.strip(), password)
  except ValueError as exc:
    print(f"Error: {exc}", file=sys.stderr)
    return 1

  print(f"Super admin credentials saved for '{account.username}'.")
  return 0


def main():
  args = parse_cli_args()
  if args.command == "superadmin":
    exit_code = handle_superadmin_cli(args)
    sys.exit(exit_code)

  debug_enabled = os.environ.get("FLASK_DEBUG", "0").strip().lower() in {"1", "true", "yes"}
  app.run(debug=debug_enabled)


if __name__ == "__main__":
  main()
