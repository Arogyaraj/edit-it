"""Tests for multi-select, batch edits, groups, layer styles (drop shadow), style copy/paste, delete/undo.
Run: python3 tests/layers-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8769
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

BASE = os.path.join(TMP, 'edit-it-l-gray.png'); open(BASE, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))
RED = os.path.join(TMP, 'edit-it-l-red.png'); open(RED, 'wb').write(png_rows(32, 32, lambda x, y: (255, 0, 0)))

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

def set_check(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.checked = v;"
                  " el.dispatchEvent(new Event('change')); }", [id, v])

def row(page, name):
    return page.locator('#layer-list .lrow', has_text=name).first

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
        page.set_input_files('#add-input', RED)
        page.wait_for_function("document.querySelectorAll('#layer-list .lrow').length === 2")
        page.click('#tab-layers')

        # selection: plain, ctrl-click, shift-click
        row(page, 'edit-it-l-red').click()
        row(page, 'edit-it-l-gray').click(modifiers=['Control'])
        check(f'{name}: ctrl-click adds a layer to the selection', page.evaluate("selectedLayers().length") == 2)
        row(page, 'edit-it-l-red').click()
        row(page, 'edit-it-l-gray').click(modifiers=['Shift'])
        check(f'{name}: shift-click selects the range', page.evaluate("selectedLayers().length") == 2)
        row(page, 'edit-it-l-red').click()
        check(f'{name}: plain click selects one', page.evaluate("selectedLayers().length") == 1)

        # batch opacity over two selected layers
        row(page, 'edit-it-l-gray').click(modifiers=['Control'])
        set_range(page, 'lay-opacity', 50)
        ops = page.evaluate("state.layers.map(L => L.opacity)")
        check(f'{name}: batch opacity applies to every selected layer', ops == [50, 50], ops)
        set_range(page, 'lay-opacity', 100)

        # batch tune: brightness on two selected layers
        set_range(page, 's-brightness', 25)
        bri = page.evaluate("state.layers.map(L => L.params.brightness)")
        check(f'{name}: batch tune applies to every selected layer', bri == [25, 25], bri)
        set_range(page, 's-brightness', 0)

        # groups: clicking one member selects the whole group
        page.click('#lay-group')
        check(f'{name}: group gives both layers a shared id', page.evaluate("state.layers[0].group && state.layers[0].group === state.layers[1].group"))
        row(page, 'edit-it-l-red').click()
        check(f'{name}: clicking a grouped layer selects its group', page.evaluate("selectedLayers().length") == 2)
        page.click('#lay-ungroup')
        check(f'{name}: ungroup clears the group', page.evaluate("state.layers.every(L => !L.group)"))

        # layer style: drop shadow under the red square (red spans x 16..48, shadow goes right and down)
        row(page, 'edit-it-l-red').click()
        check(f'{name}: pixel beside the red square is plain grey before the shadow', px_at(page, 51, 24)[0] == 128, px_at(page, 51, 24))
        set_check(page, 'fx-shadow-on', True)
        set_range(page, 'fx-shadow-dist', 10)
        set_range(page, 'fx-shadow-blur', 2)
        set_range(page, 'fx-shadow-opacity', 100)
        shadowed = px_at(page, 51, 24)[0]
        check(f'{name}: drop shadow darkens the pixel beside the square', shadowed < 110, shadowed)
        check(f'{name}: layer list shows the fx badge', page.locator('#layer-list', has_text='fx').count() >= 1)

        # copy and paste the style to the base layer
        page.click('#fx-copy')
        row(page, 'edit-it-l-gray').click()
        page.click('#fx-paste')
        check(f'{name}: pasted style turns the shadow on for the other layer', page.evaluate("state.layers[0].fx.shadow.on === true"))

        # delete the selected red layer, then undo
        row(page, 'edit-it-l-red').click()
        page.click('#lay-del')
        check(f'{name}: delete removes the selected layer', page.evaluate("state.layers.length") == 1)
        page.click('#btn-undo')
        check(f'{name}: undo restores the deleted layer', page.evaluate("state.layers.length") == 2)

        # select all with Ctrl+A
        page.locator('#view').click()
        page.keyboard.press('Control+a')
        check(f'{name}: ctrl+A selects every layer', page.evaluate("selectedLayers().length") == page.evaluate("state.layers.length"))

        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
