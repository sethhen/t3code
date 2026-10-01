/**
 * "Sign your accounts in again", above the provider list in Settings →
 * Providers. The retired pool left the list of accounts it held; each row signs
 * one in with Claude Code's or Codex's own login on the environment the page
 * shows, where it becomes a normal provider instance. The section shows only
 * while the list has accounts, and never on a server without one.
 *
 * A sign-in starts only from a click (never from an effect, so a StrictMode
 * remount cannot start two), then `signIn.status` is polled until it ends. One
 * runs at a time; one already running on the server (started before a remount,
 * or from another device) is picked up from `status`.
 */
import {
  type EnvironmentId,
  type MoveAccount,
  type MoveSignInState,
  type MoveStatus,
  PoolExtension,
} from "@t3tools/contracts";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";

import { type ExtensionCallOutcome, type ExtensionClient, useExtensionClient } from "../client";
import {
  isMoveUnsupported,
  isWholeSignInCode,
  MOVE_DRIVER,
  MOVE_PROVIDER_LABEL,
  MOVE_WAITING_TEXT,
  moveTargetHint,
  orderMoveAccounts,
  PARTIAL_CODE_MESSAGE,
} from "./move.logic";
import {
  ProviderInstanceIcon,
  readLocalApi,
  RedactedSensitiveText,
  SettingsSection,
  writeTextToClipboard,
} from "./t3";

const STATUS_POLL_MS = 10_000;
const SIGN_IN_POLL_MS = 1_500;

type MoveClient = ExtensionClient<(typeof PoolExtension)["methods"]>;
type StatusOutcome = ExtensionCallOutcome<MoveStatus>;

type Waiting = {
  readonly phase: "waiting";
  readonly account: MoveAccount;
  readonly signInId: string;
  /** The sign-in page, once the CLI printed it. */
  readonly url: string | null;
  readonly acceptsCode: boolean;
  /** The CLI took a pasted code; the next status reply clears this. */
  readonly checking: boolean;
};

type SignIn =
  | { readonly phase: "starting"; readonly account: MoveAccount }
  | Waiting
  | { readonly phase: "error"; readonly account: MoveAccount; readonly message: string };

/** Desktop opens the system browser through the shell bridge; the web build opens a tab. */
async function openInBrowser(url: string): Promise<boolean> {
  try {
    const api = readLocalApi();
    if (api) await api.shell.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}

/**
 * The account list for one environment, read on mount and every 10s while the
 * page is visible, until it is empty. Responses are sequence-gated so a read
 * sent before a skip's or cancel's answer arrived never puts back what that
 * removed.
 */
function useMoveStatus(client: MoveClient, readOnly: boolean) {
  const [status, setStatus] = useState<MoveStatus | null>(null);
  // No list here (an official T3 server, or no permission to read it): stop asking.
  const [unsupported, setUnsupported] = useState(false);
  const sequence = useRef(0);
  const applied = useRef(0);

  const accept = useCallback((id: number, next: MoveStatus) => {
    if (id < applied.current) return;
    applied.current = id;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    const outcome = await client.call("status", {});
    if (outcome.ok) accept(id, outcome.value);
    // Before the first answer a failure may mean "no list here"; after it, the last list stays up.
    else if (applied.current === 0 && (readOnly || isMoveUnsupported(outcome.message))) {
      setUnsupported(true);
    }
  }, [accept, client, readOnly]);

  /**
   * Runs a call that answers with the new list and shows it. The answer is
   * numbered when it arrives, so a read sent before then cannot hide it.
   */
  const apply = useCallback(
    async (call: () => Promise<StatusOutcome>): Promise<StatusOutcome> => {
      const outcome = await call();
      if (outcome.ok) accept(++sequence.current, outcome.value);
      return outcome;
    },
    [accept],
  );

  const polling = !unsupported && (status === null || status.accounts.length > 0);
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (!cancelled) timer = window.setTimeout(tick, STATUS_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [polling, refresh]);

  return { status, refresh, apply };
}

/** The one sign-in this section runs; `start` is only ever called from a click. */
function useSignIn(
  client: MoveClient,
  refresh: () => Promise<void>,
  apply: (call: () => Promise<StatusOutcome>) => Promise<StatusOutcome>,
) {
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  // Sign-ins that ended here: late answers for them are dropped, and a list
  // read from before the end cannot bring one back.
  const ended = useRef(new Set<string>());

  /** Applies a sign-in's state from the server; `checking` is set when it answers a pasted code. */
  const settle = useCallback(
    (signInId: string, account: MoveAccount, state: MoveSignInState, checking = false) => {
      if (ended.current.has(signInId)) return;
      if (state.state === "waiting") {
        const { url, acceptsCode } = state;
        setSignIn((current) =>
          current?.phase === "waiting" && current.signInId === signInId
            ? { ...current, url: url ?? current.url, acceptsCode, checking }
            : current,
        );
        return;
      }
      ended.current.add(signInId);
      if (state.state === "done") {
        setSignIn(null);
        toastManager.add({ type: "success", title: `${state.email ?? account.email} signed in` });
        void refresh();
        return;
      }
      setSignIn({
        phase: "error",
        account,
        message: state.message?.trim() || "Sign-in did not finish.",
      });
    },
    [refresh],
  );

  const start = useCallback(
    async (account: MoveAccount) => {
      setSignIn({ phase: "starting", account });
      const outcome = await client.call("signIn.start", { accountId: account.id });
      setSignIn(
        outcome.ok
          ? {
              phase: "waiting",
              account,
              signInId: outcome.value.signInId,
              url: outcome.value.url ?? null,
              acceptsCode: outcome.value.acceptsCode,
              checking: false,
            }
          : { phase: "error", account, message: outcome.message },
      );
    },
    [client],
  );

  const cancel = useCallback(
    async (signInId: string) => {
      ended.current.add(signInId);
      setSignIn(null);
      const outcome = await apply(() => client.call("signIn.cancel", { signInId }));
      if (!outcome.ok) {
        toastManager.add({
          type: "error",
          title: "Could not cancel the sign-in",
          description: outcome.message,
        });
      }
    },
    [apply, client],
  );

  /**
   * Hands Claude's CLI a pasted code. Answers with the server's message when it
   * refused the code; the sign-in keeps waiting and polling either way.
   */
  const submitCode = useCallback(
    async (signInId: string, account: MoveAccount, code: string): Promise<string | null> => {
      const outcome = await client.call("signIn.code", { signInId, code });
      if (!outcome.ok) return outcome.message;
      settle(signInId, account, outcome.value, true);
      return null;
    },
    [client, settle],
  );

  /**
   * Shows a sign-in the server is already running, unless one is starting or
   * waiting here or it ended here. It replaces an error (say, "Another sign-in
   * started." after another device started this one).
   */
  const adopt = useCallback((signInId: string, account: MoveAccount) => {
    if (ended.current.has(signInId)) return;
    setSignIn((current) =>
      current === null || current.phase === "error"
        ? { phase: "waiting", account, signInId, url: null, acceptsCode: false, checking: false }
        : current,
    );
  }, []);

  const waiting = signIn?.phase === "waiting" ? signIn : null;
  const waitingId = waiting?.signInId ?? null;
  // Stable across url updates (they spread the state), so polling keeps its cadence.
  const waitingAccount = waiting?.account ?? null;
  useEffect(() => {
    if (waitingId === null || waitingAccount === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) {
        const outcome = await client.call("signIn.status", { signInId: waitingId });
        if (cancelled) return;
        // A failed read (say, a dropped connection) is not the sign-in's end: keep asking.
        if (outcome.ok) settle(waitingId, waitingAccount, outcome.value);
      }
      if (!cancelled) timer = window.setTimeout(tick, SIGN_IN_POLL_MS);
    };
    // Ask right away: a start can answer already signed in, and an adopted one has no link yet.
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, settle, waitingAccount, waitingId]);

  return { signIn, start, cancel, submitCode, adopt };
}

export function MoveAccounts({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const client = useExtensionClient(PoolExtension, environmentId);
  const { status, refresh, apply } = useMoveStatus(client, readOnly);
  const { signIn, start, cancel, submitCode, adopt } = useSignIn(client, refresh, apply);
  // The account whose skip runs; every Skip waits for it.
  const [skipping, setSkipping] = useState<string | null>(null);

  const running = status?.signIn;
  const runningAccount = running
    ? status?.accounts.find((account) => account.id === running.accountId)
    : undefined;
  useEffect(() => {
    if (running && runningAccount) adopt(running.signInId, runningAccount);
  }, [adopt, running, runningAccount]);

  if (!status || status.accounts.length === 0) return null;
  const signInRunning = signIn?.phase === "starting" || signIn?.phase === "waiting";

  const skip = async (account: MoveAccount) => {
    const question = `Skip ${account.email}? It leaves this list for good. You can still add it later in the provider settings below.`;
    const api = readLocalApi();
    if (!(api ? await api.dialogs.confirm(question) : window.confirm(question))) return;
    setSkipping(account.id);
    const outcome = await apply(() => client.call("skip", { accountId: account.id }));
    setSkipping(null);
    if (!outcome.ok) {
      toastManager.add({
        type: "error",
        title: "Could not skip the account",
        description: outcome.message,
      });
    }
  };

  return (
    <SettingsSection title="Sign your accounts in again">
      <div className="space-y-1 px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <p>
          Account sharing was removed. Each account now signs in with Claude's or OpenAI's own
          sign-in and becomes a normal account below.
        </p>
        <p>Before each one, make sure your browser is signed in to that account.</p>
      </div>
      {orderMoveAccounts(status.accounts).map((account) => {
        const own = signIn?.account.id === account.id ? signIn : null;
        return (
          <AccountRow
            key={account.id}
            account={account}
            signIn={own}
            readOnly={readOnly}
            signInBlocked={signInRunning && own === null}
            skipping={skipping === account.id}
            skipBlocked={skipping !== null}
            onSignIn={() => void start(account)}
            onSkip={() => void skip(account)}
            onCancel={(signInId) => void cancel(signInId)}
            onCode={(signInId, code) => submitCode(signInId, account, code)}
          />
        );
      })}
    </SettingsSection>
  );
}

function AccountRow({
  account,
  signIn,
  readOnly,
  signInBlocked,
  skipping,
  skipBlocked,
  onSignIn,
  onSkip,
  onCancel,
  onCode,
}: {
  readonly account: MoveAccount;
  /** This account's sign-in, if it has one. */
  readonly signIn: SignIn | null;
  readonly readOnly: boolean;
  /** Another account's sign-in is running. */
  readonly signInBlocked: boolean;
  readonly skipping: boolean;
  /** Some account's skip is running. */
  readonly skipBlocked: boolean;
  readonly onSignIn: () => void;
  readonly onSkip: () => void;
  readonly onCancel: (signInId: string) => void;
  /** Resolves to the server's message when it refused the code. */
  readonly onCode: (signInId: string, code: string) => Promise<string | null>;
}) {
  const starting = signIn?.phase === "starting";
  const label = MOVE_PROVIDER_LABEL[account.provider];
  // Names the account for screen readers; the email on screen may be blurred.
  const who = `${label} account ${account.email}`;
  const signInText = signIn?.phase === "error" ? "Retry" : "Sign in";
  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex items-center gap-3">
        <ProviderInstanceIcon
          driverKind={MOVE_DRIVER[account.provider]}
          displayName={label}
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <RedactedSensitiveText
              value={account.email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="max-w-full truncate text-foreground"
            />
            {account.plan ? (
              <span className="shrink-0 text-xs text-muted-foreground">{account.plan}</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{moveTargetHint(account)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {signIn?.phase === "waiting" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={readOnly}
              aria-label={`Cancel signing in ${who}`}
              onClick={() => onCancel(signIn.signInId)}
            >
              Cancel
            </Button>
          ) : (
            <>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={readOnly || starting || skipBlocked}
                aria-label={`Skip ${who}`}
                onClick={onSkip}
              >
                {skipping ? <Spinner /> : null}
                Skip
              </Button>
              <Button
                size="xs"
                disabled={readOnly || starting || signInBlocked || skipping}
                aria-label={`${signInText} ${who}`}
                onClick={onSignIn}
              >
                {starting ? <Spinner /> : null}
                {signInText}
              </Button>
            </>
          )}
        </div>
      </div>
      {signIn?.phase === "waiting" ? (
        <WaitingSignIn
          key={signIn.signInId}
          signIn={signIn}
          readOnly={readOnly}
          onCode={(code) => onCode(signIn.signInId, code)}
        />
      ) : null}
      {signIn?.phase === "error" ? (
        <p role="alert" className="mt-2 ms-8 text-xs break-words text-destructive-foreground">
          {signIn.message}
        </p>
      ) : null}
    </div>
  );
}

/** The browser step: the page to finish on, and Claude's paste-the-code box. */
function WaitingSignIn({
  signIn,
  readOnly,
  onCode,
}: {
  readonly signIn: Waiting;
  readonly readOnly: boolean;
  readonly onCode: (code: string) => Promise<string | null>;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const { url } = signIn;

  const open = async (link: string) => {
    if (await openInBrowser(link)) return;
    toastManager.add({
      type: "error",
      title: "Could not open your browser",
      description: "Copy the link instead.",
    });
  };
  const copy = async (link: string) => {
    try {
      await writeTextToClipboard(link, "sign-in link");
      setCopiedUrl(link);
    } catch {
      toastManager.add({ type: "error", title: "Could not copy the link" });
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed === "" || submitting) return;
    // The CLI would only print a complaint and keep waiting; say it here instead.
    if (!isWholeSignInCode(trimmed)) {
      setCodeError(PARTIAL_CODE_MESSAGE);
      return;
    }
    setCodeError(null);
    setSubmitting(true);
    const refused = await onCode(trimmed);
    setSubmitting(false);
    if (refused === null) setCode("");
    else setCodeError(refused);
  };

  return (
    <div className="mt-2 ms-8 grid gap-2">
      <div className="flex items-center gap-2 text-sm">
        <Spinner size="md" tone="muted" className="shrink-0" />
        <span role="status">{MOVE_WAITING_TEXT[signIn.account.provider]}</span>
      </div>
      {url ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => void open(url)}>
            <ExternalLinkIcon aria-hidden />
            Open sign-in page
          </Button>
          <Button size="xs" variant="outline" onClick={() => void copy(url)}>
            <CopyIcon aria-hidden />
            {copiedUrl === url ? "Copied" : "Copy link"}
          </Button>
        </div>
      ) : null}
      {signIn.acceptsCode ? (
        <form className="flex max-w-md items-center gap-2" onSubmit={(event) => void submit(event)}>
          <Input
            size="compact"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setCodeError(null);
            }}
            placeholder="Paste the code from the sign-in page"
            aria-label="Paste the code from the sign-in page"
            autoComplete="off"
            spellCheck={false}
            disabled={readOnly || submitting}
          />
          <Button type="submit" size="sm" disabled={readOnly || submitting || code.trim() === ""}>
            {submitting ? <Spinner /> : null}
            Submit
          </Button>
        </form>
      ) : null}
      {codeError ? (
        <p role="alert" className="text-xs break-words text-destructive-foreground">
          {codeError}
        </p>
      ) : signIn.checking ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking the code…
        </p>
      ) : null}
    </div>
  );
}
