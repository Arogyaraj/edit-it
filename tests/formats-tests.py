"""Opens real files in many formats (generated with Pillow), checks detection by content, the HEIC path with and
without a decoder (the decoder is a stub here), and the messages for formats that still cannot be decoded.
Run: python3 tests/formats-tests.py"""
import threading, http.server, functools, os, sys, tempfile, io
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8784
TMP = tempfile.gettempdir()
W, H = 48, 32
def save(name, fmt, **kw):
    path = os.path.join(TMP, name)
    Image.new('RGB', (W, H), (200, 60, 40)).save(path, fmt, **kw)
    return path
FILES = {
    'jpeg': save('edit-it-f.jpg', 'JPEG'),
    'png': save('edit-it-f.png', 'PNG'),
    'gif': save('edit-it-f.gif', 'GIF'),
    'bmp': save('edit-it-f.bmp', 'BMP'),
    'webp': save('edit-it-f.webp', 'WEBP'),
    'avif': save('edit-it-f.avif', 'AVIF'),
    'ico': save('edit-it-f.ico', 'ICO', sizes=[(W, H)]),
    'tiff': save('edit-it-f.tif', 'TIFF'),
}
# a JPEG with a misleading name: the content decides
RENAMED = os.path.join(TMP, 'edit-it-renamed.dat'); open(RENAMED, 'wb').write(open(FILES['jpeg'], 'rb').read())
SVG = os.path.join(TMP, 'edit-it-f.svg')
open(SVG, 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"><rect width="{W}" height="{H}" fill="#3c8ad0"/></svg>')
TEXT = os.path.join(TMP, 'edit-it-notes.txt'); open(TEXT, 'w').write('this is not a picture')
# HEIC: an ISO base media header with the heic brand (the content is a stub; only the decoder stub reads it)
HEIC = os.path.join(TMP, 'edit-it-f.heic')
open(HEIC, 'wb').write(b'\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic' + b'\x00' * 64)

STUB = """window.libheif = { HeifDecoder: class {
  decode(buf) { return [{ get_width: () => 32, get_height: () => 32,
    display: (data, cb) => { for (let i = 0; i < data.data.length; i += 4) { data.data[i] = 30; data.data[i + 1] = 160; data.data[i + 2] = 90; data.data[i + 3] = 255; } cb(data); } }]; }
}};"""

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

def open_file(browser, path, stub=None):
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    if stub is not None:
        page.route('**/vendor/libheif/libheif.js', lambda route: route.fulfill(status=200, content_type='application/javascript', body=stub))
    page.goto(URL)
    page.wait_for_function("document.getElementById('sliders').children.length === 6")
    page.set_input_files('#file-input', path)
    page.wait_for_function("state.doc !== null || document.getElementById('status').textContent.length > 0", timeout=15000)
    page.wait_for_timeout(300)
    return ctx, page, errors

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])

    for kind in ['jpeg', 'png', 'gif', 'bmp', 'webp', 'avif', 'ico']:
        ctx, page, errors = open_file(browser, FILES[kind])
        doc = page.evaluate("state.doc && [state.doc.w, state.doc.h]")
        if doc is None and kind == 'avif':
            check('avif opens (this Chromium may not decode AVIF)', False, page.inner_text('#status'))
        else:
            check(f'{kind} opens at {W}x{H}', doc == [W, H], doc)
        check(f'{kind}: no page errors', not errors, errors[:2])
        ctx.close()

    ctx, page, errors = open_file(browser, SVG)
    doc = page.evaluate("state.doc && [state.doc.w, state.doc.h]")
    check(f'svg opens (through the image element) at {W}x{H}', doc == [W, H], doc)
    ctx.close()

    ctx, page, errors = open_file(browser, RENAMED)
    doc = page.evaluate("state.doc && [state.doc.w, state.doc.h]")
    check('a JPEG named .dat still opens (detected by content)', doc == [W, H], doc)
    ctx.close()

    ctx, page, errors = open_file(browser, FILES['tiff'])
    msg = page.inner_text('#status')
    check('TIFF gets a clear message, not a crash', 'TIFF photos are not supported yet' in msg, msg)
    ctx.close()

    ctx, page, errors = open_file(browser, TEXT)
    msg = page.inner_text('#status')
    check('a text file gets a clear message', 'Could not open' in msg, msg)
    ctx.close()

    ctx, page, errors = open_file(browser, HEIC)
    msg = page.inner_text('#status')
    check('HEIC without a decoder explains what to add', 'HEIC photos need a decoder' in msg, msg)
    check('HEIC without a decoder: no page errors', not errors, errors[:2])
    ctx.close()

    ctx, page, errors = open_file(browser, HEIC, stub=STUB)
    doc = page.evaluate("state.doc && [state.doc.w, state.doc.h]")
    check('HEIC with a decoder bundle opens through the adapter (stub: 32x32)', doc == [32, 32], doc)
    check('HEIC with a decoder bundle: no page errors', not errors, errors[:2])
    ctx.close()

    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
