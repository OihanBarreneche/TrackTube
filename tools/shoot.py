"""Render the benches to PNG or JPEG at reproducible sizes.

The README captures and Store captures serve different layouts. Chrome Web
Store screenshots must be 1280 x 800 or 640 x 400, while the README can show
the popup and longer history view at their natural sizes. This drives a headless
Chrome so the same command gives the same pixels on any machine.

It uses its own throwaway profile and never touches an installed one. The feed
shot fetches real thumbnails from `i.ytimg.com`, so that one needs the network.

    python tools/shoot.py                  every English shot
    python tools/shoot.py feed             one English shot
    python tools/shoot.py --lang fr feed   one French shot, saved as feed-fr.jpg

Pillow does the cropping; Chrome is looked for where Windows and Linux put it.
"""
from pathlib import Path
import argparse
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'screenshots'

CHROMES = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
]

# name: (bench url with its parameters, window size, crop box or None, format)
#
# The crop boxes are in CSS pixels at a device ratio of one, which is what the
# headless window gives. They are written here rather than guessed at capture
# time: a shot that reframes itself is a shot that changes between two runs.
#
# The two shots full of real thumbnails are written as JPEG and the two flat
# ones as PNG. The feed came to 540 KB lossless against about a fifth of that at
# quality 90, and every visitor to the repository page downloads it.
SHOTS = {
    'feed': ('test/feed-view-preview.html?thumbs&lang=en', (1280, 860), (0, 0, 1280, 800), 'jpg'),
    'history': ('test/history-preview.html?lang=en&shot=overview', (1280, 1010), (0, 0, 1280, 990), 'png'),
    'triage': ('test/triage-preview.html?lang=en&thumbs&shot=drag', (1280, 800), None, 'jpg'),
    'popup': ('test/popup-preview.html?lang=en&shot=popup', (520, 700), (20, 20, 420, 520), 'png'),
    # Store screenshots keep the real UI and fit Google's 1280x800 / 640x400 formats.
    'history-store': ('test/history-preview.html?lang=en&shot=store', (1280, 800), None, 'png'),
    'popup-store': ('test/popup-preview.html?lang=en&shot=store', (640, 400), None, 'png'),
}


AVATARS = ROOT / 'test' / 'fixtures' / '.avatars'


def ensure_avatars():
    """Download the fixture's avatars once, and index them for the benches.

    Without this the capture races the network: the grid probes each avatar
    before painting and draws an initial for whichever probe loses, which was a
    different channel on every run.
    """
    import urllib.request

    fixture = ROOT / 'test' / 'fixtures' / 'real-feed.json'
    if not fixture.exists():
        return
    channels = json.loads(fixture.read_text(encoding='utf-8'))['channels']
    AVATARS.mkdir(parents=True, exist_ok=True)
    index = {}
    for channel in channels:
        url = channel.get('avatarUrl') or ''
        if not url.startswith('https://'):
            continue
        local = AVATARS / (channel['id'] + '.jpg')
        if not local.exists():
            request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(request, timeout=30) as response:
                local.write_bytes(response.read())
            print('cached   %s' % channel['title'])
        index[channel['id']] = '.avatars/' + local.name
    (AVATARS / 'index.json').write_text(
        json.dumps(index, indent=1), encoding='utf-8')


def find_chrome():
    for path in CHROMES:
        if Path(path).exists():
            return path
    found = shutil.which('google-chrome') or shutil.which('chromium')
    if found:
        return found
    raise SystemExit('No Chrome or Edge found; add its path to CHROMES.')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def serve(port):
    """The project's own range server, in a thread, so no port is left behind."""
    sys.path.insert(0, str(ROOT / 'tools'))
    import importlib
    mod = importlib.import_module('serve-ranges'.replace('-', '_')) \
        if (ROOT / 'tools' / 'serve_ranges.py').exists() else None
    if mod is None:
        # `serve-ranges.py` is not an importable module name, so run it apart.
        proc = subprocess.Popen([sys.executable, str(ROOT / 'tools' / 'serve-ranges.py'), str(port)],
                                cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return proc
    threading.Thread(target=mod.main, args=(port,), daemon=True).start()
    return None


def shoot(chrome, port, name, lang):
    url_path, (width, height), box, fmt = SHOTS[name]
    url_path = url_path.replace('lang=en', 'lang=' + lang)
    url = 'http://127.0.0.1:%d/%s' % (port, url_path)
    with tempfile.TemporaryDirectory() as profile:
        raw = Path(profile) / 'shot.png'
        subprocess.run([
            chrome,
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
            '--no-first-run',
            '--no-default-browser-check',
            '--user-data-dir=' + profile,
            '--window-size=%d,%d' % (width, height),
            '--virtual-time-budget=30000',
            '--screenshot=' + str(raw),
            url,
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)

        from PIL import Image
        image = Image.open(raw)
        if box:
            image = image.crop(box)
        image = image.convert('RGB')
        suffix = '' if lang == 'en' else '-' + lang
        target = OUT / ('%s%s.%s' % (name, suffix, fmt))
        if fmt == 'jpg':
            image.save(target, quality=90, optimize=True, subsampling=0)
        else:
            image.save(target, optimize=True)
        print('%-9s %dx%d  %s' % (name, image.width, image.height, target.relative_to(ROOT)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lang', choices=('en', 'fr'), default='en')
    parser.add_argument('shots', nargs='*')
    args = parser.parse_args()
    wanted = args.shots or list(SHOTS)
    for name in wanted:
        if name not in SHOTS:
            raise SystemExit('Unknown shot %r; known: %s' % (name, ', '.join(SHOTS)))
    OUT.mkdir(exist_ok=True)
    ensure_avatars()
    chrome = find_chrome()
    port = free_port()
    proc = serve(port)
    try:
        time.sleep(1.5)
        for name in wanted:
            shoot(chrome, port, name, args.lang)
    finally:
        if proc:
            proc.terminate()


if __name__ == '__main__':
    main()
