#!/usr/bin/env bash
#
# Decides whether a `deliver/*` pull request carries only work that is already on `workspace`.
#
# The logic lives in a file so the CI job that exercises it (`check-delivery.test.sh`) runs the same
# bytes `action.yml` runs, instead of a copy that can drift from it.
#
# Reads from the environment:
#   BASE_SHA       the pull request's base commit (the tip of `develop` the delivery targets)
#   HEAD_SHA       the pull request's head commit (the tip of the `deliver/*` branch)
#   WORKSPACE_REF  the ref that holds `workspace`; defaults to `origin/workspace`
#
# Every commit in BASE_SHA..HEAD_SHA must pass one of two tests:
#   1. its patch id (`git patch-id --stable`) equals the patch id of a commit on workspace that is
#      not already on the base, or
#   2. it carries a `(cherry picked from commit <sha>)` trailer, as written by `git cherry-pick -x`,
#      whose <sha> is an ancestor of WORKSPACE_REF and not an ancestor of BASE_SHA. This covers a
#      cherry-pick whose context changed on the way, which gives it a different patch id from its
#      source. The second condition matters: workspace and develop share their old history, so
#      "ancestor of workspace" alone would accept a trailer naming any commit develop already has,
#      the root included. Both tests look at the same set, workspace work the base does not have.
# A merge commit is refused outright. A delivery is a list of cherry-picks; a merge in it would bring
# in history the two tests above never look at.
#
# Exit 0 = every commit traced back to workspace; exit 1 = at least one did not, or the input was
# not usable.
set -euo pipefail

BASE_SHA="${BASE_SHA-}"
HEAD_SHA="${HEAD_SHA-}"
WORKSPACE_REF="${WORKSPACE_REF:-origin/workspace}"

fail() {
  echo "::error title=promotion-gate::$1"
  exit 1
}

[ -n "${BASE_SHA}" ] || fail "BASE_SHA is empty; the gate cannot tell which commits the pull request adds."
[ -n "${HEAD_SHA}" ] || fail "HEAD_SHA is empty; the gate cannot tell which commits the pull request adds."

for name in BASE_SHA HEAD_SHA WORKSPACE_REF; do
  if ! git rev-parse --verify --quiet "${!name}^{commit}" >/dev/null; then
    fail "${name}='${!name}' does not resolve to a commit in this checkout. The delivery path needs the full history (fetch-depth: 0)."
  fi
done

workspace_sha="$(git rev-parse "${WORKSPACE_REF}^{commit}")"
echo "base ${BASE_SHA}  head ${HEAD_SHA}  workspace (${WORKSPACE_REF}) ${workspace_sha}"

mapfile -t commits < <(git rev-list --reverse "${BASE_SHA}..${HEAD_SHA}")
if [ "${#commits[@]}" -eq 0 ]; then
  # A pass over zero commits verifies nothing, so it is not reported as a pass.
  fail "the pull request adds no commits over its base; there is nothing to deliver."
fi

mapfile -t merges < <(git rev-list --merges "${BASE_SHA}..${HEAD_SHA}")
if [ "${#merges[@]}" -gt 0 ]; then
  for sha in "${merges[@]}"; do
    echo "::error title=promotion-gate::merge commit ${sha} $(git log -1 --format=%s "${sha}")"
  done
  echo
  echo "A deliver/* branch holds only cherry-picks of workspace commits. Rebuild it from develop"
  echo "with 'git cherry-pick -x <sha>...' and no merges."
  exit 1
fi

# Patch ids of the workspace commits the base does not have yet. Commits already on the base are
# left out: a delivery that copies one of them adds nothing, and leaving them out keeps the scan
# proportional to the undelivered work rather than to the whole history.
patch_ids() {
  git log --no-merges --no-color --no-ext-diff -p --format='commit %H' "$@" \
    | git patch-id --stable
}
declare -A workspace_ids=()
while read -r patch_id _; do
  workspace_ids["${patch_id}"]=1
done < <(patch_ids "${BASE_SHA}..${workspace_sha}")

declare -A delivery_ids=()
while read -r patch_id sha; do
  delivery_ids["${sha}"]="${patch_id}"
done < <(patch_ids "${BASE_SHA}..${HEAD_SHA}")

refused=0
for sha in "${commits[@]}"; do
  subject="$(git log -1 --format=%s "${sha}")"
  patch_id="${delivery_ids[${sha}]-}"

  if [ -n "${patch_id}" ] && [ -n "${workspace_ids[${patch_id}]-}" ]; then
    echo "ok  ${sha} ${subject}  (same patch as a workspace commit)"
    continue
  fi

  source_ok=""
  while read -r source; do
    [ -n "${source}" ] || continue
    if git rev-parse --verify --quiet "${source}^{commit}" >/dev/null \
      && git merge-base --is-ancestor "${source}" "${workspace_sha}" \
      && ! git merge-base --is-ancestor "${source}" "${BASE_SHA}"; then
      source_ok="${source}"
      break
    fi
  done < <(git log -1 --format=%B "${sha}" \
    | sed -nE 's/^\(cherry picked from commit ([0-9a-f]{40,64})\)$/\1/p')

  if [ -n "${source_ok}" ]; then
    echo "ok  ${sha} ${subject}  (cherry-picked from workspace commit ${source_ok})"
    continue
  fi

  echo "::error title=promotion-gate::${sha} ${subject}"
  refused=1
done

if [ "${refused}" -ne 0 ]; then
  echo
  echo "Each commit above is neither the same patch as a commit on workspace nor a 'git cherry-pick -x'"
  echo "of one. develop takes only work that originated on workspace: land the change on workspace"
  echo "first, then deliver it with 'git cherry-pick -x <workspace-sha>'."
  exit 1
fi

echo "all ${#commits[@]} commit(s) trace back to workspace"
