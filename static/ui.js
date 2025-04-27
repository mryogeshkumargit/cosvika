// File: static/ui.js
import * as dom from './dom.js';
import * as state from './state.js';
import * as api from './api.js'; // Needed for cancelGeneration assignment in setLoadingState
import * as cfg from './config.js';
// *** Correction: Import from chat_listeners.js instead of the deleted listeners.js ***
import { sendMessage, deleteImageFromHistory } from './chat_listeners.js';

/** Configures marked.js with options. */
export function configureMarked() {
    if (typeof marked !== 'undefined') {
        marked.setOptions({
            breaks: true,    // Convert '\n' in paragraphs into <br>
            gfm: true,       // Enable GitHub Flavored Markdown
            tables: true,    // Enable GFM tables
            smartypants: false, // Avoids converting quotes and dashes
            xhtml: false,    // Don't output self-closing tags
            headerIds: false,// Don't add IDs to headers
            mangle: false    // Don't obfuscate email addresses
        });
        console.log("Marked configured.");
    } else {
        console.warn("Marked library not loaded.");
    }
}

/** Appends a message to the chat area with optional markdown rendering. */
export function appendMessage(text, type, isMarkdown = false) {
    if (!dom.chatArea) {
        console.error("Chat area DOM element not found.");
        return;
    }

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`; // Types: 'sent', 'received', 'error'

    const sanitizedText = text.replace(/<script.*?>.*?<\/script>/gi, ' [removed script] ');

    if (isMarkdown && type === 'received' && typeof marked !== 'undefined' && marked.parse) {
        try {
            messageDiv.innerHTML = marked.parse(sanitizedText);
        } catch (e) {
            console.error('Markdown parsing failed:', e);
            const pre = document.createElement('pre');
            pre.textContent = sanitizedText;
            messageDiv.appendChild(pre);
        }
    } else if (type === 'received' && text.startsWith('<i>') && text.endsWith('</i>')) {
         messageDiv.innerHTML = sanitizedText; // Allow basic italic status messages
    } else {
         // Basic handling for other messages (replace newlines)
         messageDiv.innerHTML = sanitizedText.replace(/\n/g, '<br>');
    }

    dom.chatArea.appendChild(messageDiv);
    // Scroll to bottom after adding message
    setTimeout(() => {
        // Check if chatArea still exists before scrolling
        if (dom.chatArea) {
            dom.chatArea.scrollTop = dom.chatArea.scrollHeight;
        }
    }, 0);

    return messageDiv;
}

/** Removes a specific status message (typically italic) */
export function clearStatusMessage(textToClear) {
    if (!dom.chatArea) return;
    const messageText = `<i>${textToClear}</i>`; // Construct the expected innerHTML/textContent
    for (let i = dom.chatArea.children.length - 1; i >= 0; i--) {
        const messageElement = dom.chatArea.children[i];
        // Check both innerHTML and textContent for robustness
        if (messageElement.innerHTML === messageText || messageElement.textContent === textToClear) {
            messageElement.remove();
            console.log("Cleared status message:", textToClear);
            break; // Assume only one such message needs clearing
        }
        // Optimization: stop searching early if we hit a non-received message
        if (!messageElement.classList.contains('received')) break;
    }
}

/** Toggles the visual loading state for input buttons and handles cancellation. */
export function setLoadingState(isLoading) {
    console.log(`setLoadingState called with: ${isLoading}`);
    state.setIsGenerating(isLoading);

    if (dom.messageInput) dom.messageInput.disabled = isLoading;
    if (dom.micBtn) {
        const voiceReady = state.WHISPER_LOADED_ON_BACKEND; // Use state value
        // Mic is disabled if loading, OR voice disabled, OR STT not ready.
        // Note: isVoiceActive doesn't disable it; clicking stops recording.
        const shouldDisableMic = isLoading || !state.voiceSettings.enabled || !voiceReady;
        dom.micBtn.disabled = shouldDisableMic;

        // Set title based on the reason for being disabled or current state
        // This part is primarily handled by updateMicButtonState now,
        // but we set a generic "Processing..." title if loading.
        if (isLoading) {
            dom.micBtn.title = "Processing...";
        }
        // updateMicButtonState will set the correct title otherwise based on recording state etc.
    }
    if (dom.newChatBtn) dom.newChatBtn.disabled = isLoading;
    if (dom.deleteChatBtn) dom.deleteChatBtn.disabled = isLoading;
    if (dom.profileToggleBtn) dom.profileToggleBtn.disabled = isLoading;
    if (dom.chatFrameToggleBtn) dom.chatFrameToggleBtn.disabled = isLoading;
    if(dom.generateMorePhotosBtn) dom.generateMorePhotosBtn.disabled = isLoading;

    if (dom.sendBtn) {
        dom.sendBtn.disabled = isLoading;
        if (isLoading) {
            dom.sendBtn.innerHTML = '⏳';
            dom.sendBtn.title = "Generating... (Click to Cancel)";
            dom.sendBtn.onclick = api.cancelGeneration;
        } else {
            dom.sendBtn.innerHTML = '➤';
            dom.sendBtn.title = "Send Message";
            dom.sendBtn.onclick = sendMessage; // From chat_listeners
            state.setCurrentClientId(null);
            // Refocus logic
            if (state.voiceSettings?.interactionMode !== 'voice_only' && (document.activeElement === dom.sendBtn || document.activeElement === dom.messageInput)) {
                setTimeout(() => dom.messageInput?.focus(), 0);
            }
        }
    }
}


/** Renders image thumbnails for the given chat ID, including delete buttons. */
export function renderImageHistory(chatId) {
     if (!dom.imageHistoryDiv || !dom.generatedImage || !dom.imageSection) return;
    dom.imageHistoryDiv.innerHTML = ''; // Clear previous thumbnails
    const history = state.activeChatImages; // Get history from state

    if (history && history.length > 0) {
        console.log(`Rendering ${history.length} images for chat ${chatId}`);
        history.forEach((imageUrl, index) => {
            const wrapperDiv = document.createElement('div');
            wrapperDiv.className = 'image-history-thumbnail-wrapper';
            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = "Image history thumbnail";
            img.title = "Click to view this image";
            img.onclick = () => displaySelectedHistoryImage(imageUrl);
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-image-btn';
            deleteBtn.innerHTML = '×'; // Multiplication sign as 'X'
            deleteBtn.title = 'Delete this image from history';
            deleteBtn.onclick = (event) => {
                event.stopPropagation(); // Prevent image click event
                 // Ensure deleteImageFromHistory (from chat_listeners.js) is used correctly
                deleteImageFromHistory(chatId, index, imageUrl);
            };
            wrapperDiv.appendChild(img);
            wrapperDiv.appendChild(deleteBtn);
            dom.imageHistoryDiv.appendChild(wrapperDiv);
        });

        // Logic to decide which image to show in the main view
        let imageToShow = history[0]; // Default to the most recent
        if (state.lastGeneratedImageUrl && history.includes(state.lastGeneratedImageUrl)) {
             imageToShow = state.lastGeneratedImageUrl;
        }
        else if (dom.generatedImage.src && !history.includes(dom.generatedImage.src)) {
            dom.generatedImage.src = '';
            dom.imageSection.style.display = 'none';
            state.setLastGeneratedImageUrl(null);
            imageToShow = history.length > 0 ? history[0] : null; // Show newest if available
        }

        if (imageToShow && (!dom.generatedImage.src || dom.imageSection.style.display === 'none')) {
             displaySelectedHistoryImage(imageToShow);
        } else if (history.length === 0) { // Explicitly handle case where history becomes empty
            dom.generatedImage.src = '';
            dom.imageSection.style.display = 'none';
            state.setLastGeneratedImageUrl(null);
        }

    } else {
        console.log(`No image history found for chat ${chatId}`);
        dom.generatedImage.src = '';
        dom.imageSection.style.display = 'none';
        state.setLastGeneratedImageUrl(null);
    }
}

/** Displays a selected image from history in the main image view. */
export function displaySelectedHistoryImage(imageUrl) {
     if (!dom.generatedImage || !dom.imageSection) return;
    if (imageUrl) {
        dom.generatedImage.src = imageUrl;
        state.setLastGeneratedImageUrl(imageUrl); // Update state
        dom.imageSection.style.display = 'block'; // Ensure section is visible
        console.log("Displayed history image:", imageUrl);
    } else {
        console.warn("Attempted to display null/empty image URL");
    }
}

/** Updates the ComfyUI settings form elements with values from state. */
export function populateComfyUISettingsForm() {
    console.log("Populating ComfyUI settings form with state:", state.comfyUISettings);
    const s = state.comfyUISettings;
    const requiredElements = [ dom.checkpointInput, dom.widthInput, dom.heightInput, dom.seedInput, dom.stepsInput, dom.cfgInput, dom.samplerInput, dom.schedulerInput, dom.denoiseInput ];
    if (requiredElements.some(el => !el)) {
        console.error("One or more ComfyUI setting input elements are missing!");
        return;
    }

    // Populate standard inputs
    dom.widthInput.value = s.width;
    dom.heightInput.value = s.height;
    dom.seedInput.value = s.seed;
    dom.stepsInput.value = s.steps;
    dom.cfgInput.value = s.cfg;
    dom.samplerInput.value = s.sampler;
    dom.schedulerInput.value = s.scheduler;
    dom.denoiseInput.value = s.denoise;
    console.log("Populated standard ComfyUI inputs.");

    if (dom.checkpointInput.options.length <= 1 && dom.checkpointInput.options[0]?.value === "") {
        console.log("Checkpoint dropdown not populated yet, waiting for fetch.");
        return; // Don't try to set value if options aren't loaded
    }

    if (s.checkpoint) {
        const optionExists = Array.from(dom.checkpointInput.options).some(opt => opt.value === s.checkpoint);
         if (optionExists) {
             dom.checkpointInput.value = s.checkpoint;
             console.log(`Set checkpoint dropdown to: ${s.checkpoint}`);
         } else {
             console.warn(`Saved checkpoint "${s.checkpoint}" not found in dropdown. Selecting first available.`);
             if (dom.checkpointInput.options.length > 0 && dom.checkpointInput.options[0].value) {
                 dom.checkpointInput.selectedIndex = 0;
                 let currentSettings = { ...s, checkpoint: dom.checkpointInput.value };
                 state.setComfyUISettings(currentSettings);
                 console.log("Updated state checkpoint to first available:", currentSettings.checkpoint);
             } else { dom.checkpointInput.value = ""; }
         }
    } else if (dom.checkpointInput.options.length > 0 && dom.checkpointInput.options[0].value) {
         dom.checkpointInput.selectedIndex = 0;
         let currentSettings = { ...s, checkpoint: dom.checkpointInput.value };
         state.setComfyUISettings(currentSettings);
         console.log("No saved checkpoint, defaulting to first available:", currentSettings.checkpoint);
    } else {
        console.log("Checkpoint dropdown not populated or no setting found.");
         dom.checkpointInput.value = "";
    }
}

/** Switches between settings tabs. */
export function switchTab(tabId) {
    if (!dom.settingsPanel) return;
    dom.settingsPanel.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    dom.settingsPanel.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    const contentElement = document.getElementById(`${tabId}Content`); if (contentElement) contentElement.classList.add('active');
    const tabElement = dom.settingsPanel.querySelector(`.tab[data-tabId="${tabId}"]`); if (tabElement) tabElement.classList.add('active');
     if (tabId === 'voice') {
        import('./voice_listeners.js').then(voice => voice.populateMicrophoneList());
     }
}

/** Shows/hides API input fields and model selectors based on the selected backend provider. */
export function toggleExternalApiInputs(selectedBackend) {
    console.log(`Toggling API inputs for backend: ${selectedBackend}`);
    const ollamaModelGroup = document.querySelector('.model-input-group[data-backend="ollama"]');
    const externalModelSelectGroup = document.querySelector('.model-input-group[data-backend="external-provider-select"]');
    const externalModelInputGroup = document.querySelector('.model-input-group[data-backend="external-provider-input"]');
    const allProviderApiKeyGroups = document.querySelectorAll('.api-input-group[data-backend="groq"], .api-input-group[data-backend="openai"], .api-input-group[data-backend="google"], .api-input-group[data-backend="anthropic"], .api-input-group[data-backend="xai"]');
    const customApiGroups = document.querySelectorAll('.api-input-group[data-backend="custom_external"]');
    if (ollamaModelGroup) ollamaModelGroup.style.display = 'none'; if (externalModelSelectGroup) externalModelSelectGroup.style.display = 'none'; if (externalModelInputGroup) externalModelInputGroup.style.display = 'none';
    allProviderApiKeyGroups.forEach(group => group.style.display = 'none'); customApiGroups.forEach(group => group.style.display = 'none');
    if (selectedBackend === 'ollama') { if (ollamaModelGroup) ollamaModelGroup.style.display = 'flex'; }
    else if (selectedBackend === 'kobold') {}
    else if (selectedBackend === 'custom_external') { customApiGroups.forEach(group => group.style.display = 'flex'); if (externalModelInputGroup) externalModelInputGroup.style.display = 'flex'; if (dom.externalModelInput) dom.externalModelInput.value = state.apiEndpoints.customModelName || ''; }
    else if (['groq', 'openai', 'google'].includes(selectedBackend)) { const providerGroup = document.querySelector(`.api-input-group[data-backend="${selectedBackend}"]`); if (providerGroup) providerGroup.style.display = 'flex'; if (externalModelSelectGroup) externalModelSelectGroup.style.display = 'flex'; }
    else if (['anthropic', 'xai'].includes(selectedBackend)) { const providerGroup = document.querySelector(`.api-input-group[data-backend="${selectedBackend}"]`); if (providerGroup) providerGroup.style.display = 'flex'; if (externalModelInputGroup) externalModelInputGroup.style.display = 'flex'; if (dom.externalModelInput) dom.externalModelInput.value = state.currentModel || ''; }
    if (dom.modelSelect) { dom.modelSelect.disabled = (selectedBackend !== 'ollama'); }
    if (dom.externalModelSelect) { dom.externalModelSelect.disabled = (externalModelSelectGroup?.style.display !== 'flex'); }
     if (dom.externalModelInput) { dom.externalModelInput.disabled = (externalModelInputGroup?.style.display !== 'flex'); }
}

/** Populates the external model dropdown list */
export function populateExternalModelSelect(models, backend) {
    const selectElement = dom.externalModelSelect; const statusElement = dom.externalModelStatus; if (!selectElement || !statusElement) return;
    selectElement.innerHTML = ''; statusElement.textContent = '';
    if (models && Array.isArray(models) && models.length > 0) {
        selectElement.appendChild(new Option('Select Model', '')); models.forEach(modelName => { selectElement.appendChild(new Option(modelName, modelName)); });
        if (state.currentBackend === backend && state.currentModel && models.includes(state.currentModel)) { selectElement.value = state.currentModel; } else { selectElement.value = ''; }
        selectElement.disabled = false; console.log(`Populated external models for ${backend}. Selection: '${selectElement.value}'`);
    } else {
        if (statusElement.textContent === 'Error!') { selectElement.innerHTML = `<option value="">See Error</option>`; }
        else if (backend === 'anthropic' || backend === 'xai') { selectElement.innerHTML = `<option value="">Enter Manually Below</option>`; selectElement.disabled = true; }
         else { selectElement.innerHTML = `<option value="">No models found</option>`; selectElement.disabled = true; }
    }
}

/** Toggles settings panel visibility **within the left frame**. */
export function toggleSettingsView(forceShow = null) {
     if (!dom.settingsPanel || !dom.chatSettingsFrame || !dom.panelContent || !dom.settingsSection) { console.error("Cannot toggle settings view: Required DOM elements missing."); return; }
     const settingsCurrentlyVisible = dom.settingsPanel.style.display === 'block'; const shouldShow = forceShow ?? !settingsCurrentlyVisible; console.log(`toggleSettingsView: shouldShow=${shouldShow}`);
    if (shouldShow) {
        state.loadApiEndpoints(); state.loadComfyUISettings(); state.loadComfyWorkflow();
        populateComfyUISettingsForm(); populateVoiceSettingsForm(state.voiceSettings);
         if (dom.ollamaApiInput) dom.ollamaApiInput.value = state.apiEndpoints.ollama || ''; if (dom.koboldApiInput) dom.koboldApiInput.value = state.apiEndpoints.kobold || ''; if (dom.comfyUIApiInput) dom.comfyUIApiInput.value = state.apiEndpoints.comfyui || '';
         if (dom.groqApiKeyInput) dom.groqApiKeyInput.value = state.apiEndpoints.groqApiKey || ''; if (dom.openaiApiKeyInput) dom.openaiApiKeyInput.value = state.apiEndpoints.openaiApiKey || ''; if (dom.googleApiKeyInput) dom.googleApiKeyInput.value = state.apiEndpoints.googleApiKey || ''; if (dom.anthropicApiKeyInput) dom.anthropicApiKeyInput.value = state.apiEndpoints.anthropicApiKey || ''; if (dom.xaiApiKeyInput) dom.xaiApiKeyInput.value = state.apiEndpoints.xaiApiKey || '';
         if (dom.customModelNameInput) dom.customModelNameInput.value = state.apiEndpoints.customModelName || ''; if (dom.customApiEndpointInput) dom.customApiEndpointInput.value = state.apiEndpoints.customApiEndpoint || ''; if (dom.customApiKeyInput) dom.customApiKeyInput.value = state.apiEndpoints.customApiKey || '';
         if (dom.modelSelect && state.currentBackend === 'ollama') dom.modelSelect.value = state.currentModel || ''; if (dom.externalModelSelect && ['groq', 'openai', 'google'].includes(state.currentBackend)) dom.externalModelSelect.value = state.currentModel || ''; if (dom.externalModelInput && ['anthropic', 'xai', 'custom_external'].includes(state.currentBackend)) dom.externalModelInput.value = state.currentModel || ''; if (dom.externalModelInput && state.currentBackend === 'custom_external') dom.externalModelInput.value = state.apiEndpoints.customModelName || '';
         if (dom.workflowFileNameSpan) { dom.workflowFileNameSpan.textContent = localStorage.getItem('comfyUIWorkflow') ? "Using saved workflow." : "Using default workflow."; }
         if (dom.backendSelect) dom.backendSelect.value = state.currentBackend;
        api.checkComfyUIStatus(); api.fetchComfyCheckpoints(); api.fetchTTSModels().then(models => populateTTSModelSelect(models));
        const currentBackend = state.currentBackend; if (['groq', 'openai', 'google'].includes(currentBackend)) { api.fetchExternalModels(currentBackend).then(models => populateExternalModelSelect(models, currentBackend)); } else if (currentBackend === 'ollama') { api.fetchOllamaModels(); } else { populateExternalModelSelect([], currentBackend); }
        toggleExternalApiInputs(state.currentBackend);
        dom.panelContent.style.display = 'none'; dom.settingsSection.style.display = 'none'; dom.settingsPanel.style.display = 'block'; dom.chatSettingsFrame.classList.add('settings-visible');
        if (!document.querySelector('.tab.active')) { switchTab('general'); }
        import('./voice_listeners.js').then(voice => voice.populateMicrophoneList());
    } else { dom.settingsPanel.style.display = 'none'; dom.panelContent.style.display = 'flex'; dom.settingsSection.style.display = 'flex'; dom.chatSettingsFrame.classList.remove('settings-visible'); }
}

/** Toggles light/dark theme. */
export function toggleTheme() { state.setIsDarkTheme(!state.isDarkTheme); document.body.classList.toggle('dark-theme', state.isDarkTheme); localStorage.setItem('theme', state.isDarkTheme ? 'dark' : 'light'); console.log(`Theme set to: ${state.isDarkTheme ? 'Dark' : 'Light'}`); state.saveAppState(); updateMicButtonState(state.isVoiceActive); }

/** Updates titles and icons for toggle buttons based on current panel visibility state */
export function updateToggleButtonTitles() { if (!dom.appContainer || !dom.chatFrameToggleBtn || !dom.profileToggleBtn) return; const isChatSettingsHidden = state.isChatFrameCollapsed; const isProfileHidden = state.isProfileCollapsed; dom.chatFrameToggleBtn.setAttribute('title', isChatSettingsHidden ? 'Show Panel' : 'Hide Panel'); dom.chatFrameToggleBtn.innerHTML = isChatSettingsHidden ? '☰' : '✕'; dom.profileToggleBtn.setAttribute('title', isProfileHidden ? 'Show Profile Panel' : 'Hide Profile Panel'); }

/** Renders the chat list based on fetched data from knownChatList state. */
export function renderChatList() { if (!dom.chatList) return; console.log("Rendering chat list from state..."); const dynamicChats = dom.chatList.querySelectorAll('.chat-item:not(.chat-item-static)'); dynamicChats.forEach(item => item.remove()); state.knownChatList.forEach(chatInfo => { const chatId = chatInfo.id; const chatName = chatInfo.name || `Chat ${chatId.split('-').pop()}`; const chatItem = document.createElement('div'); chatItem.className = 'chat-item'; chatItem.dataset.chatId = chatId; const initials = chatName.split(/[\s-_]+/).map(n => n[0]).join('').substring(0, 2).toUpperCase() || '??'; let hash = 0; for (let i = 0; i < chatId.length; i++) { hash = chatId.charCodeAt(i) + ((hash << 5) - hash); } const bgColor = (hash & 0x00FFFFFF).toString(16).padStart(6, '0'); chatItem.innerHTML = ` <div class="chat-item-content"> <img src="/static/chat-icon.png" alt="${initials}" onerror="this.src='https://via.placeholder.com/40/${bgColor}/FFFFFF?text=${initials}'"> <span title="${chatName}">${chatName}</span> </div> <input type="checkbox" onclick="event.stopPropagation()" title="Select chat for deletion"> `; dom.chatList.insertBefore(chatItem, dom.chatList.children[1]); }); console.log(`Chat list rendered with ${state.knownChatList.length} chats.`); }

// --- Status Indicator Functions ---
export function updateComfyUIIndicator(status) { if (!dom.comfyuiIndicator) return; const icon = dom.comfyuiIndicator.querySelector('.icon'); dom.comfyuiIndicator.classList.remove('checking', 'connected', 'error', 'hidden'); switch(status) { case 'checking': dom.comfyuiIndicator.classList.add('checking'); dom.comfyuiIndicator.title = 'Checking ComfyUI Connection...'; if(icon) icon.textContent = '⏳'; break; case 'connected': dom.comfyuiIndicator.classList.add('connected'); dom.comfyuiIndicator.title = 'ComfyUI Connected'; if(icon) icon.textContent = '☁️'; break; case 'error': dom.comfyuiIndicator.classList.add('error'); dom.comfyuiIndicator.title = 'ComfyUI Connection Error'; if(icon) icon.textContent = '❌'; break; default: dom.comfyuiIndicator.classList.add('hidden'); dom.comfyuiIndicator.title = 'ComfyUI Status Unknown'; if(icon) icon.textContent = '☁️'; return; } dom.comfyuiIndicator.classList.remove('hidden'); }
export function updateVoiceIndicator(status) { if (!dom.voiceIndicator) return; const icon = dom.voiceIndicator.querySelector('.icon'); dom.voiceIndicator.classList.remove('checking', 'connected', 'disconnected', 'error', 'hidden'); switch(status) { case 'connecting': dom.voiceIndicator.classList.add('checking'); dom.voiceIndicator.title = 'Connecting Voice Service...'; if(icon) icon.textContent = '⏳'; break; case 'connected': dom.voiceIndicator.classList.add('connected'); dom.voiceIndicator.title = 'Voice Service Connected'; if(icon) icon.textContent = '🎤'; break; case 'disconnected': dom.voiceIndicator.classList.add('disconnected'); dom.voiceIndicator.title = 'Voice Service Disconnected'; if(icon) icon.textContent = '🔇'; break; case 'error': dom.voiceIndicator.classList.add('error'); dom.voiceIndicator.title = 'Voice Service Error'; if(icon) icon.textContent = '❌'; break; default: dom.voiceIndicator.classList.add('hidden'); dom.voiceIndicator.title = 'Voice Service Status Unknown'; if(icon) icon.textContent = '🎤'; return; } dom.voiceIndicator.classList.remove('hidden'); }
export function updateSaveIndicator(status) { if (!dom.saveIndicator) return; dom.saveIndicator.classList.remove('saving', 'hidden'); if (status === 'saving') { dom.saveIndicator.classList.add('saving'); dom.saveIndicator.title = 'Saving Chat...'; dom.saveIndicator.classList.remove('hidden'); } else { dom.saveIndicator.classList.add('hidden'); dom.saveIndicator.title = ''; } }

// --- Voice UI Specific Functions ---

/** Updates the microphone button style and animation based on recording state */
export function updateMicButtonState(isRecording) {
     if (!dom.micBtn) return;
     state.setIsVoiceActive(isRecording); // Update state reflects the UI goal
     const micButtonColor = state.isDarkTheme ? '#b39ddb' : '#6a0dad';
     dom.micBtn.style.color = isRecording ? 'red' : micButtonColor;

     // *** Modification START: Add/Remove Animation Class ***
     dom.micBtn.classList.toggle('listening', isRecording);
     // *** Modification END ***

     // Update title (deferring final title to setLoadingState if loading)
     let currentTitle = dom.micBtn.title; // Keep current title unless changed below
     // Only update title based on recording state if NOT currently loading
     if (!state.isGenerating) {
         currentTitle = isRecording ? "Stop Recording" : (state.voiceSettings.enabled ? "Voice Input" : "Voice Input (Disabled)");
         // Further refine title if disabled for reasons other than loading
         if (dom.micBtn.disabled && !isRecording) {
             if (!state.voiceSettings.enabled) currentTitle = "Voice Input (Disabled)";
             else if (!state.WHISPER_LOADED_ON_BACKEND) currentTitle = "Voice Input (Server STT Unavailable)";
             // else title remains "Voice Input" but button is disabled (handled by setLoadingState)
         }
     }
     // Don't overwrite title if it was set to "Processing..." by setLoadingState
     // Update title unless the button is currently showing "Processing..."
     if (!state.isGenerating || dom.micBtn.title !== "Processing...") {
         dom.micBtn.title = currentTitle;
     }
}


/** Shows or hides the voice status indicator */
export function showVoiceStatus(text, showWaveform = false) {
    if (dom.voiceStatusIndicator) {
        dom.voiceStatusIndicator.querySelector('span').textContent = text;
        const waveformEl = dom.voiceStatusIndicator.querySelector('.waveform');

        // *** Modification START: Ensure waveform has spans ***
        if (showWaveform && waveformEl && waveformEl.children.length === 0) {
            waveformEl.innerHTML = ''; // Clear just in case
            for (let i = 0; i < 5; i++) {
                waveformEl.appendChild(document.createElement('span'));
            }
        }
        // *** Modification END ***

        if (waveformEl) waveformEl.style.display = showWaveform ? 'flex' : 'none'; // Use flex
        dom.voiceStatusIndicator.style.display = 'flex';
    }
}
export function hideVoiceStatus() {
    if (dom.voiceStatusIndicator) {
        dom.voiceStatusIndicator.style.display = 'none';
    }
}

/** Populates the *primary* TTS Model selector dropdown */
export function populateTTSModelSelect(models) {
    if (!dom.ttsModelSelect) return;
    const currentSelection = state.selectedTTSModelName || state.currentTTSModelName;
    dom.ttsModelSelect.innerHTML = '';
    if (models && models.length > 0) {
        dom.ttsModelSelect.appendChild(new Option("Select TTS Model...", ""));
        models.forEach(modelName => { dom.ttsModelSelect.appendChild(new Option(modelName, modelName)); });
        if (currentSelection && models.includes(currentSelection)) { dom.ttsModelSelect.value = currentSelection; }
        else { dom.ttsModelSelect.value = ""; }
        console.log(`Populated TTS models. Selection set to: '${dom.ttsModelSelect.value}'`);
    } else { dom.ttsModelSelect.innerHTML = '<option value="">No Models Found</option>'; }
}

/** Populates the TTS *Speaker* selector dropdown */
export function populateSpeakerList(speakers) {
    if (!dom.voiceSelect) return;
    const currentSpeakerSelection = state.voiceSettings.ttsSpeaker || 'default';
    dom.voiceSelect.innerHTML = '';
    if (speakers && Array.isArray(speakers) && speakers.length > 0) {
        console.log("Populating speakers:", speakers);
        dom.voiceSelect.appendChild(new Option("Default Speaker", "default"));
        speakers.forEach(speaker => { const speakerStr = String(speaker); dom.voiceSelect.appendChild(new Option(speakerStr, speakerStr)); });
        if (speakers.map(String).includes(currentSpeakerSelection) || currentSpeakerSelection === 'default') { dom.voiceSelect.value = currentSpeakerSelection; }
        else { dom.voiceSelect.value = "default"; state.voiceSettings.ttsSpeaker = "default"; }
        dom.voiceSelect.disabled = false; // Ensure enabled if speakers exist
    } else if (state.TTS_LOADED_ON_BACKEND) {
        console.log("TTS loaded, but no specific speakers listed. Adding 'Default'.");
        dom.voiceSelect.appendChild(new Option("Default Voice", "default")); dom.voiceSelect.value = "default"; state.voiceSettings.ttsSpeaker = "default"; dom.voiceSelect.disabled = true;
    } else { console.log("TTS not loaded. Setting speaker select to N/A."); dom.voiceSelect.innerHTML = '<option value="">N/A</option>'; dom.voiceSelect.disabled = true; }
    updateSampleButtonState();
    console.log("Final TTS speaker selection:", dom.voiceSelect.value, "Disabled:", dom.voiceSelect.disabled);
}

/** Updates the enabled state of the sample button */
function updateSampleButtonState() { if (dom.sampleVoiceBtn) { const canSample = state.voiceSettings.enabled && state.TTS_LOADED_ON_BACKEND && !state.ttsModelLoading; dom.sampleVoiceBtn.disabled = !canSample; } }

/** Populates the Voice Settings form based on loaded settings */
export function populateVoiceSettingsForm(settings) {
     console.log("Populating Voice Settings Form:", settings); if (!settings) { console.error("Cannot populate voice form: settings object is null"); return; }
     if (dom.voiceEnableToggle) dom.voiceEnableToggle.checked = settings.enabled; if (dom.ttsEnableToggle) dom.ttsEnableToggle.checked = settings.ttsEnabled; if (dom.micSelect) dom.micSelect.value = settings.micId; if (dom.sttLanguageSelect) dom.sttLanguageSelect.value = settings.sttLanguage; if (dom.voiceSpeedSlider) dom.voiceSpeedSlider.value = settings.ttsSpeed; if (dom.voiceSpeedValue) dom.voiceSpeedValue.textContent = `${Number(settings.ttsSpeed).toFixed(1)}x`; if (dom.voicePitchSlider) dom.voicePitchSlider.value = settings.ttsPitch; if (dom.voicePitchValue) dom.voicePitchValue.textContent = `${Number(settings.ttsPitch).toFixed(1)}x`; if (dom.interactionModeSelect) dom.interactionModeSelect.value = settings.interactionMode;
     if (dom.ttsModelSelect && dom.ttsModelSelect.options.length > 0) { const modelToSelect = state.selectedTTSModelName || state.currentTTSModelName; if (Array.from(dom.ttsModelSelect.options).some(opt => opt.value === modelToSelect)) { dom.ttsModelSelect.value = modelToSelect; } else if (dom.ttsModelSelect.options.length > 1) {} }
     if (dom.voiceSelect && dom.voiceSelect.options.length > 0) { const speakerToSelect = settings.ttsSpeaker || 'default'; if (Array.from(dom.voiceSelect.options).some(opt => opt.value === speakerToSelect)) { dom.voiceSelect.value = speakerToSelect; } else { const defaultOption = dom.voiceSelect.querySelector('option[value="default"]'); if (defaultOption) { dom.voiceSelect.value = 'default'; } else if (dom.voiceSelect.options.length > 0 && dom.voiceSelect.options[0].value !== "") { dom.voiceSelect.selectedIndex = 0; } } }
     updateVoiceSettingsUI(settings.enabled);
}

/** Enables/disables voice setting controls based on main toggle and backend readiness */
export function updateVoiceSettingsUI(isVoiceEnabled) {
    const isTTSReady = state.TTS_LOADED_ON_BACKEND; const isTTSEnabledSetting = state.voiceSettings.ttsEnabled; const isModelLoading = state.ttsModelLoading;
    console.log(`updateVoiceSettingsUI: VoiceEnabled=${isVoiceEnabled}, TTSReady=${isTTSReady}, TTSEnabledSetting=${isTTSEnabledSetting}, ModelLoading=${isModelLoading}`);
    if (dom.ttsModelSelect) { const shouldDisableModelSelect = !isVoiceEnabled || isModelLoading; dom.ttsModelSelect.disabled = shouldDisableModelSelect; console.log(`  - TTS Model Select Disabled: ${shouldDisableModelSelect} (Reason: voiceEnabled=${isVoiceEnabled}, modelLoading=${isModelLoading})`); }
    if (dom.ttsModelStatus) { if (isModelLoading) dom.ttsModelStatus.textContent = 'Loading...'; else if (!isTTSReady && isVoiceEnabled && state.selectedTTSModelName) dom.ttsModelStatus.textContent = 'Load Failed!'; else if (isTTSReady && state.currentTTSModelName) dom.ttsModelStatus.textContent = 'Loaded'; else dom.ttsModelStatus.textContent = ''; }
    const shouldDisableTTSToggle = !isVoiceEnabled || !isTTSReady || isModelLoading;
    if (dom.ttsEnableToggle) { dom.ttsEnableToggle.disabled = shouldDisableTTSToggle; console.log(`  - TTS Enable Toggle Disabled: ${shouldDisableTTSToggle} (Reason: voiceEnabled=${isVoiceEnabled}, ttsReady=${isTTSReady}, modelLoading=${isModelLoading})`); if (shouldDisableTTSToggle && dom.ttsEnableToggle.checked) { dom.ttsEnableToggle.checked = false; } }
    const actualTTSEnabled = dom.ttsEnableToggle ? dom.ttsEnableToggle.checked : false; console.log(`  - Actual TTS Enabled (Checkbox State): ${actualTTSEnabled}`);
    if (dom.micSelect) dom.micSelect.disabled = !isVoiceEnabled; if (dom.sttLanguageSelect) dom.sttLanguageSelect.disabled = !isVoiceEnabled; if (dom.interactionModeSelect) dom.interactionModeSelect.disabled = !isVoiceEnabled; console.log(`  - Input Controls Disabled: ${!isVoiceEnabled}`);
    const disableTTSControls = !isVoiceEnabled || !isTTSReady || !actualTTSEnabled || isModelLoading; console.log(`  - TTS Output Controls Disabled: ${disableTTSControls}`);
    if (dom.voiceSelect) { const hasMultipleSpeakers = state.currentTTSSpeakers && state.currentTTSSpeakers.length > 0; dom.voiceSelect.disabled = disableTTSControls || !hasMultipleSpeakers; console.log(`  - Speaker Select Disabled: ${dom.voiceSelect.disabled} (Reason: generalTTSDisable=${disableTTSControls}, hasMultipleSpeakers=${hasMultipleSpeakers})`); }
    if (dom.voiceSpeedSlider) dom.voiceSpeedSlider.disabled = disableTTSControls; if (dom.voicePitchSlider) dom.voicePitchSlider.disabled = disableTTSControls; if (dom.replayBtn) dom.replayBtn.disabled = disableTTSControls || !state.lastPlayedAudioBuffer; if (dom.stopAudioBtn) dom.stopAudioBtn.disabled = disableTTSControls || !state.isSpeaking;
    updateSampleButtonState();
    console.log(`updateVoiceSettingsUI: Finished applying enable/disable states.`);
}