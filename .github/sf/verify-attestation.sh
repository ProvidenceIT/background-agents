#!/usr/bin/env bash
#
# verify-attestation.sh <image>@sha256:<digest>
#
# Exit 0 only when GitHub holds an artifact attestation for exactly this digest,
# signed for .github/workflows/sf-release.yml of this repository running on
# refs/heads/sf/main on a GitHub-hosted runner. Tags in GHCR are mutable and
# any workflow with packages: write can move them, so sf-release.yml reuses an
# existing image only after this check; anything else is rebuilt.
#
# Needs GH_TOKEN and a docker login to ghcr.io (gh reads ~/.docker/config.json).
# Repository: $GITHUB_REPOSITORY (set on Actions runners) or SF_REPOSITORY.
set -euo pipefail

ref=${1:?usage: verify-attestation.sh <image>@sha256:<digest>}
[[ "$ref" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]] || {
  echo "verify-attestation: not a digest reference: $ref" >&2
  exit 2
}
repo=${SF_REPOSITORY:-${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY or SF_REPOSITORY}}

gh attestation verify "oci://$ref" \
  --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/sf-release.yml" \
  --source-ref refs/heads/sf/main \
  --deny-self-hosted-runners \
  > /dev/null
