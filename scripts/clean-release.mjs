import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(import.meta.dirname, '..', 'release');
rmSync(target, { recursive: true, force: true });
