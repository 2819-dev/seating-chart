// Bundles public/* + src/server.js into a single Worker script (dist/worker.js).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const files = {
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/login.html': ['public/login.html', 'text/html; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
};
const table = Object.fromEntries(Object.entries(files).map(([k, [f, t]]) => [k, { body: readFileSync(f, 'utf8'), type: t }]));
const src = `const FILES = ${JSON.stringify(table)};\n` + readFileSync('src/server.js', 'utf8');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/worker.js', src);
console.log('built dist/worker.js', src.length, 'bytes');
