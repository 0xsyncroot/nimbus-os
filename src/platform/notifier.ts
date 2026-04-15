// notifier.ts — best-effort desktop toast with silent fallback (SPEC-151 T6)

import { detect } from './detect.ts';

export async function notify(title: string, body = ''): Promise<boolean> {
  if (!title) return false;
  const caps = detect();

  try {
    if (caps.os === 'darwin') return await runOsascript(title, body);
    if (caps.os === 'linux') return await runNotifySend(title, body);
    if (caps.os === 'win32') return await runBurntToast(title, body);
  } catch {
    return false;
  }
  return false;
}

async function runOsascript(title: string, body: string): Promise<boolean> {
  const escaped = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${escaped(body)}" with title "${escaped(title)}"`;
  const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'ignore', stderr: 'ignore' });
  const code = await proc.exited;
  return code === 0;
}

async function runNotifySend(title: string, body: string): Promise<boolean> {
  const proc = Bun.spawn(['notify-send', title, body], { stdout: 'ignore', stderr: 'ignore' });
  const code = await proc.exited;
  return code === 0;
}

async function runBurntToast(title: string, body: string): Promise<boolean> {
  const escape = (s: string): string => s.replace(/'/g, "''");
  const cmd = `Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text '${escape(title)}','${escape(body)}'`;
  const proc = Bun.spawn(['pwsh', '-NoProfile', '-Command', cmd], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const code = await proc.exited;
  return code === 0;
}
