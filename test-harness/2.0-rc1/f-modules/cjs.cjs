const require_assert = () => require('node:assert/strict');
const require_fs = () => require('node:fs');
eval(require('node:fs').readFileSync('shared.body.js', 'utf8'));
body(require('sheet-to-schema'), require('sheet-to-schema/node'), 'CJS').catch(e => { console.error(e); process.exit(1); });
