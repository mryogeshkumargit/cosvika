// File: static/config.js
export const API_BASE_URL = '/api';
export const MODELS_API = `${API_BASE_URL}/models`; // Ollama models
export const EXTERNAL_MODELS_API = `${API_BASE_URL}/external-models`; // New endpoint for external provider models
export const GENERATE_API = `${API_BASE_URL}/generate`; // Text generation
export const IMAGE_API = `${API_BASE_URL}/generate-image`; // Image generation
export const UPDATE_ENDPOINTS_API = `${API_BASE_URL}/update-endpoints`;
export const CANCEL_API = `${API_BASE_URL}/cancel`;
export const COMFYUI_STATUS_API = `${API_BASE_URL}/comfyui-status`;
export const COMFYUI_CHECKPOINTS_API = `${API_BASE_URL}/comfyui-checkpoints`;
export const CHATS_API = `${API_BASE_URL}/chats`; // GET list of chats
export const CHAT_HISTORY_API = (chatId) => `${API_BASE_URL}/chat/${chatId}`; // GET, POST, DELETE specific chat

// New TTS API Endpoints
export const TTS_MODELS_API = `${API_BASE_URL}/tts/models`;
export const TTS_SET_MODEL_API = `${API_BASE_URL}/tts/set-model`;
export const TTS_SAMPLE_API = `${API_BASE_URL}/tts/sample`;

export const HISTORY_CONTEXT_LENGTH = 20; // Keep N most recent message pairs sent to backend
export const IMAGE_TRIGGER_PHRASE = "send your photo";

// Default ComfyUI workflow structure (can be overridden by upload/state)
export const DEFAULT_COMFYUI_WORKFLOW = {
    "3": {"inputs": {"seed": 0, "steps": 25, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}, "class_type": "KSampler"},
    "4": {"inputs": {"ckpt_name": "SDXL\\DreamShaperXL_Turbo_V2-SFW.safetensors"}, "class_type": "CheckpointLoaderSimple"},
    "5": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
    "6": {"inputs": {"text": "INPUT_PROMPT", "clip": ["4", 1]}, "class_type": "CLIPTextEncode"},
    "7": {"inputs": {"text": "text, watermark, low quality, medium quality, blurry, deformed, disfigured", "clip": ["4", 1]}, "class_type": "CLIPTextEncode"},
    "8": {"inputs": {"image": "", "upload": "image"}, "class_type": "LoadImage"},
    "9": {"inputs": {"filename_prefix": "CosmoAI_Output", "images": ["11", 0]}, "class_type": "SaveImage"},
    "10": {"inputs": {"weight": 1.0, "image": ["8", 0], "model": ["4", 0]}, "class_type": "IPAdapter"},
    "11": {"inputs": {"samples": ["3", 0], "vae": ["4", 2]}, "class_type": "VAEDecode"}
};
// Default ComfyUI settings (values for the UI controls)
export const DEFAULT_COMFYUI_SETTINGS = {
    checkpoint: "SDXL\\DreamShaperXL_Turbo_V2-SFW.safetensors",
    width: 512,
    height: 512,
    seed: 0, // 0 means random in UI -> will be converted to actual random seed before sending
    steps: 25,
    cfg: 7.0,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1.0
};