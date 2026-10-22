#!/usr/bin/env bash
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
export PATH="/opt/openinspect/node/bin:$PATH"
mkdir -p /opt/openinspect/tools /app/opencode-deps /opt/openinspect/code-server
cp "$OI_BUNDLE/packages/sandbox-images/locks/tools/"package*.json /opt/openinspect/tools/
cd /opt/openinspect/tools
npm ci --ignore-scripts --no-audit --no-fund
# Run only the explicitly reviewed native binary installers. npm's lifecycle defaults differ by substrate.
node node_modules/opencode-ai/postinstall.mjs
node node_modules/bun/install.js
# @openai/codex ships its native binary as a per-platform optional dependency
# (no install script), so the reviewed-installer list above stays unchanged.
for command in opencode codex bun bunx pnpm; do
  ln -sf "/opt/openinspect/tools/node_modules/.bin/$command" "/usr/local/bin/$command"
done
cp "$OI_BUNDLE/packages/sandbox-images/locks/plugins/"package*.json /app/opencode-deps/
(cd /app/opencode-deps && npm ci --ignore-scripts --no-audit --no-fund)
download_dir="$(mktemp -d /tmp/openinspect-tools.XXXXXX)"
trap 'rm -rf "$download_dir"' EXIT
download_checked "https://github.com/vercel-labs/agent-browser/releases/download/v$AGENT_BROWSER_VERSION/agent-browser-linux-x64" "$AGENT_BROWSER_SHA256" "$download_dir/agent-browser"
install -m 0755 "$download_dir/agent-browser" /usr/local/bin/agent-browser
# grok and agy are standalone native binaries. Their own installers and
# self-updaters are never run; the image pins the exact release artifact.
download_checked "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-$GROK_VERSION-linux-x86_64" "$GROK_SHA256" "$download_dir/grok"
install -D -m 0755 "$download_dir/grok" /opt/openinspect/grok/grok
ln -sf /opt/openinspect/grok/grok /usr/local/bin/grok
download_checked "https://storage.googleapis.com/antigravity-public/antigravity-cli/$AGY_VERSION-$AGY_BUILD/linux-x64/cli_linux_x64.tar.gz" "$AGY_SHA256" "$download_dir/agy.tar.gz"
tar -xzf "$download_dir/agy.tar.gz" -C "$download_dir" --no-same-owner antigravity
install -D -m 0755 "$download_dir/antigravity" /opt/openinspect/agy/agy
ln -sf /opt/openinspect/agy/agy /usr/local/bin/agy
download_checked "https://github.com/coder/code-server/releases/download/v$CODE_SERVER_VERSION/code-server-$CODE_SERVER_VERSION-linux-amd64.tar.gz" "$CODE_SERVER_SHA256" "$download_dir/code-server.tar.gz"
tar -xzf "$download_dir/code-server.tar.gz" -C /opt/openinspect/code-server --strip-components=1
ln -sf /opt/openinspect/code-server/bin/code-server /usr/local/bin/code-server
download_checked "https://github.com/tsl0922/ttyd/releases/download/$TTYD_VERSION/ttyd.x86_64" "$TTYD_SHA256" "$download_dir/ttyd"
install -m 0755 "$download_dir/ttyd" /usr/local/bin/ttyd
download_checked "https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/linux64/chrome-linux64.zip" "$CHROME_SHA256" "$download_dir/chrome.zip"
mkdir -p /opt/openinspect/chrome
unzip -q "$download_dir/chrome.zip" -d /opt/openinspect/chrome
ln -sf /opt/openinspect/chrome/chrome-linux64/chrome /usr/local/bin/google-chrome
