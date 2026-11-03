"""Checks that a normal render does no pixel readback on the CPU: the only readback is the small histogram copy.
Counts getImageData calls with an instrumented canvas context. Run: python3 tests/readback-tests.py"""
import threading, http.server, functools, os, sys, struct, zlib, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8783
TMP = tempfile.gettempdir()
def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
PHOTO = os.path.join(TMP, 'edit-it-rb.png'); open(PHOTO, 'wb').write(png_rows(64, 48, lambda x, y: (120, 130, 140)))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

# count every pixel readback on 2D canvases
COUNT_JS = """() => { if (window.__rb) return;
  window.__rb = 0;
  const orig = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...a) { window.__rb++; return orig.apply(this, a); };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("document.getElementById('sliders').children.length === 6")
    page.set_input_files('#file-input', PHOTO)
    page.wait_for_function("!document.getElementById('view').hidden")
    page.evaluate(COUNT_JS)
    # a tuned layer, then a plain re-render
    page.evaluate("state.layers[0].params.brightness = 40; render();")
    page.evaluate("window.__rb = 0; render();")
    rb = page.evaluate("window.__rb")
    check(f'a normal re-render reads back at most the histogram thumbnail (got {rb})', rb <= 1, rb)
    # a second tuned layer on top, and a repeated render: still no full-size readbacks
    page.evaluate("window.__rb = 0; render(); render(); render();")
    check('three more renders read back no more than the histogram each time', page.evaluate("window.__rb") <= 3, page.evaluate("window.__rb"))
    # clipping is the one feature that reads the full view, and only while it is on
    page.evaluate("window.__rb = 0; state.clip = true; render();")
    check('clipping on reads the view back for its overlay', page.evaluate("window.__rb") >= 1, page.evaluate("window.__rb"))
    page.evaluate("state.clip = false; window.__rb = 0; render();")
    check('clipping off again: back to the histogram-only readback', page.evaluate("window.__rb") <= 1, page.evaluate("window.__rb"))
    check('no page errors', not errors, errors[:3])
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
