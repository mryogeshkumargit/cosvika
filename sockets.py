import logging
import uuid
import os
import tempfile
import re # For text cleaning
from flask import request
from flask_socketio import emit
from config import state # Import shared state
from services.stt_service import transcribe_audio
from services.tts_service import synthesize_speech, get_current_tts_speakers
from services.audio_utils import convert_audio
from services.llm_backends import call_llm_backend # For voice-triggered LLM calls

# This module needs the 'socketio' instance. We'll pass it during initialization.
socketio = None

def init_sockets(sock):
    global socketio
    socketio = sock
    register_socket_handlers()

def register_socket_handlers():
    if not socketio:
        logging.error("SocketIO instance not initialized in sockets.py")
        return
    logging.info("Registering SocketIO handlers...")

    @socketio.on('connect')
    def handle_connect():
        sid = request.sid
        logging.info(f"Voice Client connected: {sid}")
        state["active_voice_clients"][sid] = {
            'state': 'idle', # States: idle, listening, processing
            'buffer': b'',
            'language': 'en', # Default language
            'tts_speaker': None # Default speaker preference
        }
        logging.debug(f"Active voice clients: {list(state['active_voice_clients'].keys())}")

    @socketio.on('disconnect')
    def handle_disconnect():
        sid = request.sid
        logging.info(f"Voice Client disconnected: {sid}")
        state["active_voice_clients"].pop(sid, None) # Remove client
        logging.debug(f"Removed client {sid}. Remaining: {list(state['active_voice_clients'].keys())}")

    @socketio.on('get_voice_config')
    def handle_get_voice_config():
        """Sends initial voice capabilities and config to the client."""
        sid = request.sid
        logging.debug(f"Client {sid} requested voice config.")
        tts_speakers = get_current_tts_speakers() # Use service function

        emit('voice_config', {
            'stt_ready': state.get("stt_loaded", False),
            'tts_ready': state.get("tts_loaded", False),
            'tts_speakers': tts_speakers,
            'current_tts_model': state.get("current_tts_model_name", ""),
        })

    @socketio.on('set_voice_settings')
    def handle_set_voice_settings(data):
        """Updates voice settings for the client session."""
        sid = request.sid
        client_state = state["active_voice_clients"].get(sid)
        if client_state:
            logging.info(f"Updating voice settings for {sid}: {data}")
            if 'sttLanguage' in data:
                client_state['language'] = data['sttLanguage']
                logging.debug(f"Client {sid} STT language set to: {client_state['language']}")
            if 'ttsSpeaker' in data:
                speaker_id = data['ttsSpeaker']
                client_state['tts_speaker'] = speaker_id if speaker_id != 'default' else None
                logging.debug(f"Client {sid} TTS speaker preference set to: {client_state['tts_speaker']}")
        else:
            logging.warning(f"Received set_voice_settings from unknown SID: {sid}")

    @socketio.on('start_voice')
    def handle_start_voice(data):
        sid = request.sid
        client_state = state["active_voice_clients"].get(sid)
        if client_state:
            logging.info(f"Voice input started for client {sid}. Config: {data}")
            client_state['state'] = 'listening'
            client_state['buffer'] = b'' # Clear buffer on start
            if 'language' in data:
                client_state['language'] = data['language']
            logging.info(f"Client {sid} is listening. Language: {client_state['language']}")
            emit('voice_started', {'message': 'Listening...'})
        else:
            logging.warning(f"Received start_voice from unknown SID: {sid}")

    @socketio.on('stop_voice')
    def handle_stop_voice():
        sid = request.sid
        logging.info(f"Voice input stopped signal received for client {sid}.")
        client_state = state["active_voice_clients"].get(sid)

        if not client_state:
            logging.warning(f"Received stop_voice from unknown SID: {sid}")
            return
        if client_state['state'] != 'listening':
            logging.info(f"Received stop_voice from SID {sid} but state is '{client_state['state']}'. Ignoring.") # Changed level
            return

        client_state['state'] = 'processing' # Mark as processing BEFORE transcription
        audio_buffer = client_state['buffer']
        client_language = client_state.get('language', 'en')
        client_speaker_pref = client_state.get('tts_speaker')
        client_state['buffer'] = b'' # Clear buffer

        # --- Input Validation ---
        if not state["stt_loaded"]:
            emit('voice_error', {'message': 'Speech-to-text engine not available.'}, to=sid)
            client_state['state'] = 'idle'; return # Reset state
        if len(audio_buffer) < 1024: # Check buffer length
            logging.warning(f"Audio buffer too short ({len(audio_buffer)} bytes) for STT from {sid}.")
            emit('voice_result', {'transcript': '', 'final': True, 'error': 'Audio too short.'}, to=sid)
            client_state['state'] = 'idle'; return # Reset state

        logging.info(f"Processing {len(audio_buffer)} bytes of audio for STT (Lang: {client_language})...")
        emit('voice_processing', {'message': 'Transcribing audio...'}, to=sid)

        temp_webm_path = None
        temp_wav_path = None
        transcript = ""
        llm_response_text = ""

        try:
            # --- Save and Convert Audio ---
            temp_suffix = f"_{sid}_{uuid.uuid4().hex[:8]}.webm"
            with tempfile.NamedTemporaryFile(delete=False, suffix=temp_suffix) as temp_webm_file:
                temp_webm_path = temp_webm_file.name
                temp_webm_file.write(audio_buffer)
            wav_audio_bytes = convert_audio(audio_buffer, input_format="webm", output_format="wav")
            temp_wav_path = temp_webm_path.replace(".webm", ".wav")
            with open(temp_wav_path, "wb") as temp_wav_file:
                temp_wav_file.write(wav_audio_bytes)

            # --- STT ---
            transcript, detected_language, lang_prob = transcribe_audio(temp_wav_path, language_code=client_language if client_language != 'auto' else None)
            emit('voice_result', {'transcript': transcript, 'final': True, 'detected_language': detected_language}, to=sid)

            # --- LLM Call (if transcript exists) ---
            if transcript:
                emit('voice_processing', {'message': 'Getting AI response...'}, to=sid)
                # TODO: Get actual backend/model/history settings for voice interaction
                llm_backend = "ollama"; llm_model = "llama3"; voice_history = []
                llm_response_text = call_llm_backend(transcript, voice_history, llm_backend, llm_model)
                logging.info(f"LLM Response for voice: '{llm_response_text[:60]}...'")
            else:
                logging.warning("Empty transcript after STT, skipping LLM.")

            # --- TTS (if LLM response exists) ---
            if state["tts_loaded"] and llm_response_text:
                 emit('voice_synthesis', {'message': 'Synthesizing speech...'}, to=sid)
                 try:
                    tts_audio_data = synthesize_speech(llm_response_text, speaker=client_speaker_pref, speed=1.0)
                    if tts_audio_data:
                        chunk_size = 8192
                        for i in range(0, len(tts_audio_data), chunk_size):
                            chunk = tts_audio_data[i:i+chunk_size]
                            emit('voice_audio_chunk', {'audio': chunk}, to=sid)
                            socketio.sleep(0.01)
                        emit('voice_speak_end', to=sid)
                    elif llm_response_text:
                        logging.warning("TTS generation resulted in empty audio (potentially due to short/invalid input).")
                 except ValueError as e_val:
                      logging.warning(f"Value error during TTS generation for voice response: {e_val}")
                      emit('voice_error', {'message': f'TTS Value Error: {str(e_val)}'}, to=sid)
                 except RuntimeError as e_rt:
                      logging.error(f"Runtime error during TTS generation for voice response: {e_rt}", exc_info=True)
                      emit('voice_error', {'message': f'TTS Runtime Error: {str(e_rt)}'}, to=sid)
                 except Exception as e_tts:
                      error_msg = f"TTS generation failed: {str(e_tts)}"
                      logging.error(f"Error during TTS generation for voice response: {e_tts}", exc_info=True)
                      if "size of tensor a" in str(e_tts) and "must match the size of tensor b" in str(e_tts):
                           error_msg = "TTS Error: Model encountered internal tensor mismatch for this input."
                      elif "Kernel size can't be greater than actual input size" in str(e_tts):
                           error_msg = "TTS Error: Input text segment too short for the model after cleaning."
                      emit('voice_error', {'message': error_msg}, to=sid)

            elif not state["tts_loaded"]:
                 emit('voice_error', {'message': 'Text-to-speech engine not available.'}, to=sid)
            elif not llm_response_text and transcript:
                 logging.info("No LLM response text to synthesize.")

        except Exception as e:
            logging.error(f"Error during full voice processing for {sid}: {e}", exc_info=True)
            emit('voice_error', {'message': f'An error occurred: {str(e)}'}, to=sid)
        finally:
             # Clean up temporary files
             try:
                 if temp_webm_path and os.path.exists(temp_webm_path): os.remove(temp_webm_path)
                 if temp_wav_path and os.path.exists(temp_wav_path): os.remove(temp_wav_path)
             except OSError as e_rem: logging.error(f"Error removing temp STT files: {e_rem}")
             # Reset client state *after* all processing/emitting is done
             if sid in state["active_voice_clients"]:
                 state["active_voice_clients"][sid]['state'] = 'idle'
                 logging.debug(f"Client {sid} state set to idle.")

    @socketio.on('audio_chunk')
    def handle_audio_chunk(data):
        sid = request.sid
        client_state = state["active_voice_clients"].get(sid)
        if client_state:
             if client_state['state'] == 'listening':
                audio_data = data.get('audio')
                if isinstance(audio_data, bytes):
                    client_state['buffer'] += audio_data
                else: logging.warning(f"Received non-bytes audio chunk from {sid}")
             else:
                 # *** MODIFICATION: Changed level from WARNING to DEBUG ***
                 logging.debug(f"Received audio chunk from {sid} but state is not 'listening' (state: {client_state['state']}). Chunk ignored.")
        # Ignore if client state doesn't exist

    @socketio.on('request_tts')
    def handle_request_tts(data):
        """Handles direct TTS requests from the client (e.g., replaying)."""
        sid = request.sid
        text = data.get('text')
        speaker = data.get('speaker')
        speed = data.get('speed', 1.0)
        pitch = data.get('pitch', 1.0) # Currently ignored by backend

        logging.info(f"Received TTS request from {sid} for text: '{text[:60]}...' Speaker: {speaker}, Speed: {speed}")

        if not state["tts_loaded"]:
            emit('voice_error', {'message': 'Text-to-speech engine not available.'}, to=sid); return
        if not text:
            emit('voice_error', {'message': 'No text provided for TTS.'}, to=sid); return

        try:
            emit('voice_synthesis', {'message': 'Synthesizing speech...'}, to=sid)

            tts_audio_data = synthesize_speech(text, speaker=speaker, speed=speed)

            if tts_audio_data:
                chunk_size = 8192
                for i in range(0, len(tts_audio_data), chunk_size):
                    chunk = tts_audio_data[i:i+chunk_size]
                    emit('voice_audio_chunk', {'audio': chunk}, to=sid)
                    socketio.sleep(0.01)
                emit('voice_speak_end', to=sid)
                logging.debug("Finished sending TTS (request) audio chunks.")
            else:
                logging.warning("TTS (request) resulted in empty audio data.")
                emit('voice_error', {'message': 'TTS generation resulted in empty or invalid audio.'}, to=sid)

        except ValueError as e_val:
             logging.warning(f"Value error during TTS request for {sid}: {e_val}")
             emit('voice_error', {'message': f'TTS Value Error: {str(e_val)}'}, to=sid)
        except RuntimeError as e_rt:
             logging.error(f"Runtime error during TTS request for {sid}: {e_rt}", exc_info=True)
             emit('voice_error', {'message': f'TTS Runtime Error: {str(e_rt)}'}, to=sid)
        except Exception as e:
            logging.error(f"Error during TTS request processing for {sid}: {e}", exc_info=True)
            error_msg = f"TTS Error: {str(e)}"
            if "size of tensor a" in str(e) and "must match the size of tensor b" in str(e):
                error_msg = "TTS Error: Model encountered internal tensor mismatch for this input."
            elif "Kernel size can't be greater than actual input size" in str(e):
                error_msg = "TTS Error: Input text segment too short for the model after cleaning."
            elif "unexpected type" in str(e):
                 error_msg = "TTS Error: Model produced unexpected audio format."
            elif "produce audio bytes" in str(e):
                 error_msg = "TTS Error: Failed to process audio output."
            emit('voice_error', {'message': error_msg}, to=sid)

    logging.info("SocketIO handlers registered.")