'use strict';
const SLIDERS = ['brightness', 'contrast', 'saturation', 'warmth', 'highlights', 'shadows'];
const LABEL = { brightness: 'Brightness', contrast: 'Contrast', saturation: 'Saturation', warmth: 'Warmth', highlights: 'Highlights', shadows: 'Shadows' };
const MAX_WORK = 2048;
const MAX_HISTORY = 200;
const ASPECTS = { '1:1': 1, '4:5': 0.8, '3:2': 1.5, '16:9': 16 / 9 };
const BLEND = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  'soft-light': 'soft-light', 'hard-light': 'hard-light', 'color-dodge': 'color-dodge', 'color-burn': 'color-burn',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };

const zeros = () => Object.fromEntries(SLIDERS.map(k => [k, 0]));
const fullCrop = () => ({ x: 0, y: 0, w: 1, h: 1 });
const defaultGeo = () => ({
  rot: 0, flipH: false, flipV: false, crop: fullCrop(), aspect: 'free',
  expand: { t: 0, r: 0, b: 0, l: 0 }, expandColor: '#ffffff',
  frame: 'none', frameWidth: 5, frameColor: '#ffffff',
  angle: 0, persp: { tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] }
});
const clone = o => JSON.parse(JSON.stringify(o));
const dimsFor = (rot, w, h) => (rot % 180 ? [h, w] : [w, h]);
let idCounter = 0;
const newId = p => p + Date.now().toString(36) + (idCounter++);

// Document model. Layers are bottom (index 0) to top. Bitmaps live in state.assets and masks in
// state.masks; both are immutable once created, so history snapshots only hold ids and metadata.
const state = {
  doc: null, docName: '', assets: new Map(), masks: new Map(), layers: [], geo: defaultGeo(), selectedId: null,
  history: [], hIndex: 0, projectId: null, dirty: false, gl: null, glCanvas: null,
  maskMode: false, pickMode: false, cloneMode: false, cloneSrcPending: false, cloneSrc: null, live: null,
  tool: 'select', guides: { x: false, y: false }, horizonLine: null,
  selection: [], styleClip: null, tuneClip: null, clip: false, tuneCache: new Map(), stats: { glDraws: 0, cacheHits: 0 }, actual: false, showOrig: false, histLast: null
};
const $ = id => document.getElementById(id);
const say = msg => { $('status').textContent = msg; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const copyCanvas = src => { const c = canvasOf(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; };
const sel = () => state.layers.find(L => L.id === state.selectedId) || null;
const snap = () => clone({ layers: state.layers, geo: state.geo });
state.history = [{ ...snap(), label: 'Start' }];

// ---------- WebGL colour pass: one shader, uniforms = parameters ----------
const VS = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v = p * 0.5 + 0.5; v.y = 1.0 - v.y; gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D u_tex;
uniform float u_brightness, u_contrast, u_saturation, u_warmth, u_highlights, u_shadows;
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  vec4 s = texture(u_tex, v);
  vec3 c = toLin(s.rgb);
  c *= exp2(u_brightness);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += u_shadows * 0.1 * (1.0 - smoothstep(0.0, 0.4, l));
  c += u_highlights * 0.1 * smoothstep(0.3, 1.0, l);
  c = 0.18 * pow(max(c, vec3(1e-6)) / 0.18, vec3(exp2(u_contrast * 0.6)));
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.0 + u_saturation);
  c.r *= 1.0 + 0.12 * u_warmth;
  c.b *= 1.0 - 0.12 * u_warmth;
  o = vec4(toSrgb(c), s.a);
}`;

function makeGL(canvas) {
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) return null;
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
   [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]
    .forEach(([k, val]) => gl.texParameteri(gl.TEXTURE_2D, k, val));
  const uni = Object.fromEntries(SLIDERS.map(k => [k, gl.getUniformLocation(prog, 'u_' + k)]));
  return {
    gl,
    setImage(src) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    },
    draw(p) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      SLIDERS.forEach(k => gl.uniform1f(uni[k], (p[k] || 0) / 100));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
}
state.glCanvas = canvasOf(1, 1);
state.gl = makeGL(state.glCanvas);

// Runs the tune shader on a canvas or bitmap, returning a new canvas (or src itself when there is nothing to do).
function tuned(src, p) {
  if (!p || !state.gl || !SLIDERS.some(k => p[k])) return src;
  state.glCanvas.width = src.width;
  state.glCanvas.height = src.height;
  state.gl.setImage(src);
  state.gl.draw(p);
  state.stats.glDraws++;
  const out = canvasOf(src.width, src.height);
  out.getContext('2d').drawImage(state.glCanvas, 0, 0);
  return out;
}

// Caches each image layer's tuned output. Only the layer's own settings matter here, so editing another
// layer or a mask does not repeat this layer's GPU pass.
function tunedCached(L, src, p, full) {
  if (!p || !state.gl || !SLIDERS.some(k => p[k])) return src;
  const key = [L.asset, full ? 'f' : 'p', src.width, src.height, ...SLIDERS.map(k => p[k])].join(':');
  const hit = state.tuneCache.get(L.id);
  if (hit && hit.key === key) { state.stats.cacheHits++; return hit.canvas; }
  const out = tuned(src, p);
  state.tuneCache.set(L.id, { key, canvas: out });
  return out;
}

// The mask for a layer at document resolution (or full-resolution for export).
// During a brush stroke the live working copy is used.
function maskFor(L, full) {
  if (!L.mask) return null;
  const m = state.live && state.live.kind === 'mask' && state.live.layerId === L.id ? state.live.canvas : state.masks.get(L.mask);
  if (!m) return null;
  if (!full) return m;
  const c = canvasOf(state.doc.fw, state.doc.fh);
  c.getContext('2d').drawImage(m, 0, 0, c.width, c.height);
  return c;
}

// ---------- Straighten, perspective, retouch ----------
// Rotates by a fine angle and scales up so the frame stays covered (no transparent corners).
function straightenCanvas(src, deg) {
  const W = src.width, H = src.height, a = deg * Math.PI / 180;
  const s = Math.cos(a) + Math.max(W / H, H / W) * Math.abs(Math.sin(a));
  const out = canvasOf(W, H), g = out.getContext('2d');
  g.translate(W / 2, H / 2);
  g.rotate(a);
  g.scale(s, s);
  g.drawImage(src, -W / 2, -H / 2);
  return out;
}
const hasPersp = p => ['tl', 'tr', 'br', 'bl'].some(k => p[k][0] || p[k][1]);
// Gauss-Jordan elimination for an 8x8 system.
function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// Homography mapping four points P to four points Q (h33 fixed to 1).
function solveHomography(P, Q) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = P[i], [X, Y] = Q[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  const h = solveLinear(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
// Keystone correction: output corners stay put, source corners move by the offsets. Nearest-neighbour sampling.
function perspectiveCanvas(src, p) {
  const W = src.width, H = src.height;
  const P = [[0, 0], [W, 0], [W, H], [0, H]];
  const Q = [[p.tl[0] * W, p.tl[1] * H], [W + p.tr[0] * W, p.tr[1] * H],
             [W + p.br[0] * W, H + p.br[1] * H], [p.bl[0] * W, H + p.bl[1] * H]];
  const h = solveHomography(P, Q);
  const s = src.getContext('2d').getImageData(0, 0, W, H).data;
  const out = canvasOf(W, H), oc = out.getContext('2d');
  const img = oc.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const den = h[6] * x + h[7] * y + 1;
      const sx = Math.round((h[0] * x + h[1] * y + h[2]) / den);
      const sy = Math.round((h[3] * x + h[4] * y + h[5]) / den);
      const o = (y * W + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) { d[o + 3] = 0; continue; }
      const i = (sy * W + sx) * 4;
      d[o] = s[i]; d[o + 1] = s[i + 1]; d[o + 2] = s[i + 2]; d[o + 3] = s[i + 3];
    }
  }
  oc.putImageData(img, 0, 0);
  return out;
}
// Paint layers hold their own transparent canvas in state.masks. A live stroke takes precedence.
function paintCanvas(L, full) {
  const c = state.live && state.live.kind === 'paint' && state.live.layerId === L.id
    ? state.live.canvas : (L.paint ? state.masks.get(L.paint) : null);
  if (!c) return null;
  if (!full) return c;
  const o = canvasOf(state.doc.fw, state.doc.fh);
  o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
  return o;
}
// Clone stamp: copies the composite beneath the layer, offset by delta (source minus destination), through a soft circle.
function stampClone(s, x, y) {
  const t = s.tmp.getContext('2d'), r = s.size / 2;
  t.clearRect(0, 0, s.tmp.width, s.tmp.height);
  t.drawImage(s.below, -s.delta.x, -s.delta.y);
  t.globalCompositeOperation = 'destination-in';
  const g = t.createRadialGradient(x, y, 0, x, y, r);
  const h = Math.max(0, Math.min(0.99, s.hard / 100));
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(h, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  t.fillStyle = g;
  t.fillRect(0, 0, s.tmp.width, s.tmp.height);
  t.globalCompositeOperation = 'source-over';
  s.ctx.drawImage(s.tmp, 0, 0);
}
function putAt(s, x, y) {
  if (s.kind === 'clone') stampClone(s, x, y);
  else stamp(s.ctx, x, y, s.size / 2, s.hard, s.erase);
}
function addRetouch() {
  if (!state.doc) { say('Open a photo first.'); return; }
  const id = newId('M');
  state.masks.set(id, canvasOf(state.doc.w, state.doc.h));
  insertAboveSelected({ id: newId('L'), type: 'paint', name: 'Retouch', visible: true, locked: false,
    opacity: 100, blend: 'normal', params: zeros(), mask: null, maskInvert: false, paint: id });
  afterChange('Add retouch layer');
}

// Colour-fills a canvas with the given colour, keeping its alpha.
function tintCanvas(src, color) {
  const t = canvasOf(src.width, src.height), tc = t.getContext('2d');
  tc.drawImage(src, 0, 0);
  tc.globalCompositeOperation = 'source-in';
  tc.fillStyle = color;
  tc.fillRect(0, 0, t.width, t.height);
  return t;
}
// A tinted, blurred and offset copy of a layer's silhouette, used for shadows and glows.
function silhouette(tinted, alpha, blur, dx, dy) {
  const out = canvasOf(tinted.width, tinted.height), oc = out.getContext('2d');
  oc.filter = blur > 0 ? `blur(${blur}px)` : 'none';
  oc.globalAlpha = alpha;
  oc.drawImage(tinted, dx, dy);
  oc.filter = 'none';
  return out;
}
// Draws the styles under the layer (shadow, glow, stroke) and the colour overlay over it.
function applyFx(lc, fx) {
  if (!fx) return lc;
  const on = k => !!(fx[k] && fx[k].on);
  if (!on('shadow') && !on('glow') && !on('stroke') && !on('overlay')) return lc;
  const out = canvasOf(lc.width, lc.height), o = out.getContext('2d');
  if (on('shadow')) {
    const s = fx.shadow;
    o.drawImage(silhouette(tintCanvas(lc, s.color), s.opacity / 100, s.blur, Math.round(s.dist * 0.6), Math.round(s.dist)), 0, 0);
  }
  if (on('glow')) {
    const g = fx.glow;
    o.drawImage(silhouette(tintCanvas(lc, g.color), g.opacity / 100, g.blur, 0, 0), 0, 0);
  }
  if (on('stroke')) {
    const t = tintCanvas(lc, fx.stroke.color), ring = canvasOf(lc.width, lc.height), rc = ring.getContext('2d');
    const w = fx.stroke.width, steps = 16;
    for (let i = 0; i < steps; i++) {
      const a = i / steps * Math.PI * 2;
      rc.drawImage(t, Math.round(Math.cos(a) * w), Math.round(Math.sin(a) * w));
    }
    o.drawImage(ring, 0, 0);
  }
  o.drawImage(lc, 0, 0);
  if (on('overlay')) {
    o.globalAlpha = fx.overlay.opacity / 100;
    o.drawImage(tintCanvas(lc, fx.overlay.color), 0, 0);
    o.globalAlpha = 1;
  }
  return out;
}

function withMask(lc, m, invert) {
  const out = canvasOf(lc.width, lc.height), o = out.getContext('2d');
  o.drawImage(lc, 0, 0);
  o.globalCompositeOperation = invert ? 'destination-out' : 'destination-in';
  o.drawImage(m, 0, 0, out.width, out.height);
  return out;
}

// ---------- Adjustment helpers (Curves, Details, Vignette, Selective) ----------
const CURVE_IDENTITY = [0, 25, 50, 75, 100];
const isIdentityCurve = ys => ys.every((y, i) => y === CURVE_IDENTITY[i]);

// Builds a 256-entry lookup table from five control points (slider values 0..100 at x = 0, .25, .5, .75, 1).
function buildLut(ys) {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const x = v / 255 * 4, i = Math.min(3, Math.floor(x)), t = x - i;
    const y = (ys[i] + (ys[i + 1] - ys[i]) * t) / 100;
    lut[v] = Math.max(0, Math.min(255, Math.round(y * 255)));
  }
  return lut;
}
function applyCurve(src, ys) {
  const lut = buildLut(ys), out = copyCanvas(src), ctx = out.getContext('2d');
  const img = ctx.getImageData(0, 0, out.width, out.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  ctx.putImageData(img, 0, 0);
  return out;
}
// Unsharp mask: out = src + k * (src - blurred). Flat areas are unchanged by construction.
function applySharpen(src, amt) {
  const blur = canvasOf(src.width, src.height), bc = blur.getContext('2d');
  bc.filter = 'blur(2px)';
  bc.drawImage(src, 0, 0);
  bc.filter = 'none';
  const out = copyCanvas(src), ctx = out.getContext('2d');
  const a = ctx.getImageData(0, 0, out.width, out.height), b = bc.getImageData(0, 0, out.width, out.height);
  const k = amt / 100 * 1.5, d = a.data, e = b.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[i + c] + k * (d[i + c] - e[i + c]);
      d[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  ctx.putImageData(a, 0, 0);
  return out;
}
// Tune, then curve, then sharpen. Returns acc itself when there is nothing to apply.
function adjustPipeline(acc, L) {
  let out = tuned(acc, L.params);
  if (L.curve && !isIdentityCurve(L.curve)) out = applyCurve(out, L.curve);
  if (L.sharpen > 0) out = applySharpen(out, L.sharpen);
  return out;
}
function vignetteCanvas(D, Hd, v) {
  const c = canvasOf(D, Hd), g = c.getContext('2d');
  const cx = v.x * D, cy = v.y * Hd, R = Math.hypot(D, Hd) / 2;
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
  const inner = Math.min(0.99, Math.max(0.01, v.radius));
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(inner, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${v.strength})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, D, Hd);
  return c;
}

// Composites all visible layers bottom to top. raw=true ignores tuning and masks (used by Before).
function composite(full, raw = false, upTo = null) {
  const D = full ? state.doc.fw : state.doc.w, Hd = full ? state.doc.fh : state.doc.h;
  let acc = canvasOf(D, Hd);
  for (const L of state.layers) {
    if (upTo && L === upTo) break;
    if (!L.visible) continue;
    let lc;
    if (L.type === 'image') {
      const a = state.assets.get(L.asset);
      if (!a) continue;
      const src = tunedCached(L, full ? a.full : a.work, raw ? null : L.params, full);
      lc = canvasOf(D, Hd);
      const dw = L.scale * D, dh = dw * src.height / src.width;
      const lg = lc.getContext('2d');
      lg.translate(L.x * D + dw / 2, L.y * Hd + dh / 2);
      lg.rotate((L.rot || 0) * Math.PI / 180);
      lg.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    } else if (L.type === 'adjust') {
      if (raw) continue;
      const adj = adjustPipeline(acc, L);
      if (adj === acc) continue;
      lc = adj;
    } else if (L.type === 'paint') {
      if (raw) continue;
      const p = paintCanvas(L, full);
      if (!p) continue;
      lc = p;
    } else {
      if (raw) continue;
      lc = vignetteCanvas(D, Hd, L.vig);
    }
    if (!raw) {
      const m = maskFor(L, full);
      if (m) lc = withMask(lc, m, L.maskInvert);
      if (L.type === 'image' || L.type === 'paint') lc = applyFx(lc, L.fx);
    }
    const g = acc.getContext('2d');
    g.save();
    g.globalAlpha = L.opacity / 100;
    g.globalCompositeOperation = BLEND[L.blend] || 'source-over';
    g.drawImage(lc, 0, 0);
    g.restore();
  }
  return acc;
}

// ---------- Geometry: rotate/flip, crop, expand, frame (applies to the whole composite) ----------
function compose(src, geo, baseOnly = false) {
  const [W, H] = dimsFor(geo.rot, src.width, src.height);
  const R = canvasOf(W, H), r = R.getContext('2d');
  r.translate(W / 2, H / 2);
  r.rotate(geo.rot * Math.PI / 180);
  r.scale(geo.flipH ? -1 : 1, geo.flipV ? -1 : 1);
  r.drawImage(src, -src.width / 2, -src.height / 2);
  let base = R;
  if (geo.angle) base = straightenCanvas(base, geo.angle);
  if (geo.persp && hasPersp(geo.persp)) base = perspectiveCanvas(base, geo.persp);
  if (baseOnly) return base;

  const c = geo.crop;
  const cx = Math.round(c.x * W), cy = Math.round(c.y * H);
  const cw = Math.max(1, Math.round(c.w * W)), ch = Math.max(1, Math.round(c.h * H));
  const C = canvasOf(cw, ch);
  C.getContext('2d').drawImage(base, cx, cy, cw, ch, 0, 0, cw, ch);

  const e = geo.expand;
  const el = Math.round(cw * e.l / 100), er = Math.round(cw * e.r / 100);
  const et = Math.round(ch * e.t / 100), eb = Math.round(ch * e.b / 100);
  const EW = cw + el + er, EH = ch + et + eb;
  const E = canvasOf(EW, EH), eg = E.getContext('2d');
  if (el + er + et + eb > 0) { eg.fillStyle = geo.expandColor; eg.fillRect(0, 0, EW, EH); }
  eg.drawImage(C, el, et);

  if (geo.frame === 'none') return E;
  const fw = Math.max(1, Math.round(Math.min(EW, EH) * geo.frameWidth / 100));
  const bottom = geo.frame === 'polaroid' ? fw * 3 : fw;
  const FW = EW + 2 * fw, FH = EH + fw + bottom;
  const F = canvasOf(FW, FH), fg = F.getContext('2d');
  fg.fillStyle = geo.frameColor;
  fg.fillRect(0, 0, FW, FH);
  fg.drawImage(E, fw, fw);
  return F;
}

function fitCrop(g) {
  if (g.aspect === 'free') return;
  const [W, H] = dimsFor(g.rot, state.doc.w, state.doc.h);
  const r = g.aspect === 'original' ? W / H : ASPECTS[g.aspect];
  let w = 1, h = 1;
  if (r > W / H) h = (W / r) / H; else w = (r * H) / W;
  g.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

const GEO_CONTROLS = {
  'c-x': (g, v) => { g.crop.x = Math.min(v / 100, 1 - g.crop.w); g.aspect = 'free'; },
  'c-y': (g, v) => { g.crop.y = Math.min(v / 100, 1 - g.crop.h); g.aspect = 'free'; },
  'c-w': (g, v) => { g.crop.w = Math.max(0.05, Math.min(v / 100, 1 - g.crop.x)); g.aspect = 'free'; },
  'c-h': (g, v) => { g.crop.h = Math.max(0.05, Math.min(v / 100, 1 - g.crop.y)); g.aspect = 'free'; },
  'e-t': (g, v) => { g.expand.t = +v; },
  'e-b': (g, v) => { g.expand.b = +v; },
  'e-l': (g, v) => { g.expand.l = +v; },
  'e-r': (g, v) => { g.expand.r = +v; },
  'e-color': (g, v) => { g.expandColor = v; },
  'frame-type': (g, v) => { g.frame = v; },
  'frame-width': (g, v) => { g.frameWidth = +v; },
  'frame-color': (g, v) => { g.frameColor = v; },
  'str-angle': (g, v) => { g.angle = +v; },
};
function ensurePersp(g) { if (!g.persp) g.persp = { tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] }; }
for (const c of ['tl', 'tr', 'br', 'bl']) {
  GEO_CONTROLS['per-' + c + 'x'] = (g, v) => { ensurePersp(g); g.persp[c][0] = +v / 100; };
  GEO_CONTROLS['per-' + c + 'y'] = (g, v) => { ensurePersp(g); g.persp[c][1] = +v / 100; };
}

const LAYER_CONTROLS = {
  'lay-opacity': (L, v) => { L.opacity = +v; },
  'lay-blend': (L, v) => { L.blend = v; },
  'lay-x': (L, v) => { L.x = +v / 100; },
  'lay-y': (L, v) => { L.y = +v / 100; },
  'lay-scale': (L, v) => { L.scale = +v / 100; },
};

const FX_CONTROLS = {
  'curve-0': (L, v) => { setCurve(L, 0, +v); },
  'curve-1': (L, v) => { setCurve(L, 1, +v); },
  'curve-2': (L, v) => { setCurve(L, 2, +v); },
  'curve-3': (L, v) => { setCurve(L, 3, +v); },
  'curve-4': (L, v) => { setCurve(L, 4, +v); },
  'det-sharpen': (L, v) => { L.sharpen = +v; },
  'vig-strength': (L, v) => { L.vig.strength = +v / 100; },
  'vig-radius': (L, v) => { L.vig.radius = +v / 100; },
  'vig-x': (L, v) => { L.vig.x = +v / 100; },
  'vig-y': (L, v) => { L.vig.y = +v / 100; },
};
function setCurve(L, i, v) {
  if (!L.curve) L.curve = CURVE_IDENTITY.slice();
  L.curve[i] = v;
}
function fxTarget(id, L) {
  if (!requireUnlocked(L)) return false;
  const need = /^(curve|det)/.test(id) ? 'adjust' : 'vignette';
  return L.type === need;
}
const LOOKS = {
  'look-warm': { warmth: 30, saturation: 10 },
  'look-cool': { warmth: -30, contrast: 10 },
  'look-matte': { contrast: -20, highlights: -20, shadows: 25 },
  'look-bw': { saturation: -100, contrast: 15 },
  'look-vivid': { saturation: 35, contrast: 20 },
};

// ---------- Rendering and UI sync ----------
function renderNow(raw = false) {
  if (!state.doc) return;
  raw = raw || state.showOrig;
  // In mask edit mode the view shows document space so brush coordinates map directly.
  const useDefault = raw || state.maskMode || state.pickMode || state.cloneMode || state.cloneSrcPending || state.tool === 'move';
  const baseOnly = !useDefault && (state.tool === 'crop' || state.tool === 'straighten');
  const out = compose(composite(false, raw), useDefault ? defaultGeo() : state.geo, baseOnly);
  const v = $('view');
  v.width = out.width; v.height = out.height;
  v.getContext('2d').drawImage(out, 0, 0);
  updateHistogram();
  if (state.clip) clipOverlay(v);
  layoutCanvas();
  drawOverlay();
}

// Continuous input (slider drags, brush moves) is coalesced to one render per animation frame.
let rafId = 0, rafRaw = false;
function renderSoon(raw = false) {
  rafRaw = raw;
  if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; renderNow(rafRaw); });
}
// Discrete actions render immediately.
function render(raw = false) {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  renderNow(raw);
}

// ---------- Histogram: computed in a worker from a small copy of the preview ----------
let histWorker = null, histBusy = false, histSeq = 0, histRerun = false;
try { histWorker = new Worker('hist-worker.js'); histWorker.onmessage = onHist; } catch (e) { histWorker = null; }
function onHist(e) {
  histBusy = false;
  state.histLast = { pixels: e.data.pixels, bins: new Uint32Array(e.data.bins) };
  drawHistogram(state.histLast.bins);
  if (histRerun) { histRerun = false; updateHistogram(); }
}
function updateHistogram() {
  if (!histWorker || !state.doc) return;
  if (histBusy) { histRerun = true; return; }
  const v = $('view'), w = Math.min(256, v.width), h = Math.max(1, Math.round(v.height * w / v.width));
  const small = canvasOf(w, h), sc = small.getContext('2d');
  sc.drawImage(v, 0, 0, w, h);
  const buf = sc.getImageData(0, 0, w, h).data.buffer;
  histBusy = true;
  histWorker.postMessage({ buf, id: ++histSeq }, [buf]);
}
function drawHistogram(bins) {
  const c = $('hist'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const lum = bins.subarray(768, 1024);
  let max = 1;
  for (let i = 0; i < 256; i++) if (lum[i] > max) max = lum[i];
  g.fillStyle = 'rgba(143, 176, 255, .6)';
  for (let i = 0; i < 256; i++) {
    const h = Math.sqrt(lum[i] / max) * H;
    g.fillRect(i * W / 256, H - h, W / 256 + 0.5, h);
  }
}

// Clipping warning: highlights with any channel at 254+ turn red, shadows with all channels at 1 or less turn blue.
function clipOverlay(v) {
  const ctx = v.getContext('2d'), img = ctx.getImageData(0, 0, v.width, v.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] >= 254 || d[i + 1] >= 254 || d[i + 2] >= 254) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; }
    else if (d[i] <= 1 && d[i + 1] <= 1 && d[i + 2] <= 1) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 255; }
  }
  ctx.putImageData(img, 0, 0);
}
function toggleClip() {
  state.clip = !state.clip;
  $('clip-toggle').setAttribute('aria-pressed', state.clip);
  render();
}

// Auto tone: measures the unedited preview, then sets brightness and contrast on the selected layers.
function autoTone() {
  const ts = targets().filter(L => L.params);
  if (!ts.length) { say('Select an unlocked layer to tone.'); return; }
  render(true);
  const v = $('view'), w = Math.min(256, v.width), h = Math.max(1, Math.round(v.height * w / v.width));
  const c = canvasOf(w, h), x = c.getContext('2d');
  x.drawImage(v, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data, bins = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) bins[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
  const n = w * h;
  const pct = q => { let acc = 0; for (let i = 0; i < 256; i++) { acc += bins[i]; if (acc >= q * n) return i; } return 255; };
  const med = pct(0.5), spread = pct(0.99) - pct(0.01);
  const bright = Math.max(-100, Math.min(100, Math.round((128 - med) * 0.8)));
  const contrast = Math.max(-40, Math.min(25, Math.round((230 - spread) / 3)));
  ts.forEach(L => { L.params.brightness = bright; L.params.contrast = contrast; });
  syncUI(); render(); commit('Auto tone');
  say(`Auto tone: brightness ${bright}, contrast ${contrast}.`);
}

function openHelp() {
  const d = $('help');
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
}

function syncUI() {
  const L = sel(), p = (L && L.params) || zeros();
  const editable = !!L && !L.locked;
  SLIDERS.forEach(k => {
    $('s-' + k).value = p[k]; $('s-' + k).disabled = !editable;
    $('v-' + k).textContent = p[k];
    $('r-' + k).disabled = !editable;
  });
  $('lay-name').value = L ? L.name : ''; $('lay-name').disabled = !editable;
  $('lay-visible').checked = !!L && L.visible; $('lay-visible').disabled = !L;
  $('lay-lock').checked = !!L && L.locked; $('lay-lock').disabled = !L;
  const img = editable && L.type === 'image';
  $('lay-opacity').value = L ? L.opacity : 100; $('lay-opacity').disabled = !editable;
  $('lay-blend').value = L ? L.blend : 'normal'; $('lay-blend').disabled = !editable;
  $('lay-x').value = L && L.type === 'image' ? Math.round(L.x * 100) : 0; $('lay-x').disabled = !img;
  $('lay-y').value = L && L.type === 'image' ? Math.round(L.y * 100) : 0; $('lay-y').disabled = !img;
  $('lay-scale').value = L && L.type === 'image' ? Math.round(L.scale * 100) : 100; $('lay-scale').disabled = !img;
  ['lay-up', 'lay-down', 'lay-dup', 'lay-del'].forEach(id => { $(id).disabled = !editable; });

  const hasMask = !!(L && L.mask);
  $('mask-add').disabled = !editable || hasMask;
  $('mask-remove').disabled = !editable || !hasMask;
  $('mask-linear').disabled = !editable;
  $('mask-radial').disabled = !editable;
  $('mask-edit').disabled = !hasMask && !state.maskMode;
  $('mask-edit').setAttribute('aria-pressed', state.maskMode);
  $('lay-mask-invert').checked = !!(L && L.maskInvert);
  $('lay-mask-invert').disabled = !editable || !hasMask;
  $('view').classList.toggle('mask-mode', state.maskMode);
  renderLayerList();
  renderHistory();
  const picked = selectedLayers();
  $('lay-group').disabled = picked.length < 2;
  $('lay-ungroup').disabled = !picked.some(x => x.group);
  $('fx-copy').disabled = !L;
  $('fx-paste').disabled = !state.styleClip || !targets().length;
  $('fx-clear').disabled = !targets().length;
  syncFxUI(L);
  $('tune-auto').disabled = !state.doc || !targets().some(x => x.params);
  $('tune-copy').disabled = !L || !L.params;
  $('tune-paste').disabled = !state.tuneClip || !targets().some(x => x.params);
  $('clip-toggle').setAttribute('aria-pressed', state.clip);

  const isAdj = !!L && L.type === 'adjust', isVig = !!L && L.type === 'vignette';
  for (let i = 0; i < 5; i++) {
    $('curve-' + i).value = isAdj && L.curve ? L.curve[i] : CURVE_IDENTITY[i];
    $('curve-' + i).disabled = !(isAdj && editable);
  }
  $('det-sharpen').value = isAdj ? (L.sharpen || 0) : 0; $('det-sharpen').disabled = !(isAdj && editable);
  $('vig-strength').value = isVig ? Math.round(L.vig.strength * 100) : 60;
  $('vig-radius').value = isVig ? Math.round(L.vig.radius * 100) : 60;
  $('vig-x').value = isVig ? Math.round(L.vig.x * 100) : 50;
  $('vig-y').value = isVig ? Math.round(L.vig.y * 100) : 50;
  ['vig-strength', 'vig-radius', 'vig-x', 'vig-y'].forEach(id => { $(id).disabled = !(isVig && editable); });
  Object.keys(LOOKS).forEach(id => { $(id).disabled = !editable; });
  $('fx-selective').disabled = !state.doc;
  $('fx-selective').setAttribute('aria-pressed', state.pickMode);

  $('retouch-add').disabled = !state.doc;
  $('retouch-src').setAttribute('aria-pressed', state.cloneSrcPending);
  $('retouch-paint').setAttribute('aria-pressed', state.cloneMode);
  $('retouch-paint').disabled = !(L && L.type === 'paint' && !L.locked);

  const g = state.geo;
  $('str-angle').value = g.angle || 0;
  for (const c of ['tl', 'tr', 'br', 'bl']) {
    $('per-' + c + 'x').value = Math.round((g.persp ? g.persp[c][0] : 0) * 100);
    $('per-' + c + 'y').value = Math.round((g.persp ? g.persp[c][1] : 0) * 100);
  }
  $('aspect').value = g.aspect;
  $('c-x').value = Math.round(g.crop.x * 100); $('c-y').value = Math.round(g.crop.y * 100);
  $('c-w').value = Math.round(g.crop.w * 100); $('c-h').value = Math.round(g.crop.h * 100);
  $('e-t').value = g.expand.t; $('e-b').value = g.expand.b; $('e-l').value = g.expand.l; $('e-r').value = g.expand.r;
  $('e-color').value = g.expandColor;
  $('frame-type').value = g.frame; $('frame-width').value = g.frameWidth; $('frame-color').value = g.frameColor;
  updateUndo();
}

// Selection: state.selection holds ids; the primary layer is state.selectedId. A stale selection falls back to the primary.
function selectedLayers() {
  const ids = state.selection.includes(state.selectedId) ? state.selection : [state.selectedId];
  return state.layers.filter(L => ids.includes(L.id));
}
// Selected layers that can be edited (locked layers are skipped).
function targets() { return selectedLayers().filter(L => !L.locked); }
function setSelection(ids, primary) { state.selection = ids; state.selectedId = primary; }
const hasFx = L => !!L.fx && Object.values(L.fx).some(f => f.on);

function renderLayerList() {
  const picked = new Set(selectedLayers().map(L => L.id));
  const rows = [...state.layers].reverse().map(L => {
    const tag = { adjust: '[adj]', vignette: '[vig]', paint: '[ret]' }[L.type] || '[img]';
    const flags = (L.mask ? ' · mask' : '') + (hasFx(L) ? ' · fx' : '') + (L.group ? ' · group' : '') +
      (L.visible ? '' : ' · hidden') + (L.locked ? ' · locked' : '');
    return `<button class="lrow${picked.has(L.id) ? ' on' : ''}" data-id="${esc(L.id)}">${tag} ${esc(L.name)}${flags}</button>`;
  });
  $('layer-list').innerHTML = rows.join('') || '<p class="note">No layers. Open a photo to start.</p>';
}
function renderHistory() {
  $('history-list').innerHTML = state.history.map((h, i) =>
    `<button class="lrow${i === state.hIndex ? ' on' : ''}" data-h="${i}">${i}. ${esc(h.label)}</button>`).reverse().join('');
}
$('layer-list').addEventListener('click', e => {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  const id = b.dataset.id, order = state.layers.map(L => L.id);
  const current = state.selection.includes(state.selectedId) ? state.selection.slice() : [state.selectedId];
  if (e.shiftKey && state.selectedId) {
    const a = order.indexOf(state.selectedId), c = order.indexOf(id);
    setSelection(order.slice(Math.min(a, c), Math.max(a, c) + 1), id);
  } else if (e.metaKey || e.ctrlKey) {
    if (current.includes(id)) {
      const rest = current.filter(x => x !== id);
      setSelection(rest, rest[rest.length - 1] || null);
    } else {
      setSelection([...current, id], id);
    }
  } else {
    // Clicking a grouped layer selects its whole group.
    const L = state.layers.find(x => x.id === id);
    const ids = L && L.group ? state.layers.filter(x => x.group === L.group).map(x => x.id) : [id];
    setSelection(ids, id);
  }
  syncUI();
});
$('history-list').addEventListener('click', e => {
  const b = e.target.closest('[data-h]');
  if (!b) return;
  state.hIndex = +b.dataset.h;
  setEdit(state.history[state.hIndex]);
  state.dirty = true;
  updateUndo();
});

// ---------- History (layers, masks and geometry; selection and brush settings are not undoable) ----------
function setEdit(e) {
  state.layers = clone(e.layers);
  state.geo = clone(e.geo);
  if (!sel()) state.selectedId = state.layers.length ? state.layers[state.layers.length - 1].id : null;
  syncUI();
  render();
}
function commit(label = 'Edit') {
  state.showOrig = false;
  state.history = state.history.slice(0, state.hIndex + 1);
  state.history.push({ ...snap(), label });
  if (state.history.length > MAX_HISTORY) state.history.shift();
  state.hIndex = state.history.length - 1;
  state.dirty = true;
  releaseUnused();
  updateUndo();
}
// Frees bitmaps and masks that no history step and no layer refers to any more.
function releaseUnused() {
  const useA = new Set(), useM = new Set();
  const visit = layers => layers.forEach(L => { if (L.asset) useA.add(L.asset); if (L.mask) useM.add(L.mask); if (L.paint) useM.add(L.paint); });
  state.history.forEach(h => visit(h.layers));
  visit(state.layers);
  for (const k of [...state.assets.keys()]) if (!useA.has(k)) state.assets.delete(k);
  for (const k of [...state.masks.keys()]) if (!useM.has(k)) state.masks.delete(k);
  const liveIds = new Set(state.layers.map(L => L.id));
  for (const k of [...state.tuneCache.keys()]) if (!liveIds.has(k)) state.tuneCache.delete(k);
}
function afterChange(label = 'Edit') { syncUI(); render(); commit(label); }
function undo() { if (state.hIndex > 0) { state.hIndex--; setEdit(state.history[state.hIndex]); state.dirty = true; updateUndo(); } }
function redo() { if (state.hIndex < state.history.length - 1) { state.hIndex++; setEdit(state.history[state.hIndex]); state.dirty = true; updateUndo(); } }
function updateUndo() {
  $('btn-undo').disabled = state.hIndex <= 0;
  $('btn-redo').disabled = state.hIndex >= state.history.length - 1;
}

// ---------- Geometry actions ----------
function geoAction(fn, label = 'Geometry') { fn(state.geo); syncUI(); render(); commit(label); }
function rotate(delta) {
  geoAction(g => { g.rot = (g.rot + delta + 360) % 360; g.crop = fullCrop(); fitCrop(g); }, 'Rotate');
}

// ---------- Layer actions ----------
function requireUnlocked(L) {
  if (!L) return false;
  if (L.locked) { say('That layer is locked. Unlock it first.'); return false; }
  return true;
}
function insertAboveSelected(L) {
  const i = state.layers.findIndex(x => x.id === state.selectedId);
  state.layers.splice(i < 0 ? state.layers.length : i + 1, 0, L);
  state.selectedId = L.id;
}
function imageLayer(a, name) {
  return { id: newId('L'), type: 'image', name, asset: a.id, visible: true, locked: false,
    opacity: 100, blend: 'normal', x: 0, y: 0, scale: 1, params: zeros(), mask: null, maskInvert: false };
}
function moveSel(d) {
  const picked = selectedLayers();
  if (picked.length !== 1) { say('Select one layer to reorder it.'); return; }
  const L = picked[0]; if (!requireUnlocked(L)) return;
  const i = state.layers.indexOf(L), j = i + d;
  if (j < 0 || j >= state.layers.length) return;
  [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
  afterChange('Move layer');
}
function dupSel() {
  const ts = targets();
  if (!ts.length) { say('Select an unlocked layer to duplicate.'); return; }
  const copies = [];
  ts.slice().sort((a, b) => state.layers.indexOf(b) - state.layers.indexOf(a)).forEach(L => {
    const C = clone(L);
    C.id = newId('L'); C.name = L.name + ' copy';
    state.layers.splice(state.layers.indexOf(L) + 1, 0, C);
    copies.push(C.id);
  });
  setSelection(copies, copies[0]);
  afterChange('Duplicate layers');
}
function delSel() {
  const ts = targets();
  if (!ts.length) { say('Select an unlocked layer to delete.'); return; }
  const ids = new Set(ts.map(L => L.id));
  const first = state.layers.findIndex(L => ids.has(L.id));
  state.layers = state.layers.filter(L => !ids.has(L.id));
  const next = state.layers[Math.min(first, state.layers.length - 1)] || null;
  setSelection(next ? [next.id] : [], next ? next.id : null);
  afterChange('Delete layers');
}
// ---------- Layer styles: drop shadow, outer glow, stroke, colour overlay ----------
const FX_DEFAULT = () => ({
  shadow: { on: false, color: '#000000', opacity: 60, blur: 8, dist: 10 },
  glow: { on: false, color: '#8fb0ff', opacity: 60, blur: 16 },
  stroke: { on: false, color: '#ffffff', width: 3 },
  overlay: { on: false, color: '#8fb0ff', opacity: 40 },
});
const FX_UI = [
  ['fx-shadow-on', 'shadow', 'on', 'check'], ['fx-shadow-blur', 'shadow', 'blur', 'num'], ['fx-shadow-dist', 'shadow', 'dist', 'num'],
  ['fx-shadow-opacity', 'shadow', 'opacity', 'num'], ['fx-shadow-color', 'shadow', 'color', 'str'],
  ['fx-glow-on', 'glow', 'on', 'check'], ['fx-glow-blur', 'glow', 'blur', 'num'], ['fx-glow-opacity', 'glow', 'opacity', 'num'], ['fx-glow-color', 'glow', 'color', 'str'],
  ['fx-stroke-on', 'stroke', 'on', 'check'], ['fx-stroke-width', 'stroke', 'width', 'num'], ['fx-stroke-color', 'stroke', 'color', 'str'],
  ['fx-over-on', 'overlay', 'on', 'check'], ['fx-over-opacity', 'overlay', 'opacity', 'num'], ['fx-over-color', 'overlay', 'color', 'str'],
];
const fxRead = (el, t) => (t === 'check' ? el.checked : t === 'num' ? +el.value : el.value);
function syncFxUI(L) {
  const f = (L && L.fx) || FX_DEFAULT(), ok = !!L && !L.locked;
  FX_UI.forEach(([id, g, k, t]) => {
    const el = $(id);
    if (t === 'check') el.checked = !!f[g][k]; else el.value = f[g][k];
    el.disabled = !ok;
  });
}
function addAdjust() {
  if (!state.doc) { say('Open a photo first.'); return; }
  insertAboveSelected({ id: newId('L'), type: 'adjust', name: 'Adjustment', visible: true, locked: false,
    opacity: 100, blend: 'normal', params: zeros(), mask: null, maskInvert: false });
  afterChange('Add adjustment');
}

// ---------- Masks ----------
function setMaskCanvas(L, canvas, label) {
  const id = newId('M');
  state.masks.set(id, canvas);
  L.mask = id;
  afterChange(label);
}
function addMask() {
  const L = sel(); if (!requireUnlocked(L) || L.mask) return;
  const c = canvasOf(state.doc.w, state.doc.h), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  setMaskCanvas(L, c, 'Add mask');
}
function removeMask() {
  const L = sel(); if (!requireUnlocked(L) || !L.mask) return;
  L.mask = null;
  afterChange('Remove mask');
}
function gradientMask(kind) {
  const L = sel(); if (!requireUnlocked(L)) return;
  const c = canvasOf(state.doc.w, state.doc.h), g = c.getContext('2d');
  const grad = kind === 'linear'
    ? g.createLinearGradient(0, 0, 0, c.height)
    : g.createRadialGradient(c.width / 2, c.height / 2, 0, c.width / 2, c.height / 2, Math.hypot(c.width, c.height) / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  setMaskCanvas(L, c, kind === 'linear' ? 'Linear gradient mask' : 'Radial gradient mask');
}

// Brush stamping, in document (preview) pixels.
let stroke = null;
function stamp(ctx, x, y, r, hard, erase) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  const h = Math.max(0, Math.min(0.99, hard / 100));
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(h, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function strokeTo(x, y) {
  const s = stroke, r = s.size / 2;
  const dx = x - s.lx, dy = y - s.ly, d = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(d / Math.max(1, r / 4)));
  for (let i = 1; i <= steps; i++) putAt(s, s.lx + dx * i / steps, s.ly + dy * i / steps);
  s.lx = x; s.ly = y;
}
function docPoint(e) {
  const v = $('view'), rect = v.getBoundingClientRect();
  return { x: (e.clientX - rect.left) * (v.width / rect.width), y: (e.clientY - rect.top) * (v.height / rect.height) };
}
function finishStroke() {
  if (!stroke) return;
  const s = stroke;
  stroke = null;
  state.live = null;
  const L = state.layers.find(x => x.id === s.layerId);
  if (!L) return;
  const id = newId('M');
  state.masks.set(id, s.canvas);
  if (s.kind === 'clone') {
    L.paint = id;
    afterChange('Clone stroke');
  } else {
    L.mask = id;
    afterChange(s.erase ? 'Erase mask' : 'Paint mask');
  }
}

function addVignette() {
  if (!state.doc) { say('Open a photo first.'); return; }
  insertAboveSelected({ id: newId('L'), type: 'vignette', name: 'Vignette', visible: true, locked: false,
    opacity: 100, blend: 'normal', params: zeros(), mask: null, maskInvert: false,
    vig: { strength: 0.6, radius: 0.6, x: 0.5, y: 0.5 } });
  afterChange('Add vignette');
}
function applyLook(p) {
  const L = sel(); if (!requireUnlocked(L)) return;
  L.params = { ...zeros(), ...p };
  afterChange('Look');
}
// Selective Adjust: an adjustment layer whose mask is a radial falloff around the tapped point.
function placeSelective(pt) {
  if (!state.doc) return;
  const f = +$('sel-feather').value / 100;
  const r = Math.max(1, +$('sel-radius').value / 100 * state.doc.w);
  const c = canvasOf(state.doc.w, state.doc.h), g = c.getContext('2d');
  const grad = g.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(Math.max(0, 1 - f), 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const id = newId('M');
  state.masks.set(id, c);
  insertAboveSelected({ id: newId('L'), type: 'adjust', name: 'Selective', visible: true, locked: false,
    opacity: 100, blend: 'normal', params: zeros(), mask: id, maskInvert: false, curve: null, sharpen: 0 });
  state.pickMode = false;
  afterChange('Selective adjustment');
}

// ---------- Decoding and documents ----------
async function decodeAsset(id, name, blob) {
  const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const s = Math.min(1, MAX_WORK / Math.max(full.width, full.height));
  const work = s < 1
    ? await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(full.width * s)),
        resizeHeight: Math.max(1, Math.round(full.height * s)), resizeQuality: 'high' })
    : full;
  return { id, name, blob, full, work };
}
function heicMsg(file) {
  say(/hei[cf]/i.test(file.name + ' ' + file.type)
    ? 'HEIC/HEIF: most desktop browsers cannot decode this. Convert it to JPEG or PNG first.'
    : 'Could not decode this image.');
}
function showCanvas() {
  $('view').hidden = false; $('canvas-wrap').hidden = false; $('tools').hidden = false; $('empty').hidden = true;
}

// ---------- On-canvas handles: layer move, scale and rotate; crop; straighten ----------
let xf = null;               // the drag in progress, if any
const CROP_HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
// Screen pixels to document pixels on the canvas overlay.
function kScreen() {
  const r = $('canvas-wrap').getBoundingClientRect();
  return r.width ? $('overlay').width / r.width : 1;
}
// Sizes the canvas wrapper to fit the stage (or 100% zoom), keeping the view and overlay in step.
function layoutCanvas() {
  const v = $('view'), ov = $('overlay'), wrap = $('canvas-wrap'), st = $('stage');
  if (!state.doc || !v.width) return;
  const s = state.actual ? 1 : Math.min((st.clientWidth - 40) / v.width, (st.clientHeight - 40) / v.height, 8);
  wrap.style.width = Math.max(1, Math.round(v.width * s)) + 'px';
  wrap.style.height = Math.max(1, Math.round(v.height * s)) + 'px';
  if (ov.width !== v.width) ov.width = v.width;
  if (ov.height !== v.height) ov.height = v.height;
}
function layerBox(L) {
  const a = state.assets.get(L.asset), D = state.doc.w, Hd = state.doc.h;
  const dw = L.scale * D, dh = dw * a.work.height / a.work.width;
  return { cx: L.x * D + dw / 2, cy: L.y * Hd + dh / 2, dw, dh, rot: (L.rot || 0) * Math.PI / 180 };
}
function toWorld(b, lx, ly) {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  return { x: b.cx + lx * c - ly * s, y: b.cy + lx * s + ly * c };
}
function toLocal(b, p) {
  const c = Math.cos(-b.rot), s = Math.sin(-b.rot), dx = p.x - b.cx, dy = p.y - b.cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}
// Handle positions for the selected image layer (document pixels). Used by the overlay and by the tests.
function layerHandles() {
  const L = sel();
  if (!L || L.type !== 'image' || !state.doc) return null;
  const b = layerBox(L);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => toWorld(b, sx * b.dw / 2, sy * b.dh / 2));
  const rot = toWorld(b, 0, -b.dh / 2 - 28 * kScreen());
  return { corners, rot, box: b };
}
function hitLayer(b, p, hs) {
  const rot = toWorld(b, 0, -b.dh / 2 - 28 * kScreen());
  if (Math.hypot(p.x - rot.x, p.y - rot.y) <= hs * 1.3) return 'rotate';
  const q = toLocal(b, p);
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    if (Math.abs(q.x - sx * b.dw / 2) <= hs && Math.abs(q.y - sy * b.dh / 2) <= hs) return 'scale';
  }
  if (Math.abs(q.x) <= b.dw / 2 && Math.abs(q.y) <= b.dh / 2) return 'move';
  return null;
}
function cropHit(W, H, p, hs) {
  const c = state.geo.crop, x = c.x * W, y = c.y * H, w = c.w * W, h = c.h * H;
  for (const [name, [fx, fy]] of Object.entries(CROP_HANDLES)) {
    if (Math.abs(p.x - (x + w * fx)) <= hs && Math.abs(p.y - (y + h * fy)) <= hs) return name;
  }
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h ? 'body' : null;
}
function toolDown(e) {
  if (!['move', 'crop', 'straighten'].includes(state.tool)) return false;
  const p = docPoint(e), hs = 9 * kScreen();
  if (state.tool === 'move') {
    const L = sel();
    if (!L || L.type !== 'image' || L.locked) { say('Select an unlocked image layer to move it.'); return true; }
    const b = layerBox(L), mode = hitLayer(b, p, hs);
    if (!mode) return true;
    xf = { kind: 'layer', mode, layerId: L.id, start: p, box: b, startAng: Math.atan2(p.y - b.cy, p.x - b.cx),
      startDist: Math.max(1, Math.hypot(p.x - b.cx, p.y - b.cy)), orig: { x: L.x, y: L.y, scale: L.scale, rot: L.rot || 0 } };
  } else if (state.tool === 'crop') {
    const W = $('view').width, H = $('view').height, mode = cropHit(W, H, p, hs);
    if (!mode) return true;
    xf = { kind: 'crop', mode, start: p, W, H, orig: { ...state.geo.crop } };
  } else {
    xf = { kind: 'horizon', start: p };
    state.horizonLine = { a: p, b: p };
  }
  $('overlay').setPointerCapture(e.pointerId);
  return true;
}
function aspectOf(g, W, H) {
  return g.aspect === 'original' ? W / H : ASPECTS[g.aspect];
}
function toolMove(e) {
  if (!xf) return false;
  const p = docPoint(e), D = state.doc.w, Hd = state.doc.h;
  if (xf.kind === 'layer') {
    const L = state.layers.find(x => x.id === xf.layerId);
    if (!L) return true;
    const b0 = xf.box, aspect = state.assets.get(L.asset).work.height / state.assets.get(L.asset).work.width;
    if (xf.mode === 'move') {
      let cx = b0.cx + (p.x - xf.start.x), cy = b0.cy + (p.y - xf.start.y);
      state.guides = { x: Math.abs(cx - D / 2) < D * 0.015, y: Math.abs(cy - Hd / 2) < Hd * 0.015 };
      if (state.guides.x) cx = D / 2;
      if (state.guides.y) cy = Hd / 2;
      L.x = (cx - b0.dw / 2) / D;
      L.y = (cy - b0.dh / 2) / Hd;
    } else if (xf.mode === 'rotate') {
      let deg = xf.orig.rot + (Math.atan2(p.y - b0.cy, p.x - b0.cx) - xf.startAng) * 180 / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      L.rot = ((deg + 180) % 360 + 360) % 360 - 180;
    } else {
      const scale = Math.max(0.02, xf.orig.scale * Math.hypot(p.x - b0.cx, p.y - b0.cy) / xf.startDist);
      const dw = scale * D, dh = dw * aspect;
      L.scale = scale;
      L.x = (b0.cx - dw / 2) / D;
      L.y = (b0.cy - dh / 2) / Hd;
    }
    renderSoon();
    return true;
  }
  if (xf.kind === 'crop') {
    const dx = (p.x - xf.start.x) / xf.W, dy = (p.y - xf.start.y) / xf.H, o = xf.orig, c = state.geo.crop;
    if (xf.mode === 'body') {
      c.x = Math.min(Math.max(o.x + dx, 0), 1 - o.w);
      c.y = Math.min(Math.max(o.y + dy, 0), 1 - o.h);
    } else {
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      const m = xf.mode;
      // Edges follow the pointer exactly, so the crop lands where you drop the handle.
      if (m.includes('w')) x0 = Math.min(Math.max(p.x / xf.W, 0), x1 - 0.05);
      if (m.includes('e')) x1 = Math.max(Math.min(p.x / xf.W, 1), x0 + 0.05);
      if (m.includes('n')) y0 = Math.min(Math.max(p.y / xf.H, 0), y1 - 0.05);
      if (m.includes('s')) y1 = Math.max(Math.min(p.y / xf.H, 1), y0 + 0.05);
      c.x = x0; c.y = y0; c.w = x1 - x0; c.h = y1 - y0;
      const r = aspectOf(state.geo, xf.W, xf.H);
      if (r) {
        c.h = (c.w * xf.W / r) / xf.H;
        if (m.includes('n')) c.y = Math.max(0, y1 - c.h);
        c.h = Math.min(c.h, 1 - c.y);
      }
    }
    renderSoon();
    return true;
  }
  // straighten: the horizon is the drag line; its slope becomes the angle
  xf.end = p;
  state.horizonLine = { a: xf.start, b: p };
  const dx = Math.abs(p.x - xf.start.x), dy = p.y - xf.start.y;
  if (Math.hypot(dx, dy) > 4) {
    state.geo.angle = Math.max(-45, Math.min(45, Math.round(-Math.atan2(dy, Math.max(dx, 1)) * 1800 / Math.PI) / 10));
  }
  renderSoon();
  return true;
}
function toolUp() {
  if (!xf) return false;
  const kind = xf.kind;
  xf = null;
  state.guides = { x: false, y: false };
  state.horizonLine = null;
  syncUI(); render();
  commit({ layer: 'Transform layer', crop: 'Crop', horizon: 'Straighten' }[kind]);
  return true;
}
function setTool(name) {
  state.tool = name;
  state.maskMode = false; state.pickMode = false; state.cloneMode = false; state.cloneSrcPending = false;
  ['select', 'move', 'crop', 'straighten'].forEach(t => $('tool-' + t).setAttribute('aria-pressed', t === name));
  $('canvas-wrap').className = 'tool-' + name;
  syncUI(); render();
}

function drawCropOverlay(g, W, H, k) {
  const c = state.geo.crop, x = c.x * W, y = c.y * H, w = c.w * W, h = c.h * H;
  g.fillStyle = 'rgba(8, 9, 12, .6)';
  g.fillRect(0, 0, W, y); g.fillRect(0, y + h, W, H - y - h);
  g.fillRect(0, y, x, h); g.fillRect(x + w, y, W - x - w, h);
  g.strokeStyle = '#fff'; g.lineWidth = k;
  g.globalAlpha = 0.4; g.beginPath();
  for (let i = 1; i < 3; i++) {
    g.moveTo(x + w * i / 3, y); g.lineTo(x + w * i / 3, y + h);
    g.moveTo(x, y + h * i / 3); g.lineTo(x + w, y + h * i / 3);
  }
  g.stroke(); g.globalAlpha = 1;
  g.strokeRect(x, y, w, h);
  for (const [fx, fy] of Object.values(CROP_HANDLES)) drawHandle(g, x + w * fx, y + h * fy, k);
  pill(g, `${Math.round(w)} × ${Math.round(h)} px`, x + 6 * k, y + 6 * k, k);
}
// A small dark label with a readable text colour, drawn over the photo.
function pill(g, text, x, y, k) {
  g.font = `${12 * k}px system-ui, sans-serif`;
  const w = g.measureText(text).width + 12 * k, h = 20 * k;
  g.fillStyle = 'rgba(11, 12, 16, .82)';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#eef0f5';
  g.fillText(text, x + 6 * k, y + 14 * k);
}
function drawHandle(g, x, y, k) {
  const s = 8 * k;
  g.fillStyle = '#fff'; g.strokeStyle = '#0b0c10'; g.lineWidth = k;
  g.fillRect(x - s / 2, y - s / 2, s, s);
  g.strokeRect(x - s / 2, y - s / 2, s, s);
}
function drawStraightenOverlay(g, W, H, k) {
  g.strokeStyle = 'rgba(255, 255, 255, .3)'; g.lineWidth = k; g.beginPath();
  for (let i = 1; i < 3; i++) { g.moveTo(W * i / 3, 0); g.lineTo(W * i / 3, H); g.moveTo(0, H * i / 3); g.lineTo(W, H * i / 3); }
  g.stroke();
  const hl = state.horizonLine;
  g.font = `${13 * k}px system-ui, sans-serif`;
  if (!hl) { g.fillStyle = '#eef0f5'; g.fillText('Drag along a horizon to straighten', 10 * k, 22 * k); return; }
  g.strokeStyle = '#8fb0ff'; g.lineWidth = 2 * k; g.beginPath(); g.moveTo(hl.a.x, hl.a.y); g.lineTo(hl.b.x, hl.b.y); g.stroke();
  drawHandle(g, hl.a.x, hl.a.y, k); drawHandle(g, hl.b.x, hl.b.y, k);
  g.fillStyle = '#eef0f5';
  g.fillText(`${state.geo.angle.toFixed(1)}°`, hl.b.x + 10 * k, hl.b.y - 10 * k);
}
function drawLayerOverlay(g, W, H, k) {
  const L = sel(), D = state.doc.w, Hd = state.doc.h;
  if (state.guides.x) { g.strokeStyle = '#ff7ad9'; g.lineWidth = k; g.beginPath(); g.moveTo(D / 2, 0); g.lineTo(D / 2, H); g.stroke(); }
  if (state.guides.y) { g.strokeStyle = '#ff7ad9'; g.lineWidth = k; g.beginPath(); g.moveTo(0, Hd / 2); g.lineTo(W, Hd / 2); g.stroke(); }
  const hd = layerHandles();
  if (!hd) return;
  const b = hd.box, pts = hd.corners;
  g.strokeStyle = '#8fb0ff'; g.lineWidth = k; g.setLineDash([6 * k, 4 * k]);
  g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.stroke();
  g.setLineDash([]);
  const top = toWorld(b, 0, -b.dh / 2);
  g.beginPath(); g.moveTo(top.x, top.y); g.lineTo(hd.rot.x, hd.rot.y); g.stroke();
  pts.forEach(p => drawHandle(g, p.x, p.y, k));
  g.fillStyle = '#8fb0ff'; g.beginPath(); g.arc(hd.rot.x, hd.rot.y, 4.5 * k, 0, Math.PI * 2); g.fill();
  pill(g, `${Math.round(L.x * 100)}%, ${Math.round(L.y * 100)}%  ·  ${Math.round(L.scale * 100)}%  ·  ${Math.round(L.rot || 0)}°`,
    pts[0].x, pts[0].y - 26 * k, k);
}
function drawOverlay() {
  const ov = $('overlay'), g = ov.getContext('2d');
  g.clearRect(0, 0, ov.width, ov.height);
  if (!state.doc || $('canvas-wrap').hidden) return;
  const k = kScreen(), W = ov.width, H = ov.height;
  if (state.tool === 'crop') drawCropOverlay(g, W, H, k);
  else if (state.tool === 'straighten') drawStraightenOverlay(g, W, H, k);
  else if (state.tool === 'move') drawLayerOverlay(g, W, H, k);
}


async function openFile(file) {
  let a;
  try { a = await decodeAsset(newId('A'), file.name, file); } catch (e) { heicMsg(file); return false; }
  state.assets = new Map([[a.id, a]]);
  state.masks = new Map();
  state.doc = { w: a.work.width, h: a.work.height, fw: a.full.width, fh: a.full.height };
  state.docName = file.name;
  const L = imageLayer(a, file.name);
  state.layers = [L];
  state.selectedId = L.id;
  state.geo = defaultGeo();
  state.history = [{ ...snap(), label: 'Open' }];
  state.hIndex = 0;
  state.projectId = null;
  state.dirty = true;
  state.maskMode = false;
  showCanvas();
  syncUI();
  render();
  if (state.gl) say(`${file.name}: ${a.full.width}×${a.full.height} base layer. Stored only in this browser.`);
  else say('WebGL 2 unavailable: colour adjustments are disabled; geometry, masks and layers still work.');
  return true;
}

async function addImageFile(file) {
  if (!state.doc) return openFile(file);
  let a;
  try { a = await decodeAsset(newId('A'), file.name, file); } catch (e) { heicMsg(file); return false; }
  state.assets.set(a.id, a);
  const L = imageLayer(a, file.name);
  L.scale = 0.5;
  L.x = 0.25;
  const dhPx = L.scale * state.doc.w * a.work.height / a.work.width;
  L.y = (state.doc.h - dhPx) / 2 / state.doc.h;
  insertAboveSelected(L);
  afterChange('Add image');
  return true;
}

// ---------- Export at full resolution ----------
async function exportImage(type) {
  if (!state.doc) { say('Open a photo first.'); return; }
  if (state.gl) {
    const g = state.gl.gl, max = g.getParameter(g.MAX_TEXTURE_SIZE);
    for (const a of state.assets.values()) {
      if (a.full.width > max || a.full.height > max) {
        say(`A layer exceeds the GPU size limit (${max}px per side). Tiled export is not implemented yet.`);
        return;
      }
    }
  }
  const out = compose(composite(true), state.geo);
  const jpeg = type === 'jpeg';
  out.toBlob(blob => {
    if (!blob) { say('Export failed.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.docName.replace(/\.[^.]+$/, '') + '-edited.' + (jpeg ? 'jpg' : 'png');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    say(`Exported ${out.width}×${out.height} ${jpeg ? 'JPEG' : 'PNG'}.`);
  }, jpeg ? 'image/jpeg' : 'image/png', +$('export-quality').value / 100);
}

// ---------- Projects in IndexedDB ----------
const DB = new Promise((res, rej) => {
  const r = indexedDB.open('edit-it', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function dbDo(mode, fn) {
  const db = await DB;
  return new Promise((res, rej) => {
    const t = db.transaction('projects', mode);
    const req = fn(t.objectStore('projects'));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
async function doSaveProject() {
  if (!state.doc) return;
  state.projectId = state.projectId || newId('P');
  const assets = [...state.assets.values()].map(a => ({ id: a.id, name: a.name, blob: a.blob }));
  const masks = await Promise.all([...state.masks].map(async ([id, c]) =>
    ({ id, blob: await new Promise(r => c.toBlob(r, 'image/png')) })));
  await dbDo('readwrite', s => s.put({
    id: state.projectId, name: state.docName, updated: Date.now(), doc: state.doc, assets, masks,
    history: state.history, hIndex: state.hIndex
  }));
  state.dirty = false;
  await refreshList();
  say('Saved ' + new Date().toLocaleTimeString() + '.');
}
// Saves run one at a time, in order, so an older autosave can never finish after a newer save.
let saveChain = Promise.resolve();
function saveProject() {
  saveChain = saveChain.then(doSaveProject, doSaveProject);
  return saveChain;
}
async function refreshList() {
  const all = await dbDo('readonly', s => s.getAll());
  $('project-select').innerHTML = '<option value="">Saved projects</option>' +
    all.sort((a, b) => b.updated - a.updated).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
}

// ---------- Sliders (tune the selected layer) ----------
function resetParam(k) {
  const ts = targets().filter(L => L.params);
  if (!ts.length) return;
  ts.forEach(L => { L.params[k] = 0; });
  syncUI(); render(); commit('Reset ' + LABEL[k]);
}
function buildSliders() {
  const box = $('sliders');
  SLIDERS.forEach(k => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label for="s-${k}">${LABEL[k]}</label>` +
      `<input type="range" id="s-${k}" min="-100" max="100" step="1" value="0">` +
      `<span id="v-${k}" class="val">0</span>` +
      `<button id="r-${k}" class="mini" title="Reset ${LABEL[k]}">↺</button>`;
    box.appendChild(row);
    const el = row.querySelector('input');
    el.addEventListener('input', () => {
      const ts = targets().filter(L => L.params);
      if (!ts.length) return;
      ts.forEach(L => { L.params[k] = +el.value; });
      $('v-' + k).textContent = el.value;
      renderSoon();
    });
    el.addEventListener('change', () => { commit(LABEL[k]); render(); });
    el.addEventListener('dblclick', () => resetParam(k));
    $('r-' + k).addEventListener('click', () => resetParam(k));
  });
}

// ---------- Wiring ----------
buildSliders();
syncUI();

$('btn-open').onclick = () => $('file-input').click();
$('file-input').onchange = e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
$('add-input').onchange = e => { const f = e.target.files[0]; if (f) addImageFile(f); e.target.value = ''; };
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/') || /\.hei[cf]$/i.test(x.name));
  if (f) (state.doc ? addImageFile(f) : openFile(f));
});
addEventListener('paste', e => {
  const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (it) { const f = it.getAsFile(); state.doc ? addImageFile(f) : openFile(f); }
});

$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;
$('btn-reset').onclick = () => {
  state.layers.forEach(L => { if (L.params && !L.locked) L.params = zeros(); });
  state.geo = defaultGeo();
  afterChange('Reset all');
};

const bf = $('before');
bf.addEventListener('pointerdown', e => { e.preventDefault(); render(true); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => bf.addEventListener(t, () => render(false)));

function showTab(name) {
  ['tune', 'geo', 'layers', 'history', 'fx'].forEach(t => {
    $('panel-' + t).hidden = t !== name;
    $('tab-' + t).setAttribute('aria-pressed', t === name);
  });
  if (name === 'history') renderHistory();
}
['tune', 'geo', 'layers', 'history', 'fx'].forEach(t => { $('tab-' + t).onclick = () => showTab(t); });
$('sheet-toggle').onclick = () => {
  const closed = $('sheet').classList.toggle('closed');
  document.body.classList.toggle('panel-hidden', closed);
  $('sheet-toggle').textContent = closed ? 'Show panel' : 'Hide panel';
  $('sheet-toggle').setAttribute('aria-expanded', !closed);
};

$('rot-l').onclick = () => rotate(-90);
$('rot-r').onclick = () => rotate(90);
$('flip-h').onclick = () => geoAction(g => { g.flipH = !g.flipH; }, 'Flip horizontal');
$('flip-v').onclick = () => geoAction(g => { g.flipV = !g.flipV; }, 'Flip vertical');
$('geo-reset').onclick = () => geoAction(g => Object.assign(g, defaultGeo()), 'Reset geometry');
$('aspect').addEventListener('change', () => geoAction(g => { g.aspect = $('aspect').value; g.crop = fullCrop(); fitCrop(g); }, 'Aspect'));

for (const id of Object.keys(GEO_CONTROLS)) {
  const el = $(id);
  el.addEventListener('input', () => { GEO_CONTROLS[id](state.geo, el.value); syncUI(); render(); });
  el.addEventListener('change', () => { GEO_CONTROLS[id](state.geo, el.value); syncUI(); render(); commit('Crop & frame'); });
}

for (const id of Object.keys(LAYER_CONTROLS)) {
  const el = $(id);
  el.addEventListener('input', () => { const ts = targets(); if (!ts.length) return; ts.forEach(L => LAYER_CONTROLS[id](L, el.value)); syncUI(); render(); });
  el.addEventListener('change', () => { const ts = targets(); if (!ts.length) return; ts.forEach(L => LAYER_CONTROLS[id](L, el.value)); syncUI(); render(); commit('Layer ' + id.slice(4)); });
}
$('lay-name').addEventListener('change', () => {
  const L = sel(); if (!requireUnlocked(L)) return;
  const v = $('lay-name').value.trim();
  if (v) { L.name = v; afterChange('Rename layer'); }
});
$('lay-visible').addEventListener('change', () => { const v = $('lay-visible').checked; selectedLayers().forEach(L => { L.visible = v; }); afterChange('Visibility'); });
$('lay-lock').addEventListener('change', () => { const v = $('lay-lock').checked; selectedLayers().forEach(L => { L.locked = v; }); afterChange('Lock'); });
$('lay-mask-invert').addEventListener('change', () => {
  const L = sel(); if (!requireUnlocked(L) || !L.mask) return;
  L.maskInvert = $('lay-mask-invert').checked;
  afterChange('Invert mask');
});

$('lay-add-image').onclick = () => $('add-input').click();
$('lay-add-adjust').onclick = addAdjust;
$('lay-up').onclick = () => moveSel(1);
$('lay-down').onclick = () => moveSel(-1);
$('lay-dup').onclick = dupSel;
$('lay-del').onclick = delSel;
$('mask-add').onclick = addMask;
$('mask-remove').onclick = removeMask;
$('mask-linear').onclick = () => gradientMask('linear');
$('mask-radial').onclick = () => gradientMask('radial');
$('mask-edit').onclick = () => { state.maskMode = !state.maskMode; syncUI(); render(); };

const view = $('overlay');
view.addEventListener('pointerdown', e => {
  if (toolDown(e)) return;
  if (state.pickMode) { placeSelective(docPoint(e)); return; }
  if (state.cloneSrcPending) {
    state.cloneSrc = docPoint(e);
    state.cloneSrcPending = false;
    say('Clone source set. Turn on the clone brush and paint.');
    syncUI(); render();
    return;
  }
  if (!state.maskMode && !state.cloneMode) return;
  const L = sel();
  if (!requireUnlocked(L)) return;
  const pt = docPoint(e);
  if (state.cloneMode) {
    if (L.type !== 'paint') { say('Select a retouch layer first.'); return; }
    if (!state.cloneSrc) { say('Set a clone source first.'); return; }
    const below = composite(false, false, L);
    const c = copyCanvas(state.masks.get(L.paint));
    stroke = { kind: 'clone', layerId: L.id, canvas: c, ctx: c.getContext('2d'), size: +$('brush-size').value,
      hard: +$('brush-hard').value, erase: false, lx: pt.x, ly: pt.y, below,
      tmp: canvasOf(state.doc.w, state.doc.h),
      delta: { x: state.cloneSrc.x - pt.x, y: state.cloneSrc.y - pt.y } };
    state.live = { layerId: L.id, canvas: c, kind: 'paint' };
    view.setPointerCapture(e.pointerId);
    putAt(stroke, pt.x, pt.y);
    render();
    return;
  }
  if (!L.mask) { say('Add a mask to this layer first.'); return; }
  const c = copyCanvas(state.masks.get(L.mask));
  stroke = { kind: 'mask', layerId: L.id, canvas: c, ctx: c.getContext('2d'), size: +$('brush-size').value,
    hard: +$('brush-hard').value, erase: $('brush-mode').value === 'erase', lx: pt.x, ly: pt.y };
  state.live = { layerId: L.id, canvas: c, kind: 'mask' };
  view.setPointerCapture(e.pointerId);
  putAt(stroke, pt.x, pt.y);
  render();
});
view.addEventListener('pointermove', e => {
  if (toolMove(e)) return;
  if (!stroke) return;
  const pt = docPoint(e);
  strokeTo(pt.x, pt.y);
  renderSoon();
});
view.addEventListener('pointerup', e => { if (!toolUp()) finishStroke(); });
view.addEventListener('pointercancel', e => { if (!toolUp()) finishStroke(); });

for (const id of Object.keys(FX_CONTROLS)) {
  const el = $(id);
  el.addEventListener('input', () => { const L = sel(); if (!fxTarget(id, L)) return; FX_CONTROLS[id](L, el.value); syncUI(); render(); });
  el.addEventListener('change', () => { const L = sel(); if (!fxTarget(id, L)) return; FX_CONTROLS[id](L, el.value); syncUI(); render(); commit('Effects'); });
}
Object.keys(LOOKS).forEach(id => { $(id).onclick = () => applyLook(LOOKS[id]); });
$('fx-vignette').onclick = addVignette;
$('fx-selective').onclick = () => { state.maskMode = false; state.pickMode = !state.pickMode; syncUI(); render(); };

$('retouch-add').onclick = addRetouch;
$('retouch-src').onclick = () => {
  state.cloneSrcPending = true; state.maskMode = false; state.pickMode = false; state.cloneMode = false;
  say('Tap the image to choose the clone source.');
  syncUI(); render();
};
$('retouch-paint').onclick = () => {
  state.cloneMode = !state.cloneMode; state.maskMode = false; state.pickMode = false; state.cloneSrcPending = false;
  syncUI(); render();
};
$('lay-group').onclick = () => {
  const ts = selectedLayers();
  if (ts.length < 2) { say('Select two or more layers to group them.'); return; }
  const g = newId('G');
  ts.forEach(L => { L.group = g; });
  afterChange('Group layers');
};
$('lay-ungroup').onclick = () => {
  const ts = selectedLayers();
  if (!ts.some(L => L.group)) { say('The selection is not grouped.'); return; }
  ts.forEach(L => { L.group = null; });
  afterChange('Ungroup');
};
for (const [id, g, k, t] of FX_UI) {
  const el = $(id);
  const apply = () => targets().forEach(L => { if (!L.fx) L.fx = FX_DEFAULT(); L.fx[g][k] = fxRead(el, t); });
  el.addEventListener('input', () => { apply(); syncUI(); render(); });
  el.addEventListener('change', () => { apply(); syncUI(); render(); commit('Layer style'); });
}
$('fx-copy').onclick = () => {
  const L = sel();
  state.styleClip = clone(L && L.fx ? L.fx : FX_DEFAULT());
  say('Layer style copied. Select a layer and paste it.');
  syncUI();
};
$('fx-paste').onclick = () => {
  if (!state.styleClip) { say('Copy a layer style first.'); return; }
  targets().forEach(L => { L.fx = clone(state.styleClip); });
  afterChange('Paste layer style');
};
$('fx-clear').onclick = () => {
  targets().forEach(L => { L.fx = FX_DEFAULT(); });
  afterChange('Clear layer style');
};
$('tune-auto').onclick = autoTone;
['select', 'move', 'crop', 'straighten'].forEach(t => { $('tool-' + t).onclick = () => setTool(t); });
addEventListener('resize', () => { layoutCanvas(); drawOverlay(); });
$('tune-copy').onclick = () => {
  const L = sel(); if (!L || !L.params) return;
  state.tuneClip = clone(L.params);
  say('Tune copied. Select a layer and paste it.');
  syncUI();
};
$('tune-paste').onclick = () => {
  if (!state.tuneClip) return;
  targets().filter(L => L.params).forEach(L => { L.params = clone(state.tuneClip); });
  afterChange('Paste tune');
};
$('clip-toggle').onclick = toggleClip;
$('help-btn').onclick = openHelp;
$('help-close').onclick = () => $('help').close();
$('zoom-toggle').onclick = () => {
  state.actual = !state.actual;
  $('view').classList.toggle('actual', state.actual);
  $('stage').classList.toggle('actual', state.actual);
  $('zoom-toggle').textContent = state.actual ? 'Fit' : '100%';
};
$('btn-save').onclick = () => saveProject().catch(err => say('Save failed: ' + err.message));
$('btn-load').onclick = async () => {
  const id = $('project-select').value;
  if (!id) return;
  try {
    const rec = await dbDo('readonly', s => s.get(id));
    if (!rec) { say('Project not found.'); return; }
    if (!rec.history[0] || !rec.history[0].layers) { say('This project was saved by an older build and cannot be opened.'); return; }
    state.assets = new Map();
    for (const a of rec.assets) state.assets.set(a.id, await decodeAsset(a.id, a.name, a.blob));
    state.masks = new Map();
    for (const m of rec.masks || []) {
      const bmp = await createImageBitmap(m.blob);
      const c = canvasOf(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      state.masks.set(m.id, c);
    }
    state.doc = rec.doc;
    state.docName = rec.name;
    state.projectId = rec.id;
    state.history = rec.history;
    state.hIndex = rec.hIndex;
    state.maskMode = false;
    setEdit(state.history[state.hIndex]);
    state.dirty = false;
    showCanvas();
    updateUndo();
    say('Loaded ' + rec.name + '.');
  } catch (err) { say('Load failed: ' + err.message); }
};
$('btn-export-jpeg').onclick = () => exportImage('jpeg');
$('btn-export-png').onclick = () => exportImage('png');

addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
  if (e.key === '\\' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    state.showOrig = !state.showOrig;
    render(state.showOrig);
    return;
  }
  if (!(e.ctrlKey || e.metaKey)) {
    const inField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
    if (!inField && (e.key === 'j' || e.key === 'J')) { toggleClip(); return; }
    if (!inField && 'vmcs'.includes(e.key.toLowerCase()) && e.key.length === 1) {
      setTool({ v: 'select', m: 'move', c: 'crop', s: 'straighten' }[e.key.toLowerCase()]);
      return;
    }
    if (!inField && state.tool === 'move' && e.key.startsWith('Arrow')) {
      const L = sel();
      if (L && L.type === 'image' && !L.locked) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        L.x += dx / state.doc.w; L.y += dy / state.doc.h;
        e.preventDefault();
        render(); commit('Nudge layer');
      }
      return;
    }
    if (!inField && e.key === '?') { openHelp(); return; }
    if (!inField && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); delSel(); return; }
    if (state.maskMode && (e.key === '[' || e.key === ']')) {
      const s = $('brush-size');
      s.value = Math.max(1, Math.min(400, Math.round(+s.value * (e.key === ']' ? 1.15 : 0.87))));
      e.preventDefault();
    }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (k === 'e') { e.preventDefault(); exportImage('png'); }
  else if (k === 's') { e.preventDefault(); saveProject().catch(err => say('Save failed: ' + err.message)); }
  else if (k === 'd') { e.preventDefault(); dupSel(); }
  else if (k === 'a' && state.layers.length) { e.preventDefault(); setSelection(state.layers.map(L => L.id), state.selectedId || state.layers[state.layers.length - 1].id); syncUI(); }
});

setInterval(() => {
  if (state.dirty && state.doc && !stroke) saveProject().catch(err => say('Autosave failed: ' + err.message));
}, 3000);

refreshList().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
