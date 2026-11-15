"""Local offline Speech-to-Text module using faster-whisper.

Runs 100% locally on CPU without external cloud APIs or accounts.
"""

from __future__ import annotations
import os
import tempfile
import logging
from typing import Optional

# Compatibility patch for PyAV 19+ with faster-whisper (metadata_errors argument removed in av 15+)
try:
    import av
    _orig_av_open = av.open
    def _safe_av_open(*args, **kwargs):
        kwargs.pop("metadata_errors", None)
        return _orig_av_open(*args, **kwargs)
    av.open = _safe_av_open
except Exception:
    pass

from faster_whisper import WhisperModel

logger = logging.getLogger("transcriber")

_model: Optional[WhisperModel] = None

# Default to tiny.en for fast CPU inference (~39MB model, <0.5s inference)
DEFAULT_MODEL_SIZE = os.getenv("WHISPER_MODEL", "tiny.en")


def get_whisper_model() -> WhisperModel:
    """Lazy-load the Whisper model singleton."""
    global _model
    if _model is None:
        logger.info(f"Loading local Whisper model: {DEFAULT_MODEL_SIZE}")
        _model = WhisperModel(
            DEFAULT_MODEL_SIZE,
            device="cpu",
            compute_type="int8",
            download_root=os.getenv("WHISPER_CACHE_DIR", None),
        )
        logger.info("Local Whisper model loaded successfully.")
    return _model


def transcribe_audio_file(file_path: str) -> str:
    """Transcribe an audio file path into text using local Whisper."""
    model = get_whisper_model()
    segments, _ = model.transcribe(
        file_path,
        beam_size=1,
        language="en",
        vad_filter=True,  # filters out leading/trailing silence
    )
    text = " ".join([seg.text.strip() for seg in segments if seg.text.strip()]).strip()
    return text


def transcribe_audio_bytes(data: bytes, extension: str = ".webm") -> str:
    """Save audio bytes to a temp file and transcribe them."""
    if not extension.startswith("."):
        extension = f".{extension}"

    with tempfile.NamedTemporaryFile(suffix=extension, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        return transcribe_audio_file(tmp_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
