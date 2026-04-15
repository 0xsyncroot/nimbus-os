// modelRouter.ts — SPEC-106: class → (providerId, modelId) with runtime override.

import { ErrorCode, NimbusError } from '../observability/errors.ts';
import {
  DEFAULT_ROUTING,
  MAX_ROUTING_ENTRIES,
  MODEL_CLASSES,
  ModelRoutingSchema,
  type ModelClass,
  type ModelRouting,
  type ResolvedModel,
} from './modelClasses.ts';

let activeRouting: ModelRouting = { ...DEFAULT_ROUTING };
const overrides = new Map<ModelClass, ResolvedModel>();

export function routeModel(cls: ModelClass): ResolvedModel {
  if (!MODEL_CLASSES.includes(cls)) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'unknown_model_class',
      cls: String(cls),
    });
  }
  const override = overrides.get(cls);
  if (override) return override;
  const entry = activeRouting[cls];
  if (!entry) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'missing_class_in_routing',
      cls,
    });
  }
  return entry;
}

export function setOverride(cls: ModelClass, resolved: ResolvedModel): void {
  if (!MODEL_CLASSES.includes(cls)) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, { reason: 'unknown_model_class', cls });
  }
  overrides.set(cls, resolved);
}

export function clearOverride(cls: ModelClass): void {
  overrides.delete(cls);
}

export function loadRoutingFromConfig(
  routing: ModelRouting,
  knownProviders?: ReadonlySet<string>,
): void {
  const parsed = ModelRoutingSchema.safeParse(routing);
  if (!parsed.success) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'invalid_routing',
      issues: parsed.error.issues.map((i) => i.message),
    });
  }
  const entries = Object.entries(parsed.data);
  if (entries.length > MAX_ROUTING_ENTRIES) {
    throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
      reason: 'routing_too_large',
      size: entries.length,
    });
  }
  if (knownProviders) {
    for (const [cls, res] of entries) {
      if (!res) continue;
      if (!knownProviders.has(res.providerId)) {
        throw new NimbusError(ErrorCode.S_CONFIG_INVALID, {
          reason: 'unknown_provider',
          provider: res.providerId,
          cls,
        });
      }
    }
  }
  activeRouting = parsed.data as ModelRouting;
}

export function currentRouting(): ModelRouting {
  return { ...activeRouting };
}

export function resetRouting(): void {
  activeRouting = { ...DEFAULT_ROUTING };
  overrides.clear();
}
