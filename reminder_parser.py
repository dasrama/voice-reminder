"""Semantic reminder parser using local FastEmbed (all-MiniLM-L6-v2) vector embeddings.

Determines user intent through cosine similarity against prototype vectors,
coupled with deterministic Python date/time entity extraction.
"""

from __future__ import annotations
import re
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, Tuple
import numpy as np
from fastembed import TextEmbedding

# Direct model initialization (local ONNX runtime, no extra wrappers)
_model = TextEmbedding("sentence-transformers/all-MiniLM-L6-v2")

# Intent exemplar prototypes
INTENT_PROTOTYPES: Dict[str, list[str]] = {
    "add_reminder": [
        "remind me to",
        "remind me",
        "alert me to",
        "notify me to",
        "don't let me forget to",
        "set a reminder to",
        "ping me in",
        "remind me to water the plants tomorrow at 9 AM",
        "remind me to submit the assignment today at 6 PM",
        "remind me to take a break in 10 minutes",
        "alert me to take aspirin in 5 minutes",
        "don't let me forget to call Dad tonight",
        "remind me to attend class in 2 hours",
        "remind me to buy groceries",
    ],
    "list_reminders": [
        "what are my reminders",
        "show my reminders",
        "show all reminders",
        "list all reminders",
        "read my scheduled reminders",
        "what reminders do I have",
        "show what I have scheduled",
        "my reminders",
        "list reminders",
    ],
    "list_pending_reminders": [
        "what are my pending reminders",
        "show pending reminders",
        "list pending reminders",
        "pending reminders",
        "what tasks are still pending",
        "show pending",
    ],
    "delete_last_reminder": [
        "delete my last reminder",
        "delete the last reminder",
        "remove my last reminder",
        "cancel the previous reminder",
        "clear the last reminder",
        "clear my previous reminder",
        "discard the last task",
        "delete last reminder",
    ],
    "delete_reminder_by_id": [
        "delete reminder with ID 123",
        "delete reminder id 123",
        "delete reminder 123",
        "remove reminder with ID 456",
        "cancel reminder 789",
    ],
}

# Pre-compute and normalize prototype embedding matrices once at module load
EMBEDDED_PROTOTYPES: Dict[str, np.ndarray] = {}
for intent, phrases in INTENT_PROTOTYPES.items():
    vecs = np.array(list(_model.embed(phrases)))
    vecs = vecs / np.linalg.norm(vecs, axis=1, keepdims=True)
    EMBEDDED_PROTOTYPES[intent] = vecs


def get_local_now() -> datetime:
    """Return timezone-aware current datetime in the local timezone."""
    return datetime.now().astimezone()


def parse_time_of_day(time_str: str) -> Optional[Tuple[int, int]]:
    """
    Parse a time string like '6 PM', '6:30 PM', '9 AM', '18:30', '14:00', '8am'.
    Returns (hour, minute) in 24-hour format, or None if not matched.
    """
    cleaned = time_str.strip().lower()

    # Pattern for 12-hour format: e.g., '6 pm', '6:30 pm', '9 am', '9:15am'
    m_12 = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$", cleaned)
    if m_12:
        hour = int(m_12.group(1))
        minute = int(m_12.group(2)) if m_12.group(2) else 0
        meridiem = m_12.group(3)
        if hour == 12:
            hour = 0 if meridiem == "am" else 12
        elif meridiem == "pm":
            hour += 12
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return hour, minute

    # Pattern for 24-hour format: e.g., '18:30', '09:00', '14:15'
    m_24 = re.match(r"^(\d{1,2}):(\d{2})$", cleaned)
    if m_24:
        hour = int(m_24.group(1))
        minute = int(m_24.group(2))
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return hour, minute

    return None


def extract_relative_offset(text: str) -> Optional[Tuple[timedelta, str]]:
    """
    Match expressions like 'in 10 minutes', 'in 2 hours', 'in 1 day', 'in 30 seconds'.
    Returns (timedelta, matched_substring).
    """
    pattern = r"\bin\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b"
    m = re.search(pattern, text, re.IGNORECASE)
    if not m:
        return None

    qty = int(m.group(1))
    unit = m.group(2).lower()
    matched_str = m.group(0)

    if unit.startswith("sec"):
        delta = timedelta(seconds=qty)
    elif unit.startswith("min"):
        delta = timedelta(minutes=qty)
    elif unit.startswith("hour") or unit.startswith("hr"):
        delta = timedelta(hours=qty)
    elif unit.startswith("day"):
        delta = timedelta(days=qty)
    else:
        return None

    return delta, matched_str


def extract_date_and_time(text: str, base_time: Optional[datetime] = None) -> Optional[Tuple[datetime, str]]:
    """
    Extract date and time expressions such as:
    - 'today at 6 PM', 'today at 18:30', 'today'
    - 'tomorrow at 9 AM', 'tomorrow at 14:00', 'tomorrow'
    - 'tonight at 8 PM', 'tonight'
    - 'at 6 PM', 'at 18:30', 'at 9 AM'
    - 'in 10 minutes', 'in 2 hours', 'in 1 day'
    
    Returns (target_datetime, matched_substring) or None.
    """
    now = base_time or get_local_now()

    # 1. Check relative offset: e.g., 'in 10 minutes', 'in 2 hours', 'in 1 day'
    rel = extract_relative_offset(text)
    if rel:
        delta, matched_str = rel
        target_dt = now + delta
        return target_dt, matched_str

    # 2. Check compound: (today|tomorrow|tonight) [at TIME]
    compound_pattern = (
        r"\b(today|tomorrow|tonight)(?:\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?\b"
    )
    m_compound = re.search(compound_pattern, text, re.IGNORECASE)
    if m_compound:
        day_word = m_compound.group(1).lower()
        time_part = m_compound.group(2)
        matched_str = m_compound.group(0)

        # Determine target date
        if day_word == "today":
            target_date = now.date()
            default_hour, default_minute = (18, 0) if now.hour < 18 else (now.hour + 1, 0)
        elif day_word == "tomorrow":
            target_date = (now + timedelta(days=1)).date()
            default_hour, default_minute = (9, 0)
        elif day_word == "tonight":
            target_date = now.date()
            default_hour, default_minute = (20, 0)
        else:
            target_date = now.date()
            default_hour, default_minute = (now.hour + 1, 0)

        if time_part:
            parsed_time = parse_time_of_day(time_part)
            if parsed_time:
                target_hour, target_minute = parsed_time
            else:
                target_hour, target_minute = default_hour, default_minute
        else:
            target_hour, target_minute = default_hour, default_minute

        target_dt = now.replace(
            year=target_date.year,
            month=target_date.month,
            day=target_date.day,
            hour=target_hour,
            minute=target_minute,
            second=0,
            microsecond=0,
        )

        # Roll forward if time has already passed
        if day_word == "tonight" and target_dt <= now:
            target_dt = now + timedelta(hours=1)
        elif day_word == "today" and target_dt <= now and not time_part:
            target_dt = now + timedelta(hours=1)

        return target_dt, matched_str

    # 3. Check standalone clock time: e.g. 'at 6 PM', 'at 18:30', 'at 9:00 AM'
    clock_pattern = r"\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\b"
    m_clock = re.search(clock_pattern, text, re.IGNORECASE)
    if m_clock:
        time_part = m_clock.group(1)
        matched_str = m_clock.group(0)
        parsed_time = parse_time_of_day(time_part)
        if parsed_time:
            hour, minute = parsed_time
            target_dt = now.replace(
                hour=hour,
                minute=minute,
                second=0,
                microsecond=0,
            )
            if target_dt <= now:
                target_dt += timedelta(days=1)
            return target_dt, matched_str

    return None


def clean_task_text(text: str, matched_time_substring: Optional[str] = None) -> str:
    """
    Remove reminder trigger keywords and matched time substring to isolate the task description.
    """
    s = text.strip()

    # Strip command prefixes (including synonyms)
    prefix_patterns = [
        r"^(?:please\s+)?remind\s+me\s+to\s+",
        r"^(?:please\s+)?remind\s+me\s+",
        r"^(?:please\s+)?set\s+a\s+reminder\s+to\s+",
        r"^(?:please\s+)?set\s+a\s+reminder\s+for\s+",
        r"^(?:please\s+)?add\s+a\s+reminder\s+to\s+",
        r"^(?:please\s+)?add\s+reminder\s+",
        r"^(?:please\s+)?alert\s+me\s+to\s+",
        r"^(?:please\s+)?alert\s+me\s+",
        r"^(?:please\s+)?notify\s+me\s+to\s+",
        r"^(?:please\s+)?notify\s+me\s+",
        r"^(?:please\s+)?don'?t\s+let\s+me\s+forget\s+to\s+",
        r"^(?:please\s+)?don'?t\s+let\s+me\s+forget\s+",
        r"^(?:please\s+)?ping\s+me\s+to\s+",
        r"^(?:please\s+)?ping\s+me\s+",
    ]
    for pattern in prefix_patterns:
        s = re.sub(pattern, "", s, flags=re.IGNORECASE).strip()

    # Remove matched time substring
    if matched_time_substring:
        s = re.sub(re.escape(matched_time_substring), "", s, flags=re.IGNORECASE).strip()

    # Clean up trailing/leading prepositions or punctuation
    s = re.sub(r"^(?:to|for|about)\s+", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"\s+(?:at|on|for|by|in)$", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"[.,;!?]+$", "", s).strip()

    return s


def parse_command(transcript: str, base_time: Optional[datetime] = None) -> Dict[str, Any]:
    """
    Parse a voice command transcript into an intent and associated metadata
    using local FastEmbed semantic embeddings.

    Supported intents:
    - add_reminder
    - list_reminders
    - list_pending_reminders
    - delete_last_reminder
    - delete_reminder_by_id
    - unknown
    """
    raw = transcript.strip()
    clean = re.sub(r"[.,;!?]+$", "", raw).strip()
    if not clean:
        return {
            "intent": "unknown",
            "task": None,
            "due_at": None,
            "raw_transcript": raw,
            "target_id": None,
        }

    lower = clean.lower()

    # 1. Compute semantic embedding and cosine similarity against intent prototypes
    query_vec = list(_model.embed([clean]))[0]
    norm = np.linalg.norm(query_vec)
    if norm > 0:
        query_vec = query_vec / norm

    # Calculate max similarity score for each intent category
    scores = {
        intent: float(np.max(np.dot(vecs, query_vec)))
        for intent, vecs in EMBEDDED_PROTOTYPES.items()
    }
    best_intent, best_score = max(scores.items(), key=lambda x: x[1])

    # Minimum confidence threshold (out-of-domain queries typically score < 0.35)
    if best_score < 0.35:
        # Check if there is an explicit time expression fallback
        time_result = extract_date_and_time(raw, base_time=base_time)
        if time_result is not None:
            target_dt, matched_time_str = time_result
            task = clean_task_text(raw, matched_time_substring=matched_time_str)
            if task:
                return {
                    "intent": "add_reminder",
                    "task": task,
                    "due_at": target_dt.isoformat(),
                    "raw_transcript": raw,
                    "target_id": None,
                }
        return {
            "intent": "unknown",
            "task": None,
            "due_at": None,
            "raw_transcript": raw,
            "target_id": None,
        }

    # 2. Query intents
    if best_intent == "list_pending_reminders":
        return {
            "intent": "list_pending_reminders",
            "task": None,
            "due_at": None,
            "raw_transcript": raw,
            "target_id": None,
        }

    if best_intent == "list_reminders":
        return {
            "intent": "list_reminders",
            "task": None,
            "due_at": None,
            "raw_transcript": raw,
            "target_id": None,
        }

    # 3. Delete intents
    if best_intent == "delete_last_reminder":
        return {
            "intent": "delete_last_reminder",
            "task": None,
            "due_at": None,
            "raw_transcript": raw,
            "target_id": None,
        }

    if best_intent == "delete_reminder_by_id":
        m_id = re.search(r"\b(?:id\s+|#)?([a-zA-Z0-9\-]+)\b", lower)
        target_id = None
        if m_id:
            # Extract captured ID tokens
            tokens = re.findall(r"\b[a-zA-Z0-9\-]+\b", lower)
            for token in reversed(tokens):
                if token not in ["delete", "remove", "cancel", "reminder", "with", "id", "#", "the", "my"]:
                    target_id = token
                    break
        return {
            "intent": "delete_reminder_by_id",
            "task": None,
            "due_at": None,
            "raw_transcript": raw,
            "target_id": target_id,
        }

    # 4. Add reminder intent
    if best_intent == "add_reminder":
        time_result = extract_date_and_time(raw, base_time=base_time)
        if time_result is not None:
            target_dt, matched_time_str = time_result
            task = clean_task_text(raw, matched_time_substring=matched_time_str)
            return {
                "intent": "add_reminder",
                "task": task if task else "reminder",
                "due_at": target_dt.isoformat(),
                "raw_transcript": raw,
                "target_id": None,
            }
        else:
            task = clean_task_text(raw, matched_time_substring=None)
            return {
                "intent": "add_reminder",
                "task": task if task else "reminder",
                "due_at": None,
                "raw_transcript": raw,
                "target_id": None,
            }

    return {
        "intent": "unknown",
        "task": None,
        "due_at": None,
        "raw_transcript": raw,
        "target_id": None,
    }
