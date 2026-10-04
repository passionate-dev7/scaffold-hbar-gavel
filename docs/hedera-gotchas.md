# Hedera behaviours the vault is built around

Setup for the commands:

```bash
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=https://testnet.hashio.io/api
M=https://testnet.mirrornode.hedera.com/api/v1
HSS=0x000000000000000000000000000000000000016b
V=0xe72FbF68536D29d3A9e0D897C2aE813B7B279058       # vault C, 0.0.10839904
VID=0.0.10839904
n() { awk '{print $1}'; }
```

| # | Behaviour | Handled by |
| --- | --- | --- |
| 1 | HBAR is tinybar inside the EVM and weibar at the JSON-RPC layer | all contract math in tinybar; the app converts with `parseEther` |
| 2 | An account must be associated with an HTS token to receive it (HIP-719) | `initialize`, `_associate`, `TOKEN_ALREADY_ASSOCIATED` |
| 3 | An HTS approval from a contract costs about 700k gas and is capped by max supply | `_swap` approves `totalSupply()` once per token |
| 4 | A scheduled call runs with `msg.sender` equal to the booking contract | `runScheduled` and `OnlySelf` |
| 5 | A self-rescheduling call under 3M gas runs once and never books its successor | `MIN_SCHEDULED_GAS`, `scheduledGas` 4,000,000 |
| 6 | One schedule per scheduled execution | `runScheduled` books exactly once |
| 7 | An expiry more than 62 days out is refused | `MAX_INTERVAL = 60 days` |
| 8 | A second can be full | `_secondWithCapacity` probes +1 to +64 s; bookings carry a 0 to 29 s offset |
| 9 | The payer needs the full gas reservation, not the gas a run burns | runway formula, fuel top-ups |
| 10 | Scheduled calls read a clock about two seconds early | no deadline checks; bookings are relative to `block.timestamp` |
| 11 | A balance read inside a scheduled run is short by the unreturned gas allowance | nothing in the vault reads `address(this).balance` |
| 12 | Testnet pools are not arbitraged | `guardLeg` and `maxDeviationBps` are configurable |
| 13 | The Chainlink HBAR/USD heartbeat is 24 hours | `maxOracleAge` 25 hours |
| 14 | Bonzo's testnet oracle prices no reserve | the vault has no lending dependency |
| 15 | An HTS issuer can freeze or pause a token for a holder | `redeemExcept` skips the affected leg |
| 16 | Hashio caps `eth_getLogs` at a 7 day span | the app reads events from the mirror node |

## HBAR is tinybar in the EVM and weibar over JSON-RPC

**What happens.** Hedera accounts hold HBAR with 8 decimals (tinybar). The EVM sees the same balance as `msg.value`, `address(this).balance` and `tx.gasprice` in tinybar. The JSON-RPC relay speaks 18 decimals, so a wallet sends 10 HBAR as `10e18` and the contract reads `1_000_000_000`. One tinybar is `1e10` weibar.

**In BasketVault.** Every amount in the contract is tinybar: `deposit` mints against `msg.value`, `nav()` returns WHBAR tinybar (WHBAR has 8 decimals as well), `withdrawFuel` sends tinybar. The app uses `parseEther("10")` for 10 HBAR and displays tinybar sums as HBAR through the mirror node.

**Reproduce.** The 20 HBAR first deposit of vault C reads three ways:

```bash
H=0xe993751cad6ac8774be9387eafa0e7fed1280a3d7790889314f3cb12a70b7b0c
cast tx $H value --rpc-url $RPC                       # 20000000000000000000   (weibar)
curl -s $M/contracts/results/$H | jq .amount          # 2000000000             (tinybar)
cast balance $V --rpc-url $RPC                        # fuel in weibar
curl -s $M/accounts/$VID | jq .balance.balance        # the same fuel in tinybar
cast gas-price --rpc-url $RPC                         # 880000000000 weibar = 88 tinybar per gas
```

## HTS association before receipt (HIP-719)

**What happens.** An account receives an HTS token only if it is associated with it, unless it has free automatic association slots. [HIP-719](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-719.md) exposes `associate()` on the token's own EVM address, which returns a response code (22 for success, 194 when already associated) instead of reverting. Association itself costs gas: the owner's association of the share token measured 726,488 gas.

**In BasketVault.** `initialize` calls `IHRC719(token).associate()` for WHBAR and every leg token through `_associate`, which accepts `SUCCESS` (22) and `TOKEN_ALREADY_ASSOCIATED` (194) and reverts `HtsCallFailed(rc)` on anything else. The vault's own account has no automatic association slots, so this step is required before the first swap. Depositors associate the share token before `deposit`, and redeemers associate the payout tokens before `redeem`; the app puts an associate button in front of each. Accounts created with unlimited automatic association (`-1`), as the wallet used for the UI flows was, receive each token on first arrival.

**Reproduce.**

```bash
curl -s $M/accounts/$VID | jq .max_automatic_token_associations                 # 0
curl -s $M/accounts/$VID/tokens | jq -c '.tokens[]|{token_id,automatic_association}'
# the vault's four tokens, each automatic_association=false: it associated explicitly in initialize

curl -s $M/accounts/0.0.10838073 | jq .max_automatic_token_associations         # -1
curl -s $M/accounts/0.0.10838073/tokens | jq -c '.tokens[]|{token_id,automatic_association}'
# the same four tokens, each automatic_association=true: received without a prior step
```

The unit tests that pin the contract side: `test_initialize_associatesEveryTokenAndCreatesShareToken`, `test_initialize_toleratesTokensAlreadyAssociated`, `test_initialize_revertsWhenAssociationFails`, `test_deposit_revertsWhenDepositorIsNotAssociatedWithTheShareToken`, `test_redeem_revertsWhenRedeemerIsNotAssociatedWithAPayoutToken`.

## HTS approvals cost about 700k gas and stop at max supply

**What happens.** `approve` on an HTS token is a Token Service allowance, not a storage write. From a contract it measured 727,032 gas for the share token approval. HTS also refuses an allowance above a finite token's maximum supply, so the usual `type(uint256).max` approval reverts. USDC on testnet has max supply `1000000000000000`.

**In BasketVault.** `_swap` approves the router for the token's `totalSupply()` only when the current allowance is short of the amount in. Total supply never exceeds max supply, so HTS accepts it, and the allowance covers many later swaps. The first deposit pays for the WHBAR approval (1,137,106 gas); a later deposit on the same vault costs 429,187 gas.

**Reproduce.** The cap, simulated from an associated account:

```bash
ROUTER=0x0000000000000000000000000000000000159398
USDC=0x0000000000000000000000000000000000001549
W=0x7010221487DbB73Bf5417b11EC07E1b24b6aB013     # an account associated with USDC
curl -s $M/tokens/0.0.5449 | jq '{supply_type,max_supply,total_supply}'
cast call $USDC "approve(address,uint256)(bool)" $ROUTER 1000000000000000 --from $W --rpc-url $RPC   # true
cast call $USDC "approve(address,uint256)(bool)" $ROUTER 1000000000000001 --from $W --rpc-url $RPC   # AMOUNT_EXCEEDS_TOKEN_MAX_SUPPLY
```

The vault's own allowance equals the supply minus what it has spent. Vault C sold 129,039 raw USDC in its run 1 (the 0.129039 USDC of the sell), so the allowance reads the supply minus 129,039:

```bash
cast call $USDC "allowance(address,address)(uint256)" $V $ROUTER --rpc-url $RPC | n
cast call $USDC "totalSupply()(uint256)" --rpc-url $RPC | n
# totalSupply - allowance = the raw USDC the vault has sold since it approved
```

Gas of the approvals and of the deposits that carry them:

```bash
for h in 0xe19601a83d48bb43bc603ea38f3bd4f83045ef3a778a999fbbf34d6066c5695e \
         0xe993751cad6ac8774be9387eafa0e7fed1280a3d7790889314f3cb12a70b7b0c \
         0x2fcdac89a903e2bd9377df92aea9e9c447bd2d2a800a69e059b3f16a0c588d5a; do
  curl -s $M/contracts/results/$h | jq -c '{gas_used}'
done
# 727032 (share token approval), 1137056 (first deposit, approves WHBAR), 429187 (a later deposit, on the previous deployment)
```

Unit tests: `test_deposit_onlyApprovesWhenAllowanceIsShort`, `test_rebalance_approvesTheSoldLegOnceForItsSupply`.

## A scheduled call arrives with msg.sender equal to the booking contract

**What happens.** The network executes a schedule created by a contract as a call from that contract. The callee sees `msg.sender == address(this)` when it booked itself.

**In BasketVault.** `runScheduled` is external and permissionless in shape, and its one access check is `if (msg.sender != address(this)) revert OnlySelf();`. Only the vault's own bookings reach it.

**Reproduce.** The negative case is refused, the positive case is on chain:

```bash
cast call $V "runScheduled()" --rpc-url $RPC            # reverts with data 0x14d4a4e8
cast sig "OnlySelf()"                                   # 0x14d4a4e8
T=$(cast keccak "ScheduledRun(bool)")
curl -s "$M/contracts/$VID/results/logs?topic0=$T&timestamp=gte:1791006000&timestamp=lte:1791099999" | jq '.logs|length'   # 5 or more
```

Five `ScheduledRun` events exist (1791020053 to 1791020800, more once the 6 hour cadence has run) because five network executions passed the `OnlySelf` check. Unit test: `test_runScheduled_revertsForEveryoneButTheVault`.

## 3,000,000 gas is the floor for a self-rescheduling call

**What happens.** `scheduleCall` alone costs about 1.4M gas. A scheduled function that does work and then books its successor measured 1,511,731 gas on testnet. Booked with 1,000,000 gas, the function runs, its inner `scheduleCall` runs out of gas, and the outer call still reports `SUCCESS`. The chain ends and nothing says so.

**In BasketVault.** `MIN_SCHEDULED_GAS = 3_000_000`. The constructor reverts `BadConfig()` below it, and the deploy script books with 4,000,000. Gas that is not used is refunded, so the headroom is nearly free: the runs of vault C were charged 1.3055, 1.3964 and 1.9920 HBAR against a 4,000,000 gas booking.

**Reproduce.** Two probe contracts, identical but for the gas budget, are live on testnet:

```bash
cast call 0xAC43ea09aBb40C957488fedBa2E68a3e022ef651 "ticks()(uint256)" --rpc-url $RPC | n   # 25  (3,000,000 gas)
cast call 0xb4f980DBdb7b62f5193d5Ab0680DB468b5143445 "ticks()(uint256)" --rpc-url $RPC | n   # 2   (1,000,000 gas)

cast call $V "MIN_SCHEDULED_GAS()(uint256)" --rpc-url $RPC | n    # 3000000
cast call $V "scheduledGas()(uint256)" --rpc-url $RPC | n         # 4000000
for ts in 1791020053.074818208 1791020419.010852853 1791020800.024519104; do
  curl -s $M/contracts/$VID/results/$ts | jq -c '{gas_used,gas_limit}'
done
```

Unit test: `test_constructor_rejectsScheduledGasBelowThreeMillion`.

## One schedule per scheduled execution

**What happens.** A scheduled execution may book exactly one schedule. A second `scheduleCall` in the same execution fails with `NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION` and fails the whole transaction.

**In BasketVault.** `runScheduled` calls `_bookNext` once and nothing else in a run books. Booking goes before the rebalance so a failing rebalance cannot cost the chain, and the rebalance inside the execution never schedules. A booking that fails inside a run emits `BookingFailed(responseCode)` and leaves `rebalanceInterval` untouched; `rearm()` is a separate transaction, so it is free to book, and anyone may call it while automation is on and no run is pending.

**Reproduce.** Each execution carries exactly one `SCHEDULECREATE` child:

```bash
ID=$(curl -s "$M/transactions?timestamp=1791020419.010852853" | jq -r '.transactions[0].transaction_id')
curl -s "$M/transactions?timestamp=gte:1791020419.010852853&timestamp=lt:1791020420&limit=100" |
  jq --arg id "$ID" '[.transactions[]|select(.transaction_id==$id and .name=="SCHEDULECREATE")]|length'
# 1
```

Unit tests: `test_scheduledRun_booksTheSuccessorBeforeItRebalances` asserts one `RunBooked` per execution; `test_scheduledRun_chainsAcrossSeveralRuns` asserts the Schedule Service sees one new call per run.

## Expiry is refused beyond 62 days

**What happens.** `scheduling.maxExpirationFutureSeconds` is 5,356,800, which is 62 days. A schedule booked past it comes back as a response code, not a revert.

**In BasketVault.** `MAX_INTERVAL = 60 days`, two days inside the limit, and `startAutomation` reverts `BadInterval` outside `[MIN_INTERVAL, MAX_INTERVAL]` (60 seconds to 60 days).

**Reproduce.** `hasScheduleCapacity` is the Schedule Service's own predicate, and it flips at 62 days:

```bash
NOW=$(date -u +%s)
for d in 61 62 63; do
  printf "%s days -> " $d
  cast call $HSS "hasScheduleCapacity(uint256,uint256)(bool)" $((NOW + d*86400)) 4000000 --rpc-url $RPC | tail -1
done
# 61 days -> true
# 62 days -> true
# 63 days -> false

# control: a second in the past is also refused, so the predicate is live
cast call $HSS "hasScheduleCapacity(uint256,uint256)(bool)" $((NOW - 10)) 4000000 --rpc-url $RPC | tail -1   # false
```

Unit tests: `test_start_rejectsIntervalsAboveSixtyDays`, `test_start_rejectsIntervalsBelowTheMinimum`.

## A busy second refuses new schedules

**What happens.** Each consensus second holds a bounded amount of scheduled gas. A booking for a full second fails with `SCHEDULE_EXPIRY_IS_BUSY`. [HIP-1215](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-1215.md) adds `hasScheduleCapacity(expirySecond, gasLimit)` so a contract can ask first.

**In BasketVault.** `_bookNext` asks `_secondWithCapacity` for a second before it calls `scheduleCall`. The ideal second is `block.timestamp + rebalanceInterval + jitter`, where the jitter is 0 to 29 seconds drawn from `blockhash` and `prevrandao` at booking time, so nobody can fill in advance the exact seconds a run will ask for. The function returns that second when it has capacity and otherwise probes +1, +2, +4, +8, +16, +32 and +64 seconds, so a busy second delays a run by seconds instead of ending the chain. If every probe is full, `scheduleCall` reports `SCHEDULE_EXPIRY_IS_BUSY`: inside a run that emits `BookingFailed` and `rearm()` books it later; in `startAutomation` it reverts `ScheduleFailed`.

**Reproduce.** The probe is a view call; this reads it at the vault's own interval and gas:

```bash
NOW=$(date -u +%s)
INT=$(cast call $V "rebalanceInterval()(uint256)" --rpc-url $RPC | n)
GAS=$(cast call $V "scheduledGas()(uint256)" --rpc-url $RPC | n)
cast call $HSS "hasScheduleCapacity(uint256,uint256)(bool)" $((NOW + INT)) $GAS --rpc-url $RPC | tail -1   # true
```

Unit tests with a mock Schedule Service that marks seconds busy: `test_capacity_usesTheIdealSecondWhenFree`, `test_capacity_picksIdealPlusDelayWhenIdealIsBusy`, `test_capacity_backsOffExponentially`, `test_capacity_reachesTheLongestProbe`, `test_capacity_failsWithBusyCodeWhenEverySlotIsTaken`.

**Source.** HIP-1215.

## The payer needs the full gas reservation, not the gas a run burns

**What happens.** The network checks the payer of a scheduled call against the gas reserved, `gasLimit x gas price`, not the gas burned. A vault holding more than a run costs can still fail with `INSUFFICIENT_PAYER_BALANCE`. At testnet's 88 tinybar per gas a 4,000,000 gas booking reserves 3.52 HBAR while a run charges 1.3055 to 1.9920 HBAR.

**In BasketVault.** Keep the native balance above the reservation. The runway, the number of runs the fuel pays for, is

```
runway = (fuel - scheduledGas x gasPrice) / chargePerRun + 1
```

The `+ 1` counts the last run, which needs the reservation but only spends the charge. `startAutomation` documents the requirement, and the app shows the runway next to the fuel balance. The vault pays from its own native HBAR, so `deposit` value never funds a run: the basket holds WHBAR and the native balance is fuel only (`withdrawFuel` cannot move basket tokens).

**Reproduce.**

```bash
GP=$(cast gas-price --rpc-url $RPC | n)                          # weibar per gas
TB=$((GP / 10000000000))                                         # tinybar per gas: 88
GAS=$(cast call $V "scheduledGas()(uint256)" --rpc-url $RPC | n)
FUEL=$(curl -s $M/accounts/$VID | jq .balance.balance)           # tinybar
COST=$(curl -s "$M/transactions?timestamp=1791020800.024519104" | jq '.transactions[0].charged_tx_fee')   # the buy run: 1.3964 HBAR
python3 -c "r=$GAS*$TB; print('reserve', r/1e8, 'HBAR  runway', ($FUEL-r)/$COST+1, 'runs')"
# reserve 3.52 HBAR; with 80.0026 HBAR of fuel and 1.3964 HBAR per run the runway is about 55 runs
```

What a run charges, read from the mirror for the five runs of vault C:

```bash
curl -s "$M/transactions?account.id=$VID&timestamp=gte:1791020000&timestamp=lte:1791020900&order=asc&limit=100" |
  jq -r '.transactions[]|select(.scheduled==true)|"\(.consensus_timestamp) charged=\(.charged_tx_fee)"'
# 1.3055 HBAR (no trade, three runs), 1.9920 HBAR (sell, includes the one-time USDC approval), 1.3964 HBAR (buy)
```

A 4 HBAR vault dying with 2.76 HBAR inside it is A testnet measurement of the same rule, still readable:

```bash
curl -s "$M/transactions?account.id=0.0.10684549&limit=2&order=desc" | jq -r '.transactions[]|"\(.result) charged=\(.charged_tx_fee)"'
# INSUFFICIENT_PAYER_BALANCE charged=2306440
# SUCCESS charged=162987482
```

## Scheduled calls read a clock about two seconds early

**What happens.** A call booked for second `T` executes at a consensus time within second `T` and reads `block.timestamp` about two seconds earlier. A testnet run recorded `scheduled for 1788608600, observed 1788608598`.

**In BasketVault.** The vault books relative to `block.timestamp` and never compares a deadline against it, so it has nothing to reject on arrival. Its effect is measurable: a run books its successor `interval + jitter - 2` seconds after the previous expiry, where the jitter is the contract's 0 to 29 second booking offset.

**Reproduce.** Vault C runs a 180 second interval with the 0 to 29 second booking offset, so its gaps are the interval plus the offset less the clock lag:

```bash
T=$(cast keccak "RunBooked(address,uint256)")
curl -s "$M/contracts/$VID/results/logs?topic0=$T&order=asc&timestamp=gte:1791006000&timestamp=lte:1791099999" |
  jq -r '.logs[]|.data' | while read e; do cast to-dec $e; done
```

The five executions land at 1791020053, 1791020236, 1791020419, 1791020611 and 1791020800: gaps of 183, 183, 192 and 189 seconds. Earlier deployments without the offset re-booked every `interval - 2` seconds (178 to 179 on a 180 second interval, 118 on a 120 second interval), which is the clock lag alone; their records are in [testnet-evidence.md](testnet-evidence.md#earlier-deployments-vault-b-and-vault-a).

## A balance read inside a scheduled run is short by the unreturned allowance

**What happens.** During a scheduled call the account has already been debited the whole gas allowance; the refund of unused gas lands when the call returns. A contract that reads its own balance mid-run sees it short by the unreturned part. A testnet run recorded 0.73 HBAR seen against 2.2245 HBAR after settlement on a vault funded with 4 HBAR.

**In BasketVault.** Nothing in a run reads `address(this).balance`. Fuel is read from outside (mirror node, `cast balance`), and `runScheduled` books the successor unconditionally.

**Reproduce.**

```bash
grep -n "address(this).balance" packages/foundry/contracts/BasketVault.sol     # no matches
```

## Testnet pools are not arbitraged

**What happens.** The testnet WHBAR/USDC pool prices HBAR near $1.91 while Chainlink's HBAR/USD feed reads about $0.10. Nobody arbitrages testnet pools, so a pool-versus-oracle guard that is right on mainnet would reject every testnet transaction.

**In BasketVault.** The price guard is configuration, not code: `guardLeg` names the stablecoin leg to check (`type(uint256).max` for none) and `maxDeviationBps` is the tolerance. The testnet deploy turns it off; a mainnet deploy sets `guardLeg` to the USDC leg and a tolerance such as 300. The unit tests exercise both the guard-on paths and the off switch (`test_guard_depositRevertsWhenThePoolIsFarBelowTheOracle`, `test_guard_isOffWhenNoGuardLegIsSet`).

**Reproduce.**

```bash
P=0x914B98992d7eD602D1f5d9084ECe8160Fc0e741a                     # WHBAR/USDC, 0.30%
TICK=$(cast call $P "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url $RPC | sed -n 2p | n)
python3 -c "print('pool implies USD/HBAR', 100/1.0001**$TICK)"   # about 1.9 (USDC is token0, 6 decimals; WHBAR 8)
cast call 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RPC | sed -n 2p | n
# about 10000000 with 8 decimals, i.e. $0.10
cast call $V "guardLeg()(uint256)" --rpc-url $RPC | n            # 115792089237316195423570985008687907853269984665640564039457584007913129639935 (off)
```

**Source.** Our cast reads.

## The Chainlink heartbeat is 24 hours

**What happens.** The testnet HBAR/USD proxy `0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a` has 8 decimals and a 86,400 second heartbeat, so a healthy feed can be nearly a day old.

**In BasketVault.** `maxOracleAge` is 90,000 seconds (25 hours), one hour of margin over the heartbeat. A feed older than that reverts `StaleOracle` on `deposit` and `rebalance`. Redemption never reads the oracle, so a stale feed never traps a holder: `test_redeem_worksWithStaleOracleWhereDepositReverts`.

**Reproduce.**

```bash
F=0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a
cast call $F "decimals()(uint8)" --rpc-url $RPC | n                                  # 8
cast call $F "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RPC | sed -n 4p | n   # updatedAt
cast call $V "maxOracleAge()(uint256)" --rpc-url $RPC | n                            # 90000
```

**Source.** Our cast reads.

## Bonzo's testnet oracle prices no reserve

**What happens.** Bonzo's testnet LendingPool lists six reserves, but its price oracle reverts `UnsupportedAsset()` for every one of them, so no borrow, health-factor or collateral flow can run on testnet.

**In BasketVault.** The vault has no lending dependency. NAV comes from SaucerSwap V2 pool prices and Chainlink prices the fund in USD; the HBAR leg is plain WHBAR.

**Reproduce.**

```bash
LP=0xf67DBe9bD1B331cA379c44b5562EAa1CE831EbC2          # Bonzo LendingPool, 0.0.4999355
ORACLE=0x9B940a1e60D652bCaf09C1d2224d1A4a544FDFb0
cast call $LP "getReservesList()(address[])" --rpc-url $RPC                                    # six reserves
cast call $ORACLE "getAssetPrice(address)(uint256)" 0x0000000000000000000000000000000000003aD2 --rpc-url $RPC
# execution reverted, data "0x24a01144"
cast 4byte 0x24a01144                                  # UnsupportedAsset()
```

**Source.** Our cast reads against Hashio on 2026-10-03.

## An HTS issuer can freeze or pause a token for a holder

**What happens.** An HTS token created with a freeze key or a pause key lets its issuer block transfers for one account (freeze) or for everyone (pause). A transfer of that token then fails at the Token Service, and a payout loop that includes it fails with it.

**In BasketVault.** `redeemExcept(shares, skipLegsMask)` takes a bitmask over `legs()`: bit `i` skips `legs()[i]`. The skipped token is not paid, the redeemer's slice of it stays in the vault for the remaining holders, and `LegsSkipped(account, mask)` records the choice. `redeem(shares)` is `redeemExcept(shares, 0)`. A mask with a bit beyond the last leg reverts `BadSkipMask`. The WHBAR leg is always paid and reads no price, so a holder can leave through the legs that work.

**Reproduce.** The token records show which basket tokens carry the keys:

```bash
for t in 0.0.15058 0.0.1183558 0.0.5449; do
  curl -s $M/tokens/$t | jq -c '{token_id,freeze_key,pause_key,pause_status}'
done
```

**Source.** The Hedera Token Service freeze and pause semantics; the unit tests in `test/BasketVaultFrozenLeg.t.sol` (`test_frozenLeg_blocksPlainRedeemForEveryone`, `test_redeemExcept_paysTheOtherLegsWhenOneIsFrozen`).

## Hashio caps eth_getLogs at a 7 day span

**What happens.** Hashio rejects a log query whose block range covers more than 7 days of consensus time, so a "from block 0" scan fails and older events fall out of reach.

**In BasketVault.** The contract emits every state change as an event (`Deposited`, `Redeemed`, `Swapped`, `Rebalanced`, `RunBooked`, `ScheduledRun`, `ScheduledRunFailed`) and the app reads them from the mirror node's `/contracts/{id}/results/logs`, which has no span cap for an address query. The same endpoint with a topic filter needs a timestamp range, so the helper in [testnet-evidence.md](testnet-evidence.md) passes one.

**Reproduce.**

```bash
bn=$(cast block-number --rpc-url $RPC)
cast logs --address $V --from-block $((bn - 5000)) --to-block latest --rpc-url $RPC | wc -l    # works: a short span
cast logs --address $V --from-block 0 --to-block latest --rpc-url $RPC
# error: ... contain timestamps that exceed the maximum allowed duration of 7 days (604800 seconds)

curl -s "$M/contracts/$VID/results/logs?order=asc&limit=100" | jq '.logs|length'               # the whole history, 100 per page
```

**Source.** Our measurement.

## Foundry 1.8 cannot reach Hashio, so the toolchain is pinned to v1.7.1

**What happens.** Foundry 1.8.x sends EIP-1898 block objects (`{"blockNumber": "0x..."}`) with its state reads. Hashio's relay accepts the object form on `eth_call` only, and answers `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount` and `eth_getStorageAt` with `-32602` before `forge script` sends anything. Foundry 1.7.1 sends plain tags and runs the same script to completion. Tracked upstream as [hiero-json-rpc-relay#5826](https://github.com/hiero-ledger/hiero-json-rpc-relay/issues/5826).

**In this repository.** `foundryup --install v1.7.1` is the first step of the template's outro, and CI installs the same version through `foundry-rs/foundry-toolchain@v1` with `version: v1.7.1`, so the contract tests and the deploy script run on the toolchain that Hashio accepts.

**Reproduce.**

```bash
curl -s $RPC -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x5bcE1085cfa81D11382924C45f93125932790e04","latest"]}' | jq -r '.result'
# 0x32b6e11a00986d8800   (a hex balance: the string tag works)
curl -s $RPC -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x5bcE1085cfa81D11382924C45f93125932790e04",{"blockNumber":"0x100"}]}' | jq -r '.error.code'
# -32602   (the EIP-1898 object form Foundry 1.8 sends)

cd packages/foundry
forge --version                                  # forge Version: 1.7.1
forge script script/Deploy.s.sol --rpc-url $RPC  # Script ran successfully. SIMULATION COMPLETE.
# the same command under v1.8.4: Error: HTTP error 400 ... "code":-32602 ... Invalid parameter 1
```

**Source.** Our runs on 2026-10-04 against the official v1.7.1 and v1.8.4 release builds, and the relay issue above.
