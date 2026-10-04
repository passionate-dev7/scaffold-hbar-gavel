#!/usr/bin/env bash
# Runs every Gavel flow once on Hedera testnet and prints a HashScan link per step:
# deploy, associate, HCS quote topic, a maker with USDC and an allowance, then
#   order A: a maker quote posted to the topic and filled with it,
#   order B: no quote, the desk's own scheduled call swaps the escrow on SaucerSwap with no human transaction,
#   order C: posted, then cancelled before expiry.
#
#   DEPLOYER_PRIVATE_KEY=0x... in packages/foundry/.env (ECDSA, funded from https://portal.hedera.com/faucet)
#   MAKER_PRIVATE_KEY is generated into the same file on first run and never printed.
#   yarn foundry:live                  # deploys a fresh desk
#   DESK=0x... yarn foundry:live       # reuses a deployed desk
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source .env
set +a
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY in packages/foundry/.env}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

RPC=${HEDERA_RPC_URL:-https://testnet.hashio.io/api}
MIRROR=https://testnet.mirrornode.hedera.com/api/v1
HASHSCAN=https://hashscan.io/testnet
WHBAR=0x0000000000000000000000000000000000003aD2
SAUCE=0x0000000000000000000000000000000000120f46
USDC=0x0000000000000000000000000000000000001549
HELPER=0x000000000000000000000000000000000050a8a7
ROUTER=0x0000000000000000000000000000000000159398
POOL_WHBAR_USDC=0x914B98992d7eD602D1f5d9084ECe8160Fc0e741a
FEE=3000
ORDER_HBAR=${ORDER_HBAR:-3}
FUEL_HBAR=4
B_TTL=${B_TTL:-120}
ME=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")

# cast prints "123 [1.23e2]"; keep the exact value.
num() { cast call "$@" --rpc-url "$RPC" | awk '{print $1}'; }

# Keys never reach argv of a printed line: callers pass the variable, not its value.
send_as() {
  local key=$1 label=$2 out status hash
  shift 2
  out=$(cast send --private-key "$key" --rpc-url "$RPC" --legacy --json "$@")
  status=$(jq -r .status <<<"$out")
  hash=$(jq -r .transactionHash <<<"$out")
  printf '%-30s %s  gas=%d  %s/transaction/%s\n' \
    "$label" "$([ "$status" = 0x1 ] && echo OK || echo FAILED)" "$(jq -r .gasUsed <<<"$out")" "$HASHSCAN" "$hash"
  [ "$status" = 0x1 ] || exit 1
  LAST_HASH=$hash
}
send() { send_as "$DEPLOYER_PRIVATE_KEY" "$@"; }
msend() { send_as "$MAKER_PRIVATE_KEY" "$@"; }

# The fee the network charged for the transaction behind a hash, in HBAR, read from the mirror node.
fee_of() {
  local ts fee i
  for i in $(seq 1 12); do
    ts=$(curl -s "$MIRROR/contracts/results/$1" | jq -r '.timestamp // empty')
    if [ -n "$ts" ]; then
      fee=$(curl -s "$MIRROR/transactions?timestamp=$ts" | jq -r '.transactions[0].charged_tx_fee // empty')
      [ -n "$fee" ] && { awk -v f="$fee" 'BEGIN{printf "%.4f HBAR\n", f/1e8}'; return; }
    fi
    sleep 3
  done
  echo "n/a"
}

setenv() { # setenv NAME VALUE: keep one line per name in .env
  grep -q "^$1=" .env && sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak || printf '%s=%s\n' "$1" "$2" >>.env
}

wait_for() { # wait_for <label> <seconds> <command...>: poll until the command succeeds
  local label=$1 limit=$2 deadline
  shift 2
  deadline=$(($(date +%s) + limit))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$@"; then return 0; fi
    sleep 5
  done
  echo "FAILED: timed out waiting for $label"
  exit 1
}

# ---------------------------------------------------------------- maker key (generated once, stored only in .env)
if [ -z "${MAKER_PRIVATE_KEY:-}" ]; then
  MAKER_PRIVATE_KEY=$(cast wallet new --json | jq -r '.[0].private_key')
  setenv MAKER_PRIVATE_KEY "$MAKER_PRIVATE_KEY"
fi
MAKER=$(cast wallet address --private-key "$MAKER_PRIVATE_KEY")
echo "Taker (deployer) $ME, $(cast balance "$ME" --rpc-url "$RPC" --ether) HBAR"
echo "Maker            $MAKER"

# ---------------------------------------------------------------- deploy and associate
mkdir -p deployments
if [ -z "${DESK:-}" ]; then
  forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --slow --legacy >/dev/null
  node scripts-js/generateTsAbis.js >/dev/null
  DESK=$(jq -r '[to_entries[] | select(.value == "GavelDesk") | .key] | last' deployments/296.json)
  echo "Deployed GavelDesk $DESK  $HASHSCAN/contract/$DESK"
  send "associate WHBAR USDC SAUCE" "$DESK" "associateTokens(address[])" "[$WHBAR,$USDC,$SAUCE]" --gas-limit 4000000
fi
setenv DESK_ADDRESS "$DESK"
DESK_ID=$(curl -s "$MIRROR/contracts/$DESK" | jq -r .contract_id)
echo "Desk contract id $DESK_ID  fuelPerOrder=$(num "$DESK" "fuelPerOrder()(uint256)") tinybar  scheduledGas=$(num "$DESK" "scheduledGas()(uint256)")"

# ---------------------------------------------------------------- HCS quote topic
if [ -z "${QUOTE_TOPIC_ID:-}" ]; then
  QUOTE_TOPIC_ID=$(node scripts-js/hcs.mjs create-topic "Gavel quote board" | jq -r .topicId)
  setenv QUOTE_TOPIC_ID "$QUOTE_TOPIC_ID"
fi
echo "Quote topic $QUOTE_TOPIC_ID  $HASHSCAN/topic/$QUOTE_TOPIC_ID"

# ---------------------------------------------------------------- the maker: HBAR, USDC, allowance
if [ "$(cast balance "$MAKER" --rpc-url "$RPC")" = 0 ]; then
  send "fund maker 30 HBAR" "$MAKER" --value 30ether --gas-limit 100000
  wait_for "maker account on the mirror" 90 bash -c "curl -sf '$MIRROR/accounts/$MAKER' >/dev/null"
fi
MAKER_ID=$(curl -s "$MIRROR/accounts/$MAKER" | jq -r .account)
setenv MAKER_ACCOUNT_ID "$MAKER_ID"
echo "Maker account $MAKER_ID  $HASHSCAN/account/$MAKER_ID"
if [ "$(num "$USDC" "balanceOf(address)(uint256)" "$MAKER")" -lt 20000000 ]; then
  msend "maker wraps 5 HBAR" "$HELPER" "deposit()" --value 5ether --gas-limit 1500000
  msend "maker approves router" "$WHBAR" "approve(address,uint256)" "$ROUTER" 500000000 --gas-limit 1500000
  PATH_HEX=$(cast concat-hex "$WHBAR" 0x000bb8 "$USDC")
  msend "maker swaps WHBAR for USDC" "$ROUTER" "exactInput((bytes,address,uint256,uint256,uint256))" \
    "($PATH_HEX,$MAKER,$(($(date +%s) + 600)),500000000,0)" --gas-limit 2000000
fi
echo "Maker holds $(num "$USDC" "balanceOf(address)(uint256)" "$MAKER") raw USDC"
if [ "$(num "$USDC" "allowance(address,address)(uint256)" "$MAKER" "$DESK")" -lt 100000000 ]; then
  msend "maker approves desk for USDC" "$USDC" "approve(address,uint256)" "$DESK" 100000000 --gas-limit 1500000
fi

# ---------------------------------------------------------------- helpers over the desk
ORDER_SIG='getOrder(uint256)((address,address,address,uint24,uint256,uint256,uint64,address,uint8,uint8,uint256,uint256))'
# order_field <id> <index>: taker 0, tokenIn 1, tokenOut 2, fee 3, amountIn 4, minOut 5, expiry 6, schedule 7, status 8
order_field() { cast call "$DESK" "$ORDER_SIG" "$1" --rpc-url "$RPC" --json | jq -r ".[0][$2]" | awk '{print $1}'; }
status_of() { order_field "$1" 8; }
NAMES=(Open Filled FellBack Cancelled Refunded)

post_order() { # post_order <label> <ttl>: prints nothing, sets ORDER_ID, MIN_OUT, SPOT
  local label=$1 ttl=$2 amount=$((ORDER_HBAR * 100000000))
  SPOT=$(node scripts-js/pool-spot.mjs "$POOL_WHBAR_USDC" "$WHBAR" "$amount")
  MIN_OUT=$((SPOT * 90 / 100))
  send "$label" "$DESK" "postOrder(address,address,uint24,uint256,uint256,uint256)" \
    "$WHBAR" "$USDC" "$FEE" "$amount" "$MIN_OUT" "$ttl" --value "$((ORDER_HBAR + FUEL_HBAR))ether" --gas-limit 5000000
  ORDER_ID=$(num "$DESK" "orderCount()(uint256)")
  echo "  order $ORDER_ID: ${ORDER_HBAR} HBAR -> USDC, pool spot $SPOT, minOut $MIN_OUT, ttl ${ttl}s, fee $(fee_of "$LAST_HASH")"
  echo "  status $(status_of "$ORDER_ID") (0 = Open), schedule $(order_field "$ORDER_ID" 7)"
}

# ---------------------------------------------------------------- order A: a quote on HCS, filled with it
echo
echo "== Order A: maker quote over HCS, settled on chain"
TAKER_USDC_A=$(num "$USDC" "balanceOf(address)(uint256)" "$ME")
post_order "A post order" 600
A_ID=$ORDER_ID
# A maker quotes above pool spot: the fallback pays spot less the 0.30% pool fee, so 20 bps over spot is a 50 bps
# improvement over the guaranteed exit.
A_QUOTE_OUT=$((SPOT * 1002 / 1000))
A_DEADLINE=$(($(date +%s) + 600))
A_NONCE=$(date +%s)
QUOTE_JSON=$(node scripts-js/sign-quote.mjs "$DESK" "$A_ID" "$A_QUOTE_OUT" "$A_DEADLINE" "$A_NONCE")
POSTED=$(node scripts-js/hcs.mjs submit "$QUOTE_TOPIC_ID" "$QUOTE_JSON" --as maker)
SEQ=$(jq -r .sequence <<<"$POSTED")
echo "  maker posted quote $A_QUOTE_OUT raw USDC to topic $QUOTE_TOPIC_ID, sequence $SEQ"
echo "  topic message tx $(jq -r .txId <<<"$POSTED")"
wait_for "the quote on the mirror node" 90 bash -c "curl -sf '$MIRROR/topics/$QUOTE_TOPIC_ID/messages/$SEQ' >/dev/null"
MSG=$(curl -s "$MIRROR/topics/$QUOTE_TOPIC_ID/messages/$SEQ")
A_CONSENSUS=$(jq -r .consensus_timestamp <<<"$MSG")
echo "  consensus timestamp $A_CONSENSUS"
echo "  topic: $HASHSCAN/topic/$QUOTE_TOPIC_ID  message: $MIRROR/topics/$QUOTE_TOPIC_ID/messages/$SEQ"
# The taker reads the quote back from the mirror node, as the app does.
QUOTE=$(jq -r .message <<<"$MSG" | base64 -d)
[ "$(jq -r .orderId <<<"$QUOTE")" = "$A_ID" ] || { echo "FAILED: mirror message is not the quote"; exit 1; }
SIG=$(jq -r .signature <<<"$QUOTE")
send "A fillWithQuote" "$DESK" "fillWithQuote(uint256,(address,uint256,uint64,uint256),bytes)" \
  "$A_ID" "($(jq -r .maker <<<"$QUOTE"),$(jq -r .amountOut <<<"$QUOTE"),$(jq -r .deadline <<<"$QUOTE"),$(jq -r .nonce <<<"$QUOTE"))" "$SIG" \
  --gas-limit 3000000
echo "  fee $(fee_of "$LAST_HASH")"
A_STATUS=$(status_of "$A_ID")
GOT_A=$(($(num "$USDC" "balanceOf(address)(uint256)" "$ME") - TAKER_USDC_A))
echo "  order A status ${NAMES[$A_STATUS]}, taker received $GOT_A raw USDC (quote $A_QUOTE_OUT)"
[ "$A_STATUS" = 1 ] && [ "$GOT_A" = "$A_QUOTE_OUT" ] || { echo "FAILED: order A did not settle at the quote"; exit 1; }

# ---------------------------------------------------------------- order B: nobody quotes, the schedule swaps
echo
echo "== Order B: no quote, the desk's own scheduled call falls back to SaucerSwap"
TAKER_USDC_B=$(num "$USDC" "balanceOf(address)(uint256)" "$ME")
post_order "B post order" "$B_TTL"
B_ID=$ORDER_ID
B_EXPIRY=$(order_field "$B_ID" 6)
echo "  quotes close at $B_EXPIRY; waiting for the network to run the fallback, no transaction from us"
b_done() { [ "$(status_of "$B_ID")" != 0 ]; }
wait_for "the scheduled fallback of order $B_ID" $((B_EXPIRY - $(date +%s) + 300)) b_done
B_STATUS=$(status_of "$B_ID")
GOT_B=$(($(num "$USDC" "balanceOf(address)(uint256)" "$ME") - TAKER_USDC_B))
echo "  order B status ${NAMES[$B_STATUS]}, taker received $GOT_B raw USDC (minOut $MIN_OUT)"
[ "$B_STATUS" = 2 ] && [ "$GOT_B" -ge "$MIN_OUT" ] || { echo "FAILED: order B did not fall back and pay the taker"; exit 1; }
echo "  the quote paid $(( (GOT_A - GOT_B) * 10000 / GOT_B )) bps more than the fallback on the same size order"
# Mirror: the desk's transaction that did it is a scheduled one, and the FellBack event is in its logs.
FELLBACK_TOPIC=$(cast keccak "FellBack(uint256,uint256)")
for _ in $(seq 1 20); do
  SCHED=$(curl -s "$MIRROR/transactions?account.id=$DESK_ID&order=desc&limit=25" |
    jq -r '[.transactions[] | select(.scheduled == true)][0] | "\(.transaction_id) \(.consensus_timestamp) \(.result) \(.charged_tx_fee)"')
  [ "$SCHED" != "null" ] && [ -n "$SCHED" ] && break
  sleep 5
done
echo "  scheduled: true on the mirror -> $SCHED"
read -r SCHED_ID SCHED_TS SCHED_RESULT SCHED_FEE <<<"$SCHED"
[ "$SCHED_RESULT" = SUCCESS ] || { echo "FAILED: scheduled transaction result $SCHED_RESULT"; exit 1; }
echo "  scheduled tx: $HASHSCAN/transaction/$SCHED_TS  fee $(awk -v f="$SCHED_FEE" 'BEGIN{printf "%.4f HBAR", f/1e8}')"
FB=$(curl -s "$MIRROR/contracts/$DESK_ID/results/logs?timestamp=$SCHED_TS" | jq -r --arg t "$FELLBACK_TOPIC" '[.logs[] | select(.topics[0] == $t)] | length')
echo "  FellBack events in that transaction: $FB"
[ "$FB" = 1 ] || { echo "FAILED: no FellBack event in the scheduled transaction"; exit 1; }

# ---------------------------------------------------------------- order C: cancel
echo
echo "== Order C: posted, then cancelled"
post_order "C post order" 600
C_ID=$ORDER_ID
C_SCHEDULE=$(order_field "$C_ID" 7)
send "C cancel" "$DESK" "cancel(uint256)" "$C_ID" --gas-limit 2000000
echo "  fee $(fee_of "$LAST_HASH")"
C_STATUS=$(status_of "$C_ID")
echo "  order C status ${NAMES[$C_STATUS]}"
[ "$C_STATUS" = 3 ] || { echo "FAILED: order C is not cancelled"; exit 1; }
C_SID=$(printf '0.0.%d' "$C_SCHEDULE")
wait_for "the schedule to read as deleted" 60 bash -c "curl -s '$MIRROR/schedules/$C_SID' | jq -e '.deleted == true' >/dev/null"
echo "  schedule $C_SID deleted on the mirror: $HASHSCAN/schedule/$C_SID"
echo "  escrow held by the desk now: $(num "$WHBAR" "balanceOf(address)(uint256)" "$DESK") WHBAR, native $(cast balance "$DESK" --rpc-url "$RPC") weibar"

echo
echo "DONE desk=$DESK topic=$QUOTE_TOPIC_ID orders A=$A_ID B=$B_ID C=$C_ID"
