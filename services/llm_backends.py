import logging
import requests
import json
from utils import make_request_with_retry
import config # Import config variables

# --- Helper Functions ---
def format_kobold_prompt(prompt, history):
    """Formats prompt and history for Kobold."""
    logging.debug("Formatting prompt for Kobold...")
    ai_trigger_phrase = "Assistant:"
    formatted_lines = []
    # History is newest first, reverse for processing order
    reversed_history = history[::-1]
    current_length = 0
    max_chars_approx = config.KOBOLD_CONTEXT_LIMIT * 3 # Rough estimate

    current_prompt_line = f"User: {prompt.strip()}"
    formatted_lines.append(current_prompt_line)
    current_length += len(current_prompt_line)

    for msg in reversed_history:
        role = msg.get('role', 'user').capitalize()
        content = msg.get('content', '').strip()
        if role == 'User':
            line = f"User: {content}"
        elif role == 'Assistant':
            line = f"{ai_trigger_phrase} {content}"
        else:
            line = content # Handle system messages

        if current_length + len(line) < max_chars_approx:
            formatted_lines.insert(0, line) # Insert at beginning
            current_length += len(line)
        else:
            logging.warning(f"Kobold history truncated due to context limit ({max_chars_approx} chars).")
            break

    formatted_lines.append(ai_trigger_phrase) # Trigger AI response
    final_prompt = "\n".join(formatted_lines)
    logging.info(f"Kobold formatted prompt length: {len(final_prompt)} characters.")
    return final_prompt

# --- Main Backend Call Function ---
def call_llm_backend(prompt, history, backend, model):
    """Calls the selected LLM backend."""
    logging.info(f"LLM Call: backend={backend}, model={model}, prompt='{prompt[:50]}...'")

    # Prepare messages in standard OpenAI format (oldest first)
    messages_for_api = history[::-1] # Reverse history for chronological order
    messages_for_api.append({'role': 'user', 'content': prompt})

    api_endpoint = None
    api_key = None
    headers = {'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json'}
    payload = {}

    # --- Determine API Details based on Backend ---
    try:
        if backend == 'ollama':
            ollama_messages = [{'role': msg.get('role', 'user'), 'content': msg.get('content', '')} for msg in messages_for_api]
            payload = {'model': model, 'messages': ollama_messages, 'stream': False}
            api_endpoint = f"{config.OLLAMA_API}/api/chat"

        elif backend == 'kobold':
            kobold_formatted_prompt = format_kobold_prompt(prompt, history) # History should be newest first here
            prompt_token_estimate = len(kobold_formatted_prompt) // 3
            desired_generation_length = 512
            max_length = min(prompt_token_estimate + desired_generation_length, config.KOBOLD_CONTEXT_LIMIT)
            payload = {'prompt': kobold_formatted_prompt, 'max_length': max_length, 'temperature': 0.7}
            api_endpoint = config.KOBOLD_API

        elif backend == 'groq':
            api_endpoint = "https://api.groq.com/openai/v1/chat/completions"
            api_key = config.GROQ_API_KEY
            if not api_key: return "[Error: Groq API Key not configured on backend]"
            if not model: return "[Error: Model name required for Groq]"
            headers['Authorization'] = f'Bearer {api_key}'
            openai_messages = [{'role': msg.get('role','user'), 'content': msg.get('content','')} for msg in messages_for_api]
            payload = {"messages": openai_messages, "model": model, "stream": False}

        elif backend == 'openai':
            api_endpoint = "https://api.openai.com/v1/chat/completions"
            api_key = config.OPENAI_API_KEY
            if not api_key: return "[Error: OpenAI API Key not configured on backend]"
            if not model: return "[Error: Model name required for OpenAI]"
            headers['Authorization'] = f'Bearer {api_key}'
            openai_messages = [{'role': msg.get('role','user'), 'content': msg.get('content','')} for msg in messages_for_api]
            payload = {"messages": openai_messages, "model": model, "stream": False}

        elif backend == 'anthropic':
            api_endpoint = "https://api.anthropic.com/v1/messages"
            api_key = config.ANTHROPIC_API_KEY
            if not api_key: return "[Error: Anthropic API Key not configured on backend]"
            if not model: return "[Error: Model name required for Anthropic]"
            headers['x-api-key'] = api_key
            headers['anthropic-version'] = '2023-06-01'
            anthropic_messages = [{'role': msg.get('role','user'), 'content': msg.get('content','')} for msg in messages_for_api]
            payload = {"model": model, "messages": anthropic_messages, "max_tokens": 1024, "stream": False}
            headers.pop('Authorization', None)

        elif backend == 'google':
            if not model: return "[Error: Model name required for Google Gemini]"
            api_endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            api_key = config.GOOGLE_API_KEY
            if not api_key: return "[Error: Google API Key not configured on backend]"
            api_endpoint += f"?key={api_key}"
            gemini_contents = []
            for msg in messages_for_api:
                role = msg.get('role', 'user')
                gemini_role = 'model' if role == 'assistant' else 'user'
                gemini_contents.append({'role': gemini_role, 'parts': [{'text': msg.get('content', '')}]})
            payload = {"contents": gemini_contents}

        elif backend == 'xai':
            api_endpoint = "https://api.x.ai/v1/chat/completions"
            api_key = config.XAI_API_KEY
            if not api_key: return "[Error: xAI API Key not configured on backend (if required)]"
            if not model: return "[Error: Model name required for xAI]"
            headers['Authorization'] = f'Bearer {api_key}'
            openai_messages = [{'role': msg.get('role','user'), 'content': msg.get('content','')} for msg in messages_for_api]
            payload = {"messages": openai_messages, "model": model, "stream": False}

        elif backend == 'custom_external':
            api_endpoint = config.CUSTOM_API_ENDPOINT
            api_key = config.CUSTOM_API_KEY
            model = config.CUSTOM_API_MODEL_NAME
            if not api_endpoint: return "[Error: Custom API Endpoint not configured]"
            if not model: return "[Error: Custom API Model Name not configured]"
            if api_key: headers['Authorization'] = f'Bearer {api_key}'
            openai_messages = [{'role': msg.get('role','user'), 'content': msg.get('content','')} for msg in messages_for_api]
            payload = {"messages": openai_messages, "model": model, "stream": False}

        else:
            return f"[Backend '{backend}' not supported]"

        # --- Make the API Call ---
        logging.info(f"Attempting {backend} API Request to {api_endpoint}")
        result = make_request_with_retry(api_endpoint, "POST", json_data=payload, headers=headers, timeout=180)

        # --- Parse Response ---
        response_text = None
        if isinstance(result, dict):
            # OpenAI / Groq / xAI
            if 'choices' in result and result['choices'] and 'message' in result['choices'][0] and 'content' in result['choices'][0]['message']:
                response_text = result['choices'][0]['message']['content']
            # Anthropic
            elif backend == 'anthropic' and 'content' in result and isinstance(result['content'], list) and result['content'] and 'text' in result['content'][0]:
                response_text = result['content'][0]['text']
            # Google Gemini
            elif backend == 'google' and 'candidates' in result and result['candidates'] and 'content' in result['candidates'][0] and 'parts' in result['candidates'][0]['content'] and result['candidates'][0]['content']['parts'] and 'text' in result['candidates'][0]['content']['parts'][0]:
                 response_text = result['candidates'][0]['content']['parts'][0]['text']
            # Kobold
            elif backend == 'kobold' and 'results' in result and result['results'] and 'text' in result['results'][0]:
                 response_text = result['results'][0]['text']
            # Ollama (non-stream)
            elif backend == 'ollama' and 'message' in result and 'content' in result['message']:
                 response_text = result['message']['content']
            elif backend == 'ollama' and 'response' in result: # Fallback for older ollama non-stream
                 response_text = result['response']

            # Generic Fallback
            if response_text is None:
                 logging.warning(f"Could not parse known structure for {backend}, attempting generic keys.")
                 response_text = result.get('response') or result.get('text') or result.get('completion')

        elif isinstance(result, str): # Handle plain text response
             logging.warning(f"{backend} API returned plain text.")
             response_text = result

        if response_text is not None:
            logging.info(f"{backend} call successful.")
            return response_text.strip()
        else:
            logging.error(f"Unexpected/Unparsed API response structure from {backend}: {result}")
            return f"[Error parsing response from {backend}]"

    except requests.RequestException as e:
        error_msg = f"Error connecting to {backend} API: {e}"
        logging.error(error_msg, exc_info=True)
        return f"[{error_msg}]"
    except Exception as e:
        logging.error(f"Error calling {backend} API: {e}", exc_info=True)
        return f"[Error during {backend} API call: {e}]"