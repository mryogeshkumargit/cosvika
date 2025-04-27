from flask import Blueprint, request, jsonify
import logging
import requests
from utils import make_request_with_retry
import config # Import config variables

models_bp = Blueprint('models', __name__, url_prefix='/api')

@models_bp.route('/models', methods=['GET'])
def get_ollama_models():
    """Fetches available models from Ollama."""
    try:
        logging.info("Fetching models from Ollama...")
        url = f"{config.OLLAMA_API}/api/tags"
        response_data = make_request_with_retry(url, "GET", timeout=10)

        if isinstance(response_data, dict):
            models = response_data.get('models', [])
            if isinstance(models, list):
                 model_names = [m['name'] for m in models if isinstance(m, dict) and 'name' in m]
                 logging.info(f"Found {len(model_names)} Ollama models.")
                 return jsonify({'status': 'success', 'models': model_names})
            else:
                 logging.warning("Ollama '/api/tags' response 'models' key was not a list.")
                 return jsonify({'status': 'error', 'message': "Ollama response format error."}), 500
        else:
             logging.error(f"Unexpected response type ({type(response_data)}) from Ollama {url}")
             return jsonify({'status': 'error', 'message': 'Internal error fetching Ollama models.'}), 500
    except requests.RequestException as e:
        logging.error(f"Error fetching Ollama models: {e}")
        return jsonify({'status': 'error', 'message': f'Failed to connect to Ollama: {str(e)}'}), 500
    except Exception as e:
        logging.exception("Unexpected error fetching Ollama models:")
        return jsonify({'status': 'error', 'message': f'Server error: {str(e)}'}), 500


@models_bp.route('/external-models', methods=['GET'])
def get_external_models():
    """Fetches model list from selected external provider."""
    backend = request.args.get('backend')
    if not backend:
        return jsonify({'status': 'error', 'message': 'Backend parameter is required'}), 400

    logging.info(f"Request received to fetch models for external backend: {backend}")

    api_endpoint = None
    api_key = None
    headers = {'Accept': 'application/json'}
    models = []
    error_message = None

    try:
        if backend == 'groq':
            api_endpoint = "https://api.groq.com/openai/v1/models"
            api_key = config.GROQ_API_KEY
            if not api_key: raise ValueError("Groq API Key not configured on backend")
            headers['Authorization'] = f'Bearer {api_key}'
            response = make_request_with_retry(api_endpoint, "GET", headers=headers)
            if isinstance(response, dict) and 'data' in response:
                models = [m.get('id') for m in response['data'] if m.get('id')]
            else: raise ValueError(f"Unexpected response format from Groq /models: {str(response)[:200]}")

        elif backend == 'openai':
            api_endpoint = "https://api.openai.com/v1/models"
            api_key = config.OPENAI_API_KEY
            if not api_key: raise ValueError("OpenAI API Key not configured on backend")
            headers['Authorization'] = f'Bearer {api_key}'
            response = make_request_with_retry(api_endpoint, "GET", headers=headers)
            if isinstance(response, dict) and 'data' in response:
                models = [m.get('id') for m in response['data'] if m.get('id')]
            else: raise ValueError(f"Unexpected response format from OpenAI /models: {str(response)[:200]}")

        elif backend == 'google':
            api_endpoint = "https://generativelanguage.googleapis.com/v1beta/models"
            api_key = config.GOOGLE_API_KEY
            if not api_key: raise ValueError("Google API Key not configured on backend")
            api_endpoint += f"?key={api_key}"
            response = make_request_with_retry(api_endpoint, "GET")
            if isinstance(response, dict) and 'models' in response:
                models = [m.get('name').replace("models/", "") for m in response['models']
                          if m.get('name') and 'generateContent' in m.get('supportedGenerationMethods', [])]
            else: raise ValueError(f"Unexpected response format from Google /models: {str(response)[:200]}")

        elif backend == 'anthropic':
            logging.warning("Anthropic does not have a standard /models endpoint. Returning empty list.")
            models = []

        elif backend == 'xai':
            logging.warning("Attempting to fetch xAI models assuming OpenAI format.")
            try:
                api_endpoint = "https://api.x.ai/v1/models"
                api_key = config.XAI_API_KEY
                if not api_key: raise ValueError("xAI API Key not configured on backend")
                headers['Authorization'] = f'Bearer {api_key}'
                response = make_request_with_retry(api_endpoint, "GET", headers=headers)
                if isinstance(response, dict) and 'data' in response:
                    models = [m.get('id') for m in response['data'] if m.get('id')]
                else: raise ValueError(f"Unexpected response format from xAI /models: {str(response)[:200]}")
            except Exception as e_xai:
                 logging.error(f"Failed to fetch models for xAI: {e_xai}")
                 error_message = f"Could not fetch models for xAI. Error: {e_xai}"
                 models = [] # Fallback on error

        elif backend in ['kobold', 'ollama', 'custom_external']:
             logging.info(f"Backend {backend} does not support dynamic model fetching via this endpoint.")
             return jsonify({'status': 'success', 'models': []})

        else:
            return jsonify({'status': 'error', 'message': f'Unsupported backend: {backend}'}), 400

        models = sorted([str(m) for m in models if m])
        logging.info(f"Successfully fetched {len(models)} models for backend {backend}.")
        return jsonify({'status': 'success', 'models': models})

    except ValueError as ve:
        error_message = str(ve)
        logging.error(f"Configuration error fetching models for {backend}: {error_message}")
        return jsonify({'status': 'error', 'message': error_message}), 400
    except requests.RequestException as e:
        error_message = f"Failed to connect to {backend} API. Check endpoint/key. Error: {e}"
        logging.error(f"API request failed fetching models for {backend}: {e}", exc_info=True)
        return jsonify({'status': 'error', 'message': error_message}), 502
    except Exception as e:
        logging.exception(f"Unexpected error fetching models for {backend}:")
        error_message = error_message or f"An unexpected error occurred: {e}"
        return jsonify({'status': 'error', 'message': error_message}), 500