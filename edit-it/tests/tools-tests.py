"""Pixel tests for Straighten, Perspective, and Clone. Run: python3 tests/tools-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8767
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

GRAY = os.path.join(TMP, 'edit-it-t-gray.png')
open(GRAY, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))
HALVES = os.path.join(TMP, 'edit-it-t-halves.png')   # left half black, right half white
open(HALVES, 'wb').write(png_rows(64, 48, lambda x, y: (0, 0, 0) if x < 32 else (255, 255, 255)))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

def px_at(page, x, y):
    return page.evaluate("""([x, y]) => { const c = document.getElementById('view');
      return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data); }""", [x, y])

def set_range(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.value = v;"
                  " el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }", [id, str(v)])

def screen_of(page, dx, dy):
    """Document pixel -> screen point on the view canvas (view is 64x48 at default geometry)."""
    box = page.locator('#view').bounding_box()
    return box['x'] + (dx + 0.5) / 64 * box['width'], box['y'] + (dy + 0.5) / 48 * box['height']

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    except Exception as e:
        print('FAIL cannot launch chromium:', str(e).splitlines()[0]); sys.exit(2)

    for name, vp in [('phone', (360, 740)), ('tablet', (768, 1024)), ('desktop', (1280, 800))]:
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")

        # ---- Straighten: a uniform grey stays covered at every corner ----
        page.set_input_files('#file-input', GRAY)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-geo')
        set_range(page, 'str-angle', 10)
        corner = px_at(page, 0, 0)
        check(f'{name}: straighten 10 deg leaves no transparent corner', corner[3] == 255, corner)
        check(f'{name}: straighten keeps the grey centre (128)', abs(px_at(page, 32, 24)[0] - 128) <= 2)
        page.click('#geo-reset')
        check(f'{name}: reset geometry clears straighten angle', page.evaluate("state.geo.angle === 0"))

        # ---- Perspective: pushing the top-left source corner outside makes that output corner transparent ----
        set_range(page, 'per-tlx', -30)
        set_range(page, 'per-tly', -30)
        check(f'{name}: perspective pushes the top-left corner out (transparent)', px_at(page, 0, 0)[3] < 128, px_at(page, 0, 0))
        check(f'{name}: perspective keeps the centre (128)', abs(px_at(page, 32, 24)[0] - 128) <= 3, px_at(page, 32, 24))
        page.click('#geo-reset')
        check(f'{name}: reset clears perspective offsets', page.evaluate("state.geo.persp.tl[0] === 0 && state.geo.persp.tl[1] === 0"))

        # ---- Clone: copy the black half onto the white half, leaving pixels outside the brush alone ----
        page.set_input_files('#file-input', HALVES)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-fx')
        page.click('#retouch-add')
        check(f'{name}: retouch layer added', page.evaluate("document.querySelectorAll('#layer-list .lrow').length") == 2)
        page.click('#retouch-src')
        sx, sy = screen_of(page, 16, 24)
        page.mouse.click(sx, sy)
        check(f'{name}: clone source is set in app state', page.evaluate("state.cloneSrc !== null && !state.cloneSrcPending"))
        page.click('#retouch-paint')
        set_range(page, 'brush-size', 10)
        set_range(page, 'brush-hard', 100)
        before = px_at(page, 48, 24)
        check(f'{name}: destination starts white', before[0] > 240, before)
        dx, dy = screen_of(page, 48, 24)
        page.mouse.move(dx, dy); page.mouse.down(); page.mouse.move(dx + 1, dy + 1); page.mouse.up()
        after = px_at(page, 48, 24)
        check(f'{name}: cloning the black half paints black on the white half', after[0] < 30, after)
        check(f'{name}: pixels outside the brush stay white', px_at(page, 40, 24)[0] > 240, px_at(page, 40, 24))
        page.click('#btn-undo')
        check(f'{name}: undo of the clone stroke restores white', px_at(page, 48, 24)[0] > 240, px_at(page, 48, 24))

        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
