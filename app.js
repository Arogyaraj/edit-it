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
  maskMode: false, pickMode: false, cloneMode: false, cloneSrcPending: false, cloneSrc: null, live: null
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
  const out = canvasOf(src.width, src.height);
  out.getContext('2d').drawImage(state.glCanvas, 0, 0);
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
      const src = tuned(full ? a.full : a.work, raw ? null : L.params);
      lc = canvasOf(D, Hd);
      const dw = L.scale * D, dh = dw * src.height / src.width;
      lc.getContext('2d').drawImage(src, L.x * D, L.y * Hd, dw, dh);
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
function compose(src, geo) {
  const [W, H] = dimsFor(geo.rot, src.width, src.height);
  const R = canvasOf(W, H), r = R.getContext('2d');
  r.translate(W / 2, H / 2);
  r.rotate(geo.rot * Math.PI / 180);
  r.scale(geo.flipH ? -1 : 1, geo.flipV ? -1 : 1);
  r.drawImage(src, -src.width / 2, -src.height / 2);
  let base = R;
  if (geo.angle) base = straightenCanvas(base, geo.angle);
  if (geo.persp && hasPersp(geo.persp)) base = perspectiveCanvas(base, geo.persp);

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
function render(raw = false) {
  if (!state.doc) return;
  // In mask edit mode the view shows document space so brush coordinates map directly.
  const useDefault = raw || state.maskMode || state.pickMode || state.cloneMode || state.cloneSrcPending;
  const out = compose(composite(false, raw), useDefault ? defaultGeo() : state.geo);
  const v = $('view');
  v.width = out.width; v.height = out.height;
  v.getContext('2d').drawImage(out, 0, 0);
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

function renderLayerList() {
  const rows = [...state.layers].reverse().map(L => {
    const tag = { adjust: '[adj]', vignette: '[vig]', paint: '[ret]' }[L.type] || '[img]';
    const flags = (L.mask ? ' (mask)' : '') + (L.visible ? '' : ' (hidden)') + (L.locked ? ' (locked)' : '');
    return `<button class="lrow${L.id === state.selectedId ? ' on' : ''}" data-id="${esc(L.id)}">${tag} ${esc(L.name)}${flags}</button>`;
  });
  $('layer-list').innerHTML = rows.join('') || '<p class="note">No layers. Open a photo to start.</p>';
}
function renderHistory() {
  $('history-list').innerHTML = state.history.map((h, i) =>
    `<button class="lrow${i === state.hIndex ? ' on' : ''}" data-h="${i}">${i}. ${esc(h.label)}</button>`).reverse().join('');
}
$('layer-list').addEventListener('click', e => {
  const b = e.target.closest('[data-id]');
  if (b) { state.selectedId = b.dataset.id; syncUI(); }
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
  const L = sel(); if (!requireUnlocked(L)) return;
  const i = state.layers.indexOf(L), j = i + d;
  if (j < 0 || j >= state.layers.length) return;
  [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
  afterChange('Move layer');
}
function dupSel() {
  const L = sel(); if (!requireUnlocked(L)) return;
  const C = clone(L);
  C.id = newId('L'); C.name = L.name + ' copy';
  insertAboveSelected(C);
  afterChange('Duplicate layer');
}
function delSel() {
  const L = sel(); if (!requireUnlocked(L)) return;
  const i = state.layers.indexOf(L);
  state.layers.splice(i, 1);
  state.selectedId = state.layers.length ? state.layers[Math.min(i, state.layers.length - 1)].id : null;
  afterChange('Delete layer');
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
function showCanvas() { $('view').hidden = false; $('empty').hidden = true; }

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
  }, jpeg ? 'image/jpeg' : 'image/png', 0.92);
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
  const L = sel(); if (!L || L.locked) return;
  L.params[k] = 0; syncUI(); render(); commit('Reset ' + LABEL[k]);
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
      const L = sel(); if (!L || L.locked) return;
      L.params[k] = +el.value; $('v-' + k).textContent = el.value; render();
    });
    el.addEventListener('change', () => commit(LABEL[k]));
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
  $('sheet-toggle').textContent = closed ? 'Show' : 'Hide';
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
  el.addEventListener('input', () => { const L = sel(); if (!requireUnlocked(L)) return; LAYER_CONTROLS[id](L, el.value); syncUI(); render(); });
  el.addEventListener('change', () => { const L = sel(); if (!requireUnlocked(L)) return; LAYER_CONTROLS[id](L, el.value); syncUI(); render(); commit('Layer ' + id.slice(4)); });
}
$('lay-name').addEventListener('change', () => {
  const L = sel(); if (!requireUnlocked(L)) return;
  const v = $('lay-name').value.trim();
  if (v) { L.name = v; afterChange('Rename layer'); }
});
$('lay-visible').addEventListener('change', () => { const L = sel(); if (L) { L.visible = $('lay-visible').checked; afterChange('Visibility'); } });
$('lay-lock').addEventListener('change', () => { const L = sel(); if (L) { L.locked = $('lay-lock').checked; afterChange('Lock'); } });
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

const view = $('view');
view.addEventListener('pointerdown', e => {
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
  if (!stroke) return;
  const pt = docPoint(e);
  strokeTo(pt.x, pt.y);
  render();
});
view.addEventListener('pointerup', finishStroke);
view.addEventListener('pointercancel', finishStroke);

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
  if (!(e.ctrlKey || e.metaKey)) {
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
});

setInterval(() => {
  if (state.dirty && state.doc && !stroke) saveProject().catch(err => say('Autosave failed: ' + err.message));
}, 3000);

refreshList().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
