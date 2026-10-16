#!/usr/bin/env bash
#
# verify-attestation.sh <image>@sha256:<digest>
#
# Exit 0 only when GitHub holds an artifact attestation that
#   - names exactly this image repository AND digest as its subject (a digest that
#     was attested for another component's repository does not count), and
#   - was signed for .github/workflows/sf-release.yml of this repository running on
#     refs/heads/sf/main on a GitHub-hosted runner.
# On success it prints one line per matching attestation, "<commit>\t<event>": the
# source commit and trigger event of the sf-release run that built the image.
#
# That is not yet "this image is the build of MY commit": anything with packages:
# write can point a mutable tag at an older attested digest. sf-release.yml binds
# the reuse to the release itself: component images by their
# org.opencontainers.image.revision label (set by this workflow, covered by the
# attested digest), the sandbox by the content hash of the attested commit.
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
image=${ref%@*}
digest=${ref#*@sha256:}

json=$(gh attestation verify "oci://$ref" \
  --repo "$repo" \
  --signer-workflow "$repo/.github/workflows/sf-release.yml" \
  --source-ref refs/heads/sf/main \
  --deny-self-hosted-runners \
  --format json)

# The Fulcio certificate carries the run's commit and event (signed from the
# OIDC token); the SLSA predicate is the fallback.
out=$(jq -r --arg name "$image" --arg d "$digest" '
  .[] | .verificationResult
  | select(any(.statement.subject[]?; .name == $name and .digest.sha256 == $d))
  | [ (.signature.certificate.sourceRepositoryDigest
        // .statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit // ""),
      (.signature.certificate.buildTrigger
        // .statement.predicate.buildDefinition.internalParameters.github.event_name // "") ]
  | @tsv' <<< "$json" | sort -u)
if [[ -z "$out" ]]; then
  echo "verify-attestation: no sf-release attestation names $image@sha256:$digest as its subject" >&2
  exit 1
fi
printf '%s\n' "$out"
