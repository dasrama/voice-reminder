"""Thread-safe, atomic local JSON storage engine for reminders."""

import json
import os
import uuid
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Dict, Any

# Default path, configurable via environment variable
DEFAULT_STORAGE_PATH = os.getenv("REMINDERS_FILE", "data/reminders.json")

# Concurrency lock for safe file operations
_storage_lock = threading.Lock()


class StorageCorruptionError(Exception):
    """Raised when the reminders JSON file is corrupted or not valid JSON."""
    pass


def get_local_now() -> datetime:
    """Return timezone-aware current datetime in the local timezone."""
    return datetime.now().astimezone()


def get_local_now_iso() -> str:
    """Return ISO 8601 string for current local time."""
    return get_local_now().isoformat()


def _get_path(file_path: Optional[str] = None) -> str:
    """Resolve file path dynamically."""
    if file_path:
        return file_path
    return os.getenv("REMINDERS_FILE", DEFAULT_STORAGE_PATH)


def ensure_storage_file(file_path: Optional[str] = None) -> Path:
    """Ensure that the storage file and parent directory exist."""
    path = Path(_get_path(file_path))
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        # Initialize with empty list
        with open(path, "w", encoding="utf-8") as f:
            f.write("[]\n")
    return path


def load_reminders(file_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Load all reminders from the JSON file.
    If the file is invalid JSON, raises StorageCorruptionError without overwriting it.
    """
    path = ensure_storage_file(file_path)
    with _storage_lock:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return []
            try:
                data = json.loads(content)
                if not isinstance(data, list):
                    raise StorageCorruptionError(
                        f"Expected JSON list in {path}, but found {type(data).__name__}"
                    )
                return data
            except json.JSONDecodeError as exc:
                raise StorageCorruptionError(
                    f"Corrupted or invalid JSON in {path}: {exc}"
                ) from exc


def save_reminders(reminders: List[Dict[str, Any]], file_path: Optional[str] = None) -> None:
    """
    Atomically save reminders list to JSON file using a temporary file and os.replace.
    """
    path = ensure_storage_file(file_path)
    temp_path = path.with_suffix(".tmp")
    
    with _storage_lock:
        # Write to temporary file
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(reminders, f, indent=2, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        # Atomic rename/replace
        temp_path.replace(path)


def add_reminder(
    task: str,
    due_at: str,
    raw_transcript: str = "",
    source: str = "voice",
    file_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Add a new reminder and save it atomically."""
    new_reminder: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "task": task.strip(),
        "due_at": due_at,
        "status": "pending",
        "created_at": get_local_now_iso(),
        "announced_at": None,
        "raw_transcript": raw_transcript,
        "source": source,
    }
    reminders = load_reminders(file_path)
    reminders.append(new_reminder)
    save_reminders(reminders, file_path)
    return new_reminder


def list_all_reminders(file_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return all reminders sorted by due_at ascending."""
    reminders = load_reminders(file_path)
    return sorted(reminders, key=lambda r: r.get("due_at", ""))


def list_pending_reminders(file_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return only reminders with status 'pending' sorted by due_at ascending."""
    reminders = load_reminders(file_path)
    pending = [r for r in reminders if r.get("status") == "pending"]
    return sorted(pending, key=lambda r: r.get("due_at", ""))


def get_reminder_by_id(reminder_id: str, file_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Get a reminder by its unique ID (or prefix match if short ID used)."""
    reminders = load_reminders(file_path)
    target = reminder_id.strip().lower()
    for r in reminders:
        rid = str(r.get("id", "")).lower()
        if rid == target or (len(target) >= 4 and rid.startswith(target)):
            return r
    return None


def delete_reminder_by_id(reminder_id: str, file_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Delete a reminder by ID and return the deleted reminder, or None if not found."""
    reminders = load_reminders(file_path)
    target = reminder_id.strip().lower()
    match_index = -1
    matched_reminder = None

    for i, r in enumerate(reminders):
        rid = str(r.get("id", "")).lower()
        if rid == target or (len(target) >= 4 and rid.startswith(target)):
            match_index = i
            matched_reminder = r
            break

    if match_index != -1 and matched_reminder:
        reminders.pop(match_index)
        save_reminders(reminders, file_path)
        return matched_reminder
    return None


def delete_last_reminder(file_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Delete the most recently created reminder and return it, or None if list is empty."""
    reminders = load_reminders(file_path)
    if not reminders:
        return None
    # Last created reminder
    deleted = reminders.pop(-1)
    save_reminders(reminders, file_path)
    return deleted


def update_reminder_status(
    reminder_id: str,
    status: str,
    file_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Update status of a reminder by ID and return the updated reminder."""
    reminders = load_reminders(file_path)
    target = reminder_id.strip().lower()
    for r in reminders:
        rid = str(r.get("id", "")).lower()
        if rid == target or (len(target) >= 4 and rid.startswith(target)):
            r["status"] = status
            save_reminders(reminders, file_path)
            return r
    return None


def mark_reminder_announced(
    reminder_id: str,
    file_path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Mark a reminder as announced with current local timestamp."""
    reminders = load_reminders(file_path)
    target = reminder_id.strip().lower()
    for r in reminders:
        rid = str(r.get("id", "")).lower()
        if rid == target or (len(target) >= 4 and rid.startswith(target)):
            r["status"] = "announced"
            r["announced_at"] = get_local_now_iso()
            save_reminders(reminders, file_path)
            return r
    return None
