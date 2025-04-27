// File: static/app.js - Main Application Entry Point
import * as dom from './dom.js'; // Import DOM element references
import * as state from './state.js'; // Import state management functions and variables
import * as api from './api.js'; // Import API interaction functions
import * as ui from './ui.js'; // Import UI manipulation functions
import * as cfg from './config.js';
// Import listener setup functions from the new files
import { setupChatEventListeners, loadChat } from './chat_listeners.js';
import { setupSettingsEventListeners } from './settings_listeners.js';
import { setupVoiceEventListeners, setupSocketIO, populateMicrophoneList } from './voice_listeners.js'; // Import setupSocketIO and populateMicrophoneList

// --- Initialization Sequence ---
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM fully loaded.');

    // Check for essential DOM elements
    if (!dom.appContainer || !dom.chatList || !dom.chatArea || !dom.messageInput) {
        console.error("Essential DOM elements not found. Aborting initialization.");
        document.body.innerHTML = "<p style='color:red; padding: 20px;'>Error: Failed to initialize UI. Essential elements missing.</p>";
        return;
    }

    // 1. Configure Libraries (e.g., Marked)
    ui.configureMarked();

    // 2. Load Persisted State
    // This loads theme, panel visibility, active chat ID, backend, model, endpoints, keys, settings, TTS selection etc.
    const activeChatIdFromState = state.loadAppState(); // Returns the ID of the chat to load
    state.loadApiEndpoints(); // Loads/migrates API endpoints and keys
    state.loadComfyUISettings(); // Loads ComfyUI settings
    state.loadComfyWorkflow(); // Loads ComfyUI workflow

    // 3. Apply Static Loaded State to UI Elements
    // Apply theme and panel collapse states
    dom.appContainer.classList.toggle('chat-settings-frame-collapsed', state.isChatFrameCollapsed);
    dom.appContainer.classList.toggle('profile-collapsed', state.isProfileCollapsed);
    // Populate API fields from loaded state
    if (dom.ollamaApiInput) dom.ollamaApiInput.value = state.apiEndpoints.ollama || '';
    if (dom.koboldApiInput) dom.koboldApiInput.value = state.apiEndpoints.kobold || '';
    if (dom.comfyUIApiInput) dom.comfyUIApiInput.value = state.apiEndpoints.comfyui || '';
    // Provider Keys
    if (dom.groqApiKeyInput) dom.groqApiKeyInput.value = state.apiEndpoints.groqApiKey || '';
    if (dom.openaiApiKeyInput) dom.openaiApiKeyInput.value = state.apiEndpoints.openaiApiKey || '';
    if (dom.googleApiKeyInput) dom.googleApiKeyInput.value = state.apiEndpoints.googleApiKey || '';
    if (dom.anthropicApiKeyInput) dom.anthropicApiKeyInput.value = state.apiEndpoints.anthropicApiKey || '';
    if (dom.xaiApiKeyInput) dom.xaiApiKeyInput.value = state.apiEndpoints.xaiApiKey || '';
    // Custom Details (using renamed state keys)
    if (dom.customModelNameInput) dom.customModelNameInput.value = state.apiEndpoints.customModelName || '';
    if (dom.customApiEndpointInput) dom.customApiEndpointInput.value = state.apiEndpoints.customApiEndpoint || '';
    if (dom.customApiKeyInput) dom.customApiKeyInput.value = state.apiEndpoints.customApiKey || '';
    // Set backend dropdown value from loaded state
    if (dom.backendSelect) dom.backendSelect.value = state.currentBackend;
    // Set generic external model input field value based on loaded state if not Ollama/Kobold
    if (dom.externalModelInput && !['ollama', 'kobold'].includes(state.currentBackend)) {
         dom.externalModelInput.value = state.currentModel || '';
    }
    // Update workflow file name display
    if (dom.workflowFileNameSpan) {
        dom.workflowFileNameSpan.textContent = localStorage.getItem('comfyUIWorkflow')
            ? "Using saved workflow."
            : "Using default workflow.";
    }

    // 4. Setup Event Listeners for all interactive elements
    // Call setup functions from the specialized listener files
    setupChatEventListeners();
    setupSettingsEventListeners();
    setupVoiceEventListeners(); // Sets up listeners for voice tab controls + mic button

    // 5. Fetch Initial Dynamic Data & Populate Corresponding UI Parts
    // Fetch chat list from backend
    try {
        const knownChats = await api.makeApiRequest(cfg.CHATS_API, { method: 'GET' });
        if (knownChats.status === 'success' && Array.isArray(knownChats.chats)) {
            state.setKnownChatList(knownChats.chats);
        } else {
             console.error("Failed to fetch chat list:", knownChats.message);
             state.setKnownChatList([]); // Ensure list is empty on failure
        }
    } catch (error) {
        console.error("Error fetching chat list:", error);
        state.setKnownChatList([]); // Ensure list is empty on error
    }
    ui.renderChatList(); // Render the chat list from state

    // Fetch models/status for selected backend and ComfyUI
    if (state.currentBackend === 'ollama') {
        await api.fetchOllamaModels(); // Fetches and populates Ollama dropdown
    } else if (['groq', 'openai', 'google'].includes(state.currentBackend)) {
        // Fetch external models if backend requires it and key is likely present
         const apiKeyInputId = `${state.currentBackend}ApiKeyInput`;
         const apiKeyInput = document.getElementById(apiKeyInputId);
         if (apiKeyInput?.value?.trim()) {
             api.fetchExternalModels(state.currentBackend).then(models => {
                 ui.populateExternalModelSelect(models, state.currentBackend);
             });
         } else {
             ui.populateExternalModelSelect([], state.currentBackend); // Clear/show placeholder
         }
    } else {
        // Clear external select for other backends
        ui.populateExternalModelSelect([], state.currentBackend);
    }
    await api.checkComfyUIStatus(); // Checks status and updates indicator
    ui.populateComfyUISettingsForm(); // Populate standard comfy settings form fields
    await api.fetchComfyCheckpoints(); // Fetches checkpoints and updates dropdown/form

    // Fetch available TTS models
    const availableTTSModels = await api.fetchTTSModels();
    ui.populateTTSModelSelect(availableTTSModels); // Populate TTS model dropdown

    // 6. Setup Socket.IO Connection (will trigger 'voice_config' event upon connection)
    // Only connect if voice is enabled in settings
    if(state.voiceSettings.enabled) {
        setupSocketIO();
    } else {
        console.log("Voice mode disabled in settings, skipping Socket.IO connection.");
        ui.updateVoiceIndicator('disconnected'); // Show disconnected
    }

    // 7. Populate Voice Settings Form (partially - relies on 'voice_config' for speaker list)
    // This sets sliders, checkboxes etc. based on loaded state BEFORE socket config arrives
    ui.populateVoiceSettingsForm(state.voiceSettings);
    // Populate microphone list initially (might re-populate later)
    populateMicrophoneList();

    // 8. Load the Initial Chat View
    let initialChatElement = null;
    // Try to find the element corresponding to the loaded activeChatId
    if (activeChatIdFromState && dom.chatList) {
        initialChatElement = dom.chatList.querySelector(`.chat-item[data-chat-id="${activeChatIdFromState}"]`);
    }
    // If active chat not found or wasn't set, try loading the first chat in the list
    if (!initialChatElement && state.knownChatList.length > 0 && dom.chatList) {
        const firstChatId = state.knownChatList[0].id;
        initialChatElement = dom.chatList.querySelector(`.chat-item[data-chat-id="${firstChatId}"]`);
    }

    // Load the determined chat or the default empty view
    if (initialChatElement) {
        await loadChat(initialChatElement.dataset.chatId, initialChatElement, null);
    } else {
        await loadChat(null, null, null); // Load default empty view
    }

    // 9. Update Toggle Button Titles/Icons based on initial panel state
    ui.updateToggleButtonTitles();

    // 10. Show/hide External/Provider API fields based on the loaded backend
    ui.toggleExternalApiInputs(state.currentBackend);

    console.log('Cosmo AI GUI initialized.');
});