// File: static/voice_listeners.js
import * as dom from './dom.js';
import * as state from './state.js';
import * as api from './api.js';
import * as ui from './ui.js';
import * as chat_listeners from './chat_listeners.js'; // Import chat listeners

// --- SocketIO State & Variables ---
let socket = null;
let mediaRecorder = null;
let audioContext = null;
let audioQueue = [];
let audioSourceNode = null;
let sampleAudioPlayer = null; // Keep this for potential sample playback logic if needed elsewhere
let AVAILABLE_MICS = [];


// --- Voice/Socket Action Functions ---

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

    stopAudioPlayback();
    state.setIsVoiceActive(true);
    ui.updateMicButtonState(true); // Also adds animation class now
    console.log('Attempting to start voice input...');

    try {
        // Get microphone access
        const stream = await navigator.mediaDevices.getUserMedia({
             audio: { deviceId: state.voiceSettings.micId !== 'default' ? { exact: state.voiceSettings.micId } : undefined }
         });
        console.log("Microphone access granted.");

        // Configure MediaRecorder
        const options = { mimeType: 'audio/webm;codecs=opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
             console.warn(`${options.mimeType} not supported, trying default mimeType.`);
             delete options.mimeType;
        }
        mediaRecorder = new MediaRecorder(stream, options);
        console.log(`Using MediaRecorder with options:`, options);

        // Handle data chunks
        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0 && socket && socket.connected && state.isVoiceActive) {
                event.data.arrayBuffer().then(buffer => {
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
            if (socket && socket.connected) {
                socket.emit('start_voice', { language: state.voiceSettings.sttLanguage });
            }
        };

        // Handle recorder stop
        mediaRecorder.onstop = () => {
            console.log("MediaRecorder stopped.");
            // Backend will send processing/synthesis messages, frontend just waits
            stream.getTracks().forEach(track => track.stop()); // Release microphone track
            console.log("Sending stop_voice signal to backend.");
             if (socket && socket.connected) {
                 setTimeout(() => {
                     // Check state again - isVoiceActive should be false now
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
             state.setIsVoiceActive(false);
             ui.updateMicButtonState(false);
             ui.hideVoiceStatus();
             stream.getTracks().forEach(track => track.stop());
             mediaRecorder = null;
        };

        // Start recording with a chunk interval
        mediaRecorder.start(300);

    } catch (err) {
        // Handle errors getting user media
        console.error("Error accessing microphone:", err);
        let errorMsg = `Microphone Error: ${err.message}.`;
        if (err.name === 'NotAllowedError') errorMsg += " Please grant microphone permission.";
        else if (err.name === 'NotFoundError') errorMsg += ` Selected microphone (${state.voiceSettings.micId}) not found.`;
        else if (err.name === 'NotReadableError') errorMsg += " Microphone might be in use by another application.";
        else if (err.name === 'OverconstrainedError') errorMsg += ` Cannot satisfy microphone constraints (micId: ${state.voiceSettings.micId}).`;
        ui.appendMessage(errorMsg, 'error');
         state.setIsVoiceActive(false);
         ui.hideVoiceStatus();
         ui.updateMicButtonState(false);
    }
}

/** Stops the active voice input recording. */
function stopVoiceInput() {
    state.setIsVoiceActive(false);
    ui.updateMicButtonState(false); // Update button visual state immediately
    if (mediaRecorder && mediaRecorder.state === "recording") {
        console.log("Stopping voice input manually...");
        mediaRecorder.stop(); // This will trigger onstop, which sends the backend signal
        mediaRecorder = null;
    } else {
        console.log("Voice input not active or already stopping.");
    }
}

/** Sends text to backend TTS endpoint and handles audio playback */
export async function triggerTTS(text) {
    // Check prerequisites
    if (!socket || !socket.connected || !text || !state.voiceSettings.ttsEnabled) {
         console.log("TTS trigger conditions not met.");
         if (state.isGenerating) {
            console.log("Resetting loading state because TTS was skipped.");
            ui.setLoadingState(false);
         }
         return;
    }

    console.log("Requesting TTS from backend for:", text.substring(0, 50) + "...");
    ui.showVoiceStatus("Synthesizing...", false);
    state.setLastPlayedAudioBuffer(null);
    audioQueue = [];

    // Send request to backend via SocketIO
    socket.emit('request_tts', {
        text: text,
        speaker: state.voiceSettings.ttsSpeaker || 'default',
        speed: state.voiceSettings.ttsSpeed,
        pitch: state.voiceSettings.ttsPitch
    });
}

/** Handles playing received audio chunks (ArrayBuffers) sequentially using Web Audio API. */
async function playNextAudioChunk() {
    // Don't start playing if already speaking or queue is empty
    if (state.isSpeaking || audioQueue.length === 0) return;

    // *** MODIFICATION: Check if TTS output is enabled BEFORE playing ***
    if (!state.voiceSettings.ttsEnabled) {
        console.log("Playback skipped: TTS output is disabled in settings.");
        audioQueue = []; // Clear the queue as we won't play it
        state.setLastPlayedAudioBuffer(null); // Clear buffer too
        // Ensure loading state is reset if we skip playback
        if (state.isGenerating) {
            console.log("Resetting loading state because TTS playback was skipped.");
            ui.setLoadingState(false);
        }
        return;
    }
    // *** END MODIFICATION ***


    state.setIsSpeaking(true); // Set speaking flag

    // Combine all chunks in the queue into a single ArrayBuffer
    const totalLength = audioQueue.reduce((len, buf) => len + buf.byteLength, 0);
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    while(audioQueue.length > 0) {
        const chunk = audioQueue.shift();
        combinedBuffer.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }
    const completeAudioData = combinedBuffer.buffer;
    state.setLastPlayedAudioBuffer(completeAudioData); // Store for potential replay

    // Initialize AudioContext if needed
    if (!audioContext) {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (audioContext.state === 'suspended') await audioContext.resume();
        } catch (e) {
             console.error("Web Audio API Error:", e);
             ui.appendMessage("Cannot play audio: Web Audio API not supported or context creation failed.", "error");
             state.setIsSpeaking(false); audioQueue = []; state.setLastPlayedAudioBuffer(null);
             if (state.isGenerating) ui.setLoadingState(false);
             return;
        }
    }
     // Ensure context is running before playback attempt
     if (audioContext.state === 'suspended') {
         try { await audioContext.resume(); } catch(e) { console.error("Audio context resume failed:", e); state.setIsSpeaking(false); if (state.isGenerating) ui.setLoadingState(false); return; }
     }

    try {
        stopAudioPlayback(false); // Stop any previous playback

        // Decode the combined audio data
        const audioBuffer = await audioContext.decodeAudioData(completeAudioData);

        // Create a buffer source node
        audioSourceNode = audioContext.createBufferSource();
        audioSourceNode.buffer = audioBuffer;
        audioSourceNode.connect(audioContext.destination);

        // Handle playback end
        audioSourceNode.onended = () => {
            console.log("Audio playback finished.");
            state.setIsSpeaking(false);
            audioSourceNode = null;
            ui.hideVoiceStatus();
            if(dom.replayBtn) dom.replayBtn.disabled = !state.voiceSettings.enabled || !state.voiceSettings.ttsEnabled || !state.lastPlayedAudioBuffer;
            if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true;
             if (state.isGenerating) {
                 console.log("Resetting loading state after TTS playback.");
                 ui.setLoadingState(false);
             }
        };

        // Start playback
        audioSourceNode.start(0);
        ui.showVoiceStatus("Speaking...", false);
        console.log("Playing combined audio response...");
        if(dom.replayBtn) dom.replayBtn.disabled = true;
        if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = !state.voiceSettings.enabled || !state.voiceSettings.ttsEnabled;

    } catch (e) {
        console.error("Error decoding/playing audio:", e);
        ui.appendMessage(`Audio Playback Error: ${e.message}`, "error");
        state.setIsSpeaking(false);
        audioSourceNode = null;
        state.setLastPlayedAudioBuffer(null);
        if(dom.replayBtn) dom.replayBtn.disabled = true;
        if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true;
        ui.hideVoiceStatus();
         if (state.isGenerating) {
             console.log("Resetting loading state after TTS playback error.");
             ui.setLoadingState(false);
         }
    }
}

/** Stops the currently playing audio */
function stopAudioPlayback(hideStatus = true) {
    if (audioSourceNode) {
        try {
            audioSourceNode.onended = null; // Prevent onended handler from running
            audioSourceNode.stop();
            console.log("Stopped audio playback.");
        } catch (e) { console.error("Error stopping audio source:", e); }
        audioSourceNode = null;
    }
    state.setIsSpeaking(false);
    audioQueue = [];
    if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true;
    if(dom.replayBtn) {
        dom.replayBtn.disabled = !(state.voiceSettings.enabled && state.voiceSettings.ttsEnabled && state.lastPlayedAudioBuffer);
    }
    if(hideStatus) ui.hideVoiceStatus();
     if (state.isGenerating) {
        console.log("Resetting loading state after manual audio stop.");
        ui.setLoadingState(false);
     }
}

/** Replays the last complete audio response */
async function replayLastAudio() {
    if (state.isSpeaking || !state.lastPlayedAudioBuffer) {
        console.log("Cannot replay: Not finished speaking or no previous audio.");
        return;
    }
    if (!state.voiceSettings.enabled || !state.voiceSettings.ttsEnabled) {
        console.log("Cannot replay: Voice/TTS is disabled.");
        return;
    }
    console.log("Replaying last audio response.");
    state.setIsSpeaking(true);

    if (!audioContext) {
         try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { state.setIsSpeaking(false); return; }
    }
    if (audioContext.state === 'suspended') {
        try { await audioContext.resume(); } catch(e) { console.error("Audio context resume failed:", e); state.setIsSpeaking(false); return; }
    }

    try {
         stopAudioPlayback(false);

         const audioBuffer = await audioContext.decodeAudioData(state.lastPlayedAudioBuffer.slice(0));
         audioSourceNode = audioContext.createBufferSource();
         audioSourceNode.buffer = audioBuffer;
         audioSourceNode.connect(audioContext.destination);
         audioSourceNode.onended = () => {
             console.log("Replay finished.");
             state.setIsSpeaking(false); audioSourceNode = null;
             if(dom.replayBtn) dom.replayBtn.disabled = false;
             if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = true;
             ui.hideVoiceStatus();
         };
         audioSourceNode.start(0);
         ui.showVoiceStatus("Replaying...", false);
         if(dom.replayBtn) dom.replayBtn.disabled = true;
         if(dom.stopAudioBtn) dom.stopAudioBtn.disabled = false;
    } catch (e) {
         console.error("Error replaying audio:", e);
         ui.appendMessage(`Audio Replay Error: ${e.message}`, "error");
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
         await navigator.mediaDevices.getUserMedia({ audio: true });
         const devices = await navigator.mediaDevices.enumerateDevices();
         AVAILABLE_MICS = devices.filter(device => device.kind === 'audioinput');

         const currentSelection = dom.micSelect.value || state.voiceSettings.micId;
         dom.micSelect.innerHTML = '';

         dom.micSelect.appendChild(new Option('Default Microphone', 'default'));

         AVAILABLE_MICS.forEach(mic => {
             const option = new Option(mic.label || `Microphone ${dom.micSelect.options.length}`, mic.deviceId);
             dom.micSelect.appendChild(option);
         });
         console.log("Microphone list populated:", AVAILABLE_MICS);

         if (AVAILABLE_MICS.some(mic => mic.deviceId === currentSelection) || currentSelection === 'default') {
            dom.micSelect.value = currentSelection;
         } else if (AVAILABLE_MICS.length > 0) {
             dom.micSelect.value = 'default';
             state.voiceSettings.micId = 'default';
         }
         console.log("Mic selection restored/set to:", dom.micSelect.value);

     } catch (err) {
         console.error("Error enumerating audio devices:", err);
         dom.micSelect.innerHTML = '<option value="default">Default (Error listing mics)</option>';
         if (state.voiceSettings.enabled) {
             ui.appendMessage("Could not list microphones. Using default.", "error");
         }
     }
}

/** Persists voice settings to localStorage */
function saveVoiceSettings() {
    try {
        localStorage.setItem('voiceSettings', JSON.stringify(state.voiceSettings));
        state.saveAppState();
        console.log("Voice settings saved:", state.voiceSettings);
    } catch (e) {
        console.error("Failed to save voice settings:", e);
    }
}


/** Initializes Socket.IO connection and sets up event handlers. */
export function setupSocketIO() {
    if (socket && socket.connected) {
         console.log("Disconnecting existing Socket.IO connection...");
         socket.disconnect();
    }

    console.log("Attempting to connect Socket.IO...");
    ui.updateVoiceIndicator('connecting');
    try {
        if (typeof io === 'undefined') {
            throw new Error("Socket.IO client library not loaded.");
        }
        socket = io({ reconnectionAttempts: 5, timeout: 10000 });
    } catch (e) {
        console.error("Failed to initialize Socket.IO:", e);
         ui.updateVoiceIndicator('error');
         if (dom.micBtn) { dom.micBtn.disabled = true; dom.micBtn.title = "Voice Unavailable"; dom.micBtn.dataset.ready = 'false'; }
        return;
    }

    socket.on('connect', () => {
        console.log('Socket.IO connected:', socket.id);
        ui.updateVoiceIndicator('connected');
         socket.emit('get_voice_config');
    });

    socket.on('disconnect', (reason) => {
        console.log('Socket.IO disconnected:', reason);
        ui.updateVoiceIndicator('disconnected');
        state.setIsVoiceActive(false); stopAudioPlayback();
        ui.updateMicButtonState(false); ui.hideVoiceStatus();
        state.setWhisperLoaded(false); state.setTTSLoaded(false);
        state.setCurrentTTSModelName(''); state.setCurrentTTSSpeakers([]);
        ui.updateVoiceSettingsUI(false);
        if (dom.micBtn) { dom.micBtn.dataset.ready = 'false'; dom.micBtn.title = "Voice Input (Disconnected)"; dom.micBtn.disabled = true; }
    });

    socket.on('connect_error', (error) => {
        console.error('Socket.IO connection error:', error);
         ui.updateVoiceIndicator('error');
         if (dom.micBtn) { dom.micBtn.disabled = true; dom.micBtn.title = "Voice Unavailable"; dom.micBtn.dataset.ready = 'false'; }
         state.setWhisperLoaded(false); state.setTTSLoaded(false);
         state.setCurrentTTSModelName(''); state.setCurrentTTSSpeakers([]);
         ui.updateVoiceSettingsUI(false);
    });

     socket.on('voice_config', (data) => {
        console.log("Received initial voice config:", data);
        state.setWhisperLoaded(data.stt_ready);
        state.setTTSLoaded(data.tts_ready);

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

        const modelToLoad = dom.ttsModelSelect?.value || state.selectedTTSModelName;
        console.log(`voice_config: User selected model is '${modelToLoad}'. TTS backend ready: ${data.tts_ready}`); // Use data.tts_ready

        if (state.voiceSettings.enabled && data.tts_ready && modelToLoad) {
             console.log(`voice_config: Triggering load for selected model: ${modelToLoad}`);
             api.setTTSModel(modelToLoad);
        } else {
            console.log(`voice_config: Not triggering model load. Updating UI based on initially reported state (Model: ${data.current_tts_model}).`);
            state.setCurrentTTSModelName(data.current_tts_model || '');
            state.setCurrentTTSSpeakers(data.tts_speakers || []);
            ui.populateSpeakerList(state.currentTTSSpeakers);
             ui.updateVoiceSettingsUI(state.voiceSettings.enabled);
        }

        if (dom.voiceIndicator && !dom.voiceIndicator.classList.contains('connected')) {
            ui.updateVoiceIndicator('connected');
        }
     });

     socket.on('voice_started', (data) => console.log("Backend ack voice start:", data.message));
     socket.on('voice_processing', (data) => ui.showVoiceStatus(data.message || "Transcribing...", false));
     socket.on('voice_synthesis', (data) => ui.showVoiceStatus(data.message || "Synthesizing...", false));

    socket.on('voice_result', (data) => {
        console.log("Received voice result:", data);
        ui.hideVoiceStatus();
        if(data.transcript) {
            const displayText = `You (Voice): ${data.transcript}`;
             if (state.voiceSettings.interactionMode !== 'voice_only') {
                ui.appendMessage(displayText, 'sent');
             }
            if (state.voiceSettings.interactionMode !== 'text_only') {
                 chat_listeners.sendMessage(data.transcript);
            } else {
                 if (state.isGenerating) {
                     console.log("Resetting loading state after STT in text-only mode.");
                     ui.setLoadingState(false);
                 }
            }
        } else {
              if (state.isGenerating) {
                 console.log("Resetting loading state because STT produced no transcript.");
                 ui.setLoadingState(false);
             }
        }
        if(data.error) {
            ui.appendMessage(`<i>Transcription Error: ${data.error}</i>`, 'error');
             if (state.isGenerating) {
                 console.log("Resetting loading state due to STT error.");
                 ui.setLoadingState(false);
             }
        }
    });

    socket.on('voice_error', (data) => {
        console.error("Received voice error:", data.message);
        ui.appendMessage(`<i>Voice System Error: ${data.message}</i>`, 'error');
        state.setIsVoiceActive(false); stopAudioPlayback(); audioQueue = [];
        ui.updateMicButtonState(false); ui.hideVoiceStatus();
        if (mediaRecorder && mediaRecorder.state === "recording") {
             mediaRecorder.stop();
             mediaRecorder = null;
        }
         if (state.isGenerating) {
             console.log("Resetting loading state due to voice error.");
             ui.setLoadingState(false);
         }
    });

    socket.on('voice_audio_chunk', (data) => {
        if (data.audio instanceof ArrayBuffer && data.audio.byteLength > 0) {
             audioQueue.push(data.audio);
         } else console.warn("Invalid audio chunk received:", data.audio);
    });

    socket.on('voice_speak_end', () => {
        console.log("Backend indicated end of speech stream.");
        if (audioQueue.length > 0) {
            playNextAudioChunk(); // This function now handles resetting loading state
        } else {
            console.warn("Received speak_end but audio queue is empty.");
            ui.hideVoiceStatus();
            if (state.isGenerating) {
                console.log("Resetting loading state because speak_end received with empty queue.");
                ui.setLoadingState(false);
            }
        }
    });

    console.log("Socket.IO event handlers set up.");
}


// --- Event Listener Setup Function ---
/** Sets up event listeners related to the Voice Settings tab and Mic button. */
export function setupVoiceEventListeners() {
    console.log('Setting up Voice event listeners...');

    // Mic Button (Main UI)
    if (dom.micBtn) {
        dom.micBtn.addEventListener('click', () => {
             if (!state.voiceSettings.enabled) {
                 ui.appendMessage("<i>Voice mode is disabled. Enable it in Settings > Voice.</i>", "error");
                 return;
             }
            if (state.isVoiceActive) { stopVoiceInput(); }
            else { startVoiceInput(); }
        });
        dom.micBtn.dataset.ready = 'false';
        dom.micBtn.disabled = true;
    } else console.warn("Mic button not found");


    // --- Listeners for controls WITHIN the Voice Settings Tab ---
    if (dom.voiceEnableToggle) {
        dom.voiceEnableToggle.addEventListener('change', (e) => {
            const isEnabled = e.target.checked;
            state.voiceSettings.enabled = isEnabled;
            ui.updateVoiceSettingsUI(isEnabled);
            if (dom.micBtn) {
                 const sttReady = state.WHISPER_LOADED_ON_BACKEND;
                 dom.micBtn.disabled = !isEnabled || !sttReady || state.isGenerating || state.isVoiceActive;
                 dom.micBtn.title = isEnabled ? (sttReady ? "Voice Input" : "Voice Input (Server STT Unavailable)") : "Voice Input (Disabled)";
                 ui.updateMicButtonState(state.isVoiceActive);
            }
            saveVoiceSettings();
             if (!isEnabled && state.isVoiceActive) {
                 stopVoiceInput();
             }
             if (isEnabled && (!socket || !socket.connected)) {
                  console.log("Voice enabled, ensuring Socket.IO connection...");
                  setupSocketIO();
              } else if (!isEnabled && socket && socket.connected) {
                    console.log("Voice disabled, disconnecting Socket.IO...");
                    socket.disconnect();
              }
        });
    } else console.warn("Voice Enable Toggle not found");

     if (dom.ttsEnableToggle) {
         dom.ttsEnableToggle.addEventListener('change', (e) => {
             state.voiceSettings.ttsEnabled = e.target.checked;
             ui.updateVoiceSettingsUI(state.voiceSettings.enabled);
             saveVoiceSettings();
             if (!state.voiceSettings.ttsEnabled) {
                 stopAudioPlayback();
             }
         });
     } else console.warn("TTS Enable Toggle not found");

    if (dom.micSelect) {
        dom.micSelect.addEventListener('change', (e) => {
            state.voiceSettings.micId = e.target.value;
            saveVoiceSettings();
            if (state.isVoiceActive) {
                 console.log("Microphone changed while recording. Restarting input.");
                 stopVoiceInput();
                 setTimeout(startVoiceInput, 100);
             }
        });
    } else console.warn("Microphone Select not found");
    if (dom.sttLanguageSelect) {
        dom.sttLanguageSelect.addEventListener('change', (e) => {
            state.voiceSettings.sttLanguage = e.target.value;
            saveVoiceSettings();
             if(socket && socket.connected) socket.emit('set_voice_settings', { sttLanguage: state.voiceSettings.sttLanguage });
        });
    } else console.warn("STT Language Select not found");

    if (dom.ttsModelSelect) {
        dom.ttsModelSelect.addEventListener('change', (e) => {
            const selectedModel = e.target.value;
            state.setSelectedTTSModelName(selectedModel);
             if (selectedModel) {
                api.setTTSModel(selectedModel);
             } else {
                state.setCurrentTTSModelName('');
                state.setCurrentTTSSpeakers([]);
                ui.populateSpeakerList([]);
                ui.updateVoiceSettingsUI(state.voiceSettings.enabled);
             }
        });
    } else console.warn("TTS Model Select not found");

    if (dom.voiceSelect) {
        dom.voiceSelect.addEventListener('change', (e) => {
            state.voiceSettings.ttsSpeaker = e.target.value;
            saveVoiceSettings();
            if (socket && socket.connected) {
                socket.emit('set_voice_settings', { ttsSpeaker: state.voiceSettings.ttsSpeaker });
            }
        });
    } else console.warn("TTS Speaker Select (voiceSelect) not found");

    if (dom.sampleVoiceBtn) {
        dom.sampleVoiceBtn.addEventListener('click', () => {
            const selectedSpeaker = dom.voiceSelect ? dom.voiceSelect.value : null;
            api.sampleTTSVoice(selectedSpeaker);
        });
    } else console.warn("Sample Voice Button not found");


    if (dom.voiceSpeedSlider) {
        dom.voiceSpeedSlider.addEventListener('input', (e) => {
            const speed = parseFloat(e.target.value);
            state.voiceSettings.ttsSpeed = speed;
            if(dom.voiceSpeedValue) dom.voiceSpeedValue.textContent = `${speed.toFixed(1)}x`;
        });
         dom.voiceSpeedSlider.addEventListener('change', () => saveVoiceSettings());
    } else console.warn("TTS Speed Slider not found");
     if (dom.voicePitchSlider) {
        dom.voicePitchSlider.addEventListener('input', (e) => {
             const pitch = parseFloat(e.target.value);
            state.voiceSettings.ttsPitch = pitch;
             if(dom.voicePitchValue) dom.voicePitchValue.textContent = `${pitch.toFixed(1)}x`;
        });
         dom.voicePitchSlider.addEventListener('change', () => saveVoiceSettings());
    } else console.warn("TTS Pitch Slider not found");

    if (dom.interactionModeSelect) {
        dom.interactionModeSelect.addEventListener('change', (e) => {
            state.voiceSettings.interactionMode = e.target.value;
            saveVoiceSettings();
            const hideText = state.voiceSettings.interactionMode === 'voice_only';
            if(dom.messageInput) dom.messageInput.style.display = hideText ? 'none' : '';
            if(dom.sendBtn) dom.sendBtn.style.display = hideText ? 'none' : '';
        });
         const initialHideText = state.voiceSettings.interactionMode === 'voice_only';
         if(dom.messageInput) dom.messageInput.style.display = initialHideText ? 'none' : '';
         if(dom.sendBtn) dom.sendBtn.style.display = initialHideText ? 'none' : '';

    } else console.warn("Interaction Mode Select not found");
    if (dom.replayBtn) {
        dom.replayBtn.addEventListener('click', replayLastAudio);
    } else console.warn("Replay Button not found");
    if (dom.stopAudioBtn) {
        dom.stopAudioBtn.addEventListener('click', () => {
            stopAudioPlayback(); // Stop main TTS playback
            // Sample Player is handled within api.js now
        });
    } else console.warn("Stop Audio Button not found");

    console.log("Voice settings listeners setup complete.");
}