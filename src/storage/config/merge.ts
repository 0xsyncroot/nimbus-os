// merge.ts — SPEC-501: deep merge with array-replace semantics for 6-layer config.

import type { ConfigLayer, ConfigMergeTrace, PartialNimbusConfig } from './schema.ts';

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * Deep-merge two partials. Arrays are REPLACED (higher precedence wins outright),
 * plain objects are recursively merged. Null/undefined at higher precedence is
 * treated as "no override" (we skip).
 */
function mergePair(base: Plain, higher: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, hv] of Object.entries(higher)) {
    if (hv === undefined) continue;
    const bv = base[key];
    if (isPlainObject(hv) && isPlainObject(bv)) {
      out[key] = mergePair(bv, hv);
    } else {
      out[key] = hv;
    }
  }
  return out;
}

export interface LayerInput {
  source: ConfigLayer;
  data: PartialNimbusConfig;
}

export interface MergeResult {
  merged: PartialNimbusConfig;
  trace: ConfigMergeTrace[];
}

/**
 * Merge layers from LOWEST → HIGHEST precedence.
 * Precedence order (spec §2.1): CLI > env > workspace > profile > user > defaults.
 * Caller passes `layers` sorted lowest-first: [default, user, profile, workspace, env, cli].
 */
export function mergeLayers(layers: LayerInput[]): MergeResult {
  let merged: Plain = {};
  const trace: ConfigMergeTrace[] = [];
  for (const layer of layers) {
    const higher = layer.data as Plain;
    merged = mergePair(merged, higher);
    // Walk the higher layer and emit trace entries for each concrete leaf.
    walkLeaves(higher, '', (path, value) => {
      trace.push({ field: path, value, source: layer.source });
    });
  }
  // Later trace entries for the same path overwrite earlier — keep last-write-wins.
  const byField = new Map<string, ConfigMergeTrace>();
  for (const t of trace) byField.set(t.field, t);
  return { merged: merged as PartialNimbusConfig, trace: [...byField.values()] };
}

function walkLeaves(
  node: unknown,
  pointer: string,
  visit: (path: string, value: unknown) => void,
): void {
  if (isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      const next = `${pointer}/${escapePtr(k)}`;
      if (isPlainObject(v)) walkLeaves(v, next, visit);
      else visit(next, v);
    }
  } else {
    visit(pointer || '/', node);
  }
}

function escapePtr(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}
