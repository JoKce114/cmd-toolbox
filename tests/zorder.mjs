import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(import.meta.dirname, '../scripts/window-zorder.ps1');

function setWindowZOrder(pid, action) {
  if (!Number(pid)) return '';
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-RootProcessId',
      String(pid),
      '-Action',
      action,
      '-WaitSeconds',
      action === 'bottom' ? '15' : '0',
    ],
    { encoding: 'utf8', timeout: 30000, windowsHide: true },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    console.log(`  [zorder] ${action} 失败：${output || result.error?.message || result.status}`);
  } else {
    console.log(`  [zorder] ${output}`);
  }
  return output;
}

export function sendToBottom(pid) {
  return setWindowZOrder(pid, 'bottom');
}

export function restoreZOrder(pid) {
  return setWindowZOrder(pid, 'restore');
}
