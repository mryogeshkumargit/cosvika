const API_BASE_URL = '/api';
const MODELS_API = `${API_BASE_URL}/models`; // Ollama models
const GENERATE_API = `${API_BASE_URL}/generate`; // Text generation
const IMAGE_API = `${API_BASE_URL}/generate-image`; // Image generation
const UPDATE_ENDPOINTS_API = `${API_BASE_URL}/update-endpoints`;
const CANCEL_API = `${API_BASE_URL}/cancel`;
const COMFYUI_STATUS_API = `${API_BASE_URL}/comfyui-status`;
const COMFYUI_CHECKPOINTS_API = `${API_BASE_URL}/comfyui-checkpoints`;
const HISTORY_CONTEXT_LENGTH = 10; // Keep N most recent message pairs (User+AI)
const IMAGE_TRIGGER_PHRASE = "send your photo"; // 8. Image trigger phrase

// --- Global State ---
let currentBackend = 'ollama';
let currentModel = ''; // For Ollama
let activeChatElement = null;
let isDarkTheme = false;
let chatIdCounter = 1;
let chatHistories = {}; // { chatId: [ { role: 'user'/'assistant', content: '...' }, ... ] } (newest first)
let chatImageHistories = {}; // 3. { chatId: [ 'url1', 'url2', ... ] } (newest first)
let isGenerating = false; // General flag for any generation
let lastGeneratedFacePrompt = null; // Store prompt used for the image command
let lastGeneratedImageUrl = null; // Store URL of the last generated image shown in main view
let activeChatId = null;
// 11. Added external API fields to state
let apiEndpoints = {
    ollama: 'http://localhost:11435',
    kobold: 'http://localhost:5001/api/v1/generate',
    comfyui: 'http://127.0.0.1:8188',
    externalName: '',
    externalUrl: '',
    externalKey: ''
};
// Default ComfyUI workflow structure (can be overridden by upload)
let comfyUIWorkflow = {
    "3": {"inputs": {"seed": 1, "steps": 25, "cfg": 7, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}, "class_type": "KSampler"},
    "4": {"inputs": {"ckpt_name": "SDXL\DreamShaperXL_Turbo_V2-SFW.safetensors"}, "class_type": "CheckpointLoaderSimple"},
    "5": {"inputs": {"width": 512, "height": 512, "batch_size": 1}, "class_type": "EmptyLatentImage"},
    "6": {"inputs": {"text": "INPUT_PROMPT", "clip": ["4", 1]}, "class_type": "CLIPTextEncode"},
    "7": {"inputs": {"text": "text, watermark, low quality, medium quality, blurry, deformed, disfigured", "clip": ["4", 1]}, "class_type": "CLIPTextEncode"},
    "8": {"inputs": {"image": "", "upload": "image"}, "class_type": "LoadImage"},
    "9": {"inputs": {"filename_prefix": "CosmoAI_Output", "images": ["11", 0]}, "class_type": "SaveImage"},
    "10": {"inputs": {"weight": 1.0, "image": ["8", 0], "model": ["4", 0]}, "class_type": "IPAdapter"},
    "11": {"inputs": {"samples": ["3", 0], "vae": ["4", 2]}, "class_type": "VAEDecode"}
};
// Default ComfyUI settings (values for the UI controls)
let comfyUISettings = {
    checkpoint: "SDXL\\DreamShaperXL_Turbo_V2-SFW.safetensors", // Default checkpoint name
    width: 512,
    height: 512,
    seed: 0, // 0 often means random in ComfyUI context
    steps: 25,
    cfg: 7.0,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1.0
};
let currentClientId = null; // UUID for the current generation task

// --- DOM Element References ---
const appContainer = document.getElementById('appContainer'); // 1. Target for profile collapse class
const settingsPanel = document.getElementById('settingsPanel');
const imageSection = document.getElementById('imageSection');
const profileToggleBtn = document.getElementById('profileToggleBtn'); // 1. Toggle button
const chatList = document.getElementById('chatList');
const chatArea = document.getElementById('chatArea');
// const profileNameDisplay = document.getElementById('profileName'); // 4. Removed
const messageInput = document.getElementById('messageInput');
const backendSelect = document.getElementById('backendSelect');
const modelSelect = document.getElementById('modelSelect'); // Ollama models
const profileImage = document.getElementById('profileImage'); // Profile icon
const generatedImage = document.getElementById('generatedImage'); // Main image display
const imageHistoryDiv = document.getElementById('imageHistory'); // 3. Image history container
const settingsBtn = document.getElementById('settingsBtn');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const comfyUIConnectBtn = document.getElementById('comfyUIConnectBtn');
const comfyUIStatusElement = document.getElementById('comfyUIStatus');
const ollamaApiInput = document.getElementById('ollamaApiInput');
const koboldApiInput = document.getElementById('koboldApiInput');
const comfyUIApiInput = document.getElementById('comfyUIApiInput');
// 11. External API Inputs
const externalNameInput = document.getElementById('externalNameInput');
const externalUrlInput = document.getElementById('externalUrlInput');
const externalKeyInput = document.getElementById('externalKeyInput');

const sendBtn = document.querySelector('.send-btn');
const micBtn = document.querySelector('.mic-btn');
const newChatBtn = document.querySelector('.chat-actions button[onclick="addNewChat()"]');
const deleteChatBtn = document.querySelector('.chat-actions button[onclick="deleteSelectedChats()"]');
// ComfyUI Settings Elements
const workflowUploadInput = document.getElementById('workflowUpload');
const workflowFileNameSpan = document.getElementById('workflowFileName');
const checkpointInput = document.getElementById('checkpointInput'); // Now a select
const widthInput = document.getElementById('widthInput');
const heightInput = document.getElementById('heightInput');
const seedInput = document.getElementById('seedInput');
const stepsInput = document.getElementById('stepsInput');
const cfgInput = document.getElementById('cfgInput');
const samplerInput = document.getElementById('samplerInput');
const schedulerInput = document.getElementById('schedulerInput');
const denoiseInput = document.getElementById('denoiseInput');


// --- Utility Functions ---

/** Configures marked.js with options for better formatting. */
function configureMarked() {
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
    }
}

/** Appends a message to the chat area with optional markdown rendering. */
function appendMessage(text, type, isMarkdown = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`; // Types: 'sent', 'received', 'error'

    // Basic sanitization - replace <script> tags
    const sanitizedText = text.replace(/<script.*?>.*?<\/script>/gi, ' [removed script] ');

    if (isMarkdown && type === 'received' && typeof marked !== 'undefined' && marked.parse) {
        try {
            // Use marked to parse markdown content
            messageDiv.innerHTML = marked.parse(sanitizedText);
        } catch (e) {
            console.error('Markdown parsing failed:', e);
            // Fallback to preformatted text if markdown fails
            const pre = document.createElement('pre');
            pre.textContent = sanitizedText;
            messageDiv.appendChild(pre);
        }
    } else {
         // For sent messages or non-markdown received messages, replace newlines
         messageDiv.innerHTML = sanitizedText.replace(/\n/g, '<br>');
    }
    chatArea.insertBefore(messageDiv, chatArea.firstChild); // Add to top for reverse order
    chatArea.scrollTop = 0; // Keep scrolled to top
}

/** Makes API request using fetch with JSON handling. */
async function makeApiRequest(url, options) {
    console.log(`API Request: ${options.method || 'GET'} ${url}`);
    const defaultOptions = {
        mode: 'cors',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(options.headers || {}),
        }
    };
    const body = (typeof options.body === 'object' && options.body !== null && !['GET', 'HEAD'].includes(options.method?.toUpperCase()))
        ? JSON.stringify(options.body)
        : options.body;

    try {
        const response = await fetch(url, { ...defaultOptions, ...options, body: body });

        if (response.status === 204) {
            console.log(`API Response ${response.status}: No Content`);
            return {};
        }

        const responseContentType = response.headers.get('content-type');
        let responseData;
        if (responseContentType && responseContentType.includes('application/json')) {
            responseData = await response.json();
        } else {
            responseData = await response.text();
            console.log(`API Response ${response.status} (Non-JSON): ${responseData.substring(0, 100)}...`);
        }

        if (!response.ok) {
            let errorMsg = `HTTP error ${response.status}`;
            if (typeof responseData === 'object' && responseData !== null && responseData.message) {
                errorMsg = responseData.message;
            } else if (typeof responseData === 'string' && responseData.length > 0) {
                 // Try to parse as JSON even if content-type was wrong
                 try {
                     const errJson = JSON.parse(responseData);
                     errorMsg = errJson.message || errJson.error || responseData;
                 } catch {
                     errorMsg = responseData; // Use raw text if not JSON
                 }
            } else {
                 errorMsg = `${errorMsg}: ${response.statusText}`;
            }
            throw new Error(errorMsg);
        }
        return responseData;

    } catch (error) {
        console.error(`API Request Error (${options.method || 'GET'} ${url}):`, error);
        throw new Error(error.message || 'Network error or failed request');
    }
}

/** Toggles the visual loading state for input buttons and handles cancellation. */
function setLoadingState(isLoading) {
    isGenerating = isLoading;
    messageInput.disabled = isLoading;
    micBtn.disabled = isLoading;
    newChatBtn.disabled = isLoading;
    deleteChatBtn.disabled = isLoading;
    // Also disable profile/image buttons during generation
    profileToggleBtn.disabled = isLoading;
    const genMoreBtn = document.querySelector('.profile button[onclick="generateMorePhotos()"]');
    if(genMoreBtn) genMoreBtn.disabled = isLoading;


    if (isLoading) {
        sendBtn.innerHTML = '⏳'; // Loading indicator
        sendBtn.title = "Generating... (Click to Cancel)";
        sendBtn.disabled = false; // Keep cancel button enabled
        sendBtn.onclick = cancelGeneration; // Change action to cancel
    } else {
        sendBtn.innerHTML = '➤'; // Send icon
        sendBtn.title = "Send Message";
        sendBtn.disabled = false;
        sendBtn.onclick = sendMessage; // Restore send action
        currentClientId = null; // Clear client ID when not loading
        if (document.activeElement === sendBtn || document.activeElement === messageInput) {
            setTimeout(() => messageInput.focus(), 0);
        }
    }
}

/** Attempts to cancel the current generation task. */
async function cancelGeneration() {
    if (!isGenerating || !currentClientId) {
        console.log("Nothing to cancel.");
        return;
    }
    console.log(`Attempting to cancel task with Client ID: ${currentClientId}`);
    sendBtn.innerHTML = '🚫';
    sendBtn.disabled = true;
    sendBtn.title = "Cancelling...";

    try {
        const response = await makeApiRequest(CANCEL_API, {
            method: 'POST',
            body: { client_id: currentClientId }
        });
        console.log('Cancellation response:', response);
        if (response.status === 'success') {
            appendMessage('Generation cancelled by user.', 'received');
        } else {
            appendMessage(`Cancellation notice: ${response.message || 'Task may have already finished.'}`, 'error');
        }
    } catch (error) {
        console.error('Error cancelling task:', error);
        appendMessage(`Error attempting to cancel: ${error.message}`, 'error');
    } finally {
        // Reset state regardless of cancellation success
        setLoadingState(false);
    }
}


/** Loads API endpoints from localStorage. */
function loadApiEndpoints() {
    try {
        const saved = localStorage.getItem('apiEndpoints');
        if (saved) {
            const loadedEndpoints = JSON.parse(saved);
            // Merge saved with defaults to ensure all keys exist
            apiEndpoints = { ...apiEndpoints, ...loadedEndpoints };
            console.log('API endpoints loaded from localStorage:', apiEndpoints);
        } else {
            console.log('No API endpoints found in localStorage, using defaults.');
            localStorage.setItem('apiEndpoints', JSON.stringify(apiEndpoints));
        }
        // Update input fields
        ollamaApiInput.value = apiEndpoints.ollama || '';
        koboldApiInput.value = apiEndpoints.kobold || '';
        comfyUIApiInput.value = apiEndpoints.comfyui || '';
        // 11. Load external API fields
        externalNameInput.value = apiEndpoints.externalName || '';
        externalUrlInput.value = apiEndpoints.externalUrl || '';
        externalKeyInput.value = apiEndpoints.externalKey || ''; // Load key (type="password" hides it)

    } catch (e) {
        console.error('Failed to load or parse API endpoints from localStorage:', e);
        // Ensure inputs reflect the default values if loading fails
        ollamaApiInput.value = apiEndpoints.ollama;
        koboldApiInput.value = apiEndpoints.kobold;
        comfyUIApiInput.value = apiEndpoints.comfyui;
        externalNameInput.value = apiEndpoints.externalName;
        externalUrlInput.value = apiEndpoints.externalUrl;
        externalKeyInput.value = apiEndpoints.externalKey;
    }
}

/** Saves a single API endpoint to localStorage and notifies the backend. */
async function saveApiEndpoint(apiKey, value) {
    // Allow empty values for optional fields like externalKey or externalName
    const trimmedValue = value.trim();
    // Basic validation for URLs (optional)
    if (apiKey.endsWith('Url') || apiKey === 'ollama' || apiKey === 'kobold' || apiKey === 'comfyui') {
        if (trimmedValue && !trimmedValue.startsWith('http')) {
             appendMessage(`Warning: API URL for ${apiKey} doesn't start with http/https.`, 'error');
             // Don't prevent saving, but warn user
        }
        // Require main API URLs? Or allow empty to disable? Let's allow empty for now.
         if (!trimmedValue && ['ollama', 'kobold', 'comfyui'].includes(apiKey)) {
              console.warn(`${apiKey} API endpoint cleared.`);
              // appendMessage(`${apiKey.charAt(0).toUpperCase() + apiKey.slice(1)} API endpoint cleared.`, 'received');
         }
    }


    apiEndpoints[apiKey] = trimmedValue; // Save trimmed or empty value
    try {
        localStorage.setItem('apiEndpoints', JSON.stringify(apiEndpoints));
        // Notify backend about the change
        await makeApiRequest(UPDATE_ENDPOINTS_API, {
            method: 'POST',
            body: { [apiKey]: trimmedValue }
        });
        console.log(`API endpoint saved and notified backend: ${apiKey}=${trimmedValue ? trimmedValue.substring(0,30)+'...' : 'empty'}`);
        appendMessage(`${apiKey} setting updated successfully.`, 'received');

        // Refresh relevant data if endpoint changed
        if (apiKey === 'ollama') {
            fetchOllamaModels(); // Refetch Ollama models
        } else if (apiKey === 'comfyui') {
            checkComfyUIStatus(); // Recheck status
            fetchComfyCheckpoints(); // Refetch checkpoints
        }
    } catch (error) {
        console.error(`Error saving ${apiKey} API endpoint:`, error);
        appendMessage(`Error updating ${apiKey} setting: ${error.message}`, 'error');
        // Revert UI potentially? Or trust localStorage? Let's trust localStorage for now.
        // loadApiEndpoints();
    }
}

/** Reads ComfyUI settings from inputs, updates state, and saves to localStorage. */
function saveComfyUISettings() {
    console.log("Saving ComfyUI settings...");
    try {
        comfyUISettings = {
            checkpoint: checkpointInput.value,
            width: parseInt(widthInput.value) || 512,
            height: parseInt(heightInput.value) || 512,
            seed: parseInt(seedInput.value) || 0,
            steps: parseInt(stepsInput.value) || 25,
            cfg: parseFloat(cfgInput.value) || 7.0,
            sampler: samplerInput.value || "euler",
            scheduler: schedulerInput.value || "normal",
            denoise: parseFloat(denoiseInput.value) || 1.0
        };
        localStorage.setItem('comfyUISettings', JSON.stringify(comfyUISettings));
        appendMessage('ComfyUI settings saved locally.', 'received');
        console.log("ComfyUI Settings saved:", comfyUISettings);
    } catch (e) {
        console.error("Error saving ComfyUI settings:", e);
        appendMessage('Error saving ComfyUI settings to local storage.', 'error');
    }
}

/** Resets ComfyUI settings to default values and saves. */
function resetComfyUISettings() {
     if (!confirm("Reset all ComfyUI settings to their defaults?")) return;
     console.log("Resetting ComfyUI settings to defaults...");
     // Fetch or define the absolute default checkpoint name reliably
     const defaultCheckpointName = "SDXL\\DreamShaperXL_Turbo_V2-SFW.safetensors"; // Make sure this is accurate

     comfyUISettings = { // Restore hardcoded defaults
        checkpoint: defaultCheckpointName,
        width: 512,
        height: 512,
        seed: 0,
        steps: 25,
        cfg: 7.0,
        sampler: "euler",
        scheduler: "normal",
        denoise: 1.0
    };
    // Update UI elements to reflect defaults
    populateComfyUISettingsForm();
    // Save the reset defaults
    saveComfyUISettings();
    appendMessage('ComfyUI settings reset to defaults.', 'received');
}

/** Loads ComfyUI settings from localStorage or uses defaults, then updates the form. */
function loadComfyUISettings() {
    try {
        const saved = localStorage.getItem('comfyUISettings');
        if (saved) {
            const loadedSettings = JSON.parse(saved);
            if (typeof loadedSettings === 'object' && loadedSettings !== null) {
                comfyUISettings = { ...comfyUISettings, ...loadedSettings };
                console.log("ComfyUI settings loaded from localStorage.");
            } else {
                console.warn("Invalid ComfyUI settings format in localStorage, using defaults.");
                localStorage.setItem('comfyUISettings', JSON.stringify(comfyUISettings));
            }
        } else {
             console.log("No ComfyUI settings found, using defaults.");
             localStorage.setItem('comfyUISettings', JSON.stringify(comfyUISettings));
        }
    } catch (e) {
        console.error("Failed to load or parse ComfyUI settings:", e);
    }
    // Update the form fields
    populateComfyUISettingsForm();
}

/** Updates the ComfyUI settings form elements with values from comfyUISettings state. */
function populateComfyUISettingsForm() {
    console.log("Populating ComfyUI settings form with state:", comfyUISettings);

    if (!checkpointInput || !widthInput || !heightInput || !seedInput || !stepsInput || !cfgInput || !samplerInput || !schedulerInput || !denoiseInput) {
        console.error("One or more ComfyUI setting input elements are missing!");
        return;
    }

    widthInput.value = comfyUISettings.width;
    heightInput.value = comfyUISettings.height;
    seedInput.value = comfyUISettings.seed;
    stepsInput.value = comfyUISettings.steps;
    cfgInput.value = comfyUISettings.cfg;
    samplerInput.value = comfyUISettings.sampler;
    schedulerInput.value = comfyUISettings.scheduler;
    denoiseInput.value = comfyUISettings.denoise;
    console.log("Populated standard ComfyUI inputs.");

    // Special handling for checkpoint select: Set value if options exist
    if (comfyUISettings.checkpoint && checkpointInput.options.length > 1) { // Ensure options are loaded (more than just "Loading...")
         const optionExists = Array.from(checkpointInput.options).some(opt => opt.value === comfyUISettings.checkpoint);
         if (optionExists) {
             checkpointInput.value = comfyUISettings.checkpoint;
             console.log(`Set checkpoint dropdown to: ${comfyUISettings.checkpoint}`);
         } else {
             console.warn(`Saved checkpoint "${comfyUISettings.checkpoint}" not found in dropdown. Selecting first available.`);
             // Select the first *actual* checkpoint if saved one isn't found
             if (checkpointInput.options.length > 0 && checkpointInput.options[0].value) {
                 checkpointInput.selectedIndex = 0; // Select the first real option
                 comfyUISettings.checkpoint = checkpointInput.value; // Update state to match UI
                 console.log("Updated state checkpoint to first available:", comfyUISettings.checkpoint);
             } else {
                 checkpointInput.value = ""; // Fallback to placeholder if no options
             }
         }
    } else if (checkpointInput.options.length > 1 && checkpointInput.options[0].value) {
         // If no specific checkpoint is saved, but options exist, select the first one by default
         checkpointInput.selectedIndex = 0;
         comfyUISettings.checkpoint = checkpointInput.value;
         console.log("No saved checkpoint, defaulting to first available:", comfyUISettings.checkpoint);
    } else {
        console.log("Checkpoint dropdown not populated or no specific setting found.");
    }
}

/** Loads the ComfyUI workflow from localStorage or uses the default. */
function loadComfyWorkflow() {
    try {
        const saved = localStorage.getItem('comfyUIWorkflow');
        if (saved) {
            const loadedWorkflow = JSON.parse(saved);
            // Basic validation
            if (typeof loadedWorkflow === 'object' && loadedWorkflow !== null && loadedWorkflow["3"] && loadedWorkflow["4"]) {
                comfyUIWorkflow = loadedWorkflow;
                console.log("ComfyUI workflow loaded from localStorage.");
                workflowFileNameSpan.textContent = "Using saved workflow.";
            } else {
                console.warn("Invalid workflow format in localStorage, using default.");
                localStorage.setItem('comfyUIWorkflow', JSON.stringify(comfyUIWorkflow));
                workflowFileNameSpan.textContent = "Using default workflow.";
            }
        } else {
             console.log("No ComfyUI workflow found, using default.");
             localStorage.setItem('comfyUIWorkflow', JSON.stringify(comfyUIWorkflow));
             workflowFileNameSpan.textContent = "Using default workflow.";
        }
    } catch (e) {
        console.error("Failed to load or parse ComfyUI workflow:", e);
        workflowFileNameSpan.textContent = "Using default workflow (load error).";
    }
}

/** Handles workflow JSON file upload. */
function handleWorkflowUpload(event) {
    const file = event.target.files[0];
    if (!file) {
        console.log("Workflow upload cancelled or no file selected.");
        return;
    }
    if (file.type !== 'application/json') {
         appendMessage('Error: Please upload a valid JSON file for the workflow.', 'error');
         workflowUploadInput.value = '';
         return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const workflowFromFile = JSON.parse(e.target.result);
            if (typeof workflowFromFile !== 'object' || workflowFromFile === null) {
                throw new Error("Uploaded file does not contain a valid JSON object.");
            }
            // Simple validation: check for a couple of expected keys
            if (!workflowFromFile["3"] || !workflowFromFile["4"] || !workflowFromFile["6"] || !workflowFromFile["9"]) {
                 console.warn("Uploaded workflow might be missing standard nodes (KSampler, Loader, Prompt, Save). Using anyway.");
                 // throw new Error("Workflow missing essential nodes (KSampler, Checkpoint, Prompt, Output?).");
             }

            comfyUIWorkflow = workflowFromFile; // Update global state
            localStorage.setItem('comfyUIWorkflow', JSON.stringify(comfyUIWorkflow)); // Save
            workflowFileNameSpan.textContent = `Using: ${file.name}`;
            appendMessage(`Workflow '${file.name}' uploaded and saved successfully.`, 'received');
            console.log("Workflow updated from file:", file.name);
        } catch (error) {
            appendMessage('Error parsing workflow JSON: ' + error.message, 'error');
            workflowFileNameSpan.textContent = "Error loading workflow!";
            workflowUploadInput.value = '';
        }
    };
    reader.onerror = () => {
         appendMessage('Error reading workflow file.', 'error');
         workflowFileNameSpan.textContent = "Error reading file!";
         workflowUploadInput.value = '';
    };
    reader.readAsText(file);
}


/** Switches between settings tabs. */
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    const contentElement = document.getElementById(`${tabId}Content`);
    if (contentElement) contentElement.classList.add('active');
    const tabElement = document.querySelector(`.tab[onclick="switchTab('${tabId}')"]`);
    if (tabElement) tabElement.classList.add('active');
}

// --- Core Application Logic ---

/** Checks ComfyUI status and updates UI. */
async function checkComfyUIStatus() {
    console.log("Checking ComfyUI status...");
    comfyUIStatusElement.textContent = 'Checking...';
    comfyUIStatusElement.style.color = '#666';
    comfyUIConnectBtn.disabled = true;
    try {
        const data = await makeApiRequest(COMFYUI_STATUS_API, { method: 'GET' });
        if (data.status === 'success') {
            comfyUIStatusElement.textContent = 'Connected';
            comfyUIStatusElement.style.color = '#2c6e49';
        } else {
            comfyUIStatusElement.textContent = `Error: ${data.message || 'Unknown Error'}`;
            comfyUIStatusElement.style.color = '#c62828';
        }
    } catch (error) {
        console.error('Error checking ComfyUI status:', error);
        comfyUIStatusElement.textContent = `Error: ${error.message}`;
        comfyUIStatusElement.style.color = '#c62828';
    } finally {
        comfyUIConnectBtn.disabled = false;
    }
}

/** Fetches available ComfyUI checkpoints and populates the dropdown. */
async function fetchComfyCheckpoints() {
    console.log("Fetching ComfyUI checkpoints...");
    checkpointInput.innerHTML = '<option value="">Loading Checkpoints...</option>';
    checkpointInput.disabled = true;
    let fetchedCheckpoints = [];
    try {
        const data = await makeApiRequest(COMFYUI_CHECKPOINTS_API, { method: 'GET' });
        if (data.status === 'success' && Array.isArray(data.checkpoints)) {
            fetchedCheckpoints = data.checkpoints;
            checkpointInput.innerHTML = ''; // Clear loading
            if (fetchedCheckpoints.length === 0) {
                checkpointInput.innerHTML = '<option value="">No checkpoints found</option>';
                appendMessage('No ComfyUI checkpoints found on the backend.', 'error');
            } else {
                // Add a placeholder option? Maybe not needed if we auto-select first one.
                // checkpointInput.add(new Option("Select Checkpoint", ""));
                fetchedCheckpoints.forEach(ckptName => {
                    const option = document.createElement('option');
                    option.value = ckptName;
                    option.textContent = ckptName;
                    checkpointInput.appendChild(option);
                });
                console.log(`Populated checkpoint dropdown with ${fetchedCheckpoints.length} items.`);
            }
            checkpointInput.disabled = false;
        } else {
            throw new Error(data.message || 'Failed to fetch or parse checkpoints');
        }
    } catch (error) {
        console.error('Error fetching ComfyUI checkpoints:', error);
        checkpointInput.innerHTML = `<option value="">Error loading checkpoints</option>`;
        appendMessage(`Error loading ComfyUI checkpoints: ${error.message}`, 'error');
         checkpointInput.disabled = true; // Keep disabled on error
    } finally {
        // Attempt to populate/select the correct checkpoint AFTER fetching attempt
        console.log("Calling populateComfyUISettingsForm after checkpoint fetch attempt.");
        populateComfyUISettingsForm(); // This will select the saved/first option
    }
}


/** Fetches Ollama models based on the selected backend. */
async function fetchOllamaModels() {
    // Disable and clear Ollama model select if backend is not Ollama
    if (currentBackend !== 'ollama') {
        modelSelect.innerHTML = '<option value="">N/A for selected backend</option>';
        modelSelect.disabled = true;
        // currentModel = ''; // Don't clear currentModel here, it might be needed if user switches back
        console.log("Skipping Ollama model fetch, backend is:", currentBackend);
        return;
    }

    console.log("Fetching Ollama models...");
    modelSelect.innerHTML = '<option value="">Loading models...</option>';
    modelSelect.disabled = true;
    // currentModel = ''; // Reset while loading? Maybe not, keep previous selection attempt

    try {
        const data = await makeApiRequest(MODELS_API, { method: 'GET' });
        console.log('Ollama models fetched:', data);
        if (data.status === 'success' && Array.isArray(data.models)) {
            modelSelect.innerHTML = ''; // Clear loading message
            if (data.models.length === 0) {
                modelSelect.innerHTML = '<option value="">No Ollama models found</option>';
                appendMessage('No Ollama models found. Ensure Ollama is running and has models.', 'error');
                currentModel = ''; // No models available
                saveAppState();
                return;
            }

            modelSelect.appendChild(new Option('Select Ollama Model', '')); // Add placeholder
            data.models.forEach(modelName => {
                modelSelect.appendChild(new Option(modelName, modelName));
            });

            // Try to restore previous selection
            const savedState = JSON.parse(localStorage.getItem('appState') || '{}');
            let modelToSelect = savedState.model || currentModel; // Use state or loaded model pref

            if (modelToSelect && data.models.includes(modelToSelect)) {
                modelSelect.value = modelToSelect;
                currentModel = modelToSelect;
                console.log(`Restored selected Ollama model: ${currentModel}`);
            } else if (!currentModel && data.models.length > 0) { // 10. Auto-select first if none selected
                modelSelect.value = data.models[0]; // Select the first actual model
                currentModel = data.models[0];
                console.log(`No model selected, defaulting to first Ollama model: ${currentModel}`);
            } else if (currentModel && !data.models.includes(currentModel)) {
                 console.warn(`Previously selected model "${currentModel}" not found. Please select a model.`);
                 modelSelect.value = ""; // Select placeholder
                 currentModel = ""; // Clear invalid model
            } else {
                 // Model already selected and valid, or no models available
                 modelSelect.value = currentModel; // Ensure UI reflects state
            }

            modelSelect.disabled = false;
            saveAppState(); // Save state in case model selection changed
        } else {
            throw new Error(data.message || 'Failed to parse models');
        }
    } catch (error) {
        console.error('Error fetching Ollama models:', error);
        modelSelect.innerHTML = `<option value="">Error loading models</option>`;
        appendMessage(`Error loading Ollama models: ${error.message}`, 'error');
        modelSelect.disabled = true;
        currentModel = ''; // Clear model on error
        saveAppState();
    }
}

/** Sends user message to the backend for text generation or triggers image generation. */
async function sendMessage() {
     if (isGenerating) return; // Safeguard

    const message = messageInput.value.trim();
    if (!message) {
        messageInput.style.border = '1px solid red';
        setTimeout(() => { messageInput.style.border = ''; }, 1000);
        return;
    }

    if (!activeChatId) {
        await addNewChat(null, message); // Create new chat and load it
        if (!activeChatId) { // Guard against failure to create chat
             appendMessage("Failed to create or load a chat. Please try again.", "error");
             return;
        }
        // Fall through to send message
    }

    // --- 8. Check for Image Trigger Phrase ---
    const lowerCaseMessage = message.toLowerCase();
    if (lowerCaseMessage.startsWith(IMAGE_TRIGGER_PHRASE)) {
        const prompt = message.substring(IMAGE_TRIGGER_PHRASE.length).trim();
        const effectivePrompt = prompt || `photorealistic portrait of a beautiful woman, high quality, detailed face, mystic background`; // Default if empty
        console.log(`Image generation triggered. Prompt: "${effectivePrompt}"`);
        appendMessage(message, 'sent'); // Show the full user command
        messageInput.value = ''; // Clear input
        await generateImage(effectivePrompt); // Call image generation
        lastGeneratedFacePrompt = effectivePrompt; // Store for 'generate more'
        return; // Stop further processing
    }
    // --- End Image Trigger Check ---

    // Validate backend/model selection for text generation
    if (currentBackend === 'ollama' && !currentModel) {
        appendMessage("Please select an Ollama model in Settings first.", 'error');
        toggleSettings(true); // Show settings panel
        return;
    }
    if (currentBackend === 'kobold' && !currentModel) {
         currentModel = "default"; // Assume default works for Kobold
    }
    if (currentBackend === 'external' && (!apiEndpoints.externalUrl)) {
         appendMessage("External API URL is not configured in Settings.", 'error');
         toggleSettings(true);
         return;
    }


    setLoadingState(true);
    appendMessage(message, 'sent'); // Display user message
    messageInput.value = '';

    // Ensure history exists and add user message
    if (!chatHistories[activeChatId]) chatHistories[activeChatId] = [];
    chatHistories[activeChatId].unshift({ role: 'user', content: message });
    saveChatHistories();

    const historyForContext = chatHistories[activeChatId].slice(1, HISTORY_CONTEXT_LENGTH * 2 + 1); // Get pairs, exclude current msg

    currentClientId = crypto.randomUUID();
    const payload = {
        backend: currentBackend,
        model: currentModel, // Will be 'default' for Kobold, potentially name for External
        // History/Prompt adjusted below per backend
    };

    try {
        if (currentBackend === 'ollama') {
            let ollamaPrompt = historyForContext.slice().reverse()
                 .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
                 .join('\n');
            ollamaPrompt += `\nUser: ${message}\nAssistant:`;
            payload.prompt = ollamaPrompt;
            payload.stream = true; // Always stream Ollama

            console.log(`Sending stream request to ${GENERATE_API}?stream=true`);
            await streamOllamaResponse(payload);

        } else if (currentBackend === 'kobold') {
            payload.prompt = message;
            payload.history = historyForContext;
            payload.stream = false;

            console.log(`Sending non-stream request to ${GENERATE_API}`);
            const response = await makeApiRequest(GENERATE_API, {
                method: 'POST',
                body: payload
            });

            if (response.status === 'success' && response.response) {
                const aiResponse = response.response;
                appendMessage(aiResponse, 'received', true);
                chatHistories[activeChatId].unshift({ role: 'assistant', content: aiResponse });
                saveChatHistories();
                 setLoadingState(false);
            } else {
                throw new Error(response.message || 'Empty or failed response from Kobold backend');
            }
        } else if (currentBackend === 'external') {
             // Placeholder for external API call
             // This requires backend implementation. For now, simulate an error.
             console.warn("External API selected, but backend logic is not implemented.");
             throw new Error("External API backend is not implemented on the server yet.");
             // Actual implementation would format payload based on apiEndpoints.externalUrl/Key etc.
             // and call makeApiRequest or fetch directly.
        }

    } catch (error) {
        console.error('Error during text generation:', error);
        appendMessage(`Error: ${error.message}`, 'error');
         setLoadingState(false); // Reset on error
    }
    // setLoadingState(false) for Ollama is handled in streamOllamaResponse
}


/** Handles streaming response from Ollama using Server-Sent Events. */
async function streamOllamaResponse(payload) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message received streaming';
    chatArea.insertBefore(messageDiv, chatArea.firstChild);
    chatArea.scrollTop = 0;

    let fullResponse = '';
    let buffer = '';

    try {
        const requestOptions = {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
             body: JSON.stringify(payload)
        };
        // Add client ID to headers for potential backend cancellation/tracking
        requestOptions.headers['X-Client-ID'] = currentClientId;

        const response = await fetch(`${GENERATE_API}?stream=true`, requestOptions);


        if (!response.ok) {
            let errorMsg = `Streaming connection failed: ${response.status} ${response.statusText}`;
            try {
                 const errorBody = await response.json();
                 errorMsg = errorBody.message || errorMsg;
            } catch { try { const txt = await response.text(); if(txt) errorMsg = txt; } catch {} }
            throw new Error(errorMsg);
        }
        if (!response.body) throw new Error("Response body is null.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
             // --- Cancellation Check ---
             if (!isGenerating) {
                 console.log("Stream reading loop detected cancellation flag.");
                 if (reader) await reader.cancel();
                 throw new Error("Generation cancelled by user during streaming.");
             }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                 if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6).trim();
                    if (dataStr === '[DONE]') continue;

                    try {
                        const parsedData = JSON.parse(dataStr);
                        if (parsedData.status === 'error') {
                             throw new Error(parsedData.message || "Unknown error from backend stream");
                        }
                        if (parsedData.response) {
                             fullResponse += parsedData.response;
                             if (typeof marked !== 'undefined' && marked.parse) {
                                 messageDiv.innerHTML = marked.parse(fullResponse);
                             } else {
                                 messageDiv.innerHTML = fullResponse.replace(/\n/g, '<br>');
                             }
                             chatArea.scrollTop = 0; // Keep scrolled to top
                        }
                    } catch (e) {
                        console.warn('SSE JSON parsing warning:', e, 'Data:', dataStr);
                    }
                } else if (line.trim()) {
                     console.debug("SSE non-data line:", line);
                }
            }
        } // End while loop

        messageDiv.classList.remove('streaming');

        if (!fullResponse && !isGenerating) { // Cancelled before response
            messageDiv.remove();
        } else if (!fullResponse) {
             messageDiv.innerHTML = "[Empty Response]";
             console.warn("Stream ended with empty response.");
        } else {
             // Save full response to history
             if(activeChatId && chatHistories[activeChatId]) { // Check if chat still exists
                chatHistories[activeChatId].unshift({ role: 'assistant', content: fullResponse });
                saveChatHistories();
             }
        }

    } catch (error) {
        console.error('Streaming error:', error);
        if (messageDiv) messageDiv.remove();
        if (error.message !== "Generation cancelled by user during streaming.") {
             appendMessage(`Streaming Error: ${error.message}`, 'error');
        }
    } finally {
        console.log("Stream processing finished or errored. Resetting loading state.");
        setLoadingState(false);
    }
}

/** Generates an image using ComfyUI. */
async function generateImage(prompt) { // Now requires prompt argument
    if (isGenerating) {
        appendMessage("Please wait for the current task to finish.", "error");
        return;
    }
    if (!prompt) { // Should have been checked by caller, but safeguard
        appendMessage("Image prompt is empty.", "error");
        return;
    }
    if (!activeChatId) {
        appendMessage("Cannot generate image: No active chat selected.", "error");
        return;
    }

    console.log(`Initiating image generation with prompt: "${prompt.substring(0,50)}..."`);
    setLoadingState(true);
    appendMessage(`<i>Generating image for prompt: "${prompt.substring(0, 50)}..."</i>`, 'received');
    // Don't clear input here, prompt came from command or button

    try {
        currentClientId = crypto.randomUUID();
        const payload = {
            prompt: prompt,
            workflow: comfyUIWorkflow,
            settings: comfyUISettings,
            client_id: currentClientId
        };

        console.log("Sending image generation request to backend:", JSON.stringify(payload).substring(0, 500) + "..."); // Log truncated payload
        const response = await makeApiRequest(IMAGE_API, {
            method: 'POST',
            body: payload
        });
        console.log('Image generation backend response:', response);

        if (response.status === 'success' && response.image_url) {
            generatedImage.src = response.image_url; // Update main image view
            imageSection.style.display = 'block';
            lastGeneratedImageUrl = response.image_url; // Store URL for reference/display

            // 3. Add to image history for the active chat
            if (!chatImageHistories[activeChatId]) {
                chatImageHistories[activeChatId] = [];
            }
            chatImageHistories[activeChatId].unshift(response.image_url); // Add to beginning (newest first)
            saveImageHistories(); // Persist
            renderImageHistory(activeChatId); // Update thumbnails

            appendMessage(`Image generated successfully.`, 'received');

        } else if (response.status === 'cancelled') {
            appendMessage('Image generation was cancelled.', 'received');
        } else {
            throw new Error(response.message || 'Image generation failed on the backend.');
        }
    } catch (error) {
        console.error('Error generating image:', error);
        appendMessage(`Image Generation Error: ${error.message}`, 'error');
    } finally {
        setLoadingState(false);
    }
}


/** Generates more photos based on the last "send your photo" prompt. */
async function generateMorePhotos() {
    if (!lastGeneratedFacePrompt) {
        appendMessage("Use the 'send your photo [your prompt]' command first to set a base prompt.", "error");
        return;
    }
    // Create a variation prompt
    const newPrompt = `${lastGeneratedFacePrompt}, cinematic lighting, different angle, high detail variation`;
    console.log("Generating more photos with prompt:", newPrompt);
    await generateImage(newPrompt); // Use the main function
}

/** Adds a new chat item to the list and optionally loads it. */
async function addNewChat(chatId = null, nameHint = null) {
    const newChatId = chatId || `chat-${chatIdCounter++}`;
    let chatName = nameHint
        ? nameHint.split(' ').slice(0, 4).join(' ').substring(0, 25)
        : `Chat ${newChatId.split('-').pop()}`;
     if (nameHint && nameHint.length > 25) chatName += '...';

    const chatItem = document.createElement('div');
    chatItem.className = 'chat-item';
    chatItem.dataset.chatId = newChatId;

    const initials = chatName.split(/[\s-_]+/).map(n => n[0]).join('').substring(0, 2).toUpperCase() || '??';
    let hash = 0;
    for (let i = 0; i < newChatId.length; i++) { hash = newChatId.charCodeAt(i) + ((hash << 5) - hash); }
    const bgColor = (hash & 0x00FFFFFF).toString(16).padStart(6, '0');

    chatItem.innerHTML = `
        <div class="chat-item-content">
            <img src="/static/chat-icon.png" alt="${initials}" onerror="this.src='https://via.placeholder.com/40/${bgColor}/FFFFFF?text=${initials}'">
            <span title="${chatName}">${chatName}</span>
        </div>
        <input type="checkbox" onclick="event.stopPropagation()" title="Select chat for deletion">
    `;
    chatItem.onclick = (e) => loadChat(chatName, chatItem, e);

    chatList.insertBefore(chatItem, chatList.children[1]); // Insert after "Create New..."

    // Initialize histories
    if (!chatHistories[newChatId]) chatHistories[newChatId] = [];
    if (!chatImageHistories[newChatId]) chatImageHistories[newChatId] = []; // 3. Init image history

    saveChatHistories();
    saveImageHistories(); // 3. Save image history state
    saveAppState(); // Save chatIdCounter

    await loadChat(chatName, chatItem, null); // Load the new chat
    console.log(`Added new chat: ${chatName} (ID: ${newChatId})`);
    messageInput.focus();
}


/** Loads chat history and image history into the main area and updates UI state. */
async function loadChat(chatName, chatElement, event) {
     if (event && chatElement?.classList.contains('chat-item-static')) {
          await addNewChat();
          return;
     }
    if (event && event.target.type === 'checkbox') return;

    console.log(`Loading chat: ${chatName || 'None'} (ID: ${chatElement ? chatElement.dataset.chatId : 'None'})`);

    if (activeChatElement) activeChatElement.classList.remove('active');

    chatArea.innerHTML = ''; // Clear chat messages
    imageHistoryDiv.innerHTML = ''; // 3. Clear image history thumbnails
    generatedImage.src = ''; // Clear main image display
    imageSection.style.display = 'none'; // Hide image section initially
    lastGeneratedImageUrl = null; // Clear last image URL


    if (chatElement) {
         activeChatElement = chatElement;
         activeChatElement.classList.add('active');
         activeChatId = activeChatElement.dataset.chatId;
         // profileNameDisplay.textContent = chatName || `Chat ${activeChatId.split('-').pop()}`; // 4. Removed
         messageInput.disabled = false;

         // Load messages
         if (chatHistories[activeChatId]) {
            console.log(`Loading ${chatHistories[activeChatId].length} messages for chat ${activeChatId}`);
            chatHistories[activeChatId].forEach(msg => {
                appendMessage(msg.content, msg.role === 'user' ? 'sent' : 'received', msg.role === 'assistant');
            });
         } else {
            appendMessage('Start typing to begin this chat!', 'received');
         }
          // 3. Load image history
          renderImageHistory(activeChatId);

     } else { // No chat selected
         activeChatElement = null;
         activeChatId = null;
         // profileNameDisplay.textContent = 'No Chat Selected'; // 4. Removed
         messageInput.disabled = true;
         appendMessage('Select a chat from the left or click "Create New..." to start.', 'received');
     }

     saveAppState();
     if (chatElement) messageInput.focus(); // Focus input only if a chat is loaded
     setTimeout(() => { chatArea.scrollTop = 0; }, 0); // Ensure scroll top
}


/** Deletes chats selected via checkboxes. */
function deleteSelectedChats() {
    const checkboxes = chatList.querySelectorAll('.chat-item:not(.chat-item-static) input[type="checkbox"]:checked');
    if (checkboxes.length === 0) {
        appendMessage("Please select one or more chats to delete using the checkboxes.", "error");
        return;
    }
    if (!confirm(`Are you sure you want to permanently delete ${checkboxes.length} selected chat(s)? This cannot be undone.`)) return;

    console.log(`Deleting ${checkboxes.length} chats...`);
    let activeChatWasDeleted = false;
    checkboxes.forEach(checkbox => {
        const chatItem = checkbox.closest('.chat-item');
        if (chatItem && chatItem.dataset.chatId) {
            const chatIdToDelete = chatItem.dataset.chatId;
            if (activeChatId === chatIdToDelete) activeChatWasDeleted = true;
            // Remove from state and UI
            delete chatHistories[chatIdToDelete];
            delete chatImageHistories[chatIdToDelete]; // 3. Delete image history
            chatItem.remove();
        }
    });

    saveChatHistories();
    saveImageHistories(); // 3. Save deleted image history

    if (activeChatWasDeleted) {
        activeChatElement = null;
        activeChatId = null;
        loadChat(null, null, null); // Load default state
    }
    saveAppState();
    appendMessage(`${checkboxes.length} chat(s) deleted successfully.`, 'received');
}


/** Toggles settings panel visibility. */
function toggleSettings(forceShow = null) {
    const shouldShow = forceShow ?? (settingsPanel.style.display !== 'block');
    if (shouldShow) {
        loadApiEndpoints();
        loadComfyUISettings();
        loadComfyWorkflow();
        populateComfyUISettingsForm(); // Populate standard fields first
        // Start async fetches AFTER initial load/populate
        checkComfyUIStatus();
        fetchComfyCheckpoints(); // Will re-populate checkpoint part when done
        // Show/hide external API fields based on current backend selection
        toggleExternalApiInputs(currentBackend === 'external');
        settingsPanel.style.display = 'block';
        // Ensure the correct tab is active (e.g., general)
        if (!document.querySelector('.tab.active')) {
            switchTab('general');
        }
    } else {
        settingsPanel.style.display = 'none';
    }
}

/** 11. Shows/hides External API input fields based on backend selection */
function toggleExternalApiInputs(show) {
    const externalGroups = document.querySelectorAll('.api-input-group[data-backend="external"]');
    externalGroups.forEach(group => {
        group.style.display = show ? 'flex' : 'none'; // Use flex for alignment
    });
    // Also disable Ollama model select when external is chosen
    modelSelect.disabled = show || currentBackend === 'kobold';
    if (show) {
         modelSelect.innerHTML = '<option value="">N/A for External API</option>';
    } else if (currentBackend === 'ollama') {
         // If switching *away* from external back to ollama, re-fetch models
         fetchOllamaModels();
    } else if (currentBackend === 'kobold') {
         modelSelect.innerHTML = '<option value="">N/A for Kobold AI</option>';
    }
}


/** 1. Toggles profile panel visibility by adding/removing class on container */
function toggleProfile() {
    const isCollapsed = appContainer.classList.toggle('profile-collapsed');
    // Update button state/title (optional but good UX)
    profileToggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    profileToggleBtn.setAttribute('title', isCollapsed ? 'Show Profile Panel' : 'Hide Profile Panel');
    console.log(`Profile panel ${isCollapsed ? 'collapsed' : 'expanded'}`);
    // CSS handles the visual transition and layout changes
}

/** Toggles light/dark theme. */
function toggleTheme() {
    isDarkTheme = !isDarkTheme;
    document.body.classList.toggle('dark-theme', isDarkTheme);
    localStorage.setItem('theme', isDarkTheme ? 'dark' : 'light');
    console.log(`Theme set to: ${isDarkTheme ? 'Dark' : 'Light'}`);
    saveAppState();
}

/** Clears all chat histories and image histories, resets chat list. */
function clearHistory() {
    if (!confirm("WARNING: This will permanently delete ALL chat and image histories and remove all chats. This cannot be undone. Proceed?")) return;

    console.log("Clearing all chats and history...");
    const dynamicChats = chatList.querySelectorAll('.chat-item:not(.chat-item-static)');
    dynamicChats.forEach(item => item.remove());

    chatHistories = {};
    chatImageHistories = {}; // 3. Clear image histories
    saveChatHistories();
    saveImageHistories(); // 3. Save cleared image histories

    activeChatElement = null;
    activeChatId = null;
    chatIdCounter = 1;

    loadChat(null, null, null); // Load default state

    saveAppState();
    appendMessage("All chat and image history has been cleared.", 'received');
}

/** Placeholder for voice input functionality. */
function startVoiceInput() {
    if (isGenerating) return;
    console.log('Mic clicked - Voice input feature not implemented.');
    appendMessage('Voice input is not implemented yet.', 'error');
}

// --- Image History Functions ---

/** 3. Renders image thumbnails for the given chat ID. */
function renderImageHistory(chatId) {
    imageHistoryDiv.innerHTML = ''; // Clear previous thumbnails
    const history = chatImageHistories[chatId];
    if (history && history.length > 0) {
        console.log(`Rendering ${history.length} images for chat ${chatId}`);
        history.forEach(imageUrl => {
            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = "Image history thumbnail";
            img.title = "Click to view this image";
            img.onclick = () => displaySelectedHistoryImage(imageUrl);
            imageHistoryDiv.appendChild(img);
        });
        // Display the *most recent* image (first in history array) in the main view by default when loading chat
        if (!generatedImage.src) { // Only if main image isn't already set
             displaySelectedHistoryImage(history[0]);
        }
    } else {
        console.log(`No image history found for chat ${chatId}`);
        // Optionally display a message like "No images generated in this chat yet."
    }
}

/** 3. Displays a selected image from history in the main image view. */
function displaySelectedHistoryImage(imageUrl) {
    if (imageUrl) {
        generatedImage.src = imageUrl;
        lastGeneratedImageUrl = imageUrl; // Update the last shown URL
        imageSection.style.display = 'block'; // Ensure section is visible
        console.log("Displayed history image:", imageUrl);
    } else {
        console.warn("Attempted to display null/empty image URL");
        // Optionally hide image section or show placeholder
        // imageSection.style.display = 'none';
        // generatedImage.src = '';
    }
}


// --- Persistence ---

/** Saves chat histories to localStorage. */
function saveChatHistories() {
    try {
        localStorage.setItem('chatHistories', JSON.stringify(chatHistories));
    } catch (e) { console.error("Failed to save chat histories:", e); }
}

/** Loads chat histories from localStorage. */
function loadChatHistories() {
    try {
        const saved = localStorage.getItem('chatHistories');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (typeof parsed === 'object' && parsed !== null) {
                chatHistories = parsed;
                console.log("Chat histories loaded.");
            } else { throw new Error("Invalid format"); }
        } else { chatHistories = {}; }
    } catch (e) { console.error("Failed to load chat histories:", e); chatHistories = {}; }
}

/** 3. Saves image histories to localStorage. */
function saveImageHistories() {
    try {
        localStorage.setItem('chatImageHistories', JSON.stringify(chatImageHistories));
    } catch (e) { console.error("Failed to save image histories:", e); }
}

/** 3. Loads image histories from localStorage. */
function loadImageHistories() {
    try {
        const saved = localStorage.getItem('chatImageHistories');
        if (saved) {
            const parsed = JSON.parse(saved);
             // Basic validation: ensure it's an object, and values are arrays
             if (typeof parsed === 'object' && parsed !== null) {
                 // Further check if values are arrays (optional but good)
                 Object.values(parsed).forEach(val => { if (!Array.isArray(val)) throw new Error("Invalid image history entry"); });
                 chatImageHistories = parsed;
                 console.log("Image histories loaded.");
             } else { throw new Error("Invalid format"); }
        } else { chatImageHistories = {}; }
    } catch (e) { console.error("Failed to load image histories:", e); chatImageHistories = {}; }
}


/** Saves essential app state (theme, active chat, backend, etc.) */
function saveAppState() {
    try {
        const state = {
            activeChatId: activeChatId,
            backend: currentBackend,
            model: currentModel,
            theme: isDarkTheme ? 'dark' : 'light',
            nextChatId: chatIdCounter
        };
        localStorage.setItem('appState', JSON.stringify(state));
    } catch (e) { console.error("Failed to save app state:", e); }
}

/** Loads app state on startup and returns the activeChatId to load. */
function loadAppState() {
    let activeChatIdToLoad = null;
    try {
        const saved = localStorage.getItem('appState');
        if (saved) {
            const state = JSON.parse(saved);
            console.log("App state loaded:", state);
            currentBackend = state.backend || 'ollama';
            currentModel = state.model || ''; // Validated later
            isDarkTheme = (state.theme === 'dark');
            activeChatIdToLoad = state.activeChatId || null;
            chatIdCounter = state.nextChatId || 1;

            document.body.classList.toggle('dark-theme', isDarkTheme);
            backendSelect.value = currentBackend;
        } else {
             console.log("No app state found, using defaults.");
             document.body.classList.remove('dark-theme');
             backendSelect.value = 'ollama';
        }
    } catch (e) {
        console.error("Failed to load app state:", e);
        isDarkTheme = false; document.body.classList.remove('dark-theme');
        currentBackend = 'ollama'; backendSelect.value = 'ollama';
        chatIdCounter = 1;
    }
    return activeChatIdToLoad; // Return ID to load after UI render
}

/** Renders the chat list based on loaded chatHistories. */
function renderChatList() {
    console.log("Rendering chat list...");
    const dynamicChats = chatList.querySelectorAll('.chat-item:not(.chat-item-static)');
    dynamicChats.forEach(item => item.remove());

    let maxIdNum = 0;
    const chatIds = Object.keys(chatHistories);

    chatIds.forEach(chatId => {
        const idNumMatch = chatId.match(/(\d+)$/);
        if (idNumMatch) maxIdNum = Math.max(maxIdNum, parseInt(idNumMatch[1], 10));

        const history = chatHistories[chatId];
        let chatName = `Chat ${chatId.split('-').pop()}`;
        // Find the *oldest* user message for the name hint (last element in saved history)
        const oldestUserMsg = history?.slice().reverse().find(m => m.role === 'user');
        if (oldestUserMsg) {
             const firstWords = oldestUserMsg.content.split(' ').slice(0, 4).join(' ');
             chatName = firstWords.length > 25 ? firstWords.substring(0, 22) + '...' : firstWords;
             if (!chatName) chatName = "Chat " + chatId.split('-').pop();
        }

        const chatItem = document.createElement('div');
        chatItem.className = 'chat-item';
        chatItem.dataset.chatId = chatId;

        const initials = chatName.split(/[\s-_]+/).map(n => n[0]).join('').substring(0, 2).toUpperCase() || '??';
        let hash = 0;
        for (let i = 0; i < chatId.length; i++) { hash = chatId.charCodeAt(i) + ((hash << 5) - hash); }
        const bgColor = (hash & 0x00FFFFFF).toString(16).padStart(6, '0');

        chatItem.innerHTML = `
            <div class="chat-item-content">
                <img src="/static/chat-icon.png" alt="${initials}" onerror="this.src='https://via.placeholder.com/40/${bgColor}/FFFFFF?text=${initials}'">
                <span title="${chatName}">${chatName}</span>
            </div>
            <input type="checkbox" onclick="event.stopPropagation()" title="Select chat for deletion">
        `;
        chatItem.onclick = (e) => loadChat(chatName, chatItem, e);
        chatList.appendChild(chatItem);
    });

    chatIdCounter = maxIdNum + 1;
    console.log(`Chat list rendered. Next chat ID will be ${chatIdCounter}`);
}


// --- Event Listeners Setup ---

function setupEventListeners() {
    console.log('Setting up event listeners...');

    settingsBtn.addEventListener('click', () => toggleSettings());
    settingsCloseBtn.addEventListener('click', () => toggleSettings(false));
    comfyUIConnectBtn.addEventListener('click', checkComfyUIStatus);

    // API Endpoint Savers
    document.querySelectorAll('.save-api-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const apiKey = btn.dataset.api;
            // Find the input associated with this key - adjust if structure changes
            const input = document.getElementById(`${apiKey}Input`) || document.getElementById(`${apiKey}ApiInput`);
             if (input) {
                 saveApiEndpoint(apiKey, input.value);
             } else {
                 console.error(`Input element not found for API key: ${apiKey}`);
             }
        });
    });

    // Backend/Model Selection
    backendSelect.addEventListener('change', (e) => {
        currentBackend = e.target.value;
        console.log(`Backend changed to: ${currentBackend}`);
        fetchOllamaModels(); // Update model list visibility/content
        toggleExternalApiInputs(currentBackend === 'external'); // 11. Show/hide external fields
        saveAppState();
    });
    modelSelect.addEventListener('change', (e) => {
        currentModel = e.target.value;
        console.log(`Ollama model changed to: ${currentModel}`);
        saveAppState();
    });

    // Message Input & Sending
    sendBtn.onclick = sendMessage; // Initial action
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
             if (!isGenerating) sendMessage();
             else console.log("Enter pressed while generating - ignored.");
        }
    });
    micBtn.addEventListener('click', startVoiceInput);

    // Profile Panel Toggle
    profileToggleBtn.addEventListener('click', toggleProfile); // 1. Listener for profile toggle

    // Chat List Actions
    newChatBtn.addEventListener('click', () => addNewChat());
    deleteChatBtn.addEventListener('click', deleteSelectedChats);

    // Image Section Buttons (Only "Generate More" remains)
    const generateMoreBtn = document.querySelector('.profile button[onclick="generateMorePhotos()"]');
    if (generateMoreBtn) generateMoreBtn.onclick = generateMorePhotos;

    // ComfyUI Settings Listeners
    workflowUploadInput.addEventListener('change', handleWorkflowUpload);
    // Other ComfyUI buttons use onclick in HTML

    // Global Escape Listener
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && settingsPanel.style.display === 'block') {
            toggleSettings(false);
        }
    });

    console.log('Event listeners set up.');
}

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed.');

    configureMarked();

    // 1. Load Persisted Data
    loadChatHistories();
    loadImageHistories(); // 3. Load image histories
    const activeChatIdFromState = loadAppState();
    loadApiEndpoints();
    loadComfyUISettings();
    loadComfyWorkflow();

    // 2. Render UI based on loaded data
    renderChatList(); // Populates chat list

    // 3. Setup dynamic elements and event listeners
    setupEventListeners();

    // 4. Fetch dynamic data from backend
    fetchOllamaModels(); // Will respect loaded backend state
    checkComfyUIStatus();
    fetchComfyCheckpoints(); // Will attempt to select saved checkpoint

    // 5. Load the initial chat view
    let initialChatElement = null;
    if (activeChatIdFromState && chatHistories[activeChatIdFromState]) {
        initialChatElement = chatList.querySelector(`.chat-item[data-chat-id="${activeChatIdFromState}"]`);
    }
    if (!initialChatElement && chatList.children.length > 1) { // More than "Create New..."
        initialChatElement = chatList.querySelector('.chat-item:not(.chat-item-static)');
    }

    if (initialChatElement) {
        const initialChatName = initialChatElement.querySelector('span')?.textContent || 'Chat';
        loadChat(initialChatName, initialChatElement, null);
    } else {
        loadChat(null, null, null); // Load default view
    }

    // Set initial state for profile toggle button
    const isCollapsed = !appContainer.classList.contains('profile-collapsed'); // Check if *not* collapsed initially
    profileToggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    // Set initial title based on *current* state (assuming default is expanded)
    profileToggleBtn.setAttribute('title', appContainer.classList.contains('profile-collapsed') ? 'Show Profile Panel' : 'Hide Profile Panel');

    // 11. Show/hide external API fields based on loaded backend
    toggleExternalApiInputs(currentBackend === 'external');


    console.log('Cosmo AI GUI initialized.');
});
