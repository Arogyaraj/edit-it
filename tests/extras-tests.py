"""Tests for auto tone, tune copy/paste, clipping warning, help dialog, Delete and Ctrl+D.
Run: python3 tests/extras-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8770
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

DARK = os.path.join(TMP, 'edit-it-x-dark.png'); open(DARK, 'wb').write(png_rows(64, 48, lambda x, y: (60, 60, 60)))
WHITE = os.path.join(TMP, 'edit-it-x-white.png'); open(WHITE, 'wb').write(png_rows(64, 48, lambda x, y: (255, 255, 255)))
RED = os.path.join(TMP, 'edit-it-x-red.png'); open(RED, 'wb').write(png_rows(32, 32, lambda x, y: (255, 0, 0)))

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

        # auto tone lifts a dark, flat image
        page.set_input_files('#file-input', DARK)
        page.wait_for_function("!document.getElementById('view').hidden")
        before = px_at(page, 32, 24)[0]
        page.click('#tune-auto')
        bright = page.evaluate("state.layers[0].params.brightness")
        after = px_at(page, 32, 24)[0]
        check(f'{name}: auto tone sets a positive brightness for a dark image', bright > 0, bright)
        check(f'{name}: auto tone lifts the dark pixel', after >= before + 3 and after >= 62, (before, after))
        page.click('#btn-undo')
        check(f'{name}: undo restores the pre-auto tune', page.evaluate("state.layers[0].params.brightness") == 0)

        # tune copy and paste
        page.click('#tab-tune')
        set_range(page, 's-brightness', 30)
        page.click('#tune-copy')
        set_range(page, 's-brightness', 0)
        page.click('#tune-paste')
        check(f'{name}: paste tune restores the copied brightness', page.evaluate("state.layers[0].params.brightness") == 30)

        # clipping warning on a white image
        page.set_input_files('#file-input', WHITE)
        page.wait_for_function("document.getElementById('view').width === 64")
        page.wait_for_timeout(50)
        check(f'{name}: white is not red before clipping is on', px_at(page, 32, 24)[0] != 255 or px_at(page, 32, 24)[1] != 0, px_at(page, 32, 24))
        page.click('#clip-toggle')
        check(f'{name}: clipping on marks blown highlights red', px_at(page, 32, 24) == [255, 0, 0, 255], px_at(page, 32, 24))
        check(f'{name}: clipping button shows pressed', page.get_attribute('#clip-toggle', 'aria-pressed') == 'true')
        page.keyboard.press('j')
        check(f'{name}: J turns clipping off', px_at(page, 32, 24)[1] == 255 or px_at(page, 32, 24)[1] > 200, px_at(page, 32, 24))

        # help dialog
        page.keyboard.press('?')
        check(f'{name}: ? opens the shortcut help', page.evaluate("document.getElementById('help').open"))
        page.click('#help-close')
        check(f'{name}: help closes', not page.evaluate("document.getElementById('help').open"))

        # Delete and Ctrl+D on layers
        page.set_input_files('#add-input', RED)
        page.wait_for_function("document.querySelectorAll('#layer-list .lrow').length === 2")
        page.locator('#view').click()
        page.keyboard.press('Delete')
        check(f'{name}: Delete removes the selected layer', page.evaluate("state.layers.length") == 1, page.evaluate("state.layers.length"))
        page.keyboard.press('Control+d')
        check(f'{name}: Ctrl+D duplicates the selected layer', page.evaluate("state.layers.length") == 2)

        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
