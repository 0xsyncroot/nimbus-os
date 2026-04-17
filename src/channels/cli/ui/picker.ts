// picker.ts — SPEC-832: readline-backed option selector for CliUIHost.
// Numeric keys 1-9 + arrow-key navigation + abort via AbortSignal.
// Delegates to existing pickOne/confirmPick from onboard/picker.ts —
// this module is a thin adapter that maps UIIntent options to PickerItem<string>
// and maps PickOneResult back to UIResult.
//
// No Ink, no TUI framework. Reuses v0.3.15 drain + 80ms priming from pickOne.

import type { UIResult } from '../../../core/ui/index.ts';
import { pickOne, confirmPick } from '../../../onboard/picker.ts';

/** Dependencies for pickOption. Subset of process streams. */
export interface PickerDeps {
  stdin: NodeJS.ReadableStream & { setRawMode?: (raw: boolean) => unknown; isTTY?: boolean };
  stdout: NodeJS.WriteStream;
  colorEnabled: boolean;
}

/**
 * pickOption — wraps pickOne from onboard/picker.ts behind the UIHost pick intent.
 *
 * @param prompt   - display title shown above the option list
 * @param options  - array of { id, label, hint? } matching UIIntent.pick.options
 * @param signal   - AbortSignal; if aborted before resolution, returns { kind: 'cancel' }
 * @param deps     - I/O streams injected at CliUIHost creation
 */
export async function pickOption(args: {
  prompt: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  signal: AbortSignal;
  deps: PickerDeps;
}): Promise<UIResult<string>> {
  const { prompt, options, signal, deps } = args;

  if (signal.aborted) return { kind: 'cancel' };

  // Map UIIntent options → PickerItem<string>
  const items = options.map((o) => ({ value: o.id, label: o.label, hint: o.hint }));

  // Race picker against abort signal. pickOne returns the selected value or 'skip'.
  let abortResolve!: () => void;
  const abortPromise = new Promise<'abort'>((res) => {
    abortResolve = () => res('abort');
  });
  signal.addEventListener('abort', abortResolve, { once: true });

  try {
    const race = await Promise.race([
      pickOne(prompt, items, { default: 0 }, { input: deps.stdin, output: deps.stdout }),
      abortPromise,
    ]);

    if (race === 'abort' || race === 'skip') {
      return { kind: 'cancel' };
    }
    if (typeof race === 'object' && 'custom' in race) {
      // custom branch not used in UIHost pick — treat as cancel
      return { kind: 'cancel' };
    }
    return { kind: 'ok', value: race as string };
  } finally {
    signal.removeEventListener('abort', abortResolve);
  }
}

/**
 * confirmOption — wraps confirmPick from onboard/picker.ts.
 * Returns UIResult<'allow'|'deny'|'always'|'never'>.
 */
export async function confirmOption(args: {
  prompt: string;
  signal: AbortSignal;
  deps: PickerDeps;
}): Promise<UIResult<'allow' | 'deny' | 'always' | 'never'>> {
  const { prompt, signal, deps } = args;

  if (signal.aborted) return { kind: 'cancel' };

  let abortResolve!: () => void;
  const abortPromise = new Promise<'abort'>((res) => {
    abortResolve = () => res('abort');
  });
  signal.addEventListener('abort', abortResolve, { once: true });

  try {
    const race = await Promise.race([
      confirmPick(prompt, { input: deps.stdin, output: deps.stdout }),
      abortPromise,
    ]);

    if (race === 'abort') {
      return { kind: 'cancel' };
    }
    return { kind: 'ok', value: race };
  } finally {
    signal.removeEventListener('abort', abortResolve);
  }
}
