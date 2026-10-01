/**
 * Reading the provider CLIs' sign-in output, and the environment they sign in
 * with. Pure, so the parsing is tested against the CLIs' real lines.
 */

/**
 * Variables that would make a CLI authenticate with something other than its
 * own stored login (an API key, another base URL, a token handed in by T3, a
 * cloud provider via any `CLAUDE_CODE_USE_*`), plus the retired pool's
 * routing. Removed from every CLI the move spawns.
 */
const STRIPPED_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "T3CODE_CODEX_LAUNCH_ARGS",
]);
const STRIPPED_PREFIXES = ["CLAUDE_CODE_USE_", "T3_POOL_"];

export const signInEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const stripped =
      STRIPPED_ENV.has(name) || STRIPPED_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!stripped) next[name] = value;
  }
  return next;
};

// OSC first: an OSC 8 hyperlink (ESC ] 8 ; params ; URI ST TEXT ESC ] 8 ; ; ST, where ST is
// BEL or ESC \) loses both escapes and keeps its visible TEXT.
// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Terminal output as plain text: ANSI CSI (colors, cursor) and OSC sequences removed. */
export const stripAnsi = (output: string) => output.replace(OSC, "").replace(CSI, "");

export const CLAUDE_URL_MARKER = "If the browser didn't open, visit:";
export const CODEX_URL_MARKER =
  "If your browser did not open, navigate to this URL to authenticate:";

/**
 * The sign-in page a CLI printed after `marker`, on the same or a later line.
 * Only a URL whose line has ended counts: output arrives in chunks, and a
 * chunk can end in the middle of one.
 */
export const signInUrl = (output: string, marker: string) => {
  const plain = stripAnsi(output);
  const at = plain.indexOf(marker);
  if (at < 0) return undefined;
  return /https?:\/\/\S+(?=\s)/.exec(plain.slice(at + marker.length))?.[0];
};

/** The last non-empty line of a CLI's output: on failure, usually its error. */
export const lastLine = (output: string) =>
  stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
