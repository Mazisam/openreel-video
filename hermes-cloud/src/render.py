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

def subtitles_file(subtitles, width, height, path):
    lines = ['[Script Info]','ScriptType: v4.00+',f'PlayResX: {width}',f'PlayResY: {height}',
        '[V4+ Styles]','Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        f'Style: Default,DejaVu Sans,{round(height*.05)},&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,{round(height*.08)},1',
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

def compile_command(project, assets, output, crf=22):
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
        subtitles_file(subs,width,height,ass)
        # Controller-generated safe paths only; user strings never enter filter paths.
        escaped = str(ass).replace('\\','\\\\').replace(':','\\:').replace("'", "'\\''")
        filters.append(f"[{base}]subtitles=filename='{escaped}'[captioned]")
        base = 'captioned'
    filters.append(''.join('['+s+']' for s in sounds) + f'amix=inputs={len(sounds)}:normalize=0:duration=longest,atrim=duration={duration}[audio]')
    args += ['-filter_complex',';'.join(filters),'-map',f'[{base}]','-map','[audio]','-t',str(duration),'-fs',str(256*1024**2),
        '-c:v','libx264','-preset','veryfast','-crf',str(crf),'-pix_fmt','yuv420p','-threads','2','-c:a','aac','-b:a','160k','-ar','48000',
        '-movflags','+faststart','-progress','pipe:1',str(output)]
    return args, duration

def main():
    if sys.argv[1]=='--probe':
        print(json.dumps(inspect_media(sys.argv[2]))); return
    manifest = json.loads(Path(sys.argv[1]).read_text())
    output = Path(manifest['output'])
    args, duration = compile_command(manifest['project'],manifest['assets'],output,manifest.get('crf',22))
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
    if code!=0: raise RuntimeError('FFMPEG_FAILED: '+error[-1600:])
    result = inspect_media(output)
    if result['codec']!='h264' or not result['hasAudio'] or abs(result['duration']-duration)>.2:
        raise RuntimeError('OUTPUT_VALIDATION_FAILED')
    print(json.dumps({'progress':100,'output':output.name,'metadata':result}),flush=True)

if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(str(exc),file=sys.stderr)
        raise SystemExit(1)
