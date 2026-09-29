#!/usr/bin/env python3
"""Read allowlisted public RWKV sources without third-party Python dependencies."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import socket
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

AGENT_ROOT = Path(__file__).resolve().parents[1]
SOURCES = {s['id']: s for s in json.loads(
    (AGENT_ROOT / 'metadata/rwkv-knowledge-sources.json').read_text())}
CACHE_DIR = AGENT_ROOT.parent / '.context/rwkv-knowledge'
CACHE_TTL = 86400
MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = 20
CACHE_VERSION = 1


class ReadError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class ArticleParser(HTMLParser):
    """Prefer article/main content; never count metadata/scripts as evidence."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.parts = {'article': [], 'main': [], 'body': []}

    def handle_starttag(self, tag, attrs):
        if tag not in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                       'link', 'meta', 'param', 'source', 'track', 'wbr'}:
            self.stack.append(tag)
        if tag in {'p', 'div', 'br', 'li', 'pre', 'h1', 'h2', 'h3', 'tr'}:
            self.handle_data('\n')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in self.stack:
            index = len(self.stack) - 1 - self.stack[::-1].index(tag)
            del self.stack[index:]
        if tag in {'p', 'div', 'li', 'pre', 'h1', 'h2', 'h3', 'tr'}:
            self.handle_data('\n')

    def handle_data(self, data):
        if any(t in self.stack for t in ('head', 'script', 'style', 'nav', 'footer', 'noscript')):
            return
        for scope in self.parts:
            if scope in self.stack:
                self.parts[scope].append(data)

    def text(self):
        for scope in ('article', 'main', 'body'):
            text = ''.join(self.parts[scope])
            text = '\n'.join(re.sub(r'[ \t]+', ' ', line).strip() for line in text.splitlines())
            text = re.sub(r'\n{3,}', '\n\n', text).strip()
            if text:
                return text
        return ''


class SameHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if new.scheme != 'https' or old.hostname != new.hostname or new.username or new.password:
            raise ReadError('redirect_rejected', 'Only HTTPS redirects on the same source host are allowed.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(source):
    opener = urllib.request.build_opener(
        SameHostRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request = urllib.request.Request(source['fetchUrl'], headers={
        'User-Agent': 'OA-Agent-RWKV-Reader/1.0', 'Accept': 'text/plain, text/html;q=0.9'})
    with opener.open(request, timeout=TIMEOUT) as response:
        # Bound the response size and the overall body-read duration as well as socket waits.
        deadline = time.monotonic() + TIMEOUT
        chunks, size = [], 0
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError('Response body exceeded the read deadline.')
            chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_BYTES:
                raise ReadError('response_too_large', 'Source exceeds the 2 MiB limit.')
        encoding = response.headers.get_content_charset() or 'utf-8'
        return b''.join(chunks).decode(encoding, errors='replace'), response.headers.get_content_type()


def classify_error(error):
    if isinstance(error, ReadError):
        return error
    if isinstance(error, urllib.error.HTTPError):
        classified = ReadError('http_error', f'HTTP {error.code}', error.code in (408, 429, 500, 502, 503, 504))
        error.close()
        return classified
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(reason, ssl.SSLCertVerificationError):
        return ReadError('certificate_error', 'HTTPS certificate verification failed; configure trusted CA certificates. Verification was not disabled.')
    if isinstance(reason, (TimeoutError, socket.timeout, ConnectionError)):
        return ReadError('network_error', str(reason), True)
    if isinstance(reason, socket.gaierror):
        return ReadError('dns_error', str(reason), reason.errno == socket.EAI_AGAIN)
    return ReadError('read_error', str(reason))


def extract_content(source, raw, content_type):
    is_html = content_type == 'text/html' or re.search(r'<(?:!doctype\s+html|html|head|body)\b', raw[:1024], re.I)
    if source['format'] == 'html':
        if not is_html:
            raise ReadError('invalid_content', 'Expected an HTML article.')
        parser = ArticleParser()
        parser.feed(raw)
        text = parser.text()
    else:
        if is_html:
            raise ReadError('invalid_content', 'Expected a raw text file but received HTML.')
        text = raw.strip()
    if len(text) < 80:
        raise ReadError('empty_content', 'No meaningful source body was extracted; metadata is not evidence.')
    return text


def read_source(source_id, cache_dir=CACHE_DIR, refresh=False, offset=0, max_chars=12000):
    source = SOURCES[source_id]
    result = {'id': source_id, 'title': source['title'], 'url': source['url'], 'fetchUrl': source['fetchUrl']}
    key = hashlib.sha256(f"{CACHE_VERSION}:{source['fetchUrl']}:{source['format']}".encode()).hexdigest()
    cache_file = Path(cache_dir) / f'{key}.json'
    cached = None
    if not refresh:
        try:
            candidate = json.loads(cache_file.read_text())
            if (0 <= time.time() - candidate['timestamp'] < CACHE_TTL
                    and isinstance(candidate['content'], str) and len(candidate['content']) >= 80):
                cached = candidate
        except (OSError, ValueError, KeyError, TypeError):
            pass
    attempts = 0
    warning = None
    if cached is None:
        for attempt in range(2):
            attempts += 1
            try:
                raw, content_type = download(source)
                content = extract_content(source, raw, content_type)
                cached = {'timestamp': time.time(), 'content': content}
                break
            except Exception as error:
                classified = classify_error(error)
                if not classified.retryable or attempt == 1:
                    return {**result, 'ok': False, 'attempts': attempts, 'error': {
                        'code': classified.code, 'message': str(classified),
                        'retryable': classified.retryable, 'retryExhausted': classified.retryable}}
                time.sleep(0.3)
        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=cache_file.parent, delete=False) as file:
                    temporary = file.name
                    json.dump(cached, file, ensure_ascii=False)
                os.replace(temporary, cache_file)
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)
        except OSError:
            warning = 'Source was read successfully but could not be cached.'
    content = cached['content']
    if offset >= len(content):
        return {**result, 'ok': False, 'error': {'code': 'invalid_offset', 'message': 'Offset is beyond the source body.'}}
    end = min(offset + max_chars, len(content))
    result.update(ok=True, cached=attempts == 0, attempts=attempts,
                  fetchedAt=datetime.fromtimestamp(cached['timestamp'], timezone.utc).isoformat(),
                  totalChars=len(content), offset=offset, truncated=end < len(content),
                  nextOffset=end if end < len(content) else None, content=content[offset:end])
    if warning:
        result['warning'] = warning
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sources', nargs='+', choices=list(SOURCES))
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--max-chars', type=int, default=12000)
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    ids = list(dict.fromkeys(args.sources))
    if len(ids) > 3 or args.offset < 0 or not 1 <= args.max_chars <= 24000:
        parser.error('Use at most 3 sources, offset >= 0, and max-chars between 1 and 24000.')
    if args.offset and (len(ids) != 1 or args.refresh):
        parser.error('Pagination requires one source and cannot be combined with --refresh.')
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda source_id: read_source(
            source_id, refresh=args.refresh, offset=args.offset, max_chars=args.max_chars), ids))
    print(json.dumps({'results': results}, ensure_ascii=False))
    return 0 if all(result['ok'] for result in results) else 1


if __name__ == '__main__':
    sys.exit(main())
