"""Static server that honours the `?range=start-end` query the preview reader uses.

`python -m http.server` ignores it and returns the whole file for every segment,
so the MediaSource path can never start under it. The Playwright harness routes
those requests itself; this is the same thing for a browser driven by hand.
"""
import sys, os, re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# The repository root, found from this file: no absolute path is ever written
# down in this project, because the folder has moved twice and every path
# written down became a lie the day it moved.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        rng = (qs.get('range') or [None])[0]
        m = re.match(r'^(\d+)-(\d+)$', rng or '')
        if not m:
            return super().do_GET()

        path = self.translate_path(parsed.path)
        if not os.path.isfile(path):
            return super().do_GET()

        start, end = int(m.group(1)), int(m.group(2))
        size = os.path.getsize(path)
        end = min(end, size - 1)
        if start > end:
            self.send_error(416)
            return
        with open(path, 'rb') as f:
            f.seek(start)
            chunk = f.read(end - start + 1)

        ctype = self.guess_type(path)
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(chunk)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(chunk)

if __name__ == '__main__':
    port = int(sys.argv[1])
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
