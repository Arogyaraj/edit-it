"""Mobile tests with real touch input (DevTools protocol): layout, handle, target sizes, touch dragging, landscape.
Run: python3 tests/mobile-tests.py"""
import threading, http.server, functools, os, sys, struct, zlib, tempfile
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PORT = 8779
TMP = tempfile.gettempdir()
def make_png(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
PHOTO = os.path.join(TMP, 'edit-it-mobile.png'); open(PHOTO, 'wb').write(make_png(64, 48, (128, 128, 128)))
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail != '' else ''))

def touch_drag(cdp, a, b, steps=6):
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': a[0], 'y': a[1], 'id': 1}]})
    for i in range(1, steps + 1):
        x = a[0] + (b[0] - a[0]) * i / steps; y = a[1] + (b[1] - a[1]) * i / steps
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y, 'id': 1}]})
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})

with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'])

    # ---- portrait phone ----
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("document.getElementById('sliders').children.length === 6")
    page.set_input_files('#file-input', PHOTO)
    page.wait_for_function("!document.getElementById('view').hidden")
    check('phone: the grabber handle is shown', page.is_visible('#grabber'))
    page.click('#grabber')
    check('phone: tapping the handle hides the panel', page.evaluate("document.getElementById('sheet').classList.contains('closed')"))
    page.click('#grabber')
    check('phone: tapping the handle again shows it', not page.evaluate("document.getElementById('sheet').classList.contains('closed')"))
    tab_h = page.evaluate("document.getElementById('tab-tune').getBoundingClientRect().height")
    check(f'phone: tab buttons are at least 40px tall for fingers ({tab_h:.0f}px)', tab_h >= 39, tab_h)
    slider_h = page.evaluate("document.getElementById('s-brightness').getBoundingClientRect().height")
    check(f'phone: sliders have a 34px touch area ({slider_h:.0f}px)', slider_h >= 33, slider_h)
    header_h = page.evaluate("document.querySelector('.top').getBoundingClientRect().height")
    check(f'phone: the header is a single row ({header_h:.0f}px tall)', header_h < 70, header_h)
    check('phone: the header scrolls sideways when it is too wide', page.evaluate("document.querySelector('.top').scrollWidth > document.querySelector('.top').clientWidth"))
    stage_h = page.evaluate("document.getElementById('stage').getBoundingClientRect().height")
    check(f'phone: the photo has most of the screen ({stage_h:.0f}px of 844)', stage_h > 330, stage_h)

    # touch drag moves a layer with the Move tool (a finger needs a bigger target than a mouse)
    page.click('#tool-move')
    hd = page.evaluate("layerHandles()")
    box = page.locator('#canvas-wrap').bounding_box()
    vw, vh = page.evaluate("[document.getElementById('view').width, document.getElementById('view').height]")
    def screen(dx, dy):
        return box['x'] + dx / vw * box['width'], box['y'] + dy / vh * box['height']
    x0 = page.evaluate("state.layers[0].x")
    cdp = ctx.new_cdp_session(page)
    sx, sy = screen(hd['box']['cx'], hd['box']['cy'])
    tx, ty = screen(hd['box']['cx'] + 8, hd['box']['cy'])
    touch_drag(cdp, (sx, sy), (tx, ty))
    x1 = page.evaluate("state.layers[0].x")
    check(f'phone: dragging by touch moves the layer (+0.125 of the width)', abs((x1 - x0) - 8 / 64) < 0.02, (x0, x1))
    check('phone: no page errors', not errors, errors[:3])
    ctx.close()

    # ---- landscape phone uses the side panel ----
    ctx = browser.new_context(viewport={'width': 844, 'height': 390}, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.goto(URL)
    page.wait_for_function("document.getElementById('sliders').children.length === 6")
    stage = page.locator('#stage').bounding_box()
    sheet = page.locator('#sheet').bounding_box()
    check('landscape phone: the panel sits beside the photo', sheet['x'] >= stage['x'] + stage['width'] - 2, (stage, sheet))
    check('landscape phone: the grabber is hidden', not page.is_visible('#grabber'))
    ctx.close()
    browser.close()

print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
