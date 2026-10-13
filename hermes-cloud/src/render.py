#!/usr/bin/env python3
"""Deterministic, bounded FFmpeg renderer for the documented OpenReel subset.
Only the cloud controller may construct the local asset bindings.
"""
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

def number(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('INVALID_' + label)
    return value

def inspect_media(path):
    with open(path, 'rb') as stream: prefix = stream.read(128)
    if prefix[4:8] == b'ftyp': fmt = 'mov'
    elif prefix.startswith(b'\x1aE\xdf\xa3'): fmt = 'matroska'
    elif prefix.startswith(b'\xff\xd8\xff') or prefix.startswith(b'\x89PNG\r\n\x1a\n'): fmt = 'image2'
    elif prefix.startswith(b'RIFF') and prefix[8:12] == b'WEBP': fmt = 'webp_pipe'
    elif prefix.startswith(b'RIFF') and prefix[8:12] == b'WAVE': fmt = 'wav'
    elif prefix.startswith(b'RIFF') and prefix[8:12] == b'AVI ': fmt = 'avi'
    elif prefix.startswith(b'OggS'): fmt = 'ogg'
    elif prefix.startswith(b'fLaC'): fmt = 'flac'
    elif prefix.startswith(b'ID3') or (len(prefix)>2 and prefix[0]==255 and prefix[1]&224==224): fmt = 'mp3'
    else: raise ValueError('UNSUPPORTED_MEDIA_CONTAINER')
    result = subprocess.run(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-f',fmt,
        '-show_format','-show_streams','-of','json',str(path)],capture_output=True,text=True,timeout=20,check=True)
    data = json.loads(result.stdout)
    streams = data.get('streams', [])
    video = next((s for s in streams if s.get('codec_type') == 'video'), None)
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
    image = fmt in ('image2', 'webp_pipe')
    if not video and not audio: raise ValueError('MEDIA_HAS_NO_STREAMS')
    if video and (video.get('width',0)>7680 or video.get('height',0)>7680): raise ValueError('SOURCE_RESOLUTION_LIMIT')
    duration = 0 if image else float(data.get('format',{}).get('duration') or (video or audio).get('duration') or 0)
    if not image and not 0 < duration <= 3600: raise ValueError('SOURCE_DURATION_LIMIT')
    return {'type':'image' if image else 'video' if video else 'audio','format':fmt,'duration':duration,
        'width':video.get('width',0) if video else 0,'height':video.get('height',0) if video else 0,
        'hasAudio':bool(audio),'hasVideo':bool(video),'codec':(video or audio).get('codec_name',''),
        'fileSize':Path(path).stat().st_size,'sampleRate':int(audio.get('sample_rate',48000)) if audio else 48000,'channels':audio.get('channels',2) if audio else 2}

def ass_time(t):
    cs = round(t*100)
    return f'{cs//360000}:{cs//6000%60:02}:{cs//100%60:02}.{cs%100:02}'

CAPTION_FONTS = ('DejaVu Sans', 'Noto Sans', 'Noto Sans Arabic', 'Noto Naskh Arabic', 'Noto Kufi Arabic')
CAPTION_POSITIONS = {'bottom': 2, 'middle': 5, 'top': 8}

def installed_fonts():
    try:
        out = subprocess.run(['fc-list', ':', 'family'], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return {name.strip() for line in out.splitlines() for name in line.split(',')}

def ass_colour(value, label):
    if not isinstance(value, str) or len(value) != 7 or value[0] != '#' or any(c not in '0123456789abcdefABCDEF' for c in value[1:]):
        raise ValueError('INVALID_' + label)
    return '&H00' + value[5:7] + value[3:5] + value[1:3]  # ASS is BGR

def caption_style_line(style, width, height):
    style = style or {}
    font = style.get('font', 'DejaVu Sans')
    if font not in CAPTION_FONTS: raise ValueError('INVALID_CAPTION_FONT')
    have = installed_fonts()
    if have is not None and font not in have: raise ValueError('INVALID_CAPTION_FONT_NOT_INSTALLED')
    size = number(style.get('size_pct', 5), 2, 12, 'CAPTION_SIZE')
    margin_v = number(style.get('margin_v_pct', 8), 0, 45, 'CAPTION_MARGIN')
    margin_h = number(style.get('margin_h_pct', 5), 0, 25, 'CAPTION_MARGIN')
    outline = number(style.get('outline_pct', 0.35), 0, 2, 'CAPTION_OUTLINE')
    position = style.get('position', 'bottom')
    if position not in CAPTION_POSITIONS: raise ValueError('INVALID_CAPTION_POSITION')
    primary = ass_colour(style.get('color', '#FFFFFF'), 'CAPTION_COLOR')
    edge = ass_colour(style.get('outline_color', '#202020'), 'CAPTION_COLOR')
    box = bool(style.get('box', False))
    border_style = 3 if box else 1
    back = '&H70000000' if box else '&H80000000'
    # With BorderStyle 3 libass draws the box from the outline colour.
    edge_colour = '&H70000000' if box else edge
    outline_px = max(1, round(height * outline / 100)) if not box else max(6, round(height * 0.012))
    return (f"Style: Default,{font},{round(height * size / 100)},{primary},{primary},{edge_colour},{back},"
            f"{-1 if style.get('bold') else 0},0,0,0,100,100,0,0,{border_style},{outline_px},{1 if not box else 0},{CAPTION_POSITIONS[position]},"
            f"{round(width * margin_h / 100)},{round(width * margin_h / 100)},{round(height * margin_v / 100)},1")

def subtitles_file(subtitles, width, height, path, style=None):
    lines = ['[Script Info]','ScriptType: v4.00+',f'PlayResX: {width}',f'PlayResY: {height}','WrapStyle: 0','ScaledBorderAndShadow: yes',
        '[V4+ Styles]','Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        caption_style_line(style, width, height),
        '[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text']
    for sub in subtitles:
        if sub.get('style') or sub.get('animationStyle') or sub.get('words'): raise ValueError('UNSUPPORTED_STYLED_CAPTIONS')
        start = number(sub['startTime'],0,600,'SUBTITLE_START')
        end = number(sub['endTime'],start+.01,600,'SUBTITLE_END')
        text = str(sub['text'])
        if len(text)>1000: raise ValueError('SUBTITLE_SIZE_LIMIT')
        # Block ASS override injection, while preserving plain Unicode and line breaks.
        text = text.replace('\\','／').replace('{','(').replace('}',')').replace('\r','').replace('\n',r'\N')
        lines.append(f'Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{text}')
    Path(path).write_text('\n'.join(lines),encoding='utf-8')

def compile_command(project, assets, output, crf=22, caption_style=None):
    for field in ('textClips','shapeClips','svgClips','stickerClips','adjustmentLayers','masks','compoundClips','nestedInstances','motionInstances','motionCompositions','generatedShaders','creation','multicamGroups'):
        if project.get(field): raise ValueError('UNSUPPORTED_PROJECT_FEATURE_' + field)
    settings = project['settings']
    width = int(number(settings['width'],64,1920,'WIDTH'))
    height = int(number(settings['height'],64,1920,'HEIGHT'))
    if width % 2 or height % 2 or width*height>1920*1080: raise ValueError('MAX_OUTPUT_1080P_EVEN_DIMENSIONS')
    fps = number(settings['frameRate'],24,30,'FPS')
    timeline = project['timeline']
    if timeline.get('backgroundFillMode') == 'blur': raise ValueError('UNSUPPORTED_BLUR_BACKGROUND')
    clips = [c for t in timeline['tracks'] for c in t['clips']]
    if not clips or len(clips)>100 or len(timeline['tracks'])>32: raise ValueError('INVALID_CLIP_COUNT')
    duration = max([c['startTime']+c['duration'] for c in clips] + [s['endTime'] for s in timeline.get('subtitles',[])])
    number(duration,.04,600,'DURATION')
    if any(t.get('solo') or t.get('transitions') for t in timeline['tracks']): raise ValueError('UNSUPPORTED_SOLO_OR_TRANSITIONS')
    args = ['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex_threads','1']
    filters = [f'color=c=black:s={width}x{height}:r={fps}:d={duration},format=rgba[base]',f'anullsrc=r=48000:cl=stereo,atrim=duration={duration}[silence]']
    base = 'base'; sounds = ['silence']; index = 0
    # OpenReel track 0 is front-most; render back-to-front.
    for track in reversed(timeline['tracks']):
        ordered = sorted(track['clips'], key=lambda c:c['startTime'])
        if track['type'] != 'audio' and any(a['startTime']+a['duration']>b['startTime']+.01 for a,b in zip(ordered,ordered[1:])):
            raise ValueError('UNSUPPORTED_OVERLAPPING_CLIPS_ON_ONE_TRACK')
        for clip in ordered:
            for field in ('effects','audioEffects','keyframes','reversed','smoothSlowMo','speedKeyframes','freezeFrames','stabilization','chromaKey','colorGrading','automation','emphasisAnimation'):
                if clip.get(field): raise ValueError('UNSUPPORTED_CLIP_FEATURE_' + field)
            if clip.get('speed',1)!=1 or clip.get('blendMode','normal')!='normal' or clip.get('blendOpacity',1)!=1:
                raise ValueError('UNSUPPORTED_SPEED_OR_BLEND')
            if clip.get('audioTrackIndex',0)!=0: raise ValueError('UNSUPPORTED_AUDIO_STREAM_SELECTION')
            info = assets.get(clip['mediaId'])
            if not info: raise ValueError('MEDIA_NOT_BOUND')
            path = Path(info['path']).resolve()
            if not path.is_file(): raise ValueError('MEDIA_MISSING')
            meta = info['metadata']
            start = number(clip['startTime'],0,600,'START')
            length = number(clip['duration'],.04,600,'LENGTH')
            point = number(clip['inPoint'],0,3600,'INPOINT')
            if meta['type']!='image' and point+length>meta['duration']+.1: raise ValueError('SOURCE_RANGE_EXCEEDS_MEDIA')
            if meta['type']=='image': args += ['-loop','1','-framerate',str(fps)]
            args += ['-protocol_whitelist','file,pipe','-f',meta['format'],'-i',str(path)]
            label = f'v{index}'; end = start+length
            if track['type']!='audio' and meta['hasVideo'] and not track.get('hidden'):
                trans = clip['transform']
                if trans.get('rotation',0)!=0 or trans.get('crop') or trans.get('rotate3d') or trans.get('perspective') or trans.get('borderRadius'):
                    raise ValueError('UNSUPPORTED_TRANSFORM')
                anchor = trans.get('anchor',{'x':.5,'y':.5})
                if anchor!={'x':.5,'y':.5}: raise ValueError('UNSUPPORTED_ANCHOR')
                scale = trans.get('scale',{'x':1,'y':1}); pos = trans.get('position',{'x':0,'y':0})
                boxw = max(2,round(width*number(scale.get('x',1),.1,4,'SCALE')/2)*2)
                boxh = max(2,round(height*number(scale.get('y',1),.1,4,'SCALE')/2)*2)
                fit = trans.get('fitMode','contain')
                if fit=='cover': resize = f'scale={boxw}:{boxh}:force_original_aspect_ratio=increase,crop={boxw}:{boxh}'
                elif fit=='contain': resize = f'scale={boxw}:{boxh}:force_original_aspect_ratio=decrease'
                elif fit=='stretch': resize = f'scale={boxw}:{boxh}'
                else: raise ValueError('UNSUPPORTED_FIT')
                opacity = number(trans.get('opacity',1),0,1,'OPACITY')
                filters.append(f'[{index}:v]trim=start={point}:duration={length},setpts=PTS-STARTPTS,{resize},setsar=1,fps={fps},format=rgba,colorchannelmixer=aa={opacity},setpts=PTS+{start}/TB[{label}]')
                x = number(pos.get('x',0),-4096,4096,'POSITION'); y = number(pos.get('y',0),-4096,4096,'POSITION')
                nxt = f'b{index}'
                filters.append(f'[{base}][{label}]overlay=x=(W-w)/2+{x}:y=(H-h)/2+{y}:eof_action=pass:repeatlast=0:enable=\'gte(t,{start})*lt(t,{end})\'[{nxt}]')
                base = nxt
            volume = number(clip.get('volume',1),0,2,'VOLUME')
            if meta['hasAudio'] and not track.get('muted') and volume>0:
                chain = f'[{index}:a:0]atrim=start={point}:duration={length},asetpts=PTS-STARTPTS,aresample=48000,volume={volume}'
                fade = clip.get('fade',{})
                fi = number(fade.get('fadeIn',0),0,min(30,length),'FADE'); fo = number(fade.get('fadeOut',0),0,min(30,length),'FADE')
                if fi: chain += f',afade=t=in:st=0:d={fi}'
                if fo: chain += f',afade=t=out:st={length-fo}:d={fo}'
                chain += f',adelay={round(start*1000)}:all=1[a{index}]'
                filters.append(chain); sounds.append(f'a{index}')
            index += 1
    subs = timeline.get('subtitles',[])
    if subs:
        ass = Path(output).with_suffix('.ass')
        subtitles_file(subs,width,height,ass,caption_style)
        # Controller-generated safe paths only; user strings never enter filter paths.
        escaped = str(ass).replace('\\','\\\\').replace(':','\\:').replace("'", "'\\''")
        filters.append(f"[{base}]subtitles=filename='{escaped}'[captioned]")
        base = 'captioned'
    filters.append(''.join('['+s+']' for s in sounds) + f'amix=inputs={len(sounds)}:normalize=0:duration=longest,atrim=duration={duration}[audio]')
    args += ['-filter_complex',';'.join(filters),'-map',f'[{base}]','-map','[audio]','-t',str(duration),'-fs',str(256*1024**2),
        '-c:v','libx264','-preset','veryfast','-crf',str(crf),'-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','160k','-ar','48000',
        '-movflags','+faststart','-progress','pipe:1',str(output)]
    return args, duration


def measure_loudness(path, fmt, target=-14.0, true_peak=-1.0, timeout=300):
    """EBU R128 measurement through loudnorm's analysis pass. Returns raw strings for the second pass."""
    proc = subprocess.run(['ffmpeg','-hide_banner','-nostats','-nostdin','-protocol_whitelist','file,pipe','-f',fmt,'-i',str(path),'-vn',
        '-af',f'loudnorm=I={target}:TP={true_peak}:LRA=11:print_format=json','-f','null','-'],capture_output=True,text=True,timeout=timeout,errors='replace')
    err = proc.stderr or ''
    start, end = err.rfind('{'), err.rfind('}')
    if proc.returncode != 0 or start < 0 or end < start: return None
    try: return json.loads(err[start:end+1])
    except ValueError: return None

def finite(value):
    try:
        number_ = float(value)
        return number_ if math.isfinite(number_) else None
    except (TypeError, ValueError): return None

def normalise_loudness(output, config, duration):
    """Linear two-pass loudnorm on the finished mix; video is stream-copied. Returns a report dict."""
    target = number(config.get('target_lufs', -14), -30, -5, 'LOUDNESS_TARGET')
    ceiling = number(config.get('true_peak_dbtp', -1.0), -6, 0, 'TRUE_PEAK')
    # Keep half a dB of headroom: the AAC re-encode can move inter-sample peaks.
    inner_tp = max(-9.0, ceiling - 0.5)
    measured = measure_loudness(output, 'mov', target, inner_tp)
    report = {'requested': {'target_lufs': target, 'true_peak_dbtp': ceiling}}
    if not measured or finite(measured.get('input_i')) is None or finite(measured.get('input_i')) < -60:
        report['applied'] = False
        report['reason'] = 'audio_not_measurable_or_silent'
        return report
    report['before'] = {'integrated_lufs': finite(measured['input_i']), 'true_peak_dbtp': finite(measured['input_tp']),
                        'loudness_range_lu': finite(measured['input_lra'])}
    temp = Path(output).with_suffix('.norm.mp4')
    flt = (f"loudnorm=I={target}:TP={inner_tp}:LRA=11:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
           f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}:linear=true:print_format=summary")
    proc = subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-protocol_whitelist','file,pipe','-f','mov','-i',str(output),
        '-map','0:v:0','-map','0:a:0','-c:v','copy','-af',flt,'-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart',str(temp)],
        capture_output=True,text=True,timeout=300,errors='replace')
    if proc.returncode != 0 or not temp.is_file():
        temp.unlink(missing_ok=True)
        raise RuntimeError('LOUDNESS_PASS_FAILED: ' + (proc.stderr or '')[-800:])
    os.replace(temp, output)
    after = measure_loudness(output, 'mov', target, inner_tp)
    report['applied'] = True
    if after: report['after'] = {'integrated_lufs': finite(after['input_i']), 'true_peak_dbtp': finite(after['input_tp']),
                                 'loudness_range_lu': finite(after['input_lra'])}
    return report

def main():
    if sys.argv[1]=='--probe':
        print(json.dumps(inspect_media(sys.argv[2]))); return
    manifest = json.loads(Path(sys.argv[1]).read_text())
    output = Path(manifest['output'])
    args, duration = compile_command(manifest['project'],manifest['assets'],output,manifest.get('crf',22),manifest.get('caption_style'))
    diagnostic = tempfile.TemporaryFile(mode='w+')
    child = subprocess.Popen(args,stdout=subprocess.PIPE,stderr=diagnostic,text=True)
    def cancel(_sig,_frame):
        child.terminate()
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired: child.kill()
        raise SystemExit(143)
    signal.signal(signal.SIGTERM,cancel)
    for line in child.stdout:
        if line.startswith('out_time_us='):
            try: print(json.dumps({'progress':min(99,round(int(line.split('=')[1])/1000000/duration*100))}),flush=True)
            except ValueError: pass
    code = child.wait()
    diagnostic.seek(max(0,diagnostic.tell()-4000))
    error = diagnostic.read()
    diagnostic.close()
    if code!=0: raise RuntimeError('FFMPEG_FAILED: exit=%s%s %s' % (code, ' (killed by signal %d, usually out of memory)' % -code if code<0 else '', error[-1600:]))
    post = {}
    if manifest.get('loudnorm'): post['loudnorm'] = normalise_loudness(output, manifest['loudnorm'], duration)
    result = inspect_media(output)
    if result['codec']!='h264' or not result['hasAudio'] or abs(result['duration']-duration)>.2:
        raise RuntimeError('OUTPUT_VALIDATION_FAILED')
    print(json.dumps({'progress':100,'output':output.name,'metadata':result,'postprocess':post}),flush=True)

if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(str(exc),file=sys.stderr)
        raise SystemExit(1)
