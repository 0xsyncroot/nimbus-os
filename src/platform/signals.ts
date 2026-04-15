// signals.ts — unified interrupt/terminate subscription primitives (SPEC-151 T4)

export type Disposable = () => void;

const interruptCbs = new Set<() => void>();
const terminateCbs = new Set<() => void>();

let interruptWired = false;
let terminateWired = false;

function wireInterrupt(): void {
  if (interruptWired) return;
  interruptWired = true;
  const handler = (): void => {
    for (const cb of interruptCbs) {
      try {
        cb();
      } catch {
        // Callbacks must not throw; swallow to preserve other subscribers.
      }
    }
  };
  process.on('SIGINT', handler);
}

function wireTerminate(): void {
  if (terminateWired) return;
  terminateWired = true;
  const handler = (): void => {
    for (const cb of terminateCbs) {
      try {
        cb();
      } catch {
        // swallow
      }
    }
  };
  process.on('SIGTERM', handler);
  if (process.platform !== 'win32') {
    process.on('SIGHUP', handler);
  }
  // Windows Ctrl+Break maps to SIGBREAK in Node/Bun.
  process.on('SIGBREAK' as NodeJS.Signals, handler);
}

export function onInterrupt(cb: () => void): Disposable {
  wireInterrupt();
  interruptCbs.add(cb);
  return () => {
    interruptCbs.delete(cb);
  };
}

export function onTerminate(cb: () => void): Disposable {
  wireTerminate();
  terminateCbs.add(cb);
  return () => {
    terminateCbs.delete(cb);
  };
}

/** Test-only: remove all subscribers without detaching the process listeners. */
export function __resetSignalSubscribers(): void {
  interruptCbs.clear();
  terminateCbs.clear();
}
