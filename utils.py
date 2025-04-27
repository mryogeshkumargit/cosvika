import requests
import logging
import time
import json

def make_request_with_retry(url, method, json_data=None, params=None, headers=None, retries=3, backoff=1, timeout=60, stream=False):
    """Generic request function with retries, better error handling, optional streaming, and custom headers."""
    request_headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if headers:
        request_headers.update(headers)

    # Ensure correct charset for JSON data if not specified
    if json_data is not None and 'Content-Type' in request_headers and 'application/json' in request_headers['Content-Type'] and 'charset' not in request_headers['Content-Type'].lower():
         request_headers['Content-Type'] = 'application/json; charset=utf-8'

    if stream:
        request_headers['Accept'] = 'text/event-stream'

    # Log headers safely
    logged_headers = {k: (v if k.lower() not in ['authorization', 'x-api-key'] else '***') for k, v in request_headers.items()}
    logging.debug(f"Requesting {method} {url} with timeout {timeout}s (Stream: {stream}) Headers: {logged_headers}")

    last_exception = None
    for i in range(retries):
        try:
            response = requests.request(method, url, headers=request_headers, json=json_data, params=params, timeout=timeout, stream=stream)
            logging.debug(f"Response Status: {response.status_code}")

            # Raise HTTPError immediately for bad responses (4xx or 5xx)
            response.raise_for_status()

            if stream:
                 logging.debug(f"Stream request to {url} successful (status {response.status_code}).")
                 return response # Return raw response for iter_lines etc.

            if response.status_code == 204 or not response.content:
                logging.debug(f"Request to {url} successful with status {response.status_code} and empty body.")
                return {} # Return empty dict for No Content

            # Try parsing JSON, fallback to text
            try:
                json_response = response.json()
                logging.debug(f"Request to {url} successful with JSON response (status {response.status_code}).")
                return json_response
            except requests.exceptions.JSONDecodeError:
                logging.warning(f"Response from {url} was not valid JSON (status {response.status_code}). Returning raw text.")
                # Ensure response text is read before returning
                response_text = response.text
                return response_text

        except requests.exceptions.Timeout as e:
            logging.warning(f"Attempt {i+1}/{retries} timed out for {method} {url}")
            last_exception = e
        except requests.exceptions.HTTPError as e: # Catch 4xx/5xx specifically
             error_details = f"HTTP Error: {e}"
             if e.response is not None:
                 error_details += f" | Status Code: {e.response.status_code}"
                 try:
                     # Try to get specific error from JSON body if possible
                     err_json = e.response.json()
                     err_msg = err_json.get('error', {}).get('message') or err_json.get('message') or err_json.get('error') or str(err_json)
                     error_details += f" | Response Body: {err_msg[:500]}"
                 except (requests.exceptions.JSONDecodeError, AttributeError, TypeError): # Added TypeError
                     try:
                         # Ensure response text is read before accessing
                         error_text = e.response.text
                         error_details += f" | Response Body: {error_text[:500]}"
                     except Exception as read_err:
                         error_details += f" | Failed to read response body: {read_err}"
             logging.warning(f"Attempt {i+1}/{retries} for {method} {url} failed: {error_details}")
             last_exception = e
             # For HTTP errors, often don't retry unless it's a server error (5xx)
             if e.response is not None and e.response.status_code < 500:
                 break # Don't retry client errors (4xx)
        except requests.exceptions.RequestException as e:
            error_details = f"Request Error: {e}"
            logging.warning(f"Attempt {i+1}/{retries} for {method} {url} failed: {error_details}")
            last_exception = e

        # Backoff logic
        if i < retries - 1:
            sleep_time = backoff * (2**i)
            logging.debug(f"Retrying in {sleep_time}s...")
            time.sleep(sleep_time)
        else:
            logging.error(f"Request failed after {retries} attempts: {method} {url}")
            if last_exception:
                raise last_exception # Re-raise the last captured exception
            # If no specific exception was caught but retries exhausted
            raise requests.exceptions.RequestException(f"Request failed after {retries} attempts without specific exception detail.")

def find_node_errors(prompt_history):
    """Helper to extract node errors from ComfyUI history."""
    errors = []
    if not isinstance(prompt_history, dict):
        logging.warning(f"find_node_errors expected dict, got {type(prompt_history)}")
        return "Invalid history format"

    status_block = prompt_history.get('status', {})
    if isinstance(status_block, dict) and status_block.get('exception'):
        exc_info = status_block['exception']
        if isinstance(exc_info, list) and len(exc_info) > 1:
             errors.append(f"Exception: {exc_info[1]} (Type: {exc_info[0]})")
        else:
             errors.append(f"Exception: {exc_info}")


    prompt_data = prompt_history.get('prompt', [])
    if isinstance(prompt_data, list) and len(prompt_data) > 2:
        exec_info = prompt_data[2] # Assuming execution info is the 3rd element
        if isinstance(exec_info, dict):
            for node_id, info in exec_info.items():
                if isinstance(info, dict) and info.get('error'):
                    errors.append(f"Node {node_id}: {info['error']}")

    # Check for top-level error keys (might vary with ComfyUI versions)
    if 'error' in prompt_history:
         errors.append(f"General Error: {prompt_history['error']}")
    if 'node_errors' in prompt_history and isinstance(prompt_history['node_errors'], dict):
         for node_id, error_info in prompt_history['node_errors'].items():
             if isinstance(error_info, dict):
                errors.append(f"Node {node_id} Error: {error_info.get('message', 'Unknown error')}")
             else:
                 errors.append(f"Node {node_id} Error: {error_info}")

    return "; ".join(errors) if errors else None