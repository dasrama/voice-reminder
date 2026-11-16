# Voice Notes Reminder Agent

A lightweight, speech-driven reminder agent built with **Python 3.10+**, **FastAPI**, **Uvicorn**, and **Pydantic**. Reminders are stored in a local, corruption-resistant JSON file (`data/reminders.json`) with an asynchronous background scheduler and WebSocket real-time announcements. No external LLMs, no databases, no cloud dependencies, and no paid APIs are required.

---

## Features

- **Local Offline Whisper AI**: Powered by `faster-whisper` (`tiny.en`) running 100% locally on CPU. No external cloud STT services or network transmissions.
- **Universal Browser Support**: Uses standard HTML5 `MediaRecorder` and `Web Audio API` with live real-time VU meter level feedback. Works across Chrome, Firefox, Safari, Edge, and mobile browsers.
- **Rule-Based Natural Language Voice Parser**: Uses regex and date/time calculation to parse natural reminder intents and relative/absolute time expressions (e.g., *"tomorrow at 9 AM"*, *"in 10 minutes"*, *"tonight"*, *"today at 6 PM"*, *"in 2 hours"*).
- **Safe, Atomic JSON Storage**: Uses atomic file replacement (`os.replace`) and concurrency locks to prevent corrupted data, and validates JSON integrity before updates.
- **RESTful API & Pydantic Validation**: Full CRUD endpoints for managing reminders and parsing voice command transcripts.
- **Background Scheduler**: Regularly monitors pending reminders, marks past-due reminders as announced, and sends announcements across connected WebSocket clients.
- **Real-Time WebSocket Updates**: Broadcasts live event notifications (`reminder_added`, `reminder_updated`, `reminder_deleted`, `reminder_announced`) to all connected browser tabs.
- **Zero External Dependencies**: Operates 100% locally with zero cloud or LLM costs.

---

## Folder Structure

```text
voice-reminder/
├── app.py                  # FastAPI application, routes, and lifespan manager
├── transcriber.py          # Local offline faster-whisper transcription engine
├── reminder_parser.py      # Regex and datetime command parser
├── storage.py              # Thread-safe atomic JSON file storage
├── scheduler.py            # Background scheduler and WebSocket connection manager
├── schemas.py              # Pydantic models for validation and typing
├── requirements.txt        # Python package dependencies
├── .env.example            # Environment variable template
├── pytest.ini              # Pytest configuration
├── data/
│   └── reminders.json      # Local JSON data store
├── templates/
│   └── index.html          # Jinja2 HTML template placeholder (to be supplied)
├── static/
│   ├── style.css           # CSS styling placeholder (to be supplied)
│   └── app.js              # Vanilla JavaScript placeholder (to be supplied)
└── tests/
    ├── test_parser.py      # Unit tests for voice command parsing
    ├── test_storage.py     # Unit tests for JSON storage CRUD and atomic writes
    └── test_api.py         # Integration tests for FastAPI endpoints
```

---

## Installation

### 1. Prerequisites
- Python 3.10 or higher.
- A modern web browser supporting the Web Speech API (Google Chrome, Microsoft Edge, Brave, or Safari).

### 2. Set Up Virtual Environment

```bash
# Create virtual environment
python3 -m venv .venv

# Activate virtual environment
# On macOS/Linux:
source .venv/bin/activate
# On Windows:
# .venv\Scripts\activate
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

### 4. Configuration (Optional)

Copy the sample environment file if you wish to adjust the port, host, or check interval:

```bash
cp .env.example .env
```

Default settings in `.env.example`:
- `APP_HOST=127.0.0.1`
- `APP_PORT=8000`
- `REMINDERS_FILE=data/reminders.json`
- `SCHEDULER_INTERVAL_SECONDS=30`

---

## How to Run the App

Start the development server with live reload:

```bash
uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

- **Web App**: Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser.
- **Interactive Swagger Documentation**: Open [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).
- **ReDoc Documentation**: Open [http://127.0.0.1:8000/redoc](http://127.0.0.1:8000/redoc).

---

## Example Voice Commands

The parser supports common speech commands without requiring exact syntax:

| Intent | Example Voice Command | What Happens |
| :--- | :--- | :--- |
| **Add Reminder** | *"Remind me to water the plants tomorrow at 9 AM."* | Creates a reminder due tomorrow at 09:00 AM. |
| **Add Reminder** | *"Remind me to submit the assignment today at 6 PM."* | Creates a reminder due today at 06:00 PM. |
| **Add Reminder** | *"Remind me to call Mom tonight."* | Creates a reminder due tonight at 08:00 PM. |
| **Add Reminder** | *"Remind me to take a break in 10 minutes."* | Sets reminder due 10 minutes from now. |
| **Add Reminder** | *"Remind me to attend class in 2 hours."* | Sets reminder due 2 hours from now. |
| **Missing Time** | *"Remind me to buy groceries"* | Responds asking the user to specify a time. |
| **List Reminders** | *"What are my reminders?"* | Lists all scheduled reminders. |
| **List Pending** | *"What are my pending reminders?"* | Lists all reminders with status `pending`. |
| **Delete Last** | *"Delete my last reminder."* | Removes the most recently created reminder. |
| **Delete by ID** | *"Delete reminder with ID 123."* | Deletes the matching reminder by ID/prefix. |

---

## API Endpoints

### 1. `GET /`
- **Description**: Returns the main HTML interface.
- **Response**: `200 OK` (`text/html`).

### 2. `POST /api/voice-command`
- **Description**: Uploads raw audio recording (WebM, WAV, MP4, etc.), transcribes via local Whisper AI, and processes the command.
- **Request**: `multipart/form-data` with `file: <audio_file>`.
- **Response**: `CommandResponse` JSON with `transcript`, `reply`, `intent`, `reminder`.

### 3. `POST /api/transcribe`
- **Description**: Transcribes an uploaded audio file using local Whisper and returns the text transcript.
- **Request**: `multipart/form-data` with `file: <audio_file>`.
- **Response**: `{"transcript": "..."}`.

### 4. `POST /api/command`
- **Description**: Submits a speech transcript string to the NLP parser and executes the corresponding action.
- **Request Body**:
  ```json
  {
    "transcript": "Remind me to take a break in 10 minutes."
  }
  ```
- **Response (`200 OK` on success, `400 Bad Request` if invalid/missing time, `404` if target reminder missing)**:
  ```json
  {
    "intent": "add_reminder",
    "task": "take a break",
    "due_at": "2026-11-13T23:20:00+05:30",
    "reply": "I have set a reminder to take a break today at 11:20 PM.",
    "success": true,
    "reminder": {
      "id": "e42ad3c5-9279-4d6d-9226-6816cf4b47eb",
      "task": "take a break",
      "due_at": "2026-11-13T23:20:00+05:30",
      "status": "pending",
      "created_at": "2026-11-13T23:10:00+05:30",
      "announced_at": null,
      "raw_transcript": "Remind me to take a break in 10 minutes.",
      "source": "voice"
    },
    "reminders": null
  }
  ```

### 3. `GET /api/reminders`
- **Description**: Returns all stored reminders sorted chronologically by `due_at`.
- **Response**: `200 OK` with array of `Reminder` objects.

### 4. `GET /api/reminders/pending`
- **Description**: Returns all reminders whose status is currently `"pending"`.
- **Response**: `200 OK` with array of pending `Reminder` objects.

### 5. `PATCH /api/reminders/{reminder_id}`
- **Description**: Updates the status of a reminder.
- **Request Body**:
  ```json
  {
    "status": "completed"
  }
  ```
- **Response**: `200 OK` with updated reminder, or `404 Not Found`.

### 6. `DELETE /api/reminders/{reminder_id}`
- **Description**: Deletes a reminder by ID.
- **Response**: `200 OK` with deleted reminder data, or `404 Not Found`.

### 7. `WebSocket /ws`
- **Description**: Real-time push channel.
- **Emitted Events**:
  - `reminder_added`
  - `reminder_updated`
  - `reminder_deleted`
  - `reminder_announced`

---

## Reminder Data Schema

Reminders in `data/reminders.json` follow this JSON structure:

```json
{
  "id": "c1f73b64-8977-4bf2-a39c-5d15a97305ea",
  "task": "water the plants",
  "due_at": "2026-11-14T09:00:00+05:30",
  "status": "pending",
  "created_at": "2026-11-13T18:20:00+05:30",
  "announced_at": null,
  "raw_transcript": "remind me to water the plants tomorrow at 9 AM",
  "source": "voice"
}
```

---

## Running Unit Tests

To run the automated test suite covering the regex parser, atomic file storage, and API routes:

```bash
pytest -v
```

---

## Live Microphone Demo Instructions

When integrating the frontend with browser speech APIs:

1. **Browser Requirements**:
   - Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) is supported natively in **Google Chrome**, **Microsoft Edge**, **Brave**, and **Safari**.
   - Ensure the site is accessed via `http://localhost:8000` or `http://127.0.0.1:8000` (browsers permit microphone access on `localhost` without HTTPS).
2. **Microphone Permissions**:
   - The first time the user clicks "Start Listening", the browser prompts for microphone permission.
   - Click **Allow**.
3. **Voice Interaction Cycle**:
   - User speaks: *"Remind me to take a break in 10 minutes."*
   - Browser `SpeechRecognition` captures speech and passes transcript to `POST /api/command`.
   - Backend parses task and calculates ISO timestamp, saves to `data/reminders.json`, and returns confirmation message.
   - Frontend reads `response.reply` and speaks it aloud using `window.speechSynthesis.speak()`.
   - When 10 minutes elapse, the backend scheduler broadcasts `reminder_announced` over WebSocket `/ws`, prompting the frontend to chime or speak the announcement.

---

## Troubleshooting

- **Microphone Not Working / "not-allowed" error**:
  - Check browser permissions for `http://127.0.0.1:8000` in browser site settings and make sure microphone is allowed.
  - Verify your system settings allow your browser to access the microphone.
- **Port 8000 already in use**:
  - Start on a different port: `uvicorn app:app --port 8080 --reload`.
- **Corrupted `data/reminders.json`**:
  - If manually edited with invalid JSON, the server will safely reject corrupt modifications. Either fix the JSON syntax or reset the file to `[]`.
