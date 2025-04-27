import * as dom from './dom.js';
import * as state from './state.js';
import * as api from './api.js';
import * as ui from './ui.js';
import * as cfg from './config.js';
import { DEFAULT_COMFYUI_SETTINGS } from './config.js'; // Import defaults for reset

// --- SocketIO State --- (For Voice Interaction)
let socket = null;
let mediaRecorder = null;
let audioContext = null;
let audioQueue = [];
let audioSourceNode = null; // To hold the current playing source for stopping
let sampleAudioPlayer = null; // Reference for sample audio playback
let AVAILABLE_MICS = [];


// --- Core Action Functions ---

/** Sends user message or triggers image generation */
export async function sendMessage(optionalMessage = null) {
    if (state.isGenerating) {
        console.log("sendMessage blocked: isGenerating is true");
        return;
    }
     if (state.voiceSettings.enabled && state.voiceSettings.interactionMode === 'voice_only') {
        console.log("sendMessage blocked: In voice-only mode.");
         ui.appendMessage("<i>Currently in Voice-Only mode. Use the microphone.</i>", "error");
        return;
    }
    if (!dom.messageInput) {
        console.error("sendMessage failed: messageInput DOM element not found.");
        return;
    }

    const message = optionalMessage ?? dom.messageInput.value.trim();

    // Check if message is empty *before* calling toLowerCase
    if (!message) {
        if (!optionalMessage) {
            dom.messageInput.style.border = '1px solid red';
            setTimeout(() => { if (dom.messageInput) dom.messageInput.style.border = ''; }, 1000);
        }
        return;
    }


    if (!state.activeChatId) {
        console.log("sendMessage: No active chat, calling addNewChat...");
        await addNewChat(null, message);
        if (!state.activeChatId) {
             console.error("sendMessage failed: addNewChat did not set activeChatId.");
             ui.appendMessage("Failed to create or load a chat. Please try again.", "error");
             return;
        }
        console.log(`sendMessage: addNewChat completed, activeChatId is now ${state.activeChatId}`);
    }

    // Call toLowerCase here, after validation
    const lowerCaseMessage = message.toLowerCase();
    if (lowerCaseMessage.startsWith(cfg.IMAGE_TRIGGER_PHRASE)) {
        const prompt = message.substring(cfg.IMAGE_TRIGGER_PHRASE.length).trim();
        const effectivePrompt = prompt || `photorealistic portrait of a beautiful woman, high quality, detailed face, mystic background`;
        console.log(`Image generation triggered. Prompt: "${effectivePrompt}"`);
        ui.appendMessage(message, 'sent');
        if (dom.messageInput) dom.messageInput.value = '';
        state.setLastGeneratedFacePrompt(effectivePrompt);
        await generateImage(effectivePrompt);
        return;
    }

    // --- Determine Model Name based on Backend ---
    let modelNameForApi = '';
    if (state.currentBackend === 'ollama') {
        modelNameForApi = state.currentModel; // Get from state (set by dropdown)
        if (!modelNameForApi) {
            ui.appendMessage("Please select an Ollama model in Settings first.", 'error');
            ui.toggleSettingsView(true); return;
        }
    } else if (state.currentBackend === 'kobold') {
        modelNameForApi = 'default'; // Kobold often doesn't need a specific name
    } else if (state.currentBackend === 'custom_external') {
        // Model name for custom is handled by backend using stored value
        modelNameForApi = state.apiEndpoints.customModelName; // Use stored custom name
        if (!state.apiEndpoints.customApiEndpoint) {
            ui.appendMessage("Custom API Endpoint is not configured in Settings.", 'error');
            ui.toggleSettingsView(true); return;
        }
         if (!modelNameForApi) {
            ui.appendMessage("Custom Model Name is not configured in Settings.", 'error');
            ui.toggleSettingsView(true); return;
        }
    } else if (['groq', 'openai', 'google'].includes(state.currentBackend)) {
        // Get model name from the *external select* dropdown for these providers
        modelNameForApi = dom.externalModelSelect ? dom.externalModelSelect.value : '';
        if (!modelNameForApi) {
             // Use state.currentModel as fallback if select element is missing or has no value
             modelNameForApi = state.currentModel;
             if (!modelNameForApi) { // If still no model, show error
                ui.appendMessage(`Please select a Model for ${state.currentBackend.toUpperCase()} in Settings.`, 'error');
                ui.toggleSettingsView(true); return;
             }
        }
        state.setCurrentModel(modelNameForApi); // Ensure state matches dropdown
    } else if (['anthropic', 'xai'].includes(state.currentBackend)) {
        // Get model name from the *external input* field for these providers
        modelNameForApi = dom.externalModelInput ? dom.externalModelInput.value.trim() : '';
         if (!modelNameForApi) {
             // Use state.currentModel as fallback if input element is missing or has no value
             modelNameForApi = state.currentModel;
              if (!modelNameForApi) { // If still no model, show error
                ui.appendMessage(`Please enter the Model Name for ${state.currentBackend.toUpperCase()} in Settings.`, 'error');
                ui.toggleSettingsView(true); return;
             }
        }
        state.setCurrentModel(modelNameForApi); // Ensure state matches input
    } else {
        // This case should not be reached if backendSelect is populated correctly
        ui.appendMessage(`Selected backend '${state.currentBackend}' is not recognized.`, 'error');
        return;
    }
    // --- End Model Name Determination ---


    console.log(`sendMessage: Processing text message for backend ${state.currentBackend} with model ${modelNameForApi}`);
    ui.setLoadingState(true);
    ui.appendMessage(message, 'sent');
    if (dom.messageInput) dom.messageInput.value = '';

    let currentMessages = state.activeChatMessages;
    currentMessages.unshift({ role: 'user', content: message });
    state.setActiveChatMessages(currentMessages);
    await api.saveActiveChatHistory();

    const historyForContext = state.activeChatMessages.slice(1, cfg.HISTORY_CONTEXT_LENGTH * 2 + 1);
    state.setCurrentClientId(crypto.randomUUID());

    // Construct messages in the order expected by most APIs (older first)
    const messagesForApi = historyForContext.slice().reverse();
    messagesForApi.push({ role: 'user', content: message });

    try {
        // Payload now uses modelNameForApi determined above
        let payload = {
            backend: state.currentBackend,
            model: modelNameForApi,
            prompt: message, // Prompt might be redundant if using messages format, but include for flexibility
            history: historyForContext, // Backend expects newest first for history usually
            // Stream only for Ollama for now
            stream: state.currentBackend === 'ollama'
        };

        console.log("Payload being sent to backend:", JSON.stringify(payload));

        if (state.currentBackend === 'ollama' && payload.stream) {
            console.log(`sendMessage: Calling streamOllamaResponse`);
            await streamOllamaResponse(payload); // Stream function handles its own logic

        } else { // Non-streaming backends (Kobold, Groq, OpenAI, Google, Anthropic, xAI, Custom, non-stream Ollama)
            payload.stream = false; // Ensure stream is false
            console.log(`sendMessage: Calling backend proxy for ${state.currentBackend}`);
            const response = await api.makeApiRequest(cfg.GENERATE_API, { method: 'POST', body: payload });

            if (response.status === 'success' && response.response) {
                const aiResponse = response.response;
                 if (state.voiceSettings.interactionMode !== 'voice_only') {
                    ui.appendMessage(aiResponse, 'received', true); // Render as markdown
                 }
                let currentMsgs = state.activeChatMessages;
                currentMsgs.unshift({ role: 'assistant', content: aiResponse });
                state.setActiveChatMessages(currentMsgs);
                await api.saveActiveChatHistory();

                if (state.voiceSettings.enabled && state.voiceSettings.ttsEnabled && state.voiceSettings.interactionMode !== 'text_only') {
                     await triggerTTS(aiResponse);
                 }
                ui.setLoadingState(false);
            } else {
                // Handle errors from backend (already formatted with [Error: ...])
                // If response.status wasn't success, or response.response is missing
                throw new Error(response.message || `API call to ${state.currentBackend} failed or returned empty response.`);
            }
        }

    } catch (error) {
        console.error(`Error during ${state.currentBackend} generation:`, error);
        // Display the error message returned from makeApiRequest or caught locally
        ui.appendMessage(`Error: ${error.message}`, 'error');
        ui.setLoadingState(false); // Ensure loading state is reset on error
    }
}


/** Handles streaming response from Ollama using Server-Sent Events. */
async function streamOllamaResponse(payload) { // Payload contains backend info, model, prompt, history
    if (!dom.chatArea) {
        console.error("streamOllamaResponse failed: chatArea not found.");
        return;
    }

    let messageDiv = null;
    if (state.voiceSettings.interactionMode !== 'voice_only') {
        messageDiv = document.createElement('div');
        messageDiv.className = 'message received streaming';
        dom.chatArea.appendChild(messageDiv);
        setTimeout(() => dom.chatArea.scrollTop = dom.chatArea.scrollHeight, 0);
    }

    let fullResponse = '';
    let buffer = '';
    let reader = null;
    let wasCancelled = false;

    try {
        // Send the payload to our backend /api/generate?stream=true
        const requestOptions = {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
             body: JSON.stringify(payload), // Send the full payload
        };
        if (state.currentClientId) {
             requestOptions.headers['X-Client-ID'] = state.currentClientId;
        }

        console.log(`streamOllamaResponse: Fetching ${cfg.GENERATE_API}?stream=true`);
        const response = await fetch(`${cfg.GENERATE_API}?stream=true`, requestOptions);

        if (!response.ok) {
             let errorMsg = `Streaming connection failed: ${response.status} ${response.statusText}`;
             try {
                 // Try to parse error from backend response body
                 const errorBody = await response.text();
                 try { const errorJson = JSON.parse(errorBody); errorMsg = errorJson.message || errorJson.error || errorBody; }
                 catch { errorMsg = errorBody || errorMsg; } // Use text if not JSON
             } catch {} // Ignore errors reading error body
             throw new Error(errorMsg);
        }
        if (!response.body) throw new Error("Response body is null.");

        reader = response.body.getReader();
        const decoder = new TextDecoder();

        console.log("streamOllamaResponse: Starting reader loop...");
        while (true) {
             // Check cancellation flag at the start of each iteration
             if (!state.isGenerating) {
                 console.log("streamOllamaResponse: Cancellation detected in loop.");
                 wasCancelled = true;
                 if (reader) {
                     try { await reader.cancel("User cancelled"); } catch (e) { console.warn("Error cancelling reader:", e); }
                 }
                 break; // Exit the loop
             }

            const { done, value } = await reader.read();
            if (done) {
                 console.log("streamOllamaResponse: Reader loop finished (done).");
                 break; // Exit loop when stream ends
             }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep potential incomplete line in buffer

            for (const line of lines) {
                 if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6).trim();
                    // Check for backend's explicit DONE marker
                    if (dataStr === '[DONE]') {
                        console.log("streamOllamaResponse: Received explicit [DONE] marker from backend.");
                        continue; // Ignore this line, wait for reader.read() to be done
                    }

                    try {
                        const parsedData = JSON.parse(dataStr);
                        // Check for backend-reported errors within the stream
                        if (parsedData.status === 'error') {
                             throw new Error(parsedData.message || "Unknown error from backend stream");
                        }
                        // Expecting backend to send {'response': 'chunk'} consistently
                        if (parsedData.response) {
                             fullResponse += parsedData.response;
                             if (messageDiv) {
                                if (typeof marked !== 'undefined' && marked.parse) {
                                    messageDiv.innerHTML = marked.parse(fullResponse);
                                } else {
                                    // Fallback basic rendering
                                    messageDiv.innerHTML = fullResponse.replace(/\n/g, '<br>');
                                }
                                dom.chatArea.scrollTop = dom.chatArea.scrollHeight; // Scroll down
                             }
                        }
                    } catch (e) { console.warn('SSE JSON parsing warning:', e, 'Data:', dataStr); }
                 } else if (line.trim()) { console.debug("SSE non-data line:", line); } // Log other lines if needed
            }
        } // End while loop

        // After loop finishes (normally or by cancellation)
        if (messageDiv) messageDiv.classList.remove('streaming');

        // Trigger TTS only if not cancelled and response exists
        if (!wasCancelled && fullResponse && state.voiceSettings.enabled && state.voiceSettings.ttsEnabled && state.voiceSettings.interactionMode !== 'text_only') {
             await triggerTTS(fullResponse);
        }

    } catch (error) {
        console.error('streamOllamaResponse Error:', error);
        if (messageDiv) messageDiv.remove(); // Remove the placeholder div on error
        // Don't show error message if cancellation was intended
        if (error.name !== 'AbortError' && !wasCancelled) {
             ui.appendMessage(`Streaming Error: ${error.message}`, 'error');
        } else {
             console.log("streamOllamaResponse: Processing stopped due to cancellation or expected end.");
        }
    } finally {
        console.log("streamOllamaResponse: Finalizing stream processing.");
        // Ensure reader is cancelled if it exists and wasn't already cancelled
        if (reader && !reader.closed && !wasCancelled) {
             try { await reader.cancel(); } catch {}
        }

        // Save response to history only if not cancelled and response exists
        if (!wasCancelled && fullResponse && state.activeChatId) {
             console.log(`streamOllamaResponse: Saving full response to history.`);
             let currentMsgs = state.activeChatMessages;
             // Check if the first message is a placeholder (might happen on rapid interactions)
             if (currentMsgs.length > 0 && currentMsgs[0].role === 'assistant' && currentMsgs[0].content.includes('streaming')) {
                  currentMsgs[0].content = fullResponse; // Update placeholder
             } else {
                  // Add new assistant message
                  currentMsgs.unshift({ role: 'assistant', content: fullResponse });
             }
             state.setActiveChatMessages(currentMsgs);
             await api.saveActiveChatHistory(); // Save updated history
        } else if (!fullResponse && !wasCancelled) {
             console.warn("streamOllamaResponse: Stream ended with empty response.");
             if (messageDiv) messageDiv.innerHTML = "<i>[Empty Response]</i>";
        } else if (!fullResponse && wasCancelled) {
             console.log("streamOllamaResponse: Cancelled before receiving any response.");
             if (messageDiv) messageDiv.innerHTML = "<i>[Cancelled]</i>";
        }

        // Reset loading state ONLY if not cancelled (cancellation resets state earlier)
        if (!wasCancelled) {
            state.setIsGenerating(false); // Set global flag
            ui.setLoadingState(false); // Update UI buttons etc.
        }
    }
}


/** Generates an image using ComfyUI via the backend. */
export async function generateImage(prompt) {
    if (state.isGenerating) { ui.appendMessage("Please wait for the current task...", "error"); return; }
    if (!dom.generatedImage || !dom.imageSection) { console.error("generateImage: Image DOM elements missing."); return; }
    if (!prompt) { ui.appendMessage("Image prompt cannot be empty.", "error"); return; }
    if (!state.activeChatId) { ui.appendMessage("Please select a chat first.", "error"); return; }

    console.log(`generateImage: Initiating for prompt: "${prompt.substring(0,50)}..."`);
    ui.setLoadingState(true);

    try {
        state.setCurrentClientId(crypto.randomUUID()); // Generate unique ID for this task
        const payload = {
            prompt: prompt,
            workflow: state.comfyUIWorkflow, // Send current workflow state
            settings: state.comfyUISettings, // Send current settings state
            client_id: state.currentClientId // Send ID for cancellation
        };

        console.log("generateImage: Sending request to backend...");
        const response = await api.makeApiRequest(cfg.IMAGE_API, { method: 'POST', body: payload });
        console.log('generateImage response:', response);

        if (response.status === 'success' && response.image_url) {
            dom.generatedImage.src = response.image_url; // Display image
            dom.imageSection.style.display = 'block'; // Show section
            state.setLastGeneratedImageUrl(response.image_url); // Update state

            // Add image to history for the active chat
            if (state.activeChatId) {
                console.log(`generateImage: Adding image ${response.image_url} to history for chat ${state.activeChatId}`);
                let currentImages = state.activeChatImages;
                currentImages.unshift(response.image_url); // Add to beginning (newest first)
                state.setActiveChatImages(currentImages);
                await api.saveActiveChatHistory(); // Save updated history (includes images)
                ui.renderImageHistory(state.activeChatId); // Refresh thumbnails
            }
            ui.appendMessage(`Image generated successfully.`, 'received');
        } else if (response.status === 'cancelled') {
            ui.appendMessage('Image generation was cancelled.', 'received');
        } else {
            // Handle backend errors reported in the response
            throw new Error(response.message || 'Image generation failed on the backend.');
        }
    } catch (error) {
        console.error('Error generating image:', error);
        ui.appendMessage(`Image Generation Error: ${error.message}`, 'error');
    } finally {
        ui.setLoadingState(false); // Reset loading state
    }
}

/** Generates more photos based on the last "send your photo" prompt. */
export async function generateMorePhotos() {
    console.log("generateMorePhotos clicked.");
    if (!state.lastGeneratedFacePrompt) {
        ui.appendMessage("Use the 'send your photo [your prompt]' command first to set a base prompt.", "error");
        return;
    }
    // Create a slightly modified prompt for variation
    const newPrompt = `${state.lastGeneratedFacePrompt}, cinematic lighting, different angle, high detail variation`;
    console.log("generateMorePhotos: Generating with prompt:", newPrompt);
    await generateImage(newPrompt); // Call the main image generation function
}

/** Adds a new chat item to the list and loads it. */
export async function addNewChat(chatId = null, nameHint = null) {
    console.log("addNewChat function started. nameHint:", nameHint);
    if (!dom.chatList) {
        console.error("Cannot add new chat, chatList element not found.");
        return;
    }

    // Use provided ID or generate a new one
    const newChatId = chatId || `chat-${state.chatIdCounter}`;
    // Increment counter only if we generated a new ID
    if (!chatId) state.setChatIdCounter(state.chatIdCounter + 1);

    // Determine chat name from hint or default
    let chatName = nameHint
        ? nameHint.split(' ').slice(0, 4).join(' ').substring(0, 25) // First 4 words, max 25 chars
        : `Chat ${newChatId.split('-').pop()}`; // Default name
    if (nameHint && nameHint.length > 25) chatName += '...'; // Add ellipsis if truncated
    console.log(`addNewChat: Generated ID ${newChatId}, Name: ${chatName}`);

    // Create the chat item element
    const chatItem = document.createElement('div');
    chatItem.className = 'chat-item';
    chatItem.dataset.chatId = newChatId;

    // Generate icon fallback based on ID/Name
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

    // Insert the new chat item after the static "Create New..." item
    dom.chatList.insertBefore(chatItem, dom.chatList.children[1]);
    console.log("addNewChat: Chat item added to UI list.");

    // Add to known chat list state
    let currentKnownList = state.knownChatList;
    currentKnownList.unshift({ id: newChatId, name: chatName }); // Add to beginning
    state.setKnownChatList(currentKnownList);
    console.log("addNewChat: Chat added to knownChatList state.");

    // Set as active chat immediately
    state.setActiveChatId(newChatId);
    state.setActiveChatMessages([]); // Start with empty history
    state.setActiveChatImages([]);
    try {
        // Initialize history on the backend by saving the empty state
        console.log(`addNewChat: Initializing backend history for ${newChatId}...`);
        await api.saveActiveChatHistory();
        console.log(`addNewChat: Backend history initialized for ${newChatId}.`);
    } catch (e) {
         console.error(`addNewChat: Failed to initialize backend history for ${newChatId}:`, e);
         ui.appendMessage(`Error creating chat ${newChatId} on server.`, "error");
         // Rollback UI and state changes if backend save fails
         chatItem.remove();
         state.setKnownChatList(state.knownChatList.filter(c => c.id !== newChatId));
         state.setActiveChatId(null);
         state.saveAppState();
         return; // Prevent loading the failed chat
    }

    state.saveAppState(); // Save updated counter and active ID
    console.log("addNewChat: App state saved.");

    // Load the newly created chat (will clear area and show "Start typing...")
    console.log(`addNewChat: Calling loadChat for new chat: ${newChatId}`);
    await loadChat(newChatId, chatItem, null, true); // Pass isNewChat flag
    console.log(`addNewChat: Finished loading new chat: ${chatName} (ID: ${newChatId})`);

    // Focus input if not in voice-only mode
    if(dom.messageInput && state.voiceSettings?.interactionMode !== 'voice_only') {
        if (!dom.messageInput.disabled) {
             dom.messageInput.focus();
        } else {
            console.warn("addNewChat: messageInput still disabled after loadChat, cannot focus.");
        }
    }
}

/** Loads chat history from backend for the specified chat ID. */
export async function loadChat(chatId, chatElement, event, isNewChat = false) {
    console.log(`loadChat called with chatId: ${chatId}, event type: ${event?.type}, isNewChat: ${isNewChat}`);
    if (!dom.chatArea || !dom.messageInput || !dom.imageHistoryDiv || !dom.generatedImage || !dom.imageSection) {
        console.error("Cannot load chat, essential DOM elements missing.");
        return;
    }

     // Handle click on the static "Create New..." item
     if (event && chatElement?.classList.contains('chat-item-static')) {
          console.log("loadChat: Static item clicked, calling addNewChat...");
          await addNewChat();
          return;
     }
    // Ignore clicks on checkboxes within chat items
    if (event && event.target.type === 'checkbox') {
        console.log("loadChat: Checkbox clicked, ignoring.");
        return;
    }

    // Determine the target chat ID from element or argument
    const targetChatId = chatElement ? chatElement.dataset.chatId : chatId;
    // Prevent reloading if the chat is already active (unless it's a new chat being loaded)
    if (targetChatId && targetChatId === state.activeChatId && !isNewChat) {
         console.log(`loadChat: Chat ${targetChatId} is already active. No action needed.`);
         return;
     }
    console.log(`loadChat: Attempting to load chat ID: ${targetChatId || 'None'}`);

    // --- Reset UI State ---
    if (state.activeChatElement) state.activeChatElement.classList.remove('active');
    dom.chatArea.innerHTML = ''; // Clear message area
    dom.imageHistoryDiv.innerHTML = ''; // Clear image thumbnails
    dom.generatedImage.src = ''; // Clear main image
    dom.imageSection.style.display = 'none'; // Hide image section
    state.setLastGeneratedImageUrl(null); // Reset last image state
    state.setActiveChatMessages([]); // Clear message state
    state.setActiveChatImages([]); // Clear image state
    state.setActiveChatId(null); // Clear active ID state
    state.setActiveChatElement(null); // Clear active element state
    if(dom.messageInput) dom.messageInput.disabled = true; // Disable input initially
    // --- End Reset UI State ---

    // If a valid target chat ID is provided
    if (targetChatId) {
         // Set the corresponding chat item as active in the UI
         if(chatElement) {
             state.setActiveChatElement(chatElement);
             state.activeChatElement.classList.add('active');
         } else {
            // Find the element if only ID was passed
            const foundElement = dom.chatList?.querySelector(`.chat-item[data-chat-id="${targetChatId}"]`);
            if(foundElement) {
                state.setActiveChatElement(foundElement);
                state.activeChatElement.classList.add('active');
            } else {
                 console.warn(`loadChat: Could not find chat item element for ID ${targetChatId}`);
            }
         }
         // Set the active chat ID in the state
         state.setActiveChatId(targetChatId);
         console.log(`loadChat: Set activeChatId to ${targetChatId}`);

         // Enable message input
         if(dom.messageInput) dom.messageInput.disabled = false;

         if (isNewChat) {
             // If it's a newly created chat, don't fetch history, just show placeholder
             console.log("loadChat: Skipping history fetch for new chat.");
             state.setActiveChatMessages([]); // Ensure empty
             state.setActiveChatImages([]); // Ensure empty
             ui.appendMessage('Start typing to begin this chat!', 'received');
             ui.renderImageHistory(state.activeChatId); // Render empty image history
             setTimeout(() => { if (dom.chatArea) dom.chatArea.scrollTop = dom.chatArea.scrollHeight; }, 0);
         } else {
             // If it's an existing chat, fetch history from backend
             try {
                 console.log(`loadChat: Fetching history for existing chat ${state.activeChatId}...`);
                 const response = await api.makeApiRequest(cfg.CHAT_HISTORY_API(state.activeChatId), { method: 'GET' });

                 if (response.status === 'success' && response.history) {
                     // Load messages and images into state
                     state.setActiveChatMessages(response.history.messages || []);
                     state.setActiveChatImages(response.history.images || []);
                     console.log(`loadChat: Loaded ${state.activeChatMessages.length} msgs, ${state.activeChatImages.length} imgs for ${state.activeChatId}`);

                     // Render messages (oldest first)
                     if (state.activeChatMessages.length > 0) {
                        state.activeChatMessages.slice().reverse().forEach(msg => {
                            ui.appendMessage(msg.content, msg.role === 'user' ? 'sent' : 'received', msg.role === 'assistant');
                        });
                     } else {
                        // Show placeholder if chat exists but has no messages
                        ui.appendMessage('Start typing to continue this chat!', 'received');
                     }
                     // Render image history thumbnails
                     ui.renderImageHistory(state.activeChatId);

                 } else { throw new Error(response.message || 'Failed to load chat history.'); }
             } catch (error) {
                 console.error(`loadChat: Error loading chat ${state.activeChatId}:`, error);
                 ui.appendMessage(`Error loading chat history: ${error.message}`, 'error');
                 if(dom.messageInput) dom.messageInput.disabled = true; // Disable input on error
             } finally {
                 // Ensure chat area is scrolled to the bottom after loading
                 setTimeout(() => { if (dom.chatArea) dom.chatArea.scrollTop = dom.chatArea.scrollHeight; }, 0);
             }
         }

     } else {
         // No target chat selected (e.g., after deleting active chat)
         console.log("loadChat: No target chat selected, loading default view.");
         if(dom.messageInput) dom.messageInput.disabled = true; // Keep input disabled
         ui.appendMessage('Select a chat from the left or click "Create New..." to start.', 'received');
         setTimeout(() => { if (dom.chatArea) dom.chatArea.scrollTop = 0; }, 0); // Scroll to top
     }

     state.saveAppState(); // Save the active chat ID
     console.log("loadChat function finished.");
}


/** Deletes selected chats from backend and UI. */
export async function deleteSelectedChats() {
    console.log("deleteSelectedChats function started.");
    if (!dom.chatList) { console.error("deleteSelectedChats: chatList not found."); return; }

    // Find all checked checkboxes within dynamic chat items
    const checkboxes = dom.chatList.querySelectorAll('.chat-item:not(.chat-item-static) input[type="checkbox"]:checked');
    if (checkboxes.length === 0) {
        ui.appendMessage("Please select one or more chats to delete using the checkboxes.", "error");
        return;
    }
    // Confirm deletion with the user
    if (!confirm(`Are you sure you want to permanently delete ${checkboxes.length} selected chat(s)? This cannot be undone.`)) {
        return;
    }

    console.log(`Deleting ${checkboxes.length} chats...`);
    ui.setLoadingState(true); // Indicate processing

    let activeChatWasDeleted = false;
    const promises = [];
    const deletedIds = [];
    const failedDeletions = [];

    checkboxes.forEach(checkbox => {
        const chatItem = checkbox.closest('.chat-item');
        if (chatItem && chatItem.dataset.chatId) {
            const chatIdToDelete = chatItem.dataset.chatId;
            console.log(`deleteSelectedChats: Preparing to delete ${chatIdToDelete}`);
            if (state.activeChatId === chatIdToDelete) activeChatWasDeleted = true;

            // Queue a backend delete request for each selected chat
            promises.push(
                api.makeApiRequest(cfg.CHAT_HISTORY_API(chatIdToDelete), { method: 'DELETE' })
                    .then(response => {
                        if (response.status === 'success') {
                            console.log(`deleteSelectedChats: Successfully deleted ${chatIdToDelete} from backend.`);
                            deletedIds.push(chatIdToDelete); // Track successful deletions
                            chatItem.remove(); // Remove item from UI list
                            return { id: chatIdToDelete, success: true };
                        } else {
                            // If backend reports failure (e.g., file not found, permission error)
                            throw new Error(response.message || `Backend failed to delete ${chatIdToDelete}`);
                        }
                    })
                    .catch(error => {
                        // Handle network errors or backend-reported errors
                        console.error(`deleteSelectedChats: Error deleting chat ${chatIdToDelete}:`, error);
                        failedDeletions.push(chatIdToDelete);
                        ui.appendMessage(`Error deleting chat ${chatIdToDelete}: ${error.message}`, 'error');
                        checkbox.checked = false; // Uncheck the box on failure
                        return { id: chatIdToDelete, success: false };
                    })
            );
        }
    });

    // Wait for all delete requests to complete
    await Promise.all(promises);

    // Update the known chat list state by removing successfully deleted IDs
    if (deletedIds.length > 0) {
        let currentKnownList = state.knownChatList.filter(chat => !deletedIds.includes(chat.id));
        state.setKnownChatList(currentKnownList);
    }

    console.log("deleteSelectedChats: Finished processing all delete requests.");
    ui.setLoadingState(false); // Reset loading state

    // If the currently active chat was deleted, load the default empty view
    if (activeChatWasDeleted) {
        console.log("deleteSelectedChats: Active chat was deleted, loading default view.");
        state.setActiveChatElement(null);
        state.setActiveChatId(null);
        state.setActiveChatMessages([]);
        state.setActiveChatImages([]);
        await loadChat(null, null, null); // Load empty state
    }
    state.saveAppState(); // Save updated known list and potentially active ID
}

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

    // Load the default empty view
    await loadChat(null, null, null);

    state.saveAppState(); // Persist the cleared state
    ui.setLoadingState(false); // Reset loading indicator
    ui.appendMessage("All chat and image history has been cleared from the server.", 'received');
    console.log("clearHistory function finished.");
}

/** Deletes a specific image from the active chat's history (local state and backend). */
export async function deleteImageFromHistory(chatId, indexToDelete, imageUrlToDelete) {
    console.log(`deleteImageFromHistory called for chat ${chatId}, index ${indexToDelete}`);
    // Validate input: ensure chat is active, index is valid
    if (!chatId || chatId !== state.activeChatId || indexToDelete < 0 || indexToDelete >= state.activeChatImages.length) {
        console.error("deleteImageFromHistory: Invalid parameters or wrong chat active.");
        ui.appendMessage("Cannot delete image: Invalid request or chat not active.", 'error');
        return;
    }
    // Confirm with user
    if (!confirm(`Are you sure you want to remove this image from the history?`)) {
        return;
    }

    console.log(`deleteImageFromHistory: Deleting image index ${indexToDelete}`);
    // Create a new array without the image at the specified index
    let currentImages = [...state.activeChatImages];
    const deletedImage = currentImages.splice(indexToDelete, 1); // Remove the image
    state.setActiveChatImages(currentImages); // Update state
    console.log(`Image removed from state: ${deletedImage}`);

    // Save the updated history (without the deleted image) to the backend
    await api.saveActiveChatHistory();
    // Re-render the image history thumbnails for the current chat
    ui.renderImageHistory(chatId);
    console.log("deleteImageFromHistory finished.");
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

// --- Event Listener Setup ---
/** Sets up all primary event listeners for the application. */
export function setupEventListeners() {
    console.log('Setting up event listeners...');

    // Settings Panel Toggle Buttons
    if (dom.settingsBtn) dom.settingsBtn.addEventListener('click', () => ui.toggleSettingsView(true));
    else console.warn("Settings button not found");
    if (dom.settingsCloseBtn) dom.settingsCloseBtn.addEventListener('click', () => ui.toggleSettingsView(false));
    else console.warn("Settings close button not found");

    // ComfyUI Connect Button
    if (dom.comfyUIConnectBtn) dom.comfyUIConnectBtn.addEventListener('click', api.checkComfyUIStatus);
    else console.warn("ComfyUI connect button not found");

    // API Savers - Now uses data-api attribute like 'groqApiKey', 'customModelName', etc.
    document.querySelectorAll('.save-api-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const apiKey = btn.dataset.api; // e.g., 'ollama', 'groqApiKey', 'customModelName'
            // Construct the expected input ID based on the apiKey
            const inputId = `${apiKey}Input`;
            const input = document.getElementById(inputId);
            if (input) {
                 console.log(`Save API button clicked for: ${apiKey}`);
                 api.saveApiEndpoint(apiKey, input.value); // Pass the specific key/value to API function
            } else {
                console.error(`Input element not found for API key: ${apiKey} (Expected ID: ${inputId})`);
             }
        });
    });


     // Settings Tabs
     const tabsContainer = dom.settingsPanel?.querySelector('.tabs');
     if (tabsContainer) {
         tabsContainer.addEventListener('click', (e) => {
             // Delegate clicks to tab elements
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
            // Fetch models for providers that have a /models endpoint
            // Check if API key is present before fetching
             const apiKeyInputId = `${newBackend}ApiKeyInput`; // Construct key input ID
             const apiKeyInput = document.getElementById(apiKeyInputId);
             // Use optional chaining and check trimmed value
             if (apiKeyInput?.value?.trim()) {
                console.log(`API key found for ${newBackend}, fetching models...`);
                api.fetchExternalModels(newBackend).then(models => {
                    ui.populateExternalModelSelect(models, newBackend);
                    // Do not automatically select a model here, let user choose
                     state.setCurrentModel(''); // Clear model state until user selects
                });
             } else {
                 console.log(`API key for ${newBackend} not entered, skipping model fetch.`);
                 ui.populateExternalModelSelect([], newBackend); // Clear dropdown
                 state.setCurrentModel('');
             }
        } else if (['anthropic', 'xai', 'custom_external'].includes(newBackend)) {
            // These require manual input, clear the dropdown, ensure input is visible
             ui.populateExternalModelSelect([], newBackend); // Ensure dropdown is cleared/shows guide
             // For custom, pre-fill input with saved custom name
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
        state.saveAppState(); // Save the selected backend (model state cleared or will be set by fetch/user)

    }); else console.warn("Backend select not found");

    // Listener for the *Ollama* model select dropdown
    if (dom.modelSelect) dom.modelSelect.addEventListener('change', (e) => {
        // Only update state if the current backend IS Ollama
        if (state.currentBackend === 'ollama') {
            state.setCurrentModel(e.target.value);
            console.log(`Ollama model changed to: ${state.currentModel}`);
            state.saveAppState(); // Save the selected Ollama model
        }
    }); else console.warn("Model select (Ollama) not found");

    // Listener for the *external* model select dropdown
    if (dom.externalModelSelect) {
        dom.externalModelSelect.addEventListener('change', (e) => {
            const selectedModel = e.target.value;
            // Update state only if the current backend uses this dropdown
            if (['groq', 'openai', 'google'].includes(state.currentBackend)) {
                state.setCurrentModel(selectedModel);
                console.log(`External model select changed to: ${selectedModel} for backend ${state.currentBackend}`);
                state.saveAppState(); // Save the selected model
            }
        });
    } else console.warn("External Model Select not found");

    // Listener for the *external* model input field (manual entry)
     if (dom.externalModelInput) {
         dom.externalModelInput.addEventListener('change', (e) => { // 'change' triggers on blur or Enter
             const enteredModel = e.target.value.trim();
             // Update state only if the current backend uses this input field
             if (['anthropic', 'xai', 'custom_external'].includes(state.currentBackend)) {
                 state.setCurrentModel(enteredModel);
                 console.log(`External model input changed to: ${enteredModel} for backend ${state.currentBackend}`);
                 // If it's the custom backend, DO NOT automatically save to apiEndpoints.customModelName
                 // User must click the specific save button for that field.
                 state.saveAppState(); // Save the currently selected/typed model name
             }
         });
     } else console.warn("External Model Input not found");


    // Send Button and Message Input Enter Key
    if (dom.sendBtn) dom.sendBtn.onclick = () => sendMessage(); // Initial assignment
    else console.warn("Send button not found");
    if (dom.messageInput) dom.messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault(); // Prevent default newline behavior
             // Check generating flag and voice mode before sending
             if (!state.isGenerating && !(state.voiceSettings.enabled && state.voiceSettings.interactionMode === 'voice_only')) {
                 sendMessage();
             } else {
                 console.log("Enter pressed while generating or in voice-only mode - ignored.");
             }
        }
    }); else console.warn("Message input not found");

    // Mic Button
    if (dom.micBtn) {
        dom.micBtn.addEventListener('click', () => {
             if (!state.voiceSettings.enabled) {
                 ui.appendMessage("<i>Voice mode is disabled. Enable it in Settings > Voice.</i>", "error");
                 return;
             }
            // Toggle voice input state
            if (state.isVoiceActive) { stopVoiceInput(); }
            else { startVoiceInput(); }
        });
        // Initialize mic button state (will be updated by voice_config)
        dom.micBtn.dataset.ready = 'false';
        dom.micBtn.disabled = true;
    } else console.warn("Mic button not found");

    // Panel Toggle Buttons
    if (dom.chatFrameToggleBtn) dom.chatFrameToggleBtn.addEventListener('click', toggleChatSettingsFrame);
    else console.warn("Chat/Settings frame toggle button not found");
    if (dom.profileToggleBtn) dom.profileToggleBtn.addEventListener('click', toggleProfile);
    else console.warn("Profile toggle button not found");

     // Chat List Delegation
     if (dom.chatList) {
         dom.chatList.addEventListener('click', (e) => {
             const chatItem = e.target.closest('.chat-item');
             if (!chatItem) { return; } // Clicked outside an item

             // Handle static "Create New..." item
             if (chatItem.classList.contains('chat-item-static')) {
                 console.log("Static 'Create New...' item clicked in delegation");
                 addNewChat(); // Call without args
                 return;
             }
             // Ignore clicks on the checkbox itself
             if (e.target.type === 'checkbox') {
                 console.log("Checkbox click ignored by delegation");
                 return;
             }
             // Handle clicks on dynamic chat items
             if (chatItem.dataset.chatId) {
                 console.log(`Delegated click loading chat: ${chatItem.dataset.chatId}`);
                 loadChat(chatItem.dataset.chatId, chatItem, e); // Load existing chat
             }
         });
     } else console.error("Chat list element not found!");

    // Chat Action Buttons
    if (dom.newChatBtn) dom.newChatBtn.addEventListener('click', () => addNewChat());
    else console.error("New Chat button (#newChatBtn) not found!");
    if (dom.deleteChatBtn) dom.deleteChatBtn.addEventListener('click', deleteSelectedChats);
    else console.error("Delete Chat button (#deleteChatBtn) not found!");

    // Generate More Photos Button
    if (dom.generateMorePhotosBtn) dom.generateMorePhotosBtn.onclick = generateMorePhotos;
    else console.warn("Generate More Photos button not found");

    // General Settings Buttons
    if (dom.toggleThemeBtn) dom.toggleThemeBtn.onclick = ui.toggleTheme;
    else console.warn("Toggle theme button not found");
    if (dom.clearHistoryBtn) dom.clearHistoryBtn.onclick = clearHistory;
    else console.warn("Clear history button not found");

    // ComfyUI Settings Buttons & Inputs
    if (dom.saveComfyUISettingsBtn) dom.saveComfyUISettingsBtn.onclick = saveComfyUISettings;
    else console.warn("Save ComfyUI settings button not found");
    if (dom.resetComfyUISettingsBtn) dom.resetComfyUISettingsBtn.onclick = resetComfyUISettings;
    else console.warn("Reset ComfyUI settings button not found");
    if (dom.workflowUploadInput) dom.workflowUploadInput.addEventListener('change', handleWorkflowUpload);
    else console.warn("Workflow upload input not found");

    setupVoiceSettingsListeners(); // Setup listeners specifically for the Voice tab

    // Global Escape Listener for Settings Panel
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.settingsPanel && dom.settingsPanel.style.display === 'block') {
            ui.toggleSettingsView(false); // Close settings on Escape
        }
    });

    console.log('Event listeners setup complete.');
}

/** Sets up listeners specifically for the Voice settings tab */
function setupVoiceSettingsListeners() {
    if (dom.voiceEnableToggle) {
        dom.voiceEnableToggle.addEventListener('change', (e) => {
            const isEnabled = e.target.checked;
            state.voiceSettings.enabled = isEnabled;
            ui.updateVoiceSettingsUI(isEnabled); // Update all voice UI elements enable/disable state
            // Update mic button immediately based on new enabled state and STT readiness
            if (dom.micBtn) {
                 const sttReady = state.WHISPER_LOADED_ON_BACKEND;
                 dom.micBtn.disabled = !isEnabled || !sttReady || state.isGenerating || state.isVoiceActive;
                 dom.micBtn.title = isEnabled ? (sttReady ? "Voice Input" : "Voice Input (Server STT Unavailable)") : "Voice Input (Disabled)";
                 ui.updateMicButtonState(state.isVoiceActive); // Ensure visual state matches
            }
            saveVoiceSettings(); // Persist the change
             // Stop any active recording if voice is disabled
             if (!isEnabled && state.isVoiceActive) {
                 stopVoiceInput();
             }
             // If enabling, try to connect socket if not already connected
             if (isEnabled && (!socket || !socket.connected)) {
                  console.log("Voice enabled, ensuring Socket.IO connection...");
                  setupSocketIO(); // Attempt to connect/reconnect
              }
        });
    } else console.warn("Voice Enable Toggle not found");

     if (dom.ttsEnableToggle) {
         dom.ttsEnableToggle.addEventListener('change', (e) => {
             state.voiceSettings.ttsEnabled = e.target.checked;
             ui.updateVoiceSettingsUI(state.voiceSettings.enabled); // Update TTS dependent controls enable/disable state
             saveVoiceSettings(); // Persist the change
             // Stop any ongoing playback if TTS output is disabled
             if (!state.voiceSettings.ttsEnabled) {
                 stopAudioPlayback();
             }
         });
     } else console.warn("TTS Enable Toggle not found");

    if (dom.micSelect) {
        dom.micSelect.addEventListener('change', (e) => {
            state.voiceSettings.micId = e.target.value;
            saveVoiceSettings(); // Persist the change
            // If recording, restart with the new mic
            if (state.isVoiceActive) {
                 console.log("Microphone changed while recording. Restarting input.");
                 stopVoiceInput();
                 setTimeout(startVoiceInput, 100); // Short delay before restarting
             }
        });
    } else console.warn("Microphone Select not found");
    if (dom.sttLanguageSelect) {
        dom.sttLanguageSelect.addEventListener('change', (e) => {
            state.voiceSettings.sttLanguage = e.target.value;
            saveVoiceSettings(); // Persist the change
             // Inform backend about the language change immediately
             if(socket && socket.connected) socket.emit('set_voice_settings', { sttLanguage: state.voiceSettings.sttLanguage });
        });
    } else console.warn("STT Language Select not found");

    // TTS Model Selection Listener
    if (dom.ttsModelSelect) {
        dom.ttsModelSelect.addEventListener('change', (e) => {
            const selectedModel = e.target.value;
            state.setSelectedTTSModelName(selectedModel); // Store user's *selection* immediately
             if (selectedModel) {
                // Trigger backend model load immediately on change
                api.setTTSModel(selectedModel); // This function handles state saving on success
             } else {
                // Handle empty selection (e.g., "Select Model...")
                state.setCurrentTTSModelName(''); // Clear currently loaded model state
                state.setCurrentTTSSpeakers([]); // Clear speakers
                ui.populateSpeakerList([]); // Clear speaker list in UI
                ui.updateVoiceSettingsUI(state.voiceSettings.enabled); // Update dependent controls enable/disable state
             }
        });
    } else console.warn("TTS Model Select not found");

    // Speaker Selection Listener
    if (dom.voiceSelect) {
        dom.voiceSelect.addEventListener('change', (e) => {
            state.voiceSettings.ttsSpeaker = e.target.value; // Store speaker preference
            saveVoiceSettings(); // Save updated speaker setting
            // Inform backend about the speaker preference change immediately
            if (socket && socket.connected) {
                socket.emit('set_voice_settings', { ttsSpeaker: state.voiceSettings.ttsSpeaker });
            }
        });
    } else console.warn("TTS Speaker Select (voiceSelect) not found");

    // Sample Voice Button Listener
    if (dom.sampleVoiceBtn) {
        dom.sampleVoiceBtn.addEventListener('click', () => {
            const selectedSpeaker = dom.voiceSelect ? dom.voiceSelect.value : null;
            api.sampleTTSVoice(selectedSpeaker); // Call API function to get sample
        });
    } else console.warn("Sample Voice Button not found");


    // Sliders
    if (dom.voiceSpeedSlider) {
        dom.voiceSpeedSlider.addEventListener('input', (e) => { // Update value display on drag
            const speed = parseFloat(e.target.value);
            state.voiceSettings.ttsSpeed = speed;
            if(dom.voiceSpeedValue) dom.voiceSpeedValue.textContent = `${speed.toFixed(1)}x`;
        });
         dom.voiceSpeedSlider.addEventListener('change', () => saveVoiceSettings()); // Save on release
    } else console.warn("TTS Speed Slider not found");
     if (dom.voicePitchSlider) {
        dom.voicePitchSlider.addEventListener('input', (e) => { // Update value display on drag
             const pitch = parseFloat(e.target.value);
            state.voiceSettings.ttsPitch = pitch;
             if(dom.voicePitchValue) dom.voicePitchValue.textContent = `${pitch.toFixed(1)}x`;
        });
         dom.voicePitchSlider.addEventListener('change', () => saveVoiceSettings()); // Save on release
    } else console.warn("TTS Pitch Slider not found");

    // Mode & Playback
    if (dom.interactionModeSelect) {
        dom.interactionModeSelect.addEventListener('change', (e) => {
            state.voiceSettings.interactionMode = e.target.value;
            saveVoiceSettings(); // Persist change
            // Show/hide text input based on mode
            if(dom.messageInput) dom.messageInput.style.display = state.voiceSettings.interactionMode === 'voice_only' ? 'none' : '';
            if(dom.sendBtn) dom.sendBtn.style.display = state.voiceSettings.interactionMode === 'voice_only' ? 'none' : '';
        });
    } else console.warn("Interaction Mode Select not found");
    if (dom.replayBtn) {
        dom.replayBtn.addEventListener('click', replayLastAudio);
    } else console.warn("Replay Button not found");
    if (dom.stopAudioBtn) {
        dom.stopAudioBtn.addEventListener('click', () => {
            stopAudioPlayback(); // Stop main TTS playback
            // Also stop sample playback if it's running
            if (sampleAudioPlayer && !sampleAudioPlayer.paused) {
                 try {
                     sampleAudioPlayer.pause();
                     sampleAudioPlayer.currentTime = 0; // Reset position
                     console.log("Stopped sample audio playback via button.");
                      // Re-enable sample button after stopping
                      if (dom.sampleVoiceBtn) {
                          // Check conditions again to re-enable
                          const canSample = state.voiceSettings.enabled && state.TTS_LOADED_ON_BACKEND && !state.ttsModelLoading;
                          dom.sampleVoiceBtn.disabled = !canSample;
                          dom.sampleVoiceBtn.textContent = '▶️ Sample';
                      }
                 } catch (e) { console.error("Error stopping sample audio:", e); }
             }
        });
    } else console.warn("Stop Audio Button not found");

    console.log("Voice settings listeners setup.");
}

/** Persists voice settings to localStorage */
function saveVoiceSettings() {
    try {
        // Save the entire voiceSettings object
        localStorage.setItem('voiceSettings', JSON.stringify(state.voiceSettings));
        // Also save within the main app state bundle for consistency
        state.saveAppState();
        console.log("Voice settings saved:", state.voiceSettings);
    } catch (e) {
        console.error("Failed to save voice settings:", e);
    }
}

// Voice settings loading is handled within state.loadAppState

// --- SocketIO Setup & Voice Functions ---

/** Starts voice input using Microphone and sends chunks via SocketIO. */
async function startVoiceInput() {
    // Check prerequisites
    if (state.isGenerating || state.isVoiceActive) {
        console.log("Voice input cannot start: Task running or voice already active.");
        return;
    }
    if (!socket || !socket.connected) {
        ui.appendMessage("<i>Voice service not connected. Cannot start recording.</i>", "error");
        ui.updateVoiceIndicator('error');
        return;
    }
    if (!state.WHISPER_LOADED_ON_BACKEND) {
         ui.appendMessage("<i>Speech-to-text engine not ready on server. Cannot start recording.</i>", "error");
        return;
    }
    if (!state.voiceSettings.enabled) {
         ui.appendMessage("<i>Voice mode is disabled in settings.</i>", "error");
        return;
    }

    stopAudioPlayback(); // Stop any ongoing playback before starting recording
    state.setIsVoiceActive(true); // Set state flag
    ui.updateMicButtonState(true); // Update button visual state
    console.log('Attempting to start voice input...');

    try {
        // Get microphone access
        const stream = await navigator.mediaDevices.getUserMedia({
             audio: { deviceId: state.voiceSettings.micId !== 'default' ? { exact: state.voiceSettings.micId } : undefined }
         });
        console.log("Microphone access granted.");

        // Configure MediaRecorder
        const options = { mimeType: 'audio/webm;codecs=opus' }; // Prefer Opus codec
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
             console.warn(`${options.mimeType} not supported, trying default mimeType.`);
             delete options.mimeType; // Fallback to browser default
        }
        mediaRecorder = new MediaRecorder(stream, options);
        console.log(`Using MediaRecorder with options:`, options);

        // Handle data chunks
        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0 && socket && socket.connected && state.isVoiceActive) {
                // Convert Blob chunk to ArrayBuffer before sending
                event.data.arrayBuffer().then(buffer => {
                    // Double-check state and connection before emitting
                    if (socket && socket.connected && state.isVoiceActive) {
                        socket.emit('audio_chunk', { audio: buffer });
                    }
                }).catch(e => console.error("Error converting blob chunk to ArrayBuffer:", e));
            }
        };

        // Handle recorder start
        mediaRecorder.onstart = () => {
            console.log("MediaRecorder started.");
            ui.showVoiceStatus("Listening...", true); // Show visual indicator
            // Inform backend that recording has started
            if (socket && socket.connected) {
                socket.emit('start_voice', { language: state.voiceSettings.sttLanguage });
            }
        };

        // Handle recorder stop
        mediaRecorder.onstop = () => {
            console.log("MediaRecorder stopped.");
            ui.showVoiceStatus("Processing...", false); // Update indicator
            stream.getTracks().forEach(track => track.stop()); // Release microphone track
            console.log("Sending stop_voice signal to backend.");
             // Send stop signal to backend after a short delay to ensure last chunk is sent
             if (socket && socket.connected) {
                 setTimeout(() => {
                     // Check state again before sending stop signal
                     if (socket && socket.connected && !state.isVoiceActive) {
                        socket.emit('stop_voice');
                     } else {
                        console.log("Stop voice signal aborted, state changed or disconnected.");
                     }
                 }, 100); // 100ms delay
             }
        };

        // Handle recorder errors
        mediaRecorder.onerror = (event) => {
             console.error("MediaRecorder error:", event.error);
             ui.appendMessage(`Voice Recorder Error: ${event.error.name || event.error.message}`, 'error');
             // Reset state on error
             state.setIsVoiceActive(false);
             ui.updateMicButtonState(false);
             ui.hideVoiceStatus();
             stream.getTracks().forEach(track => track.stop()); // Ensure tracks are stopped
             mediaRecorder = null; // Clear recorder instance
        };

        // Start recording with a chunk interval (e.g., 300ms)
        mediaRecorder.start(300);

    } catch (err) {
        // Handle errors getting user media (permissions, device not found, etc.)
        console.error("Error accessing microphone:", err);
        let errorMsg = `Microphone Error: ${err.message}.`;
        if (err.name === 'NotAllowedError') errorMsg += " Please grant microphone permission.";
        else if (err.name === 'NotFoundError') errorMsg += ` Selected microphone (${state.voiceSettings.micId}) not found.`;
        else if (err.name === 'NotReadableError') errorMsg += " Microphone might be in use by another application.";
        else if (err.name === 'OverconstrainedError') errorMsg += ` Cannot satisfy microphone constraints (micId: ${state.voiceSettings.micId}).`;
        ui.appendMessage(errorMsg, 'error');
         // Reset state on error
         state.setIsVoiceActive(false);
         ui.hideVoiceStatus();
         ui.updateMicButtonState(false);
    }
}

/** Stops the active voice input recording. */
function stopVoiceInput() {
    state.setIsVoiceActive(false); // Set state flag first
    ui.updateMicButtonState(false); // Update button visual state immediately
    if (mediaRecorder && mediaRecorder.state === "recording") {
        console.log("Stopping voice input manually...");
        mediaRecorder.stop(); // Trigger onstop handler which sends signal to backend
        mediaRecorder = null; // Clear instance
    } else {
        console.log("Voice input not active or already stopping.");
    }
}

/** Sends text to backend TTS endpoint and handles audio playback */
async function triggerTTS(text) {
    // Check prerequisites
    if (!socket || !socket.connected || !text || !state.voiceSettings.ttsEnabled) {
         console.log("TTS trigger conditions not met.");
         return;
    }

    console.log("Requesting TTS from backend for:", text.substring(0, 50) + "...");
    ui.showVoiceStatus("Synthesizing...", false); // Update status indicator
    state.setLastPlayedAudioBuffer(null); // Clear previous audio buffer
    audioQueue = []; // Clear any pending audio chunks

    // Send request to backend via SocketIO
    socket.emit('request_tts', {
        text: text,
        speaker: state.voiceSettings.ttsSpeaker || 'default', // Send speaker preference (or default)
        speed: state.voiceSettings.ttsSpeed,
        pitch: state.voiceSettings.ttsPitch // Send pitch (backend might ignore)
    });
}

/** Handles playing received audio chunks (ArrayBuffers) sequentially using Web Audio API. */
async function playNextAudioChunk() {
    // Don't start playing if already speaking or queue is empty
    if (state.isSpeaking || audioQueue.length === 0) return;
    state.setIsSpeaking(true); // Set speaking flag

    // Combine all chunks in the queue into a single ArrayBuffer
    const totalLength = audioQueue.reduce((len, buf) => len + buf.byteLength, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    while(audioQueue.length > 0) {
        const chunk = audioQueue.shift(); // Take chunk from front of queue
        combinedBuffer.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }
    const completeAudioData = combinedBuffer.buffer; // Get the underlying ArrayBuffer
    state.setLastPlayedAudioBuffer(completeAudioData); // Store for potential replay

    // Initialize AudioContext if needed
    if (!audioContext) {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            // Resume context if it's suspended (required by some browsers)
            if (audioContext.state === 'suspended') await audioContext.resume();
        } catch (e) {
             console.error("Web Audio API Error:", e);
             ui.appendMessage("Cannot play audio: Web Audio API not supported or context creation failed.", "error");
             // Reset state on error
             state.setIsSpeaking(false); audioQueue = []; state.setLastPlayedAudioBuffer(null); return;
        }
    }
     // Ensure context is running before playback attempt
     if (audioContext.state === 'suspended') {
         try { await audioContext.resume(); } catch(e) { console.error("Audio context resume failed:", e); state.setIsSpeaking(false); return; }
     }

    try {
        stopAudioPlayback(false); // Stop any previous playback without hiding status

        // Decode the combined audio data
        const audioBuffer = await audioContext.decodeAudioData(completeAudioData);

        // Create a buffer source node
        audioSourceNode = audioContext.createBufferSource();
        audioSourceNode.buffer = audioBuffer;
        audioSourceNode.connect(audioContext.destination); // Connect to output

        // Handle playback end
        audioSourceNode.onended = () => {
            console.log("Audio playback finished.");
            state.setIsSpeaking(false); // Clear speaking flag
            audioSourceNode = null; // Clear node reference
            ui.hideVoiceStatus(); // Hide status indicator
            // Re-enable replay button if applicable
            if(dom.replayBtn) dom.replayBtn.disabled = !state.voiceSettings.enabled || !state.voiceSettings.ttsEnabled || !state.lastPlayedAudioBuffer;
            if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true; // Disable stop button
        };

        // Start playback
        audioSourceNode.start(0);
        ui.showVoiceStatus("Speaking...", false); // Update status indicator
        console.log("Playing combined audio response...");
        // Disable replay, enable stop during playback
        if(dom.replayBtn) dom.replayBtn.disabled = true;
        if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = !state.voiceSettings.enabled || !state.voiceSettings.ttsEnabled;

    } catch (e) {
        console.error("Error decoding/playing audio:", e);
        ui.appendMessage(`Audio Playback Error: ${e.message}`, "error");
        // Reset state on error
        state.setIsSpeaking(false);
        audioSourceNode = null;
        state.setLastPlayedAudioBuffer(null);
        if(dom.replayBtn) dom.replayBtn.disabled = true;
        if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true;
        ui.hideVoiceStatus();
    }
}

/** Stops the currently playing audio */
function stopAudioPlayback(hideStatus = true) {
    if (audioSourceNode) {
        try {
            audioSourceNode.onended = null; // Prevent onended handler from running after manual stop
            audioSourceNode.stop(); // Stop playback immediately
            console.log("Stopped audio playback.");
        } catch (e) { console.error("Error stopping audio source:", e); }
        audioSourceNode = null; // Clear reference
    }
    state.setIsSpeaking(false); // Update state flag
    audioQueue = []; // Clear any queued chunks that haven't been combined
    // Update button states
    if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true; // Disable stop button
    // Enable replay button only if conditions are met
    if(dom.replayBtn) {
        dom.replayBtn.disabled = !(state.voiceSettings.enabled && state.voiceSettings.ttsEnabled && state.lastPlayedAudioBuffer);
    }
    if(hideStatus) ui.hideVoiceStatus(); // Hide status indicator if requested
}

/** Replays the last complete audio response */
async function replayLastAudio() {
    // Check prerequisites
    if (state.isSpeaking || !state.lastPlayedAudioBuffer) {
        console.log("Cannot replay: Not finished speaking or no previous audio.");
        return;
    }
    if (!state.voiceSettings.enabled || !state.voiceSettings.ttsEnabled) {
        console.log("Cannot replay: Voice/TTS is disabled.");
        return;
    }
    console.log("Replaying last audio response.");
    state.setIsSpeaking(true); // Set speaking flag

    // Ensure AudioContext is ready
    if (!audioContext) {
         try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { state.setIsSpeaking(false); return; }
    }
    if (audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch(e) { console.error("Audio context resume failed:", e); state.setIsSpeaking(false); return; }
    }

    try {
         stopAudioPlayback(false); // Stop any previous playback

         // Decode the stored audio data (create a copy to avoid issues with buffer reuse)
         const audioBuffer = await audioContext.decodeAudioData(state.lastPlayedAudioBuffer.slice(0));
         // Create and configure source node
         audioSourceNode = audioContext.createBufferSource();
         audioSourceNode.buffer = audioBuffer;
         audioSourceNode.connect(audioContext.destination);
         // Handle end of replay
         audioSourceNode.onended = () => {
             console.log("Replay finished.");
             state.setIsSpeaking(false); audioSourceNode = null;
             // Update button states
             if(dom.replayBtn) dom.replayBtn.disabled = false; // Re-enable replay
             if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true; // Disable stop
             ui.hideVoiceStatus();
         };
         // Start replay
         audioSourceNode.start(0);
         ui.showVoiceStatus("Replaying...", false); // Show status
         // Update button states during replay
         if(dom.replayBtn) dom.replayBtn.disabled = true;
         if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = false; // Enable stop
    } catch (e) {
         console.error("Error replaying audio:", e);
         ui.appendMessage(`Audio Replay Error: ${e.message}`, "error");
         // Reset state on error
         state.setIsSpeaking(false); audioSourceNode = null;
         if(dom.replayBtn) dom.replayBtn.disabled = false;
         if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true;
         ui.hideVoiceStatus();
    }
}

/** Gets available microphone devices */
export async function populateMicrophoneList() {
     if (!dom.micSelect) return;
     try {
         // Request permission first if needed, otherwise enumerateDevices might return limited info
         await navigator.mediaDevices.getUserMedia({ audio: true });
         const devices = await navigator.mediaDevices.enumerateDevices();
         AVAILABLE_MICS = devices.filter(device => device.kind === 'audioinput');

         // Save current selection before clearing
         const currentSelection = dom.micSelect.value || state.voiceSettings.micId;
         dom.micSelect.innerHTML = ''; // Clear existing options

         // Add default option first
         dom.micSelect.appendChild(new Option('Default Microphone', 'default'));

         // Add detected microphones
         AVAILABLE_MICS.forEach(mic => {
             // Use label if available, otherwise generic name
             const option = new Option(mic.label || `Microphone ${dom.micSelect.options.length}`, mic.deviceId);
             dom.micSelect.appendChild(option);
         });
         console.log("Microphone list populated:", AVAILABLE_MICS);

         // Restore previous selection if it still exists, otherwise use default
         if (AVAILABLE_MICS.some(mic => mic.deviceId === currentSelection) || currentSelection === 'default') {
            dom.micSelect.value = currentSelection;
         } else if (AVAILABLE_MICS.length > 0) {
             dom.micSelect.value = 'default'; // Fallback to default
             state.voiceSettings.micId = 'default'; // Update state if fallback occurred
         }
         console.log("Mic selection restored/set to:", dom.micSelect.value);

     } catch (err) {
         console.error("Error enumerating audio devices:", err);
         // Provide fallback option on error
         dom.micSelect.innerHTML = '<option value="default">Default (Error listing mics)</option>';
         if (state.voiceSettings.enabled) {
             // Inform user only if voice is enabled
             ui.appendMessage("Could not list microphones. Using default.", "error");
         }
     }
}


/** Initializes Socket.IO connection and sets up event handlers. */
export function setupSocketIO() {
    // Disconnect existing socket if any
    if (socket && socket.connected) {
         console.log("Disconnecting existing Socket.IO connection...");
         socket.disconnect();
    }

    console.log("Attempting to connect Socket.IO...");
    ui.updateVoiceIndicator('connecting'); // Show connecting status
    try {
        // Check if Socket.IO library is loaded
        if (typeof io === 'undefined') {
            throw new Error("Socket.IO client library not loaded.");
        }
        // Initialize connection with reconnection attempts and timeout
        socket = io({ reconnectionAttempts: 5, timeout: 10000 });
    } catch (e) {
        console.error("Failed to initialize Socket.IO:", e);
         ui.updateVoiceIndicator('error'); // Show error status
         // Disable voice features reliant on socket
         if (dom.micBtn) { dom.micBtn.disabled = true; dom.micBtn.title = "Voice Unavailable"; dom.micBtn.dataset.ready = 'false'; }
        return;
    }

    // --- Socket Event Handlers ---
    socket.on('connect', () => {
        console.log('Socket.IO connected:', socket.id);
        ui.updateVoiceIndicator('connected'); // Show connected status
         socket.emit('get_voice_config'); // Request initial server config after connecting
    });

    socket.on('disconnect', (reason) => {
        console.log('Socket.IO disconnected:', reason);
        ui.updateVoiceIndicator('disconnected'); // Show disconnected status
        // Reset voice state on disconnect
        state.setIsVoiceActive(false); stopAudioPlayback();
        ui.updateMicButtonState(false); ui.hideVoiceStatus();
        // Reset backend status flags
        state.setWhisperLoaded(false); state.setTTSLoaded(false);
        state.setCurrentTTSModelName(''); state.setCurrentTTSSpeakers([]);
        // Update UI elements based on reset state
        ui.updateVoiceSettingsUI(false); // Reflect disabled state in UI
        if (dom.micBtn) { dom.micBtn.dataset.ready = 'false'; dom.micBtn.title = "Voice Input (Disconnected)"; dom.micBtn.disabled = true; }
    });

    socket.on('connect_error', (error) => {
        console.error('Socket.IO connection error:', error);
         ui.updateVoiceIndicator('error'); // Show error status
         // Disable voice features
         if (dom.micBtn) { dom.micBtn.disabled = true; dom.micBtn.title = "Voice Unavailable"; dom.micBtn.dataset.ready = 'false'; }
         // Reset backend status flags
         state.setWhisperLoaded(false); state.setTTSLoaded(false);
         state.setCurrentTTSModelName(''); state.setCurrentTTSSpeakers([]);
         ui.updateVoiceSettingsUI(false); // Reflect disabled state in UI
    });

     socket.on('voice_config', (data) => {
        console.log("Received initial voice config:", data);
        // Update state based on backend capabilities
        state.setWhisperLoaded(data.stt_ready);
        state.setTTSLoaded(data.tts_ready);
        // Only set currentTTSModelName if it wasn't already set by user action or persistence
        // if (!state.currentTTSModelName) {
        //     state.setCurrentTTSModelName(data.current_tts_model || '');
        // }
        // NOTE: We will rely on the explicit api.setTTSModel call below to set the correct
        // currentTTSModelName and currentTTSSpeakers after verifying user selection.

        // Update Mic Button based on STT readiness and voice setting
        if (dom.micBtn) {
             dom.micBtn.dataset.ready = state.WHISPER_LOADED_ON_BACKEND.toString();
             const shouldDisableMic = !state.voiceSettings.enabled || !state.WHISPER_LOADED_ON_BACKEND || state.isGenerating || state.isVoiceActive;
             dom.micBtn.disabled = shouldDisableMic;
             let micTitle = "Voice Input (Disabled in Settings)";
             if (state.voiceSettings.enabled) {
                micTitle = state.WHISPER_LOADED_ON_BACKEND ? "Voice Input" : "Voice Input (Server STT Unavailable)";
             }
             dom.micBtn.title = micTitle;
             ui.updateMicButtonState(state.isVoiceActive);
        }

        // --- Trigger load of user's selected model ---
        const modelToLoad = dom.ttsModelSelect?.value || state.selectedTTSModelName;
        console.log(`voice_config: User selected model is '${modelToLoad}'. TTS backend ready: ${state.TTS_LOADED_ON_BACKEND}`);

        // Only trigger load if voice is enabled, TTS backend *reports* ready, AND a model is selected/persisted.
        if (state.voiceSettings.enabled && data.tts_ready && modelToLoad) {
             console.log(`voice_config: Triggering load for selected model: ${modelToLoad}`);
             // Call the API function to ensure the backend loads the user's preferred model.
             // This function handles UI updates (loading state, speakers) on success/failure.
             api.setTTSModel(modelToLoad);
        } else {
            // If conditions not met, just update the UI based on the initial (potentially default) state reported by backend.
            console.log(`voice_config: Not triggering model load. Updating UI based on initially reported state.`);
            // Update speakers based on initially reported model (likely empty if default model is single-speaker)
            ui.populateSpeakerList(data.tts_speakers || []);
            // Refresh overall voice UI enable/disable states
             ui.updateVoiceSettingsUI(state.voiceSettings.enabled);
        }
        // --- END Trigger logic ---

        // Ensure voice indicator shows connected state
        if (dom.voiceIndicator && !dom.voiceIndicator.classList.contains('connected')) {
            ui.updateVoiceIndicator('connected');
        }
     });

     // Acknowledgment/Status Messages from Backend
     socket.on('voice_started', (data) => console.log("Backend ack voice start:", data.message));
     socket.on('voice_processing', (data) => ui.showVoiceStatus(data.message || "Transcribing...", false));
     socket.on('voice_synthesis', (data) => ui.showVoiceStatus(data.message || "Synthesizing...", false));

    // Final STT Result
    socket.on('voice_result', (data) => {
        console.log("Received voice result:", data);
        ui.hideVoiceStatus(); // Hide processing indicator
        if(data.transcript) {
            const displayText = `You (Voice): ${data.transcript}`;
             // Display transcript in chat only if not in voice-only mode
             if (state.voiceSettings.interactionMode !== 'voice_only') {
                ui.appendMessage(displayText, 'sent');
             }
             // Send transcript to LLM unless in text-only mode
             if (state.voiceSettings.interactionMode !== 'text_only') {
                sendMessage(data.transcript); // Send transcript as user message
            }
        }
        // Display transcription errors if any
        if(data.error) {
            ui.appendMessage(`<i>Transcription Error: ${data.error}</i>`, 'error');
        }
    });

    // Handle Errors from Voice System
    socket.on('voice_error', (data) => {
        console.error("Received voice error:", data.message);
        ui.appendMessage(`<i>Voice System Error: ${data.message}</i>`, 'error');
        // Reset voice state on error
        state.setIsVoiceActive(false); stopAudioPlayback(); audioQueue = [];
        ui.updateMicButtonState(false); ui.hideVoiceStatus();
        // Stop recorder if it's still running
        if (mediaRecorder && mediaRecorder.state === "recording") {
             mediaRecorder.stop();
             mediaRecorder = null;
        }
    });

    // Handle Incoming Audio Chunks for Playback
    socket.on('voice_audio_chunk', (data) => {
        // Validate chunk data
        if (data.audio instanceof ArrayBuffer && data.audio.byteLength > 0) {
             audioQueue.push(data.audio); // Add chunk to queue
         } else console.warn("Invalid audio chunk received:", data.audio);
    });

    // Handle Signal for End of TTS Audio Stream
    socket.on('voice_speak_end', () => {
        console.log("Backend indicated end of speech stream.");
        // If there are chunks in the queue, combine and play them
        if (audioQueue.length > 0) {
            playNextAudioChunk();
        } else {
            // This might happen if TTS fails or produces empty audio
            console.warn("Received speak_end but audio queue is empty.");
            ui.hideVoiceStatus(); // Ensure status is hidden
        }
    });

    console.log("Socket.IO event handlers set up.");
}