// riskReport.ts — SPEC-310 T6: Risk report UX renderer + confirm prompts.
// LOW→[y/N]; MED→[y/N]+3s delay; HIGH→typed-phrase (skill name, not "yes").
// --yes flag ignored for MED/HIGH.

import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import type { RiskReport, RiskLevel } from './analyzer.ts';

const RISK_COLORS: Record<RiskLevel, string> = {
  low: '\x1b[32m',    // green
  medium: '\x1b[33m', // yellow
  high: '\x1b[31m',   // red
  refuse: '\x1b[35m', // magenta
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function colorize(text: string, level: RiskLevel): string {
  return `${RISK_COLORS[level]}${text}${RESET}`;
}

/**
 * formatRiskReport — format RiskReport as human-readable text for TTY output.
 */
export function formatRiskReport(report: RiskReport): string {
  const tierBadge = `[${report.tier.toUpperCase()}]`;
  const levelBadge = colorize(`[${report.level.toUpperCase()}]`, report.level);
  const lines: string[] = [
    ``,
    `${BOLD}Skill Risk Report${RESET}`,
    `  Name:    ${report.skill}@${report.version}`,
    `  Tier:    ${tierBadge}`,
    `  Risk:    ${levelBadge}  (score: ${report.score}/100)`,
    ``,
  ];

  if (report.risks.length === 0) {
    lines.push(`  No risk signals detected.`);
  } else {
    lines.push(`  Risk signals:`);
    for (const risk of report.risks) {
      const badge = colorize(`[${risk.severity.toUpperCase()}]`, risk.severity);
      lines.push(`    ${badge} ${risk.dim}: ${risk.detail}`);
    }
  }

  lines.push(``);
  lines.push(`  Permissions:`);
  const perms = report.permissions;
  if (perms.sideEffects) lines.push(`    sideEffects: ${perms.sideEffects}`);
  if (perms.network) lines.push(`    network: ${perms.network.hosts.join(', ')}`);
  if (perms.fsWrite?.length) lines.push(`    fsWrite: ${perms.fsWrite.join(', ')}`);
  if (perms.fsRead?.length) lines.push(`    fsRead: ${perms.fsRead.join(', ')}`);
  if (perms.bash) lines.push(`    bash: ${perms.bash.allow.join(', ')}`);
  if (perms.env?.length) lines.push(`    env: ${perms.env.join(', ')}`);

  lines.push(``);
  return lines.join('\n');
}

/**
 * readLine — read a line from stdin (used for confirm prompts).
 */
async function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const handler = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = s.indexOf('\n');
      if (nl !== -1) {
        buf += s.slice(0, nl);
        process.stdin.removeListener('data', handler);
        process.stdin.pause();
        resolve(buf.trim());
      } else {
        buf += s;
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', handler);
  });
}

/**
 * sleep — delay in ms.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ConfirmOptions {
  yes?: boolean; // --yes flag (ignored for MED/HIGH)
  isTTY?: boolean;
}

/**
 * confirmInstall — present risk report and prompt for install confirmation.
 * Throws T_PERMISSION if user declines or level is 'refuse'.
 */
export async function confirmInstall(
  report: RiskReport,
  opts: ConfirmOptions = {},
): Promise<void> {
  const { level, skill } = report;
  const isTTY = opts.isTTY ?? process.stdin.isTTY;

  if (level === 'refuse') {
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      reason: 'skill_refused',
      skill,
      detail: 'Risk level REFUSE — skill cannot be installed.',
    });
  }

  // Print report
  process.stdout.write(formatRiskReport(report));

  // TRUSTED auto-install: just print a notification banner, no confirm needed
  if (report.tier === 'trusted') {
    process.stdout.write(
      `[SKILL] auto-installing ${skill}@${report.version} (trusted)\n`,
    );
    logger.info({ skill, version: report.version }, 'skill_auto_install_trusted');
    return;
  }

  // Non-TTY: only allow LOW with --yes
  if (!isTTY) {
    if (level === 'low' && opts.yes) {
      return;
    }
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      reason: 'non_interactive_confirm_required',
      skill,
      level,
      hint: 'MED/HIGH risk skills require interactive TTY for confirmation.',
    });
  }

  if (level === 'low') {
    if (opts.yes) {
      logger.debug({ skill, level }, 'skill_confirm_yes_flag');
      return;
    }
    process.stdout.write(`Install ${skill}? [y/N] `);
    const answer = await readLine();
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      throw new NimbusError(ErrorCode.T_PERMISSION, {
        reason: 'user_declined_install',
        skill,
        level,
      });
    }
    return;
  }

  if (level === 'medium') {
    // --yes ignored for MED
    process.stdout.write(
      `${colorize('[MEDIUM RISK]', 'medium')} Install ${skill}? Waiting 3 seconds... [y/N] `,
    );
    await sleep(3_000);
    const answer = await readLine();
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      throw new NimbusError(ErrorCode.T_PERMISSION, {
        reason: 'user_declined_install',
        skill,
        level,
      });
    }
    return;
  }

  if (level === 'high') {
    // --yes ignored for HIGH; require typed skill name
    process.stdout.write(
      `${colorize('[HIGH RISK]', 'high')} To confirm, type the skill name exactly: `,
    );
    const answer = await readLine();
    if (answer !== skill) {
      throw new NimbusError(ErrorCode.T_PERMISSION, {
        reason: 'high_risk_confirm_failed',
        skill,
        typed: answer,
        hint: `You must type the skill name "${skill}" exactly to install.`,
      });
    }
    logger.warn({ skill, version: report.version }, 'skill_high_risk_confirmed');
    return;
  }
}

/**
 * printAutoInstallBanner — one-line non-blocking notification for trusted auto-installs.
 */
export function printAutoInstallBanner(skillName: string, version: string): void {
  process.stdout.write(`[SKILL] auto-installed ${skillName} v${version} (trusted)\n`);
}
