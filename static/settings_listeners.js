// File: static/settings_listeners.js
import * as dom from './dom.js';
import * as state from './state.js';
import * as api from './api.js';
import * as ui from './ui.js';
import { DEFAULT_COMFYUI_SETTINGS } from './config.js'; // Import defaults for reset

// --- Settings Panel Action Functions (Moved from listeners.js) ---

/** Clears all chat histories from backend and resets UI. */
export async function clearHistory() {
    console.log("clearHistory function started.");
    // Double-check with the user due to destructive nature
    if (!confirm("WARNING: This will permanently delete ALL chat and image histories from the server and remove all chats from the list. This cannot be undone. Proceed?")) {
        return;
    }

    console.log("clearHistory: Clearing all chats from backend...");
    ui.setLoadingState(true); // Indicate processing

    // Get the list of chats to delete from the current state
    const chatsToDelete = [...state.knownChatList];
    const promises = [];
    console.log(`clearHistory: Found ${chatsToDelete.length} chats to delete.`);

    // Queue delete requests for all known chats
    chatsToDelete.forEach(chat => {
         console.log(`clearHistory: Queuing delete for ${chat.id}`);
         promises.push(
            api.makeApiRequest(cfg.CHAT_HISTORY_API(chat.id), { method: 'DELETE' })
                .catch(error => {
                    // Log errors but continue trying to delete others
                    console.error(`clearHistory: Error deleting chat ${chat.id}:`, error);
                    ui.appendMessage(`Error clearing chat ${chat.id}: ${error.message}`, 'error');
                })
         );
    });

    try {
        // Wait for all delete requests to finish
        await Promise.all(promises);
        console.log("clearHistory: Finished sending all delete requests.");
    } catch (e) {
        // Should not happen with the catch inside the loop, but log just in case
        console.error("clearHistory: Error during Promise.all (unexpected):", e);
    }

    // --- Reset Frontend State ---
    console.log("clearHistory: Clearing frontend state and UI.");
    // Remove all dynamic chat items from the UI list
    if (dom.chatList) {
        const dynamicChats = dom.chatList.querySelectorAll('.chat-item:not(.chat-item-static)');
        dynamicChats.forEach(item => item.remove());
    }
    // Clear state variables
    state.setKnownChatList([]);
    state.setActiveChatMessages([]);
    state.setActiveChatImages([]);
    state.setActiveChatElement(null);
    state.setActiveChatId(null);
    state.setChatIdCounter(1); // Reset counter

    // Load the default empty view - need to import loadChat
    import('./chat_listeners.js').then(chat => chat.loadChat(null, null, null));

    state.saveAppState(); // Persist the cleared state
    ui.setLoadingState(false); // Reset loading indicator
    ui.appendMessage("All chat and image history has been cleared from the server.", 'received');
    console.log("clearHistory function finished.");
}


/** Handles workflow JSON file upload, updates state, and saves to localStorage. */
export function handleWorkflowUpload(event) {
    console.log("handleWorkflowUpload triggered.");
    const file = event.target.files[0];
    if (!file) { console.log("No file selected."); return; }
    // Validate file type
    if (file.type !== 'application/json') {
         ui.appendMessage('Error: Please upload a valid JSON file for the workflow.', 'error');
         if (dom.workflowUploadInput) dom.workflowUploadInput.value = ''; // Clear input
         return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const workflowFromFile = JSON.parse(e.target.result);
            // Basic validation: Check if it's an object and has some expected keys
            if (typeof workflowFromFile !== 'object' || workflowFromFile === null) {
                throw new Error("Invalid JSON object.");
            }
            if (!workflowFromFile["3"] || !workflowFromFile["4"] || !workflowFromFile["6"] || !workflowFromFile["9"]) {
                 console.warn("Uploaded workflow missing standard nodes (KSampler, Loader, Prompt, Save?). Using anyway.");
            }
            // Update state and save to localStorage
            state.setComfyUIWorkflow(workflowFromFile);
            localStorage.setItem('comfyUIWorkflow', JSON.stringify(state.comfyUIWorkflow));
            // Update UI to show filename
            if (dom.workflowFileNameSpan) dom.workflowFileNameSpan.textContent = `Using: ${file.name}`;
            console.log("Workflow updated from file:", file.name);
        } catch (error) {
            ui.appendMessage('Error parsing workflow JSON: ' + error.message, 'error');
            if (dom.workflowFileNameSpan) dom.workflowFileNameSpan.textContent = "Error loading workflow!";
            if (dom.workflowUploadInput) dom.workflowUploadInput.value = ''; // Clear input on error
        }
    };
    reader.onerror = () => {
         ui.appendMessage('Error reading workflow file.', 'error');
         if (dom.workflowFileNameSpan) dom.workflowFileNameSpan.textContent = "Error reading file!";
         if (dom.workflowUploadInput) dom.workflowUploadInput.value = '';
    };
    reader.readAsText(file);
}

/** Saves ComfyUI settings from inputs to state and localStorage. */
export function saveComfyUISettings() {
    console.log("saveComfyUISettings function called.");
    // Ensure all required DOM elements are present
    const requiredElements = [ dom.checkpointInput, dom.widthInput, dom.heightInput, dom.seedInput, dom.stepsInput, dom.cfgInput, dom.samplerInput, dom.schedulerInput, dom.denoiseInput ];
    if (requiredElements.some(el => !el)) {
        console.error("Cannot save ComfyUI settings, form elements missing.");
        return;
    }

    try {
        // Read values from form elements and update state
        let newSettings = {
            checkpoint: dom.checkpointInput.value,
            width: parseInt(dom.widthInput.value) || 512,
            height: parseInt(dom.heightInput.value) || 512,
            seed: parseInt(dom.seedInput.value) || 0, // 0 signifies random
            steps: parseInt(dom.stepsInput.value) || 25,
            cfg: parseFloat(dom.cfgInput.value) || 7.0,
            sampler: dom.samplerInput.value || "euler",
            scheduler: dom.schedulerInput.value || "normal",
            denoise: parseFloat(dom.denoiseInput.value) || 1.0
        };
        state.setComfyUISettings(newSettings);
        // Save the updated settings object to localStorage
        localStorage.setItem('comfyUISettings', JSON.stringify(state.comfyUISettings));
        console.log("ComfyUI Settings saved:", state.comfyUISettings);
        // Optionally provide user feedback
        // ui.appendMessage('ComfyUI settings saved locally.', 'received');
    } catch (e) {
        console.error("Error saving ComfyUI settings:", e);
        ui.appendMessage('Error saving ComfyUI settings to local storage.', 'error');
    }
}

/** Resets ComfyUI settings to default values (from config.js) and saves. */
export function resetComfyUISettings() {
     if (!confirm("Reset all ComfyUI settings to their defaults?")) return;
     console.log("resetComfyUISettings function called.");
     // Use a deep copy of the default settings from config
     state.setComfyUISettings(JSON.parse(JSON.stringify(DEFAULT_COMFYUI_SETTINGS)));
     // Update the form elements to reflect these defaults
     ui.populateComfyUISettingsForm();
     // Save the reset defaults to localStorage
     localStorage.setItem('comfyUISettings', JSON.stringify(state.comfyUISettings));
     // Optionally provide user feedback
     // ui.appendMessage('ComfyUI settings reset to defaults.', 'received');
}

/** Toggles the combined Chat/Settings Frame visibility */
export function toggleChatSettingsFrame() {
    console.log("toggleChatSettingsFrame called.");
    if (!dom.appContainer) return;
    // Toggle the collapsed state flag
    const isNowCollapsed = !state.isChatFrameCollapsed;
    state.setIsChatFrameCollapsed(isNowCollapsed);
    // Apply/remove the corresponding CSS class to the container
    dom.appContainer.classList.toggle('chat-settings-frame-collapsed', isNowCollapsed);
    // Update button titles/icons based on the new state
    ui.updateToggleButtonTitles();
    // Save the updated panel visibility state
    state.saveAppState();
    console.log(`Chat/Settings frame ${isNowCollapsed ? 'collapsed' : 'expanded'}`);
}

/** Toggles profile panel visibility */
export function toggleProfile() {
    console.log("toggleProfile called.");
    if (!dom.appContainer) return;
    // Toggle the collapsed state flag
    const isNowCollapsed = !state.isProfileCollapsed;
    state.setIsProfileCollapsed(isNowCollapsed);
    // Apply/remove the corresponding CSS class to the container
    dom.appContainer.classList.toggle('profile-collapsed', isNowCollapsed);
    // Update button titles/icons
    ui.updateToggleButtonTitles();
    // Save the updated panel visibility state
    state.saveAppState();
    console.log(`Profile panel ${isNowCollapsed ? 'collapsed' : 'expanded'}`);
}


// --- Event Listener Setup Function ---
/** Sets up event listeners related to the settings panel and general UI. */
export function setupSettingsEventListeners() {
    console.log('Setting up Settings/General event listeners...');

    // Settings Panel Toggle Buttons
    if (dom.settingsBtn) dom.settingsBtn.addEventListener('click', () => ui.toggleSettingsView(true));
    else console.warn("Settings button not found");
    if (dom.settingsCloseBtn) dom.settingsCloseBtn.addEventListener('click', () => ui.toggleSettingsView(false));
    else console.warn("Settings close button not found");

    // ComfyUI Connect Button
    if (dom.comfyUIConnectBtn) dom.comfyUIConnectBtn.addEventListener('click', api.checkComfyUIStatus);
    else console.warn("ComfyUI connect button not found");

    // API Savers - Now uses data-api attribute
    document.querySelectorAll('.save-api-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const apiKey = btn.dataset.api;
            const inputId = `${apiKey}Input`;
            const input = document.getElementById(inputId);
            if (input) {
                 console.log(`Save API button clicked for: ${apiKey}`);
                 api.saveApiEndpoint(apiKey, input.value);
            } else {
                console.error(`Input element not found for API key: ${apiKey} (Expected ID: ${inputId})`);
             }
        });
    });

     // Settings Tabs
     const tabsContainer = dom.settingsPanel?.querySelector('.tabs');
     if (tabsContainer) {
         tabsContainer.addEventListener('click', (e) => {
             if (e.target.classList.contains('tab') && e.target.dataset.tabid) {
                 console.log(`Tab clicked: ${e.target.dataset.tabid}`);
                 ui.switchTab(e.target.dataset.tabid);
             }
         });
     } else console.warn("Tabs container not found");

    // Backend Selection Dropdown
    if (dom.backendSelect) dom.backendSelect.addEventListener('change', (e) => {
        const newBackend = e.target.value;
        state.setCurrentBackend(newBackend);
        console.log(`Backend changed to: ${newBackend}`);

        // Show/hide relevant API input fields and model selectors
        ui.toggleExternalApiInputs(newBackend);

        // Reset current model selection when backend changes
        state.setCurrentModel('');
        if (dom.externalModelInput) dom.externalModelInput.value = '';
        if (dom.externalModelSelect) dom.externalModelSelect.value = '';
        if (dom.modelSelect) dom.modelSelect.value = ''; // Clear Ollama select too

        // Fetch models based on the new backend selection
        if (newBackend === 'ollama') {
            api.fetchOllamaModels(); // Fetches and populates Ollama select
        } else if (['groq', 'openai', 'google'].includes(newBackend)) {
             const apiKeyInputId = `${newBackend}ApiKeyInput`;
             const apiKeyInput = document.getElementById(apiKeyInputId);
             if (apiKeyInput?.value?.trim()) {
                console.log(`API key found for ${newBackend}, fetching models...`);
                api.fetchExternalModels(newBackend).then(models => {
                    ui.populateExternalModelSelect(models, newBackend);
                     state.setCurrentModel(''); // Clear model state until user selects
                });
             } else {
                 console.log(`API key for ${newBackend} not entered, skipping model fetch.`);
                 ui.populateExternalModelSelect([], newBackend); // Clear dropdown
                 state.setCurrentModel('');
             }
        } else if (['anthropic', 'xai', 'custom_external'].includes(newBackend)) {
             ui.populateExternalModelSelect([], newBackend); // Ensure dropdown is cleared/shows guide
             if (newBackend === 'custom_external' && dom.externalModelInput) {
                dom.externalModelInput.value = state.apiEndpoints.customModelName || '';
                state.setCurrentModel(dom.externalModelInput.value); // Sync state
             } else {
                 state.setCurrentModel(''); // Clear model state until user types
             }
        } else { // Kobold or unknown
            ui.populateExternalModelSelect([], newBackend); // Clear dropdown
            state.setCurrentModel(''); // Clear model state
        }
        state.saveAppState(); // Save the selected backend

    }); else console.warn("Backend select not found");

    // Listener for the *Ollama* model select dropdown
    if (dom.modelSelect) dom.modelSelect.addEventListener('change', (e) => {
        if (state.currentBackend === 'ollama') {
            state.setCurrentModel(e.target.value);
            console.log(`Ollama model changed to: ${state.currentModel}`);
            state.saveAppState();
        }
    }); else console.warn("Model select (Ollama) not found");

    // Listener for the *external* model select dropdown
    if (dom.externalModelSelect) {
        dom.externalModelSelect.addEventListener('change', (e) => {
            const selectedModel = e.target.value;
            if (['groq', 'openai', 'google'].includes(state.currentBackend)) {
                state.setCurrentModel(selectedModel);
                console.log(`External model select changed to: ${selectedModel} for backend ${state.currentBackend}`);
                state.saveAppState();
            }
        });
    } else console.warn("External Model Select not found");

    // Listener for the *external* model input field (manual entry)
     if (dom.externalModelInput) {
         dom.externalModelInput.addEventListener('change', (e) => {
             const enteredModel = e.target.value.trim();
             if (['anthropic', 'xai', 'custom_external'].includes(state.currentBackend)) {
                 state.setCurrentModel(enteredModel);
                 console.log(`External model input changed to: ${enteredModel} for backend ${state.currentBackend}`);
                 state.saveAppState();
             }
         });
     } else console.warn("External Model Input not found");

    // Panel Toggle Buttons
    if (dom.chatFrameToggleBtn) dom.chatFrameToggleBtn.addEventListener('click', toggleChatSettingsFrame);
    else console.warn("Chat/Settings frame toggle button not found");
    if (dom.profileToggleBtn) dom.profileToggleBtn.addEventListener('click', toggleProfile);
    else console.warn("Profile toggle button not found");

    // General Settings Buttons
    if (dom.toggleThemeBtn) dom.toggleThemeBtn.onclick = ui.toggleTheme;
    else console.warn("Toggle theme button not found");
    if (dom.clearHistoryBtn) dom.clearHistoryBtn.onclick = clearHistory; // Use local clearHistory
    else console.warn("Clear history button not found");

    // ComfyUI Settings Buttons & Inputs
    if (dom.saveComfyUISettingsBtn) dom.saveComfyUISettingsBtn.onclick = saveComfyUISettings; // Use local saveComfyUISettings
    else console.warn("Save ComfyUI settings button not found");
    if (dom.resetComfyUISettingsBtn) dom.resetComfyUISettingsBtn.onclick = resetComfyUISettings; // Use local resetComfyUISettings
    else console.warn("Reset ComfyUI settings button not found");
    if (dom.workflowUploadInput) dom.workflowUploadInput.addEventListener('change', handleWorkflowUpload); // Use local handleWorkflowUpload
    else console.warn("Workflow upload input not found");

    // Global Escape Listener for Settings Panel
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.settingsPanel && dom.settingsPanel.style.display === 'block') {
            ui.toggleSettingsView(false); // Close settings on Escape
        }
    });

    console.log('Settings/General event listeners setup complete.');
}