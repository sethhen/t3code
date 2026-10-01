/**
 * The pure parts of the move: the CLIs' sign-in output (their real lines),
 * the environment they sign in with, the id_token claims, the ids and
 * directory names an account gets, and which process is the retired pool's.
 */
import { assert, describe, it } from "@effect/vitest";

import { isOwnProxy } from "./boot.ts";
import {
  CLAUDE_URL_MARKER,
  CODEX_URL_MARKER,
  lastLine,
  signInEnv,
  signInUrl,
  stripAnsi,
} from "./cli.ts";
import { emailSlug, jwtClaims, jwtEmail, jwtPlanType, moveAccountId } from "./state.ts";

const ESC = "\u001b";
const BEL = "\u0007";
const CLAUDE_URL =
  "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=abc";
const CODEX_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=xyz";

const jwt = (claims: unknown) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

describe("sign-in output", () => {
  it("strips colors, titles and OSC 8 hyperlinks down to their text", () => {
    assert.equal(stripAnsi(`${ESC}[1m${ESC}[32mDone${ESC}[0m`), "Done");
    assert.equal(stripAnsi(`${ESC}]0;claude${BEL}ready`), "ready");
    assert.equal(
      stripAnsi(`${ESC}]8;id=1;https://a.example${ESC}\\link${ESC}]8;;${ESC}\\`),
      "link",
    );
  });

  it("finds Claude's sign-in page behind an OSC 8 hyperlink", () => {
    const output = [
      `${ESC}[2mOpening browser to sign in…${ESC}[22m`,
      `${CLAUDE_URL_MARKER} ${ESC}]8;;${CLAUDE_URL}${BEL}${CLAUDE_URL}${ESC}]8;;${BEL}`,
      "Paste code here if prompted > ",
    ].join("\n");
    assert.equal(signInUrl(output, CLAUDE_URL_MARKER), CLAUDE_URL);
  });

  it("finds Codex's sign-in page on a later line, not its callback server", () => {
    const output = [
      "Starting local login server on http://localhost:1455.",
      CODEX_URL_MARKER,
      "",
      CODEX_URL,
      "",
    ].join("\n");
    assert.equal(signInUrl(output, CODEX_URL_MARKER), CODEX_URL);
  });

  it("waits for a URL whose line hasn't ended", () => {
    assert.isUndefined(
      signInUrl(`${CODEX_URL_MARKER}\n${CODEX_URL.slice(0, 40)}`, CODEX_URL_MARKER),
    );
    assert.isUndefined(
      signInUrl("Starting local login server on http://localhost:1455.\n", CODEX_URL_MARKER),
    );
    assert.equal(signInUrl(`${CODEX_URL_MARKER}\n${CODEX_URL}\n`, CODEX_URL_MARKER), CODEX_URL);
  });

  it("reports the last non-empty line", () => {
    assert.equal(
      lastLine(`warning\n${ESC}[31mError: port 1455 is in use${ESC}[0m\n\n`),
      "Error: port 1455 is in use",
    );
    assert.isUndefined(lastLine("\n \n"));
  });
});

describe("sign-in environment", () => {
  it("drops API keys, base URLs, handed-in tokens, cloud providers and the pool's variables", () => {
    const env = signInEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_AUTH_TOKEN: "token",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18417",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "refresh",
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "http://127.0.0.1:18417/v1",
      T3CODE_CODEX_LAUNCH_ARGS: "-c model_provider=pool",
      T3_POOL_API_KEY: "pool",
      T3_POOL_KEY_FILE: "/state/pool/keys/abc",
    });
    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HOME: "/home/me",
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
    });
  });
});

describe("accounts", () => {
  it("reads the email and plan from an OpenAI id_token", () => {
    const claims = jwtClaims(
      jwt({
        email: "ann@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
      }),
    );
    assert.equal(jwtEmail(claims), "ann@example.com");
    assert.equal(jwtPlanType(claims), "pro");
    assert.equal(
      jwtEmail(jwtClaims(jwt({ "https://api.openai.com/profile": { email: "bob@example.com" } }))),
      "bob@example.com",
    );
  });

  it("treats a damaged or missing token as no claims", () => {
    assert.deepEqual(jwtClaims("not-a-jwt"), {});
    assert.deepEqual(jwtClaims("a.%%%.c"), {});
    assert.deepEqual(jwtClaims(undefined), {});
    assert.equal(jwtEmail({}), "");
    assert.equal(jwtPlanType({}), "");
  });

  it("gives an account one id and directory name whatever the email's case", () => {
    const id = moveAccountId({ provider: "claude", email: "Ann@Example.com" });
    assert.match(id, /^claude_[0-9a-f]{8}$/);
    assert.equal(moveAccountId({ provider: "claude", email: "ann@example.com" }), id);
    assert.notEqual(moveAccountId({ provider: "codex", email: "ann@example.com" }), id);
    assert.equal(emailSlug("Ann.Lee+work@Example.com"), "ann-lee-work-example-com");
    const long = emailSlug("a-very-long-mailbox-name.with.dots@a-long-company-domain.example.com");
    assert.isAtMost(long.length, 40);
    assert.notMatch(long, /-$/);
  });
});

describe("the retired pool's proxy", () => {
  it("recognises only this pool's own proxy", () => {
    const paths = { binDir: "/state/pool/bin", configPath: "/state/pool/config.yaml" };
    const own = "/state/pool/bin/7.3.17/cli-proxy-api -config /state/pool/config.yaml";
    assert.isTrue(isOwnProxy({ executable: own, commandLine: own }, paths, "darwin"));
    const gui =
      "/Users/me/Library/Application Support/com.cpa.gui/cpa-core/cli-proxy-api -config /Users/me/Library/Application Support/com.cpa.gui/cpa-core/config.yaml";
    assert.isFalse(isOwnProxy({ executable: gui, commandLine: gui }, paths, "darwin"));
    const otherConfig = "/state/pool/bin/7.3.17/cli-proxy-api -config /elsewhere/config.yaml";
    assert.isFalse(
      isOwnProxy({ executable: otherConfig, commandLine: otherConfig }, paths, "darwin"),
    );
    assert.isTrue(
      isOwnProxy(
        {
          executable: String.raw`C:\Users\Me\AppData\t3\pool\bin\7.3.17\cli-proxy-api.exe`,
          commandLine: String.raw`"C:\Users\Me\AppData\t3\pool\bin\7.3.17\cli-proxy-api.exe" -config C:\Users\Me\AppData\t3\pool\config.yaml`,
        },
        {
          binDir: String.raw`c:\users\me\appdata\t3\pool\bin`,
          configPath: String.raw`c:\users\me\appdata\t3\pool\config.yaml`,
        },
        "win32",
      ),
    );
  });
});
