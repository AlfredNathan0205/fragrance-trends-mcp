import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ignored = new Set(['node_modules', 'dist', '.git']);
const forbidden = [
  /trendanalysis\.cplaromas\.com/gi,
  /cpl\s*aromas/gi,
  /INSTAGRAM_SESSION_ID\s*=\s*\S+/g,
  /INSTAGRAM_CSRF_TOKEN\s*=\s*\S+/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

const findings = [];
for (const path of await files(root)) {
  if (path === new URL(import.meta.url).pathname) continue;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    continue;
  }
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${relative(root, path)} matched ${pattern}`);
  }
}

if (findings.length) {
  console.error('Commercial boundary check failed:\n' + findings.map((x) => `- ${x}`).join('\n'));
  process.exit(1);
}

console.log('Commercial boundary check passed.');
