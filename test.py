import torch
import os
import shutil
import logging
from TTS.api import TTS
from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import XttsAudioConfig, XttsArgs
from TTS.config.shared_configs import BaseDatasetConfig

# Configure logging
logging.basicConfig(level=logging.DEBUG)

# Allowlist for XTTS
torch.serialization.add_safe_globals([XttsConfig, XttsAudioConfig, BaseDatasetConfig, XttsArgs])

def setup_speaker_file(model_name):
    """Moves speakers_xtts.pth to the cache directory if it exists in services."""
    cache_dir = os.path.join(os.path.expanduser("~"), ".local", "share", "tts", model_name.replace("/", "--"))
    speaker_file = os.path.join(cache_dir, "speakers_xtts.pth")
    services_speaker_file = os.path.join("services", "speakers_xtts.pth")

    # Create cache directory if it doesn't exist
    os.makedirs(cache_dir, exist_ok=True)

    # Move speakers_xtts.pth from services to cache if it exists
    if os.path.exists(services_speaker_file):
        try:
            shutil.move(services_speaker_file, speaker_file)
            logging.info(f"Moved {services_speaker_file} to {speaker_file}")
        except Exception as e:
            logging.error(f"Error moving {services_speaker_file} to {speaker_file}: {e}", exc_info=True)
            return False
    else:
        logging.warning(f"Speaker file {services_speaker_file} not found in services folder.")

    # Verify speaker file in cache
    if os.path.exists(speaker_file):
        logging.info(f"Speaker file {speaker_file} found in cache.")
        return True
    else:
        logging.error(f"Speaker file {speaker_file} not found in cache after move attempt.")
        return False

def get_speakers(model_name):
    """Retrieves speaker list for the given TTS model."""
    # Setup speaker file
    if not setup_speaker_file(model_name):
        logging.warning("Proceeding without speakers_xtts.pth; attempting to use synthesizer.")

    # Initialize TTS
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        tts = TTS(model_name=model_name, progress_bar=True).to(device)
        logging.info(f"TTS model {model_name} loaded on {device}")
    except Exception as e:
        logging.error(f"Error loading TTS model {model_name}: {e}", exc_info=True)
        return [], None

    speakers = []
    speaker_source = "Unknown"
    try:
        # Primary method: synthesizer.tts_model.speaker_manager.speaker_names
        if (hasattr(tts, 'synthesizer') and hasattr(tts.synthesizer, 'tts_model') and
            hasattr(tts.synthesizer.tts_model, 'speaker_manager') and
            hasattr(tts.synthesizer.tts_model.speaker_manager, 'speaker_names')):
            data = tts.synthesizer.tts_model.speaker_manager.speaker_names
            speakers = list(data.keys()) if isinstance(data, dict) else list(data) if isinstance(data, list) else []
            speaker_source = "synthesizer.tts_model.speaker_manager.speaker_names"
        # Fallback: Load speakers_xtts.pth
        else:
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

        if speakers:
            logging.info(f"Found {len(speakers)} speakers via: {speaker_source}")
        else:
            logging.warning(f"No speakers found for {model_name} (source: {speaker_source}).")
            if hasattr(tts, 'synthesizer'):
                logging.debug(f"Synthesizer attributes: {dir(tts.synthesizer)}")
                if hasattr(tts.synthesizer, 'tts_model'):
                    logging.debug(f"Synthesizer.tts_model attributes: {dir(tts.synthesizer.tts_model)}")
                    if hasattr(tts.synthesizer.tts_model, 'speaker_manager'):
                        logging.debug(f"Synthesizer.tts_model.speaker_manager attributes: {dir(tts.synthesizer.tts_model.speaker_manager)}")

        return speakers, tts

    except Exception as e:
        logging.error(f"Error retrieving speakers for {model_name}: {e}", exc_info=True)
        return [], None

def select_and_synthesize(model_name, text="Hello world!", language="en"):
    """Prompts user to select a speaker and synthesizes speech."""
    speakers, tts = get_speakers(model_name)
    if not speakers or tts is None:
        print("No speakers available. Exiting.")
        return

    print(f"Available speakers for {model_name} ({len(speakers)}):")
    for i, speaker in enumerate(speakers, 1):
        print(f"{i}. {speaker}")

    while True:
        try:
            choice = input("Enter the number of the speaker to use (or 'q' to quit): ")
            if choice.lower() == 'q':
                print("Exiting.")
                return
            choice = int(choice)
            if 1 <= choice <= len(speakers):
                selected_speaker = speakers[choice - 1]
                print(f"Selected speaker: {selected_speaker}")
                break
            else:
                print(f"Please enter a number between 1 and {len(speakers)}.")
        except ValueError:
            print("Invalid input. Please enter a number or 'q'.")

    # Synthesize speech with selected speaker
    try:
        output_file = "output.wav"
        tts.tts_to_file(
            text=text,
            speaker=selected_speaker,
            language=language,
            file_path=output_file,
            split_sentences=True
        )
        print(f"Speech synthesized to {output_file}")
    except Exception as e:
        logging.error(f"Error synthesizing speech with speaker {selected_speaker}: {e}", exc_info=True)
        print(f"Error synthesizing speech: {e}")

if __name__ == "__main__":
    model_name = "tts_models/multilingual/multi-dataset/xtts_v2"
    select_and_synthesize(model_name)