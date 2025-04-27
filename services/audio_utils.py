import io
import logging
from pydub import AudioSegment
import numpy as np # Import numpy
import soundfile as sf

def convert_audio(input_bytes, input_format="webm", output_format="wav"):
    """Converts audio data from one format to another using pydub."""
    try:
        # Load audio from bytes using the specified format
        audio = AudioSegment.from_file(io.BytesIO(input_bytes), format=input_format)
        # Export to a buffer in the target format with desired parameters
        output_buffer = io.BytesIO()
        # Specify codec and sample rate for WAV output (common for STT)
        # Use 16-bit PCM and 16kHz sample rate
        audio.export(output_buffer, format=output_format, parameters=["-acodec", "pcm_s16le", "-ar", "16000"])
        logging.info(f"Audio converted from {input_format} to {output_format} (16kHz, 16-bit PCM) ({len(output_buffer.getvalue())} bytes)")
        return output_buffer.getvalue()
    except Exception as e:
        logging.error(f"Error converting audio from {input_format} to {output_format}: {e}", exc_info=True)
        raise # Re-raise the exception

def convert_tts_list_to_wav(tts_output_list, samplerate=22050):
    """Converts a list of audio samples (int/float/numpy numeric) to WAV bytes."""
    if not isinstance(tts_output_list, list) or not tts_output_list:
        logging.error("TTS output list is not a valid non-empty list.")
        return None

    # *** Correction 2: Allow numpy numeric types ***
    # Check if the first element is a standard Python number or a numpy number
    first_element = tts_output_list[0]
    if not isinstance(first_element, (int, float, np.number)):
        logging.error(f"TTS output list contains non-numeric data (type: {type(first_element)}). Failed check: isinstance({type(first_element)}, (int, float, np.number))")
        return None

    try:
        # Convert list to numpy array (use float32 for broader compatibility initially)
        # Ensure conversion handles numpy types correctly if they are already present
        audio_array = np.array(tts_output_list).astype(np.float32)

        # Check for NaN or Inf values which can cause issues
        if np.isnan(audio_array).any() or np.isinf(audio_array).any():
            logging.error("TTS output array contains NaN or Inf values after conversion.")
            # Option: Try to clamp or remove offending values, or return None
            # For now, let's return None as it indicates a deeper issue
            return None

        # Normalize if necessary (often TTS models output in range [-1, 1])
        # Check max absolute value to decide if normalization is needed
        max_abs_val = np.max(np.abs(audio_array))
        if max_abs_val > 1.0:
            logging.warning(f"TTS output array max absolute value is {max_abs_val}, normalizing to [-1, 1].")
            audio_array = audio_array / max_abs_val
        elif max_abs_val == 0:
             logging.warning("TTS output array is all zeros.")
             # Return empty bytes or None? Return None as it's not valid audio.
             return None


        # Convert float32 array in range [-1, 1] to int16 range [-32767, 32767]
        audio_array_int16 = (audio_array * 32767).astype(np.int16)

        # Write to a bytes buffer
        byte_io = io.BytesIO()
        sf.write(byte_io, audio_array_int16, samplerate, format='WAV', subtype='PCM_16')
        wav_bytes = byte_io.getvalue()
        logging.info(f"Successfully converted list output to WAV bytes ({len(wav_bytes)} bytes) at {samplerate}Hz.")
        return wav_bytes
    except ImportError:
        logging.error("Failed to convert TTS list output: Numpy or Soundfile library not found. Install with: pip install numpy soundfile")
        return None
    except Exception as e_conv:
        logging.error(f"Error during TTS list to WAV conversion: {e_conv}", exc_info=True)
        return None