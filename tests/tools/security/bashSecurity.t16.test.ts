// tests/tools/security/bashSecurity.t16.test.ts — SPEC-303: 13 T16 persistence traces.

import { describe, expect, test } from 'bun:test';
import { checkBashCommand } from '../../../src/permissions/bashSecurity.ts';

function t16(cmd: string): void {
  const r = checkBashCommand(cmd);
  expect(r.ok).toBe(false);
  expect(r.threat).toBe('T16');
  expect(r.rule).toBe('TR-11');
}

describe('SPEC-303 T16 persistence traces (13 classes)', () => {
  test('1. .bashrc', () => t16('echo "evil" >> ~/.bashrc'));
  test('2. .zshrc', () => t16('echo "evil" >> ~/.zshrc'));
  test('3. .profile', () => t16('echo "evil" >> ~/.profile'));
  test('4. .bash_profile', () => t16('echo "evil" >> ~/.bash_profile'));
  test('5. /var/spool/cron user entry', () => t16('echo "* * * * * evil" >> /var/spool/cron/crontabs/user'));
  test('6. /etc/cron.d drop', () => t16('cp evil /etc/cron.d/evil'));
  test('7. /etc/cron.daily', () => t16('install -m 755 evil /etc/cron.daily/evil'));
  test('8. /etc/cron.hourly', () => t16('install -m 755 evil /etc/cron.hourly/evil'));
  test('9. systemd user unit', () => t16('tee ~/.config/systemd/user/evil.service'));
  test('10. systemd system unit', () => t16('tee /etc/systemd/system/evil.service'));
  test('11. macOS LaunchAgents', () => t16('cp evil.plist ~/Library/LaunchAgents/evil.plist'));
  test('12. /etc/rc.local', () => t16('echo evil >> /etc/rc.local'));
  test('13. /etc/profile.d drop', () => t16('echo "export X=1" >> /etc/profile.d/evil.sh'));
});
