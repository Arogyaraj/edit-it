"""Tests for on-canvas handles: layer move, scale, rotate; crop; straighten; tool keys; arrow nudging.
Run: python3 tests/canvas-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8771
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

BASE = os.path.join(TMP, 'edit-it-c-gray.png'); open(BASE, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))
RED = os.path.join(TMP, 'edit-it-c-red.png'); open(RED, 'wb').write(png_rows(32, 32, lambda x, y: (255, 0, 0)))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

def to_screen(page, dx, dy):
    r = page.locator('#canvas-wrap').bounding_box()
    w, h = page.evaluate("[document.getElementById('view').width, document.getElementById('view').height]")
    return r['x'] + dx / w * r['width'], r['y'] + dy / h * r['height']

def drag(page, a, b, steps=8):
    page.mouse.move(*a); page.mouse.down(); page.mouse.move(*b, steps=steps); page.mouse.up()

def export_dims(page):
    with page.expect_download() as dl:
        page.click('#btn-export-png')
    import struct as s
    data = open(dl.value.path(), 'rb').read()
    return s.unpack('>II', data[16:24])

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    except Exception as e:
        print('FAIL cannot launch chromium:', str(e).splitlines()[0]); sys.exit(2)

    for name, vp in [('desktop', (1280, 800)), ('phone', (390, 844))]:
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]}, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', BASE)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.set_input_files('#add-input', RED)
        page.wait_for_function("document.querySelectorAll('#layer-list .lrow').length === 2")
        check(f'{name}: toolbar is visible once a photo is open', page.is_visible('#tools'))

        # ---- move the red layer by dragging its body ----
        page.keyboard.press('m')
        check(f'{name}: M selects the move tool', page.get_attribute('#tool-move', 'aria-pressed') == 'true')
        x0 = page.evaluate("state.layers[1].x")
        hd = page.evaluate("layerHandles()")
        cx, cy = hd['box']['cx'], hd['box']['cy']
        drag(page, to_screen(page, cx, cy), to_screen(page, cx + 8, cy))
        x1 = page.evaluate("state.layers[1].x")
        check(f'{name}: dragging the body moves the layer (+8px ~ +0.125)', abs((x1 - x0) - 8 / 64) < 0.01, (x0, x1))

        # ---- scale from a corner ----
        s0 = page.evaluate("state.layers[1].scale")
        corner = page.evaluate("layerHandles().corners[2]")
        drag(page, to_screen(page, corner['x'], corner['y']), to_screen(page, corner['x'] + 10, corner['y'] + 10))
        s1 = page.evaluate("state.layers[1].scale")
        check(f'{name}: dragging a corner scales the layer up', s1 > s0 * 1.2, (s0, s1))

        # ---- rotate from the handle above the layer ----
        page.evaluate("state.layers[1].scale = 0.5; state.layers[1].x = 0.25; state.layers[1].y = 0.25; state.layers[1].rot = 0; render();")
        rot = page.evaluate("layerHandles().rot")
        box = page.evaluate("layerHandles().box")
        drag(page, to_screen(page, rot['x'], rot['y']), to_screen(page, box['cx'] + 60, box['cy']))
        angle = page.evaluate("state.layers[1].rot || 0")
        check(f'{name}: dragging the rotate handle to the right turns the layer ~90 deg', abs(angle - 90) < 8, angle)

        # ---- arrow keys nudge the layer ----
        xb = page.evaluate("state.layers[1].x")
        page.keyboard.press('ArrowLeft')
        check(f'{name}: arrow key nudges the layer one pixel', abs((page.evaluate("state.layers[1].x") - xb) + 1 / 64) < 0.001)
        page.click('#btn-undo')   # the nudge is undoable
        check(f'{name}: undo the nudge', abs(page.evaluate("state.layers[1].x") - xb) < 0.001)

        # ---- crop: drag the east edge to half width ----
        page.keyboard.press('c')
        check(f'{name}: C selects the crop tool', page.get_attribute('#tool-crop', 'aria-pressed') == 'true')
        page.click('#btn-undo')  # nothing to undo beyond the nudge; keep the state
        page.keyboard.press('c')
        page.evaluate("state.layers[1].rot = 0; state.layers[1].scale = 0.5; state.layers[1].x = 0.25; state.layers[1].y = 0.25; render();")
        drag(page, to_screen(page, 63.5, 24), to_screen(page, 32, 24))
        cw = page.evaluate("state.geo.crop.w")
        check(f'{name}: dragging the east handle crops to half width', abs(cw - 0.5) < 0.03, cw)
        check(f'{name}: the crop changes the export width to 32', export_dims(page)[0] == 32, export_dims(page))

        # ---- straighten: drag a horizon ----
        page.keyboard.press('s')
        page.evaluate("state.geo.crop = {x:0,y:0,w:1,h:1}; render();")
        drag(page, to_screen(page, 10, 30), to_screen(page, 50, 22))
        ang = page.evaluate("state.geo.angle")
        expected = -(__import__('math').degrees(__import__('math').atan2(-8, 40)))
        check(f'{name}: dragging a sloped horizon sets the straighten angle (~{expected:.1f} deg)', abs(ang - expected) < 0.8, ang)

        # ---- tool keys and the select tool ----
        page.keyboard.press('v')
        check(f'{name}: V returns to the select tool', page.get_attribute('#tool-select', 'aria-pressed') == 'true')
        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
