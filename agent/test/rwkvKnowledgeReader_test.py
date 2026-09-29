import importlib.util
import io
import json
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/readRwkvKnowledge.py'
spec = importlib.util.spec_from_file_location('rwkv_reader', SCRIPT)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
BODY = 'Verified architecture and inference documentation.\n' * 20


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def read(self, source='rwkv-overview', **kwargs):
        return reader.read_source(source, cache_dir=self.directory.name, **kwargs)

    def test_cache_pagination_deduplicates_network_and_preserves_source(self):
        with patch.object(reader, 'download', return_value=(BODY, 'text/plain')) as fetch:
            first = self.read(max_chars=100)
            second = self.read(offset=first['nextOffset'], max_chars=100)
        self.assertEqual(fetch.call_count, 1)
        self.assertTrue(second['cached'])
        self.assertEqual(first['content'] + second['content'], BODY[:200])
        self.assertTrue(first['url'].startswith('https://github.com/'))
        self.assertEqual(first['fetchedAt'], second['fetchedAt'])

    def test_expired_and_refresh_fetch_new_body(self):
        with patch.object(reader, 'download', return_value=(BODY, 'text/plain')) as fetch:
            self.read()
            with patch.object(reader.time, 'time', return_value=reader.time.time() + reader.CACHE_TTL + 1):
                self.assertFalse(self.read()['cached'])
            self.assertFalse(self.read(refresh=True)['cached'])
        self.assertEqual(fetch.call_count, 3)

    def test_corrupt_cache_recovers(self):
        with patch.object(reader, 'download', return_value=(BODY, 'text/plain')):
            self.read()
            next(Path(self.directory.name).glob('*.json')).write_text('{broken')
            self.assertTrue(self.read()['ok'])

    def test_article_body_excludes_head_navigation_and_scripts(self):
        html = f'<html><head><title>Not evidence</title></head><body><nav>Menu</nav><article><h1>DPLR</h1><p>{BODY}&amp; equations</p><script>bad()</script></article><footer>Footer</footer></body></html>'
        with patch.object(reader, 'download', return_value=(html, 'text/html')):
            result = self.read('dplr-mathematics')
        self.assertTrue(result['ok'])
        self.assertIn('& equations', result['content'])
        for excluded in ('Not evidence', 'Menu', 'bad()', 'Footer'):
            self.assertNotIn(excluded, result['content'])

    def test_html_head_is_not_successful_evidence_or_cached(self):
        html = '<html><head><title>' + BODY + '</title></head></html>'
        with patch.object(reader, 'download', return_value=(html, 'text/html')) as fetch:
            for _ in range(2):
                result = self.read('dplr-mathematics')
                self.assertFalse(result['ok'])
                self.assertEqual(result['error']['code'], 'empty_content')
        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(list(Path(self.directory.name).glob('*')), [])

    def test_html_instead_of_raw_file_is_rejected(self):
        with patch.object(reader, 'download', return_value=(f'<html><body>{BODY}</body></html>', 'text/html')):
            self.assertEqual(self.read()['error']['code'], 'invalid_content')

    def test_404_and_certificate_failure_do_not_retry(self):
        errors = [
            (urllib.error.HTTPError('https://example.test', 404, 'Not found', {}, None), 'http_error'),
            (urllib.error.URLError(ssl.SSLCertVerificationError('unknown CA')), 'certificate_error'),
        ]
        for error, code in errors:
            with self.subTest(code=code), patch.object(reader, 'download', side_effect=error) as fetch:
                result = self.read()
                self.assertFalse(result['ok'])
                self.assertEqual(result['error']['code'], code)
                self.assertEqual(fetch.call_count, 1)

    def test_transient_failure_retries_once_and_stops(self):
        with patch.object(reader.time, 'sleep'), patch.object(reader, 'download', side_effect=TimeoutError('timeout')) as fetch:
            result = self.read()
        self.assertFalse(result['ok'])
        self.assertTrue(result['error']['retryExhausted'])
        self.assertEqual(fetch.call_count, 2)

    def test_transient_retry_can_recover(self):
        with patch.object(reader.time, 'sleep'), patch.object(reader, 'download', side_effect=[TimeoutError('timeout'), (BODY, 'text/plain')]):
            result = self.read()
        self.assertTrue(result['ok'])
        self.assertEqual(result['attempts'], 2)

    def test_redirect_cannot_leave_source_host_or_downgrade(self):
        handler = reader.SameHostRedirect()
        req = urllib.request.Request('https://example.test/article')
        for url in ('http://example.test/article/', 'https://other.test/', 'https://user:pass@example.test/'):
            with self.assertRaises(reader.ReadError):
                handler.redirect_request(req, None, 302, '', {}, url)
        self.assertEqual(handler.redirect_request(req, None, 302, '', {}, 'https://example.test/article/').full_url, 'https://example.test/article/')

    def test_response_size_is_bounded(self):
        class FakeResponse(io.BytesIO):
            pass
        with patch.object(reader, 'MAX_BYTES', 100), patch.object(reader.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value = FakeResponse(b'x' * 101)
            with self.assertRaises(reader.ReadError) as context:
                reader.download(reader.SOURCES['rwkv-overview'])
        self.assertEqual(context.exception.code, 'response_too_large')

    def test_cli_rejects_unlisted_url_and_invalid_pagination(self):
        for args in (['https://example.test'], ['rwkv-overview', '--offset', '-1'], ['rwkv-overview', '--offset', '2', '--refresh']):
            result = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)

    def test_cli_deduplicates_ids_and_reports_partial_failure(self):
        with patch.object(sys, 'argv', [str(SCRIPT), 'rwkv-overview', 'rwkv-overview', 'albatross']), patch.object(reader, 'read_source', side_effect=lambda source_id, **kw: {'id': source_id, 'ok': source_id == 'rwkv-overview'}) as read, patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(reader.main(), 1)
        self.assertEqual(read.call_count, 2)
        self.assertEqual(len(json.loads(output.getvalue())['results']), 2)


if __name__ == '__main__':
    unittest.main()
