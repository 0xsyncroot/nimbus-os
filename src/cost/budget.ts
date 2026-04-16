// budget.ts — SPEC-702 T3+T4+T5+T6: budget config + 4-mode enforcer + /budget slash.
// Synchronous check for use in agent loop before provider call.

import { z } from 'zod';
import { logger } from '../observability/logger.ts';
import { ErrorCode, NimbusError } from '../observability/errors.ts';
import type { ModelClass } from './types.ts';
import type { TokenEstimate } from './estimator.ts';
import { WARN_THRESHOLD_USD } from './estimator.ts';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export const BudgetConfigSchema = z.object({
  /** Maximum total USD spend per UTC day. 0 = always block. */
  dailyBudget: z.number().min(0),
  /** Enforcement mode (default soft-stop per spec §4). */
  mode: z.enum(['warn', 'soft-stop', 'hard-stop', 'fallback']).default('soft-stop'),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

export type BudgetDecision =
  | { action: 'proceed'; estimate: TokenEstimate }
  | { action: 'warn'; estimate: TokenEstimate; message: string }
  | { action: 'prompt'; estimate: TokenEstimate; message: string }
  | { action: 'block'; estimate: TokenEstimate; message: string }
  | { action: 'downgrade'; newModelClass: ModelClass; estimate: TokenEstimate; message: string };

export interface BudgetEnforcer {
  check(
    estimate: TokenEstimate,
    workspaceId: string,
    config: BudgetConfig,
    currentModelClass?: ModelClass,
  ): BudgetDecision;
  recordSpend(costUsd: number, workspaceId: string): void;
  resetDaily(workspaceId: string): void;
  getSpent(workspaceId: string): number;
}

// ---------------------------------------------------------------------------
// Downgrade chain (flagship → workhorse → budget)
// ---------------------------------------------------------------------------

/** Ordered downgrade chain. 'reasoning' and 'local' fall through to 'budget'. */
const DOWNGRADE_CHAIN: ModelClass[] = ['flagship', 'workhorse', 'budget'];

export function nextModelClass(current: ModelClass): ModelClass | null {
  const idx = DOWNGRADE_CHAIN.indexOf(current);
  if (idx === -1 || idx >= DOWNGRADE_CHAIN.length - 1) return null;
  return DOWNGRADE_CHAIN[idx + 1] ?? null;
}

// ---------------------------------------------------------------------------
// In-memory daily spend tracker (resets at UTC midnight)
// ---------------------------------------------------------------------------

interface DayEntry {
  dateUtc: string;
  spent: number;
}

const spendMap = new Map<string, DayEntry>();

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function getSpent(workspaceId: string): number {
  const entry = spendMap.get(workspaceId);
  if (!entry) return 0;
  if (entry.dateUtc !== todayUtc()) {
    // Midnight reset
    spendMap.delete(workspaceId);
    return 0;
  }
  return entry.spent;
}

function addSpend(workspaceId: string, costUsd: number): void {
  const today = todayUtc();
  const existing = spendMap.get(workspaceId);
  if (!existing || existing.dateUtc !== today) {
    spendMap.set(workspaceId, { dateUtc: today, spent: costUsd });
  } else {
    existing.spent += costUsd;
  }
}

function resetDaily(workspaceId: string): void {
  spendMap.delete(workspaceId);
}

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

function budgetMessage(estimate: TokenEstimate, remaining: number, dailyBudget: number): string {
  return (
    `Estimated cost: $${estimate.costMidUsd.toFixed(4)} ` +
    `(hi: $${estimate.costHiUsd.toFixed(4)}) | ` +
    `Daily budget: $${dailyBudget.toFixed(2)} | ` +
    `Remaining today: $${remaining.toFixed(4)}`
  );
}

function isOverBudget(estimate: TokenEstimate, remaining: number): boolean {
  // Over if hi-end estimate exceeds remaining OR hi >= warning threshold
  return estimate.costHiUsd > remaining || estimate.costHiUsd >= WARN_THRESHOLD_USD;
}

function checkBudget(
  estimate: TokenEstimate,
  workspaceId: string,
  config: BudgetConfig,
  currentModelClass?: ModelClass,
): BudgetDecision {
  const spent = getSpent(workspaceId);
  const remaining = Math.max(0, config.dailyBudget - spent);

  // $0 budget → always block regardless of mode.
  if (config.dailyBudget === 0) {
    logger.warn({ workspaceId }, 'budget: dailyBudget=0, blocking turn');
    return {
      action: 'block',
      estimate,
      message: 'Daily budget is $0.00 — all turns are blocked. Set a budget with `/budget $X`.',
    };
  }

  const over = isOverBudget(estimate, remaining);
  const msg = budgetMessage(estimate, remaining, config.dailyBudget);

  switch (config.mode) {
    case 'warn': {
      if (over) {
        logger.warn({ workspaceId, costHi: estimate.costHiUsd, remaining }, 'budget: warn');
        return { action: 'warn', estimate, message: `⚠ Budget warning: ${msg}` };
      }
      return { action: 'proceed', estimate };
    }

    case 'soft-stop': {
      if (over) {
        logger.warn({ workspaceId, costHi: estimate.costHiUsd, remaining }, 'budget: soft-stop → prompt');
        return {
          action: 'prompt',
          estimate,
          message: `Budget limit approaching. Proceed? ${msg}`,
        };
      }
      return { action: 'proceed', estimate };
    }

    case 'hard-stop': {
      if (estimate.costHiUsd > remaining) {
        logger.warn({ workspaceId, costHi: estimate.costHiUsd, remaining }, 'budget: hard-stop → block');
        throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
          reason: 'budget_hard_stop',
          costHiUsd: estimate.costHiUsd,
          remaining,
          dailyBudget: config.dailyBudget,
          message: `Hard-stop: estimated cost $${estimate.costHiUsd.toFixed(4)} exceeds remaining budget $${remaining.toFixed(4)}.`,
        });
      }
      return { action: 'proceed', estimate };
    }

    case 'fallback': {
      if (!over) return { action: 'proceed', estimate };

      const current: ModelClass = currentModelClass ?? 'flagship';
      const next = nextModelClass(current);
      if (next !== null) {
        logger.info(
          { workspaceId, from: current, to: next, costHi: estimate.costHiUsd },
          'budget: fallback — downgrading model class',
        );
        return {
          action: 'downgrade',
          newModelClass: next,
          estimate,
          message: `Budget fallback: downgrading from ${current} → ${next}. ${msg}`,
        };
      }
      // Already at budget class and still over → soft-stop (spec §2.1)
      logger.warn({ workspaceId, remaining }, 'budget: fallback exhausted → prompt');
      return {
        action: 'prompt',
        estimate,
        message: `Budget fallback exhausted (already at budget class). Proceed? ${msg}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// BudgetEnforcer factory
// ---------------------------------------------------------------------------

export function createBudgetEnforcer(): BudgetEnforcer {
  return {
    check(estimate, workspaceId, config, currentModelClass): BudgetDecision {
      return checkBudget(estimate, workspaceId, config, currentModelClass);
    },
    recordSpend(costUsd, workspaceId): void {
      addSpend(workspaceId, costUsd);
    },
    resetDaily(workspaceId): void {
      resetDaily(workspaceId);
    },
    getSpent(workspaceId): number {
      return getSpent(workspaceId);
    },
  };
}

export const budgetEnforcer: BudgetEnforcer = createBudgetEnforcer();

// ---------------------------------------------------------------------------
// /budget $X slash parser
// ---------------------------------------------------------------------------

export interface BudgetSlashResult {
  dailyBudget: number;
  /** Null means user did not supply a mode — caller should prompt. */
  mode: BudgetConfig['mode'] | null;
}

const BUDGET_RE = /^\s*\/budget\s+\$?([\d]+(?:\.[\d]{1,2})?)\s*(?:(warn|soft-stop|hard-stop|fallback)\s*)?$/i;

/**
 * Parse a `/budget $X [mode]` slash command string.
 * Returns parsed result or throws NimbusError on invalid input.
 */
export function parseBudgetSlash(input: string): BudgetSlashResult {
  const match = BUDGET_RE.exec(input);
  if (!match) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'invalid_budget_slash',
      input,
      help: 'Usage: /budget $X [warn|soft-stop|hard-stop|fallback]',
    });
  }
  const amount = parseFloat(match[1]!);
  if (isNaN(amount) || amount < 0) {
    throw new NimbusError(ErrorCode.U_BAD_COMMAND, {
      reason: 'invalid_budget_amount',
      input,
    });
  }
  const modeRaw = match[2]?.toLowerCase() ?? null;
  const mode = modeRaw
    ? (BudgetConfigSchema.shape.mode.parse(modeRaw) as BudgetConfig['mode'])
    : null;

  return { dailyBudget: amount, mode };
}

// ---------------------------------------------------------------------------
// Testing hooks
// ---------------------------------------------------------------------------

export function __resetBudgetState(): void {
  spendMap.clear();
}
