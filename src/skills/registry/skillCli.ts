// skillCli.ts — SPEC-310: `nimbus skill` subcommand handler.
// 8 subcommands: search, install, list, info, upgrade, revoke, reassess, audit.

import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import { logger } from '../../observability/logger.ts';
import { printError } from '../../observability/errorFormat.ts';

function printSkillHelp(): void {
  process.stdout.write(`nimbus skill — registry skill management

Usage: nimbus skill <subcommand> [args]

Subcommands:
  search [query]        Search registry for skills (all if no query)
  install <name[@ver]>  Install a skill from registry (exact version)
  list                  List installed skills
  info <name>           Show skill info (registry + installed manifest)
  upgrade <name>        Upgrade skill to latest version
  revoke <name>         Remove installed skill
  reassess <name>       Re-run risk analysis on installed skill
  audit                 Show install/revoke audit log

Flags:
  --yes                 Auto-confirm LOW risk installs (ignored for MED/HIGH)
  --json                Output JSON (list, info, audit)
  --help, -h            Show this help

`);
}

export async function runSkillCli(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === '--help' || sub === '-h') {
    printSkillHelp();
    return 0;
  }

  const hasYes = rest.includes('--yes');
  const hasJson = rest.includes('--json');
  const isTTY = process.stdin.isTTY;

  try {
    switch (sub) {
      case 'search': {
        const query = rest.filter((a) => !a.startsWith('--')).join(' ');
        const { searchIndex } = await import('./client.ts');
        const results = await searchIndex(query);
        if (hasJson) {
          process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        } else {
          if (results.length === 0) {
            process.stdout.write('No skills found.\n');
          } else {
            for (const s of results) {
              process.stdout.write(
                `  ${s.name}@${s.version}  [${s.tier.toUpperCase()}]  ${s.description}\n`,
              );
            }
          }
        }
        return 0;
      }

      case 'install': {
        const nameArg = rest.find((a) => !a.startsWith('--'));
        if (!nameArg) {
          process.stderr.write('Usage: nimbus skill install <name[@version]>\n');
          return 1;
        }
        const { installSkill } = await import('./installer.ts');
        const installed = await installSkill(nameArg, { yes: hasYes, isTTY });
        process.stdout.write(
          `Installed ${installed.name}@${installed.version} [${installed.tier}]\n`,
        );
        return 0;
      }

      case 'list': {
        const { listInstalledSkills } = await import('./installer.ts');
        const skills = await listInstalledSkills();
        if (hasJson) {
          process.stdout.write(JSON.stringify(skills, null, 2) + '\n');
        } else {
          if (skills.length === 0) {
            process.stdout.write('No skills installed.\n');
          } else {
            for (const s of skills) {
              const date = new Date(s.installedAt).toISOString().slice(0, 10);
              process.stdout.write(
                `  ${s.name}@${s.version}  [${s.tier}]  installed ${date}\n`,
              );
            }
          }
        }
        return 0;
      }

      case 'info': {
        const name = rest.find((a) => !a.startsWith('--'));
        if (!name) {
          process.stderr.write('Usage: nimbus skill info <name>\n');
          return 1;
        }
        const { getSkillInfo } = await import('./installer.ts');
        const { entry, manifest } = await getSkillInfo(name);
        if (hasJson) {
          process.stdout.write(JSON.stringify({ entry, manifest }, null, 2) + '\n');
        } else {
          process.stdout.write(`  Name:    ${entry.name}@${entry.version}\n`);
          process.stdout.write(`  Tier:    [${entry.tier.toUpperCase()}]\n`);
          process.stdout.write(`  Digest:  ${entry.bundleDigest}\n`);
          process.stdout.write(`  Installed: ${manifest ? 'yes' : 'no'}\n`);
          if (manifest) {
            process.stdout.write(`  Description: ${manifest.description}\n`);
          }
        }
        return 0;
      }

      case 'upgrade': {
        const name = rest.find((a) => !a.startsWith('--'));
        if (!name) {
          process.stderr.write('Usage: nimbus skill upgrade <name>\n');
          return 1;
        }
        const { upgradeSkill } = await import('./installer.ts');
        const installed = await upgradeSkill(name, { yes: hasYes, isTTY });
        process.stdout.write(
          `Upgraded ${installed.name} to ${installed.version}\n`,
        );
        return 0;
      }

      case 'revoke': {
        const name = rest.find((a) => !a.startsWith('--'));
        if (!name) {
          process.stderr.write('Usage: nimbus skill revoke <name>\n');
          return 1;
        }
        const { revokeSkill } = await import('./installer.ts');
        await revokeSkill(name);
        process.stdout.write(`Revoked ${name}\n`);
        return 0;
      }

      case 'reassess': {
        const name = rest.find((a) => !a.startsWith('--'));
        if (!name) {
          process.stderr.write('Usage: nimbus skill reassess <name>\n');
          return 1;
        }
        const { listInstalledSkills } = await import('./installer.ts');
        const skills = await listInstalledSkills();
        const skill = skills.find((s) => s.name === name);
        if (!skill) {
          process.stderr.write(`Skill "${name}" is not installed.\n`);
          return 1;
        }
        // Re-read manifest and analyze
        const { parseManifest } = await import('./manifest.ts');
        const { analyzeSkill } = await import('./analyzer.ts');
        const { formatRiskReport } = await import('./riskReport.ts');
        try {
          const raw = await Bun.file(skill.manifestPath).text();
          const manifest = parseManifest(JSON.parse(raw));
          const report = analyzeSkill(manifest);
          process.stdout.write(formatRiskReport(report));
        } catch (err) {
          process.stderr.write(`Failed to reassess ${name}: ${(err as Error).message}\n`);
          return 1;
        }
        return 0;
      }

      case 'audit': {
        const { listInstalledSkills } = await import('./installer.ts');
        const skills = await listInstalledSkills();
        if (hasJson) {
          process.stdout.write(JSON.stringify(skills, null, 2) + '\n');
        } else {
          process.stdout.write('Installed skills audit log:\n');
          if (skills.length === 0) {
            process.stdout.write('  (empty)\n');
          } else {
            for (const s of skills) {
              const date = new Date(s.installedAt).toISOString();
              process.stdout.write(
                `  ${date}  INSTALL  ${s.name}@${s.version}  [${s.tier}]\n`,
              );
            }
          }
        }
        return 0;
      }

      default:
        process.stderr.write(`Unknown skill subcommand: ${sub}\n`);
        printSkillHelp();
        return 1;
    }
  } catch (err) {
    if (err instanceof NimbusError) {
      printError(err, false);
      logger.debug({ err: err.toJSON() }, 'skill_cli_error');
      return 2;
    }
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    logger.error({ err: (err as Error).message }, 'skill_cli_fatal');
    return 3;
  }
}
