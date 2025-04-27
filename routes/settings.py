from flask import Blueprint, request, jsonify
import logging
import json
import config # Import config module directly

settings_bp = Blueprint('settings', __name__, url_prefix='/api')

# This route modifies variables directly within the imported config module.
# Be aware this might not be ideal in complex scenarios, but works for this structure.
@settings_bp.route('/update-endpoints', methods=['POST'])
def update_endpoints():
    """Updates API endpoints and keys dynamically."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'Invalid JSON payload'}), 400

        updated_keys = []
        # Update config module attributes directly
        if 'ollama' in data: config.OLLAMA_API = data['ollama']; updated_keys.append('ollama')
        if 'kobold' in data: config.KOBOLD_API = data['kobold']; updated_keys.append('kobold')
        if 'comfyui' in data: config.COMFYUI_API_BASE = data['comfyui']; updated_keys.append('comfyui')
        if 'groqApiKey' in data: config.GROQ_API_KEY = data['groqApiKey']; updated_keys.append('groqApiKey')
        if 'openaiApiKey' in data: config.OPENAI_API_KEY = data['openaiApiKey']; updated_keys.append('openaiApiKey')
        if 'anthropicApiKey' in data: config.ANTHROPIC_API_KEY = data['anthropicApiKey']; updated_keys.append('anthropicApiKey')
        if 'googleApiKey' in data: config.GOOGLE_API_KEY = data['googleApiKey']; updated_keys.append('googleApiKey')
        if 'xaiApiKey' in data: config.XAI_API_KEY = data['xaiApiKey']; updated_keys.append('xaiApiKey')
        if 'customModelName' in data: config.CUSTOM_API_MODEL_NAME = data['customModelName']; updated_keys.append('customModelName')
        if 'customApiEndpoint' in data: config.CUSTOM_API_ENDPOINT = data['customApiEndpoint']; updated_keys.append('customApiEndpoint')
        if 'customApiKey' in data: config.CUSTOM_API_KEY = data['customApiKey']; updated_keys.append('customApiKey')

        if updated_keys:
            logging.info(f"Backend API settings updated for keys: {', '.join(updated_keys)}")
            # Log current config (optional)
            logged_config = {k: (v if 'key' not in k.lower() else bool(v)) for k, v in vars(config).items() if k.isupper()}
            logging.debug(f"Current config state (masked keys): {json.dumps(logged_config)}")
            return jsonify({'status': 'success', 'message': f'Backend API setting(s) updated.'})
        else:
            logging.warning(f"Received update-endpoints request with no valid keys: {data}")
            return jsonify({'status': 'error', 'message': 'No valid endpoint keys provided.'}), 400
    except Exception as e:
        logging.exception("Error updating backend API endpoints:")
        return jsonify({'status': 'error', 'message': f'Failed to update: {str(e)}'}), 500