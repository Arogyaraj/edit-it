"""Tests for canvas zoom and pan, perspective handles, clone source marker, project delete, RGB histogram,
and the phone header menu. Run: python3 tests/polish-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8772
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

BASE = os.path.join(TMP, 'edit-it-p-gray.png'); open(BASE, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))

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

        # ---- zoom: wheel, keys, label ----
        check(f'{name}: zoom label starts at Fit', page.inner_text('#zoom-label') == 'Fit')
        cx, cy = to_screen(page, 32, 24)
        page.mouse.move(cx, cy)
        page.mouse.wheel(0, -200)
        page.wait_for_timeout(50)
        check(f'{name}: wheel up zooms in (label is a percentage)', page.inner_text('#zoom-label').endswith('%'), page.inner_text('#zoom-label'))
        page.keyboard.press('0')
        check(f'{name}: 0 returns to fit', page.inner_text('#zoom-label') == 'Fit')
        for _ in range(8):
            page.keyboard.press('+')
        check(f'{name}: + zooms in to a scrollable size', page.evaluate("document.getElementById('stage').classList.contains('scrollable')"))

        # ---- Space + drag pans the zoomed canvas ----
        before = page.evaluate("document.getElementById('stage').scrollLeft")
        page.keyboard.down(' ')
        page.mouse.move(*to_screen(page, 4, 4)); page.mouse.down()
        page.mouse.move(*to_screen(page, -8, 4), steps=6); page.mouse.up()
        page.keyboard.up(' ')
        after = page.evaluate("document.getElementById('stage').scrollLeft")
        check(f'{name}: space-drag pans the canvas', after > before, (before, after))
        page.keyboard.press('0')

        # ---- perspective tool: drag the top-left corner ----
        page.keyboard.press('p')
        check(f'{name}: P selects the perspective tool', page.get_attribute('#tool-perspective', 'aria-pressed') == 'true')
        # the bottom-right corner: the phone toolbar sits over the top-left one
        drag(page, to_screen(page, 63.5, 47.5), to_screen(page, 53.5, 41.5))
        br = page.evaluate("state.geo.persp.br")
        check(f'{name}: dragging a corner sets its perspective offset',
              abs(br[0] - (53.5 - 64) / 64) < 0.02 and abs(br[1] - (41.5 - 48) / 48) < 0.02, br)
        page.click('#btn-undo')
        check(f'{name}: undo returns the perspective corner', page.evaluate("state.geo.persp.br[0] === 0"))
        page.keyboard.press('v')

        # ---- clone source marker ----
        page.click('#tab-fx')
        page.click('#retouch-add')
        page.click('#retouch-src')
        sx, sy = to_screen(page, 16, 24)
        page.mouse.click(sx, sy)
        page.click('#retouch-paint')
        marked = page.evaluate("""() => { const ov = document.getElementById('overlay'), g = ov.getContext('2d');
          const s = state.cloneSrc, d = g.getImageData(Math.max(0, s.x - 14), Math.max(0, s.y - 14), 28, 28).data;
          let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; }""")
        check(f'{name}: the clone source shows a marker on the canvas', marked > 10, marked)
        page.click('#retouch-paint')

        # ---- RGB histogram toggle ----
        check(f'{name}: RGB toggle starts off', page.get_attribute('#hist-mode', 'aria-pressed') == 'false')
        page.click('#hist-mode')
        check(f'{name}: RGB toggle turns on', page.get_attribute('#hist-mode', 'aria-pressed') == 'true' and page.evaluate("state.histRGB"))
        page.click('#hist-mode')

        # ---- phone header menu, and desktop shows the buttons inline ----
        if name == 'phone':
            check('phone: Reset all is hidden until More is opened', not page.is_visible('#btn-reset'))
            page.click('#more-btn')
            check('phone: More opens the menu', page.is_visible('#btn-reset') and page.get_attribute('#more-btn', 'aria-expanded') == 'true')
            page.click('#more-btn')
        else:
            check('desktop: Reset all is shown inline', page.is_visible('#btn-reset'))
            check('desktop: the More button is hidden', not page.is_visible('#more-btn'))

        # ---- project delete: two clicks ----
        page.keyboard.press('Control+s')
        page.wait_for_function("document.getElementById('status').textContent.startsWith('Saved')")
        page.wait_for_function("document.getElementById('project-select').options.length > 1")
        page.select_option('#project-select', index=1)
        n0 = page.evaluate("document.getElementById('project-select').options.length")
        page.click('#project-delete')
        check(f'{name}: first Delete asks to confirm', page.inner_text('#project-delete') == 'Confirm')
        page.click('#project-delete')
        page.wait_for_function(f"document.getElementById('project-select').options.length === {n0 - 1}")
        check(f'{name}: second Delete removes the saved project', page.evaluate("document.getElementById('project-select').options.length") == n0 - 1)

        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
