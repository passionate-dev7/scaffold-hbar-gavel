#!/usr/bin/env bash
# Re-reads every headline claim of docs/testnet-evidence.md from the chain and prints PASS or FAIL per row.
# Exits 1 when any row fails. Needs curl, jq and cast. Reads only public endpoints, no key, no .env.
#
#   bash scripts/verify-evidence.sh
#   EXPECT_OWNER=0x... MIN_SCHEDULED=12 bash scripts/verify-evidence.sh   # every expectation is an env override
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=${HEDERA_RPC_URL:-https://testnet.hashio.io/api}
M=https://testnet.mirrornode.hedera.com/api/v1
SOURCIFY=https://sourcify.dev/server/v2/contract/296

V=0xe72FbF68536D29d3A9e0D897C2aE813B7B279058 # vault C, contract 0.0.10839904
VID=0.0.10839904
SHARE_ID=0.0.10839906
D=0x2edbae1a15efe7b26d7562ac2efc8c050f0cbfbb # vault D, guard on (guardLeg 1, 300 bps), contract 0.0.10858261
REFUSED=${REFUSED_TX:-0x8557b8899218fb68030215740eaa9cf041a7a442d1468e5a095ada37c40ddd29}
EXPECT_OWNER=${EXPECT_OWNER:-0x1565aF2C2eF52b4A89180684a47C5260c716AbD1}
EXPECT_CODE_BYTES=${EXPECT_CODE_BYTES:-16573}
MIN_SCHEDULED=${MIN_SCHEDULED:-10}
MIN_TRADED=${MIN_TRADED:-2}
EXPECT_GUARD_BPS=${EXPECT_GUARD_BPS:-300}

fails=0
row() { # row <name> <ok 0|1> <detail>
  if [ "$2" = 0 ]; then printf 'PASS  %-34s %s\n' "$1" "$3"; else printf 'FAIL  %-34s %s\n' "$1" "$3"; fails=$((fails + 1)); fi
}
num() { awk '{print $1}'; } # cast prints "123 [1.23e2]"; keep the exact value
lower() { tr '[:upper:]' '[:lower:]'; }

# every log of a contract, following the mirror's pagination (a topic filter would cap the window at 7 days)
all_logs() {
  local url="$M/contracts/$1/results/logs?order=asc&limit=100" i
  for i in $(seq 1 40); do
    local page
    page=$(curl -sf "$url") || return 1
    jq -c '.logs[]' <<<"$page"
    local next
    next=$(jq -r '.links.next // empty' <<<"$page")
    [ -n "$next" ] || return 0
    url="https://testnet.mirrornode.hedera.com$next"
  done
}

# rows 1-3: bytecode, owner, the share token
code=$(cast code "$V" --rpc-url "$RPC" 2>/dev/null)
bytes=$(((${#code} - 2) / 2))
[ "${#code}" -gt 2 ] && [ "$bytes" = "$EXPECT_CODE_BYTES" ]
row "vault C bytecode" $? "$bytes bytes at $V (want $EXPECT_CODE_BYTES)"

owner=$(cast call "$V" "owner()(address)" --rpc-url "$RPC" 2>/dev/null)
[ -n "$owner" ] && [ "$(lower <<<"$owner")" = "$(lower <<<"$EXPECT_OWNER")" ]
row "vault C owner" $? "owner() = $owner (want $EXPECT_OWNER)"

tok=$(curl -sf "$M/tokens/$SHARE_ID")
sym=$(jq -r .symbol <<<"$tok")
treasury=$(jq -r .treasury_account_id <<<"$tok")
mirror_supply=$(jq -r .total_supply <<<"$tok")
share=$(cast call "$V" "shareToken()(address)" --rpc-url "$RPC" 2>/dev/null)
chain_supply=$(cast call "$share" "totalSupply()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
dead=$(cast call "$share" "balanceOf(address)(uint256)" "$V" --rpc-url "$RPC" 2>/dev/null | num)
[ "$sym" = IBSK ] && [ "$treasury" = "$VID" ] && [ -n "$chain_supply" ] && [ "$mirror_supply" = "$chain_supply" ] && [ "$chain_supply" -gt 0 ]
row "IBSK supply, treasury = vault" $? "$sym treasury $treasury supply mirror=$mirror_supply evm=$chain_supply"
[ -n "$dead" ] && [ "$dead" = 100000 ]
row "dead shares held by the vault" $? "balanceOf(vault) = $dead (want 100000)"

# row 4: runs the network started. Every ScheduledRun log must sit in a transaction flagged scheduled=true.
runs=$(all_logs "$VID" | jq -r --arg t "$(cast keccak 'ScheduledRun(bool)')" 'select(.topics[0]==$t)|"\(.timestamp) \(.data)"')
total=0 scheduled=0 traded=0 bad=0
while read -r ts data; do
  [ -n "$ts" ] || continue
  total=$((total + 1))
  t=$(curl -sf "$M/transactions?timestamp=$ts" | jq -r '.transactions[0]|"\(.scheduled) \(.result)"')
  if [ "$t" = "true SUCCESS" ]; then scheduled=$((scheduled + 1)); else bad=$((bad + 1)); fi
  case "$data" in *1) traded=$((traded + 1)) ;; esac
done <<<"$runs"
[ "$total" -gt 0 ] && [ "$bad" = 0 ] && [ "$scheduled" -ge "$MIN_SCHEDULED" ]
row "scheduled runs, scheduled=true" $? "$scheduled/$total ScheduledRun logs are scheduled=true SUCCESS (want >= $MIN_SCHEDULED, 0 other)"
[ "$traded" -ge "$MIN_TRADED" ]
row "scheduled runs that traded" $? "$traded ScheduledRun(traded=true) (want >= $MIN_TRADED)"

# row 5: source verified on Sourcify (chain 296)
sm=$(curl -sf -A "verify-evidence.sh" "$SOURCIFY/$V" | jq -r '.match // "none"')
[ "$sm" = exact_match ] || [ "$sm" = match ]
row "Sourcify match, vault C" $? "match = $sm (exact_match or match passes)"

# rows 6-8: the price guard refused a deposit on vault D
gl=$(cast call "$D" "guardLeg()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
gb=$(cast call "$D" "maxDeviationBps()(uint256)" --rpc-url "$RPC" 2>/dev/null | num)
[ "$gl" = 1 ] && [ "$gb" = "$EXPECT_GUARD_BPS" ]
row "vault D guard armed" $? "guardLeg = $gl, maxDeviationBps = $gb (want 1, $EXPECT_GUARD_BPS)"

res=$(curl -sf "$M/contracts/results/$REFUSED")
result=$(jq -r .result <<<"$res")
err=$(jq -r '.error_message // ""' <<<"$res")
sel=$(cast sig "PoolPriceDeviates(uint256,uint256)")
args=$(cast decode-error "$err" --sig "PoolPriceDeviates(uint256,uint256)" 2>/dev/null | grep -E '^[0-9]' | num | paste -sd' ' -)
implied=${args%% *}
oracle=${args##* }
dev=0
[ -n "$implied" ] && [ -n "$oracle" ] && dev=$(((implied > oracle ? implied - oracle : oracle - implied) * 10000 / oracle))
[ "$result" = CONTRACT_REVERT_EXECUTED ] && [ "${err:0:10}" = "$sel" ] && [ "$dev" -gt "$EXPECT_GUARD_BPS" ]
row "guard refusal on-chain" $? "$result ${err:0:10} PoolPriceDeviates(implied=$implied, oracle=$oracle) USD e8, deviation $dev bps > $EXPECT_GUARD_BPS"

live=$(cast call "$D" "deposit(uint256)" 1 --value 1ether --from 0x1565aF2C2eF52b4A89180684a47C5260c716AbD1 --rpc-url "$RPC" 2>&1)
case "$live" in *"$sel"*) ok=0 ;; *) ok=1 ;; esac
row "guard refuses a deposit now" $ok "eth_call deposit(1) with 1 HBAR on vault D $([ $ok = 0 ] && echo "reverts with $sel" || echo "did not revert with $sel")"

echo
if [ "$fails" = 0 ]; then echo "ALL ROWS PASS"; else echo "$fails ROW(S) FAILED"; fi
[ "$fails" = 0 ]
