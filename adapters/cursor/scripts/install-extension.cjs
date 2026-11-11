'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const extensionSrc = path.join(root, 'extension');
const version = JSON.parse(fs.readFileSync(path.join(extensionSrc, 'package.json'), 'utf8')).version;
const target = path.join(os.homedir(), '.cursor', 'extensions', `owl-assist.cursor-token-lens-${version}`);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
copyDir(extensionSrc, target);
fs.writeFileSync(
  path.join(target, '.vsixmanifest'),
  `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="cursor-token-lens" Version="${version}" Publisher="owl-assist" />
    <DisplayName>Token Lens</DisplayName>
    <Description>Per-chat token usage panel</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`
);

const extensionsJson = path.join(os.homedir(), '.cursor', 'extensions', 'extensions.json');
let list = [];
try {
  list = JSON.parse(fs.readFileSync(extensionsJson, 'utf8'));
  if (!Array.isArray(list)) list = [];
} catch {
  list = [];
}
list = list.filter((item) => item?.identifier?.id !== 'owl-assist.cursor-token-lens');
list.push({
  identifier: { id: 'owl-assist.cursor-token-lens' },
  version,
  location: {
    $mid: 1,
    fsPath: target,
    _sep: 1,
    external: `file:///${target.replace(/\\/g, '/')}`,
    path: `/${target.replace(/\\/g, '/')}`,
    scheme: 'file',
  },
  relativeLocation: `owl-assist.cursor-token-lens-${version}`,
  metadata: {
    installedTimestamp: Date.now(),
    pinned: true,
    source: 'vsix',
  },
});
fs.writeFileSync(extensionsJson, JSON.stringify(list));

console.log(`Installed Token Lens extension to:\n${target}`);
console.log('Reload Cursor window (Developer: Reload Window) to activate.');

const cursorCmd = process.platform === 'win32' ? 'cursor.cmd' : 'cursor';
const probe = spawnSync(cursorCmd, ['--list-extensions'], { encoding: 'utf8', shell: true });
if (probe.status === 0) {
  console.log('cursor CLI available; extension will load after reload.');
}
