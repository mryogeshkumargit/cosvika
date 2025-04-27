// File: static/state.js
import { DEFAULT_COMFYUI_WORKFLOW, DEFAULT_COMFYUI_SETTINGS } from './config.js';
import * as dom from './dom.js'; // Import DOM elements for use in persistence functions

// --- Global State --- (Exported for modification by other modules)
export let currentBackend = 'ollama';
export let currentModel = ''; // For Ollama or selected external model
export let activeChatElement = null;
export let isDarkTheme = false;
export let chatIdCounter = 1;
export let activeChatMessages = []; // Messages for the currently loaded chat
export let activeChatImages = []; // Image URLs for the currently loaded chat
export let knownChatList = []; // [{id: 'chat-1', name: 'Chat 1'}, ...] List of known chat IDs/names
export let isGenerating = false; // Flag for ongoing AI generation (text or image)
export let lastGeneratedFacePrompt = null; // Last prompt used with 'send your photo'
export let lastGeneratedImageUrl = null; // URL of last image shown in main view
export let activeChatId = null; // ID of the currently loaded chat
// === Updated apiEndpoints with all provider keys ===
export let apiEndpoints = {
    ollama: 'http://localhost:11435',
    kobold: 'http://localhost:5001/api/v1/generate',
    comfyui: 'http://127.0.0.1:8188',
    // Provider API Keys
    groqApiKey: '',
    openaiApiKey: '',
    googleApiKey: '',
    anthropicApiKey: '',
    xaiApiKey: '',
    // Custom External API Details
    customModelName: '', // Renamed from externalModelName
    customApiEndpoint: '', // Renamed from externalApiEndpoint
    customApiKey: '' // Renamed from externalApiKey
};
// ===============================================
export let comfyUIWorkflow = JSON.parse(JSON.stringify(DEFAULT_COMFYUI_WORKFLOW)); // Deep copy defaults
export let comfyUISettings = JSON.parse(JSON.stringify(DEFAULT_COMFYUI_SETTINGS)); // Deep copy defaults
export let currentClientId = null; // UUID for the current generation task
export let isChatFrameCollapsed = false; // State for **combined** left panel visibility
export let isProfileCollapsed = false; // State for right panel visibility

// --- Voice State ---
export let voiceSettings = { // Default voice settings
    enabled: false,
    micId: 'default',
    sttLanguage: 'en',
    ttsEnabled: false,
    ttsSpeaker: 'default', // Default speaker preference (used for multi-speaker models)
    ttsSpeed: 1.0,
    ttsPitch: 1.0,
    interactionMode: 'hybrid',
};
export let isSpeaking = false; // Is TTS currently playing?
export let isVoiceActive = false; // Is microphone actively recording?
export let lastPlayedAudioBuffer = null; // Buffer for replay function
export let WHISPER_LOADED_ON_BACKEND = false; // Status from backend
export let TTS_LOADED_ON_BACKEND = false;   // Status from backend
export let AVAILABLE_TTS_MODELS = [];       // List from backend
export let selectedTTSModelName = ''; // User's selection in dropdown
export let currentTTSModelName = ''; // Model confirmed loaded by backend
export let currentTTSSpeakers = []; // Speakers for the currently loaded model
export let ttsModelLoading = false; // Flag for model loading process

// --- State Setters --- (Functions to modify state)
export function setCurrentBackend(backend) { currentBackend = backend; }
export function setCurrentModel(model) { currentModel = model; }
export function setActiveChatElement(element) { activeChatElement = element; }
export function setIsDarkTheme(isDark) { isDarkTheme = isDark; }
export function setChatIdCounter(count) { chatIdCounter = count; }
export function setActiveChatMessages(messages) { activeChatMessages = messages; }
export function setActiveChatImages(images) { activeChatImages = images; }
export function setKnownChatList(list) { knownChatList = list; }
export function setIsGenerating(generating) { isGenerating = generating; }
export function setLastGeneratedFacePrompt(prompt) { lastGeneratedFacePrompt = prompt; }
export function setLastGeneratedImageUrl(url) { lastGeneratedImageUrl = url; }
export function setActiveChatId(id) { activeChatId = id; }
export function setApiEndpoints(endpoints) { apiEndpoints = endpoints; }
export function setComfyUIWorkflow(workflow) { comfyUIWorkflow = workflow; }
export function setComfyUISettings(settings) { comfyUISettings = settings; }
export function setCurrentClientId(id) { currentClientId = id; }
export function setIsChatFrameCollapsed(collapsed) { isChatFrameCollapsed = collapsed; }
export function setIsProfileCollapsed(collapsed) { isProfileCollapsed = collapsed; }
// Voice state setters
export function setVoiceSettings(settings) { voiceSettings = settings; }
export function setIsSpeaking(speaking) { isSpeaking = speaking; }
export function setIsVoiceActive(active) { isVoiceActive = active; }
export function setLastPlayedAudioBuffer(buffer) { lastPlayedAudioBuffer = buffer; }
export function setWhisperLoaded(loaded) { WHISPER_LOADED_ON_BACKEND = loaded; }
export function setTTSLoaded(loaded) { TTS_LOADED_ON_BACKEND = loaded; }
export function setAvailableTTSModels(models) { AVAILABLE_TTS_MODELS = models; } // New
export function setSelectedTTSModelName(name) { selectedTTSModelName = name; } // New
export function setCurrentTTSModelName(name) { currentTTSModelName = name; } // New
export function setCurrentTTSSpeakers(speakers) { currentTTSSpeakers = speakers; } // New
export function setTTSModelLoading(loading) { ttsModelLoading = loading; } // New


// --- Persistence Functions ---

/** Saves essential UI state (theme, panel visibility, active chat, etc.) */
export function saveAppState() {
    try {
        const stateToSave = {
            activeChatId: activeChatId,
            backend: currentBackend,
            model: currentModel, // Save selected Ollama model or external model name
            theme: isDarkTheme ? 'dark' : 'light',
            nextChatId: chatIdCounter,
            isChatFrameCollapsed: isChatFrameCollapsed,
            isProfileCollapsed: isProfileCollapsed,
            selectedTTSModelName: selectedTTSModelName, // Save user's TTS model selection
            voiceSettings: voiceSettings, // Save full voice settings object
        };
        localStorage.setItem('appState', JSON.stringify(stateToSave));
        // Optional: Save voice settings separately if still needed
        // localStorage.setItem('voiceSettings', JSON.stringify(voiceSettings));
    } catch (e) { console.error("Failed to save app state:", e); }
}

/** Loads essential UI state on startup */
export function loadAppState() {
    let activeChatIdToLoad = null;
    try {
        const saved = localStorage.getItem('appState');
        if (saved) {
            const loadedState = JSON.parse(saved);
            console.log("App state loaded:", loadedState);
            // Apply loaded state using setters
            setCurrentBackend(loadedState.backend || 'ollama');
            setCurrentModel(loadedState.model || '');
            setIsDarkTheme(loadedState.theme === 'dark');
            activeChatIdToLoad = loadedState.activeChatId || null; // Keep track of ID to load
            setChatIdCounter(loadedState.nextChatId || 1);
            setIsChatFrameCollapsed(loadedState.isChatFrameCollapsed || false); // Combined panel state
            setIsProfileCollapsed(loadedState.isProfileCollapsed || false);
            setSelectedTTSModelName(loadedState.selectedTTSModelName || ''); // Load TTS model selection

            // Load voice settings from the bundle
            if(loadedState.voiceSettings && typeof loadedState.voiceSettings === 'object') {
                 setVoiceSettings({ ...voiceSettings, ...loadedState.voiceSettings }); // Merge with defaults
            } else {
                 console.warn("Voice settings missing or invalid in appState, using defaults.");
                 setVoiceSettings(voiceSettings); // Ensure defaults are set
            }

            // Apply theme class immediately
            document.body.classList.toggle('dark-theme', isDarkTheme);

        } else {
             console.log("No app state found, using defaults.");
             // Ensure defaults are set if no saved state
             setCurrentBackend('ollama'); setCurrentModel(''); setIsDarkTheme(false);
             document.body.classList.remove('dark-theme'); setChatIdCounter(1);
             setIsChatFrameCollapsed(false); setIsProfileCollapsed(false);
             setSelectedTTSModelName('');
             setVoiceSettings(voiceSettings); // Set default voice settings
             // Save defaults if nothing was loaded
             saveAppState();
        }
    } catch (e) {
        console.error("Failed to load app state:", e);
        // Apply defaults on error
        setCurrentBackend('ollama'); setCurrentModel(''); setIsDarkTheme(false);
        document.body.classList.remove('dark-theme'); setChatIdCounter(1);
        setIsChatFrameCollapsed(false); setIsProfileCollapsed(false);
        setSelectedTTSModelName(''); setVoiceSettings(voiceSettings);
    }
    // Apply voice settings to UI happens later in initialization
    return activeChatIdToLoad;
}

/** Loads API endpoints and keys from localStorage */
export function loadApiEndpoints() {
    try {
        const saved = localStorage.getItem('apiEndpoints');
        let loadedEndpoints = {};
        if (saved) {
            loadedEndpoints = JSON.parse(saved);
        }

        // --- START Remove Migration Logic ---
        // Old keys (externalName, externalUrl, externalKey) are no longer needed
        // --- END Remove Migration Logic ---


        // Merge loaded with defaults to ensure all *current* keys exist
        // Explicitly define all expected keys here
        apiEndpoints = {
            ollama: loadedEndpoints.ollama ?? 'http://localhost:11435',
            kobold: loadedEndpoints.kobold ?? 'http://localhost:5001/api/v1/generate',
            comfyui: loadedEndpoints.comfyui ?? 'http://127.0.0.1:8188',
            // Provider keys
            groqApiKey: loadedEndpoints.groqApiKey ?? '',
            openaiApiKey: loadedEndpoints.openaiApiKey ?? '',
            googleApiKey: loadedEndpoints.googleApiKey ?? '',
            anthropicApiKey: loadedEndpoints.anthropicApiKey ?? '',
            xaiApiKey: loadedEndpoints.xaiApiKey ?? '',
            // Custom API
            customModelName: loadedEndpoints.customModelName ?? '',
            customApiEndpoint: loadedEndpoints.customApiEndpoint ?? '',
            customApiKey: loadedEndpoints.customApiKey ?? ''
        };

        console.log('API endpoints loaded from localStorage:', apiEndpoints);
        // Save back potentially defaulted state
        localStorage.setItem('apiEndpoints', JSON.stringify(apiEndpoints));

    } catch (e) {
        console.error('Failed to load or parse API endpoints from localStorage:', e);
        // On error, reset to ensure defaults are used and saved
         apiEndpoints = {
             ollama: 'http://localhost:11435',
             kobold: 'http://localhost:5001/api/v1/generate',
             comfyui: 'http://127.0.0.1:8188',
             groqApiKey: '',
             openaiApiKey: '',
             googleApiKey: '',
             anthropicApiKey: '',
             xaiApiKey: '',
             customModelName: '',
             customApiEndpoint: '',
             customApiKey: ''
         };
         localStorage.setItem('apiEndpoints', JSON.stringify(apiEndpoints));
    }
}

/** Loads ComfyUI settings from localStorage */
export function loadComfyUISettings() {
    try {
        const saved = localStorage.getItem('comfyUISettings');
        if (saved) {
            const loadedSettings = JSON.parse(saved);
            if (typeof loadedSettings === 'object' && loadedSettings !== null) {
                // Merge loaded settings with defaults to ensure all keys exist
                comfyUISettings = { ...DEFAULT_COMFYUI_SETTINGS, ...loadedSettings };
                console.log("ComfyUI settings loaded from localStorage.");
            } else {
                console.warn("Invalid ComfyUI settings format in localStorage, using defaults.");
                comfyUISettings = JSON.parse(JSON.stringify(DEFAULT_COMFYUI_SETTINGS));
                localStorage.setItem('comfyUISettings', JSON.stringify(comfyUISettings));
            }
        } else {
             console.log("No ComfyUI settings found, using defaults.");
             comfyUISettings = JSON.parse(JSON.stringify(DEFAULT_COMFYUI_SETTINGS));
             localStorage.setItem('comfyUISettings', JSON.stringify(comfyUISettings));
        }
    } catch (e) {
        console.error("Failed to load or parse ComfyUI settings:", e);
        comfyUISettings = JSON.parse(JSON.stringify(DEFAULT_COMFYUI_SETTINGS));
    }
}

/** Loads ComfyUI workflow from localStorage */
export function loadComfyWorkflow() {
    try {
        const saved = localStorage.getItem('comfyUIWorkflow');
        if (saved) {
            const loadedWorkflow = JSON.parse(saved);
            // Basic validation: check if it's an object and has some common keys
            if (typeof loadedWorkflow === 'object' && loadedWorkflow !== null && loadedWorkflow["3"] && loadedWorkflow["4"]) {
                comfyUIWorkflow = loadedWorkflow;
                console.log("ComfyUI workflow loaded from localStorage.");
            } else {
                console.warn("Invalid workflow format in localStorage, using default.");
                comfyUIWorkflow = JSON.parse(JSON.stringify(DEFAULT_COMFYUI_WORKFLOW));
                localStorage.setItem('comfyUIWorkflow', JSON.stringify(comfyUIWorkflow));
            }
        } else {
             console.log("No ComfyUI workflow found, using default.");
             comfyUIWorkflow = JSON.parse(JSON.stringify(DEFAULT_COMFYUI_WORKFLOW));
             localStorage.setItem('comfyUIWorkflow', JSON.stringify(comfyUIWorkflow));
        }
    } catch (e) {
        console.error("Failed to load or parse ComfyUI workflow:", e);
        comfyUIWorkflow = JSON.parse(JSON.stringify(DEFAULT_COMFYUI_WORKFLOW));
    }
}