"""Tests for shape and text layers, double exposure, lens blur, noise reduction, extra looks, inner shadow,
gradient overlay, drag to reorder, and layer thumbnails. Run: python3 tests/features-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8773
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

# A checkerboard by column: even columns 100, odd columns 160. Blurring pulls both towards the middle.
CHECK = os.path.join(TMP, 'edit-it-f-check.png')
open(CHECK, 'wb').write(png_rows(64, 48, lambda x, y: (100, 100, 100) if x % 2 == 0 else (160, 160, 160)))
RED = os.path.join(TMP, 'edit-it-f-red.png'); open(RED, 'wb').write(png_rows(32, 32, lambda x, y: (255, 0, 0)))
BLUE = os.path.join(TMP, 'edit-it-f-blue.png'); open(BLUE, 'wb').write(png_rows(32, 32, lambda x, y: (0, 0, 255)))

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
                  " el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }", [id, v])

def set_check(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.checked = v;"
                  " el.dispatchEvent(new Event('change')); }", [id, v])

def fresh(browser, vp):
    ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
    page = ctx.new_page()
    page.goto(URL)
    page.wait_for_function("document.getElementById('sliders').children.length === 6")
    page.set_input_files('#file-input', CHECK)
    page.wait_for_function("!document.getElementById('view').hidden")
    return ctx, page

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    except Exception as e:
        print('FAIL cannot launch chromium:', str(e).splitlines()[0]); sys.exit(2)

    for name, vp in [('desktop', (1280, 800)), ('phone', (390, 844))]:
        errors = []

        # ---- shape layer: a filled rectangle with the fill colour ----
        ctx, page = fresh(browser, vp)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.click('#tab-layers')
        page.click('#lay-add-shape')
        check(f'{name}: adding a rectangle shape creates a shape layer', page.evaluate("state.layers[1].type") == 'shape')
        inside = px(page, 32, 21)
        check(f'{name}: the rectangle paints its fill colour (143,176,255)', abs(inside[0] - 143) <= 2 and abs(inside[2] - 255) <= 2, inside)
        check(f'{name}: outside the rectangle is untouched', abs(px(page, 2, 2)[0] - 100) <= 2 or abs(px(page, 2, 2)[0] - 160) <= 2, px(page, 2, 2))
        ctx.close()

        # ---- text layer: red text draws red pixels in its box ----
        ctx, page = fresh(browser, vp)
        page.click('#tab-layers')
        page.click('#lay-add-text')
        set_value(page, 'text-content', 'HI')
        set_value(page, 'text-size', 30)
        set_value(page, 'text-color', '#ff0000')
        redish = page.evaluate("""() => { const c = document.getElementById('view'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) n++; return n; }""")
        check(f'{name}: text layer draws red text pixels', redish > 20, redish)
        check(f'{name}: text content is stored on the layer', page.evaluate("state.layers[1].text.content") == 'HI')
        ctx.close()

        # ---- double exposure: an added photo is screen-blended at 60% ----
        ctx, page = fresh(browser, vp)
        page.click('#tab-layers')
        page.click('#exp-double')
        page.set_input_files('#add-input', BLUE)
        page.wait_for_function("state.layers.length === 2")
        L = page.evaluate("state.layers[1]")
        check(f'{name}: double exposure uses screen blend at 60% opacity', L['blend'] == 'screen' and L['opacity'] == 60, (L['blend'], L['opacity']))
        check(f'{name}: double exposure is named for its photo', L['name'].startswith('Double exposure'))
        ctx.close()

        # ---- lens blur: sharp at the focus, blurred away from it ----
        ctx, page = fresh(browser, vp)
        page.click('#tab-fx')
        page.click('#fx-lensblur')
        focus = px(page, 32, 24)[0]
        # the blur leaves a small ripple, so average a run of pixels for the far side
        far = page.evaluate("""() => { const c = document.getElementById('view'), d = c.getContext('2d').getImageData(0, 22, 9, 1).data;
          let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]; return s / (d.length / 4); }""")
        check(f'{name}: lens blur keeps the focus sharp (within 3 of 100 or 160)', min(abs(focus - 100), abs(focus - 160)) <= 3, focus)
        check(f'{name}: lens blur softens the far side towards the middle (118-142)', 118 <= far <= 142, far)
        ctx.close()

        # ---- noise reduction: a hard edge softens ----
        ctx, page = fresh(browser, vp)
        page.click('#tab-layers')
        page.click('#lay-add-adjust')
        page.click('#tab-fx')
        check(f'{name}: checkerboard is sharp before noise reduction', px(page, 32, 24)[0] == 100)
        set_range(page, 'det-denoise', 100)
        check(f'{name}: noise reduction softens the checkerboard (>115)', px(page, 32, 24)[0] > 115, px(page, 32, 24))
        ctx.close()

        # ---- looks: sepia sets warmth and cuts saturation ----
        ctx, page = fresh(browser, vp)
        page.click('#tab-fx')
        page.click('#look-sepia')
        check(f'{name}: sepia look sets warmth to 40', page.evaluate("state.layers[0].params.warmth") == 40)
        ctx.close()

        # ---- inner shadow: the red layer darkens along its inside edges ----
        ctx, page = fresh(browser, vp)
        page.click('#tab-layers')
        page.set_input_files('#add-input', RED)
        page.wait_for_function("state.layers.length === 2")
        page.click('#tab-layers')
        set_check(page, 'fx-inner-on', True)
        set_value(page, 'fx-inner-opacity', 100)
        set_value(page, 'fx-inner-blur', 3)
        set_value(page, 'fx-inner-dist', 0)
        edge, middle = px(page, 17, 24)[0], px(page, 32, 24)[0]
        check(f'{name}: inner shadow darkens the inside edge of the red layer', middle == 255 and edge < 230, (edge, middle))
        ctx.close()

        # ---- gradient overlay: left dark, right light ----
        ctx, page = fresh(browser, vp)
        page.click('#tab-layers')
        page.set_input_files('#add-input', RED)
        page.wait_for_function("state.layers.length === 2")
        page.click('#tab-layers')
        set_check(page, 'fx-grad-on', True)
        set_value(page, 'fx-grad-angle', 0)
        set_value(page, 'fx-grad-opacity', 100)
        left, right = px(page, 18, 24)[0], px(page, 46, 24)[0]
        check(f'{name}: gradient overlay runs dark to light across the layer', right > left + 60, (left, right))
        ctx.close()

        # ---- drag to reorder, and thumbnails for each layer ----
        ctx, page = fresh(browser, vp)
        page.click('#tab-layers')
        page.set_input_files('#add-input', RED)
        page.wait_for_function("state.layers.length === 2")
        thumbs = page.evaluate("document.querySelectorAll('#layer-list canvas.thumb').length")
        check(f'{name}: each layer has a thumbnail', thumbs == 2, thumbs)
        # centre the rows in the panel first, so the sticky tab bar does not cover the drop target
        page.evaluate("document.querySelector('#layer-list').scrollIntoView({block: 'center'})")
        page.wait_for_timeout(400)   # let the panel's fade-in finish, so the rows are where the drag expects them
        page.locator('#layer-list .lrow', has_text='edit-it-f-red').drag_to(page.locator('#layer-list .lrow', has_text='edit-it-f-check'))
        check(f'{name}: dragging a row reorders the layers', page.evaluate("state.layers[0].name") == 'edit-it-f-red.png' or 'red' in page.evaluate("state.layers[0].name"), page.evaluate("state.layers.map(L=>L.name)"))
        ctx.close()

        check(f'{name}: no page errors', not errors, errors[:3])
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
