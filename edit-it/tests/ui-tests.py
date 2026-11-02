"""Tests for the histogram worker, render coalescing and tune cache, zoom, before toggle, and shortcuts.
Run: python3 tests/ui-tests.py"""
import struct, zlib, threading, http.server, functools, os, sys, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8768
TMP = tempfile.gettempdir()

def png_rows(w, h, pixel):
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

GRAY = os.path.join(TMP, 'edit-it-u-gray.png')
open(GRAY, 'wb').write(png_rows(64, 48, lambda x, y: (128, 128, 128)))

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

def set_range(page, id, v):
    page.evaluate("([id, v]) => { const el = document.getElementById(id); el.value = v;"
                  " el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }", [id, str(v)])

MEAN_LUMA = """() => { const b = state.histLast.bins.subarray(768, 1024); let n = 0, s = 0;
  for (let i = 0; i < 256; i++) { n += b[i]; s += i * b[i]; } return s / n; }"""

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
        page.set_input_files('#file-input', GRAY)
        page.wait_for_function("!document.getElementById('view').hidden")

        # histogram from the worker: one luminance count per thumbnail pixel (64x48 here)
        page.wait_for_function("state.histLast !== null", timeout=5000)
        pixels = page.evaluate("state.histLast.pixels")
        check(f'{name}: histogram counts every thumbnail pixel', pixels == 64 * 48, pixels)
        mean0 = page.evaluate(MEAN_LUMA)
        check(f'{name}: histogram mean luma of grey is ~128', abs(mean0 - 128) <= 2, mean0)

        # the histogram follows edits
        set_range(page, 's-brightness', 60)
        page.wait_for_function(f"(() => {{ return ({MEAN_LUMA})() > {mean0 + 5}; }})()", timeout=5000)
        check(f'{name}: histogram updates after a brightness change', page.evaluate(MEAN_LUMA) > mean0 + 5)

        # tune cache: a repeated composite re-uses the layer's tuned result (no new GPU pass)
        draws = page.evaluate("state.stats.glDraws")
        hits = page.evaluate("state.stats.cacheHits")
        page.evaluate("render()")
        check(f'{name}: unchanged render does no GPU pass', page.evaluate("state.stats.glDraws") == draws,
              (draws, page.evaluate("state.stats.glDraws")))
        check(f'{name}: unchanged render hits the tune cache', page.evaluate("state.stats.cacheHits") > hits)

        # a change to the tune values does re-run the GPU pass
        set_range(page, 's-contrast', 20)
        check(f'{name}: a tune change runs the GPU pass again', page.evaluate("state.stats.glDraws") > draws)

        # before/after with the backslash key
        set_range(page, 's-brightness', 0)
        set_range(page, 's-contrast', 0)
        set_range(page, 's-brightness', 100)
        tuned_px = px(page)[0]
        page.keyboard.press('Backslash')
        check(f'{name}: backslash shows the original', abs(px(page)[0] - 128) <= 2, px(page))
        page.keyboard.press('Backslash')
        check(f'{name}: backslash again restores the edit', abs(px(page)[0] - tuned_px) <= 1, (px(page)[0], tuned_px))
        set_range(page, 's-brightness', 0)

        # zoom to 100%
        page.click('#zoom-toggle')
        check(f'{name}: zoom to 100% sets the actual class', page.evaluate("document.getElementById('view').classList.contains('actual')"))
        check(f'{name}: zoom button label flips to Fit', page.inner_text('#zoom-toggle') == 'Fit')
        page.click('#zoom-toggle')
        check(f'{name}: zoom back to fit clears the class', not page.evaluate("document.getElementById('view').classList.contains('actual')"))

        # Ctrl/Cmd+S saves
        page.keyboard.press('Control+s')
        page.wait_for_function("document.getElementById('status').textContent.startsWith('Saved')", timeout=5000)
        check(f'{name}: Ctrl+S saves the project', page.inner_text('#status').startswith('Saved'))

        # JPEG export honours the quality slider: smaller at lower quality
        set_range(page, 'export-quality', 50)
        with page.expect_download() as d1:
            page.click('#btn-export-jpeg')
        low = os.path.getsize(d1.value.path())
        set_range(page, 'export-quality', 100)
        with page.expect_download() as d2:
            page.click('#btn-export-jpeg')
        high = os.path.getsize(d2.value.path())
        check(f'{name}: JPEG quality 100 is larger than quality 50', high > low, (low, high))

        # sheet collapse moves the layout (desktop) and hides the panel
        page.click('#sheet-toggle')
        check(f'{name}: hide panel collapses the inspector', page.evaluate("document.body.classList.contains('panel-hidden')"))
        page.click('#sheet-toggle')

        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
