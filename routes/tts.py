from flask import Blueprint, request, jsonify, send_from_directory
import logging
import os
import tempfile
from services.tts_service import get_available_tts_models, load_tts_model, synthesize_speech, get_current_tts_speakers
from config import state # Import shared state

tts_bp = Blueprint('tts', __name__, url_prefix='/api/tts')

@tts_bp.route('/models', methods=['GET'])
def get_tts_models_list():
    """Returns the list of available TTS models found at startup or fetched."""
    # Use the list stored in shared state, which is updated by get_available_tts_models
    return jsonify({'status': 'success', 'models': state.get("available_tts_models", [])})

@tts_bp.route('/set-model', methods=['POST'])
def set_tts_model_route():
    """Sets the active TTS model."""
    data = request.get_json()
    model_name = data.get('model_name')
    if not model_name:
        return jsonify({'status': 'error', 'message': 'model_name is required'}), 400

    logging.info(f"Request received to set TTS model to: {model_name}")
    success, message = load_tts_model(model_name) # Calls the service function

    if success:
        speakers = get_current_tts_speakers() # Get speakers from the newly loaded model
        return jsonify({
            'status': 'success', 'message': message,
            'loaded_model': state["current_tts_model_name"], # Return the actually loaded model name
            'speakers': speakers
        })
    else:
        # Return error, report the currently loaded model (which might be None or previous)
        return jsonify({
            'status': 'error', 'message': message,
            'loaded_model': state["current_tts_model_name"]
        }), 500

@tts_bp.route('/sample', methods=['POST'])
def tts_sample_voice():
    """Generates a sample audio for the currently loaded model/speaker."""
    data = request.get_json()
    speaker_id = data.get('speaker_id') if data else None

    sample_text = "Hello, How are you? I hope you are doing well."
    logging.info(f"Request received to sample TTS voice. Speaker ID: {speaker_id}")

    if not state["tts_loaded"] or not state["tts_model"]:
        return jsonify({'status': 'error', 'message': 'TTS model not loaded.'}), 503

    temp_wav_path = None
    try:
        # Use the synthesize_speech service function
        wav_bytes = synthesize_speech(sample_text, speaker=speaker_id, speed=1.0)

        if not wav_bytes:
            raise ValueError("TTS sample generation failed to produce audio bytes.")

        # Create a temporary file to send back
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_wav_file:
            temp_wav_path = temp_wav_file.name
            temp_wav_file.write(wav_bytes)
        logging.info(f"TTS sample generated successfully to {temp_wav_path}")

        response = send_from_directory(os.path.dirname(temp_wav_path),
                                       os.path.basename(temp_wav_path),
                                       mimetype='audio/wav',
                                       as_attachment=False)
        # Add headers to prevent caching
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    except Exception as e:
        logging.error(f"Error generating TTS sample: {e}", exc_info=True)
        return jsonify({'status': 'error', 'message': f'TTS sample generation failed: {str(e)}'}), 500
    finally:
        # Clean up the temporary file
        if temp_wav_path and os.path.exists(temp_wav_path):
            try:
                os.remove(temp_wav_path)
                logging.debug(f"Removed temporary TTS sample file: {temp_wav_path}")
            except OSError as e_rem:
                logging.error(f"Error removing temporary TTS sample file '{temp_wav_path}': {e_rem}")