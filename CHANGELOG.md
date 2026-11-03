# Changelog

## 2.1.0

- Formats are detected from the file's contents, so a renamed file still opens.
- Opens JPEG, PNG, GIF, WebP, AVIF, BMP, ICO and SVG (the browser decodes them; SVG goes through the image element).
- HEIC: the app loads a decoder from `vendor/libheif/` when it is present. The adapter (`vendor/libheif/heic-decode.js`) is written for libheif-js's documented API. The decoder bundle itself is not in the package, so HEIC shows a clear message until you add it. The adapter has been tested with a stub decoder only, not with real HEIC files.
- TIFF and JPEG XL get a clear message. They are not decodable in browsers without a pure JavaScript decoder, which is not included.
- Clear messages for files that can't be opened, instead of a generic failure.

## 2.0.2

- Faster rendering: the GL result is copied straight to the accelerated 2D canvas, the view is no longer forced onto the CPU, and the GL canvas is resized only when its size changes.
- Pixel readback now happens only where a CPU filter needs it (the 256-pixel histogram, curves, sharpen, noise reduction, healing, auto tone) and, while clipping is on, for the clipping overlay. A normal render reads back only the histogram copy.
- A readback test counts pixel reads during renders, so this can't regress unnoticed.
- Still on the CPU: blend modes, masks, layer styles and the curve, sharpen and denoise filters run on the 2D canvas, which Chrome accelerates where it can. A full WebGL compositor is not in this release.

## 2.0.1

- Fixed: the clipping overlay and other pixel readbacks (clipping, curves, sharpen, heal, auto tone, histogram) now use canvases created with `willReadFrequently`. Chrome was copying those canvases from the GPU on every render and logged a performance warning.
- Added a console test that fails on that warning, so it can't come back unnoticed.
- Known: each tuned layer still copies its result from the GPU to the 2D canvas (`GPU stall due to ReadPixels` in Chrome's console). Keeping the whole composite on the GPU is planned.
- Note: "Unchecked runtime.lastError: The message port closed" comes from a browser extension, not from the app.

## 2.0.0

First full release of edit-it: a browser photo editor that runs entirely on the device.

### Editing
- Non-destructive: the original photo is never changed. Every edit is a layer, a setting or an undoable step.
- Tune: brightness, contrast, saturation, warmth, highlights, shadows. Auto tone, copy and paste tune, double-click to reset.
- Curves, Details (sharpen and noise reduction), Vignette, Selective adjustment, Looks (eight presets and your own), Lens blur.
- Crop, rotate, flip, straighten, perspective correction, aspect ratios, expand (solid or edge-extended), solid and Polaroid frames.
- Retouch: clone and heal (lighting-matched) brushes with a visible source point.

### Layers
- Image, adjustment, shape, text, retouch, lens blur and smart layers.
- Opacity, visibility, lock, 14 blend modes, masks (paint, gradient, invert), layer styles (drop shadow, glow, stroke, colour and gradient overlay, inner shadow, bevel and emboss, pattern overlay).
- Select several layers, batch edits, groups, drag to reorder, duplicate, merge down, rasterise, thumbnails.
- Smart layers: group layers, edit their contents as a working document, then press Done.
- On-canvas handles: move, scale and rotate layers, shapes and text; crop; straighten; perspective corners.

### Working with it
- Undo and redo over every change, including layers, masks and geometry. A history panel jumps to any step.
- Projects save to IndexedDB with autosave. Saved projects can be loaded or deleted.
- Export PNG or JPEG (quality slider) at full resolution.
- Zoom with the wheel, keys or pinch; pan with Space-drag; 100% and fit views.
- Clipping warning, histogram (luminance or RGB), before and after.
- Keyboard shortcuts and a built-in help guide (press ?).

### Mobile and install
- Bottom sheet on phones with a handle; landscape phones use the side panel.
- Touch-sized targets, larger canvas handles for fingers, safe-area padding.
- Installable as a PWA, works offline after the first visit, iPhone home-screen icons.

### Known limits
- HEIC photos can't be decoded in most browsers. Convert them first.
- Batch apply across photos, tiled export above the GPU texture limit, worker processing for the heavy filters, nested groups and group blend modes are not in 2.0.
- Shadow and glow use canvas blur, which older Safari versions don't support.
- PIN lock was deliberately left out.
