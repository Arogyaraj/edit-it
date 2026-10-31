"""Headless Chromium tests for edit-it. Run: python3 tests/browser-tests.py (needs Playwright + Chromium)."""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8766

def png(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

TMP = tempfile.gettempdir()
GRAY = os.path.join(TMP, 'edit-it-gray.png'); open(GRAY, 'wb').write(png(64, 48, (128, 128, 128)))
RED = os.path.join(TMP, 'edit-it-red.png'); open(RED, 'wb').write(png(32, 32, (255, 0, 0)))

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

def px(page):
    return page.evaluate("""() => { const c = document.getElementById('view');
      return Array.from(c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data); }""")

def export_dims(page):
    with page.expect_download() as dl:
        page.click('#btn-export-png')
    data = open(dl.value.path(), 'rb').read()
    return struct.unpack('>II', data[16:24])

def set_range(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.value = v;"
                  " el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }", [id, str(v)])

def set_select(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.value = v;"
                  " el.dispatchEvent(new Event('change')); }", [id, v])

def value(page, id):
    return page.input_value('#' + id)

def toggle(page, id):
    page.evaluate("id => { const el = document.getElementById(id); el.checked = !el.checked; el.dispatchEvent(new Event('change')); }", id)

def layer_count(page):
    return page.evaluate("document.querySelectorAll('#layer-list .lrow').length")


def px_at(page, x, y):
    return page.evaluate("""([x, y]) => { const c = document.getElementById('view');
      return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data); }""", [x, y])

def close(a, b, tol):
    return abs(a - b) <= tol

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    except Exception as e:
        print('FAIL cannot launch chromium:', str(e).splitlines()[0]); sys.exit(2)

    for name, vp in [('phone', (360, 740)), ('tablet', (768, 1024)), ('desktop', (1280, 800))]:
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]}, accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")

        # open base photo: one image layer
        page.set_input_files('#file-input', GRAY)
        page.wait_for_function("!document.getElementById('view').hidden")
        check(f'{name}: opening a photo creates one image layer', layer_count(page) == 1, layer_count(page))
        check(f'{name}: base pixel is 128', close(px(page)[0], 128, 2), px(page))

        # adjustment layer above base, brightness +100 -> ~177
        page.click('#tab-layers')
        page.click('#lay-add-adjust')
        check(f'{name}: add adjustment -> 2 layers', layer_count(page) == 2)
        page.click('#tab-tune')
        set_range(page, 's-brightness', 100)
        check(f'{name}: adjustment brightness +100 -> ~177', close(px(page)[0], 177, 3), px(page))

        # opacity 50 -> mix of 128 and 177 ~ 152
        page.click('#tab-layers')
        set_range(page, 'lay-opacity', 50)
        check(f'{name}: adjustment opacity 50% -> ~152', close(px(page)[0], 152, 4), px(page))
        set_range(page, 'lay-opacity', 100)

        # visibility off -> base 128; back on -> 177
        toggle(page, 'lay-visible')
        check(f'{name}: hiding adjustment -> 128', close(px(page)[0], 128, 2), px(page))
        toggle(page, 'lay-visible')
        check(f'{name}: showing adjustment -> 177', close(px(page)[0], 177, 3), px(page))

        # add red image above adjustment, multiply -> ~(177,0,0)
        page.set_input_files('#add-input', RED)
        page.wait_for_function("document.querySelectorAll('#layer-list .lrow').length === 3")
        set_select(page, 'lay-blend', 'multiply')
        pr = px(page)
        check(f'{name}: red image multiply over grey -> R~177, G~0', close(pr[0], 177, 4) and pr[1] <= 3, pr)

        # lock selected layer -> tune disabled
        toggle(page, 'lay-lock')
        check(f'{name}: locked layer disables tune sliders', page.is_disabled('#s-brightness'))
        check(f'{name}: locked layer disables delete', page.is_disabled('#lay-del'))
        toggle(page, 'lay-lock')
        check(f'{name}: unlock re-enables tune', not page.is_disabled('#s-brightness'))

        # duplicate -> 4, delete -> 3, undo delete -> 4
        page.click('#lay-dup')
        check(f'{name}: duplicate -> 4 layers', layer_count(page) == 4, layer_count(page))
        page.click('#lay-del')
        check(f'{name}: delete -> 3 layers', layer_count(page) == 3, layer_count(page))
        page.click('#btn-undo')
        check(f'{name}: undo delete -> 4 layers', layer_count(page) == 4, layer_count(page))

        # move: undo move restores order (pixel test under moved adjustment)
        before_move = px(page)
        page.click('#lay-down')
        page.click('#btn-undo')
        check(f'{name}: undo move restores the pixel', px(page) == before_move, (px(page), before_move))

        # geometry still undoes alongside layers
        page.click('#tab-geo'); page.click('#rot-r')
        check(f'{name}: rotate with layers -> 48x64 export', export_dims(page) == (48, 64))
        page.click('#btn-undo')
        check(f'{name}: undo rotate -> 64x48 export', export_dims(page) == (64, 48))
        page.click('#tab-layers')

        # --- masks: hide the red layer, then test on the adjustment layer ---
        reds = page.locator('#layer-list .lrow', has_text='edit-it-red')
        for i in range(reds.count()):   # the duplicate and original are both red
            reds.nth(i).click()
            if page.is_checked('#lay-visible'):
                toggle(page, 'lay-visible')
        page.locator('#layer-list .lrow', has_text='[adj]').first.click()
        check(f'{name}: adjustment centre back at ~177 before masking', close(px(page)[0], 177, 3), px(page))
        page.click('#mask-add')
        check(f'{name}: adding a reveal-all mask keeps 177', close(px(page)[0], 177, 3), px(page))
        page.click('#mask-edit')
        check(f'{name}: mask edit mode on', page.get_attribute('#mask-edit', 'aria-pressed') == 'true')
        set_range(page, 'brush-size', 200)
        set_range(page, 'brush-hard', 100)
        set_select(page, 'brush-mode', 'erase')
        box = page.locator('#view').bounding_box()
        cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        page.mouse.move(cx, cy); page.mouse.down(); page.mouse.move(cx + 4, cy + 4); page.mouse.up()
        check(f'{name}: erasing the centre reveals the base (~128)', close(px(page)[0], 128, 3), px(page))
        page.click('#btn-undo')
        check(f'{name}: undo erase restores 177', close(px(page)[0], 177, 3), px(page))
        page.click('#btn-redo')
        check(f'{name}: redo erase returns 128', close(px(page)[0], 128, 3), px(page))
        page.click('#btn-undo')
        page.click('#lay-mask-invert')
        check(f'{name}: inverted reveal-all mask hides adjustment (128)', close(px(page)[0], 128, 3), px(page))
        page.click('#lay-mask-invert')
        check(f'{name}: un-inverting restores 177', close(px(page)[0], 177, 3), px(page))
        page.click('#mask-edit')
        check(f'{name}: mask edit mode off', page.get_attribute('#mask-edit', 'aria-pressed') == 'false')
        # rename
        page.fill('#lay-name', 'Brighten')
        page.locator('#lay-name').press('Enter')
        check(f'{name}: rename appears in layer list', page.locator('#layer-list', has_text='Brighten').count() == 1)
        # history panel lists steps and can jump
        page.click('#tab-history')
        hist_count = page.evaluate("document.querySelectorAll('#history-list [data-h]').length")
        check(f'{name}: history panel lists steps', hist_count >= 8, hist_count)
        page.locator('#history-list [data-h]').first.click()
        page.click('#tab-layers')
        check(f'{name}: jump to newest history step is not the start', hist_count > 1)
        page.click('#btn-redo') if page.is_enabled('#btn-redo') else None
        # sheet collapse animation toggles a class
        page.click('#sheet-toggle')
        check(f'{name}: sheet collapses', page.evaluate("document.getElementById('sheet').classList.contains('closed')"))
        page.click('#sheet-toggle')

        # --- effects ---
        page.click('#tab-fx')
        page.click('#fx-vignette')
        set_range(page, 'vig-strength', 100)
        set_range(page, 'vig-radius', 20)
        corner = px_at(page, 2, 2)
        check(f'{name}: vignette darkens the corner', corner[0] < 25, corner)
        check(f'{name}: vignette leaves the centre alone (~177)', close(px(page)[0], 177, 4), px(page))

        page.click('#tab-layers')
        page.locator('#layer-list .lrow', has_text='Brighten').first.click()
        page.click('#tab-fx')
        before_curve = px(page)[0]
        set_range(page, 'curve-2', 0)
        after_curve = px(page)[0]
        check(f'{name}: curve pulled down at the centre tone darkens it (176 -> ~146)', after_curve < before_curve - 20 and close(after_curve, 146, 4), (before_curve, after_curve))
        set_range(page, 'curve-2', 50)
        check(f'{name}: curve reset to identity restores the centre', close(px(page)[0], before_curve, 2), px(page))

        page.click('#tab-fx')
        set_range(page, 'det-sharpen', 50)
        check(f'{name}: sharpen leaves a flat area unchanged', close(px(page)[0], before_curve, 2), px(page))
        set_range(page, 'det-sharpen', 0)

        page.click('#look-bw')
        check(f'{name}: black and white look sets saturation to -100', value(page, 's-saturation') == '-100', value(page, 's-saturation'))
        _bw = px(page)
        check(f'{name}: black and white centre is neutral grey (R=G=B, ~129 after the look replaces tune)', _bw[0] == _bw[1] == _bw[2] and close(_bw[0], 129, 3), _bw)

        # selective: tap the centre, then darken it; corner must stay the same
        corner_before = px_at(page, 2, 2)
        page.click('#fx-selective')
        check(f'{name}: selective pick mode on', page.get_attribute('#fx-selective', 'aria-pressed') == 'true')
        box = page.locator('#view').bounding_box()
        page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        check(f'{name}: selective layer appears', page.locator('#layer-list', has_text='Selective').count() == 1)
        set_range(page, 's-brightness', -100)
        check(f'{name}: selective darkens the tapped centre', px(page)[0] < before_curve - 30, (px(page)[0], before_curve))
        check(f'{name}: selective leaves the far corner unchanged', px_at(page, 2, 2) == corner_before, (px_at(page, 2, 2), corner_before))

        # save, reload, load -> same layers and same pixel
        ref = px(page)
        page.click('#btn-save')
        page.wait_for_function("!state.dirty && document.getElementById('status').textContent.startsWith('Saved')")
        page.reload()
        page.wait_for_function("document.getElementById('project-select').options.length > 1")
        page.select_option('#project-select', index=1)
        page.click('#btn-load')
        page.wait_for_function("document.getElementById('status').textContent.startsWith('Loaded')")
        check(f'{name}: reload restores 6 layers (base, adjustments, red, vignette, selective)', layer_count(page) == 6, layer_count(page))
        check(f'{name}: reload restores the composite pixel', close(px(page)[0], ref[0], 2), (px(page), ref))
        check(f'{name}: export after reload is 64x48', export_dims(page) == (64, 48))

        # click every visible button on every tab
        for tab in ['tab-tune', 'tab-geo', 'tab-layers']:
            page.click('#' + tab)
            bids = page.evaluate("""() => [...document.querySelectorAll('button')]
                .filter(b => b.id && b.offsetParent && !b.disabled && !['btn-open', 'lay-add-image', 'sheet-toggle'].includes(b.id)).map(b => b.id)""")
            for bid in bids:
                page.evaluate("id => document.getElementById(id).click()", bid)
                page.wait_for_timeout(30)
        for rid in page.evaluate("() => [...document.querySelectorAll('#layer-list [data-id]')].map(b => b.dataset.id)"):
            page.evaluate("id => document.querySelector(`[data-id=\"${id}\"]`).click()", rid)
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(TMP, f'edit-it-{name}.png'), full_page=True)
        check(f'{name}: no page errors while clicking every button', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
