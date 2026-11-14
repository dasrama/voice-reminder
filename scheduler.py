"""Background scheduler and WebSocket connection manager for Voice Notes Reminder Agent."""

from __future__ import annotations
import asyncio
import os
import logging
from datetime import datetime
from typing import List, Dict, Any, Optional
from fastapi import WebSocket

import storage

logger = logging.getLogger("reminder_scheduler")

DEFAULT_INTERVAL_SECONDS = int(os.getenv("SCHEDULER_INTERVAL_SECONDS", "30"))


class ConnectionManager:
    """Manages active WebSocket client connections and JSON broadcasting."""

    def __init__(self) -> None:
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected. Total clients: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        logger.info(f"WebSocket client disconnected. Total clients: {len(self.active_connections)}")

    async def broadcast(self, message: Dict[str, Any]) -> None:
        """Broadcast a JSON message to all active WebSocket connections."""
        async with self._lock:
            disconnected: List[WebSocket] = []
            for connection in self.active_connections:
                try:
                    await connection.send_json(message)
                except Exception as exc:
                    logger.warning(f"Failed to send to client ({exc}). Marking for disconnect.")
                    disconnected.append(connection)

            for dead_conn in disconnected:
                if dead_conn in self.active_connections:
                    self.active_connections.remove(dead_conn)


# Shared singleton instance
manager = ConnectionManager()


async def check_due_reminders(storage_file: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Check for pending reminders whose due_at time has arrived or passed,
    mark them as 'announced', and broadcast an announcement event.
    """
    path = storage_file or storage.DEFAULT_STORAGE_PATH
    now = datetime.now().astimezone()
    pending = storage.list_pending_reminders(path)
    announced: List[Dict[str, Any]] = []

    for r in pending:
        due_at_str = r.get("due_at")
        if not due_at_str:
            continue

        try:
            due_at = datetime.fromisoformat(due_at_str)
            # Ensure due_at has timezone info for comparison
            if due_at.tzinfo is None:
                due_at = due_at.replace(tzinfo=now.tzinfo)

            if due_at <= now:
                # Mark as announced in storage (updates status & announced_at)
                updated = storage.mark_reminder_announced(r["id"], file_path=path)
                if updated:
                    announced.append(updated)
                    # Broadcast notification to all connected clients
                    await manager.broadcast({
                        "event": "reminder_announced",
                        "message": f"Reminder: {updated.get('task')}",
                        "reminder": updated,
                    })
                    logger.info(f"Announced reminder {updated.get('id')}: {updated.get('task')}")
        except Exception as exc:
            logger.error(f"Error checking reminder {r.get('id')}: {exc}")

    return announced


class ReminderScheduler:
    """Async scheduler service that runs in the background while the application is active."""

    def __init__(self, interval_seconds: int = DEFAULT_INTERVAL_SECONDS) -> None:
        self.interval_seconds = interval_seconds
        self._task: Optional[asyncio.Task] = None
        self._running = False

    async def _loop(self) -> None:
        logger.info(f"Background reminder scheduler started (checking every {self.interval_seconds}s)")
        while self._running:
            try:
                await check_due_reminders()
            except Exception as exc:
                logger.error(f"Unexpected error in scheduler loop: {exc}")

            try:
                await asyncio.sleep(self.interval_seconds)
            except asyncio.CancelledError:
                break

    def start(self) -> None:
        if not self._running:
            self._running = True
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._running:
            self._running = False
            if self._task:
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass
            logger.info("Background reminder scheduler stopped")


# Shared scheduler instance
scheduler = ReminderScheduler()
