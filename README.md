# edit-it

A browser photo editor. Everything runs locally: photos and projects are stored in this browser's IndexedDB, and nothing is uploaded.

## User guide

### Quick start
1. Open a photo: click **Open**, drag it onto the page, or paste it (Ctrl/Cmd+V).
2. Adjust the photo in the inspector on the right (phones: the panel at the bottom). Start with the **Tune** tab.
3. Use the tools on the photo to move, crop, and straighten.
4. Click **Save** (Ctrl/Cmd+S) to save now. Projects also save about every three seconds.
5. Click **PNG** or **JPEG** to export at full resolution.

Your original photo is never changed. Every edit is a layer or an undoable step. Nothing leaves your device.

### The interface
Each inspector tab is a page with its own address (`#tune`, `#crop`, `#layers`, `#history`, `#effects`). Use the browser's back and forward buttons, the ‹ › arrows in the page header, or open a page directly from its link. Your photo and edits stay loaded while you move between pages.

- **Header**: Open, undo and redo, 100% zoom, Before (hold to see the original), saved projects, Save, JPEG quality, Export, Clipping, help (?), and Hide panel.
- **Histogram**: the luminance of the current picture. Press RGB to see the three channels together. It updates as you edit.
- **Pages** (tabs): Tune, Crop, Layers, History, Effects.
- **Toolbar on the photo**: Select, Move, Crop, Straighten, Perspective.
- **Status line** (bottom): tells you what just happened.

### Canvas tools
| Tool | Key | What it does |
| --- | --- | --- |
| Select | V | Default. Click a layer in the Layers tab to choose it. |
| Move | M | Drag an image layer to move it. Drag a corner to scale it, or the handle above it to rotate. Shift snaps rotation to 15°. Drag near the centre to snap to it. Arrow keys nudge one pixel (Shift for ten). |
| Crop | C | Drag the corners or edges, or drag inside to move the crop. The grid and size show while you work. Aspect presets hold their ratio. |
| Straighten | S | Drag along something that should be level, such as a horizon. The slope sets the angle, up to ±45°. |
| Perspective | P | Drag any of the four corners to correct keystone distortion. The dashed outline shows the source area. |

**Zoom and pan**: scroll the mouse wheel over the photo (or Ctrl/Cmd+wheel) to zoom. `+` and `-` zoom step by step, `0` returns to fit, and `1` shows 100%. Hold Space and drag to pan a zoomed photo. The zoom level shows in the corner of the canvas.

Clipping (J) shows blown highlights in red and crushed shadows in blue. Hold **Before**, or press \ to see the original.

### Adjusting the picture
- **Tune**: brightness, contrast, saturation, warmth, highlights, and shadows. Sliders change every selected layer. Double-click a slider to reset it.
- **Auto tone** sets brightness and contrast from the picture. **Copy tune** and **Paste tune** move settings between layers.
- **Crop & frame**: rotate, flip, straighten, correct perspective, set an aspect ratio, expand the canvas with a solid fill, and add a solid or Polaroid frame.
- **Effects**:
  - Vignette darkens the edges.
  - Curves sets five points, from shadows to highlights.
  - Details sharpen sharpens detail. Flat areas stay the same.
  - Selective adjusts only the area you tap. Set the radius and feather first.
  - Looks are presets (Warm, Cool, Matte, Black & white, Vivid). A look replaces the layer's tune values.
  - Retouch clone copies one part of the picture onto another. Set the source, then paint with the clone brush.

### Layers
- Add an image, an adjustment layer, or a retouch layer.
- Select layers with a click. Ctrl/Cmd-click adds or removes one, Shift-click selects a range, and Ctrl/Cmd+A selects all. Opacity, blend, visibility, lock, tune, duplicate, and delete apply to the whole selection.
- **Group** links the selected layers. Clicking any member selects the group.
- Each layer has a name, visibility, lock, opacity, and blend mode (14 modes). Image layers also have position, scale, and rotation.
- **Layer style**: drop shadow, outer glow, stroke, and colour overlay. Copy style and Paste style move them between layers.
- **Mask**: add a mask, or use a linear or radial gradient. Edit mask paints (reveals) or erases (hides). Invert flips the mask.
- The list shows badges for masks, styles, groups, hidden layers, and locked layers.

### Keyboard shortcuts
| Action | Keys |
| --- | --- |
| Undo / Redo | Ctrl/Cmd+Z / Shift+Ctrl/Cmd+Z |
| Save project | Ctrl/Cmd+S |
| Export PNG | Ctrl/Cmd+E |
| Select all layers | Ctrl/Cmd+A |
| Duplicate selected layers | Ctrl/Cmd+D |
| Delete selected layers | Delete or Backspace |
| Add or remove a layer from the selection | Ctrl/Cmd-click |
| Select a range of layers | Shift-click |
| Select / Move / Crop / Straighten | V / M / C / S |
| Clipping warning | J |
| Before and after | \ |
| Nudge the layer (Move tool) | Arrow keys (Shift for ten pixels) |
| Mask brush smaller / larger | [ / ] |
| Help | ? |

### Tips and troubleshooting
- Set Selective's radius and feather before you tap the photo.
- Clone copies from what is beneath the retouch layer, so set the source first.
- Looks replace the layer's tune values. You can adjust them afterwards.
- Shadows and glows need canvas blur. Older Safari versions show them without blur.
- HEIC photos don't open in most desktop browsers. Convert them to JPEG or PNG first.
- If the panel is in the way, use **Hide panel** in the header. On phones, Reset all and Help are under the ••• button.
- Clone shows a circle and crosshair at the source point, sized to the brush.
- **Delete** next to Load removes the selected saved project. It asks you to press it a second time to confirm.
- The app works offline after the first load. Install it from the browser menu to use it like an app.

## Run
Serve the folder over HTTP (the service worker needs http://localhost or HTTPS): `python3 -m http.server 8080`, then open http://localhost:8080. Opening index.html directly works for editing, but install and offline caching need HTTP.

## Included
- Mobile:
  - Portrait phones: the inspector is a bottom sheet with a handle. Tap the handle to hide or show it; the handle stays visible when the panel is hidden. The tab row and the photo keep their place as you scroll.
  - Touch targets: buttons, tabs, layer rows and sliders are sized for fingers (40–44 px). Canvas handles have a larger hit area for touch (22 px against 9 px for a mouse).
  - Landscape phones use the side-panel layout, the same as a desktop.
  - The header is one row that scrolls sideways. The tool bar scrolls sideways too, so every tool stays reachable.
  - Safe areas: the header, the toast and the zoom bar respect the notch and the home indicator.
  - iPhone home-screen support: an apple-touch-icon and the web-app meta tags, so the app opens full screen after "Add to Home Screen". Icons are PNG files, because iOS ignores SVG icons.
  - Phones and low-memory devices get a smaller preview (1536 px); exports always use full resolution.
  - Text fields use 16 px type, so iOS does not zoom when you tap them.
- Smart layers: Make smart puts the selected layers inside one layer. Edit contents opens those layers as a working document, with a banner and a Done button that writes the changes back. Unpack turns a smart layer back into its layers. Saving and exporting wait until you press Done. Undo works inside the edit, and the whole edit is one undo step in the parent document.
- Interface: icons on the header and tools, a floating zoom bar, toast messages for status, a spinner during merge, rasterise and save, coloured slider fills, card sections, a dot-grid canvas, and a one-row header on phones that scrolls sideways.
- Edge fill for Expand: choose Extend edges to stretch the photo's outer pixels into the new area, instead of a solid colour.
- Heal (Retouch): Clone brush with the Heal option. Heal copies the source and adjusts it to the lighting around the target, so a dark source doesn't leave a dark patch on a light area.
- Rotation for shape and text layers: drag the rotate handle, or set the angle on the layer.
- Rasterise: turns one shape, text, or retouch layer into an image layer, keeping its appearance, mask, and styles.
- Bevel and emboss: a light band along the top-left inside edges and a shade along the bottom-right.
- Pattern overlay: dots or diagonal stripes, with size, opacity, and colour.
- Pinch to zoom on touch screens: two fingers spread to zoom in and pinch together to zoom out. A second finger cancels a drag in progress.
- Custom looks: Save tune as look stores the selected layer's tune under a name in this browser (a separate store in IndexedDB). Apply sets it on the selected layers, and Delete removes it. Saved looks survive reloads.
- Merge down: merges the selected layer into the one beneath it, baking in its tune, masks and styles. The lower layer's blend mode and opacity carry over to the result. Undo restores both layers. This also rasterises shape and text layers when merged with a layer below.
- Shape and text handles: the Move tool drags shape and text layers, and a corner drag resizes them (shapes change width and height; text changes its size). Shape and text layers don't rotate yet.
- New layer types: shape layers (rectangle, ellipse, line, with fill, stroke, and size) and text layers (words, size, colour, font, bold). Position uses the X and Y sliders.
- Double exposure: adds a photo in screen blend at 60% opacity.
- Lens blur: blurs what lies beneath, leaving a focus area sharp. Set the focus position, focus size, and blur amount.
- Noise reduction (Effects, Details): softens fine noise on adjustment layers.
- Looks: Sepia, Cross process, and Film, alongside Warm, Cool, Matte, Black & white, and Vivid.
- Layer styles: inner shadow and gradient overlay, alongside shadow, glow, stroke, and colour overlay.
- Drag a layer row to reorder layers.
- Layer thumbnails: each row shows its image, or a colour swatch for shape, text, and adjustment layers.
- On-canvas tools (the toolbar on the photo, or V, M, C, S):
  - Select (V): the default. Mask, clone and tap-to-place tools still work.
  - Move (M): drag an image layer to move it, drag a corner to scale from its centre, drag the handle above it to rotate. Hold Shift while rotating to snap to 15°. Drag near the document centre to snap to it (a magenta guide shows). Arrow keys nudge one pixel, or 10 with Shift. Each drag is one undo step.
  - Crop (C): drag the corners and edges, or drag inside to move the crop. The rule-of-thirds grid and the crop size show while you work. Aspect presets hold their ratio. Edges follow the pointer exactly.
  - Straighten (S): drag along a horizon. Its slope becomes the angle (limited to ±45°), and the angle shows on the canvas.
  - The move, crop and straighten tools show the photo without expand and frame, so the handles line up with the image. The export still includes them.
- Layers can be rotated. Rotation is about each layer's centre, and styles and masks follow it.
- Auto tone (Tune tab): measures the unedited preview and sets brightness and contrast on the selected layers from the median and spread. Undoable.
- Copy tune and paste tune: move the Tune settings between layers.
- Clipping warning (J, or the Clipping button): blown highlights (any channel 254+) show red, and crushed shadows (all channels 1 or less) show blue. The overlay is for viewing only; it doesn't change the image or the histogram.
- Shortcut help (?): a dialog listing every shortcut.
- Delete or Backspace removes the selected layers. Ctrl/Cmd+D duplicates them.
- Layer selection: click selects one layer. Ctrl/Cmd-click toggles, Shift-click selects a range, and Ctrl/Cmd+A selects all.
- Batch edits on the selection: opacity, blend, visibility, lock, tune sliders, reset, duplicate, and delete. Locked layers are skipped by edits, but their lock can still be toggled. Move up and down need a single selected layer.
- Groups: Group gives the selected layers a shared group id. Clicking one member selects the whole group. Ungroup clears it. Groups are a selection tag only: they don't composite as a unit and can't be nested.
- Layer styles (image and retouch layers): drop shadow (blur, distance, opacity, colour), outer glow, stroke (width, colour), and colour overlay (opacity, colour). Styles are drawn under the layer's content, after its mask. Copy style, Paste style, and Clear style apply to the selection.
- Layer list badges: mask, fx (a style is on), group, hidden, locked.
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
- Layer styles are approximate: shadow and glow use canvas blur, which Safari supports only in newer versions. Stroke is a 16-direction offset, not a true outline.
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
- HEIC decoding. It needs a decoder library, which can't be fetched in this build environment. The app detects HEIC and asks you to convert it.
- Batch apply across several photos. The app works on one open document at a time, so batch apply needs a multi-document model first.
- Tiled export above the GPU texture limit. The app warns above about 16 MP and does not tile. Tiling needs the render pipeline to work region by region.
- Worker or OffscreenCanvas processing for the heavy filters (curves, sharpen, noise reduction). Only the histogram runs in a worker. The render pipeline is synchronous, so moving these needs an async render first.
- Smart objects (layers linked to an external source that can be edited and updated). This needs a source-linked layer model.
- Nested groups and group blend modes. Groups are selection tags only. Smart layers can contain other layers, but groups still don't composite as a unit.
- Satin and pattern styles beyond dots and stripes.
- PIN lock (deliberately excluded).

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
- Extras tests (auto tone, tune copy and paste, clipping, help dialog, Delete and Ctrl+D): `python3 tests/extras-tests.py`.
- Layer tests (selection, batch edits, groups, styles): `python3 tests/layers-tests.py`.
- Canvas tests (handles, crop, straighten, tool keys, nudging): `python3 tests/canvas-tests.py`.
- Pixel tests for Straighten, Perspective, and Clone: `python3 tests/tools-tests.py`.
- Not verified: real GPU drivers, iOS Safari limits, HEIC decoding, PWA installation on a device, and blend-mode output against a reference other than the browser's own compositor.

## Adding a tool (Tune pattern)
1. Add the parameter name to `SLIDERS` and `LABEL` in app.js.
2. Add `uniform float u_<name>;` to the fragment shader and apply it there.
3. Sliders, reset, history, save, and export pick it up automatically, because previews and exports share the same shader.

For a geometry control, add an entry to `GEO_CONTROLS`, a control in index.html, and handle it in `compose()`. For a layer property, add it to `LAYER_CONTROLS` and to `composite()`.
