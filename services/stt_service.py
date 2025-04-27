import logging
import config # Import config variables
from config import state # Import shared state

# Attempt to import faster_whisper
try:
    from faster_whisper import WhisperModel
    _faster_whisper_available = True
except ImportError:
    _faster_whisper_available = False
    WhisperModel = None # Define as None if import fails

def load_whisper_model():
    """Loads the Faster Whisper model based on config."""
    if not _faster_whisper_available:
        logging.warning("Faster Whisper library not found. Voice input will be disabled. Install with: pip install faster-whisper")
        state["stt_loaded"] = False
        state["stt_model"] = None
        return

    if state["stt_loaded"]:
        logging.info("Faster Whisper model already loaded.")
        return

    try:
        logging.info(f"Attempting to load Faster Whisper model '{config.WHISPER_MODEL_NAME}' on device '{config.WHISPER_DEVICE}' with compute type '{config.WHISPER_COMPUTE_TYPE}'...")
        model = WhisperModel(config.WHISPER_MODEL_NAME,
                             device=config.WHISPER_DEVICE,
                             compute_type=config.WHISPER_COMPUTE_TYPE)
        state["stt_model"] = model
        state["stt_loaded"] = True
        logging.info("Faster Whisper model loaded successfully.")
    except Exception as e:
        logging.error(f"Error loading Faster Whisper model: {e}. Voice input disabled.", exc_info=True)
        state["stt_loaded"] = False
        state["stt_model"] = None

def transcribe_audio(audio_path, language_code=None):
    """Transcribes audio file using the loaded Whisper model."""
    if not state["stt_loaded"] or state["stt_model"] is None:
        raise RuntimeError("STT model is not loaded.")

    try:
        logging.info(f"Transcribing {audio_path} with language hint: {language_code}")
        # beam_size=5 is a common default for good balance
        segments, info = state["stt_model"].transcribe(audio_path, beam_size=5, language=language_code)

        transcript = "".join([segment.text for segment in segments]).strip()
        detected_language = info.language
        lang_prob = info.language_probability
        logging.info(f"STT Result: Detected language '{detected_language}' with probability {lang_prob:.2f}")
        logging.info(f"STT Transcript: '{transcript}'")

        return transcript, detected_language, lang_prob

    except Exception as e:
        logging.error(f"Error during audio transcription: {e}", exc_info=True)
        raise # Re-raise the exception to be handled by the caller