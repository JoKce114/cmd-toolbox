import { readFileSync } from 'node:fs';
import path from 'node:path';

const dir = 'D:/project-demo/cmd-toolbox/.test-data/grok-native-wheel-out';
const names = ['baseline', 'up-1', 'up-2', 'up-3', 'down-1', 'down-2', 'down-3'];
const screens = Object.fromEntries(
  names.map((name) => [name, readFileSync(path.join(dir, `${name}.txt`), 'utf8').split('\n').map((l) => l.replace(/\s+$/, ''))]),
);

function shift(a, b) {
  const candidates = [];
  for (let offset = -20; offset <= 20; offset += 1) {
    let matches = 0;
    const matched = [];
    for (let i = 0; i < b.length; i += 1) {
      const src = i + offset;
      if (src < 0 || src >= a.length) continue;
      if (a[src] === b[i] && a[src].trim()) {
        matches += 1;
        matched.push(i);
      }
    }
    candidates.push({ offset, matches, matched });
  }
  candidates.sort((x, y) => y.matches - x.matches);
  return candidates.slice(0, 4);
}

for (let i = 1; i < names.length; i += 1) {
  const before = screens[names[i - 1]];
  const after = screens[names[i]];
  const top = shift(before, after);
  console.log(`${names[i - 1]} -> ${names[i]}:`, top.map((c) => `offset=${c.offset} matches=${c.matches} rows=${c.matched.slice(0, 8).join(',')}`).join(' | '));
}

console.log('\n--- top 6 non-empty lines per screen ---');
for (const name of names) {
  const lines = screens[name].map((l, i) => ({ i, l })).filter((x) => x.l.trim()).slice(0, 6);
  console.log(name, JSON.stringify(lines.map((x) => `${x.i}:${x.l.trim().slice(0, 60)}`)));
}
