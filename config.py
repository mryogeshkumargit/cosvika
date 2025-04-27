# File: config.py
import os
import torch

# --- Basic Server Config ---
HISTORY_DIR = "chat_histories"
DEFAULT_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# --- API Endpoints ---
OLLAMA_API = os.getenv("OLLAMA_API", "http://localhost:11435")
KOBOLD_API = os.getenv("KOBOLD_API", "http://localhost:5001/api/v1/generate")
# *** CORRECTED LINE: Added quotes around the default URL ***
COMFYUI_API_BASE = os.getenv("COMFYUI_API", "http://127.0.0.1:8188")

# --- External Provider API Keys ---
# Use os.getenv to allow overriding, provide defaults
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "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")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "AIzaSyAezt8agF0yTVvlx6j2bhVDwSm82RvLFhY")
XAI_API_KEY = os.getenv("XAI_API_KEY", "")

# --- Custom Provider Config ---
CUSTOM_API_MODEL_NAME = os.getenv("CUSTOM_API_MODEL_NAME", "")
CUSTOM_API_ENDPOINT = os.getenv("CUSTOM_API_ENDPOINT", "")
CUSTOM_API_KEY = os.getenv("CUSTOM_API_KEY", "")

# --- Model Specific Config ---
KOBOLD_CONTEXT_LIMIT = int(os.getenv("KOBOLD_CONTEXT_LIMIT", 4096))

# --- STT (Whisper) Config ---
WHISPER_MODEL_NAME = os.getenv("WHISPER_MODEL", "base.en")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", DEFAULT_DEVICE)
DEFAULT_WHISPER_COMPUTE_TYPE = "float16" if WHISPER_DEVICE == "cuda" else "int8"
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", DEFAULT_WHISPER_COMPUTE_TYPE)

# --- TTS (Coqui) Config ---
TTS_MODEL_NAME = os.getenv("TTS_MODEL", "tts_models/en/ljspeech/tacotron2-DDC")
TTS_USE_GPU = DEFAULT_DEVICE == "cuda"
DEFAULT_TTS_MODELS_LIST = [
    "tts_models/multilingual/multi-dataset/xtts_v2",
    "tts_models/multilingual/multi-dataset/xtts_v1.1",
    "tts_models/multilingual/multi-dataset/your_tts",
    "tts_models/multilingual/multi-dataset/bark",
    "tts_models/en/ljspeech/tacotron2-DDC",
    "tts_models/en/jenny/jenny",
    "tts_models/en/vctk/vits",
]

# --- ComfyUI Workflow Config ---
DEFAULT_WORKFLOW_TEMPLATE = {
    "3": {"inputs": {"seed": 1, "steps": 25, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}, "class_type": "KSampler"},
    "4": {"inputs": {"ckpt_name": "SDXL\\DreamShaperXL_Turbo_V2-SFW.safetensors"}, "class_type": "CheckpointLoaderSimple"},
    "5": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
    "6": {"inputs": {"text": "INPUT_PROMPT", "clip": ["4", 1]}, "class_type": "CLIPTextEncode"},
    "7": {"inputs": {"text": "text, watermark, low quality, medium quality, blurry, deformed, disfigured", "clip": ["4", 1]}, "class_type": "CLIPTextEncode"},
    "8": {"inputs": {"image": "", "upload": "image"}, "class_type": "LoadImage"},
    "9": {"inputs": {"filename_prefix": "CosmoAI_Output", "images": ["11", 0]}, "class_type": "SaveImage"},
    "10": {"inputs": {"weight": 1.0, "image": ["8", 0], "model": ["4", 0]}, "class_type": "IPAdapter"},
    "11": {"inputs": {"samples": ["3", 0], "vae": ["4", 2]}, "class_type": "VAEDecode"}
}
# Node IDs (Consider making these configurable if workflows change often)
POSITIVE_PROMPT_NODE_ID = "6"
CHECKPOINT_NODE_ID = "4"
KSAMPLER_NODE_ID = "3"
LATENT_IMAGE_NODE_ID = "5"
OUTPUT_NODE_ID = "9"

# --- Global Mutable State References (Initialized in app.py) ---
# These will hold the actual loaded models and shared state
# This avoids circular imports if services need config
state = {
    "stt_model": None,
    "stt_loaded": False,
    "tts_model": None,
    "tts_loaded": False,
    "current_tts_model_name": TTS_MODEL_NAME,
    "available_tts_models": [],
    "active_tasks": {},
    "task_lock": None, # Will be initialized in app.py
    "active_voice_clients": {}
}