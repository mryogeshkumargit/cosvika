// File: static/dom.js
// --- DOM Element References --- (Exported for use in other modules)

// Main layout containers
export const appContainer = document.getElementById('appContainer');
export const chatSettingsFrame = document.getElementById('chatSettingsFrame'); // Combined Frame
export const panelContent = document.getElementById('panelContent'); // Content within left frame (chat list/actions)
export const mainContent = document.querySelector('.main-content');
export const profile = document.querySelector('.profile');
export const settingsPanel = document.getElementById('settingsPanel'); // The actual settings view

// Chat list and area
export const chatList = document.getElementById('chatList');
export const chatArea = document.getElementById('chatArea'); // In main-content
export const newChatBtn = document.getElementById('newChatBtn');
export const deleteChatBtn = document.getElementById('deleteChatBtn');

// Input area
export const messageInput = document.getElementById('messageInput');
export const sendBtn = document.querySelector('.send-btn');
export const micBtn = document.querySelector('.mic-btn');
export const voiceStatusIndicator = document.getElementById('voiceStatusIndicator');

// Profile panel elements
export const profileImage = document.getElementById('profileImage');
export const imageSection = document.getElementById('imageSection');
export const generatedImage = document.getElementById('generatedImage');
export const imageHistoryContainer = document.querySelector('.image-history-container');
export const imageHistoryDiv = document.getElementById('imageHistory');
export const generateMorePhotosBtn = document.getElementById('generateMorePhotosBtn');

// Panel toggle buttons
export const chatFrameToggleBtn = document.getElementById('chatFrameToggleBtn');
export const profileToggleBtn = document.getElementById('profileToggleBtn');

// Settings panel elements (within settingsPanel)
export const settingsSection = document.getElementById('settingsSection'); // The button container at bottom
export const settingsBtn = document.getElementById('settingsBtn');
export const settingsCloseBtn = document.getElementById('settingsCloseBtn');
export const backendSelect = document.getElementById('backendSelect');

// Model Selection Elements
export const modelSelect = document.getElementById('modelSelect'); // For Ollama
export const externalModelSelect = document.getElementById('externalModelSelect'); // New dropdown for external models
export const externalModelInput = document.getElementById('externalModelInput'); // Text input fallback/custom
export const externalModelStatus = document.getElementById('externalModelStatus'); // Loading/Error indicator

// Status Elements
export const comfyUIStatusElement = document.getElementById('comfyUIStatus'); // Keep for text status in settings if needed
export const comfyUIConnectBtn = document.getElementById('comfyUIConnectBtn');

// --- Status Indicators (in left panel) ---
export const statusIndicators = document.getElementById('statusIndicators');
export const comfyuiIndicator = document.getElementById('comfyuiIndicator');
export const voiceIndicator = document.getElementById('voiceIndicator');
export const saveIndicator = document.getElementById('saveIndicator');

// Settings - API Inputs
export const ollamaApiInput = document.getElementById('ollamaApiInput');
export const koboldApiInput = document.getElementById('koboldApiInput');
export const comfyUIApiInput = document.getElementById('comfyUIApiInput');
// Provider Keys
export const groqApiKeyInput = document.getElementById('groqApiKeyInput');
export const openaiApiKeyInput = document.getElementById('openaiApiKeyInput');
export const googleApiKeyInput = document.getElementById('googleApiKeyInput');
export const anthropicApiKeyInput = document.getElementById('anthropicApiKeyInput');
export const xaiApiKeyInput = document.getElementById('xaiApiKeyInput');
// Custom Provider
export const customModelNameInput = document.getElementById('customModelNameInput');
export const customApiEndpointInput = document.getElementById('customApiEndpointInput');
export const customApiKeyInput = document.getElementById('customApiKeyInput');
// ==================================

// Settings - General Buttons
export const toggleThemeBtn = document.getElementById('toggleThemeBtn');
export const clearHistoryBtn = document.getElementById('clearHistoryBtn');

// Settings - ComfyUI Inputs & Buttons
export const workflowUploadInput = document.getElementById('workflowUpload');
export const workflowFileNameSpan = document.getElementById('workflowFileName');
export const checkpointInput = document.getElementById('checkpointInput');
export const widthInput = document.getElementById('widthInput');
export const heightInput = document.getElementById('heightInput');
export const seedInput = document.getElementById('seedInput');
export const stepsInput = document.getElementById('stepsInput');
export const cfgInput = document.getElementById('cfgInput');
export const samplerInput = document.getElementById('samplerInput');
export const schedulerInput = document.getElementById('schedulerInput');
export const denoiseInput = document.getElementById('denoiseInput');
export const saveComfyUISettingsBtn = document.getElementById('saveComfyUISettingsBtn');
export const resetComfyUISettingsBtn = document.getElementById('resetComfyUISettingsBtn');

// Settings - Voice Inputs & Buttons
export const voiceEnableToggle = document.getElementById('voiceEnableToggle');
export const micSelect = document.getElementById('micSelect');
export const sttLanguageSelect = document.getElementById('sttLanguageSelect');
export const ttsModelSelect = document.getElementById('ttsModelSelect'); // New
export const ttsModelStatus = document.getElementById('ttsModelStatus'); // New
// export const loadTtsModelBtn = document.getElementById('loadTtsModelBtn'); // Optional
export const ttsEnableToggle = document.getElementById('ttsEnableToggle');
export const voiceSelect = document.getElementById('voiceSelect'); // Existing, now for speakers
export const sampleVoiceBtn = document.getElementById('sampleVoiceBtn'); // New
export const voiceSpeedSlider = document.getElementById('voiceSpeedSlider');
export const voiceSpeedValue = document.getElementById('voiceSpeedValue');
export const voicePitchSlider = document.getElementById('voicePitchSlider');
export const voicePitchValue = document.getElementById('voicePitchValue');
export const interactionModeSelect = document.getElementById('interactionModeSelect');
export const replayBtn = document.getElementById('replayBtn');
export const stopAudioBtn = document.getElementById('stopAudioBtn');