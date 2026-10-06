// Build the single-file executable: node scripts/build.mjs [--skip-web] [--no-exe]
//
//   1. vite build             packages/web → packages/web/dist
//   2. esbuild                packages/cli/src/entry.ts → dist/app.mjs (everything bundled, ESM)
//   3. Node SEA blob          scripts/sea-loader.cjs + assets (app.mjs, gzipped ffmpeg, web UI, book sources)
//   4. postject               copy of node.exe + blob → dist/salvia(.exe)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// SALVIA_DIST builds elsewhere, e.g. while dist/salvia.exe is running and locked.
const dist = process.env.SALVIA_DIST ? join(root, process.env.SALVIA_DIST) : join(root, 'dist');
const args = new Set(process.argv.slice(2));
const require = createRequire(import.meta.url);
const exeName = process.platform === 'win32' ? 'salvia.exe' : 'salvia';

const step = (msg) => console.log(`\n▸ ${msg}`);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

if (!args.has('--skip-web')) {
  step('web: vite build');
  run('npm run build -w @salvia/web', []);
}

step('bundle: esbuild');
// ESM, because Ink and yoga-layout use top-level await. `require` is provided for bundled CJS
// dependencies that load Node built-ins.
await esbuild.build({
  entryPoints: [join(root, 'packages/cli/src/entry.ts')],
  outfile: join(dist, 'app.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'external',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      // WebTorrent's optional native parts (WebRTC via node-datachannel, uTP) can't load from a
      // single-file build. Without them it uses TCP peers, DHT, trackers and web seeds.
      name: 'stub-native-bt',
      setup(b) {
        b.onResolve({ filter: /^(webrtc-polyfill|utp-native)$/ }, (a) => ({ path: a.path, namespace: 'stub-bt' }));
        b.onLoad({ filter: /.*/, namespace: 'stub-bt' }, (a) =>
          a.path === 'utp-native'
            ? { contents: 'module.exports = {};', loader: 'js' }
            : { contents: 'export const RTCPeerConnection = undefined, RTCSessionDescription = undefined, RTCIceCandidate = undefined; export default {};' },
        );
      },
    },
    {
      // Ink imports React DevTools statically from a dev-only module; ship an empty stand-in.
      name: 'stub-devtools',
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} };' }));
      },
    },
  ],
  banner: { js: "import { createRequire as __salviaCreateRequire } from 'node:module'; const require = __salviaCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log(`  dist/app.mjs ${(statSync(join(dist, 'app.mjs')).size / 1e6).toFixed(1)} MB`);

if (args.has('--no-exe')) {
  // Runnable as `node dist/app.mjs` (ffmpeg comes from the ffmpeg-static package then).
  cpSync(join(root, 'packages/web/dist'), join(dist, 'web'), { recursive: true });
  cpSync(join(root, 'sources'), join(dist, 'sources'), { recursive: true });
  process.exit(0);
}

step('assets');
const assets = { 'app.mjs': join(dist, 'app.mjs') };
const assetDir = join(dist, 'assets');
mkdirSync(assetDir, { recursive: true });

// ffmpeg, compressed: about half the size; unpacked once on first use and verified by hash.
const ffmpeg = require('ffmpeg-static');
const ffBin = readFileSync(ffmpeg);
writeFileSync(join(assetDir, 'ffmpeg.gz'), gzipSync(ffBin, { level: 9 }));
writeFileSync(join(assetDir, 'ffmpeg.sha256'), createHash('sha256').update(ffBin).digest('hex'));
assets['ffmpeg.gz'] = join(assetDir, 'ffmpeg.gz');
assets['ffmpeg.sha256'] = join(assetDir, 'ffmpeg.sha256');
console.log(`  ffmpeg ${(ffBin.length / 1e6).toFixed(0)} MB → ${(statSync(assets['ffmpeg.gz']).size / 1e6).toFixed(0)} MB`);

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const webDist = join(root, 'packages/web/dist');
if (!existsSync(webDist)) throw new Error('packages/web/dist is missing; run without --skip-web');
for (const file of walk(webDist)) assets[`web/${relative(webDist, file).split('\\').join('/')}`] = file;
for (const file of walk(join(root, 'sources')).filter((f) => f.endsWith('.json'))) assets[`sources/${relative(join(root, 'sources'), file).split('\\').join('/')}`] = file;
console.log(`  ${Object.keys(assets).length} assets`);

step('sea blob');
const seaConfig = join(dist, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({ main: join(root, 'scripts/sea-loader.cjs'), output: join(dist, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2),
);
run(process.execPath, ['--experimental-sea-config', seaConfig], { shell: false });

step('executable');
const exe = join(dist, exeName);
copyFileSync(process.execPath, exe);
const postject = join(root, 'node_modules/postject/dist/cli.js');
const injectArgs = [postject, exe, 'NODE_SEA_BLOB', join(dist, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, injectArgs, { shell: false });

for (const f of ['sea-prep.blob', 'sea-config.json']) rmSync(join(dist, f), { force: true });
rmSync(assetDir, { recursive: true, force: true });
console.log(`\n✓ ${relative(root, exe)} ${(statSync(exe).size / 1e6).toFixed(0)} MB`);
