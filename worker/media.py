"""Media worker protocol: one JSON request file in, one JSON result on stdout.

Files are named by the API. FFmpeg receives argument arrays, never a shell command.
"""
import json
from contextlib import redirect_stdout
import math
import os
import re
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
from PIL import Image

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def run(args, timeout=1500):
    proc = subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', *args], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    if proc.returncode:
        raise ValueError('Media processing failed: ' + proc.stderr[-1200:])


def probe(file):
    p = subprocess.run([FFMPEG, '-hide_banner', '-i', str(file)], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
    text = p.stderr
    duration = re.search(r'Duration: (\d+):(\d+):([\d.]+)', text)
    video = next((line for line in text.splitlines() if 'Video:' in line), '')
    size = re.search(r'\b(\d{2,5})x(\d{2,5})\b', video)
    if not duration:
        raise ValueError('Could not read media duration.')
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
    if not math.isfinite(seconds) or seconds <= 0 or seconds > 900:
        raise ValueError('Videos must be between 0 and 15 minutes.')
    return {'duration': seconds, 'width': int(size[1]) if size else 0, 'height': int(size[2]) if size else 0, 'hasAudio': 'Audio:' in text,
            'h264': bool(re.search(r'Video: h264\b', video)), 'aac': bool(re.search(r'Audio: aac\b', text)),
            # AAC is a family, and only the Low Complexity profile is safe to
            # hand a browser: iOS Safari's WebCodecs decoder accepts an HE-AAC
            # config and then fails mid-decode ("InternalAudioDecoderCocoa
            # decoding failed"), which is how a clip that exported fine on a
            # laptop died on a phone. ffmpeg prints the profile in parentheses
            # ("Audio: aac (LC)", "Audio: aac (HE-AAC)"); anything it does not
            # name LC is re-encoded rather than trusted.
            'aacLc': bool(re.search(r'Audio: aac \(LC\)', text)),
            'mp4': bool(re.search(r'Input #0, [^\n]*mp4', text))}


def thumbnail(file, target):
    run(['-i', str(file), '-frames:v', '1', '-vf', 'scale=360:-2', str(target)], 60)


def normalize(source, target, info=None):
    info = info or probe(source)
    if not info['width']:
        raise ValueError('This file does not contain a video stream.')
    # A clip pulled from Instagram/YouTube/TikTok is already H.264 in an MP4
    # nearly every time, and re-encoding one of those costs minutes of CPU to
    # produce a slightly worse copy of what we already had. When the source
    # already satisfies everything the editor needs, remux instead -- same
    # container work, no pixels touched, seconds instead of minutes. Anything
    # that doesn't qualify (odd dimensions, VP9/AV1) still takes the full
    # encode below, and so does a remux that fails to verify. Audio no longer
    # decides this: a track that isn't plain AAC-LC is re-encoded on its own,
    # seconds of work, while the video -- the expensive part -- is still
    # copied untouched.
    if (
        info['mp4'] and info['h264']
        and info['width'] % 2 == 0 and info['height'] % 2 == 0
    ):
        copy = ['-i', str(source)]
        if not info['hasAudio']:
            copy += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest']
        copy += ['-map', '0:v:0', '-map', '0:a:0' if info['hasAudio'] else '1:a:0',
                 '-t', str(info['duration']), '-c:v', 'copy']
        copy += (['-c:a', 'copy'] if info['hasAudio'] and info['aacLc']
                 else ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'])
        copy += ['-movflags', '+faststart', str(target)]
        try:
            run(copy)
            return probe(target)
        except ValueError:
            target.unlink(missing_ok=True)
    args = ['-i', str(source)]
    if not info['hasAudio']:
        args += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
    # 192k keeps this internal editing copy closer to the source than the 128k
    # ceiling Instagram documents for the final export (see render()); the
    # export re-encode still lands on the platform-compliant bitrate.
    args += ['-map', '0:v:0', '-map', '0:a:0' if info['hasAudio'] else '1:a:0', '-t', str(info['duration']), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', str(target)]
    run(args)
    return probe(target)


def download_limit(info, *, incomplete=False):
    if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming'):
        return 'Live streams are not supported. Use a finished video.'
    if (info.get('duration') or 0) > 900:
        return 'Video exceeds 15 minutes.'


def download_options(job, root):
    return {
        'quiet': True, 'no_warnings': True, 'noprogress': True,
        'logtostderr': True, 'noplaylist': True, 'playlist_items': '1',
        'allowed_extractors': ['^instagram$', '^youtube$', '^tiktok$', '^vm\\.tiktok$'],
        'js_runtimes': {'node': {'path': os.environ.get('NODE_BINARY', 'node')}},
        'socket_timeout': 25, 'retries': 2,
        # Reels and Shorts arrive as many small fragments, which yt-dlp fetches
        # one at a time by default -- on a link with hundreds of them the
        # transfer is round-trip bound rather than bandwidth bound, and the
        # connection sits idle between each one.
        'concurrent_fragment_downloads': 8,
        # Prefer a stream that is already H.264 in MP4 so normalize() can remux
        # it instead of re-encoding (see normalize()); the generic best-quality
        # selectors stay as fallbacks, so nothing becomes undownloadable, it
        # just costs an encode when the nice format isn't offered.
        'format': 'bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[vcodec^=avc1]/bestvideo*+bestaudio/best',
        'merge_output_format': 'mp4',
        'ffmpeg_location': FFMPEG, 'max_filesize': 300 * 1024 * 1024,
        'outtmpl': str(root / (job['id'] + '-download.%(ext)s')),
        'match_filter': download_limit,
    }


def import_media(job, root):
    meta = {}
    if job['action'] == 'download':
        import yt_dlp
        options = download_options(job, root)
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(job['url'], download=True)
        if info and 'entries' in info:
            info = next((x for x in info['entries'] if x), None)
        if not info:
            raise ValueError('The platform did not return a downloadable public video.')
        rejection = download_limit(info)
        if rejection:
            raise ValueError(rejection)
        title = re.sub(r'^Video by\s+', '', info.get('title') or 'Imported video', flags=re.IGNORECASE).strip()
        meta = {'name': title[:200], 'caption': (info.get('description') or '')[:8000], 'creator': info.get('uploader') or ''}
        candidates = [p for p in root.glob(job['id'] + '-download.*') if p.suffix not in ['.part', '.ytdl']]
        if not candidates:
            raise ValueError('The platform did not return a downloadable public video within the size limit.')
        source = max(candidates, key=lambda p: p.stat().st_size)
    else:
        source = root / job['input']
    target = root / (job['id'] + '.mp4')
    source_info = probe(source)
    info = normalize(source, target, source_info)
    audio = root / (job['id'] + '.wav')
    # Extract from the original source, not the AAC-encoded editing copy: the
    # separation model should see one lossy hop (the source's own encoding),
    # not two (source codec, then our re-encode).
    audio_source = source if source_info['hasAudio'] else target
    run(['-i', str(audio_source), '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', str(audio)])
    thumb = root / (job['id'] + '.jpg')
    thumbnail(target, thumb)
    source.unlink(missing_ok=True)
    return {**meta, **info, 'file': target.name, 'audioFile': audio.name, 'thumbnail': thumb.name, 'size': target.stat().st_size}


def audio(job, root):
    source = root / job['input']
    info = probe(source)
    if abs(info['duration'] - job['duration']) > 0.5:
        raise ValueError('Processed audio must match the full source duration.')
    target = root / (job['id'] + '.wav')
    run(['-i', str(source), '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', str(target)])
    source.unlink(missing_ok=True)
    return {'file': target.name, 'duration': info['duration'], 'size': target.stat().st_size}


def accept(job, root):
    # On-device export: the browser already encoded the final MP4 (WebCodecs),
    # so this just validates and registers it -- no FFmpeg re-encode, which is
    # the whole point of rendering on the user's device instead of the server.
    source = root / job['input']
    info = probe(source)
    if not info['width']:
        raise ValueError('This file does not contain a video stream.')
    if abs(info['duration'] - job['expectedDuration']) > 1.0:
        raise ValueError('Exported video duration does not match the edited timeline.')
    expected = (720, 1280) if job['quality'] == '720p' else (1080, 1920)
    if (info['width'], info['height']) != expected or not info['mp4'] or not info['h264'] or (info['hasAudio'] and not info['aac']):
        raise ValueError('Export must be a Reel-size H.264 MP4 with AAC audio (or muted), matching the chosen quality.')
    target = root / (job['id'] + '.mp4')
    source.rename(target)
    thumb = root / (job['id'] + '.jpg')
    try:
        thumbnail(target, thumb)
        return {**info, 'file': target.name, 'thumbnail': thumb.name, 'size': target.stat().st_size}
    except Exception:
        target.unlink(missing_ok=True)
        thumb.unlink(missing_ok=True)
        raise


def isolate(job, root):
    # Bulk instrument-removal queue: mux the source's own video (stream-copied,
    # zero re-encode) with the browser-isolated vocal track, producing a new
    # standalone media item. No crop/overlay/trim -- that stays Editor-only.
    source = root / job['input']
    info = probe(source)
    audio_upload = root / job['audioFile']
    audio_info = probe(audio_upload)
    if abs(audio_info['duration'] - info['duration']) > 0.5:
        raise ValueError('Isolated audio must match the full source duration.')
    target = root / (job['id'] + '.mp4')
    run(['-i', str(source), '-i', str(audio_upload), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', str(target)])
    audio_upload.unlink(missing_ok=True)
    thumb = root / (job['id'] + '.jpg')
    thumbnail(target, thumb)
    return {'duration': info['duration'], 'width': info['width'], 'height': info['height'], 'hasAudio': True, 'file': target.name, 'thumbnail': thumb.name, 'size': target.stat().st_size}


def overlay_filters(overlays, previous='base0'):
    """Chain each cropped overlay at its own offset.

    Input index i+2 matches the order render() appends '-loop 1 -i' arguments
    (0 is the source, 1 is the background). Offsets are coerced to int here so
    nothing but a number can reach the filter string.
    """
    filters = []
    for i, overlay in enumerate(overlays):
        output = f'base{i+1}'
        x, y = int(overlay['x']), int(overlay['y'])
        start, end = float(overlay['startMs']) / 1000, float(overlay['endMs']) / 1000
        filters.append(f"[{previous}][{i+2}:v]overlay={x}:{y}:enable='between(t,{start},{end})'[{output}]")
        previous = output
    return filters, previous


def render(job, root):
    spec = job['spec']
    if spec['canvas']['aspectRatio'] != '9:16':
        raise ValueError('Only the 9:16 Reel format is supported.')
    width, height = (720, 1280) if job.get('quality') == '720p' else (1080, 1920)
    source = root / job['input']
    info = probe(source)
    args = ['-i', str(source)]
    background = root / job['background']
    with Image.open(background) as image:
        if image.format != 'PNG' or image.size != (width, height):
            raise ValueError('Background dimensions do not match the project canvas.')
    args += ['-loop', '1', '-i', str(background)]
    # Overlays are cropped to the pixels they draw, so FFmpeg blends a small box
    # per overlay instead of a full 1080x1920 frame. Each box must still land
    # inside the canvas.
    overlays = job['overlays']
    for overlay in overlays:
        file = root / overlay['file']
        with Image.open(file) as image:
            if image.format != 'PNG':
                raise ValueError('Artwork must be a PNG.')
            box_width, box_height = image.size
        if int(overlay['x']) + box_width > width or int(overlay['y']) + box_height > height:
            raise ValueError('Overlay artwork falls outside the project canvas.')
        args += ['-loop', '1', '-i', str(file)]
    audio_input = '0:a'
    if job['audioFile']:
        args += ['-i', str(root / job['audioFile'])]
        audio_input = str(len(overlays) + 2) + ':a'
    c = spec['crop']
    cw = max(2, int(info['width'] * c['width']) // 2 * 2)
    ch = max(2, int(info['height'] * c['height']) // 2 * 2)
    cx = min(info['width'] - cw, int(info['width'] * c['x']) // 2 * 2)
    cy = min(info['height'] - ch, int(info['height'] * c['y']) // 2 * 2)
    # crop.x/y/width/height are a source-selection concern only -- which
    # pixels are kept, sized at a fixed scale (fitting the FULL, uncropped
    # source) so cropping never itself zooms. Where the result draws on the
    # canvas is separate: crop.offsetX/offsetY (0..1) position it anywhere
    # across the full canvas, defaulting to exactly the position cropping
    # alone would give it (the edge(s) not cropped stay put) when unset.
    # Mirrors lib/canvas.ts's compose() and shared/export.mjs's
    # cropGeometry() exactly, so preview, on-device export and this server
    # render all agree pixel-for-pixel.
    scale = min(width / info['width'], height / info['height'])
    dw = max(2, round(cw * scale) // 2 * 2)
    dh = max(2, round(ch * scale) // 2 * 2)
    pinned_x = (width - info['width'] * scale) / 2 + cx * scale
    pinned_y = (height - info['height'] * scale) / 2 + cy * scale
    avail_x = max(0, width - dw)
    avail_y = max(0, height - dh)
    offset_x = c.get('offsetX', pinned_x / avail_x if avail_x > 0 else 0.5)
    offset_y = c.get('offsetY', pinned_y / avail_y if avail_y > 0 else 0.5)
    offset_x = min(1, max(0, offset_x))
    offset_y = min(1, max(0, offset_y))
    dx = round(avail_x * offset_x)
    dy = round(avail_y * offset_y)
    filters = [f'[0:v]crop={cw}:{ch}:{cx}:{cy},scale={dw}:{dh},setsar=1,fps=30[video]', f'[1:v]fps=30,setsar=1[bg]', f'[bg][video]overlay={dx}:{dy}:shortest=1[base0]']
    chain, previous = overlay_filters(overlays)
    filters += chain
    segments = [s for s in spec['segments'] if s['enabled']]
    count = len(segments)
    filters.append(f'[{previous}]split={count}' + ''.join(f'[vs{i}]' for i in range(count)))
    filters.append(f'[{audio_input}]asplit={count}' + ''.join(f'[as{i}]' for i in range(count)))
    for i, s in enumerate(segments):
        start, end = s['startMs'] / 1000, s['endMs'] / 1000
        filters.append(f'[vs{i}]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{i}]')
        filters.append(f'[as{i}]atrim=start={start}:end={end},asetpts=PTS-STARTPTS' + (',volume=0' if spec['audio']['mode'] == 'mute' else '') + f'[a{i}]')
    filters.append(''.join(f'[v{i}][a{i}]' for i in range(count)) + f'concat=n={count}:v=1:a=1[outv][outa]')
    target = root / (job['id'] + '.mp4')
    run([*args, '-filter_complex_threads', '2', '-filter_complex', ';'.join(filters), '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-maxrate', '20M', '-bufsize', '40M', '-threads', '4', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', str(target)])
    thumb = root / (job['id'] + '.jpg'); thumbnail(target, thumb)
    return {**probe(target), 'file': target.name, 'thumbnail': thumb.name, 'size': target.stat().st_size}


def execute(job):
    # stdout is the API's JSON protocol, never a library's progress/log stream.
    # yt-dlp's quiet flag alone still allows carriage-return progress output.
    with redirect_stdout(sys.stderr):
        root = Path(job['root']).resolve()
        action = job['action']
        result = import_media(job, root) if action in ['download', 'import'] else audio(job, root) if action == 'audio' else isolate(job, root) if action == 'isolate' else accept(job, root) if action == 'accept' else render(job, root)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        job = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        execute(job)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
