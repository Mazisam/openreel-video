#!/usr/bin/env python3
"""Media analysis and technical QA for the SAAM edit pipeline (cloud only).

Two controller-driven modes, both reading a JSON manifest written by queue.mjs:
  analyze.py --analyze manifest.json   inspect a source clip
  analyze.py --qa manifest.json        inspect a rendered clip
Everything is bounded: fixed argument arrays (no shell), per-command timeouts,
capped frame counts, no network access. Speech recognition is an optional plug-in:
nothing is invented when it is not installed.
"""
import importlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render import inspect_media, measure_loudness, finite  # noqa: E402  (same directory)

ENGINE_VERSION = '0.2.0'
MAX_FRAMES_HARD = 40


def emit(progress):
    print(json.dumps({'progress': int(progress)}), flush=True)


def run(args, timeout=240, limit=8 * 1024 * 1024):
    proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, errors='replace')
    return proc.returncode, (proc.stderr or '')[-limit:], (proc.stdout or '')[-limit:]


def inp(path, fmt):
    """Input arguments with the container forced and only local protocols allowed."""
    return ['-protocol_whitelist', 'file,pipe', '-f', fmt, '-i', str(path)]


def ffprobe_streams(path, fmt):
    code, err, out = run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', fmt, '-show_streams', '-show_format', '-of', 'json', str(path)], 30)
    if code != 0:
        raise RuntimeError('PROBE_FAILED')
    return json.loads(out)


def rotation_of(stream):
    for item in stream.get('side_data_list', []) or []:
        if 'rotation' in item:
            return int(round(float(item['rotation']))) % 360
    tag = (stream.get('tags') or {}).get('rotate')
    return int(tag) % 360 if tag and tag.lstrip('-').isdigit() else 0


def fps_of(stream):
    raw = stream.get('avg_frame_rate') or stream.get('r_frame_rate') or '0/1'
    try:
        a, b = raw.split('/')
        return round(float(a) / float(b), 3) if float(b) else 0.0
    except Exception:
        return 0.0


def loudness(path, fmt, has_audio, target=-14.0, true_peak=-1.0):
    if not has_audio:
        return None
    raw = measure_loudness(path, fmt, target, true_peak)
    if not raw:
        return {'status': 'failed'}
    return {'status': 'ok', 'integrated_lufs': finite(raw.get('input_i')), 'true_peak_dbtp': finite(raw.get('input_tp')),
            'loudness_range_lu': finite(raw.get('input_lra')), 'threshold_lufs': finite(raw.get('input_thresh'))}


def intervals(text, begin_key, end_key, duration):
    """Parse ffmpeg *_start/_end log pairs into closed intervals."""
    starts = [float(x) for x in re.findall(begin_key + r'[:=]\s*(-?[0-9.]+)', text)]
    ends = [float(x) for x in re.findall(end_key + r'[:=]\s*(-?[0-9.]+)', text)]
    out = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else duration
        s = max(0.0, s)
        e = min(duration, max(s, e))
        out.append({'start': round(s, 3), 'end': round(e, 3), 'duration': round(e - s, 3)})
    return out


def silences(path, fmt, has_audio, duration, noise_db=-35, min_len=0.35):
    if not has_audio:
        return []
    code, err, _ = run(['ffmpeg', '-hide_banner', '-nostats', '-nostdin'] + inp(path, fmt) + ['-vn',
                        '-af', f'silencedetect=noise={noise_db}dB:d={min_len}', '-f', 'null', '-'], 300)
    return intervals(err, 'silence_start', 'silence_end', duration)


def scene_times(path, fmt, duration, threshold=0.3, cap=40):
    code, err, _ = run(['ffmpeg', '-hide_banner', '-nostats', '-nostdin'] + inp(path, fmt) + ['-an',
                        '-vf', f"select='gt(scene,{threshold})',showinfo", '-f', 'null', '-'], 300)
    times = []
    for value in re.findall(r'pts_time:([0-9.]+)', err):
        t = float(value)
        if 0.3 < t < duration - 0.3 and (not times or t - times[-1] > 0.5):
            times.append(round(t, 3))
    return times[:cap]


def pick_frames(duration, scenes, limit):
    limit = max(4, min(int(limit), MAX_FRAMES_HARD))
    uniform_n = min(limit, max(6, math.ceil(duration / 2.5)))
    uniform = [round((i + 0.5) * duration / uniform_n, 3) for i in range(uniform_n)]
    scene_pts = []
    for t in scenes:
        scene_pts += [round(max(0.0, t - 0.15), 3), round(min(duration - 0.05, t + 0.15), 3)]
    chosen = []
    for t, reason in sorted([(t, 'scene') for t in scene_pts] + [(t, 'uniform') for t in uniform]):
        if chosen and t - chosen[-1][0] < 0.6:
            if reason == 'scene' and chosen[-1][1] == 'uniform':
                chosen[-1] = (t, reason)
            continue
        chosen.append((t, reason))
    if len(chosen) > limit:
        keep = [c for c in chosen if c[1] == 'scene'][:limit // 2]
        rest = [c for c in chosen if c[1] != 'scene']
        room = limit - len(keep)
        step = max(1, len(rest) / max(1, room))
        keep += [rest[int(i * step)] for i in range(min(room, len(rest)))]
        chosen = sorted(keep)
    return chosen[:limit]


def extract_frame(path, fmt, t, out_file, width):
    code, err, _ = run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', f'{t:.3f}'] + inp(path, fmt) + [
                        '-frames:v', '1', '-vf', f'scale={int(width)}:-2', '-q:v', '5', str(out_file)], 60)
    return code == 0 and Path(out_file).is_file() and Path(out_file).stat().st_size > 0


def write_frames(path, fmt, picks, prefix, width, label):
    frames = []
    for i, (t, reason) in enumerate(picks):
        name = f'{label}{i:02d}.jpg'
        target = Path(str(prefix) + '.' + name)
        if extract_frame(path, fmt, t, target, width):
            frames.append({'index': i, 't': t, 'reason': reason, 'file': name, 'bytes': target.stat().st_size})
    return frames


def transcribe(path, fmt, asr):
    """Optional speech recognition. Returns a transcript object; never invents text."""
    engine = (asr or {}).get('engine', 'auto')
    configured = os.environ.get('ASR_ENGINE', '').strip()
    if engine == 'off':
        return {'status': 'off'}
    name = configured if engine == 'auto' else engine
    if not name:
        return {'status': 'unavailable', 'reason': 'ASR_ENGINE_NOT_CONFIGURED'}
    language = (asr or {}).get('language') or None
    if language is not None and not re.fullmatch(r'[a-z]{2,3}', str(language)):
        return {'status': 'failed', 'reason': 'INVALID_LANGUAGE'}
    wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    wav.close()
    try:
        code, err, _ = run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y'] + inp(path, fmt) + ['-vn',
                            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav.name], 300)
        if code != 0:
            return {'status': 'failed', 'reason': 'AUDIO_EXTRACTION_FAILED'}
        if name.startswith('module:'):
            module = importlib.import_module(name[7:])
            raw = module.transcribe(wav.name, language)
            source = name
        elif name == 'faster-whisper':
            try:
                from faster_whisper import WhisperModel
            except Exception:
                return {'status': 'unavailable', 'reason': 'ASR_ENGINE_NOT_INSTALLED'}
            model_name = (asr or {}).get('model') or os.environ.get('ASR_MODEL', 'small')
            model = WhisperModel(model_name, device='cpu', compute_type='int8', cpu_threads=int(os.environ.get('ASR_THREADS', '2')))
            segments, info = model.transcribe(wav.name, language=language, word_timestamps=True, vad_filter=True, beam_size=5)
            raw = {'language': info.language, 'language_probability': round(float(info.language_probability), 3),
                   'segments': [{'start': s.start, 'end': s.end, 'text': s.text,
                                 'avg_logprob': s.avg_logprob, 'no_speech_prob': s.no_speech_prob,
                                 'words': [{'start': w.start, 'end': w.end, 'text': w.word, 'p': w.probability} for w in (s.words or [])]}
                                for s in segments]}
            source = 'faster-whisper:' + model_name
        else:
            return {'status': 'unavailable', 'reason': 'ASR_ENGINE_UNKNOWN'}
    except Exception as exc:
        return {'status': 'failed', 'reason': 'ASR_RUNTIME_ERROR', 'detail': type(exc).__name__}
    finally:
        try:
            os.unlink(wav.name)
        except OSError:
            pass
    return normalise_transcript(raw, source)


def normalise_transcript(raw, source):
    segments = []
    word_no = 0
    for si, seg in enumerate(raw.get('segments', [])[:2000], 1):
        words = []
        for w in (seg.get('words') or [])[:400]:
            word_no += 1
            text = str(w.get('text', '')).strip()
            if not text:
                continue
            p = w.get('p')
            words.append({'id': f'w{word_no}', 'start': round(float(w['start']), 3), 'end': round(float(w['end']), 3), 'text': text,
                          'p': None if p is None else round(float(p), 3), 'low_confidence': p is not None and float(p) < 0.5})
        segments.append({'id': f's{si}', 'start': round(float(seg['start']), 3), 'end': round(float(seg['end']), 3),
                         'text': str(seg.get('text', '')).strip(), 'words': words,
                         'avg_logprob': seg.get('avg_logprob'), 'no_speech_prob': seg.get('no_speech_prob')})
    return {'status': 'ok', 'engine': source, 'language': raw.get('language'), 'language_probability': raw.get('language_probability'),
            'segments': segments, 'source': 'asr',
            'warnings': ['Speech recognition output is a machine estimate; mixed Persian/English speech may contain errors.']}


def analyze(manifest):
    path = Path(manifest['path'])
    prefix = manifest['out_prefix']
    frames_cfg = manifest.get('frames') or {}
    emit(2)
    meta = inspect_media(path)
    if meta['type'] != 'video':
        raise ValueError('SOURCE_NOT_VIDEO')
    if meta['duration'] > 600:
        raise ValueError('SOURCE_DURATION_LIMIT')
    fmt = meta['format']
    probe = ffprobe_streams(path, fmt)
    streams = probe.get('streams', [])
    video = next(s for s in streams if s.get('codec_type') == 'video')
    audio_streams = [s for s in streams if s.get('codec_type') == 'audio']
    rotation = rotation_of(video)
    swap = rotation in (90, 270)
    dw, dh = (meta['height'], meta['width']) if swap else (meta['width'], meta['height'])
    notes = []
    if rotation:
        notes.append(f'Display rotation {rotation}: the player shows {dw}x{dh}.')
    if len(audio_streams) > 1:
        notes.append('More than one audio stream; only the first is analysed and rendered.')
    emit(10)
    loud = loudness(path, fmt, meta['hasAudio'])
    emit(30)
    quiet = silences(path, fmt, meta['hasAudio'], meta['duration'])
    emit(40)
    scenes = scene_times(path, fmt, meta['duration'])
    emit(55)
    picks = pick_frames(meta['duration'], scenes, frames_cfg.get('max', 24))
    frames = write_frames(path, fmt, picks, prefix, frames_cfg.get('width', 360), 'f')
    emit(75)
    transcript = transcribe(path, fmt, manifest.get('asr')) if meta['hasAudio'] else {'status': 'no_audio'}
    emit(95)
    silent_total = sum(i['duration'] for i in quiet)
    analysis = {
        'schema_version': 1, 'engine_version': ENGINE_VERSION,
        'source': {'sha256': manifest.get('sha256'), 'duration': round(meta['duration'], 3), 'width': meta['width'], 'height': meta['height'],
                   'display_width': dw, 'display_height': dh, 'rotation': rotation, 'fps': fps_of(video), 'codec': meta['codec'],
                   'has_audio': meta['hasAudio'], 'audio_streams': len(audio_streams), 'bytes': meta['fileSize']},
        'audio': None if not meta['hasAudio'] else {**(loud or {}), 'silences': quiet,
                   'silent_seconds': round(silent_total, 3), 'speech_ratio_estimate': round(max(0.0, 1 - silent_total / meta['duration']), 3),
                   'clipping_suspected': bool(loud and loud.get('true_peak_dbtp') is not None and loud['true_peak_dbtp'] > -0.1)},
        'scenes': scenes, 'frames': frames, 'transcript': transcript, 'notes': notes,
        'subject_regions': {'status': 'not_computed', 'reason': 'Estimated from the frames by the planning model, with confidence; not computed on the renderer.'},
    }
    Path(prefix + '.analysis.json').write_text(json.dumps(analysis, ensure_ascii=False), encoding='utf-8')
    return {'progress': 100, 'summary': {'duration': analysis['source']['duration'], 'frames': len(frames), 'scenes': len(scenes),
                                          'transcript': transcript.get('status'), 'rotation': rotation}}


def detect_filters(path, fmt, duration):
    """Evidence detectors for rendered output; each returns intervals, never a verdict."""
    code, err, _ = run(['ffmpeg', '-hide_banner', '-nostats', '-nostdin'] + inp(path, fmt) + ['-an',
                        '-vf', 'blackdetect=d=0.4:pix_th=0.10,freezedetect=n=-60dB:d=1.0', '-f', 'null', '-'], 300)
    return {'black': intervals(err, 'black_start', 'black_end', duration), 'freeze': intervals(err, 'freeze_start', 'freeze_end', duration)}


def qa(manifest):
    path = Path(manifest['path'])
    prefix = manifest['out_prefix']
    expect = manifest.get('expect') or {}
    plan = manifest.get('plan') or {}
    emit(3)
    checks = []
    def add(cid, status, evidence):
        checks.append({'id': cid, 'status': status, 'evidence': evidence})

    code, err, _ = run(['ffmpeg', '-hide_banner', '-v', 'error', '-nostdin'] + inp(path, 'mov') + ['-f', 'null', '-'], 600)
    add('decode', 'pass' if code == 0 and not err.strip() else 'fail', {'exit_code': code, 'messages': err.strip()[-600:]})
    try:
        meta = inspect_media(path)
        probe = ffprobe_streams(path, meta['format'])
    except Exception as exc:
        add('container', 'fail', {'error': str(exc)[:200]})
        return finish_qa(prefix, checks, None, [])
    streams = probe.get('streams', [])
    video = next((s for s in streams if s.get('codec_type') == 'video'), None)
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
    ok = bool(video and audio and video.get('codec_name') == 'h264' and audio.get('codec_name') == 'aac' and video.get('pix_fmt') == 'yuv420p')
    add('container', 'pass' if ok else 'fail', {'video': video and video.get('codec_name'), 'audio': audio and audio.get('codec_name'), 'pix_fmt': video and video.get('pix_fmt')})
    want_w, want_h = expect.get('width'), expect.get('height')
    if want_w and want_h:
        add('dimensions', 'pass' if (meta['width'], meta['height']) == (want_w, want_h) else 'fail', {'expected': [want_w, want_h], 'actual': [meta['width'], meta['height']]})
    if expect.get('duration'):
        tolerance = max(0.25, float(expect.get('tolerance', 0.25)))
        diff = abs(meta['duration'] - float(expect['duration']))
        add('duration', 'pass' if diff <= tolerance else 'fail', {'expected': expect['duration'], 'actual': round(meta['duration'], 3), 'tolerance': tolerance})
    if video and audio:
        vd = float(video.get('duration') or meta['duration']); ad = float(audio.get('duration') or meta['duration'])
        vs = float(video.get('start_time') or 0); as_ = float(audio.get('start_time') or 0)
        gap = max(abs(vd - ad), abs(vs - as_))
        add('av_sync', 'pass' if gap <= 0.15 else 'fail', {'video_seconds': round(vd, 3), 'audio_seconds': round(ad, 3), 'start_gap': round(abs(vs - as_), 3)})
    emit(35)
    target = float(plan.get('loudness_target_lufs', -14)); tp_max = float(plan.get('true_peak_max_dbtp', -1.0))
    loud = loudness(path, meta['format'], bool(audio), target, tp_max)
    if loud and loud.get('status') == 'ok' and loud.get('integrated_lufs') is not None:
        i, tp = loud['integrated_lufs'], loud.get('true_peak_dbtp')
        if i < -50:
            add('audio_level', 'fail', {**loud, 'reason': 'audio_near_silent'})
        else:
            off = abs(i - target)
            status = 'pass' if off <= 2 and (tp is None or tp <= tp_max + 0.3) else 'warn'
            add('audio_level', status, {**loud, 'target_lufs': target, 'true_peak_max_dbtp': tp_max})
    else:
        add('audio_level', 'fail', {'reason': 'loudness_not_measured' if audio else 'no_audio_stream', **(loud or {})})
    emit(55)
    quiet = silences(path, meta['format'], bool(audio), meta['duration'], min_len=0.6)
    bf = detect_filters(path, meta['format'], meta['duration'])
    for key, items in (('silence', quiet), ('black_frames', bf['black']), ('frozen_frames', bf['freeze'])):
        total = sum(i['duration'] for i in items)
        planned = plan.get('allow_' + key, False)
        if total >= 0.6 * meta['duration']:
            status = 'fail'
        elif items and not planned:
            status = 'warn'
        else:
            status = 'pass' if not items else 'info'
        add(key, status, {'intervals': items[:30], 'total_seconds': round(total, 3), 'allowed_by_plan': bool(planned)})
    emit(75)
    times = sorted({round(float(t), 3) for t in (manifest.get('frames_at') or []) if 0 <= float(t) < meta['duration']})[:24]
    frames = write_frames(path, meta['format'], [(t, 'plan') for t in times], prefix, 360, 'q')
    return finish_qa(prefix, checks, meta, frames)


def finish_qa(prefix, checks, meta, frames):
    verdict = 'qa_failed' if any(c['status'] == 'fail' for c in checks) else 'needs_review' if any(c['status'] == 'warn' for c in checks) else 'qa_passed'
    report = {'schema_version': 1, 'engine_version': ENGINE_VERSION, 'verdict': verdict, 'checks': checks, 'frames': frames,
              'limits': ['Technical evidence only. Speech accuracy, caption wording, subject framing and style need human review.']}
    Path(prefix + '.qa.json').write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
    return {'progress': 100, 'summary': {'verdict': verdict, 'failed': [c['id'] for c in checks if c['status'] == 'fail'],
                                          'warnings': [c['id'] for c in checks if c['status'] == 'warn']}}


def main():
    mode, manifest_path = sys.argv[1], sys.argv[2]
    manifest = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
    if mode == '--analyze':
        result = analyze(manifest)
    elif mode == '--qa':
        result = qa(manifest)
    else:
        raise ValueError('UNKNOWN_MODE')
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except subprocess.TimeoutExpired:
        print('ANALYSIS_TIMEOUT', file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
