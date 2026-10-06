// Entry of the single-file executable. Node 24 SEA can only start CommonJS, while the app (Ink,
// yoga-layout) needs ES modules with top-level await. So the ESM bundle travels as an asset and
// is unpacked once into ~/.salvia/app/<hash>/ and imported from there.
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const sea = require('node:sea');

// Worker threads of the app can't query node:sea: tell them they run in the packaged build.
process.env.SALVIA_PACKAGED = '1';

const code = Buffer.from(sea.getAsset('app.mjs'));
const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
const dir = join(process.env.SALVIA_HOME || join(homedir(), '.salvia'), 'app', hash);
const file = join(dir, 'app.mjs');

if (!existsSync(file) || !readFileSync(file).equals(code)) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, code);
  renameSync(tmp, file);
}

import(pathToFileURL(file).href).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
