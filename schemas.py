"""Pydantic schemas for Voice Notes Reminder Agent."""

from __future__ import annotations
from typing import Optional, List, Any, Dict
from pydantic import BaseModel, Field


class ReminderBase(BaseModel):
    task: str = Field(..., description="Description of the task to be reminded about")
    due_at: str = Field(..., description="ISO 8601 string of when the reminder is due")
    status: str = Field(default="pending", description="Status: pending, announced, completed, or dismissed")
    announced_at: Optional[str] = Field(default=None, description="ISO 8601 string when reminder was announced")
    raw_transcript: Optional[str] = Field(default="", description="Original speech transcript")
    source: Optional[str] = Field(default="voice", description="Source of the reminder, e.g., voice or web")


class ReminderCreate(ReminderBase):
    pass


class Reminder(ReminderBase):
    id: str = Field(..., description="Unique reminder UUID string")
    created_at: str = Field(..., description="ISO 8601 string when reminder was created")


class ReminderStatusUpdate(BaseModel):
    status: str = Field(..., description="Updated status: pending, announced, completed, or dismissed")


class CommandRequest(BaseModel):
    transcript: str = Field(..., description="Transcript string spoken by the user")


class CommandResponse(BaseModel):
    intent: str = Field(..., description="Parsed intent, e.g. add_reminder, list_reminders, etc.")
    task: Optional[str] = Field(default=None, description="Extracted task text")
    due_at: Optional[str] = Field(default=None, description="Extracted due datetime in ISO 8601 format")
    reply: str = Field(..., description="Spoken/text response for the user")
    success: bool = Field(default=True, description="Whether the command succeeded")
    transcript: Optional[str] = Field(default=None, description="Transcribed voice command string")
    reminder: Optional[Reminder] = Field(default=None, description="Affected single reminder if applicable")
    reminders: Optional[List[Reminder]] = Field(default=None, description="List of reminders if queried")


class WebSocketMessage(BaseModel):
    event: str = Field(..., description="Event type: reminder_added, reminder_updated, reminder_deleted, reminder_announced")
    message: str = Field(..., description="Human-readable announcement or message")
    data: Optional[Dict[str, Any]] = Field(default=None, description="Payload data")
