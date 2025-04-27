from flask import Blueprint, request, jsonify, Response
import logging
import json
import uuid
from utils import make_request_with_retry
from services.llm_backends import call_llm_backend
from services.history_manager import get_chat_list as get_chat_list_from_history, \
                                     load_chat_data, save_chat_data, delete_chat_file
from config import state # Import shared state
import config # Import full config for API endpoints etc.

chat_bp = Blueprint('chat', __name__, url_prefix='/api')

@chat_bp.route('/generate', methods=['POST'])
def generate_text():
    """Generates text using the selected backend."""
    client_id_header = request.headers.get('X-Client-ID')
    client_id = client_id_header or str(uuid.uuid4())

    try:
        data = request.get_json()
        if not data: return jsonify({'status': 'error', 'message': 'Invalid JSON payload'}), 400

        prompt = data.get('prompt')
        backend = data.get('backend', 'ollama')
        model = data.get('model')
        history_context = data.get('history', []) # Newest first
        stream = request.args.get('stream', 'false').lower() == 'true' and backend == 'ollama'

        logging.info(f"HTTP Route: /generate - backend={backend}, stream={stream}, client={client_id}, model={model}, prompt='{prompt[:50]}...'")

        if not prompt: return jsonify({'status': 'error', 'message': 'Prompt is required'}), 400

        # --- Backend/Model Validation ---
        if backend == 'ollama' and not model: return jsonify({'status': 'error', 'message': 'Model is required for Ollama'}), 400
        if backend == 'kobold' and not model: model = 'default'
        if backend in ['groq', 'openai', 'anthropic', 'google', 'xai'] and not model:
            logging.warning(f'Model name is missing for {backend.capitalize()}, required.')
            # Let backend call handle specific error message
        if backend == 'custom_external':
            if not config.CUSTOM_API_ENDPOINT: return jsonify({'status': 'error', 'message': 'Custom API Endpoint not configured.'}), 400
            if not config.CUSTOM_API_MODEL_NAME: logging.warning("Custom backend selected, but model name not configured.")

        # --- Task Management ---
        with state["task_lock"]:
            state["active_tasks"][client_id] = {"type": "text", "backend": backend, "controller": None}
            logging.debug(f"Task {client_id} added (text/{backend})")

        # --- Handle Ollama Streaming ---
        if backend == 'ollama' and stream:
            # Convert history (newest first) to Ollama format (oldest first)
            messages_for_ollama = [{'role': msg.get('role','user'), 'content': msg.get('content','')} for msg in history_context]
            messages_for_ollama.reverse()
            messages_for_ollama.append({'role': 'user', 'content': prompt})
            ollama_payload = {'model': model, 'messages': messages_for_ollama, 'stream': True}
            endpoint = f"{config.OLLAMA_API}/api/chat"

            def generate_ollama_stream():
                response = None
                request_cancelled = False
                try:
                    logging.info(f"Initiating Ollama stream request to: {endpoint} for client {client_id}")
                    stream_headers = {'Accept': 'text/event-stream', 'X-Client-ID': client_id}
                    response = make_request_with_retry(endpoint, "POST", json_data=ollama_payload, headers=stream_headers, stream=True, timeout=300, retries=1)
                    logging.info(f"Ollama stream connection established for {client_id}.")

                    with state["task_lock"]:
                        if client_id in state["active_tasks"]:
                            state["active_tasks"][client_id]["controller"] = getattr(response, 'raw', response)
                            logging.debug(f"Assigned stream controller for client {client_id}")
                        else:
                            logging.info(f"Task {client_id} removed before stream controller assignment.")
                            if response: response.close()
                            request_cancelled = True
                            return

                    buffer = ""
                    for line in response.iter_lines():
                        with state["task_lock"]:
                            if client_id not in state["active_tasks"]:
                                logging.info(f"Cancellation detected during Ollama stream for client {client_id}.")
                                request_cancelled = True
                                break
                        if line:
                            try:
                                decoded_line = line.decode('utf-8')
                                buffer += decoded_line
                                # Try parsing potential JSON object chunks
                                while True:
                                    try:
                                        data_json, index = json.JSONDecoder().raw_decode(buffer)
                                        buffer = buffer[index:].lstrip() # Remove processed part + leading whitespace

                                        chunk_content = data_json.get('message', {}).get('content')
                                        if chunk_content is None and 'response' in data_json:
                                            chunk_content = data_json['response']

                                        if chunk_content is not None:
                                            sse_data = json.dumps({'response': chunk_content})
                                            yield f"data: {sse_data}\n\n"

                                        if data_json.get('done'):
                                            logging.info(f"Ollama stream received 'done: true' marker for {client_id}.")
                                            request_cancelled = True # Treat 'done' as end signal
                                            break # Exit inner loop
                                    except json.JSONDecodeError:
                                        # Incomplete JSON object in buffer, break inner loop and wait for more data
                                        break
                                # Check outer loop break condition
                                if request_cancelled:
                                    break
                            except Exception as e_parse:
                                logging.error(f"Error processing Ollama stream line: {e_parse}", exc_info=True)
                                buffer = "" # Clear buffer on error

                    logging.info(f"Ollama stream loop finished for {client_id}. Cancelled: {request_cancelled}")
                    if not request_cancelled: # If ended without 'done' or explicit cancel
                        yield "data: [DONE]\n\n"
                        logging.debug(f"Sent stream [DONE] marker for client {client_id}")

                except Exception as e_gen:
                    logging.exception(f"Unexpected error during Ollama streaming for client {client_id}:")
                    if not request_cancelled:
                        yield f"data: {json.dumps({'status': 'error', 'message': 'Internal server error during stream.'})}\n\n"
                finally:
                    logging.info(f"Cleaning up task {client_id} after Ollama stream (Cancelled: {request_cancelled}).")
                    if response:
                        try: response.close()
                        except Exception as e_close: logging.warning(f"Error closing response: {e_close}")
                    with state["task_lock"]:
                        state["active_tasks"].pop(client_id, None)

            return Response(generate_ollama_stream(), mimetype='text/event-stream')

        # --- Handle Non-Streaming Backends ---
        else:
            response_text = call_llm_backend(prompt, history_context, backend, model)
            with state["task_lock"]:
                state["active_tasks"].pop(client_id, None) # Remove task on completion/error

            if response_text and not response_text.startswith("[Error"):
                return jsonify({'status': 'success', 'response': response_text})
            else:
                error_message = response_text or f"{backend.capitalize()} call failed."
                status_code = 400 if "[Error: " in error_message and ("API Key" in error_message or "Endpoint" in error_message or "Model name" in error_message) else 500
                logging.error(f"LLM call failed for backend {backend}: {error_message}")
                return jsonify({'status': 'error', 'message': error_message}), status_code

    except Exception as e:
        logging.exception("Unexpected error during /generate:")
        with state["task_lock"]:
            state["active_tasks"].pop(client_id, None)
        return jsonify({'status': 'error', 'message': f'Server error: {str(e)}'}), 500


@chat_bp.route('/chats', methods=['GET'])
def list_chats():
    """Lists available chat IDs based on stored files."""
    try:
        chat_list = get_chat_list_from_history()
        return jsonify({'status': 'success', 'chats': chat_list})
    except OSError as e:
        logging.error(f"Error listing chat directory {config.HISTORY_DIR}: {e}")
        return jsonify({'status': 'error', 'message': 'Could not list chat histories.'}), 500
    except Exception as e:
        logging.exception("Unexpected error listing chats:")
        return jsonify({'status': 'error', 'message': f'Server error: {str(e)}'}), 500

@chat_bp.route('/chat/<chat_id>', methods=['GET'])
def get_chat(chat_id):
    """Gets the message and image history for a specific chat."""
    try:
        chat_data = load_chat_data(chat_id)
        return jsonify({'status': 'success', 'chat_id': chat_id, 'history': chat_data})
    except ValueError as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400
    except Exception as e:
        logging.exception(f"Unexpected error loading chat {chat_id}:")
        return jsonify({'status': 'error', 'message': f'Server error loading chat: {str(e)}'}), 500

@chat_bp.route('/chat/<chat_id>', methods=['POST'])
def save_chat(chat_id):
    """Saves/updates the message and image history for a specific chat."""
    try:
        data = request.get_json()
        if not data or 'messages' not in data or 'images' not in data:
             return jsonify({'status': 'error', 'message': 'Invalid payload. Missing messages or images key.'}), 400
        save_chat_data(chat_id, data)
        return jsonify({'status': 'success', 'message': f'Chat {chat_id} saved.'})
    except ValueError as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400
    except Exception as e:
        logging.exception(f"Unexpected error saving chat {chat_id}:")
        return jsonify({'status': 'error', 'message': f'Server error saving chat: {str(e)}'}), 500

@chat_bp.route('/chat/<chat_id>', methods=['DELETE'])
def delete_chat(chat_id):
    """Deletes the history file for a specific chat."""
    try:
        deleted = delete_chat_file(chat_id)
        if deleted:
            return jsonify({'status': 'success', 'message': f'Chat {chat_id} deleted.'})
        else:
            # If file didn't exist, treat as success from user perspective
            return jsonify({'status': 'success', 'message': f'Chat {chat_id} not found or already deleted.'})
    except Exception as e:
        logging.exception(f"Unexpected error deleting chat {chat_id}:")
        return jsonify({'status': 'error', 'message': f'Server error deleting chat: {str(e)}'}), 500

@chat_bp.route('/cancel', methods=['POST'])
def cancel_task_route():
    """Attempts to cancel an ongoing task based on client_id."""
    try:
        data = request.get_json()
        if not data or 'client_id' not in data:
            return jsonify({'status': 'error', 'message': 'Client ID required'}), 400
        client_id = data['client_id']

        logging.info(f"Received cancellation request for client ID: {client_id}")
        task_cancelled = False
        task_details = None

        with state["task_lock"]:
            if client_id in state["active_tasks"]:
                task_details = state["active_tasks"].pop(client_id) # Remove and get details
                task_cancelled = True
                logging.info(f"Removed task entry for client {client_id}.")
            else:
                logging.warning(f"No active task found for client ID {client_id} upon cancellation request.")
                return jsonify({'status': 'error', 'message': 'No active task found for client ID'}), 404

        if task_cancelled and task_details:
            task_type = task_details.get("type")
            controller = task_details.get("controller")
            prompt_id = task_details.get("prompt_id") # For image tasks
            backend = task_details.get("backend") # For text tasks

            logging.info(f"Processing cancellation for client {client_id}, type: {task_type}, backend: {backend}, prompt_id: {prompt_id}")

            # --- Cancellation Logic ---
            if task_type == "text" and backend == "ollama" and controller:
                # Controller might be requests.Response or response.raw
                logging.info(f"Attempting to close controller for text stream {client_id}")
                try:
                    if hasattr(controller, 'close'):
                        controller.close()
                        logging.info(f"Closed stream controller for {client_id}")
                    else:
                        logging.warning(f"Controller for {client_id} (type {type(controller)}) has no close method.")
                except Exception as e:
                    logging.warning(f"Error closing controller for {client_id}: {e}")

            elif task_type == "image" and prompt_id:
                logging.info(f"Attempting ComfyUI interrupt for client {client_id} / prompt {prompt_id}")
                try:
                    interrupt_payload = {"client_id": client_id}
                    # Use make_request_with_retry for interrupt as well? Maybe not needed.
                    interrupt_response = requests.post(f"{config.COMFYUI_API_BASE}/interrupt", json=interrupt_payload, timeout=5)
                    if interrupt_response.ok:
                        logging.info(f"Sent ComfyUI interrupt request for client {client_id} / prompt {prompt_id}.")
                    else:
                        logging.warning(f"ComfyUI interrupt failed for client {client_id}. Status: {interrupt_response.status_code}, Response: {interrupt_response.text[:200]}")
                except requests.RequestException as e:
                     logging.warning(f"Could not send ComfyUI interrupt request: {e}")
            # --- End Cancellation Logic ---

            return jsonify({'status': 'success', 'message': 'Task cancellation initiated.'})
        else:
             # Should not be reached if logic is correct
             return jsonify({'status': 'error', 'message': 'Internal state mismatch during cancellation.'}), 500

    except Exception as e:
        logging.exception("Error processing cancel request:")
        return jsonify({'status': 'error', 'message': f'Internal server error during cancellation: {str(e)}'}), 500