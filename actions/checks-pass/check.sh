#!/usr/bin/env bash
#
# The whole of the fan-in's logic, in a file rather than inline in `action.yml`.
#
# Inline, the only way to test it is to copy it into the test — and a test that
# runs a copy passes while the original rots. Here `action.yml` and the CI job
# that exercises the refusals run the same bytes.
#
# Reads NEEDS and ALLOWED_SKIPS from the environment. Exit 0 = every dependency
# succeeded; exit 1 = something did not, or the input was not usable.
set -euo pipefail

NEEDS="${NEEDS-}"
ALLOWED_SKIPS="${ALLOWED_SKIPS-}"

# Empty input is checked BEFORE jq, because jq reads empty stdin as "no documents",
# produces no output and exits 0 — so a type test over it passes over nothing.
# Measured while writing this: an empty `needs` made the action report success,
# which is the green-light-over-nothing failure it exists to refuse, inside the
# thing built to refuse one.
if [ -z "${NEEDS//[[:space:]]/}" ]; then
  echo "::error title=checks-pass::\`needs\` is empty. Pass \`\${{ toJSON(needs) }}\`."
  exit 1
fi

if ! printf '%s' "${NEEDS}" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "::error title=checks-pass::\`needs\` is not a JSON object. Pass \`\${{ toJSON(needs) }}\`."
  exit 1
fi

count="$(printf '%s' "${NEEDS}" | jq 'length')"
if [ "${count}" -eq 0 ]; then
  # A fan-in with nothing to fan in is a green light over nothing — the exact shape
  # this action exists to refuse, so it refuses its own.
  echo "::error title=checks-pass::no dependencies. A job that aggregates nothing cannot vouch for anything."
  exit 1
fi

# Normalise the skip list once: commas or whitespace, either way. The surrounding
# spaces make the membership test below exact, so `a` does not match a job `ab`.
allowed=" $(printf '%s' "${ALLOWED_SKIPS}" | tr ',' ' ' | tr -s '[:space:]' ' ' | sed 's/^ //;s/ $//') "

failed=0
printf '%-40s %-10s %s\n' "JOB" "RESULT" "VERDICT"
while IFS=$'\t' read -r job result; do
  case "${result}" in
    success) verdict="ok" ;;
    skipped)
      case "${allowed}" in
        *" ${job} "*) verdict="skipped (declared)" ;;
        *) verdict="SKIPPED — not in allowed-skips"; failed=1 ;;
      esac
      ;;
    *) verdict="FAILED"; failed=1 ;;
  esac
  printf '%-40s %-10s %s\n' "${job}" "${result}" "${verdict}"
done < <(printf '%s' "${NEEDS}" | jq -r 'to_entries[] | "\(.key)\t\(.value.result)"' | sort)

if [ "${failed}" -ne 0 ]; then
  echo "::error title=checks-pass::at least one dependency did not succeed — see the table above."
  exit 1
fi
echo "all ${count} dependencies succeeded"
