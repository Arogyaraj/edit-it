# Changelog

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
