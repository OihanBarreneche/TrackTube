# -*- coding: utf-8 -*-
"""Re-lay the marquee as a 1280 x 800 screenshot for the store listing.

The promotional images are never drawn on an item's own page: the small tile
belongs to the homepage, the category pages and the search results, and the
marquee is only painted when Google picks an item for the carousel at the top
of the store. The screenshots are the one place a listing shows artwork it
chose itself, and they take 1280 x 800 or 640 x 400. So the artwork made for
the marquee is re-laid out at that size and added to the screenshots.

It is re-laid out and not scaled. The marquee is 1400 x 560, which is 2.5:1,
against 1.6:1 here: fitting one inside the other leaves a third of the frame
empty whichever way it is done. What this tool does instead is move the
marquee's own groups, each of which keeps its internal coordinates and is
simply wrapped in a translation. Nothing is redrawn, no string is copied: the
headline, the feed mock and the three feature cards are the same elements, so a
word changed in `marquee.svg` or `marquee.fr.svg` reaches this image too, and
the two languages cannot drift apart.

The blocks are cut on anchors that must appear exactly once, and the cut fails
loudly rather than producing a quietly wrong picture.

Rendering goes through headless Chrome because Node is not installed on this
machine, which is also why `tools/shoot.py` drives Chrome rather than
Playwright. The thumbnails are inlined as data URIs first: a `file://` document
does not reliably load a relative subresource from an SVG, and the one that
fails leaves a blank rectangle rather than an error.

    python tools/render-promo.py           both languages
    python tools/render-promo.py fr        one of them
"""
import base64
import io
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'store-assets')
OUT = os.path.join(ROOT, 'screenshots')
WIDTH, HEIGHT = 1280, 800

CHROME = os.environ.get('TRACKTUBE_BROWSER_PATH') or \
    r'C:\Program Files\Google\Chrome\Application\chrome.exe'

# Where each block goes, as a translation applied to the marquee's own
# coordinates. The numbers are the target top left corner minus the source one,
# so they read against the source file rather than being magic.
#
#   headline   x  72 y  78  ->  150,  72     the brand mark, title and badge
#   feed       x 550 y  62  ->  672,  68     the card is already inside a
#                                            translate(0 20), hence y 62
#   shorts     x1078 y  63  ->  150, 589     the three feature cards, stacked
#   history    x1034 y 198  ->  437, 566     in the marquee, in a row here
#   sort       x1034 y 377  ->  812, 575
PLACES = {
    'headline': (78, -6),
    'feed': (122, 6),
    'shorts': (-928, 526),
    'history': (-597, 368),
    'sort': (-222, 198),
}

# The marquee's own decorations are framed for a 2.5:1 canvas; these are the
# same three shapes and the same colours, framed for this one.
BACKDROP = """  <rect width="%d" height="%d" fill="url(#background)"/>
  <circle cx="1150" cy="-140" r="380" fill="#6c54ed" opacity=".13"/>
  <circle cx="170" cy="880" r="350" fill="#9e7cf4" opacity=".09"/>
  <path d="M0 694C250 612 430 700 648 800H0Z" fill="#6951d2" opacity=".07"/>
""" % (WIDTH, HEIGHT)


def cut(text, anchor, what):
    """Split on an anchor that has to be unique, and say so when it is not."""
    seen = text.count(anchor)
    if seen != 1:
        raise SystemExit('anchor for %s found %d times, expected once: %s'
                         % (what, seen, anchor))
    head, tail = text.split(anchor)
    return head, anchor + tail


def blocks(svg):
    """The marquee's five movable parts, each keeping its own coordinates."""
    defs = re.search(r'<defs>.*?</defs>', svg, re.S)
    if not defs:
        raise SystemExit('no <defs> in the source')

    body = svg[defs.end():]
    body = body[:body.rindex('</svg>')]

    # The first two cuts land on comments the file already carries as section
    # headings; the last three on the rounded rectangle that opens each card.
    _, rest = cut(body, '<!-- The small tile is the brand mark', 'the headline')
    headline, rest = cut(rest, '<!-- An illustrative feed', 'the feed')
    feed, rest = cut(rest, '<!-- Three compact companion cards', 'the cards')
    shorts, rest = cut(rest, '<g filter="url(#shadow)"><rect x="1034" y="198"', 'history')
    history, sort = cut(rest, '<g filter="url(#shadow)"><rect x="1034" y="377"', 'sort')

    return defs.group(0), {
        'headline': headline, 'feed': feed,
        'shorts': shorts, 'history': history, 'sort': sort,
    }


def compose(svg):
    defs, parts = blocks(svg)
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
           'viewBox="0 0 %d %d">' % (WIDTH, HEIGHT, WIDTH, HEIGHT), defs,
           BACKDROP]
    for name in ('headline', 'feed', 'shorts', 'history', 'sort'):
        dx, dy = PLACES[name]
        out.append('  <g transform="translate(%s %s)">' % (dx, dy))
        out.append(parts[name].strip())
        out.append('  </g>')
    out.append('</svg>')
    return '\n'.join(out)


def inline_photos(svg):
    """A relative href does not survive a file:// document; base64 does."""
    for name in ('lake', 'road', 'city'):
        reference = 'href="thumbnails/%s.jpg"' % name
        if reference not in svg:
            raise SystemExit('missing %s' % reference)
        with open(os.path.join(ASSETS, 'thumbnails', '%s.jpg' % name), 'rb') as f:
            data = base64.b64encode(f.read()).decode('ascii')
        svg = svg.replace(reference, 'href="data:image/jpeg;base64,%s"' % data)
    return svg


def shoot(svg, target):
    page = ('<!doctype html><meta charset="utf-8">'
            '<style>html,body{margin:0;padding:0;overflow:hidden;'
            'background:#100e21}svg{display:block}</style>' + svg)
    work = tempfile.mkdtemp(prefix='tracktube-promo-')
    source = os.path.join(work, 'promo.html')
    with io.open(source, 'w', encoding='utf-8', newline='') as f:
        f.write(page)
    subprocess.run([
        CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--force-device-scale-factor=1', '--default-background-color=00000000',
        '--user-data-dir=' + os.path.join(work, 'profile'),
        '--virtual-time-budget=5000',
        '--window-size=%d,%d' % (WIDTH, HEIGHT),
        '--screenshot=' + target, 'file:///' + source.replace('\\', '/'),
    ], check=True, capture_output=True)
    return source


def render(lang):
    stem = 'marquee' if lang == 'en' else 'marquee.fr'
    with io.open(os.path.join(ASSETS, '%s.svg' % stem), encoding='utf-8') as f:
        svg = compose(f.read())
    name = 'promo-store.png' if lang == 'en' else 'promo-store-fr.png'
    target = os.path.join(OUT, name)
    source = shoot(inline_photos(svg), target)

    from PIL import Image
    with Image.open(target) as image:
        size = image.size
    if size != (WIDTH, HEIGHT):
        raise SystemExit('%s came out at %dx%d' % (name, size[0], size[1]))
    print('%s  %dx%d  %d bytes' % (name, size[0], size[1],
                                   os.path.getsize(target)))
    return source


if __name__ == '__main__':
    wanted = sys.argv[1:] or ['en', 'fr']
    for lang in wanted:
        if lang not in ('en', 'fr'):
            raise SystemExit('unsupported language: %s' % lang)
        render(lang)
