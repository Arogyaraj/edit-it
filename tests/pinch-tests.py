"""Pinch to zoom with two touch points (sent through the DevTools protocol). Run: python3 tests/pinch-tests.py"""
import threading, http.server, functools, struct, zlib, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8776
TMP = tempfile.gettempdir()
def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
GREY = os.path.join(TMP, 'edit-it-pinch.png'); open(GREY, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("document.getElementById('sliders').children.length === 6")
    page.set_input_files('#file-input', GREY)
    page.wait_for_function("!document.getElementById('view').hidden")
    check('zoom label starts at Fit', page.inner_text('#zoom-label') == 'Fit')
    r = page.locator('#canvas-wrap').bounding_box()
    cx, cy = r['x'] + r['width'] / 2, r['y'] + r['height'] / 2
    cdp = ctx.new_cdp_session(page)
    def touch(kind, points):
        cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': points})
    # spread the two fingers apart: a pinch out zooms in
    touch('touchStart', [{'x': cx - 30, 'y': cy, 'id': 1}, {'x': cx + 30, 'y': cy, 'id': 2}])
    for step in range(1, 9):
        touch('touchMove', [{'x': cx - 30 - step * 12, 'y': cy, 'id': 1}, {'x': cx + 30 + step * 12, 'y': cy, 'id': 2}])
    touch('touchEnd', [])
    page.wait_for_timeout(100)
    label = page.inner_text('#zoom-label')
    check('pinching apart zooms in (label is a percentage above Fit)', label.endswith('%'), label)
    zoomed = page.evaluate("state.zoom")
    check('pinching apart increases the zoom factor', zoomed > 1.5, zoomed)
    # pinch together zooms back out
    touch('touchStart', [{'x': cx - 150, 'y': cy, 'id': 1}, {'x': cx + 150, 'y': cy, 'id': 2}])
    for step in range(1, 9):
        touch('touchMove', [{'x': cx - 150 + step * 12, 'y': cy, 'id': 1}, {'x': cx + 150 - step * 12, 'y': cy, 'id': 2}])
    touch('touchEnd', [])
    page.wait_for_timeout(100)
    check('pinching together zooms out', page.evaluate("state.zoom") < zoomed, (zoomed, page.evaluate("state.zoom")))
    check('no page errors', not errors, errors[:3])
    ctx.close(); browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
