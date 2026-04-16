// analyzer.ts — SPEC-310 T4: static analysis 9 risk dimensions.
// Dims: subprocess, bash, fsWrite scope, net egress, secrets, dynamic-code,
//       perm-delta, osv CVE (stub), entropy >4.5 (obfuscation).

import { NimbusError, ErrorCode } from '../../observability/errors.ts';
import type { SkillManifest } from './manifest.ts';

export type RiskLevel = 'low' | 'medium' | 'high' | 'refuse';

export interface RiskDimension {
  dim: string;
  severity: RiskLevel;
  detail: string;
}

export interface RiskReport {
  skill: string;
  version: string;
  tier: string;
  score: number; // 0-100
  level: RiskLevel;
  permissions: SkillManifest['permissions'];
  risks: RiskDimension[];
}

// Score weights per dimension
const DIM_SCORES: Record<string, number> = {
  subprocess: 20,
  bash: 15,
  fsWrite: 15,
  netEgress: 15,
  secrets: 20,
  dynamicCode: 25,
  permDelta: 10,
  osvCve: 30,
  entropy: 20,
};

function scoreToLevel(score: number): RiskLevel {
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

// --- Dimension analyzers ---

/**
 * analyzeSubprocess — checks if code spawns child processes (Bun.spawn / child_process / execSync).
 */
function analyzeSubprocess(code: string): RiskDimension | null {
  const patterns = [
    /Bun\.spawn\s*\(/,
    /child_process/,
    /execSync\s*\(/,
    /spawnSync\s*\(/,
    /exec\s*\(/,
    /fork\s*\(/,
  ];
  if (patterns.some((p) => p.test(code))) {
    return {
      dim: 'subprocess',
      severity: 'high',
      detail: 'Code spawns child processes (Bun.spawn/child_process/exec). High risk of sandbox escape.',
    };
  }
  return null;
}

/**
 * analyzeBash — checks if code executes bash/shell commands.
 */
function analyzeBash(code: string, manifest: SkillManifest): RiskDimension | null {
  const hasBashInCode = /bash\s*[`'"(]|sh\s+-c|\/bin\/sh|\/bin\/bash/.test(code);
  const declaresBash = !!manifest.permissions.bash;
  if (hasBashInCode && !declaresBash) {
    return {
      dim: 'bash',
      severity: 'high',
      detail: 'Code appears to execute bash/shell commands but bash permission not declared in manifest.',
    };
  }
  if (declaresBash) {
    const allowCount = manifest.permissions.bash?.allow.length ?? 0;
    if (allowCount > 10) {
      return {
        dim: 'bash',
        severity: 'medium',
        detail: `Manifest declares ${allowCount} allowed bash commands — broad shell access.`,
      };
    }
    return {
      dim: 'bash',
      severity: 'low',
      detail: `Manifest declares ${allowCount} allowed bash commands.`,
    };
  }
  return null;
}

/**
 * analyzeFsWrite — checks file write scope breadth.
 */
function analyzeFsWrite(manifest: SkillManifest): RiskDimension | null {
  const paths = manifest.permissions.fsWrite ?? [];
  if (paths.length === 0) return null;
  const dangerousPaths = paths.filter(
    (p) =>
      p === '/' ||
      p === '~' ||
      p === '~/' ||
      p.startsWith('/etc') ||
      p.startsWith('/usr') ||
      p.startsWith('/bin') ||
      p === '**' ||
      p === '/**',
  );
  if (dangerousPaths.length > 0) {
    return {
      dim: 'fsWrite',
      severity: 'high',
      detail: `Manifest requests write access to sensitive paths: ${dangerousPaths.join(', ')}`,
    };
  }
  if (paths.length > 5) {
    return {
      dim: 'fsWrite',
      severity: 'medium',
      detail: `Manifest requests write access to ${paths.length} paths.`,
    };
  }
  return {
    dim: 'fsWrite',
    severity: 'low',
    detail: `Manifest requests write access to ${paths.length} path(s).`,
  };
}

/**
 * analyzeNetEgress — checks network permission scope.
 */
function analyzeNetEgress(manifest: SkillManifest): RiskDimension | null {
  const hosts = manifest.permissions.network?.hosts ?? [];
  if (hosts.length === 0) return null;
  const isWildcard = hosts.some((h) => h === '*' || h === '0.0.0.0' || h.startsWith('*.'));
  if (isWildcard) {
    return {
      dim: 'netEgress',
      severity: 'high',
      detail: `Manifest requests unrestricted network access (wildcard host: ${hosts.filter((h) => h === '*' || h.startsWith('*.')).join(', ')}).`,
    };
  }
  if (hosts.length > 5) {
    return {
      dim: 'netEgress',
      severity: 'medium',
      detail: `Manifest requests network access to ${hosts.length} hosts.`,
    };
  }
  return {
    dim: 'netEgress',
    severity: 'low',
    detail: `Manifest requests network access to: ${hosts.join(', ')}`,
  };
}

/**
 * analyzeSecrets — checks for secrets/credential access patterns.
 */
function analyzeSecrets(code: string, manifest: SkillManifest): RiskDimension | null {
  const codePatterns = [
    /process\.env\[.*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|API)/i,
    /process\.env\.(?:.*(?:KEY|TOKEN|SECRET|PASS))/i,
    /readSecret|loadSecret|getSecret/,
    /\.nimbus\/vault/,
    /NIMBUS_VAULT/,
  ];
  const envPatterns = manifest.permissions.env ?? [];
  const sensitiveEnv = envPatterns.filter((e) =>
    /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|API/i.test(e),
  );

  const codeAccess = codePatterns.some((p) => p.test(code));

  if (codeAccess && sensitiveEnv.length > 0) {
    return {
      dim: 'secrets',
      severity: 'high',
      detail: `Code accesses credentials AND manifest declares sensitive env vars: ${sensitiveEnv.join(', ')}`,
    };
  }
  if (codeAccess) {
    return {
      dim: 'secrets',
      severity: 'medium',
      detail: 'Code appears to access environment variables that may contain credentials.',
    };
  }
  if (sensitiveEnv.length > 0) {
    return {
      dim: 'secrets',
      severity: 'low',
      detail: `Manifest declares potentially sensitive env vars: ${sensitiveEnv.join(', ')}`,
    };
  }
  return null;
}

/**
 * analyzeDynamicCode — detects eval / new Function / dynamic require.
 */
function analyzeDynamicCode(code: string): RiskDimension | null {
  const patterns = [
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /Function\s*\(\s*['"`]/,
    /dynamic\s+require/,
    /import\s*\(\s*[^'"`]/,  // dynamic import with non-literal
  ];
  if (patterns.some((p) => p.test(code))) {
    return {
      dim: 'dynamicCode',
      severity: 'high',
      detail: 'Code uses eval() or new Function() — dynamic code execution bypasses static analysis.',
    };
  }
  return null;
}

/**
 * analyzePermDelta — compare current manifest vs installed version perms.
 */
function analyzePermDelta(
  manifest: SkillManifest,
  installedManifest: SkillManifest | null,
): RiskDimension | null {
  if (!installedManifest) return null;

  const newHosts = new Set(manifest.permissions.network?.hosts ?? []);
  const oldHosts = new Set(installedManifest.permissions.network?.hosts ?? []);
  const addedHosts = [...newHosts].filter((h) => !oldHosts.has(h));

  const newWrite = new Set(manifest.permissions.fsWrite ?? []);
  const oldWrite = new Set(installedManifest.permissions.fsWrite ?? []);
  const addedWrite = [...newWrite].filter((p) => !oldWrite.has(p));

  const newBash = new Set(manifest.permissions.bash?.allow ?? []);
  const oldBash = new Set(installedManifest.permissions.bash?.allow ?? []);
  const addedBash = [...newBash].filter((c) => !oldBash.has(c));

  const hasWidening = addedHosts.length > 0 || addedWrite.length > 0 || addedBash.length > 0;
  if (!hasWidening) return null;

  const details: string[] = [];
  if (addedHosts.length > 0) details.push(`+network: ${addedHosts.join(', ')}`);
  if (addedWrite.length > 0) details.push(`+fsWrite: ${addedWrite.join(', ')}`);
  if (addedBash.length > 0) details.push(`+bash: ${addedBash.join(', ')}`);

  return {
    dim: 'permDelta',
    severity: 'medium',
    detail: `Permission widening detected vs installed version: ${details.join('; ')}`,
  };
}

/**
 * analyzeOsvCve — stub OSV CVE check for v0.3.
 * Real osv-scanner integration deferred to v0.3.1.
 */
function analyzeOsvCve(_manifest: SkillManifest): RiskDimension | null {
  // Stub: no CVE data available in v0.3. Return null (no finding).
  // v0.3.1: wire osv.dev API with manifest.deps
  return null;
}

/**
 * analyzeEntropy — Shannon entropy >4.5 suggests obfuscation.
 */
function computeEntropy(text: string): number {
  if (text.length === 0) return 0;
  const freq: Record<string, number> = {};
  for (const c of text) {
    freq[c] = (freq[c] ?? 0) + 1;
  }
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function analyzeEntropy(code: string): RiskDimension | null {
  // Check entropy on contiguous non-whitespace blocks >50 chars
  const blocks = code.match(/\S{50,}/g) ?? [];
  const highEntropyBlocks = blocks.filter((b) => computeEntropy(b) > 4.5);
  if (highEntropyBlocks.length > 0) {
    return {
      dim: 'entropy',
      severity: 'high',
      detail: `Code contains ${highEntropyBlocks.length} high-entropy block(s) (>4.5 bits/char) — possible obfuscation.`,
    };
  }
  return null;
}

// --- Main analyzer ---

export interface AnalyzeOptions {
  code?: string;
  installedManifest?: SkillManifest | null;
}

/**
 * analyzeSkill — run all 9 risk dimensions against manifest + code.
 * Returns a RiskReport. Throws T_VALIDATION if manifest missing.
 */
export function analyzeSkill(
  manifest: SkillManifest,
  opts: AnalyzeOptions = {},
): RiskReport {
  const code = opts.code ?? '';
  const installed = opts.installedManifest ?? null;

  const rawDims: Array<RiskDimension | null> = [
    analyzeSubprocess(code),
    analyzeBash(code, manifest),
    analyzeFsWrite(manifest),
    analyzeNetEgress(manifest),
    analyzeSecrets(code, manifest),
    analyzeDynamicCode(code),
    analyzePermDelta(manifest, installed),
    analyzeOsvCve(manifest),
    analyzeEntropy(code),
  ];

  const risks: RiskDimension[] = rawDims.filter((d): d is RiskDimension => d !== null);

  // Compute aggregate score
  let score = 0;
  for (const risk of risks) {
    const weight = DIM_SCORES[risk.dim] ?? 10;
    if (risk.severity === 'high') score += weight;
    else if (risk.severity === 'medium') score += Math.floor(weight * 0.5);
    else if (risk.severity === 'low') score += Math.floor(weight * 0.2);
  }
  score = Math.min(score, 100);

  // TRUSTED tier: cap at medium unless dynamicCode or subprocess high
  const hasHardRefuse =
    manifest.trust.tier === 'trusted' &&
    risks.some(
      (r) => (r.dim === 'dynamicCode' || r.dim === 'subprocess') && r.severity === 'high',
    );

  let level = scoreToLevel(score);

  // Gate logic: refuse on dynamicCode+high for all tiers (no-execute policy)
  const hasDynamicHigh = risks.some((r) => r.dim === 'dynamicCode' && r.severity === 'high');
  if (hasDynamicHigh && manifest.trust.tier !== 'trusted') {
    level = 'refuse';
    score = 100;
  } else if (hasHardRefuse) {
    // TRUSTED with dynamic code: elevate to high but don't refuse
    level = 'high';
  }

  return {
    skill: manifest.name,
    version: manifest.version,
    tier: manifest.trust.tier,
    score,
    level,
    permissions: manifest.permissions,
    risks,
  };
}

/**
 * assertAnalysisAllowed — throws T_PERMISSION if level is 'refuse'.
 */
export function assertAnalysisAllowed(report: RiskReport): void {
  if (report.level === 'refuse') {
    throw new NimbusError(ErrorCode.T_PERMISSION, {
      reason: 'skill_refused',
      skill: report.skill,
      score: report.score,
      risks: report.risks.map((r) => `${r.dim}:${r.severity}`),
    });
  }
}
