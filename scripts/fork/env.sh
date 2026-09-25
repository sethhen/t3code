# Source before running any pnpm command in this fork: `source scripts/fork/env.sh`.
# Upstream requires Node ^24.13.1 and pnpm 11 (root package.json engines/packageManager).
NODE24_BIN="$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin 2>/dev/null | sort -V | tail -1)"
if [ -z "$NODE24_BIN" ]; then
  echo "scripts/fork/env.sh: install Node 24 first (nvm install 24)" >&2
  return 1 2>/dev/null || exit 1
fi
export PATH="$NODE24_BIN:$PATH"
unset -f node 2>/dev/null
hash -r
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ~/.config/husky/init.sh (sourced by the vite-plus git hooks) prepends nvm's
# default Node, which is too old for this repo. Commit with `fork_git commit ...`
# so hooks keep the Node 24 PATH above.
FORK_HOOK_XDG="${TMPDIR:-/tmp}/t3code-fork-xdg"
mkdir -p "$FORK_HOOK_XDG"
fork_git() { XDG_CONFIG_HOME="$FORK_HOOK_XDG" git "$@"; }

# The desktop build compiles native/resource-monitor with Cargo (rustup, installed
# with --no-modify-path so shell profiles stay untouched).
if [ -d "$HOME/.cargo/bin" ]; then export PATH="$HOME/.cargo/bin:$PATH"; fi
