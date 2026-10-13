"""Deterministic stand-in for a speech engine, used only to test the transcript plumbing."""
def transcribe(wav_path, language):
    return {'language': language or 'fa', 'language_probability': 0.9, 'segments': [
        {'start': 0.2, 'end': 1.6, 'text': ' سلام Maziyar', 'avg_logprob': -0.2, 'no_speech_prob': 0.01,
         'words': [{'start': 0.2, 'end': 0.8, 'text': ' سلام', 'p': 0.93}, {'start': 0.9, 'end': 1.6, 'text': ' Maziyar', 'p': 0.31}]}]}
