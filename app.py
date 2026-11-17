"""FastAPI main application for Voice Notes Reminder Agent."""

import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect, status, File, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

import storage
import transcriber
from schemas import (
    Reminder,
    ReminderStatusUpdate,
    CommandRequest,
    CommandResponse,
)
from reminder_parser import parse_command
from scheduler import scheduler, manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for starting and stopping background scheduler."""
    print("Starting Voice Notes Reminder Agent...")
    storage.ensure_storage_file()
    scheduler.start()
    yield
    print("Stopping Voice Notes Reminder Agent...")
    await scheduler.stop()


app = FastAPI(
    title="Voice Notes Reminder Agent",
    description="Speech-driven reminder web application with local JSON persistence and background announcement scheduler.",
    version="1.0.0",
    lifespan=lifespan,
)

# Ensure directories exist
os.makedirs("static", exist_ok=True)
os.makedirs("templates", exist_ok=True)
os.makedirs("data", exist_ok=True)

# Mount static files and Jinja2 templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


def format_friendly_time(iso_str: str) -> str:
    """Format an ISO datetime string into a natural, spoken friendly string."""
    try:
        dt = datetime.fromisoformat(iso_str)
        now = datetime.now().astimezone()
        # Today / tomorrow check
        dt_date = dt.date()
        now_date = now.date()

        time_part = dt.strftime("%I:%M %p").lstrip("0")
        if dt_date == now_date:
            return f"today at {time_part}"
        elif (dt_date - now_date).days == 1:
            return f"tomorrow at {time_part}"
        else:
            return f"on {dt.strftime('%B %d')} at {time_part}"
    except Exception:
        return iso_str


# ---------------------------------------------------------------------------
# HTTP Endpoints
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def get_index(request: Request):
    """Serve the main application HTML page."""
    return templates.TemplateResponse(request=request, name="index.html")


@app.post("/api/transcribe")
async def transcribe_audio_endpoint(file: UploadFile = File(...)):
    """Transcribe an uploaded audio file using the local Whisper model."""
    try:
        content = await file.read()
        if not content:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Empty audio payload received.",
            )
        filename = file.filename or "recording.webm"
        ext = os.path.splitext(filename)[1] or ".webm"
        transcript = transcriber.transcribe_audio_bytes(content, ext)
        return {"transcript": transcript}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Transcription error: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Transcription failed: {exc}",
        )


@app.post("/api/voice-command", response_model=CommandResponse)
async def process_voice_audio_command(file: UploadFile = File(...)):
    """
    Accept an audio recording file directly, transcribe it via local Whisper,
    and process the resulting transcript into a reminder action.
    """
    try:
        content = await file.read()
        if not content:
            content_resp = CommandResponse(
                intent="unknown",
                reply="Empty audio recording received.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=content_resp)

        filename = file.filename or "recording.webm"
        ext = os.path.splitext(filename)[1] or ".webm"
        transcript = transcriber.transcribe_audio_bytes(content, ext)

        if not transcript:
            content_resp = CommandResponse(
                intent="unknown",
                reply="No speech could be recognized. Please try speaking again.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=content_resp)

        return await process_voice_command(CommandRequest(transcript=transcript))
    except Exception as exc:
        print(f"Voice audio command error: {exc}")
        content_resp = CommandResponse(
            intent="unknown",
            reply="Failed to process voice audio recording.",
            success=False,
        ).model_dump()
        return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=content_resp)


@app.post("/api/command", response_model=CommandResponse)
async def process_voice_command(body: CommandRequest):
    """
    Accept voice transcript, parse intent and parameters, perform action,
    and return structured response suitable for frontend display and speech synthesis.
    """
    transcript = body.transcript.strip()
    if not transcript:
        content = CommandResponse(
            intent="unknown",
            reply="I did not hear any speech. Please try speaking again.",
            success=False,
        ).model_dump()
        return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=content)

    try:
        parsed = parse_command(transcript)
    except Exception as exc:
        print(f"Error parsing transcript '{transcript}': {exc}")
        content = CommandResponse(
            intent="unknown",
            reply="An error occurred while parsing your request.",
            success=False,
        ).model_dump()
        return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=content)

    intent = parsed["intent"]
    task = parsed.get("task")
    due_at = parsed.get("due_at")
    target_id = parsed.get("target_id")

    # Intent 1: Add Reminder
    if intent == "add_reminder":
        if not due_at:
            content = CommandResponse(
                intent="add_reminder",
                task=task,
                due_at=None,
                reply="Please repeat the reminder with a time, for example: 'tomorrow at 9 AM' or 'in 10 minutes'.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=content)

        clean_task = task or "your reminder"
        try:
            created = storage.add_reminder(
                task=clean_task,
                due_at=due_at,
                raw_transcript=transcript,
                source="voice",
            )
            # Notify WebSocket clients
            await manager.broadcast({
                "event": "reminder_added",
                "message": f"Added reminder: {clean_task}",
                "reminder": created,
            })

            friendly_time = format_friendly_time(due_at)
            reply_msg = f"I have set a reminder to {clean_task} {friendly_time}."
            return CommandResponse(
                intent="add_reminder",
                task=clean_task,
                due_at=due_at,
                reply=reply_msg,
                success=True,
                transcript=transcript,
                reminder=Reminder(**created),
            )
        except Exception as exc:
            print(f"Error saving reminder: {exc}")
            content = CommandResponse(
                intent="add_reminder",
                task=clean_task,
                reply="Failed to save reminder due to a storage error.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=content)

    # Intent 2: List All Reminders
    elif intent == "list_reminders":
        try:
            all_reminders = storage.list_all_reminders()
            if not all_reminders:
                reply_msg = "You do not have any reminders set."
            else:
                count = len(all_reminders)
                first_due = format_friendly_time(all_reminders[0].get("due_at", ""))
                reply_msg = f"You have {count} reminder{'s' if count > 1 else ''}. The next one is '{all_reminders[0]['task']}' {first_due}."

            return CommandResponse(
                intent="list_reminders",
                reply=reply_msg,
                success=True,
                transcript=transcript,
                reminders=[Reminder(**r) for r in all_reminders],
            )
        except Exception as exc:
            print(f"Error listing reminders: {exc}")
            content = CommandResponse(
                intent="list_reminders",
                reply="Unable to retrieve reminders at this time.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=content)

    # Intent 3: List Pending Reminders
    elif intent == "list_pending_reminders":
        try:
            pending = storage.list_pending_reminders()
            if not pending:
                reply_msg = "You have no pending reminders."
            else:
                count = len(pending)
                first_due = format_friendly_time(pending[0].get("due_at", ""))
                reply_msg = f"You have {count} pending reminder{'s' if count > 1 else ''}. Next is '{pending[0]['task']}' {first_due}."

            return CommandResponse(
                intent="list_pending_reminders",
                reply=reply_msg,
                success=True,
                transcript=transcript,
                reminders=[Reminder(**r) for r in pending],
            )
        except Exception as exc:
            print(f"Error listing pending reminders: {exc}")
            content = CommandResponse(
                intent="list_pending_reminders",
                reply="Unable to retrieve pending reminders at this time.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=content)

    # Intent 4: Delete Last Reminder
    elif intent == "delete_last_reminder":
        try:
            deleted = storage.delete_last_reminder()
            if deleted:
                await manager.broadcast({
                    "event": "reminder_deleted",
                    "message": f"Deleted reminder: {deleted.get('task')}",
                    "reminder": deleted,
                })
                reply_msg = f"Deleted your last reminder: '{deleted.get('task')}'."
                return CommandResponse(
                    intent="delete_last_reminder",
                    reply=reply_msg,
                    success=True,
                    transcript=transcript,
                    reminder=Reminder(**deleted),
                )
            else:
                reply_msg = "There are no reminders to delete."
                return CommandResponse(
                    intent="delete_last_reminder",
                    reply=reply_msg,
                    success=False,
                    transcript=transcript,
                )
        except Exception as exc:
            print(f"Error deleting last reminder: {exc}")
            content = CommandResponse(
                intent="delete_last_reminder",
                reply="Failed to delete reminder due to a storage error.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=content)

    # Intent 5: Delete Reminder by ID
    elif intent == "delete_reminder_by_id":
        if not target_id:
            content = CommandResponse(
                intent="delete_reminder_by_id",
                reply="Please specify the reminder ID you wish to delete.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=content)

        try:
            deleted = storage.delete_reminder_by_id(target_id)
            if deleted:
                await manager.broadcast({
                    "event": "reminder_deleted",
                    "message": f"Deleted reminder: {deleted.get('task')}",
                    "reminder": deleted,
                })
                reply_msg = f"Deleted reminder: '{deleted.get('task')}'."
                return CommandResponse(
                    intent="delete_reminder_by_id",
                    reply=reply_msg,
                    success=True,
                    transcript=transcript,
                    reminder=Reminder(**deleted),
                )
            else:
                reply_msg = f"Reminder with ID '{target_id}' was not found."
                content = CommandResponse(
                    intent="delete_reminder_by_id",
                    reply=reply_msg,
                    success=False,
                    transcript=transcript,
                ).model_dump()
                return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content=content)
        except Exception as exc:
            print(f"Error deleting reminder {target_id}: {exc}")
            content = CommandResponse(
                intent="delete_reminder_by_id",
                reply="Failed to delete reminder due to a storage error.",
                success=False,
            ).model_dump()
            return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=content)

    # Fallback: Unknown Command
    else:
        reply_msg = "I didn't recognize that command. You can say 'Remind me to water the plants tomorrow at 9 AM' or 'What are my reminders?'"
        content = CommandResponse(
            intent="unknown",
            reply=reply_msg,
            success=False,
        ).model_dump()
        return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content=content)


@app.get("/api/reminders", response_model=List[Reminder])
async def get_all_reminders():
    """Retrieve all reminders sorted by due time."""
    try:
        data = storage.list_all_reminders()
        return [Reminder(**r) for r in data]
    except storage.StorageCorruptionError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))
    except Exception as exc:
        print(f"Error retrieving reminders: {exc}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to load reminders")


@app.get("/api/reminders/pending", response_model=List[Reminder])
async def get_pending_reminders():
    """Retrieve all pending reminders."""
    try:
        data = storage.list_pending_reminders()
        return [Reminder(**r) for r in data]
    except storage.StorageCorruptionError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc))
    except Exception as exc:
        print(f"Error retrieving pending reminders: {exc}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to load pending reminders")


@app.patch("/api/reminders/{reminder_id}", response_model=Reminder)
async def update_status(reminder_id: str, body: ReminderStatusUpdate):
    """Update status of a reminder (e.g. pending, completed, announced, dismissed)."""
    try:
        updated = storage.update_reminder_status(reminder_id, body.status)
        if not updated:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Reminder with ID '{reminder_id}' not found",
            )

        # Notify WebSocket clients
        await manager.broadcast({
            "event": "reminder_updated",
            "message": f"Updated reminder {reminder_id} to status '{body.status}'",
            "reminder": updated,
        })
        return Reminder(**updated)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Error updating reminder {reminder_id}: {exc}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to update reminder")


@app.delete("/api/reminders/{reminder_id}", response_model=Reminder)
async def delete_reminder(reminder_id: str):
    """Delete a reminder by ID."""
    try:
        deleted = storage.delete_reminder_by_id(reminder_id)
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Reminder with ID '{reminder_id}' not found",
            )

        # Notify WebSocket clients
        await manager.broadcast({
            "event": "reminder_deleted",
            "message": f"Deleted reminder: {deleted.get('task')}",
            "reminder": deleted,
        })
        return Reminder(**deleted)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Error deleting reminder {reminder_id}: {exc}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to delete reminder")


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket connection for real-time announcements and reminder state updates."""
    await manager.connect(websocket)
    try:
        while True:
            # Keep connection open and receive optional messages from frontend
            data = await websocket.receive_text()
            # If client sends a ping or message, respond or acknowledge
            if data.lower() == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception as exc:
        print(f"WebSocket client error: {exc}")
        await manager.disconnect(websocket)
