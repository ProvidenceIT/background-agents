"""Build configuration shared by recipe planning and frozen-lock validation."""

import json
from pathlib import Path
from typing import Any

IMAGE_PACKAGE = Path("packages/sandbox-images")
RUNTIME_PACKAGE = Path("packages/sandbox-runtime")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def runtime_environment(target: dict[str, str]) -> dict[str, str]:
    home = target["home"]
    prefix = f"{home}/.npm-global"
    user_bin = f"{home}/.local/bin"
    environment = {
        "HOME": home,
        "XDG_CONFIG_HOME": f"{home}/.config",
        "NODE_ENV": "development",
        "PYTHONPATH": "/app",
        "NODE_PATH": f"/opt/openinspect/tools/node_modules:{prefix}/lib/node_modules:/usr/lib/node_modules:/usr/local/lib/node_modules",
        "PATH": f"/opt/openinspect/python/bin:/opt/openinspect/node/bin:/opt/openinspect/tools/node_modules/.bin:{home}/.venv/bin:{user_bin}:{home}/.local/share/pnpm:{home}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{prefix}/bin",
        "npm_config_prefix": prefix,
        "npm_config_cache": f"{home}/.npm-cache",
        "PNPM_HOME": f"{home}/.local/share/pnpm",
        "OPENINSPECT_BIN_INSTALL_DIR": user_bin,
        "OI_SCM_CRED_CACHE_DIR": f"{home}/.cache/openinspect/scm",
    }
    if target.get("sfStack"):
        environment |= SF_STACK_ENVIRONMENT
        environment["PATH"] = f"/opt/openinspect/node-select/bin:{environment['PATH']}"
    return environment


# sf: install/sf-stack.sh. Package downloads that the egress allowlist refuses
# are skipped or pointed at the image's Chrome; ESLint and tsc on large
# workspaces need more than V8's default heap.
SF_STACK_ENVIRONMENT = {
    "PUPPETEER_SKIP_DOWNLOAD": "1",
    "PUPPETEER_EXECUTABLE_PATH": "/usr/local/bin/google-chrome",
    "CYPRESS_INSTALL_BINARY": "0",
    "NODE_OPTIONS": "--max-old-space-size=4096",
}
