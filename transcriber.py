
import os
import tempfile

from faster_whisper import WhisperModel

_model = None

MODEL_SIZE = os.getenv("WHISPER_MODEL", "base.en")


def get_whisper_model():
    global _model

    if _model is None:
        _model = WhisperModel(
            MODEL_SIZE,
            device="cpu",
            compute_type="int8",
            download_root=os.getenv("WHISPER_CACHE_DIR")
        )

    return _model


def transcribe_audio_file(file_path: str) -> str:
    segments, _ = get_whisper_model().transcribe(
        file_path,
        language="en",
        beam_size=5,
        vad_filter=True
    )

    return " ".join(segment.text.strip() for segment in segments).strip()


def transcribe_audio_bytes(data: bytes, extension: str = ".webm") -> str:
    with tempfile.NamedTemporaryFile(suffix=extension, delete=False) as tmp:
        tmp.write(data)
        path = tmp.name

    try:
        return transcribe_audio_file(path)
    finally:
        os.remove(path)
