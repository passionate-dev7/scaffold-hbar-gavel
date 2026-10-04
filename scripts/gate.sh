#!/usr/bin/env bash
# The bounty eligibility gate against a fresh scaffold of this template:
# scaffold, install, contract tests, lint, build, boot, load every core route, no committed secrets.
#
#   bash scripts/gate.sh                                   # the committed HEAD of this checkout
#   GATE_TEMPLATE=passionate-dev7/scaffold-hbar-gavel bash scripts/gate.sh   # the published repo
#   PM=npm bash scripts/gate.sh                            # npm instead of yarn
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PM=${PM:-yarn}
WORK=$(mktemp -d)
PORT=${PORT:-3123}
ROUTES=(/ /debug /blockexplorer)

if [ -n "${GATE_TEMPLATE:-}" ]; then
  TEMPLATE=$GATE_TEMPLATE
else
  # git archive serves exactly what GitHub would: committed files, no submodule contents, no .env.
  mkdir "$WORK/template"
  git -C "$ROOT" archive HEAD | tar -x -C "$WORK/template"
  export CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR="$WORK/template"
  TEMPLATE=passionate-dev7/scaffold-hbar-gavel
fi
echo "Gate: $TEMPLATE with $PM in $WORK"

echo "== committed secrets"
if git -C "$ROOT" ls-files | grep -E '(^|/)\.env$'; then
  echo "FAIL: .env is committed"
  exit 1
fi
if git -C "$ROOT" grep -nE '(PRIVATE_KEY|OPERATOR_KEY)=(0x)?[0-9a-fA-F]{64}' -- ':!*.md'; then
  echo "FAIL: a private key is committed"
  exit 1
fi

echo "== scaffold"
cd "$WORK"
npx -y create-scaffold-hbar@latest app --template "$TEMPLATE" \
  -f nextjs-app -s foundry --network testnet --package-manager "$PM" --skip-hedera-skills --ci
cd app
for f in README.md AGENTS.md LICENCE packages/foundry/contracts/GavelDesk.sol packages/nextjs/app/page.tsx; do
  test -f "$f" || { echo "FAIL: missing $f"; exit 1; }
done

run() { if [ "$PM" = npm ]; then npm run "$1" -- "${@:2}"; else yarn "$@"; fi; }
echo "== contract tests"; run foundry:test
echo "== lint"; run lint
echo "== build"; run next:build

echo "== boot"
run next:start -p "$PORT" >next.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 45); do curl -sf "http://localhost:$PORT" >/dev/null && break; sleep 2; done
fail=0
for r in "${ROUTES[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT$r")
  echo "$code  $r"
  [ "$code" = 200 ] || fail=1
done
[ $fail = 0 ] && echo "GATE PASS" || { echo "GATE FAIL"; tail -30 next.log; exit 1; }
