"""Offline regression tests for the worker's stdout JSON protocol."""
import io
import json
import unittest
import tempfile
from types import SimpleNamespace
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

import yt_dlp
from yt_dlp.downloader.common import FileDownloader
from worker import media


class WorkerProtocolTests(unittest.TestCase):
    def test_downloaders_and_limits(self):
        options = media.download_options({'id': 'test'}, Path('.'))
        with yt_dlp.YoutubeDL(options) as ydl:
            self.assertEqual(set(ydl._ies), {'Instagram', 'Youtube', 'TikTok', 'TikTokVM'})
        self.assertTrue(options['noprogress'])
        self.assertTrue(options['noplaylist'])
        self.assertIn('node', options['js_runtimes'])
        self.assertIsNone(media.download_limit({'duration': 60}))
        self.assertIsNotNone(media.download_limit({'duration': 901}))
        self.assertIsNotNone(media.download_limit({'is_live': True}))
        self.assertIsNotNone(media.download_limit({'live_status': 'is_upcoming'}))

    def test_download_progress_cannot_contaminate_result(self):
        result = {'file': 'sample.mp4', 'caption': 'Caption with emojis 🎬'}

        def noisy_download(*args):
            # Reproduce the real failure: quiet=True still prints a progress
            # line without a final newline, immediately before the JSON result.
            with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True}) as ydl:
                downloader = FileDownloader(ydl, ydl.params)
                downloader.report_progress({
                    'status': 'finished', 'downloaded_bytes': 1024,
                    'total_bytes': 1024, 'elapsed': 1,
                    'filename': 'sample.mp4', 'info_dict': {},
                })
            return result

        output, diagnostics = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(diagnostics):
            with patch.object(media, 'import_media', side_effect=noisy_download):
                media.execute({'action': 'download', 'root': '.'})
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertIn('[download]', diagnostics.getvalue())

    def test_failed_download_does_not_emit_a_success_result(self):
        output = io.StringIO()
        with redirect_stdout(output):
            with patch.object(media, 'import_media', side_effect=ValueError('Download failed')):
                with self.assertRaisesRegex(ValueError, 'Download failed'):
                    media.execute({'action': 'download', 'root': '.'})
        self.assertEqual(output.getvalue(), '')



class OverlayCompositingTests(unittest.TestCase):
    def test_overlays_composite_at_their_own_offset(self):
        # Each overlay blends only its own box, so the offset must survive into
        # the filter graph and the input index must follow the -i order.
        filters, last = media.overlay_filters([
            {'file': 'a.png', 'x': 90, 'y': 198, 'startMs': 0, 'endMs': 2000},
            {'file': 'b.png', 'x': 0, 'y': 1700, 'startMs': 500, 'endMs': 6000},
        ])
        self.assertEqual(last, 'base2')
        self.assertEqual(filters, [
            "[base0][2:v]overlay=90:198:enable='between(t,0.0,2.0)'[base1]",
            "[base1][3:v]overlay=0:1700:enable='between(t,0.5,6.0)'[base2]",
        ])

    def test_offsets_cannot_inject_filter_syntax(self):
        with self.assertRaises(ValueError):
            media.overlay_filters([
                {'file': 'a.png', 'x': "0[x];drawbox", 'y': 0, 'startMs': 0, 'endMs': 1},
            ])

    def test_a_project_without_overlays_leaves_the_base_untouched(self):
        self.assertEqual(media.overlay_filters([]), ([], 'base0'))


class BlurCompositingTests(unittest.TestCase):
    def test_each_box_blurs_its_own_rectangle_over_its_own_span(self):
        # The split is not optional: a filter output may be consumed once, and
        # every box both reads the frame and draws back onto it.
        filters, last = media.blur_filters([
            {'x': 0.1, 'y': 0.2, 'width': 0.5, 'height': 0.25, 'intensity': 50, 'startMs': 0, 'endMs': 3000},
            {'x': 0.5, 'y': 0.5, 'width': 0.25, 'height': 0.25, 'intensity': 20, 'startMs': 3000, 'endMs': 6000},
        ], 1080, 1920)
        self.assertEqual(last, 'blurred1')
        self.assertEqual(filters, [
            '[base0]split=2[bs0a][bs0b]',
            '[bs0a]crop=540:480:108:384,boxblur=37:3[bb0]',
            "[bs0b][bb0]overlay=108:384:enable='between(t,0.0,3.0)'[blurred0]",
            '[blurred0]split=2[bs1a][bs1b]',
            '[bs1a]crop=270:480:540:960,boxblur=15:3[bb1]',
            "[bs1b][bb1]overlay=540:960:enable='between(t,3.0,6.0)'[blurred1]",
        ])

    def test_a_box_with_no_timing_is_on_every_frame(self):
        # What every box saved before blur had a timeline meant, and what the
        # preview draws for one: no enable expression at all.
        filters, _ = media.blur_filters(
            [{'x': 0, 'y': 0, 'width': 0.2, 'height': 0.2, 'intensity': 100}], 1080, 1920)
        self.assertNotIn('enable', filters[-1])
        self.assertTrue(filters[-1].endswith('overlay=0:0[blurred0]'))

    def test_the_radius_never_exceeds_what_it_is_blurring(self):
        # boxblur rejects a radius larger than half the box, which a thin
        # watermark strip at full intensity would otherwise ask for.
        filters, _ = media.blur_filters(
            [{'x': 0, 'y': 0, 'width': 0.02, 'height': 0.02, 'intensity': 100}], 1080, 1920)
        crop = [f for f in filters if 'crop=' in f][0]
        width, height = 22, 38
        radius = int(crop.split('boxblur=')[1].split(':')[0])
        self.assertLessEqual(radius, min(width, height) // 2)
        self.assertGreaterEqual(radius, 1)

    def test_a_project_without_blur_leaves_the_base_untouched(self):
        self.assertEqual(media.blur_filters([], 1080, 1920), ([], 'base0'))

    def test_blur_geometry_cannot_inject_filter_syntax(self):
        with self.assertRaises(ValueError):
            media.blur_filters(
                [{'x': "0[x];drawbox", 'y': 0, 'width': 0.2, 'height': 0.2, 'intensity': 50}], 1080, 1920)

    def test_text_is_composited_over_the_blur_not_under_it(self):
        # Draw order has to match the preview and the on-device export: blur
        # hides footage, then text sits on top of it, sharp.
        blurred, previous = media.blur_filters(
            [{'x': 0, 'y': 0, 'width': 0.2, 'height': 0.2, 'intensity': 50}], 1080, 1920)
        overlays, last = media.overlay_filters(
            [{'file': 'a.png', 'x': 0, 'y': 0, 'startMs': 0, 'endMs': 1000}], previous)
        self.assertEqual(previous, 'blurred0')
        self.assertTrue(overlays[0].startswith('[blurred0]'))
        self.assertEqual(last, 'base1')


class CpuShareTests(unittest.TestCase):
    def test_the_api_decides_how_many_threads_ffmpeg_may_use(self):
        # Left alone FFmpeg takes every core, and on a box that is also serving
        # the app that means one render makes everything else wait.
        try:
            with patch.object(media, 'import_media', return_value={'ok': True}):
                with redirect_stdout(io.StringIO()):
                    media.execute({'action': 'import', 'root': '.', 'threads': 3})
            self.assertEqual(media.THREADS, 3)
            self.assertEqual(media.thread_flags(), ['-threads', '3'])
            recorded = []
            with patch.object(media.subprocess, 'run', side_effect=lambda args, **kw: recorded.append(args) or SimpleNamespace(returncode=0, stderr='')):
                media.run(['-i', 'in.mp4', 'out.mp4'])
            # Once before the input, capping the decoder, and once immediately
            # before the output, which is the only position the encoder reads.
            # In front of the whole command line x264 ignores it and opens a
            # thread per core anyway.
            self.assertEqual(recorded[0][-3:], ['-threads', '3', 'out.mp4'])
            self.assertEqual(recorded[0].count('-threads'), 2)
            self.assertLess(recorded[0].index('-threads'), recorded[0].index('-i'))
            # Nothing outside the API sets an allowance, and then the flag is
            # left off entirely rather than guessed at.
            with patch.object(media, 'import_media', return_value={'ok': True}):
                with redirect_stdout(io.StringIO()):
                    media.execute({'action': 'import', 'root': '.'})
            self.assertEqual(media.thread_flags(), [])
        finally:
            media.THREADS = 0


class DeviceAcceptTests(unittest.TestCase):
    def test_probe_recognizes_mp4_h264_aac(self):
        stderr = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x':\nDuration: 00:00:04.00\nStream #0:0: Video: h264 (High), yuv420p, 720x1280, 30 fps\nStream #0:1: Audio: aac (LC), 48000 Hz"
        with patch.object(media.subprocess, 'run', return_value=SimpleNamespace(stderr=stderr)):
            info = media.probe('x')
        self.assertTrue(info['mp4'] and info['h264'] and info['aac'])

    def test_device_accept_checks_format_and_never_reencodes(self):
        with tempfile.TemporaryDirectory(prefix='frame-device-') as folder:
            root = Path(folder)
            source = root / 'input.device-export'
            source.write_bytes(b'test-only')
            job = {'input': source.name, 'id': 'output', 'quality': '720p', 'expectedDuration': 4}
            info = {'duration': 4, 'width': 720, 'height': 1280, 'mp4': True, 'h264': True, 'hasAudio': True, 'aac': True}
            for change in [{'h264': False}, {'aac': False}, {'mp4': False}, {'width': 1080}, {'duration': 9}]:
                with patch.object(media, 'probe', return_value={**info, **change}):
                    with self.assertRaises(ValueError): media.accept(job, root)
                self.assertTrue(source.exists())
            with patch.object(media, 'probe', return_value=info), patch.object(media, 'thumbnail'), patch.object(media, 'normalize') as normalize:
                result = media.accept(job, root)
                normalize.assert_not_called()
            self.assertEqual((root / result['file']).read_bytes(), b'test-only')


if __name__ == '__main__':
    unittest.main()
