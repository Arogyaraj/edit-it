"""Tests for custom looks (saved in IndexedDB), merge down, and move/scale handles on shape and text layers.
Run: python3 tests/next-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8774
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

BASE = os.path.join(TMP, 'edit-it-n-gray.png'); open(BASE, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))
RED = os.path.join(TMP, 'edit-it-n-red.png'); open(RED, 'wb').write(png_rows(32, 32, lambda x, y: (255, 0, 0)))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

def px(page, x, y):
    return page.evaluate("""([x, y]) => { const c = document.getElementById('view');
      return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data); }""", [x, y])

def set_range(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.value = v;"
                  " el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }", [id, str(v)])

def to_screen(page, dx, dy):
    r = page.locator('#canvas-wrap').bounding_box()
    w, h = page.evaluate("[document.getElementById('view').width, document.getElementById('view').height]")
    return r['x'] + dx / w * r['width'], r['y'] + dy / h * r['height']

def drag(page, a, b, steps=8):
    page.mouse.move(*a); page.mouse.down(); page.mouse.move(*b, steps=steps); page.mouse.up()

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    except Exception as e:
        print('FAIL cannot launch chromium:', str(e).splitlines()[0]); sys.exit(2)

    for name, vp in [('desktop', (1280, 800)), ('phone', (390, 844))]:
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', BASE)
        page.wait_for_function("!document.getElementById('view').hidden")

        # ---- custom looks: save, apply, delete, and they survive a reload ----
        page.click('#tab-fx')
        set_range(page, 's-brightness', 30)
        page.fill('#look-name', 'Golden hour')
        page.click('#look-save')
        page.wait_for_function("[...document.querySelectorAll('#look-list option')].some(o => o.textContent === 'Golden hour')")
        check(f'{name}: saving a look adds it to the list', page.locator('#look-list option', has_text='Golden hour').count() == 1)
        set_range(page, 's-brightness', 0)
        page.click('#look-list')
        page.select_option('#look-list', label='Golden hour')
        page.click('#look-apply')
        page.wait_for_function("state.layers[0].params.brightness === 30")
        check(f'{name}: applying a saved look restores its tune', page.evaluate("state.layers[0].params.brightness") == 30,
              page.evaluate("state.layers[0].params.brightness"))
        page.reload()
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        check(f'{name}: saved looks survive a reload', page.locator('#look-list option', has_text='Golden hour').count() == 1)
        page.select_option('#look-list', label='Golden hour')
        page.click('#look-delete')
        page.wait_for_function("![...document.querySelectorAll('#look-list option')].some(o => o.textContent === 'Golden hour')")
        check(f'{name}: deleting a look removes it', page.locator('#look-list option', has_text='Golden hour').count() == 0)

        # ---- merge down: the pixel is the same before and after; undo restores two layers ----
        page.set_input_files('#file-input', BASE)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-layers')
        page.set_input_files('#add-input', RED)
        page.wait_for_function("state.layers.length === 2")
        before = px(page, 32, 24)
        page.click('#lay-merge')
        page.wait_for_function("state.layers.length === 1")
        check(f'{name}: merge down leaves one layer', page.evaluate("state.layers.length") == 1)
        check(f'{name}: merged layer is an image named for its base', page.evaluate("state.layers[0].name").endswith('(merged)'))
        check(f'{name}: merging keeps the same picture', px(page, 32, 24) == before, (before, px(page, 32, 24)))
        page.click('#btn-undo')
        page.wait_for_function("state.layers.length === 2")
        check(f'{name}: undo restores both layers', page.evaluate("state.layers.length") == 2)

        # ---- shape handles: drag to move, drag a corner to resize ----
        page.click('#lay-add-shape')
        page.keyboard.press('m')
        x0 = page.evaluate("state.layers[state.layers.length-1].x")
        hd = page.evaluate("layerHandles()")
        cx, cy = hd['box']['cx'], hd['box']['cy']
        drag(page, to_screen(page, cx, cy), to_screen(page, cx + 8, cy))
        x1 = page.evaluate("state.layers[state.layers.length-1].x")
        check(f'{name}: dragging a shape moves it (+8px)', abs((x1 - x0) - 8 / 64) < 0.01, (x0, x1))
        w0 = page.evaluate("state.layers[state.layers.length-1].shape.w")
        corner = page.evaluate("layerHandles().corners[2]")
        drag(page, to_screen(page, corner['x'], corner['y']), to_screen(page, corner['x'] + 8, corner['y'] + 6))
        w1 = page.evaluate("state.layers[state.layers.length-1].shape.w")
        check(f'{name}: dragging a shape corner resizes it', w1 > w0 * 1.1, (w0, w1))
        page.keyboard.press('v')

        # ---- text handles: drag to move ----
        page.click('#lay-add-text')
        page.keyboard.press('m')
        t0 = page.evaluate("state.layers[state.layers.length-1].x")
        hd = page.evaluate("layerHandles()")
        cx, cy = hd['box']['cx'], hd['box']['cy']
        drag(page, to_screen(page, cx, cy), to_screen(page, cx + 6, cy + 4))
        t1 = page.evaluate("state.layers[state.layers.length-1].x")
        check(f'{name}: dragging text moves it', abs((t1 - t0) - 6 / 64) < 0.01, (t0, t1))
        check(f'{name}: text now has a rotate handle', page.evaluate("layerHandles().box.canRotate") is True)
        page.keyboard.press('v')

        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
