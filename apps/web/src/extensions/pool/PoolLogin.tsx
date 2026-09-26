/**
 * Adding an account: `login.start` from the click (never from an effect,
 * so a StrictMode remount cannot open two browser tabs), the sign-in page in
 * the user's browser, then `login.status` polled until the proxy has the
 * account. The dialog keeps the link at hand for when the browser did not open.
 */
import type { PoolProvider } from "@t3tools/contracts";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Alert, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";

import { POOL_ACCOUNT_KIND, POOL_PROVIDER_LABEL } from "./pool.logic";
import { readLocalApi, writeTextToClipboard } from "./t3";
import type { PoolClient } from "./usePoolStatus";

const LOGIN_POLL_MS = 1_500;

export type PoolLoginState =
  | { readonly phase: "starting"; readonly provider: PoolProvider }
  | {
      readonly phase: "waiting";
      readonly provider: PoolProvider;
      readonly loginId: string;
      readonly url: string;
      readonly openFailed: boolean;
    }
  | {
      readonly phase: "error";
      readonly provider: PoolProvider;
      readonly message: string;
      readonly url?: string;
    };

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

export function usePoolLogin(client: PoolClient, onAdded: () => void) {
  const [login, setLogin] = useState<PoolLoginState | null>(null);
  // The attempt a pending await belongs to; closing or restarting retires it.
  const attempt = useRef(0);
  const latestOnAdded = useRef(onAdded);
  useLayoutEffect(() => {
    latestOnAdded.current = onAdded;
  });

  const start = useCallback(
    async (provider: PoolProvider) => {
      const id = ++attempt.current;
      setLogin({ phase: "starting", provider });
      const outcome = await client.call("login.start", { provider });
      if (attempt.current !== id) return;
      if (!outcome.ok) {
        setLogin({ phase: "error", provider, message: outcome.message });
        return;
      }
      const { loginId, url } = outcome.value;
      setLogin({ phase: "waiting", provider, loginId, url, openFailed: false });
      const opened = await openInBrowser(url);
      if (!opened && attempt.current === id) {
        setLogin((current) =>
          current?.phase === "waiting" && current.loginId === loginId
            ? { ...current, openFailed: true }
            : current,
        );
      }
    },
    [client],
  );

  const close = useCallback(() => {
    attempt.current += 1;
    setLogin(null);
  }, []);

  const loginId = login?.phase === "waiting" ? login.loginId : null;
  const provider = login?.provider ?? null;
  useEffect(() => {
    if (loginId === null || provider === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const outcome = await client.call("login.status", { loginId });
      if (cancelled) return;
      if (outcome.ok && outcome.value.state === "pending") {
        timer = window.setTimeout(tick, LOGIN_POLL_MS);
        return;
      }
      if (outcome.ok && outcome.value.state === "done") {
        attempt.current += 1;
        setLogin(null);
        toastManager.add({
          type: "success",
          title: `${POOL_ACCOUNT_KIND[provider]} added`,
          description: `${POOL_PROVIDER_LABEL[provider]} sessions can use it now.`,
        });
        latestOnAdded.current();
        return;
      }
      const message = outcome.ok
        ? outcome.value.message?.trim() || "Sign-in did not finish."
        : outcome.message;
      setLogin((current) =>
        current?.phase === "waiting" && current.loginId === loginId
          ? { phase: "error", provider, message, url: current.url }
          : current,
      );
    };
    timer = window.setTimeout(tick, LOGIN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, loginId, provider]);

  return { login, pending: login !== null, start, close };
}

export function PoolLoginDialog({
  login,
  preparing,
  onRetry,
  onClose,
}: {
  readonly login: PoolLoginState | null;
  /** Account sharing is downloading or starting, which the first sign-in waits for. */
  readonly preparing: boolean;
  readonly onRetry: (provider: PoolProvider) => void;
  readonly onClose: () => void;
}) {
  // Keyed by URL, so a new sign-in link starts without the last one's result.
  const [copy, setCopy] = useState<{ url: string; copied: boolean } | null>(null);
  // Keep the last content up while the dialog animates closed.
  const [shown, setShown] = useState(login);
  if (login !== null && login !== shown) setShown(login);
  if (shown === null) return null;

  const kind = POOL_ACCOUNT_KIND[shown.provider];
  const url = shown.phase === "starting" ? null : (shown.url ?? null);

  const copyLink = async () => {
    if (!url) return;
    try {
      await writeTextToClipboard(url, "sign-in link");
      setCopy({ url, copied: true });
    } catch {
      setCopy({ url, copied: false });
    }
  };

  return (
    <Dialog
      open={login !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a {kind}</DialogTitle>
          <DialogDescription>
            {shown.phase === "error"
              ? "The sign-in did not go through."
              : `Sign in with the ${kind} you want to add.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3">
          {shown.phase === "error" ? (
            <Alert variant="error">
              <AlertTitle className="font-normal break-words">{shown.message}</AlertTitle>
            </Alert>
          ) : (
            <div className="flex items-center gap-2.5 text-sm">
              <Spinner className="size-4 shrink-0 text-muted-foreground" />
              <span>
                {shown.phase === "waiting"
                  ? "Finish signing in with your browser…"
                  : preparing
                    ? "Getting ready. The first time takes a minute…"
                    : "Getting the sign-in page…"}
              </span>
            </div>
          )}
          {shown.phase === "waiting" ? (
            <p className="text-xs text-muted-foreground">
              {shown.openFailed
                ? "Your browser did not open. Open the sign-in page or copy the link."
                : "This closes by itself once you are signed in."}
            </p>
          ) : null}
          {url && shown.phase === "waiting" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" variant="outline" onClick={() => void openInBrowser(url)}>
                <ExternalLinkIcon aria-hidden />
                Open sign-in page
              </Button>
              <Button size="xs" variant="outline" onClick={() => void copyLink()}>
                <CopyIcon aria-hidden />
                {copy?.url === url && copy.copied ? "Copied" : "Copy link"}
              </Button>
              {copy?.url === url && !copy.copied ? (
                <span className="text-xs text-destructive-foreground">
                  Could not copy the link.
                </span>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            {shown.phase === "error" ? "Close" : "Cancel"}
          </Button>
          {shown.phase === "error" ? (
            <Button onClick={() => onRetry(shown.provider)}>Try again</Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
