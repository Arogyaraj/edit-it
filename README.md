# edit-it

A browser photo editor. Everything runs locally: photos and projects are stored in this browser's IndexedDB, and nothing is uploaded.

## Run
Serve the folder over HTTP (the service worker needs http://localhost or HTTPS): `python3 -m http.server 8080`, then open http://localhost:8080. Opening index.html directly works for editing, but install and offline caching need HTTP.

## Included
- Layout: a Lightroom-style workspace. The inspector sits on the right on desktop and becomes a bottom sheet on phones. "Hide panel" gives the photo the full width.
- Histogram: luminance, computed in a Web Worker (hist-worker.js) from a 256px copy of the preview, and updated after every change.
- Zoom: "100%" shows the photo at actual pixels, scrollable. "Fit" returns to fit-to-screen.
- JPEG quality slider in the header.
- Keyboard: `\` toggles before/after, Ctrl/Cmd+S saves, Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z undo and redo, Ctrl/Cmd+E exports PNG, `[` and `]` change the mask brush size.
- Efficiency:
  - Slider drags and brush strokes are coalesced to one render per animation frame. Discrete actions render immediately and cancel any queued frame.
  - Each image layer's tuned output is cached until its own asset or tune values change. Editing other layers or masks does not repeat its GPU pass. The `state.stats` counters (glDraws, cacheHits) show this.
  - Cache entries for deleted layers are released with the other memory.
  - Saves run in order, so an older autosave can't overwrite a newer one.
- Interface: a dark, quiet layout. Tabs are a segmented control, sliders and buttons are restyled, and the photo sits on a checkerboard so transparency shows. It collapses to the bottom with the Hide button and works from 360px phones up.
- Open, drop, or paste a photo. Drop or paste adds a layer when a document is already open. EXIF orientation is applied.
- Preview is capped at 2048px on the long side. Export composites the full-resolution layers.
- Layers:
  - Image layers and adjustment layers. Adjustment layers apply the Tune settings to everything beneath them.
  - Each layer has visibility, opacity, lock, and one of 14 blend modes (normal, multiply, screen, overlay, soft light, hard light, colour dodge, colour burn, difference, exclusion, hue, saturation, colour, luminosity).
  - Image layers have numeric position and scale (percent of the document).
  - Add image, add adjustment, duplicate, delete, move up, and move down. Locked layers can't be tuned, moved, duplicated, or deleted.
- Tune: brightness, contrast, saturation, warmth, highlights, shadows, applied to the selected layer. Each slider has a reset button, and double-click resets it. The shader runs in linear light and converts back to sRGB at the end.
- Crop & frame, applied to the whole composite:
  - Rotate in 90° steps, flip horizontal and vertical.
  - Crop by X, Y, width, and height, with aspect presets (Free, Original, 1:1, 4:5, 3:2, 16:9).
  - Expand per side (0–50%) with a solid fill.
  - Solid or Polaroid frames with width and colour.
- Layer masks: add a reveal-all mask, linear or radial gradient masks, invert, remove. Edit mode paints or erases with a brush (size, hardness, paint or erase mode; [ and ] change size). Masks are document-resolution and scale up for export.
- Layer rename.
- Geometry additions:
  - Straighten: a fine rotation from -45° to 45°. The image is scaled up so no transparent corner shows.
  - Perspective: eight corner-offset sliders (±30% of the image) drive a homography warp with nearest-neighbour sampling.
- Retouch (Effects tab): add a retouch layer, set a clone source by tapping the image, then paint with the clone brush. Clone copies the composite beneath the layer, aligned to the source offset. Brush size and hardness are shared with the mask brush.
- Effects tab:
  - Vignette: a radial darkening layer with strength, clear radius, and centre.
  - Curves: five-point tone curve on adjustment layers, applied through a 256-entry lookup table.
  - Details: sharpen (unsharp mask) on adjustment layers. Flat areas are unchanged.
  - Selective Adjust: tap the image to place an adjustment layer with a radial mask. Radius and feather are set before tapping.
  - Looks: five presets (Warm, Cool, Matte, Black & white, Vivid). A look replaces the selected layer's tune values.
- History panel: every step, labelled, click to jump. Undo and redo work the same list. The list is capped at 200 steps.
- Memory: bitmaps and masks that no history step or layer refers to are released after each change.
- The sheet collapses and expands with a short animation (Hide / Show).
- Hold "Before" to see the original, with no tuning, masks, or geometry.
- Undo and redo cover layers (contents, order, visibility, lock, blend, opacity, position) and geometry. Selection is not undoable (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z).
- Projects save to IndexedDB with the original files, the layer structure, and the edit history. Autosave runs about every 3 seconds. Load restores layers, geometry, and undo history.
- Export PNG or JPEG at full resolution. Ctrl/Cmd+E exports PNG.
- Installable PWA. The service worker caches the app shell cache-first.

## Not yet built
- Text and shape layers (rectangle, ellipse, line, polygon). Rasterise.
- Groups, drag-to-reorder, merge down.
- On-canvas move, scale, and rotate handles with snapping. Position is set with numeric sliders.
- Mask edit is in document space: geometry (crop, frame, expand) is hidden while editing masks.
- Custom gradient angle and centre. Gradients are top-to-bottom and centre-out.
- Healing (lighting and texture matching). Clone is built; Healing is not.
- Double Exposure, Lens Blur, Text, Expand's generated fill, the Details noise reduction, and the filters beyond Black & white.
- On-canvas perspective handles. Perspective is set with sliders.
- Clone source marker on the canvas.
- On-canvas crop handles. Crop is set with numeric sliders.
- Worker or OffscreenCanvas processing. Everything runs on the main thread.
- Tiled export above the GPU texture limit. The app warns above about 16 MP and does not tile.
- Batch apply, pinch and rotate gestures, and further keyboard shortcuts.
- Worker or OffscreenCanvas processing for curves, sharpen, and tune. Only the histogram runs in a worker.
- Measured frame timings. The efficiency work is verified by counters, not by benchmarks.
- HEIC decoding. The app detects HEIC and asks you to convert it.
- PIN lock.

## Known limits of the model
- Blending is done in the browser's compositing space (sRGB), not in linear light. Only the tune step is linear.
- An adjustment layer's opacity mixes its result with the layers beneath it, but it doesn't use an alpha mask.
- Projects saved by the earlier single-photo build can't be opened by this build.
- Mask painting on very large documents may be slow. Strokes are re-composited on every pointer move.

## Browser support
Needs WebGL 2 and `createImageBitmap` with `imageOrientation`. Targets current Chrome, Edge, and Firefox, and Safari 16.4 or later. Without WebGL 2 the photo still shows, geometry and layers still work, and colour adjustments are disabled.

## Tests
- `node --check app.js` and `node tests/check-ids.js` (static; the second confirms every DOM id used by the script exists in index.html).
- `python3 tests/browser-tests.py` (needs Playwright with Chromium). It checks:
  - Colour pixel math against known values.
  - Layer behaviour: adjustment brightness and opacity, visibility, a multiply blend, lock, duplicate and delete.
  - Masks: reveal-all mask, erase stroke, undo and redo of the stroke, invert, and un-invert.
  - Rename, history panel jump, and the sheet collapse.
  - Undo for layers and geometry.
  - Save and reload, including the composite pixel.
  - Export dimensions.
  - That clicking every visible button raises no page error.
- The button sweep dispatches clicks inside the page. It checks handlers, not Playwright's hit-testing.
- Pixel tests for Straighten, Perspective, and Clone: `python3 tests/tools-tests.py`.
- Not verified: real GPU drivers, iOS Safari limits, HEIC decoding, PWA installation on a device, and blend-mode output against a reference other than the browser's own compositor.

## Adding a tool (Tune pattern)
1. Add the parameter name to `SLIDERS` and `LABEL` in app.js.
2. Add `uniform float u_<name>;` to the fragment shader and apply it there.
3. Sliders, reset, history, save, and export pick it up automatically, because previews and exports share the same shader.

For a geometry control, add an entry to `GEO_CONTROLS`, a control in index.html, and handle it in `compose()`. For a layer property, add it to `LAYER_CONTROLS` and to `composite()`.
