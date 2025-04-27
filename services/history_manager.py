import os
import json
import logging
from config import HISTORY_DIR

def get_chat_filepath(chat_id):
    """Constructs the file path for a given chat ID."""
    # Basic sanitization to prevent directory traversal
    safe_chat_id = "".join(c for c in chat_id if c.isalnum() or c in ('-', '_'))
    if not safe_chat_id or safe_chat_id != chat_id: # Ensure original ID was safe
        raise ValueError(f"Invalid chat ID format: {chat_id}")
    return os.path.join(HISTORY_DIR, f"{safe_chat_id}.json")

def load_chat_data(chat_id):
    """Loads chat history (messages and images) from its JSON file."""
    try:
        filepath = get_chat_filepath(chat_id)
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    # Ensure default structure if keys are missing
                    if 'messages' not in data: data['messages'] = []
                    if 'images' not in data: data['images'] = []
                    return data
            except (json.JSONDecodeError, IOError) as e:
                logging.error(f"Error loading chat file {filepath}: {e}")
                return {'messages': [], 'images': []} # Return empty structure on error
        else:
            logging.info(f"Chat file not found for {chat_id}, returning empty structure.")
            return {'messages': [], 'images': []} # Return empty if file doesn't exist
    except ValueError as e: # Catch invalid chat ID from get_chat_filepath
        logging.error(f"Error getting chat filepath: {e}")
        raise # Re-raise validation error

def save_chat_data(chat_id, data):
    """Saves chat history (messages and images) to its JSON file."""
    try:
        os.makedirs(HISTORY_DIR, exist_ok=True)
        filepath = get_chat_filepath(chat_id)
        # Ensure data has the correct keys before saving
        if 'messages' not in data: data['messages'] = []
        if 'images' not in data: data['images'] = []
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        logging.debug(f"Saved chat data for {chat_id} to {filepath}")
    except (IOError, TypeError) as e:
        logging.error(f"Error saving chat file {filepath}: {e}")
        raise # Re-raise to signal failure
    except ValueError as e: # Catch invalid chat ID
        logging.error(f"Error getting chat filepath for saving: {e}")
        raise

def delete_chat_file(chat_id):
    """Deletes the JSON file associated with a chat ID."""
    try:
        filepath = get_chat_filepath(chat_id)
        if os.path.exists(filepath):
            os.remove(filepath)
            logging.info(f"Deleted chat history file: {filepath}")
            return True
        else:
            logging.warning(f"Attempted to delete non-existent chat file: {filepath}")
            return False
    except (IOError, ValueError, OSError) as e:
        logging.error(f"Error deleting chat file for {chat_id}: {e}")
        return False # Indicate failure

def get_chat_list():
    """Lists available chat IDs and names based on stored files."""
    chat_list_data = []
    if not os.path.exists(HISTORY_DIR):
        return chat_list_data # Return empty list if directory doesn't exist

    try:
        # Sort files by modification time, newest first
        files = sorted(
            [os.path.join(HISTORY_DIR, f) for f in os.listdir(HISTORY_DIR) if f.endswith(".json")],
            key=os.path.getmtime,
            reverse=True
        )
        for filepath in files:
            filename = os.path.basename(filepath)
            chat_id = filename[:-5] # Remove .json extension
            name = None
            try:
                # Attempt to read the first user message as a name hint
                with open(filepath, 'r', encoding='utf-8') as f_read:
                    data = json.load(f_read)
                    messages = data.get('messages', [])
                    # Find the *oldest* user message (last in list)
                    oldest_user_msg = next((msg['content'] for msg in reversed(messages) if msg.get('role') == 'user'), None)
                    if oldest_user_msg:
                         name = " ".join(oldest_user_msg.split()[:4]) # First 4 words
                         if len(oldest_user_msg) > len(name) + 3: name += "..." # Add ellipsis
            except Exception as e_name:
                logging.warning(f"Could not read name hint for {chat_id}: {e_name}")
            # Fallback name
            chat_list_data.append({"id": chat_id, "name": name or f"Chat {chat_id.split('-')[-1]}"})
        return chat_list_data
    except OSError as e:
        logging.error(f"Error listing chat directory {HISTORY_DIR}: {e}")
        # Re-raise or return empty list? Let's re-raise to signal a potentially bigger issue.
        raise OSError(f"Could not list chat histories: {e}")