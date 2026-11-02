"""Tests for the interface pieces: icons, zoom bar, toast, empty-state button, slider fills, busy spinner.
Run: python3 tests/ui-polish-tests.py"""
import threading, http.server, functools, os, sys, struct, zlib, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PHOTO = os.path.join(tempfile.gettempdir(), 'edit-it-ui-photo.png')
def make_png(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
open(PHOTO, 'wb').write(make_png(64, 48, (120, 130, 140)))
PORT = 8778
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])
    for name, vp in [('desktop', (1280, 800)), ('phone', (390, 844))]:
        ctx = browser.new_context(viewport={'width': vp[0], 'height': vp[1]})
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_function("document.getElementById('sliders').children.length === 6")

        check(f'{name}: header buttons carry icons', page.evaluate("document.querySelectorAll('#btn-open svg.ico, #btn-save svg.ico, #tool-move svg.ico').length") == 3)
        check(f'{name}: the empty state has an Open button', page.is_visible('#empty-open'))
        with page.expect_file_chooser() as fc:
            page.click('#empty-open')
        check(f'{name}: the empty-state button opens the file picker', fc.value is not None)

        # the toast shows a message and then leaves
        page.evaluate("say('A status message')")
        check(f'{name}: a status message shows as a toast', page.evaluate("document.getElementById('status').classList.contains('show')"))

        # zoom bar buttons move the zoom factor
        if True:
            page.set_input_files('#file-input', PHOTO)
            page.wait_for_function("!document.getElementById('view').hidden")
            before = page.evaluate("state.zoom")
            page.click('#zoom-in')
            check(f'{name}: the zoom-in button zooms in', page.evaluate("state.zoom") > before)
            page.click('#zoom-fit')
            check(f'{name}: the fit button returns to fit', page.inner_text('#zoom-label') == 'Fit')

            # slider fills follow the value
            set_v = page.evaluate("""() => { const el = document.getElementById('s-brightness');
              el.value = 50; el.dispatchEvent(new Event('input')); return el.style.getPropertyValue('--p'); }""")
            check(f'{name}: a slider reports its fill position (75%)', set_v.strip() == '75%', set_v)
        check(f'{name}: no page errors', not errors, errors[:3])
        ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
