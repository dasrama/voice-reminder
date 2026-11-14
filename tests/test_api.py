"""Integration tests for FastAPI endpoints."""

import os
import pytest
from fastapi.testclient import TestClient

import storage
from app import app


@pytest.fixture(autouse=True)
def setup_test_storage(tmp_path, monkeypatch):
    """Use a temporary storage file for each API test."""
    test_storage_file = str(tmp_path / "test_api_reminders.json")
    monkeypatch.setenv("REMINDERS_FILE", test_storage_file)
    monkeypatch.setattr(storage, "DEFAULT_STORAGE_PATH", test_storage_file)
    storage.ensure_storage_file(test_storage_file)


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_get_root_page(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_post_command_add_reminder_success(client):
    payload = {"transcript": "Remind me to water the plants tomorrow at 9 AM."}
    response = client.post("/api/command", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["intent"] == "add_reminder"
    assert "water the plants" in data["task"].lower()
    assert data["reminder"] is not None
    assert data["reminder"]["status"] == "pending"


def test_post_command_missing_time(client):
    payload = {"transcript": "Remind me to call grandma"}
    response = client.post("/api/command", json=payload)
    assert response.status_code == 400
    data = response.json()
    assert data["success"] is False
    assert data["intent"] == "add_reminder"
    assert "repeat" in data["reply"].lower() or "time" in data["reply"].lower()


def test_post_command_empty_transcript(client):
    payload = {"transcript": "   "}
    response = client.post("/api/command", json=payload)
    assert response.status_code == 400
    data = response.json()
    assert data["success"] is False


def test_post_command_list_reminders(client):
    # Add one reminder first
    client.post("/api/command", json={"transcript": "Remind me to do homework in 1 hour."})
    
    # Query reminders
    response = client.post("/api/command", json={"transcript": "What are my reminders?"})
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["intent"] == "list_reminders"
    assert len(data["reminders"]) >= 1


def test_post_command_delete_last_reminder(client):
    client.post("/api/command", json={"transcript": "Remind me to take medicine in 10 minutes."})
    response = client.post("/api/command", json={"transcript": "Delete my last reminder."})
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["intent"] == "delete_last_reminder"
    assert "take medicine" in data["reply"].lower()


def test_get_and_patch_reminders_rest(client):
    # Create reminder
    res_add = client.post("/api/command", json={"transcript": "Remind me to exercise tomorrow at 7 AM."})
    rem_id = res_add.json()["reminder"]["id"]

    # GET /api/reminders
    res_list = client.get("/api/reminders")
    assert res_list.status_code == 200
    reminders = res_list.json()
    assert any(r["id"] == rem_id for r in reminders)

    # GET /api/reminders/pending
    res_pending = client.get("/api/reminders/pending")
    assert res_pending.status_code == 200
    assert any(r["id"] == rem_id for r in res_pending.json())

    # PATCH /api/reminders/{reminder_id}
    res_patch = client.patch(f"/api/reminders/{rem_id}", json={"status": "completed"})
    assert res_patch.status_code == 200
    assert res_patch.json()["status"] == "completed"

    # DELETE /api/reminders/{reminder_id}
    res_del = client.delete(f"/api/reminders/{rem_id}")
    assert res_del.status_code == 200

    # DELETE again should return 404
    res_del_404 = client.delete(f"/api/reminders/{rem_id}")
    assert res_del_404.status_code == 404
