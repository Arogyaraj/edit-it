// Verifies every DOM id the scripts look up exists in index.html.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const used = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]),
  ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
]);
const missing = [...used].filter(id => !htmlIds.has(id));
if (missing.length) { console.error('Missing ids:', missing); process.exit(1); }
console.log(`ok: ${used.size} ids referenced, all present in index.html`);
