// cancellation.ts — SPEC-301: per-tool-call cancellation scope with onAbort cleanup.

export interface CancellationScope {
  readonly signal: AbortSignal;
  onAbort(fn: () => void): void;
  dispose(): void;
}

export function createCancellationScope(parent: AbortSignal): CancellationScope {
  const ctrl = new AbortController();
  const cleanups: Array<() => void> = [];
  let disposed = false;

  const handleParent = (): void => {
    if (!ctrl.signal.aborted) ctrl.abort(parent.reason);
  };
  if (parent.aborted) {
    ctrl.abort(parent.reason);
  } else {
    parent.addEventListener('abort', handleParent, { once: true });
  }

  const runCleanups = (): void => {
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch { /* swallow */ }
    }
  };

  ctrl.signal.addEventListener('abort', runCleanups, { once: true });

  return {
    signal: ctrl.signal,
    onAbort(fn: () => void): void {
      if (disposed) return;
      if (ctrl.signal.aborted) {
        try { fn(); } catch { /* swallow */ }
        return;
      }
      cleanups.push(fn);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      parent.removeEventListener('abort', handleParent);
      cleanups.length = 0;
    },
  };
}
