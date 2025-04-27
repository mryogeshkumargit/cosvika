// File: static/api.js
import * as cfg from './config.js';
import * as state from './state.js';
import * as ui from './ui.js'; // Import UI functions (incl. indicators)
import * as dom from './dom.js'; // For UI updates within API functions

// --- Default Model Lists (Fallbacks) ---
const DEFAULT_MODELS = {
    groq: ['llama3-8b-8192', 'llama3-70b-8192', 'mixtral-8x7b-32768', 'gemma-7b-it', 'whisper-large-v3'],
    openai: ['gpt-4o', 'gpt-4', 'gpt-3.5-turbo', 'gpt-4.5'], // Added gpt-4.5 as per user req
    google: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro', 'gemini-pro-vision'], // Consolidated from user list
    anthropic: ['claude-3-opus', 'claude-3.5-sonnet', 'claude-3-haiku'], // Consolidated from user list
    xai: ['grok-beta', 'grok-3', 'chocolate'], // Added grok-3, chocolate as per user req
    // No defaults needed for ollama, kobold, custom_external
};

/** Makes API request using fetch with JSON handling. */
export async function makeApiRequest(url, options) {
    console.log(`API Request: ${options.method || 'GET'} ${url}`);
    const defaultOptions = {
        mode: 'cors',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(options.headers || {}),
        }
    };
    // Stringify body only if it's an object and not a GET/HEAD request
    const body = (typeof options.body === 'object' && options.body !== null && !['GET', 'HEAD'].includes(options.method?.toUpperCase()))
        ? JSON.stringify(options.body)
        : options.body;

    try {
        const response = await fetch(url, { ...defaultOptions, ...options, body: body });

        // Handle No Content response
        if (response.status === 204) {
            console.log(`API Response ${response.status}: No Content`);
            return {}; // Return empty object for consistency
        }

        const responseContentType = response.headers.get('content-type');
        let responseData;

        // Try to parse as JSON if content type suggests it
        if (responseContentType && responseContentType.includes('application/json')) {
            try {
                 responseData = await response.json();
            } catch (e) {
                 // If JSON parsing fails (e.g., empty body with json header), read as text
                 console.warn(`Failed to parse JSON response from ${url}, reading as text.`);
                 // Read text first before checking response.ok
                 const textResponse = await response.text();
                 if (!response.ok) { // Throw error based on status code even if JSON parse failed
                      throw new Error(`HTTP error ${response.status}: ${textResponse || response.statusText}`);
                 }
                 responseData = textResponse; // Use text if response was ok but not valid JSON
            }
        } else {
            // Read as text for other content types
            responseData = await response.text();
            // Log only a snippet for potentially large non-JSON responses
            console.log(`API Response ${response.status} (Non-JSON): ${String(responseData).substring(0, 100)}...`);
        }

        // Check if request failed after attempting to read body
        if (!response.ok) {
            let errorMsg = `HTTP error ${response.status}`;
            // Try to extract error message from parsed JSON or raw text response data
            if (typeof responseData === 'object' && responseData !== null && (responseData.message || responseData.error)) {
                errorMsg = responseData.message || responseData.error;
            } else if (typeof responseData === 'string' && responseData.length > 0) {
                 // Try to parse text response as JSON for error details
                 try {
                     const errJson = JSON.parse(responseData);
                     errorMsg = errJson.message || errJson.error || responseData;
                 } catch {
                     errorMsg = responseData; // Use raw text if not JSON
                 }
            } else {
                 // Fallback to status text if body reading failed or was empty
                 errorMsg = `${errorMsg}: ${response.statusText}`;
            }
            throw new Error(errorMsg); // Throw extracted or default error message
        }
        // Return parsed JSON or raw text on success
        return responseData;

    } catch (error) {
        // Catch fetch errors (network issues) or errors thrown from response handling
        console.error(`API Request Error (${options.method || 'GET'} ${url}):`, error);
        // Rethrow a potentially cleaner error message
        throw new Error(error.message || 'Network error or failed request');
    }
}

/** Fetches Ollama models based on the selected backend. */
export async function fetchOllamaModels() {
    // Only proceed if Ollama is the selected backend
    if (state.currentBackend !== 'ollama') {
        if (dom.modelSelect) {
            dom.modelSelect.innerHTML = '<option value="">N/A for selected backend</option>';
            dom.modelSelect.disabled = true;
        }
        console.log("Skipping Ollama model fetch, backend is:", state.currentBackend);
        return;
    }

    console.log("Fetching Ollama models...");
    if (!dom.modelSelect) return; // Exit if dropdown doesn't exist

    dom.modelSelect.innerHTML = '<option value="">Loading models...</option>';
    dom.modelSelect.disabled = true;

    try {
        const data = await makeApiRequest(cfg.MODELS_API, { method: 'GET' });
        console.log('Ollama models fetched:', data);

        dom.modelSelect.innerHTML = ''; // Clear loading message
        if (data.status === 'success' && Array.isArray(data.models)) {
            if (data.models.length === 0) {
                dom.modelSelect.innerHTML = '<option value="">No Ollama models found</option>';
                state.setCurrentModel(''); // Update state
                state.saveAppState(); // Persist change
                return;
            }

            dom.modelSelect.appendChild(new Option('Select Ollama Model', '')); // Add placeholder
            data.models.forEach(modelName => {
                dom.modelSelect.appendChild(new Option(modelName, modelName));
            });

            // Try to restore previous selection from state
            let modelToSelect = state.currentModel;

            if (modelToSelect && data.models.includes(modelToSelect)) {
                dom.modelSelect.value = modelToSelect; // Restore selection
                console.log(`Restored selected Ollama model: ${modelToSelect}`);
            } else {
                 // If no valid model selected, or previous selection invalid, select placeholder
                 console.warn(`Previously selected model "${modelToSelect}" not found or none selected. Please select a model.`);
                 dom.modelSelect.value = ""; // Select placeholder
                 state.setCurrentModel(""); // Clear invalid model from state
                 state.saveAppState(); // Persist cleared state
            }
            dom.modelSelect.disabled = false; // Enable dropdown
        } else {
            // Handle backend error or unexpected format
            throw new Error(data.message || 'Failed to parse models');
        }
    } catch (error) {
        console.error('Error fetching Ollama models:', error);
        dom.modelSelect.innerHTML = `<option value="">Error loading models</option>`;
        dom.modelSelect.disabled = true;
        ui.appendMessage(`Error loading Ollama models: ${error.message}`, 'error');
        state.setCurrentModel(''); // Clear model on error
        state.saveAppState(); // Persist cleared state
    }
}

/** Fetches models for external providers (Groq, OpenAI, Google). */
export async function fetchExternalModels(backend) {
    console.log(`Fetching models for external backend: ${backend}...`);
    // Use the appropriate UI elements for external models
    const modelSelect = dom.externalModelSelect;
    const modelStatus = dom.externalModelStatus;

    if (!modelSelect || !modelStatus) {
        console.error("External model select/status elements not found.");
        return []; // Return empty array if UI elements missing
    }

    // Update UI to show loading state
    modelSelect.innerHTML = '<option value="">Loading...</option>';
    modelSelect.disabled = true;
    modelStatus.textContent = 'Fetching...';
    modelStatus.style.color = '#666'; // Neutral color

    try {
        const url = `${cfg.EXTERNAL_MODELS_API}?backend=${encodeURIComponent(backend)}`;
        const data = await makeApiRequest(url, { method: 'GET' });

        if (data.status === 'success' && Array.isArray(data.models)) {
            console.log(`Fetched ${data.models.length} models for ${backend}.`);
            modelStatus.textContent = ''; // Clear status on success
            return data.models; // Return the list of model names
        } else {
            // Handle errors reported by the backend (e.g., missing key)
            throw new Error(data.message || `Failed to fetch models for ${backend}`);
        }
    } catch (error) {
        console.error(`Error fetching external models for ${backend}:`, error);
        modelStatus.textContent = 'Fetch Error!'; // Indicate fetch failed
        modelStatus.style.color = '#c62828'; // Error color

        // Populate with default list on failure
        const defaultList = DEFAULT_MODELS[backend] || [];
        if (defaultList.length > 0) {
            console.warn(`Fetching models for ${backend} failed (${error.message}). Using default list.`);
            ui.populateExternalModelSelect(defaultList, backend); // Populate UI with defaults
            return defaultList; // Return the default list
        } else {
            // If no defaults, show error in dropdown
            modelSelect.innerHTML = `<option value="">${error.message}</option>`;
            modelSelect.disabled = false; // Keep enabled to show error
            return []; // Return empty array
        }
    }
}


/** Checks ComfyUI status and updates UI indicator. */
export async function checkComfyUIStatus() {
    console.log("Checking ComfyUI status...");
    ui.updateComfyUIIndicator('checking'); // Update indicator
    if (dom.comfyUIStatusElement) dom.comfyUIStatusElement.textContent = 'Checking...';
    if (dom.comfyUIConnectBtn) dom.comfyUIConnectBtn.disabled = true;

    try {
        const data = await makeApiRequest(cfg.COMFYUI_STATUS_API, { method: 'GET' });
        if (data.status === 'success') {
            ui.updateComfyUIIndicator('connected'); // Update indicator
            if (dom.comfyUIStatusElement) {
                 dom.comfyUIStatusElement.textContent = 'Connected';
                 dom.comfyUIStatusElement.style.color = '#2c6e49'; // Use CSS variable?
            }
        } else {
            // Handle specific error message from backend if available
            ui.updateComfyUIIndicator('error'); // Update indicator
            if (dom.comfyUIStatusElement) {
                 dom.comfyUIStatusElement.textContent = `Error: ${data.message || 'Unknown Status'}`;
                 dom.comfyUIStatusElement.style.color = '#c62828'; // Use CSS variable?
            }
        }
    } catch (error) {
        console.error('Error checking ComfyUI status:', error);
        ui.updateComfyUIIndicator('error'); // Update indicator
        if (dom.comfyUIStatusElement) {
             dom.comfyUIStatusElement.textContent = `Error: ${error.message}`;
             dom.comfyUIStatusElement.style.color = '#c62828';
        }
    } finally {
        if (dom.comfyUIConnectBtn) dom.comfyUIConnectBtn.disabled = false; // Re-enable button
    }
}


/** Fetches available ComfyUI checkpoints and populates the dropdown. */
export async function fetchComfyCheckpoints() {
    console.log("Fetching ComfyUI checkpoints...");
     if (!dom.checkpointInput) return; // Exit if dropdown doesn't exist

    ui.updateComfyUIIndicator('checking'); // Indicate activity
    dom.checkpointInput.innerHTML = '<option value="">Loading Checkpoints...</option>';
    dom.checkpointInput.disabled = true;
    let fetchedCheckpoints = [];
    try {
        const data = await makeApiRequest(cfg.COMFYUI_CHECKPOINTS_API, { method: 'GET' });
        if (data.status === 'success' && Array.isArray(data.checkpoints)) {
            fetchedCheckpoints = data.checkpoints;
            dom.checkpointInput.innerHTML = ''; // Clear loading message
            if (fetchedCheckpoints.length === 0) {
                dom.checkpointInput.innerHTML = '<option value="">No checkpoints found</option>';
            } else {
                // Populate dropdown with fetched checkpoints
                fetchedCheckpoints.forEach(ckptName => {
                    const option = document.createElement('option');
                    option.value = ckptName;
                    option.textContent = ckptName;
                    dom.checkpointInput.appendChild(option);
                });
                console.log(`Populated checkpoint dropdown with ${fetchedCheckpoints.length} items.`);
            }
            dom.checkpointInput.disabled = false; // Enable dropdown
        } else {
            // Handle error response from backend
            throw new Error(data.message || 'Failed to fetch or parse checkpoints');
        }
    } catch (error) {
        console.error('Error fetching ComfyUI checkpoints:', error);
        dom.checkpointInput.innerHTML = `<option value="">Error loading</option>`;
        // Keep dropdown disabled on error
    } finally {
        // Always attempt to populate/select the correct checkpoint AFTER fetching attempt
        console.log("Calling populateComfyUISettingsForm after checkpoint fetch attempt.");
        ui.populateComfyUISettingsForm();
    }
}

/** Saves a single API endpoint or key to localStorage and notifies the backend. */
export async function saveApiEndpoint(apiKey, value) {
    const trimmedValue = value.trim();
    console.log(`[Debug] saveApiEndpoint called with key: ${apiKey}`);
    console.log(`[Debug] Current state keys before check: ${Object.keys(state.apiEndpoints)}`);

    if (['ollama', 'kobold', 'comfyui', 'customApiEndpoint'].includes(apiKey)) {
        if (trimmedValue && !trimmedValue.startsWith('http')) {
            console.warn(`Warning: API Endpoint for ${apiKey} might be invalid (missing http/https).`);
        }
        if (!trimmedValue) {
            console.warn(`${apiKey} API endpoint cleared.`);
        }
    }

    if (apiKey in state.apiEndpoints) {
        let updatedEndpoints = { ...state.apiEndpoints };
        updatedEndpoints[apiKey] = trimmedValue;
        state.setApiEndpoints(updatedEndpoints);
    } else {
        console.error(`Attempted to save unknown API key: ${apiKey}`);
        ui.appendMessage(`Error: Unknown setting key "${apiKey}". Cannot save.`, 'error');
        return;
    }


    try {
        localStorage.setItem('apiEndpoints', JSON.stringify(state.apiEndpoints));

        const backendResponse = await makeApiRequest(cfg.UPDATE_ENDPOINTS_API, {
            method: 'POST',
            body: { [apiKey]: trimmedValue }
        });
        if (backendResponse.status !== 'success') {
            throw new Error(backendResponse.message || 'Backend failed to acknowledge update.');
        }
        console.log(`API setting saved and notified backend: ${apiKey}`);

        if (apiKey === 'ollama') await fetchOllamaModels();
        else if (apiKey === 'comfyui') { await checkComfyUIStatus(); await fetchComfyCheckpoints(); }
        else if (apiKey === 'groqApiKey' && state.currentBackend === 'groq') { fetchExternalModels('groq').then(models => ui.populateExternalModelSelect(models, 'groq')); }
        else if (apiKey === 'openaiApiKey' && state.currentBackend === 'openai') { fetchExternalModels('openai').then(models => ui.populateExternalModelSelect(models, 'openai')); }
        else if (apiKey === 'googleApiKey' && state.currentBackend === 'google') { fetchExternalModels('google').then(models => ui.populateExternalModelSelect(models, 'google')); }

    } catch (error) {
        console.error(`Error saving ${apiKey} API setting:`, error);
        ui.appendMessage(`Error updating ${apiKey} setting: ${error.message}`, 'error');
    }
}

/** Attempts to cancel the current generation task. */
export async function cancelGeneration() {
    if (!state.isGenerating || !state.currentClientId) {
        console.log("Nothing to cancel or no client ID.");
        return;
    }
    const clientIdToCancel = state.currentClientId;
    console.log(`Attempting to cancel task with Client ID: ${clientIdToCancel}`);

    if (dom.sendBtn) {
        dom.sendBtn.innerHTML = '🚫';
        dom.sendBtn.disabled = true;
        dom.sendBtn.title = "Cancelling...";
    }
    state.setIsGenerating(false); // Signal cancellation intent

    try {
        const response = await makeApiRequest(cfg.CANCEL_API, {
            method: 'POST',
            body: { client_id: clientIdToCancel }
        });
        console.log('Cancellation response:', response);
        if (response.status === 'success') {
            ui.appendMessage('<i>Generation cancellation requested.</i>', 'received');
        } else {
            ui.appendMessage(`<i>Cancellation notice: ${response.message || 'Task may have already finished.'}</i>`, 'error');
        }
    } catch (error) {
        console.error('Error sending cancel request:', error);
        ui.appendMessage(`<i>Error attempting to cancel: ${error.message}</i>`, 'error');
    } finally {
         console.log("Cancel request sent/processed.");
    }
}

/** Saves the current active chat history (messages + images) to the backend. */
export async function saveActiveChatHistory() {
    if (!state.activeChatId) {
        console.warn("Attempted to save history with no active chat ID.");
        return;
    }

    console.log(`Saving history for chat ${state.activeChatId}...`);
    ui.updateSaveIndicator('saving');

    try {
        const payload = {
            messages: state.activeChatMessages,
            images: state.activeChatImages
        };
        const response = await makeApiRequest(cfg.CHAT_HISTORY_API(state.activeChatId), {
            method: 'POST',
            body: payload
        });
        if (response.status !== 'success') {
            throw new Error(response.message || 'Failed to save history to backend');
        }
        console.log(`Chat ${state.activeChatId} history saved successfully.`);

    } catch (error) {
        console.error(`Error saving chat history for ${state.activeChatId}:`, error);
        ui.appendMessage(`Error saving chat: ${error.message}`, 'error');
    } finally {
        setTimeout(() => ui.updateSaveIndicator('idle'), 500);
    }
}


// --- TTS API Functions ---

/** Fetches the list of available TTS models from the backend */
export async function fetchTTSModels() {
    console.log("Fetching available TTS models...");
    if (!dom.ttsModelSelect) return [];

    dom.ttsModelSelect.disabled = true;
    dom.ttsModelSelect.innerHTML = '<option value="">Loading...</option>';
    if (dom.ttsModelStatus) dom.ttsModelStatus.textContent = 'Fetching...';

    try {
        const data = await makeApiRequest(cfg.TTS_MODELS_API, { method: 'GET' });
        if (data.status === 'success' && Array.isArray(data.models)) {
            console.log(`Found ${data.models.length} TTS models.`);
            state.setAvailableTTSModels(data.models);
            if (dom.ttsModelStatus) dom.ttsModelStatus.textContent = '';
            return data.models;
        } else {
            throw new Error(data.message || 'Failed to fetch TTS models');
        }
    } catch (error) {
        console.error("Error fetching TTS models:", error);
        if (dom.ttsModelSelect) dom.ttsModelSelect.innerHTML = '<option value="">Error</option>';
        if (dom.ttsModelStatus) dom.ttsModelStatus.textContent = 'Error fetching!';
        state.setAvailableTTSModels([]);
        return [];
    }
}

/** Tells the backend to load a specific TTS model */
export async function setTTSModel(modelName) {
    if (!modelName) {
        console.log("No TTS model selected to load.");
        return;
    }

    if (modelName === state.currentTTSModelName && state.TTS_LOADED_ON_BACKEND) {
        console.log(`Model ${modelName} is already the currently loaded model on backend.`);
        if (dom.ttsModelStatus) dom.ttsModelStatus.textContent = 'Loaded';
        ui.updateVoiceSettingsUI(state.voiceSettings.enabled);
        return;
    }

    console.log(`Requesting backend to load TTS model: ${modelName}`);
    state.setTTSModelLoading(true);
    if (dom.ttsModelSelect) dom.ttsModelSelect.disabled = true;
    if (dom.ttsModelStatus) dom.ttsModelStatus.textContent = 'Loading...';
    if (dom.voiceSelect) dom.voiceSelect.disabled = true;
    if (dom.sampleVoiceBtn) dom.sampleVoiceBtn.disabled = true;

    try {
        const payload = { model_name: modelName };
        const response = await makeApiRequest(cfg.TTS_SET_MODEL_API, {
            method: 'POST',
            body: payload
        });

        if (response.status === 'success') {
            state.setCurrentTTSModelName(response.loaded_model || modelName);
            state.setCurrentTTSSpeakers(response.speakers || []);
            state.setTTSLoaded(true);
            state.setSelectedTTSModelName(state.currentTTSModelName);
            state.saveAppState();
            console.log(`Backend confirmed TTS model loaded: ${state.currentTTSModelName}`, "Speakers:", state.currentTTSSpeakers);

            if (dom.ttsModelStatus) dom.ttsModelStatus.textContent = 'Loaded';
            if(dom.ttsModelSelect) dom.ttsModelSelect.value = state.currentTTSModelName;
            ui.populateSpeakerList(state.currentTTSSpeakers);

        } else {
            throw new Error(response.message || `Failed to load model ${modelName}`);
        }
    } catch (error) {
        console.error("Error setting TTS model:", error);
        state.setTTSLoaded(false);
        state.setCurrentTTSSpeakers([]);
        if (dom.ttsModelStatus) dom.ttsModelStatus.textContent = 'Load Failed!';
        ui.appendMessage(`Error loading TTS model '${modelName}': ${error.message}`, 'error');
        ui.populateSpeakerList([]);
    } finally {
        state.setTTSModelLoading(false);
        ui.updateVoiceSettingsUI(state.voiceSettings.enabled);
    }
}


/** Requests a voice sample from the backend */
export async function sampleTTSVoice(speakerId = null) {
    console.log(`Requesting voice sample. Speaker: ${speakerId || 'default'}`);
    if (!state.TTS_LOADED_ON_BACKEND || state.ttsModelLoading) {
         console.warn("Cannot sample voice: TTS not ready or model is loading.");
         ui.appendMessage("TTS not ready or model is changing.", "error");
         return;
    }
    if (dom.sampleVoiceBtn) dom.sampleVoiceBtn.disabled = true;
    if (dom.sampleVoiceBtn) dom.sampleVoiceBtn.textContent = '⏳';

    // *** Modification Start: Declare variables outside try block ***
    let audioPlayer = null;
    let audioUrl = null;
    // *** Modification End ***

    // --- Cleanup function ---
    const cleanup = () => {
         if (audioUrl) URL.revokeObjectURL(audioUrl); // Release memory
         if (dom.sampleVoiceBtn) {
             const canSample = state.voiceSettings.enabled && state.TTS_LOADED_ON_BACKEND && !state.ttsModelLoading;
             dom.sampleVoiceBtn.disabled = !canSample;
             dom.sampleVoiceBtn.textContent = '▶️ Sample';
         }
         audioPlayer = null;
         audioUrl = null;
         // *** Modification Start: Removed reference to non-existent sampleAudioPlayer ***
         // sampleAudioPlayer = null; // This variable doesn't exist in this scope
         // *** Modification End ***
    };
    // --- End Cleanup ---

    try {
        const payload = {};
        if (speakerId && speakerId !== 'default') {
            payload.speaker_id = speakerId;
        }
        const response = await fetch(cfg.TTS_SAMPLE_API, {
             method: 'POST',
             headers: {'Content-Type': 'application/json', 'Accept': 'audio/wav'},
             body: JSON.stringify(payload)
        });

        if (!response.ok) {
            let errorMsg = `Sample request failed: ${response.status}`;
             try {
                 // Attempt to get specific error message from backend response
                 const errData = await response.json();
                 errorMsg = errData.message || errorMsg;
             } catch(e) { /* ignore if body wasn't json */ }
             // *** Modification Start: Throw specific error ***
            throw new Error(`TTS sample generation failed: ${errorMsg}`);
             // *** Modification End ***
        }

        const audioBlob = await response.blob();
        if (!audioBlob.type.startsWith('audio/')) {
             console.warn("Received sample audio blob, but type is not audio/*:", audioBlob.type);
        }
         if (audioBlob.size < 100) {
             throw new Error("Received empty or very small audio sample.");
         }

        audioUrl = URL.createObjectURL(audioBlob);
        audioPlayer = new Audio(audioUrl);
        // Removed assignment to sampleAudioPlayer here

        audioPlayer.onerror = (e) => {
            console.error("Error playing audio sample:", e);
            ui.appendMessage("Error playing audio sample.", 'error');
            cleanup();
        };
         audioPlayer.onended = () => {
             console.log("Audio sample finished playing.");
             cleanup();
         };
         await audioPlayer.play();

    } catch (error) {
        console.error("Error getting or playing TTS sample:", error);
        // *** Modification Start: Display specific error ***
        ui.appendMessage(`Error getting sample: ${error.message}`, 'error');
        // *** Modification End ***
        cleanup(); // Ensure cleanup happens on error
    }
}