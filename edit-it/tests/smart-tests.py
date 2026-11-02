"""Tests for smart layers: make, edit contents and Done, undo, unpack, saving reload, and the editing guards.
Run: python3 tests/smart-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8777
TMP = tempfile.gettempdir()
def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
GREY = os.path.join(TMP, 'edit-it-s-grey.png'); open(GREY, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))
RED = os.path.join(TMP, 'edit-it-s-red.png'); open(RED, 'wb').write(png_rows(32, 32, lambda x, y: (255, 0, 0)))

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

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    for name, vp in [('desktop', (1280, 800)), ('phone', (390, 844))]:
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]}, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")
        page.set_input_files('#file-input', GREY)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-layers')
        page.set_input_files('#add-input', RED)
        page.wait_for_function("state.layers.length === 2")
        before = px(page, 32, 24)

        # make a smart layer from both layers: the picture does not change
        page.keyboard.press('Control+a')
        page.click('#lay-make-smart')
        check(f'{name}: making a smart layer leaves one layer of type smart', page.evaluate("state.layers.length === 1 && state.layers[0].type === 'smart'"))
        check(f'{name}: the picture is unchanged by making it smart', px(page, 32, 24) == before, (before, px(page, 32, 24)))

        # edit the contents: hide the red child, press Done; the parent updates
        page.click('#smart-edit')
        check(f'{name}: editing shows the banner', page.is_visible('#smart-banner'))
        check(f'{name}: the working document holds the two child layers', page.evaluate("state.layers.length") == 2)
        page.keyboard.press('Control+s')
        check(f'{name}: saving is refused while editing', 'Press Done' in page.inner_text('#status'), page.inner_text('#status'))
        page.locator('#layer-list .lrow', has_text='edit-it-s-red').click()
        set_range(page, 'lay-opacity', 0)
        page.click('#smart-done')
        check(f'{name}: Done hides the banner', not page.is_visible('#smart-banner'))
        check(f'{name}: Done writes the change into the smart layer (red hidden, so grey)', abs(px(page, 32, 24)[0] - 128) <= 2, px(page, 32, 24))
        page.click('#btn-undo')
        check(f'{name}: undo brings the red layer back inside the smart layer', px(page, 32, 24) == before, px(page, 32, 24))

        # unpack restores the two layers
        page.click('#smart-unpack')
        check(f'{name}: unpack restores the layers', page.evaluate("state.layers.length === 2 && state.layers.every(L => L.type !== 'smart')"))

        # save and reload keeps the smart layer
        page.set_input_files('#file-input', GREY)
        page.wait_for_function("!document.getElementById('view').hidden")
        page.click('#tab-layers')
        page.set_input_files('#add-input', RED)
        page.wait_for_function("state.layers.length === 2")
        page.keyboard.press('Control+a')
        page.click('#lay-make-smart')
        ref = px(page, 32, 24)
        page.keyboard.press('Control+s')
        page.wait_for_function("document.getElementById('status').textContent.startsWith('Saved')")
        page.reload()
        page.wait_for_function("document.getElementById('project-select').options.length > 1")
        page.select_option('#project-select', index=1)
        page.click('#btn-load')
        page.wait_for_function("document.getElementById('status').textContent.startsWith('Loaded')")
        check(f'{name}: a saved smart layer reloads as a smart layer', page.evaluate("state.layers.length === 1 && state.layers[0].type === 'smart'"))
        check(f'{name}: the reloaded picture matches', px(page, 32, 24) == ref, (ref, px(page, 32, 24)))
        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
