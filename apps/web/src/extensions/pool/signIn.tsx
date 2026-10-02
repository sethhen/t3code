/**
 * Sign-ins for the Accounts section: the server's `status` (the accounts the
 * retired pool left, where a new account lands, the sign-in it runs), and the
 * one sign-in that runs at a time, for a listed account (`signIn.start`), a
 * new one (`account.add`) or a signed-out account again (`account.signIn`).
 *
 * A sign-in starts only from a click (never from an effect, so a StrictMode
 * remount cannot start two), then `signIn.status` is polled until it ends. One
 * already running on the server (started before a remount, or from another
 * device) is picked up from `status`.
 */
import {
  type MoveAccount,
  type MoveProvider,
  type MoveSignInStart,
  type MoveSignInState,
  type MoveStatus,
  PoolExtension,
} from "@t3tools/contracts";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button, InlineButton } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";

import type { ExtensionCallOutcome, ExtensionClient } from "../client";
import { ACCOUNT_KIND } from "./accounts.logic";
import {
  isMoveUnsupported,
  isWholeSignInCode,
  MOVE_WAITING_TEXT,
  PARTIAL_CODE_MESSAGE,
} from "./move.logic";
import { readLocalApi, writeTextToClipboard } from "./t3";

const STATUS_POLL_MS = 10_000;
const SIGN_IN_POLL_MS = 1_500;

export type MoveClient = ExtensionClient<(typeof PoolExtension)["methods"]>;
type StatusOutcome = ExtensionCallOutcome<MoveStatus>;

/** What a sign-in signs in: a listed account, an account instance again, or (both null) a new one of `provider`. */
interface SignInSubject {
  readonly provider: MoveProvider;
  readonly account: MoveAccount | null;
  /** The instance it signs in again, and the name its row shows. */
  readonly instance: SignInInstance | null;
}

export interface SignInInstance {
  readonly id: string;
  readonly label: string;
}

type Waiting = SignInSubject & {
  readonly phase: "waiting";
  readonly signInId: string;
  /** The sign-in page, once the CLI printed it. */
  readonly url: string | null;
  readonly acceptsCode: boolean;
  /** The CLI took a pasted code; the next status reply clears this. */
  readonly checking: boolean;
};

export type SignIn =
  | (SignInSubject & { readonly phase: "starting" })
  | Waiting
  | (SignInSubject & { readonly phase: "error"; readonly message: string });

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

/** The desktop's own dialog where there is one, else the browser's. */
export async function confirmAction(question: string): Promise<boolean> {
  const api = readLocalApi();
  return api ? api.dialogs.confirm(question) : window.confirm(question);
}

/**
 * The server's `status` for one environment. Responses are sequence-gated so a
 * read sent before a skip's or cancel's answer arrived never puts back what
 * that removed.
 */
export function useMoveStatus(client: MoveClient, readOnly: boolean) {
  const [status, setStatus] = useState<MoveStatus | null>(null);
  // No sign-ins here (an official T3 server, or no permission to ask): stop asking.
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
    // Before the first answer a failure may mean "no sign-ins here"; after it, the last status stays up.
    else if (applied.current === 0 && (readOnly || isMoveUnsupported(outcome.message))) {
      setUnsupported(true);
    }
  }, [accept, client, readOnly]);

  /**
   * Runs a call that answers with the new status and shows it. The answer is
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

  return { status, unsupported, refresh, apply };
}

/** Calls `refresh` now and every 10s while `active`, skipping ticks while the page is hidden. */
export function useStatusPolling(refresh: () => Promise<void>, active: boolean) {
  useEffect(() => {
    if (!active) return;
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
  }, [active, refresh]);
}

/**
 * The one sign-in the section runs; `start`, `add` and `signInAgain` are only
 * ever called from a click. `onEnd` runs when one ends here, with the instance the account
 * became if it finished (a failed one may still have changed where the next
 * account lands).
 */
export function useSignIn(
  client: MoveClient,
  apply: (call: () => Promise<StatusOutcome>) => Promise<StatusOutcome>,
  onEnd: (instanceId: string | undefined) => void,
) {
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  // Sign-ins that ended here: late answers for them are dropped, and a status
  // read from before the end cannot bring one back.
  const ended = useRef(new Set<string>());
  const latestOnEnd = useRef(onEnd);
  useLayoutEffect(() => {
    latestOnEnd.current = onEnd;
  });

  /** Applies a sign-in's state from the server; `checking` is set when it answers a pasted code. */
  const settle = useCallback(
    (signInId: string, subject: SignInSubject, state: MoveSignInState, checking = false) => {
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
        const { instance } = subject;
        toastManager.add({
          type: "success",
          title: instance
            ? `${state.email ?? instance.label} signed in again`
            : `${state.email ?? subject.account?.email ?? ACCOUNT_KIND[subject.provider]} added`,
        });
        latestOnEnd.current(state.instanceId ?? instance?.id);
        return;
      }
      setSignIn({
        phase: "error",
        provider: subject.provider,
        account: subject.account,
        instance: subject.instance,
        message: state.message?.trim() || "Sign-in did not finish.",
      });
      latestOnEnd.current(undefined);
    },
    [],
  );

  const begin = useCallback(
    async (subject: SignInSubject, call: () => Promise<ExtensionCallOutcome<MoveSignInStart>>) => {
      setSignIn({ phase: "starting", ...subject });
      const outcome = await call();
      setSignIn(
        outcome.ok
          ? {
              phase: "waiting",
              ...subject,
              signInId: outcome.value.signInId,
              url: outcome.value.url ?? null,
              acceptsCode: outcome.value.acceptsCode,
              checking: false,
            }
          : { phase: "error", ...subject, message: outcome.message },
      );
    },
    [],
  );

  /** Signs a listed account in. */
  const start = useCallback(
    (account: MoveAccount) =>
      begin({ provider: account.provider, account, instance: null }, () =>
        client.call("signIn.start", { accountId: account.id }),
      ),
    [begin, client],
  );

  /** Signs in whichever account the browser picks, as a new account of `provider`. */
  const add = useCallback(
    (provider: MoveProvider) =>
      begin({ provider, account: null, instance: null }, () =>
        client.call("account.add", { provider }),
      ),
    [begin, client],
  );

  /** Signs a signed-out account instance in again, in its own config dir or home. */
  const signInAgain = useCallback(
    (provider: MoveProvider, instance: SignInInstance) =>
      begin({ provider, account: null, instance }, () =>
        client.call("account.signIn", { instanceId: instance.id }),
      ),
    [begin, client],
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
    async (waiting: Waiting, code: string): Promise<string | null> => {
      const outcome = await client.call("signIn.code", { signInId: waiting.signInId, code });
      if (!outcome.ok) return outcome.message;
      settle(waiting.signInId, waiting, outcome.value, true);
      return null;
    },
    [client, settle],
  );

  /**
   * Shows a sign-in the server is already running, unless one is starting or
   * waiting here or it ended here. It replaces an error (say, "Another sign-in
   * started." after another device started this one).
   */
  const adopt = useCallback((signInId: string, subject: SignInSubject) => {
    if (ended.current.has(signInId)) return;
    setSignIn((current) =>
      current === null || current.phase === "error"
        ? { phase: "waiting", ...subject, signInId, url: null, acceptsCode: false, checking: false }
        : current,
    );
  }, []);

  /** Clears a failed sign-in's message. */
  const dismiss = useCallback(() => {
    setSignIn((current) => (current?.phase === "error" ? null : current));
  }, []);

  const waiting = signIn?.phase === "waiting" ? signIn : null;
  const waitingId = waiting?.signInId ?? null;
  // Stable across url updates (they spread the state), so polling keeps its cadence.
  const waitingProvider = waiting?.provider ?? null;
  const waitingAccount = waiting?.account ?? null;
  const waitingInstance = waiting?.instance ?? null;
  useEffect(() => {
    if (waitingId === null || waitingProvider === null) return;
    const subject: SignInSubject = {
      provider: waitingProvider,
      account: waitingAccount,
      instance: waitingInstance,
    };
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) {
        const outcome = await client.call("signIn.status", { signInId: waitingId });
        if (cancelled) return;
        // A failed read (say, a dropped connection) is not the sign-in's end: keep asking.
        if (outcome.ok) settle(waitingId, subject, outcome.value);
      }
      if (!cancelled) timer = window.setTimeout(tick, SIGN_IN_POLL_MS);
    };
    // Ask right away: a start can answer already signed in, and an adopted one has no link yet.
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, settle, waitingAccount, waitingId, waitingInstance, waitingProvider]);

  return { signIn, start, add, signInAgain, cancel, submitCode, adopt, dismiss };
}

/** Under the row or group a sign-in belongs to: its browser step, or why it failed. */
export function SignInDetails({
  signIn,
  readOnly,
  onCode,
  onDismiss,
}: {
  readonly signIn: SignIn;
  readonly readOnly: boolean;
  /** Resolves to the server's message when it refused the code. */
  readonly onCode: (waiting: Waiting, code: string) => Promise<string | null>;
  readonly onDismiss: () => void;
}) {
  if (signIn.phase === "waiting") {
    return (
      <WaitingSignIn
        key={signIn.signInId}
        signIn={signIn}
        readOnly={readOnly}
        onCode={(code) => onCode(signIn, code)}
      />
    );
  }
  if (signIn.phase === "error") {
    return (
      <p role="alert" className="mt-2 text-xs break-words text-destructive-foreground">
        {signIn.message}{" "}
        <InlineButton tone="muted" onClick={onDismiss}>
          Dismiss
        </InlineButton>
      </p>
    );
  }
  return null;
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
    <div className="mt-2 grid gap-2">
      <div className="flex items-center gap-2 text-sm">
        <Spinner size="md" tone="muted" className="shrink-0" />
        <span role="status">{MOVE_WAITING_TEXT[signIn.provider]}</span>
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
