"""Tests for edge-extend expand, heal, rotation of shape and text layers, rasterising, bevel and pattern overlay.
Run: python3 tests/hard-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8775
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

GREY = os.path.join(TMP, 'edit-it-h-grey.png'); open(GREY, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))
STEP = os.path.join(TMP, 'edit-it-h-step.png'); open(STEP, 'wb').write(png_rows(64, 48, lambda x, y: (100, 100, 100) if x < 32 else (200, 200, 200)))
RED = os.path.join(TMP, 'edit-it-h-red.png'); open(RED, 'wb').write(png_rows(32, 32, lambda x, y: (255, 0, 0)))

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

def set_value(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.value = v;"
                  " el.dispatchEvent(new Event('change')); }", [id, v])

def set_check(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.checked = v;"
                  " el.dispatchEvent(new Event('change')); }", [id, v])

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
        errors = []

        # ---- expand: extend edges versus solid fill ----
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', GREY)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-geo')
        set_range(page, 'e-l', 10)
        check(f'{name}: solid expand fills the new area white', px(page, 2, 24)[0] == 255, px(page, 2, 24))
        set_value(page, 'e-mode', 'edge')
        check(f'{name}: edge expand repeats the photo edge (128)', abs(px(page, 2, 24)[0] - 128) <= 2, px(page, 2, 24))
        ctx.close()

        # ---- heal: lighter target from a darker source ends up near the target's lighting ----
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', STEP)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-fx')
        page.click('#retouch-add')
        page.click('#retouch-src')
        page.mouse.click(*to_screen(page, 16, 24))
        page.click('#retouch-paint')
        set_value(page, 'retouch-kind', 'heal')
        set_range(page, 'brush-size', 12)
        set_range(page, 'brush-hard', 100)
        drag(page, to_screen(page, 48, 24), to_screen(page, 49, 24))
        healed = px(page, 48, 24)[0]
        check(f'{name}: healing a dark source onto a light area lifts it (near 200, not 100)', abs(healed - 200) <= 10, healed)
        page.click('#btn-undo')
        check(f'{name}: undo restores the light area', abs(px(page, 48, 24)[0] - 200) <= 2, px(page, 48, 24))
        ctx.close()

        # ---- rotate a shape: a rectangle turned 90 degrees covers a point it did not cover before ----
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', GREY)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-layers')
        page.click('#lay-add-shape')
        check(f'{name}: outside the rectangle before rotating is grey', abs(px(page, 32, 10)[0] - 128) <= 2, px(page, 32, 10))
        page.evaluate("state.layers[state.layers.length - 1].rot = 90; render();")
        check(f'{name}: rotated rectangle now covers the point above it', px(page, 32, 10) == [143, 176, 255, 255], px(page, 32, 10))
        check(f'{name}: shape layers now offer a rotate handle', page.evaluate("layerHandles().box.canRotate") is True)
        ctx.close()

        # ---- rasterise: a text layer becomes an image layer with the same pixels ----
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', GREY)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-layers')
        page.click('#lay-add-text')
        set_value(page, 'text-color', '#ff0000')
        set_value(page, 'text-size', 30)
        before = page.evaluate("""() => { const c = document.getElementById('view'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60) n++; return n; }""")
        page.click('#lay-rasterize')
        page.wait_for_function("state.layers[state.layers.length - 1].type === 'image'")
        after = page.evaluate("""() => { const c = document.getElementById('view'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60) n++; return n; }""")
        check(f'{name}: rasterising keeps the text pixels', before > 20 and abs(after - before) <= max(4, before // 10), (before, after))
        ctx.close()

        # ---- bevel: light on the top-left inside edge, shade on the bottom-right ----
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', GREY)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-layers')
        page.set_input_files('#add-input', RED)
        page.wait_for_function("state.layers.length === 2")
        page.click('#tab-fx')
        page.click('#tab-layers')
        set_check(page, 'fx-bevel-on', True)
        set_value(page, 'fx-bevel-dist', 4)
        set_value(page, 'fx-bevel-blur', 1)
        top_left = px(page, 18, 10)
        bottom_right = px(page, 45, 38)
        check(f'{name}: bevel lights the top-left inside edge (blue lifted)', top_left[2] > 40, top_left)
        check(f'{name}: bevel shades the bottom-right inside edge (red darkened)', bottom_right[0] < 230, bottom_right)
        ctx.close()

        # ---- pattern overlay: dots in black on the red square ----
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', GREY)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-layers')
        page.set_input_files('#add-input', RED)
        page.wait_for_function("state.layers.length === 2")
        page.click('#tab-fx')
        page.click('#tab-layers')
        set_check(page, 'fx-pat-on', True)
        set_value(page, 'fx-pat-opacity', 100)
        set_value(page, 'fx-pat-scale', 10)
        dots = page.evaluate("""() => { const c = document.getElementById('view'), d = c.getContext('2d').getImageData(17, 9, 30, 30).data;
          let dark = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] < 120) dark++; else if (d[i] > 200) red++; } return [dark, red]; }""")
        check(f'{name}: pattern overlay puts dark dots on the red square', dots[0] > 5 and dots[1] > 5, dots)
        ctx.close()

        check(f'{name}: no page errors', not errors, errors[:3])
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
