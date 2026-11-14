"""Unit tests for the rule-based reminder parser."""

import pytest
from datetime import datetime, timedelta
from reminder_parser import parse_command, parse_time_of_day, extract_relative_offset


def test_parse_time_of_day_12h():
    assert parse_time_of_day("9 AM") == (9, 0)
    assert parse_time_of_day("9:30 AM") == (9, 30)
    assert parse_time_of_day("6 PM") == (18, 0)
    assert parse_time_of_day("12 PM") == (12, 0)
    assert parse_time_of_day("12 AM") == (0, 0)


def test_parse_time_of_day_24h():
    assert parse_time_of_day("18:30") == (18, 30)
    assert parse_time_of_day("09:15") == (9, 15)
    assert parse_time_of_day("00:00") == (0, 0)


def test_extract_relative_offset():
    delta, match = extract_relative_offset("remind me in 10 minutes to stretch")
    assert delta == timedelta(minutes=10)
    assert match == "in 10 minutes"

    delta, match = extract_relative_offset("attend lecture in 2 hours")
    assert delta == timedelta(hours=2)
    assert match == "in 2 hours"

    delta, match = extract_relative_offset("finish project in 1 day")
    assert delta == timedelta(days=1)
    assert match == "in 1 day"


def test_command_water_plants_tomorrow_9am():
    cmd = "Remind me to water the plants tomorrow at 9 AM."
    res = parse_command(cmd)
    assert res["intent"] == "add_reminder"
    assert "water the plants" in res["task"].lower()
    assert res["due_at"] is not None
    dt = datetime.fromisoformat(res["due_at"])
    assert dt.hour == 9
    assert dt.minute == 0


def test_command_submit_assignment_today_6pm():
    cmd = "Remind me to submit the assignment today at 6 PM."
    res = parse_command(cmd)
    assert res["intent"] == "add_reminder"
    assert "submit the assignment" in res["task"].lower()
    assert res["due_at"] is not None
    dt = datetime.fromisoformat(res["due_at"])
    assert dt.hour == 18
    assert dt.minute == 0


def test_command_call_mom_tonight():
    cmd = "Remind me to call Mom tonight."
    res = parse_command(cmd)
    assert res["intent"] == "add_reminder"
    assert "call mom" in res["task"].lower()
    assert res["due_at"] is not None


def test_command_take_break_in_10_minutes():
    cmd = "Remind me to take a break in 10 minutes."
    res = parse_command(cmd)
    assert res["intent"] == "add_reminder"
    assert "take a break" in res["task"].lower()
    assert res["due_at"] is not None


def test_command_attend_class_in_2_hours():
    cmd = "Remind me to attend class in 2 hours."
    res = parse_command(cmd)
    assert res["intent"] == "add_reminder"
    assert "attend class" in res["task"].lower()
    assert res["due_at"] is not None


def test_command_what_are_my_reminders():
    cmd = "What are my reminders?"
    res = parse_command(cmd)
    assert res["intent"] == "list_reminders"


def test_command_what_are_my_pending_reminders():
    cmd = "What are my pending reminders?"
    res = parse_command(cmd)
    assert res["intent"] == "list_pending_reminders"


def test_command_delete_last_reminder():
    cmd = "Delete my last reminder."
    res = parse_command(cmd)
    assert res["intent"] == "delete_last_reminder"


def test_command_delete_reminder_with_id():
    cmd = "Delete reminder with ID 123."
    res = parse_command(cmd)
    assert res["intent"] == "delete_reminder_by_id"
    assert res["target_id"] == "123"


def test_command_add_reminder_missing_time():
    cmd = "Remind me to buy groceries"
    res = parse_command(cmd)
    assert res["intent"] == "add_reminder"
    assert res["task"] == "buy groceries"
    assert res["due_at"] is None


def test_command_unknown():
    cmd = "Tell me a funny joke about robots."
    res = parse_command(cmd)
    assert res["intent"] == "unknown"
    assert res["due_at"] is None
