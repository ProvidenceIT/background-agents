#!/usr/bin/env bash
#
# Print the 12-character Kubernetes sandbox content hash (the sandbox image tag)
# of the checked-out tree, the same way on every machine.
#
# `cli.py hash` hashes file contents AND permission bits of the files on disk,
# so a checkout made under umask 002 (664 files) hashes differently from one
# under umask 022 (644 files). This script first resets the permissions of the
# hashed inputs to what git records (100644 -> 644, 100755 -> 755) and refuses
# untracked files there, so CI and a local run agree on the tag.
#
# Used by .github/workflows/sf-release.yml (jobs meta and sandbox).
#   .github/sf/sandbox-hash.sh            # prints e.g. 9028661964fe
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

roots=(packages/sandbox-runtime packages/sandbox-images packages/kubernetes-infra)

untracked=$(git ls-files --others --exclude-standard -- "${roots[@]}")
if [[ -n "$untracked" ]]; then
  echo "untracked files under the sandbox inputs would change the hash:" >&2
  echo "$untracked" >&2
  exit 1
fi

git ls-files -s -z -- "${roots[@]}" | python3 -c '
import os, sys
for record in sys.stdin.buffer.read().split(b"\0"):
    if not record:
        continue
    meta, path = record.split(b"\t", 1)
    mode = meta.split()[0]
    if mode == b"100644":
        os.chmod(path, 0o644)
    elif mode == b"100755":
        os.chmod(path, 0o755)
'

hash=$(python3 packages/sandbox-images/cli.py hash --provider kubernetes | jq -er .hash)
if [[ ! "$hash" =~ ^[0-9a-f]{64}$ ]]; then
  echo "unexpected hash output: $hash" >&2
  exit 1
fi
echo "${hash:0:12}"
