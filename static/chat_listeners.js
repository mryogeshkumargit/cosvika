// File: static/chat_listeners.js
import * as dom from './dom.js';
import * as state from './state.js';
import * as api from './api.js';
import * as ui from './ui.js';
import * as cfg from './config.js';
// Import specific functions needed from other listener files if necessary
// (Currently none needed, but be mindful if dependencies arise)

// --- Core Chat Action Functions (Moved from listeners.js) ---

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
        await generateImage(effectivePrompt); // Call generateImage directly
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

                // Import triggerTTS from voice_listeners when needed
                 if (state.voiceSettings.enabled && state.voiceSettings.ttsEnabled && state.voiceSettings.interactionMode !== 'text_only') {
                      import('./voice_listeners.js').then(voice => voice.triggerTTS(aiResponse));
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
              import('./voice_listeners.js').then(voice => voice.triggerTTS(fullResponse));
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

// --- Event Listener Setup Function ---
/** Sets up event listeners related to the chat interface. */
export function setupChatEventListeners() {
    console.log('Setting up Chat event listeners...');

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

    // Generate More Photos Button (Profile Panel)
    if (dom.generateMorePhotosBtn) dom.generateMorePhotosBtn.onclick = generateMorePhotos;
    else console.warn("Generate More Photos button not found");

    // Note: Deleting specific image history items is handled via onclick added during rendering

    console.log('Chat event listeners setup complete.');
}