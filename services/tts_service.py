# File: services/tts_service.py
import logging
import os
import gc
import pickle
import re
import torch
import numpy as np
import shutil # Keep import from user's version
from config import TTS_MODEL_NAME, TTS_USE_GPU, DEFAULT_TTS_MODELS_LIST
from config import state
from services.audio_utils import convert_tts_list_to_wav

# --- TTS Library Imports & Workarounds ---
try:
    from TTS.api import TTS
    from TTS.utils.manage import ModelManager
    try:
        from torch.serialization import add_safe_globals
    except ImportError:
        try:
            from torch import serialization
            if hasattr(serialization, 'add_safe_globals'):
                add_safe_globals = serialization.add_safe_globals
            else: add_safe_globals = None
        except ImportError: add_safe_globals = None
    if add_safe_globals is None:
        logging.warning("Could not find torch.serialization.add_safe_globals. XTTS workaround might fail.")
    _tts_lib_available = True
except ImportError:
    logging.error("Coqui TTS library not found. TTS features disabled. Install with: pip install TTS")
    TTS = None
    ModelManager = None
    add_safe_globals = None
    _tts_lib_available = False


def get_available_tts_models():
    """Gets available TTS models programmatically using TTS.utils.manage.ModelManager."""
    fetched_models = []
    final_models = []
    if not _tts_lib_available or not ModelManager:
        logging.warning("TTS library or ModelManager not available, returning default model list.")
        final_models = DEFAULT_TTS_MODELS_LIST # Use defaults
    else:
        try:
            logging.info("Fetching available TTS models programmatically via ModelManager...")
            manager = ModelManager()
            available_models_list = manager.list_tts_models()

            if isinstance(available_models_list, list):
                fetched_models = sorted(list(set([str(m) for m in available_models_list if isinstance(m, str)])))
                logging.info(f"ModelManager successfully fetched {len(fetched_models)} models.")
                combined_list = list(set(fetched_models + DEFAULT_TTS_MODELS_LIST))
                final_models = sorted(combined_list)
                logging.info(f"Final combined model list has {len(final_models)} unique models.")
            else:
                logging.error(f"ModelManager().list_tts_models() returned unexpected type: {type(available_models_list)}. Falling back to defaults.")
                final_models = DEFAULT_TTS_MODELS_LIST

        except Exception as e:
            logging.error(f"Error fetching TTS models via ModelManager: {e}", exc_info=True)
            final_models = DEFAULT_TTS_MODELS_LIST
            logging.warning("Using default TTS model list due to error during programmatic fetch.")

    logging.info(f"Final list of available TTS models being set in state ({len(final_models)}): {final_models}")
    state["available_tts_models"] = final_models
    return final_models

def load_tts_model(model_name_to_load=TTS_MODEL_NAME):
    """Loads the specified TTS model, unloading the previous one."""
    if not _tts_lib_available:
        logging.error("Cannot load TTS model: TTS library not available.")
        state["tts_loaded"] = False
        state["tts_model"] = None
        return False, "TTS library not found."

    if state["tts_loaded"] and state["tts_model"] and state["current_tts_model_name"] == model_name_to_load:
        logging.info(f"TTS model '{model_name_to_load}' is already loaded.")
        get_current_tts_speakers() # Ensure state['currentTTSSpeakers'] is up-to-date
        return True, "Model already loaded."

    if state["tts_model"]:
        logging.info(f"Unloading previous TTS model: {state['current_tts_model_name']}")
        try:
            tts_instance = state["tts_model"]
            state["tts_model"] = None
            state["tts_loaded"] = False
            state["current_tts_model_name"] = ""
            state["currentTTSSpeakers"] = [] # Clear speakers on unload
            del tts_instance
            gc.collect()
            if TTS_USE_GPU and hasattr(torch.cuda, 'empty_cache'):
                 torch.cuda.empty_cache()
            logging.info(f"Previous TTS model unloaded.")
        except Exception as e:
             logging.warning(f"Error during TTS model unload: {e}")
             state["tts_model"] = None
             state["tts_loaded"] = False
             state["current_tts_model_name"] = ""
             state["currentTTSSpeakers"] = []

    logging.info(f"Attempting to load Coqui TTS model '{model_name_to_load}' (GPU: {TTS_USE_GPU})...")
    try:
        if add_safe_globals is not None and "xtts" in model_name_to_load.lower():
            logging.warning(f"Applying PyTorch serialization workaround for XTTS model: {model_name_to_load}")
            classes_to_trust = []
            try:
                from TTS.tts.configs.xtts_config import XttsConfig
                from TTS.tts.models.xtts import XttsAudioConfig, XttsArgs
                from TTS.config.shared_configs import BaseDatasetConfig
                classes_to_trust = [XttsConfig, XttsAudioConfig, BaseDatasetConfig, XttsArgs]
            except ImportError as e_imp: logging.error(f"Could not import required XTTS config classes: {e_imp}.", exc_info=True)
            except Exception as e_other: logging.error(f"Unexpected error importing XTTS config classes: {e_other}", exc_info=True)

            if classes_to_trust:
                try:
                    add_safe_globals(classes_to_trust)
                    logging.info(f"Added {', '.join([cls.__name__ for cls in classes_to_trust])} to safe globals.")
                except Exception as e_safe: logging.error(f"Error applying serialization workaround: {e_safe}", exc_info=True)
            else: logging.warning("Could not add classes to safe globals because import failed.")

        # Load the model
        model = TTS(model_name=model_name_to_load, progress_bar=True, gpu=TTS_USE_GPU)
        state["tts_model"] = model
        state["tts_loaded"] = True
        state["current_tts_model_name"] = model_name_to_load
        get_current_tts_speakers() # This updates state['currentTTSSpeakers']
        logging.info(f"Coqui TTS model '{model_name_to_load}' loaded successfully. Speakers retrieved.")
        return True, f"Model '{model_name_to_load}' loaded."

    except pickle.UnpicklingError as e_pickle:
         error_str = str(e_pickle)
         if "weights_only" in error_str and "Unsupported global" in error_str:
             global_path_match = re.search(r"GLOBAL\s+([\w\.]+)\s+was", error_str)
             failed_class = global_path_match.group(1) if global_path_match else "[unknown class]"
             msg = (f"Model load failed for '{model_name_to_load}' (PyTorch weights_only issue). "
                    f"Untrusted class: {failed_class}. See server logs.")
             logging.error(msg + f" Original error: {error_str}")
             state["tts_loaded"] = False; state["tts_model"] = None; state["currentTTSSpeakers"] = []
             return False, msg
         else:
             logging.error(f"Unpickling error loading TTS model '{model_name_to_load}': {e_pickle}", exc_info=True)
             state["tts_loaded"] = False; state["tts_model"] = None; state["currentTTSSpeakers"] = []
             return False, f"Error loading model (pickle error): {e_pickle}"
    except Exception as e:
        logging.error(f"General error loading TTS model '{model_name_to_load}': {e}", exc_info=True)
        state["tts_loaded"] = False; state["tts_model"] = None; state["currentTTSSpeakers"] = []
        return False, f"Error loading model '{model_name_to_load}': {str(e)}"

def get_current_tts_speakers():
    """Gets the speaker list from the currently loaded TTS model and updates state."""
    if not state.get("tts_loaded") or not state.get("tts_model"):
        logging.warning("get_current_tts_speakers called but TTS model not loaded.")
        if "currentTTSSpeakers" not in state or state["currentTTSSpeakers"]:
            state["currentTTSSpeakers"] = []
        return []

    speakers = []
    model = state["tts_model"]
    model_name = state.get("current_tts_model_name", "[Unknown Model]")
    logging.info(f"Attempting speaker retrieval for model: {model_name}")

    try:
        speaker_source = "Unknown"
        # Check and move speakers_xtts.pth if in services folder
        # Keep the user's logic for file moving, although standard retrieval should work
        if "xtts" in model_name.lower():
            cache_dir = os.path.join(os.path.expanduser("~"), ".local", "share", "tts", model_name.replace("/", "--"))
            speaker_file = os.path.join(cache_dir, "speakers_xtts.pth")
            services_speaker_file = os.path.join("services", "speakers_xtts.pth")
            os.makedirs(cache_dir, exist_ok=True)
            if os.path.exists(services_speaker_file):
                try:
                    # Make sure shutil is imported if this block is kept
                    import shutil
                    shutil.move(services_speaker_file, speaker_file)
                    logging.info(f"Moved {services_speaker_file} to {speaker_file}")
                except NameError:
                     logging.error("shutil module not imported, cannot move speaker file.")
                except Exception as e:
                    logging.error(f"Error moving {services_speaker_file}: {e}")

        # Use the user's primary method first, as they added it specifically
        if (hasattr(model, 'synthesizer') and hasattr(model.synthesizer, 'tts_model') and
            hasattr(model.synthesizer.tts_model, 'speaker_manager') and
            hasattr(model.synthesizer.tts_model.speaker_manager, 'speaker_names')):
            data = model.synthesizer.tts_model.speaker_manager.speaker_names
            speakers = list(data.keys()) if isinstance(data, dict) else list(data) if isinstance(data, list) else []
            speaker_source = "synthesizer.tts_model.speaker_manager.speaker_names"
        # Fallback: Load speakers_xtts.pth (Keep user's logic)
        elif "xtts" in model_name.lower():
            cache_dir = os.path.join(os.path.expanduser("~"), ".local", "share", "tts", model_name.replace("/", "--"))
            speaker_file = os.path.join(cache_dir, "speakers_xtts.pth")
            if os.path.exists(speaker_file):
                try:
                    speaker_data = torch.load(speaker_file)
                    speakers = list(speaker_data.keys())
                    speaker_source = "speakers_xtts.pth"
                except Exception as e:
                    logging.warning(f"Failed to load speakers_xtts.pth: {e}")
            else:
                logging.warning(f"Speaker file {speaker_file} not found")
        # Standard attributes (as further fallbacks)
        elif hasattr(model, 'speaker_manager') and hasattr(model.speaker_manager, 'speaker_ids') and model.speaker_manager.speaker_ids:
            speakers = list(model.speaker_manager.speaker_ids)
            speaker_source = "speaker_manager.speaker_ids"
        elif hasattr(model, 'speakers') and model.speakers:
            speakers = list(model.speakers)
            speaker_source = "model.speakers"
        elif hasattr(model, 'config'): # Check config last
            cfg = model.config
            if hasattr(cfg, 'speakers') and cfg.speakers:
                 data = cfg.speakers
                 speakers = list(data.keys()) if isinstance(data, dict) else list(data) if isinstance(data, list) else []
                 speaker_source = "model.config.speakers"
            elif hasattr(cfg, 'speaker_ids') and cfg.speaker_ids:
                 data = cfg.speaker_ids
                 speakers = list(data.keys()) if isinstance(data, dict) else list(data) if isinstance(data, list) else []
                 speaker_source = "model.config.speaker_ids"

        if speakers:
            logging.info(f"Found speakers via: {speaker_source}")
        elif hasattr(model, 'is_multi_speaker') and model.is_multi_speaker:
            logging.warning(f"Multi-speaker model '{model_name}' loaded, but couldn't retrieve speaker list via known attributes (source: {speaker_source}).")
            # Keep the detailed debug logging for future issues
            logging.debug(f"--- Debug Info for {model_name} Speaker Retrieval ---")
            logging.debug(f"Model Object Type: {type(model)}")
            logging.debug(f"Model Attributes: {dir(model)}")
            if hasattr(model, 'synthesizer'):
                logging.debug(f"Available attributes on synthesizer: {dir(model.synthesizer)}")
                if hasattr(model.synthesizer, 'tts_model'):
                    logging.debug(f"Available attributes on synthesizer.tts_model: {dir(model.synthesizer.tts_model)}")
                    if hasattr(model.synthesizer.tts_model, 'speaker_manager'):
                        logging.debug(f"Available attributes on synthesizer.tts_model.speaker_manager: {dir(model.synthesizer.tts_model.speaker_manager)}")
            if hasattr(model, 'speaker_manager'):
                logging.debug(f"Speaker Manager Object Type: {type(model.speaker_manager)}")
                logging.debug(f"Speaker Manager Attributes: {dir(model.speaker_manager)}")
                logging.debug(f"Speaker Manager speaker_ids value: {getattr(model.speaker_manager, 'speaker_ids', 'N/A')}")
            else: logging.debug("Model has NO 'speaker_manager' attribute.")
            if hasattr(model, 'config'):
                logging.debug(f"Config Object Type: {type(model.config)}")
                logging.debug(f"Config Attributes: {dir(model.config)}")
                logging.debug(f"Config speakers value: {getattr(model.config, 'speakers', 'N/A')}")
                logging.debug(f"Config speaker_ids value: {getattr(model.config, 'speaker_ids', 'N/A')}")
            else: logging.debug("Model has NO 'config' attribute.")
            logging.debug("--- End Debug Info ---")


        speakers = [str(s) for s in speakers if s is not None]
        logging.info(f"Final speaker list ({len(speakers)}) retrieved via '{speaker_source}' for model '{model_name}'. Updating state.")
        state["currentTTSSpeakers"] = speakers

    except Exception as e_spk:
        logging.warning(f"Exception during speaker retrieval for {model_name}: {e_spk}", exc_info=True)
        speakers = []
        state["currentTTSSpeakers"] = []

    return speakers


def synthesize_speech(text, speaker=None, speed=1.0):
    """Synthesizes speech using the loaded model."""
    if not state.get("tts_loaded") or not state.get("tts_model"):
        raise RuntimeError("TTS model not loaded or unavailable.")
    if not text:
        raise ValueError("No text provided for TTS.")

    model = state["tts_model"]
    model_name = state.get("current_tts_model_name", "[Unknown Model]")
    cleaned_text = re.sub(r'[*#`]', '', text).strip()

    if not cleaned_text:
        logging.warning("Text became empty after cleaning, skipping TTS.")
        return None

    MIN_TTS_TEXT_LENGTH = 3
    if len(cleaned_text) < MIN_TTS_TEXT_LENGTH:
        logging.warning(f"Cleaned text '{cleaned_text}' is shorter than minimum length ({MIN_TTS_TEXT_LENGTH}), skipping TTS.")
        return None

    # --- Prepare Base Args ---
    tts_args = {"text": cleaned_text, "speed": speed}

    # --- Language Argument Handling ---
    # Check if the model object indicates multilingual capability
    is_multi_lingual = getattr(model, 'is_multi_lingual', False)
    # *** Modification: Add language arg if model is multi-lingual ***
    if is_multi_lingual:
        lang_code = "en" # Default to English
        tts_args["language"] = lang_code
        logging.debug(f"Model '{model_name}' is multi-lingual. Added language='{lang_code}' to args.")
    # *** End Modification ***
    else:
        logging.debug(f"Model '{model_name}' is not multi-lingual. No language argument added.")

    # --- Speaker Argument Handling (uses refreshed available_speakers) ---
    is_multi_speaker = getattr(model, 'is_multi_speaker', False)
    selected_speaker = None
    available_speakers = state.get("currentTTSSpeakers", [])
    if is_multi_speaker and not available_speakers:
        logging.warning(f"State['currentTTSSpeakers'] empty for multi-speaker model '{model_name}'. Attempting direct retrieval.")
        available_speakers = get_current_tts_speakers() # Attempt refresh

    if is_multi_speaker:
        logging.debug(f"Multi-speaker model detected. Provided speaker arg: '{speaker}'. Available: {available_speakers}")
        if speaker and speaker != "default":
            selected_speaker = speaker
            if available_speakers and speaker not in available_speakers:
                 logging.warning(f"Requested speaker '{speaker}' not found in available list for model {model_name}. Attempting anyway.")
            logging.debug(f"Using explicitly selected speaker: {selected_speaker}")
        elif available_speakers:
            selected_speaker = available_speakers[0] # Use first available as default
            logging.debug(f"Using first available speaker as default: {selected_speaker}")
        else:
             logging.error(f"CRITICAL: Multi-speaker model '{model_name}' requires a speaker, but 'default' was requested and NO available speakers could be found. Cannot synthesize.")
             raise ValueError(f"Cannot determine a speaker for multi-speaker model '{model_name}'.")
        tts_args["speaker"] = selected_speaker
    else:
        if speaker and speaker != "default":
            logging.warning(f"Speaker '{speaker}' requested, but model '{model_name}' is single-speaker. Ignoring.")
        logging.debug("Single-speaker model detected. No speaker argument added.")
    # --- End Speaker Handling ---

    try:
        logging.debug(f"Calling model.tts() with final args: {tts_args}")
        tts_output = model.tts(**tts_args)

        # --- Output Processing ---
        wav_bytes = None
        if isinstance(tts_output, bytes):
            wav_bytes = tts_output
        elif isinstance(tts_output, list):
            logging.info("TTS returned list, attempting conversion.")
            samplerate = 22050
            try:
                if hasattr(model, 'synthesizer') and hasattr(model.synthesizer, 'output_sample_rate') and model.synthesizer.output_sample_rate:
                    samplerate = model.synthesizer.output_sample_rate
                elif hasattr(model, 'config') and hasattr(model.config, 'audio') and hasattr(model.config.audio, 'sample_rate') and model.config.audio.sample_rate:
                    samplerate = model.config.audio.sample_rate
                elif hasattr(model, 'config') and hasattr(model.config, 'sample_rate') and model.config.sample_rate:
                     samplerate = model.config.sample_rate
                logging.info(f"Using sample rate {samplerate} for list conversion.")
            except Exception:
                 logging.warning(f"Could not reliably determine sample rate, using default {samplerate}Hz.")
            wav_bytes = convert_tts_list_to_wav(tts_output, samplerate)
        else:
             raise TypeError(f"TTS model returned unexpected type: {type(tts_output)}")

        if wav_bytes:
            logging.info(f"TTS synthesis successful ({len(wav_bytes)} bytes).")
            return wav_bytes
        else:
            raise ValueError("TTS processing failed to produce audio bytes from list.")

    except ValueError as e:
         logging.error(f"ValueError during TTS synthesis call: {e}", exc_info=False) # Log specific error
         raise # Re-raise to be handled by caller
    except Exception as e:
        logging.error(f"Unexpected error during TTS synthesis call: {e}", exc_info=True)
        raise