// Installers around the built executable (run `node scripts/build.mjs` first, on the target OS):
//
//   Windows   salvia-<v>-windows-x64-setup.exe (Inno Setup: per-user, adds itself to PATH) and a .zip
//   macOS     salvia-<v>-macos-<arch>.pkg (/usr/local/bin/salvia) and a .tar.gz
//   Linux     salvia_<v>_<arch>.deb (/usr/bin/salvia) and a .tar.gz
//
// Everything lands in dist/release. Tools: ISCC (Inno Setup 6), pkgbuild, dpkg-deb, tar (Windows
// 10+ has bsdtar, which also writes the .zip).
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(dist, 'release');
const stage = join(dist, 'stage');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const arch = process.arch;
const win = process.platform === 'win32';
const exe = join(dist, win ? 'salvia.exe' : 'salvia');
if (!existsSync(exe)) throw new Error(`${exe} is missing; run node scripts/build.mjs first`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const fresh = (dir) => (rmSync(dir, { recursive: true, force: true }), mkdirSync(dir, { recursive: true }), dir);
const made = [];

fresh(out);

/** salvia(.exe) plus README and license notices, in a folder named like the archive. */
function portable(name) {
  const dir = fresh(join(stage, name));
  copyFileSync(exe, join(dir, win ? 'salvia.exe' : 'salvia'));
  copyFileSync(join(root, 'README.md'), join(dir, 'README.md'));
  if (existsSync(join(dist, 'app.mjs.LEGAL.txt'))) copyFileSync(join(dist, 'app.mjs.LEGAL.txt'), join(dir, 'LEGAL.txt'));
  return dir;
}

function tarGz(name) {
  portable(name);
  const file = join(out, `${name}.tar.gz`);
  run('tar', ['-czf', file, '-C', stage, name]);
  made.push(file);
}

if (process.platform === 'win32') {
  const name = `salvia-${version}-windows-${arch}`;
  portable(name);
  const zip = join(out, `${name}.zip`);
  // Windows' own bsdtar (writes zip); Git's GNU tar may come first on PATH and can't.
  run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', stage, name]);
  made.push(zip);

  const iscc = [
    process.env.ISCC,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs\\Inno Setup 6\\ISCC.exe'),
  ].find((p) => p && existsSync(p));
  if (!iscc) {
    console.warn('Inno Setup (ISCC.exe) not found: skipping the setup .exe');
  } else {
    const iss = join(stage, 'salvia.iss');
    writeFileSync(iss, innoScript(name), 'utf8');
    run(iscc, ['/Qp', iss]);
    made.push(join(out, `${name}-setup.exe`));
  }
} else if (process.platform === 'darwin') {
  tarGz(`salvia-${version}-macos-${arch}`);
  const pkgRoot = fresh(join(stage, 'pkgroot'));
  mkdirSync(join(pkgRoot, 'usr/local/bin'), { recursive: true });
  copyFileSync(exe, join(pkgRoot, 'usr/local/bin/salvia'));
  chmodSync(join(pkgRoot, 'usr/local/bin/salvia'), 0o755);
  const pkg = join(out, `salvia-${version}-macos-${arch}.pkg`);
  run('pkgbuild', ['--root', pkgRoot, '--identifier', 'io.github.during-morning.salvia', '--version', version, '--install-location', '/', pkg]);
  made.push(pkg);
} else if (process.platform === 'linux') {
  tarGz(`salvia-${version}-linux-${arch}`);
  const debArch = { x64: 'amd64', arm64: 'arm64' }[arch] ?? arch;
  const deb = fresh(join(stage, 'deb'));
  mkdirSync(join(deb, 'DEBIAN'));
  mkdirSync(join(deb, 'usr/bin'), { recursive: true });
  mkdirSync(join(deb, 'usr/share/doc/salvia'), { recursive: true });
  copyFileSync(exe, join(deb, 'usr/bin/salvia'));
  chmodSync(join(deb, 'usr/bin/salvia'), 0o755);
  copyFileSync(join(root, 'README.md'), join(deb, 'usr/share/doc/salvia/README.md'));
  writeFileSync(
    join(deb, 'DEBIAN/control'),
    [
      'Package: salvia',
      `Version: ${version}`,
      `Architecture: ${debArch}`,
      'Maintainer: during <duringmorning2026@gmail.com>',
      'Section: video',
      'Priority: optional',
      'Homepage: https://github.com/during-morning/Salvia',
      'Description: 一个输入框搞定视频、音乐、番剧、小说下载',
      ' Terminal UI and web UI in one self-contained binary (ffmpeg included).',
      '',
    ].join('\n'),
  );
  const file = join(out, `salvia_${version}_${debArch}.deb`);
  run('dpkg-deb', ['--build', '--root-owner-group', deb, file]);
  made.push(file);
} else {
  tarGz(`salvia-${version}-${process.platform}-${arch}`);
}

rmSync(stage, { recursive: true, force: true });
console.log(`\n✓ dist/release\n${made.map((f) => `  ${f.slice(out.length + 1)}`).join('\n')}`);

/** Per-user install (no admin), Start menu entry, and the folder on the user's PATH while installed. */
function innoScript(name) {
  return `#define AppVersion "${version}"
[Setup]
AppId={{6F1D2C7A-5B8E-4E0B-9C61-0D3A9B2F7E41}
AppName=Salvia
AppVersion={#AppVersion}
AppPublisher=during
AppPublisherURL=https://github.com/during-morning/Salvia
DefaultDirName={localappdata}\\Programs\\Salvia
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ChangesEnvironment=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=${out}
OutputBaseFilename=${name}-setup
Compression=lzma2/max
SolidCompression=yes
UninstallDisplayIcon={app}\\salvia.exe
WizardStyle=modern

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "${join(stage, name, 'salvia.exe')}"; DestDir: "{app}"; Flags: ignoreversion
Source: "${join(stage, name, 'README.md')}"; DestDir: "{app}"; Flags: ignoreversion
Source: "${join(stage, name, 'LEGAL.txt')}"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{autoprograms}\\Salvia"; Filename: "{app}\\salvia.exe"

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Run]
Filename: "{app}\\salvia.exe"; Description: "Start Salvia"; Flags: nowait postinstall skipifsilent

[Code]
function NeedsAddPath(Dir: string): Boolean;
var
  Path: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then Path := '';
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Path) + ';') = 0;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Path, Dir: string;
  P: Integer;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Path) then Exit;
  Dir := ExpandConstant('{app}');
  P := Pos(';' + Uppercase(Dir), Uppercase(Path));
  if P > 0 then
  begin
    Delete(Path, P, Length(Dir) + 1);
    RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Path);
  end;
end;
`;
}
