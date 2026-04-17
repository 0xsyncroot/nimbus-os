// repl.tsx — SPEC-851: Ink App composition root for the REPL.
// Stitches SPEC-840/841/842/843/846/847/848/849/852/853 components.
// Event bus subscriptions (tools.todoUpdate, ui.error) wired here, torn down on unmount.
// SIGINT: AltScreen cleanup + process.exit(0) via SPEC-849 handler (exitOnCtrlC=false here).
// NOTE: mountApp() sets exitOnCtrlC=true in app.tsx; we override signal handling below.

import React, { useState, useEffect, useCallback } from 'react';
import { Box } from 'ink';
import { mountApp } from './app.tsx';
import type { WorkspaceSummary } from './app.tsx';
import type { MountedApp } from './app.tsx';
import { Welcome, isFreshSession } from './components/Welcome.tsx';
import { StatusLine } from './components/StatusLine.tsx';
import { PromptInput } from './components/PromptInput.tsx';
import { PromptInputFooter } from './components/PromptInputFooter.tsx';
import { SlashAutocomplete } from './components/SlashAutocomplete.tsx';
import { FileRefAutocomplete } from './components/FileRefAutocomplete.tsx';
import { TaskListV2 } from './components/TaskListV2.tsx';
import { ErrorDialog } from './components/ErrorDialog.tsx';
import { useAppContext } from './app.tsx';
import { getGlobalBus } from '../../../core/events.ts';
import { TOPICS } from '../../../core/eventTypes.ts';
import type { UiErrorEvent } from '../../../core/eventTypes.ts';
import type { NimbusError } from '../../../observability/errors.ts';
import type { PermissionMode } from '../../../permissions/mode.ts';
import type { UIHost } from '../../../core/ui/index.ts';
import { createInkUIHost } from './uiHost.tsx';
import { logger } from '../../../observability/logger.ts';
import { NIMBUS_VERSION } from '../../../version.ts';

// ── Version constant ───────────────────────────────────────────────────────────
const PKG_VERSION = NIMBUS_VERSION;

// ── InkReplProps ───────────────────────────────────────────────────────────────

export interface InkReplProps {
  workspace: WorkspaceSummary;
  mode: PermissionMode;
  lastBootAt?: number;
  numStartups?: number;
  /** Absolute workspace root path for FileRefAutocomplete */
  workspaceRoot: string;
  /** Called when user submits a prompt message. */
  onSubmit: (value: string) => void;
  /** Called when user presses Ctrl-C / exits (double Ctrl-C or /exit). */
  onExit: () => void;
  /** setModalNode injected by mountReplApp for Ink UIHost. */
  setModalNode: (node: React.ReactNode) => void;
  /** Pre-flight key hint shown in Welcome area when defaultProvider has no resolvable key */
  keyHint?: string;
}

// ── InkRepl — the composition root component ──────────────────────────────────

function InkReplInner({
  lastBootAt,
  numStartups: _numStartups,
  workspaceRoot,
  onSubmit,
  onExit,
  setModalNode: _setModalNode,
  keyHint,
}: Omit<InkReplProps, 'workspace' | 'mode'>): React.ReactElement {
  const { workspace, mode, noColor, cols, rows } = useAppContext();

  // ── Welcome: shown once on fresh boot ─────────────────────────────────────
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const freshSession = isFreshSession(lastBootAt);

  // ── Slash autocomplete visibility ─────────────────────────────────────────
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [fileRefQuery, setFileRefQuery] = useState<string | null>(null);

  // ── ui.error bus subscription ─────────────────────────────────────────────
  const [uiErrors, setUiErrors] = useState<NimbusError[]>([]);

  useEffect(() => {
    const bus = getGlobalBus();
    const dispose = bus.subscribe<UiErrorEvent>(
      TOPICS.ui.error,
      (event: UiErrorEvent) => {
        // Auto-dismiss after 10 seconds
        setUiErrors((prev) => [...prev, event.error]);
        setTimeout(() => {
          setUiErrors((prev) => prev.filter((e) => e !== event.error));
        }, 10_000);
      },
    );
    return dispose;
  }, []);

  // ── Prompt submit handler ──────────────────────────────────────────────────
  const handleSubmit = useCallback((value: string) => {
    setSlashQuery(null);
    setFileRefQuery(null);
    if (!welcomeDismissed) setWelcomeDismissed(true);
    onSubmit(value);
  }, [onSubmit, welcomeDismissed]);

  // ── Prompt buffer change → drive autocomplete visibility ──────────────────
  const handleModeChange = useCallback(() => {
    // Mode changes clear autocomplete
    setSlashQuery(null);
    setFileRefQuery(null);
  }, []);

  // ── Narrow / short breakpoints (inlined per SPEC-848) ─────────────────────
  const isNarrow = cols < 80;
  const isShort = rows < 24;

  // ── Static error blocks ────────────────────────────────────────────────────
  const errorBlocks = uiErrors.map((err, idx) => (
    <ErrorDialog key={`err-${idx}`} error={err} noColor={noColor} cols={cols} />
  ));

  return (
    <Box flexDirection="column" width={cols}>
      {/* Welcome banner — shown on first boot, hidden after first submit */}
      {!welcomeDismissed && (
        <Welcome
          version={PKG_VERSION}
          freshSession={freshSession}
          noColor={noColor}
          cols={cols}
          workspace={workspace.name}
          model={workspace.defaultModel}
          keyHint={keyHint}
        />
      )}

      {/* Status line */}
      <StatusLine costToday={0} ctxPercent={0} />

      {/* Inline error dialogs */}
      {errorBlocks.length > 0 && (
        <Box flexDirection="column">
          {errorBlocks}
        </Box>
      )}

      {/* Slash autocomplete overlay — rendered above prompt when active */}
      {slashQuery !== null && (
        <SlashAutocomplete
          query={slashQuery}
          onAccept={(cmd: string) => {
            setSlashQuery(null);
            handleSubmit(cmd);
          }}
          onDismiss={() => setSlashQuery(null)}
        />
      )}

      {/* FileRef autocomplete overlay */}
      {fileRefQuery !== null && (
        <FileRefAutocomplete
          prefix={fileRefQuery}
          workspaceRoot={workspaceRoot}
          onAccept={(path: string) => {
            setFileRefQuery(null);
            handleSubmit(`@${path}`);
          }}
          onDismiss={() => setFileRefQuery(null)}
        />
      )}

      {/* Prompt input */}
      <PromptInput
        placeholder="Ask anything… (/help for commands)"
        onSubmit={(value: string, _inputMode) => {
          // Drive autocomplete from buffer
          if (value.startsWith('/')) {
            setSlashQuery(value);
            return;
          }
          if (value.startsWith('@')) {
            setFileRefQuery(value.slice(1));
            return;
          }
          handleSubmit(value);
        }}
        onCancel={onExit}
        onModeChange={handleModeChange}
      />

      {/* Footer row */}
      <PromptInputFooter
        mode={mode}
        isNarrow={isNarrow}
        isShort={isShort}
        notificationCount={0}
      />

      {/* Task list */}
      <TaskListV2 />
    </Box>
  );
}

export function InkRepl(props: InkReplProps): React.ReactElement {
  return <InkReplInner {...props} keyHint={props.keyHint} />;
}

// ── mountReplApp — entry called from repl.ts ───────────────────────────────────

export interface MountReplAppOptions {
  workspace: WorkspaceSummary;
  mode: PermissionMode;
  lastBootAt?: number;
  numStartups?: number;
  workspaceRoot: string;
  onSubmit: (value: string) => void;
  /** onExit is called when the Ink app should terminate (Ctrl-C or /exit). */
  onExit: () => void;
  /** Receives the UIHost created for the Ink path (includes canAsk for loopAdapter). */
  onUIHostReady?: (host: UIHost & { canAsk(): boolean }) => void;
  /** Pre-flight key hint shown in Welcome area when defaultProvider has no resolvable key */
  keyHint?: string;
}

/**
 * mountReplApp — mounts the full Ink REPL <App> composition.
 * Returns { waitUntilExit, unmount } — caller (repl.ts) awaits waitUntilExit().
 *
 * Flow:
 *   1. Creates inkUIHost (SPEC-851 §3).
 *   2. Mounts <App workspace mode> wrapping <InkRepl>.
 *   3. Returns MountedApp handle.
 */
export function mountReplApp(opts: MountReplAppOptions): MountedApp {
  const {
    workspace,
    mode,
    lastBootAt,
    numStartups,
    workspaceRoot,
    onSubmit,
    onExit,
    onUIHostReady,
    keyHint,
  } = opts;

  // Modal node state — shared between uiHost and the Ink tree.
  // We use a mutable ref-like container so the closure can update React state.
  let setModalNodeFn: ((node: React.ReactNode) => void) | null = null;

  function setModalNode(node: React.ReactNode): void {
    if (setModalNodeFn) setModalNodeFn(node);
    else logger.warn({}, '[SPEC-851] setModalNode called before Ink tree ready');
  }

  const inkUIHost = createInkUIHost(setModalNode);
  if (onUIHostReady) onUIHostReady(inkUIHost);

  // Modal host component — manages the modal slot with React state
  function ModalHost({ children }: { children: React.ReactNode }): React.ReactElement {
    const [modalNode, setModal] = useState<React.ReactNode>(null);

    // Wire the setter into the closure so uiHost can update it
    useEffect(() => {
      setModalNodeFn = setModal;
      return () => { setModalNodeFn = null; };
    }, []);

    return (
      <>
        {modalNode}
        {children}
      </>
    );
  }

  const mounted = mountApp({
    workspace,
    mode,
    children: (
      <ModalHost>
        <InkRepl
          workspace={workspace}
          mode={mode}
          lastBootAt={lastBootAt}
          numStartups={numStartups}
          workspaceRoot={workspaceRoot}
          onSubmit={onSubmit}
          onExit={onExit}
          setModalNode={setModalNode}
          keyHint={keyHint}
        />
      </ModalHost>
    ),
  });

  return mounted;
}
