#!/usr/bin/env bash
# Re-reads the canonical Backstop testnet run from the chain and the mirror node and prints PASS or FAIL per row.
# Exits 1 when any row fails. Needs curl, jq and cast. Reads only public endpoints, no key, no .env.
#
#   bash scripts/verify-evidence.sh
#   ORDER_A=1 ORDER_B=2 ORDER_C=3 bash scripts/verify-evidence.sh   # every expectation is an env override
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=${HEDERA_RPC_URL:-https://testnet.hashio.io/api}
M=https://testnet.mirrornode.hedera.com/api/v1
SOURCIFY=https://sourcify.dev/server/v2/contract/296

DESK=${DESK:-0xe48eC020C7D928330c788f1AC448F72C7d116960}
DESK_ID=${DESK_ID:-0.0.10860415}
TOPIC=${TOPIC:-0.0.10860170}
MAKER=${MAKER:-0x9Cad678f7D970afe0B9736Bae036877255a9dA84}
WHBAR=0x0000000000000000000000000000000000003aD2
ORDER_A=${ORDER_A:-3} # filled with a quote read from the topic
ORDER_B=${ORDER_B:-4} # no quote: the desk's scheduled call swapped it
ORDER_C=${ORDER_C:-5} # cancelled
EXPECT_SCHEDULED_GAS=${EXPECT_SCHEDULED_GAS:-3000000}
EXPECT_FUEL=${EXPECT_FUEL:-400000000}
EXPECT_CODE_BYTES=${EXPECT_CODE_BYTES:-15794}

fails=0
row() { # row <name> <ok 0|1> <detail>
  if [ "$2" = 0 ]; then printf 'PASS  %-34s %s\n' "$1" "$3"; else printf 'FAIL  %-34s %s\n' "$1" "$3"; fails=$((fails + 1)); fi
}
num() { awk '{print $1}'; } # cast prints "123 [1.23e2]"; keep the exact value
lower() { tr '[:upper:]' '[:lower:]'; }
pad() { printf '0x%064x' "$1"; }
NAMES=(Open Filled FellBack Cancelled Refunded)
ORDER_SIG='getOrder(uint256)((address,address,address,uint24,uint256,uint256,uint64,address,uint8,uint8,uint256,uint256))'
status_of() { cast call "$DESK" "$ORDER_SIG" "$1" --rpc-url "$RPC" --json 2>/dev/null | jq -r '.[0][8]' | num; }
created=$(curl -sf "$M/contracts/$DESK_ID" | jq -r '.created_timestamp')
# a topic filter on the logs endpoint needs a timestamp window
WINDOW="timestamp=gte:$created&timestamp=lte:$(awk -v c="$created" 'BEGIN{printf "%d", c + 6*86400}')"
logs_for() { # logs_for <event signature> <order id>
  curl -sf "$M/contracts/$DESK_ID/results/logs?topic0=$(cast keccak "$1")&topic1=$(pad "$2")&$WINDOW&order=asc&limit=10"
}

# 1-3: bytecode, configuration, Sourcify
code=$(cast code "$DESK" --rpc-url "$RPC" 2>/dev/null)
bytes=$(((${#code} - 2) / 2))
[ "${#code}" -gt 2 ] && [ "$bytes" = "$EXPECT_CODE_BYTES" ]
row "desk bytecode" $? "$bytes bytes at $DESK (want $EXPECT_CODE_BYTES)"

gas=$(cast call "$DESK" "scheduledGas()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
fuel=$(cast call "$DESK" "fuelPerOrder()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
[ "$gas" = "$EXPECT_SCHEDULED_GAS" ] && [ "$fuel" = "$EXPECT_FUEL" ]
row "scheduledGas and fuelPerOrder" $? "$gas gas, $fuel tinybar (want $EXPECT_SCHEDULED_GAS, $EXPECT_FUEL)"

match=$(curl -sf "$SOURCIFY/$DESK" | jq -r '.runtimeMatch // .match // "none"')
[ "$match" = exact_match ]
row "Sourcify verification" $? "runtimeMatch = $match"

# 4-6: order A, the quote path
a_status=$(status_of "$ORDER_A")
[ "$a_status" = 1 ]
row "order A status" $? "${NAMES[${a_status:-0}]} (want Filled)"

filled=$(logs_for "Filled(uint256,address,uint256)" "$ORDER_A")
fill_maker=$(jq -r '.logs[0].topics[2] // empty' <<<"$filled" | sed 's/^0x0*//' | lower)
fill_amount=$(jq -r '.logs[0].data // empty' <<<"$filled")
fill_ts=$(jq -r '.logs[0].timestamp // empty' <<<"$filled")
[ -n "$fill_maker" ] && [ "0x$fill_maker" = "$(lower <<<"$MAKER")" ]
row "order A Filled event maker" $? "maker 0x$fill_maker, amount $([ -n "$fill_amount" ] && cast to-dec "$fill_amount" || echo none)"

# The signature the desk accepted is the one on the topic: find the topic message for this order and look for its
# signature inside the fill transaction's parameters.
msgs=$(curl -sf "$M/topics/$TOPIC/messages?limit=100&order=asc")
msg=$(jq -c --arg id "$ORDER_A" '[.messages[] | {s: .sequence_number, t: .consensus_timestamp, m: (.message | @base64d | fromjson? // {})} | select(.m.orderId == $id)] | last' <<<"$msgs")
sig=$(jq -r '.m.signature // empty' <<<"$msg" | lower)
params=$(curl -sf "$M/contracts/results?timestamp=$fill_ts" | jq -r '.results[0].function_parameters // empty' | lower)
[ -n "$sig" ] && [ -n "$params" ] && [[ "$params" == *"${sig#0x}"* ]]
row "order A fill used the topic quote" $? "topic seq $(jq -r .s <<<"$msg") consensus $(jq -r .t <<<"$msg")"

# 7-9: order B, the network-triggered fallback
b_status=$(status_of "$ORDER_B")
[ "$b_status" = 2 ]
row "order B status" $? "${NAMES[${b_status:-0}]} (want FellBack)"

fb=$(logs_for "FellBack(uint256,uint256)" "$ORDER_B")
fb_ts=$(jq -r '.logs[0].timestamp // empty' <<<"$fb")
fb_out=$(jq -r '.logs[0].data // empty' <<<"$fb")
tx=$(curl -sf "$M/transactions?timestamp=$fb_ts" | jq -c '.transactions[0] // {}')
[ -n "$fb_ts" ] && [ "$(jq -r .scheduled <<<"$tx")" = true ] && [ "$(jq -r .result <<<"$tx")" = SUCCESS ]
row "order B ran as a scheduled tx" $? "scheduled=$(jq -r .scheduled <<<"$tx") result=$(jq -r .result <<<"$tx") at $fb_ts"

payer=$(jq -r '[.transfers[] | select(.amount < 0)][0].account // empty' <<<"$tx")
[ "$payer" = "$DESK_ID" ]
row "the desk paid for it" $? "payer $payer, charged $(jq -r '(.charged_tx_fee // 0) / 1e8' <<<"$tx") HBAR, swap out $([ -n "$fb_out" ] && cast to-dec "$fb_out" || echo none)"

# 10-11: order C, cancel deletes the schedule
c_status=$(status_of "$ORDER_C")
[ "$c_status" = 3 ]
row "order C status" $? "${NAMES[${c_status:-0}]} (want Cancelled)"

del=$(logs_for "ScheduleDeleted(uint256,address,int64)" "$ORDER_C")
sched_addr=$(jq -r '.logs[0].data // empty' <<<"$del" | cut -c1-66)
del_rc=$(jq -r '.logs[0].data // empty' <<<"$del" | cut -c67-130)
sid=$([ -n "$sched_addr" ] && printf '0.0.%d' "0x${sched_addr:26}" || echo none)
deleted=$(curl -sf "$M/schedules/$sid" | jq -r '.deleted // "none"')
[ "$deleted" = true ] && [ -n "$del_rc" ] && [ "$((16#$del_rc))" = 22 ]
row "order C schedule deleted" $? "schedule $sid deleted=$deleted, response code $([ -n "$del_rc" ] && echo $((16#$del_rc)) || echo none)"

# 12-13: nothing is stuck in escrow
held=$(cast call "$WHBAR" "balanceOf(address)(uint256)" "$DESK" --rpc-url "$RPC" 2>/dev/null | num)
booked=$(cast call "$DESK" "escrowed(address)(uint256)" "$WHBAR" --rpc-url "$RPC" 2>/dev/null | num)
[ -n "$held" ] && [ "$held" = "$booked" ]
row "WHBAR held equals escrow booked" $? "held $held, booked $booked"

topic=$(curl -sf "$M/topics/$TOPIC")
[ "$(jq -r .topic_id <<<"$topic")" = "$TOPIC" ] && [ "$(jq -r '.submit_key // "none"' <<<"$topic")" = none ]
row "quote topic is open to makers" $? "$TOPIC memo $(jq -r .memo <<<"$topic"), no submit key"

echo
[ "$fails" = 0 ] && echo "ALL ROWS PASS" || { echo "$fails ROW(S) FAILED"; exit 1; }
