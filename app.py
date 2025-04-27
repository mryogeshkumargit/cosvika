import logging
import os
from threading import Lock
from flask import Flask, send_from_directory
from flask_socketio import SocketIO
from flask_cors import CORS

# --- Configuration Import ---
# Import specific variables needed here or the whole module
import config
from config import state # Import shared state dictionary

# --- Utility/Service Imports ---
# Import necessary initialization functions or modules
from services import tts_service, stt_service, history_manager
from sockets import init_sockets

# --- Route Imports ---
from routes.chat import chat_bp
from routes.comfyui import comfyui_bp
from routes.models import models_bp
from routes.settings import settings_bp
from routes.tts import tts_bp

# --- Configure Logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logging.info(f"Default device detected: {config.DEFAULT_DEVICE}")

# --- Initialize Flask App & Extensions ---
app = Flask(__name__, static_folder='static', static_url_path='/static')
app.config['SECRET_KEY'] = os.urandom(24) # Needed for SocketIO sessions
CORS(app)
# async_mode='threading' is important for background tasks with standard Flask
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# --- Initialize Shared State Components ---
state["task_lock"] = Lock()

# --- Register Blueprints (API Routes) ---
app.register_blueprint(chat_bp)
app.register_blueprint(comfyui_bp)
app.register_blueprint(models_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(tts_bp)

# --- Initialize SocketIO Handlers ---
init_sockets(socketio)

# --- Initialize Services (Load Models, etc.) ---
stt_service.load_whisper_model()
config.state["available_tts_models"] = tts_service.get_available_tts_models() # Fetch list initially
tts_service.load_tts_model(config.state["current_tts_model_name"]) # Load initial model

# --- Root Route for Frontend ---
@app.route('/')
def serve_index():
    # Serves Index.html from the current directory (or specify static folder)
    return send_from_directory('.', 'Index.html')

# --- Run the Application ---
if __name__ == '__main__':
    os.makedirs(config.HISTORY_DIR, exist_ok=True)

    # Print final configuration summary
    print("----------------------------------------------------")
    print("Cosmo AI Server Configuration (Refactored):")
    print(f"  Default Device: {config.DEFAULT_DEVICE}")
    print(f"  History Directory: {config.HISTORY_DIR}")
    print(f"  Ollama API: {config.OLLAMA_API}")
    print(f"  Kobold API: {config.KOBOLD_API}")
    print(f"  ComfyUI API: {config.COMFYUI_API_BASE}")
    print(f"  Groq Key Set: {'Yes' if config.GROQ_API_KEY else 'No (Using Default)'}")
    print(f"  OpenAI Key Set: {'Yes' if config.OPENAI_API_KEY else 'No'}")
    print(f"  Anthropic Key Set: {'Yes' if config.ANTHROPIC_API_KEY else 'No'}")
    print(f"  Google Key Set: {'Yes' if config.GOOGLE_API_KEY else 'No (Using Default)'}")
    print(f"  xAI Key Set: {'Yes' if config.XAI_API_KEY else 'No'}")
    print(f"  Custom Endpoint: {config.CUSTOM_API_ENDPOINT or 'Not Set'}")
    print(f"  STT Model: {config.WHISPER_MODEL_NAME if state['stt_loaded'] else 'Not Loaded'}")
    print(f"  TTS Model: {state['current_tts_model_name'] if state['tts_loaded'] else 'Not Loaded'}")
    print(f"  Available TTS Models Found: {len(state['available_tts_models'])}")
    print("----------------------------------------------------")

    print(f"Starting Flask-SocketIO server on http://0.0.0.0:5000...")
    # use_reloader=False prevents duplicate model loading in debug mode
    # allow_unsafe_werkzeug needed for threading mode with newer Werkzeug
    socketio.run(app, debug=False, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True, use_reloader=False)