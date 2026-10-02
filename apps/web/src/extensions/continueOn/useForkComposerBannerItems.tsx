/**
 * "Continue on…" in the composer's notices. When a Claude or Codex thread
 * stopped on its account's usage limit, the user picks another of their
 * accounts that shares this conversation store; T3 moves the thread there and
 * continues. Nothing moves until that click. ChatView passes its banner items
 * through `useForkComposerBannerItems` (a host seam), which hands back the same
 * array while there is nothing to add.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  UnifiedSettings,
} from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix, createModelSelection } from "@t3tools/shared/model";
import { GaugeIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";

import {
  accountName,
  candidateSummary,
  CONTINUE_PROMPT,
  CONTINUE_PROVIDER_LABEL,
  type ContinueCandidate,
  continueCandidates,
  holdQueueForMove,
  releaseQueueAfterMove,
  usageLimitStop,
} from "./continueOn.logic";
import {
  appAtomRegistry,
  applyProviderInstanceSettings,
  buildThreadTurnInterruptInput,
  type ComposerBannerStackItem,
  deriveProviderInstanceEntries,
  EMPTY_SERVER_PROVIDERS,
  environmentThreadShells,
  getComposerProviderState,
  isProviderInstancePickerReady,
  newMessageId,
  type ProviderInstanceEntry,
  readThread,
  RedactedSensitiveText,
  resolveAppModelSelectionForInstance,
  resolveThreadMetadataUpdateForNextTurn,
  serverEnvironment,
  threadEnvironment,
  useComposerDraftStore,
  useEnvironmentSettings,
  useQueuedMessageStore,
  useThread,
} from "./t3";

/** How long the session may take to stop the paused turn, or to pick up the new one. */
const SESSION_TIMEOUT_MS = 30_000;

/**
 * Dismissed stops, by thread and stop. Module-level so a dismissal survives
 * ChatView remounting (switching threads and back), like ThreadErrorBanner's.
 */
const dismissedStopKeys = new Set<string>();

async function run<W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

/**
 * Resolves true once `done` holds for the thread's shell (where its session
 * lives), false if it still doesn't after `SESSION_TIMEOUT_MS`.
 */
function waitForShell(
  threadRef: ScopedThreadRef,
  done: (shell: EnvironmentThreadShell) => boolean,
): Promise<boolean> {
  const shellAtom = environmentThreadShells.threadShellAtom(threadRef);
  const check = () => {
    const shell = appAtomRegistry.get(shellAtom);
    return shell !== null && done(shell);
  };
  if (check()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), SESSION_TIMEOUT_MS);
    const unsubscribe = appAtomRegistry.subscribe(shellAtom, () => {
      if (check()) finish(true);
    });
    if (check()) finish(true);
  });
}

/**
 * Moves the thread to `target` and continues it there, the way picking the
 * account in the model picker and sending would. The model and options are
 * resolved for the target before anything changes. Resolves once the session
 * picked the new turn up, so the old stop cannot show again in between.
 */
async function continueOnAccount(input: {
  readonly threadRef: ScopedThreadRef;
  readonly target: ProviderInstanceEntry;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
}): Promise<void> {
  const { threadRef, target, settings, providers } = input;
  const { environmentId, threadId } = threadRef;
  const thread = readThread(threadRef);
  if (thread === null) throw new Error("This thread is not loaded.");
  // `selection` on the target: its model where the target offers it, else the
  // target's default, with the options the composer would keep for that model.
  const forTarget = (selection: ModelSelection) => {
    const model = resolveAppModelSelectionForInstance(
      target.instanceId,
      settings,
      providers,
      selection.model,
    );
    if (model === null) return null;
    const { modelOptionsForDispatch, promptEffort } = getComposerProviderState({
      provider: target.driverKind,
      model,
      models: target.models,
      modelOptions: selection.options,
      planModeEnabled: settings.planModeEnabled,
    });
    return {
      modelSelection: createModelSelection(target.instanceId, model, modelOptionsForDispatch),
      promptEffort,
    };
  };
  const next = forTarget(thread.modelSelection);
  if (next === null) throw new Error("That account has no model to continue with.");
  const { modelSelection, promptEffort } = next;

  // Queued messages and the composer follow the pick, so nothing sent from
  // here on goes back to the limited account. The queue holds until the
  // target picked the new turn up, so nothing races it; after a failure it
  // stays held and Send now still works.
  const threadKey = scopedThreadKey(threadRef);
  const queues = useQueuedMessageStore.getState().queuesByThreadKey;
  const hold = holdQueueForMove(
    queues,
    threadKey,
    (selection) => forTarget(selection)?.modelSelection ?? modelSelection,
  );
  if (hold.queuesByThreadKey !== queues) {
    useQueuedMessageStore.setState({ queuesByThreadKey: hold.queuesByThreadKey });
  }
  const draftStore = useComposerDraftStore.getState();
  const draft = draftStore.getComposerDraft(threadRef);
  // The selection the composer shows, picked the way it picks one.
  const draftSelection =
    draft?.modelSelectionByProvider[
      draft.activeProvider ?? thread.session?.providerInstanceId ?? thread.modelSelection.instanceId
    ] ?? thread.modelSelection;
  draftStore.setModelSelection(
    threadRef,
    forTarget(draftSelection)?.modelSelection ?? modelSelection,
    { explicit: true, replaceOptions: true },
  );

  // A paused turn is still running on the limited account.
  if (thread.session?.status === "running") {
    await run(threadEnvironment.interruptTurn, {
      environmentId,
      input: buildThreadTurnInterruptInput(thread),
    });
    if (!(await waitForShell(threadRef, (shell) => shell.session?.status !== "running"))) {
      throw new Error(
        "The paused turn hasn't stopped yet. Once it stops, send a message: the composer already uses the account you picked.",
      );
    }
  }

  const current = readThread(threadRef) ?? thread;
  const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
    currentModelSelection: current.modelSelection,
    nextModelSelection: modelSelection,
    currentBranch: current.branch,
  });
  if (metadataUpdate) {
    await run(threadEnvironment.updateMetadata, {
      environmentId,
      input: { threadId, ...metadataUpdate },
    });
  }
  await run(threadEnvironment.startTurn, {
    environmentId,
    input: {
      threadId,
      message: {
        messageId: newMessageId(),
        role: "user",
        text: applyClaudePromptEffortPrefix(CONTINUE_PROMPT, promptEffort),
        attachments: [],
      },
      modelSelection,
      runtimeMode: current.runtimeMode,
      interactionMode: current.interactionMode,
      createdAt: new Date().toISOString(),
    },
  });
  // The turn start is accepted. A failed stop still reads as one until the
  // target's session starts the new turn (or that turn ends), so wait for
  // that. "starting" may still name the old session while it is alive, so
  // only the target's own counts. A slow start past the timeout is not an
  // error; the queue just stays held.
  const stoppedTurnId = thread.latestTurn?.turnId ?? null;
  const started = await waitForShell(threadRef, (shell) => {
    const session = shell.session;
    return (
      session?.providerInstanceId === target.instanceId &&
      (session.status === "starting" ||
        session.status === "running" ||
        (shell.latestTurn?.turnId ?? null) !== stoppedTurnId)
    );
  });
  if (started && hold.held.size > 0) {
    useQueuedMessageStore.setState((state) => {
      const queuesByThreadKey = releaseQueueAfterMove(
        state.queuesByThreadKey,
        threadKey,
        hold.held,
      );
      return queuesByThreadKey === state.queuesByThreadKey ? state : { queuesByThreadKey };
    });
  }
}

/** An address stays blurred until clicked, as in the usage-limits notice. */
function AccountName({ name }: { readonly name: string }) {
  return name.includes("@") ? (
    <RedactedSensitiveText
      key={name}
      value={name}
      ariaLabel="Toggle account visibility"
      revealTooltip="Click to reveal account"
      hideTooltip="Click to hide account"
      className="max-w-full truncate align-bottom font-sans text-xs leading-normal text-inherit"
    />
  ) : (
    name
  );
}

/** The accounts to pick from, each with its plan and the quota it has left. */
function ContinueOnPicker({
  candidates,
  onPick,
}: {
  readonly candidates: ReadonlyArray<ContinueCandidate>;
  readonly onPick: (target: ProviderInstanceEntry) => void;
}) {
  // Reset times are read when the picker opens; nothing ticks while it is open.
  const [now, setNow] = useState(0);
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) setNow(Date.now());
      }}
    >
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>Continue on…</PopoverTrigger>
      <PopoverPopup
        aria-label="Accounts that can continue this thread"
        side="top"
        align="end"
        padding="compact"
        width="md"
      >
        <p className="pb-1 text-xs text-muted-foreground">
          The first reply re-reads this thread on the account you pick.
        </p>
        <ul className="flex flex-col">
          {candidates.map((candidate) => (
            <li key={candidate.entry.instanceId} className="flex items-center gap-2 py-1.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="min-w-0 truncate text-xs">
                  <AccountName name={accountName(candidate.entry)} />
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {candidateSummary(candidate, now)}
                </span>
              </div>
              <Button size="xs" variant="outline" onClick={() => onPick(candidate.entry)}>
                Continue
              </Button>
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * ChatView's composer notices plus "Continue on…" while the thread's account
 * is stopped on its usage limit and another of the user's accounts can take
 * it. Returns `items` itself when it adds nothing.
 */
export function useForkComposerBannerItems(
  items: ComposerBannerStackItem[],
  { environmentId, threadId }: { environmentId: EnvironmentId; threadId: ThreadId },
): ComposerBannerStackItem[] {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const threadKey = scopedThreadKey(threadRef);
  // Draft threads have no shell yet; waiting for it keeps them from fetching a detail.
  const thread = useThread(threadRef, { waitForShell: true });
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(environmentId);
  const [moving, setMoving] = useState<{ threadKey: string; account: string } | null>(null);
  // Dismissing only adds to `dismissedStopKeys`; the tick re-renders.
  const [, setDismissTick] = useState(0);

  const session = thread?.session ?? null;
  const latestTurn = thread?.latestTurn ?? null;
  const activities = thread?.activities;
  const messages = thread?.messages;
  const stop = useMemo(
    () =>
      activities && messages ? usageLimitStop({ session, latestTurn, activities, messages }) : null,
    [activities, latestTurn, messages, session],
  );
  // New for every stop, so dismissing one does not hide the next.
  const stopKey = stop ? `${threadKey}:${stop.key}` : null;
  const dismissed = stopKey !== null && dismissedStopKeys.has(stopKey);

  const entries = useMemo(
    () => applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    [providers, settings],
  );
  const currentInstanceId = session?.providerInstanceId ?? thread?.modelSelection.instanceId;
  const current = useMemo(
    () =>
      entries.find(
        (entry) =>
          entry.instanceId === currentInstanceId &&
          CONTINUE_PROVIDER_LABEL[entry.driverKind] !== undefined,
      ) ?? null,
    [currentInstanceId, entries],
  );
  const candidates = useMemo(
    () =>
      current === null
        ? []
        : continueCandidates(entries.filter(isProviderInstancePickerReady), current),
    [current, entries],
  );

  const pick = useCallback(
    (target: ProviderInstanceEntry) => {
      setMoving({ threadKey, account: accountName(target) });
      continueOnAccount({ threadRef, target, settings, providers })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not continue this thread",
            description: error instanceof Error ? error.message : "Try again.",
          });
        })
        // A move started since on another thread keeps its own busy state.
        .finally(() => setMoving((now) => (now?.threadKey === threadKey ? null : now)));
    },
    [providers, settings, threadKey, threadRef],
  );
  const item = useMemo<ComposerBannerStackItem | null>(() => {
    // The stop clears as soon as the paused turn is interrupted, before the move
    // finishes, so the move shows on its own until the turn starts.
    if (moving?.threadKey === threadKey) {
      return {
        id: `continue-on:${threadKey}`,
        variant: "info",
        priority: "activity",
        icon: <Spinner />,
        title: (
          <>
            Continuing on <AccountName name={moving.account} />…
          </>
        ),
      };
    }
    // Without another account to pick there is nothing to offer here.
    if (stopKey === null || current === null || dismissed || candidates.length === 0) return null;
    return {
      id: `continue-on:${threadKey}`,
      variant: "warning",
      priority: "urgent",
      icon: <GaugeIcon />,
      title: (
        <>
          <AccountName name={accountName(current)} /> reached its usage limit.
        </>
      ),
      actions: <ContinueOnPicker candidates={candidates} onPick={pick} />,
      dismissLabel: "Dismiss usage limit notice",
      onDismiss: () => {
        dismissedStopKeys.add(stopKey);
        setDismissTick((tick) => tick + 1);
      },
    };
  }, [candidates, current, dismissed, moving, pick, stopKey, threadKey]);

  return useMemo(() => (item === null ? items : [...items, item]), [item, items]);
}
