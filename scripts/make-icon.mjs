import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'scripts', 'icon.svg'), 'utf8');
const buildDirectory = join(root, 'build');
mkdirSync(buildDirectory, { recursive: true });

function render(size) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0, 0, 0, 0)',
  }).render();
}

// All-PNG frames keep the ICO small and are accepted by rcedit when it patches
// the Electron executable's resources.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = sizes.map((size) => render(size).asPng());

writeFileSync(join(buildDirectory, 'icon.png'), render(512).asPng());

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);

const directory = Buffer.alloc(frames.length * 16);
let offset = 6 + directory.length;
for (const [index, frame] of frames.entries()) {
  const size = sizes[index];
  const entry = index * 16;
  directory.writeUInt8(size >= 256 ? 0 : size, entry);
  directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
  directory.writeUInt8(0, entry + 2);
  directory.writeUInt8(0, entry + 3);
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frame.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
}

writeFileSync(join(buildDirectory, 'icon.ico'), Buffer.concat([header, directory, ...frames]));

console.log(`icon.png (512) and icon.ico (${sizes.join(', ')}) written to build/`);
