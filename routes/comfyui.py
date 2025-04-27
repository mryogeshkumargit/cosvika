from flask import Blueprint, request, jsonify
import logging
import json
import time
import requests
from urllib.parse import urlencode
from utils import make_request_with_retry, find_node_errors
from config import state # Import shared state
import config # Import full config

comfyui_bp = Blueprint('comfyui', __name__, url_prefix='/api')

@comfyui_bp.route('/comfyui-status', methods=['GET'])
def check_comfyui_status():
    """Checks if ComfyUI server is running."""
    try:
        logging.info("Checking ComfyUI status...")
        # Use make_request_with_retry for robustness
        response_or_data = make_request_with_retry(f"{config.COMFYUI_API_BASE}/", "GET", timeout=5)

        # Check the type returned by the retry function
        if isinstance(response_or_data, requests.Response):
             status_code = response_or_data.status_code
             if 200 <= status_code < 300:
                 return jsonify({'status': 'success', 'message': 'ComfyUI is responding.'})
             else:
                 logging.warning(f"ComfyUI responded with status {status_code}.")
                 return jsonify({'status': 'error', 'message': f'ComfyUI responded with status {status_code}.'}), 500
        elif isinstance(response_or_data, (dict, str)): # If retry func returned parsed data/text
             return jsonify({'status': 'success', 'message': 'ComfyUI is responding.'})
        else:
             # This path indicates an issue with make_request_with_retry or unexpected response
             logging.error(f"ComfyUI status check returned unexpected type: {type(response_or_data)}")
             return jsonify({'status': 'error', 'message': 'ComfyUI did not respond as expected.'}), 503

    except requests.RequestException as e:
        logging.error(f"ComfyUI is not running or unreachable: {e}")
        return jsonify({'status': 'error', 'message': f'ComfyUI connection failed: {str(e)}'}), 503
    except Exception as e:
        logging.exception("Unexpected error checking ComfyUI status:")
        return jsonify({'status': 'error', 'message': f'Server error: {str(e)}'}), 500


@comfyui_bp.route('/comfyui-checkpoints', methods=['GET'])
def get_comfyui_checkpoints():
    """Fetches available checkpoint models from ComfyUI."""
    NODE_CLASS_NAME = "CheckpointLoaderSimple"
    try:
        logging.info(f"Fetching object info for {NODE_CLASS_NAME} from ComfyUI...")
        url = f"{config.COMFYUI_API_BASE}/object_info/{NODE_CLASS_NAME}"
        response_data = make_request_with_retry(url, "GET", timeout=15)

        if isinstance(response_data, dict) and NODE_CLASS_NAME in response_data:
            node_info = response_data[NODE_CLASS_NAME]
            required_inputs = node_info.get('input', {}).get('required', {})
            ckpt_info = required_inputs.get('ckpt_name', [])

            if isinstance(ckpt_info, list) and len(ckpt_info) > 0 and isinstance(ckpt_info[0], list):
                checkpoint_list = ckpt_info[0]
                if isinstance(checkpoint_list, list):
                    logging.info(f"Found {len(checkpoint_list)} ComfyUI checkpoints.")
                    checkpoint_list_str = [str(name) for name in checkpoint_list]
                    return jsonify({'status': 'success', 'checkpoints': checkpoint_list_str})
                else:
                    logging.error(f"Expected list of checkpoints, found type {type(checkpoint_list)}.")
                    return jsonify({'status': 'error', 'message': 'Unexpected data format for checkpoints.'}), 500
            else:
                logging.error(f"Could not find checkpoint list structure in node_info: {node_info}")
                return jsonify({'status': 'error', 'message': 'Could not locate checkpoint list structure.'}), 500
        else:
            error_msg = f"Unexpected response format from {url}."
            logging.error(error_msg + f" Raw Response: {response_data}")
            return jsonify({'status': 'error', 'message': error_msg}), 500
    except requests.RequestException as e:
        logging.error(f"Error fetching ComfyUI node info for {NODE_CLASS_NAME}: {e}")
        return jsonify({'status': 'error', 'message': f'Failed to connect/fetch info: {str(e)}'}), 500
    except Exception as e:
        logging.exception(f"Unexpected error fetching ComfyUI node info:")
        return jsonify({'status': 'error', 'message': f'Server error: {str(e)}'}), 500


@comfyui_bp.route('/generate-image', methods=['POST'])
def generate_image_route():
    """Generates an image using ComfyUI."""
    client_id = request.json.get('client_id') or str(uuid.uuid4())
    try:
        data = request.get_json()
        if not data: return jsonify({'status': 'error', 'message': 'Invalid JSON payload'}), 400

        prompt_text = data.get('prompt')
        workflow_input = data.get('workflow', json.loads(json.dumps(config.DEFAULT_WORKFLOW_TEMPLATE))) # Deep copy
        settings = data.get('settings', {})

        if not prompt_text: return jsonify({'status': 'error', 'message': 'Image prompt is required'}), 400

        logging.info(f"Image generation request: client={client_id}, prompt='{prompt_text[:50]}...'")
        workflow_data = json.loads(json.dumps(workflow_input)) # Deep copy

        # --- Apply Settings to Workflow ---
        if config.POSITIVE_PROMPT_NODE_ID in workflow_data:
            workflow_data[config.POSITIVE_PROMPT_NODE_ID]['inputs']['text'] = prompt_text
        if config.CHECKPOINT_NODE_ID in workflow_data and settings.get('checkpoint'):
            workflow_data[config.CHECKPOINT_NODE_ID]['inputs']['ckpt_name'] = settings['checkpoint']
        if config.KSAMPLER_NODE_ID in workflow_data:
            inputs = workflow_data[config.KSAMPLER_NODE_ID]['inputs']
            inputs['seed'] = settings.get('seed', inputs.get('seed', 0))
            if inputs['seed'] == 0: inputs['seed'] = int(time.time() * 1000) % (2**32) # Randomize
            inputs['steps'] = settings.get('steps', inputs.get('steps', 25))
            inputs['cfg'] = settings.get('cfg', inputs.get('cfg', 7.0))
            inputs['sampler_name'] = settings.get('sampler', inputs.get('sampler_name', 'euler'))
            inputs['scheduler'] = settings.get('scheduler', inputs.get('scheduler', 'normal'))
            inputs['denoise'] = settings.get('denoise', inputs.get('denoise', 1.0))
        if config.LATENT_IMAGE_NODE_ID in workflow_data:
            inputs = workflow_data[config.LATENT_IMAGE_NODE_ID]['inputs']
            inputs['width'] = settings.get('width', inputs.get('width', 512))
            inputs['height'] = settings.get('height', inputs.get('height', 512))
        # --- End Apply Settings ---

        payload = {"prompt": workflow_data, "client_id": client_id}
        logging.debug(f"Queueing ComfyUI workflow (client: {client_id})...")

        queue_response = make_request_with_retry(f"{config.COMFYUI_API_BASE}/prompt", "POST", json_data=payload, timeout=30)

        if not isinstance(queue_response, dict) or 'prompt_id' not in queue_response:
             error_details = queue_response if isinstance(queue_response, str) else json.dumps(queue_response)
             logging.error(f"Failed to queue prompt with ComfyUI. Response: {error_details}")
             return jsonify({'status': 'error', 'message': 'Failed to queue prompt with ComfyUI.'}), 500

        prompt_id = queue_response['prompt_id']
        with state["task_lock"]:
            state["active_tasks"][client_id] = {"type": "image", "prompt_id": prompt_id}
        logging.info(f"ComfyUI prompt queued: Prompt ID={prompt_id}, Client ID={client_id}")

        # --- Polling Logic ---
        start_time = time.time()
        timeout_seconds = 300
        image_url = None
        final_status_message = 'Image generation timed out or failed.'
        poll_interval = 3

        logging.info(f"Polling ComfyUI history for Prompt ID {prompt_id} (Timeout: {timeout_seconds}s)")
        while time.time() - start_time < timeout_seconds:
            with state["task_lock"]:
                if client_id not in state["active_tasks"]:
                    logging.info(f"Image generation cancelled by client {client_id}.")
                    final_status_message = 'Image generation cancelled.'
                    # Try to interrupt ComfyUI
                    try:
                        interrupt_payload = {"client_id": client_id}
                        requests.post(f"{config.COMFYUI_API_BASE}/interrupt", json=interrupt_payload, timeout=5)
                        logging.info(f"Sent ComfyUI interrupt request for {client_id}.")
                    except requests.RequestException as e_int:
                         logging.warning(f"Could not send ComfyUI interrupt: {e_int}")
                    return jsonify({'status': 'cancelled', 'message': final_status_message})

            try:
                history_url = f"{config.COMFYUI_API_BASE}/history/{prompt_id}"
                history_data = make_request_with_retry(history_url, "GET", timeout=15, retries=2)

                if isinstance(history_data, dict) and prompt_id in history_data:
                    prompt_history = history_data[prompt_id]
                    outputs = prompt_history.get('outputs', {})
                    status = prompt_history.get('status', {})
                    exec_status = status.get('status_str', 'unknown')
                    completed = status.get('completed', False)
                    if exec_status == 'unknown' and outputs: completed = True; exec_status = 'success (inferred)'

                    logging.debug(f"Polling Prompt ID {prompt_id}: Status='{exec_status}', Completed={completed}")

                    if config.OUTPUT_NODE_ID in outputs:
                        output_node = outputs[config.OUTPUT_NODE_ID]
                        if 'images' in output_node and output_node['images']:
                            image_info = output_node['images'][0]
                            filename = image_info.get('filename')
                            if filename:
                                params = urlencode({
                                    'filename': filename,
                                    'subfolder': image_info.get('subfolder', ''),
                                    'type': image_info.get('type', 'output')
                                })
                                image_url = f"{config.COMFYUI_API_BASE}/view?{params}"
                                final_status_message = 'Image generated successfully.'
                                break # Success!
                    elif exec_status in ['error', 'failed']:
                        node_errors = find_node_errors(prompt_history)
                        final_status_message = f"Image generation failed: {exec_status}"
                        if node_errors: final_status_message += f" Details: {node_errors}"
                        logging.error(f"ComfyUI task {prompt_id} failed: {final_status_message}")
                        break # Failure
                    elif completed and config.OUTPUT_NODE_ID not in outputs:
                         final_status_message = f"Image generation finished, but output node '{config.OUTPUT_NODE_ID}' not found."
                         logging.error(final_status_message + f" Outputs: {outputs.keys()}")
                         break # Completed but no output

                # If prompt_id not in history_data yet, continue polling

            except requests.RequestException as e:
                 logging.warning(f"Polling /history/{prompt_id} failed: {e}. Retrying.")
            except Exception as e_poll:
                 logging.exception(f"Unexpected error polling /history/{prompt_id}:")
                 # Potentially break on unexpected errors? Or just log and continue?
                 # final_status_message = "Unexpected polling error."
                 # break

            time.sleep(poll_interval)
        # --- End Polling Loop ---

        with state["task_lock"]:
            state["active_tasks"].pop(client_id, None) # Clean up task entry

        if image_url:
            return jsonify({'status': 'success', 'image_url': image_url, 'message': final_status_message})
        else:
            logging.error(f"Image generation failed/timed out for Prompt ID {prompt_id}. Final status: {final_status_message}")
            return jsonify({'status': 'error', 'message': final_status_message}), 500

    except Exception as e:
        logging.exception("Unexpected error during image generation:")
        with state["task_lock"]:
            state["active_tasks"].pop(client_id, None)
        return jsonify({'status': 'error', 'message': f'Internal server error: {str(e)}'}), 500