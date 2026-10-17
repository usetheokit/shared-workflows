#!/usr/bin/env bash
#
# Exercises check-delivery.sh against throwaway git repositories, one per case. Each case builds a
# `develop` and a `workspace` that share a root, cuts a `deliver/*` branch from develop the way the
# squad kit does, and asserts the verdict. A guard is only a guard if something has watched it
# refuse, so most cases here are refusals, and the cases that must pass are asserted too: a check
# that refuses everything is not a check either.
#
# Run from anywhere: `bash actions/promotion-gate/check-delivery.test.sh`. Exit 0 = every case held.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="${here}/check-delivery.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT

# Isolated from the caller's git configuration, so a global hook, signing setup or default branch
# name cannot change what the cases build.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

failures=0

# A repository with ten numbered lines on develop, and workspace one commit ahead (W0 rewrites line
# 2, so any later workspace commit near the top of the file has different context there than on
# develop). The `origin/workspace` ref is created the way a fetch-depth 0 checkout leaves it.
new_repo() {
  local dir="${scratch}/$1"
  git init -q -b develop "${dir}"
  cd "${dir}"
  seq 1 10 > numbers.txt
  git add numbers.txt
  git commit -q -m "root"
  git switch -q -c workspace
  sed -i 's/^2$/two/' numbers.txt
  git commit -q -am "W0: rewrite line 2"
  sed -i 's/^4$/four/' numbers.txt
  git commit -q -am "W1: rewrite line 4"
  echo "notes" > notes.txt
  git add notes.txt
  git commit -q -m "W2: add notes"
  git update-ref refs/remotes/origin/workspace workspace
  git switch -q develop
  git switch -q -c deliver/B-410-1a2b3c4
}

run_check() {
  BASE_SHA="$(git rev-parse develop)" HEAD_SHA="$(git rev-parse HEAD)" \
    bash "${check}" >"${scratch}/out.txt" 2>&1
}

expect_pass() {
  if run_check; then
    echo "ok    accepted: $1"
  else
    echo "FAIL  refused: $1"
    sed 's/^/      /' "${scratch}/out.txt"
    failures=$((failures + 1))
  fi
}

expect_refusal() {
  local name="$1" must_mention="${2-}"
  if run_check; then
    echo "FAIL  accepted: ${name}"
    sed 's/^/      /' "${scratch}/out.txt"
    failures=$((failures + 1))
  elif [ -n "${must_mention}" ] && ! grep -qF -- "${must_mention}" "${scratch}/out.txt"; then
    echo "FAIL  refused ${name}, but the output does not name '${must_mention}'"
    sed 's/^/      /' "${scratch}/out.txt"
    failures=$((failures + 1))
  else
    echo "ok    refused: ${name}"
  fi
}

ws() { git rev-parse "workspace~$1"; }

# --- accepted ------------------------------------------------------------------------------------

new_repo pure-cherry-picks
git cherry-pick "$(ws 0)" >/dev/null
expect_pass "a delivery of plain cherry-picks (same patch as workspace)"

new_repo pure-cherry-picks-x
git cherry-pick -x "$(ws 2)" "$(ws 0)" >/dev/null
expect_pass "a delivery of 'git cherry-pick -x' copies"

new_repo changed-context
# W1 rewrites line 4. On workspace its context includes W0's 'two'; on develop that line is still
# '2', so the copy's patch differs from its source and only the -x trailer can vouch for it.
git cherry-pick -x "$(ws 1)" >/dev/null
delivered_id="$(git show HEAD | git patch-id --stable | cut -d' ' -f1)"
source_id="$(git show "$(ws 1)" | git patch-id --stable | cut -d' ' -f1)"
if [ "${delivered_id}" = "${source_id}" ]; then
  # The case is only meaningful if the trailer is the sole path to acceptance.
  echo "FAIL  the changed-context fixture produced the same patch id as its source; it proves nothing"
  failures=$((failures + 1))
else
  expect_pass "a -x cherry-pick whose context changed (patch id differs, trailer names a workspace commit)"
fi

# --- refused -------------------------------------------------------------------------------------

new_repo extra-commit
git cherry-pick -x "$(ws 0)" >/dev/null
echo "not from workspace" > extra.txt
git add extra.txt
git commit -q -m "sneak in a change"
extra_sha="$(git rev-parse HEAD)"
expect_refusal "one commit that is not on workspace" "${extra_sha} sneak in a change"

new_repo merge-commit
git cherry-pick -x "$(ws 0)" >/dev/null
git switch -q -c side develop
echo "side" > side.txt
git add side.txt
git commit -q -m "side work"
git switch -q deliver/B-410-1a2b3c4
git merge -q --no-ff --no-edit side
expect_refusal "a merge commit in the delivery" "merge commit $(git rev-parse HEAD)"

new_repo merge-of-workspace-commits
# Even a merge whose every parent is workspace history is refused: a delivery is cherry-picks only.
git merge -q --no-ff --no-edit "$(ws 0)"
expect_refusal "a merge that brings in workspace itself" "merge commit"

new_repo forged-trailer
# The root IS an ancestor of workspace, so "ancestor of workspace" alone would accept this. It is
# also already on develop, which means it is not undelivered workspace work, and that is what the
# trailer has to name.
echo "forged" > forged.txt
git add forged.txt
git commit -q -m "claims a workspace origin" \
  -m "(cherry picked from commit $(git rev-parse develop))"
expect_refusal "a -x trailer naming a commit develop already has" "claims a workspace origin"

new_repo unknown-trailer
echo "unknown" > unknown.txt
git add unknown.txt
git commit -q -m "claims an unknown origin" \
  -m "(cherry picked from commit 0123456789abcdef0123456789abcdef01234567)"
expect_refusal "a -x trailer naming a commit that does not exist" "claims an unknown origin"

new_repo amended-copy
# A copy of W2 changed on the way and carries no trailer, so its patch no longer matches anything.
git cherry-pick "$(ws 0)" >/dev/null
echo "more notes" >> notes.txt
git commit -q --amend -a --no-edit
expect_refusal "a cherry-pick altered after the fact, without -x" "W2: add notes"

new_repo empty-delivery
expect_refusal "a delivery with no commits" "no commits"

new_repo no-workspace-ref
git cherry-pick "$(ws 0)" >/dev/null
git update-ref -d refs/remotes/origin/workspace
expect_refusal "a checkout without origin/workspace" "WORKSPACE_REF"

new_repo empty-base
git cherry-pick "$(ws 0)" >/dev/null
if BASE_SHA="" HEAD_SHA="$(git rev-parse HEAD)" bash "${check}" >"${scratch}/out.txt" 2>&1; then
  echo "FAIL  accepted: an empty BASE_SHA"
  failures=$((failures + 1))
else
  echo "ok    refused: an empty BASE_SHA"
fi

echo
if [ "${failures}" -ne 0 ]; then
  echo "${failures} case(s) failed"
  exit 1
fi
echo "every case held"
