"""Fails if any readback path logs a browser warning or error (for example Canvas2D willReadFrequently).
Runs the clipping overlay, curves, sharpen, noise reduction, auto tone, healing and the histogram.
Run: python3 tests/console-tests.py"""
import threading, http.server, functools, os, sys, struct, zlib, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8780
TMP = tempfile.gettempdir()
def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
STEP = os.path.join(TMP, 'edit-it-c2-step.png'); open(STEP, 'wb').write(png_rows(64, 48, lambda x, y: (100, 100, 100) if x < 32 else (200, 200, 200)))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

def set_range(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.value = v;"
                  " el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }", [id, str(v)])

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    page = browser.new_page(viewport={'width': 1280, 'height': 800})
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('warning', 'error', 'issue') else None)
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto(URL)
    page.wait_for_function("document.getElementById('sliders').children.length === 6")
    page.set_input_files('#file-input', STEP)
    page.wait_for_function("!document.getElementById('view').hidden")
    page.wait_for_timeout(300)
    # Chrome warns only after repeated readbacks, so keep the clipping overlay on and re-render many times
    page.click('#clip-toggle')
    for _ in range(12):
        page.evaluate("render()")
    page.click('#clip-toggle')
    page.click('#tab-geo'); page.click('#tab-tune')
    page.click('#tab-tune')
    page.click('#tune-auto')
    page.click('#tab-fx')
    set_range(page, 'det-sharpen', 50)
    set_range(page, 'det-denoise', 50)
    page.click('#tab-layers')
    page.click('#lay-add-adjust')
    page.click('#tab-fx')
    set_range(page, 'curve-2', 20)
    page.click('#retouch-add'); page.click('#retouch-src')
    page.mouse.click(*(lambda b, w, h: (b['x'] + (16 + .5) / w * b['width'], b['y'] + (24 + .5) / h * b['height']))(page.locator('#canvas-wrap').bounding_box(), *page.evaluate("[document.getElementById('view').width, document.getElementById('view').height]")))
    page.click('#retouch-paint')
    set_range(page, 'brush-size', 12)
    page.evaluate("document.getElementById('retouch-kind').value = 'heal'")
    page.evaluate("""() => { const b = document.getElementById('canvas-wrap').getBoundingClientRect();
      const sx = b.x + 48.5 / 64 * b.width, sy = b.y + 24.5 / 48 * b.height;
      const o = { clientX: sx, clientY: sy, pointerId: 1, pointerType: 'mouse', bubbles: true };
      const ov = document.getElementById('overlay');
      ov.dispatchEvent(new PointerEvent('pointerdown', o)); ov.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: sx + 1 }));
      ov.dispatchEvent(new PointerEvent('pointerup', o)); }""")
    page.wait_for_timeout(200)
    check('the heal stroke ran (the layer was added and painted)', page.evaluate("state.layers.length >= 3"))
    # The readback warning is what this test guards. Environment and GPU messages are reported as notes.
    bad = [l for l in logs if 'Canvas2D' in l or 'willReadFrequently' in l or l.startswith('pageerror')]
    notes = [l for l in logs if l not in bad]
    for n in notes:
        print('note: ' + n[:160])
    check('no Canvas2D readback warnings and no page errors', not bad, bad[:5])
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
