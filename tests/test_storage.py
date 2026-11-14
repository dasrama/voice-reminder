"""Unit tests for the JSON storage engine."""

import os
import pytest
from pathlib import Path

import storage


@pytest.fixture
def temp_storage(tmp_path):
    """Provide an isolated temporary JSON storage file path."""
    test_file = str(tmp_path / "test_reminders.json")
    return test_file


def test_add_and_list_reminders(temp_storage):
    rem = storage.add_reminder(
        task="Water the cactus",
        due_at="2026-11-14T09:00:00",
        raw_transcript="remind me to water the cactus tomorrow at 9 AM",
        file_path=temp_storage,
    )
    assert rem["id"] is not None
    assert rem["task"] == "Water the cactus"
    assert rem["status"] == "pending"
    assert rem["announced_at"] is None
    assert rem["source"] == "voice"

    all_reminders = storage.list_all_reminders(temp_storage)
    assert len(all_reminders) == 1
    assert all_reminders[0]["id"] == rem["id"]


def test_list_pending_reminders(temp_storage):
    r1 = storage.add_reminder(task="Task 1", due_at="2026-11-14T10:00:00", file_path=temp_storage)
    r2 = storage.add_reminder(task="Task 2", due_at="2026-11-14T11:00:00", file_path=temp_storage)

    # Mark r1 as completed
    storage.update_reminder_status(r1["id"], "completed", file_path=temp_storage)

    pending = storage.list_pending_reminders(temp_storage)
    assert len(pending) == 1
    assert pending[0]["id"] == r2["id"]


def test_delete_reminder_by_id(temp_storage):
    r1 = storage.add_reminder(task="Task 1", due_at="2026-11-14T10:00:00", file_path=temp_storage)
    r2 = storage.add_reminder(task="Task 2", due_at="2026-11-14T11:00:00", file_path=temp_storage)

    deleted = storage.delete_reminder_by_id(r1["id"], file_path=temp_storage)
    assert deleted is not None
    assert deleted["id"] == r1["id"]

    remaining = storage.list_all_reminders(temp_storage)
    assert len(remaining) == 1
    assert remaining[0]["id"] == r2["id"]


def test_delete_last_reminder(temp_storage):
    r1 = storage.add_reminder(task="Task 1", due_at="2026-11-14T10:00:00", file_path=temp_storage)
    r2 = storage.add_reminder(task="Task 2", due_at="2026-11-14T11:00:00", file_path=temp_storage)

    deleted = storage.delete_last_reminder(temp_storage)
    assert deleted is not None
    assert deleted["id"] == r2["id"]

    all_rem = storage.list_all_reminders(temp_storage)
    assert len(all_rem) == 1
    assert all_rem[0]["id"] == r1["id"]


def test_mark_announced(temp_storage):
    r = storage.add_reminder(task="Task X", due_at="2026-11-14T10:00:00", file_path=temp_storage)
    updated = storage.mark_reminder_announced(r["id"], file_path=temp_storage)
    assert updated is not None
    assert updated["status"] == "announced"
    assert updated["announced_at"] is not None


def test_invalid_json_corrupted_file(temp_storage):
    # Write invalid JSON content into the file
    with open(temp_storage, "w", encoding="utf-8") as f:
        f.write("{ invalid json corrupted content }")

    # Ensure StorageCorruptionError is raised and file is not overwritten
    with pytest.raises(storage.StorageCorruptionError):
        storage.load_reminders(temp_storage)

    # Verify content was preserved and not overwritten
    with open(temp_storage, "r", encoding="utf-8") as f:
        content = f.read()
    assert content == "{ invalid json corrupted content }"
