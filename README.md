# Cosmo AI - Multifaceted AI Interaction Interface

![Cosmo AI Icon](./static/title.png)

**Cosmo AI** is a powerful and versatile web interface designed to seamlessly interact with a variety of AI models and services, including Large Language Models (LLMs), Speech-to-Text (STT), Text-to-Speech (TTS), and Image Generation via ComfyUI. Whether deployed locally or in the cloud, Cosmo AI aims to be your ultimate AI companion.

---

## 🌟 Core Features

- **Multi-Backend LLM Support**  
  Interact with a wide range of text generation backends:  
  - **Local**: Ollama, KoboldAI  
  - **Cloud**: Groq, OpenAI (ChatGPT), Google (Gemini), Anthropic (Claude), xAI (Grok)  
  - **Custom**: Configure your own OpenAI-compatible API endpoint  

- **Speech-to-Text (STT)**  
  Real-time voice input powered by Faster Whisper, capturing audio directly from your microphone.

- **Text-to-Speech (TTS)**  
  Transform AI responses into natural-sounding voice output using Coqui TTS, with customizable model and speaker options.

- **Image Generation**  
  Create stunning images with ComfyUI based on text prompts or variations, supporting custom workflows.

- **Chat History**  
  Save and load chat messages and generated images for each conversation, ensuring continuity.

- **Real-time Voice Interaction**  
  Combine STT and TTS for smooth, near real-time voice conversations with the AI.

- **Configurable Settings**  
  Intuitive UI panel to manage API endpoints, keys, LLM backends/models, ComfyUI parameters, and voice settings.

- **Responsive UI**  
  Sleek, desktop-optimized design with basic mobile support (mobile refinements in progress).

- **Dark/Light Theme**  
  Toggle between dark and light themes to suit your preference.

---

## 🛠 Technology Stack

### Backend
- **Language**: Python 3  
- **Framework**: Flask  
- **Real-time**: Flask-SocketIO  
- **API Handling**: Requests  
- **STT**: faster-whisper  
- **TTS**: Coqui TTS  
- **Audio Processing**: pydub, numpy, soundfile  
- **Configuration**: Python environment variables, `config.py`  
- **GPU Acceleration**: PyTorch (CUDA support for STT/TTS)  

### Frontend
- **Structure**: HTML5 (`Index.html`)  
- **Styling**: CSS3 (`static/styles.css`)  
- **Logic**: Vanilla JavaScript (ES Modules)  
- **Real-time**: Socket.IO Client  
- **Markdown Rendering**: Marked.js  

### External Dependencies
- **FFmpeg**: Required by `pydub` for audio format conversion. Install separately.  
- **Local AI Services (Optional)**:  
  - Ollama Server (for Ollama backend)  
  - KoboldAI Instance (for Kobold backend)  
  - ComfyUI Server (for Image Generation)  

---

## 🚀 Setup and Installation

Follow these steps to get Cosmo AI up and running:

1. **Clone the Repository**  
   ```bash
   git clone <your-repository-url>
   cd <repository-directory>
   ```

2. **Create a Python Virtual Environment** (Recommended)  
   ```bash
   python -m venv .venv
   # Activate the environment:
   # Windows:
   .\.venv\Scripts\activate
   # macOS/Linux:
   source .venv/bin/activate
   ```

3. **Install Python Dependencies**  
   - Ensure Python 3.10+ is installed.  
   - For GPU acceleration, install PyTorch with CUDA support (see [PyTorch website](https://pytorch.org/get-started/locally/)).  
   - Install required packages:  
     ```bash
     pip install -r requirements.txt
     ```  
   - If `requirements.txt` is missing, install manually:  
     ```bash
     pip install Flask Flask-SocketIO Flask-Cors python-dotenv requests torch torchvision torchaudio faster-whisper TTS pydub soundfile numpy
     ```  
     > **Note**: `TTS` and `faster-whisper` may require additional dependencies or a C++ compiler.

4. **Install FFmpeg** (Required for Audio Conversion)  
   - **Windows**: Download from [FFmpeg website](https://ffmpeg.org/download.html) and add `bin` to PATH.  
   - **macOS**: `brew install ffmpeg`  
   - **Linux (Debian/Ubuntu)**: `sudo apt update && sudo apt install ffmpeg`  
   - **Linux (Fedora)**: `sudo dnf install ffmpeg`

5. **Configure API Keys and Endpoints**  
   See the [Configuration](#configuration) section below.

6. **Setup External Services** (Optional)  
   - **Ollama**: Install and run [Ollama](https://ollama.ai/). Pull models (e.g., `ollama pull llama3`).  
   - **ComfyUI**: Install and run [ComfyUI](https://github.com/comfyanonymous/ComfyUI) for image generation.  
   - **KoboldAI**: Install and run [KoboldAI](https://github.com/KoboldAI/KoboldAI-Client) for Kobold backend.

---

## ▶️ Running the Application

1. **Activate Virtual Environment**  
   ```bash
   # Windows: .\.venv\Scripts\activate
   # macOS/Linux: source .venv/bin/activate
   ```

2. **Set Environment Variables**  
   Create a `.env` file or set system variables (see [Configuration](#configuration)).

3. **Ensure Backend Services are Running**  
   Start Ollama, ComfyUI, or KoboldAI if using these services.

4. **Start the Flask Server**  
   ```bash
   python app.py
   ```  
   The server will load STT/TTS models and listen on `http://0.0.0.0:5000`.

5. **Access the UI**  
   Open your browser and navigate to `http://localhost:5000`.

---

## ⚙️ Configuration

Configuration is managed via environment variables, loaded by `config.py`. Use a `.env` file in the project root.

### Example `.env` File
```dotenv
# API Endpoints (Optional - Defaults in config.py)
OLLAMA_API=http://localhost:11435
KOBOLD_API=http://localhost:5001/api/v1/generate
COMFYUI_API=http://127.0.0.1:8188

# External Provider API Keys (Required for cloud backends)
GROQ_API_KEY=gsk_YourGroqKeyHere
OPENAI_API_KEY=sk-YourOpenAIKeyHere
GOOGLE_API_KEY=AIzaSyYourGoogleKeyHere
ANTHROPIC_API_KEY=sk-ant-YourAnthropicKeyHere
XAI_API_KEY=YourXaiKeyHere_IfAny

# STT/TTS Model Config (Optional)
WHISPER_MODEL=base.en
WHISPER_DEVICE=cuda
WHISPER_COMPUTE_TYPE=float16
TTS_MODEL=tts_models/multilingual/multi-dataset/xtts_v2
```

> **⚠️ Important**  
> - **Do NOT commit API keys to Git.** Add `.env` to `.gitignore`.  
> - Defaults for local endpoints are in `config.py` but can be overridden.  
> - UI settings (saved in browser `localStorage`) override environment variables for the session.

---

## 🌐 API Endpoints

The Flask backend exposes endpoints under `/api`:

- **POST /api/generate**: Text generation for various backends (supports streaming for Ollama).  
- **GET /api/chats**: List chat history IDs.  
- **GET, POST, DELETE /api/chat/<chat_id>**: Manage chat history.  
- **POST /api/cancel**: Cancel ongoing generation tasks.  
- **GET /api/comfyui-status**: Check ComfyUI server status.  
- **GET /api/comfyui-checkpoints**: List ComfyUI checkpoint models.  
- **POST /api/generate-image**: Queue image generation with ComfyUI.  
- **GET /api/models**: List Ollama models.  
- **GET /api/external-models**: List cloud provider models.  
- **POST /api/update-endpoints**: Update backend configuration via UI.  
- **GET /api/tts/models**: List available TTS models.  
- **POST /api/tts/set-model**: Load a specific TTS model.  
- **POST /api/tts/sample**: Generate sample TTS audio.

---

## 🔊 WebSocket Events (Real-time Voice)

Flask-SocketIO handles real-time voice interactions:

- **Client -> Server**: `connect`, `disconnect`, `get_voice_config`, `set_voice_settings`, `start_voice`, `audio_chunk`, `stop_voice`, `request_tts`  
- **Server -> Client**: `voice_config`, `voice_started`, `voice_processing`, `voice_synthesis`, `voice_result`, `voice_error`, `voice_audio_chunk`, `voice_speak_end`

---

## 📂 Project Structure

```
.
├── app.py                  # Main Flask application
├── config.py               # Backend configuration
├── sockets.py              # WebSocket handlers
├── utils.py                # Utility functions
├── requirements.txt        # Python dependencies
├── .env                    # Environment variables (add to .gitignore)
├── chat_histories/         # Chat history JSON files
├── routes/                 # Flask Blueprints for API
│   ├── chat.py
│   ├── comfyui.py
│   ├── models.py
│   ├── settings.py
│   └── tts.py
├── services/               # Backend logic
│   ├── audio_utils.py
│   ├── history_manager.py
│   ├── llm_backends.py
│   ├── stt_service.py
│   └── tts_service.py
├── static/                 # Frontend files
│   ├── app.js
│   ├── api.js
│   ├── chat_listeners.js
│   ├── config.js
│   ├── dom.js
│   ├── settings_listeners.js
│   ├── state.js
│   ├── styles.css
│   ├── ui.js
│   ├── voice_listeners.js
│   ├── chat-icon.png
│   ├── profile.png
│   └── title.png
└── Index.html              # Main HTML frontend
```

---

## 🔮 Future Improvements

- Enhance mobile responsiveness.  
- Add UI language selection for STT/TTS.  
- Support streaming for non-Ollama backends.  
- Improve error handling and user feedback.  
- Enable speaker cloning for XTTS via audio upload.  
- Implement advanced frontend state management.  
- Add unit and integration tests.  
- Refine LLM prompt formatting.  
- Support multiple ComfyUI workflows.

---

## 🤝 Contributing

Contributions are welcome! Please:  
1. Fork the repository.  
2. Create a feature branch (`git checkout -b feature/YourFeature`).  
3. Commit changes (`git commit -m 'Add YourFeature'`).  
4. Push to the branch (`git push origin feature/YourFeature`).  
5. Open a Pull Request.

Ensure code is well-documented and follows the project’s style.

---

**💖 Support Our Work**

We are passionate about building innovative tools like Cosmo AI to empower users and advance AI accessibility. Your support fuels our motivation to create impactful projects that benefit the community. If you find Cosmo AI valuable, consider contributing financially to help us continue this journey.

Support us via UPI: mryogeshkumar@icici

Every contribution, big or small, makes a difference and inspires us to keep innovating. Thank you for being part of our mission!

---

## 📜 License

[MIT License](LICENSE) (or specify your chosen license).

---

## 📝 Notes

- **Generate `requirements.txt`**: Run `pip freeze > requirements.txt` after installing dependencies.  
- **Protect Sensitive Data**: Add `.env`, `.venv/`, and `__pycache__/` to `.gitignore`.  
- **Full Documentation**: View the [web interface](index.html) for additional details.

> **Enjoy building with Cosmo AI!** 🚀
