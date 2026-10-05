# Hedera behaviours the desk is built around

`GavelDesk` depends on seventeen behaviours of the Hedera network that an Ethereum developer does not expect. Each entry gives what happens, where the contract handles it, a command that reproduces it against live testnet, and the measurement from a testnet run. Entries 12 to 15 belong to the RFQ design. The rest are the scheduling, token and fee behaviours the desk is built on, re-run against Gavel's own transactions.

Setup for the commands:

```bash
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=https://testnet.hashio.io/api
M=https://testnet.mirrornode.hedera.com/api/v1
D=0x659380d965EE890fD93bf36C537dAd80ee76F73C      # GavelDesk, 0.0.10861208
DID=0.0.10861208
MAKER=0x9Cad678f7D970afe0B9736Bae036877255a9dA84
```

| # | Behaviour | Handled by |
| --- | --- | --- |
| 1 | HBAR is tinybar inside the EVM and weibar at the JSON-RPC layer | all contract math in tinybar; the app converts with `parseEther` |
| 2 | An account receives an HTS token only after association (HIP-719) | `associateTokens`, `_associate`, `claim` |
| 3 | An HTS approval from a contract costs about 700k gas and is capped by max supply | `swapEscrow` approves `totalSupply()` once per token |
| 4 | A scheduled call runs with `msg.sender` equal to the booking contract | `fallbackFill`, `swapEscrow` and `OnlySelf` |
| 5 | `scheduleCall` costs about 1.4M gas and a scheduled call under 3M gas is unreliable | `MIN_SCHEDULED_GAS`, `postOrder` sent with 5M gas |
| 6 | One schedule per transaction | `postOrder` and `rearm` book exactly once |
| 7 | An expiry more than 62 days out is refused | `MAX_TTL = 60 days` |
| 8 | A second can be full | `_secondWithCapacity` probes +1 to +64 s |
| 9 | The payer needs the full gas reservation, not the gas a run burns | `fuelPerOrder` of 4 HBAR per order |
| 10 | Scheduled calls read a clock about two seconds early | `fallbackFill` checks no time |
| 11 | Testnet pools are not arbitraged and the Chainlink HBAR/USD heartbeat is 24 hours | `maxOracleAge` 90,000 s, a band that admits quotes above the pool |
| 12 | Only the order's taker may submit a quote | `OnlyTaker` in `fillWithQuote` |
| 13 | Quote nonces are a bitmap and only a successful fill spends one | `nonceBitmap`, `cancelNonces` |
| 14 | An HTS token can carry custom fees that change what a transfer moves | `getTokenCustomFees` check, intake delta, `Insolvent` cover check |
| 15 | HCS is a public, ordered quote board that anyone can write to | signature checks in the reader, settlement on the signed price |
| 16 | Foundry 1.8 cannot reach Hashio | the README pins Foundry 1.7.1 |
| 17 | Hashio caps `eth_getLogs` at a 7 day span | the app and the maker read events from the mirror node |

## HBAR is tinybar in the EVM and weibar over JSON-RPC

**What happens.** Hedera accounts hold HBAR with 8 decimals (tinybar). The EVM sees the same balance as `msg.value`, `address(this).balance` and `tx.gasprice` in tinybar. The JSON-RPC relay speaks 18 decimals, so a wallet sends 7 HBAR as `7e18` and the contract reads `700_000_000`.

**In GavelDesk.** Every native amount is tinybar: `fuelPerOrder` is `4e8`, `postOrder` takes `amountIn + fuel` as `msg.value`, the fuel refund is tinybar. WHBAR has 8 decimals as well. The app uses `parseEther` for HBAR amounts.

**Reproduce.** Order 1 of the canonical desk escrowed 3 HBAR with 4 HBAR of fuel:

```bash
H=0x19d5a8898828607be8a5cbd6bb3ec0c63cb415069dbd7c2eb23fdbcb5c56e7dc
cast tx $H value --rpc-url $RPC                    # 7000000000000000000  (weibar)
curl -s $M/contracts/results/$H | jq .amount      # 700000000            (tinybar)
cast gas-price --rpc-url $RPC                      # 860000000000 weibar = 86 tinybar per gas
```

**Source.** Measured on Hedera testnet; re-run here.

## HTS association before receipt (HIP-719)

**What happens.** An account receives an HTS token only if it is associated with it, unless it has automatic association slots. [HIP-719](https://github.com/hiero-ledger/hiero-improvement-proposals/blob/main/HIP/hip-719.md) exposes `associate()` on the token's own EVM address and returns a response code (22 success, 194 already associated) instead of reverting. Association costs gas: the desk's association of three tokens measured 2,221,902 gas.

**In GavelDesk.** `associateTokens` and the lazy association in `postOrder` call `IHRC719(token).associate()` and accept 22 and 194. A taker who is not associated with tokenOut cannot be paid by a fallback swap, so a failed refund parks the escrow as `claimable` and `claim(id)` pays it once the taker associates. The app puts an associate step in front of the post button when the output token is missing.

**Reproduce.**

```bash
curl -s $M/accounts/$DID/tokens | jq -c '.tokens[]|{token_id,automatic_association}'
# 0.0.5449, 0.0.15058, 0.0.1183558, each automatic_association=false: the desk associated them itself
curl -s $M/contracts/results/0xfcbbed82d9d4eb8dfac995f1758970e62d506dd8909734fda5d2d74b65d2e804 | jq .gas_used   # 2221902
```

**Source.** Measured on Hedera testnet.

## HTS approvals cost about 700k gas and stop at max supply

**What happens.** `approve` on an HTS token is a Token Service allowance. From an account it measured 727,020 gas for the maker's USDC approval to the desk. HTS refuses an allowance above a finite token's maximum supply, so the usual `type(uint256).max` approval reverts.

**In GavelDesk.** `swapEscrow` approves the SaucerSwap router for the token's `totalSupply()` only when the current allowance is short. The maker approves the desk once, then each fill is a cheap pull.

**Reproduce.**

```bash
curl -s $M/contracts/results/0x364fbe226fe6c9a388f280762e4f6159910e50d03a12ada245b9dae6a2a9df54 | jq .gas_used   # 727020, the maker approving the desk
curl -s $M/contracts/results/0x62a9e738d563d8b4ed90665430ee8bc1f615c4b1bcbb745185b9b97a6e0956ea | jq .gas_used   # 220127, a fill that pulls the maker's USDC
```

**Source.** Measured on Hedera testnet; the command above reproduces it.

## A scheduled call arrives with msg.sender equal to the booking contract

**What happens.** The network executes a schedule created by a contract as a call from that contract.

**In GavelDesk.** `fallbackFill` and `swapEscrow` are external, and their one access check is `if (msg.sender != address(this)) revert OnlySelf();`. Only the desk's own bookings reach them.

**Reproduce.**

```bash
cast call $D "fallbackFill(uint256)" 1 --rpc-url $RPC   # reverts with data 0x14d4a4e8
cast sig "OnlySelf()"                                    # 0x14d4a4e8
```

The positive case is order 2: the network ran `fallbackFill` and the mirror shows the transaction as `scheduled: true` with the desk as payer (entry 9). Unit test: `test_fallback_onlyTheDeskItselfMayCall`.

**Source.** Measured on Hedera testnet; the command above reproduces it.

## scheduleCall costs about 1.4M gas and a scheduled call needs 3M

**What happens.** Booking a schedule from a contract is expensive: `postOrder` measured 1.72M gas in total, of which `scheduleCall` is most. A scheduled call given less than 3M gas is not reliable on the network.

**In GavelDesk.** `MIN_SCHEDULED_GAS = 3_000_000` and the constructor reverts `BadConfig` below it. The live script sends `postOrder` with 5M gas.

**Reproduce.**

```bash
curl -s $M/contracts/results/0xb7ac9633d8bd71028cd894f3b04c843bb323c075317e21805fa1a6dbb7f1fecb | jq .gas_used   # 1722137
cast call $D "scheduledGas()(uint256)" --rpc-url $RPC                                                             # 3000000
```

**Source.** Measured on Hedera testnet (the floor); Gavel run (the post cost).

## One schedule per transaction

**What happens.** A second `scheduleCall` in the same transaction, or inside a scheduled execution, fails the transaction.

**In GavelDesk.** `postOrder` and `rearm` each book exactly once. `fallbackFill` never books, and a fill or cancel only deletes. Unit tests count the bookings of every entry point.

**Source.** Measured on Hedera testnet.

## An expiry more than 62 days out is refused

**What happens.** The Schedule Service refuses an expiry beyond 62 days from now.

**In GavelDesk.** `MAX_TTL = 60 days`; `postOrder` reverts `BadTtl(ttl)` outside `MIN_TTL` (60 s) to 60 days. Unit tests: `test_post_rejectsTtlOutsideTheWindow`.

**Source.** Measured on Hedera testnet (61 and 62 days accepted, 63 refused).

## A busy second refuses new schedules

**What happens.** Each second holds a limited number of scheduled executions. A booking for a full second fails with `SCHEDULE_EXPIRY_IS_BUSY`.

**In GavelDesk.** `_secondWithCapacity` probes `expiry`, +1, +2, +4 and on to +64 seconds with `hasScheduleCapacity` and books the first second with room. If every probe is full, `postOrder` reverts and the taker retries.

**Source.** Measured on Hedera testnet.

## The payer needs the full gas reservation, not the gas a run burns

**What happens.** A scheduled transaction is paid by the booking contract. The network reserves `gasLimit x gasPrice` up front and returns the unused part.

**In GavelDesk.** Each order carries `fuelPerOrder` (4 HBAR), enough for a 3M gas booking at the testnet price (about 2.6 HBAR) with room. A fill or cancel refunds the fuel to the taker; a fallback keeps it in the desk, where it pays for later runs. The fallback of order 2 charged 0.7322 HBAR to the desk against the 4 HBAR deposit.

**Reproduce.**

```bash
curl -s "$M/transactions?timestamp=1791141845.151550208" | jq -c '.transactions[0]|{scheduled,result,charged_tx_fee,entity_id}'
# {"scheduled":true,"result":"SUCCESS","charged_tx_fee":73215711,"entity_id":"0.0.10861208"}
```

**Source.** Measured on Hedera testnet; Gavel run.

## Scheduled calls read a clock about two seconds early

**What happens.** A scheduled call executes with a `block.timestamp` slightly before the second it was booked for.

**In GavelDesk.** `fallbackFill` checks no time. The schedule is booked at the order's `expiry`, quotes close at `expiry`, and a deadline check inside the fallback would reject the network's own run.

**Source.** Measured on Hedera testnet.

## Testnet pools are not arbitraged and the Chainlink heartbeat is 24 hours

**What happens.** On testnet the WHBAR/USDC pool prices 1 HBAR near 1.84 USDC while the Chainlink HBAR/USD feed reads about 0.10. The feed updates at most every 24 hours.

**In GavelDesk.** `maxOracleAge` is 90,000 s so a healthy feed never reads as stale. The band is a floor: it rejects a quote below the oracle-implied amount less `maxDeviationBps`, so on testnet it admits any quote at or above the pool. On mainnet the same band binds.

**Reproduce.**

```bash
cast call $D "hbarUsd()(uint256)" --rpc-url $RPC       # 10369444, i.e. $0.1037 with 8 decimals
cd packages/foundry && node scripts-js/pool-spot.mjs 0x914B98992d7eD602D1f5d9084ECe8160Fc0e741a \
  0x0000000000000000000000000000000000003aD2 100000000  # 1836924 raw USDC for 1 HBAR
```

**Source.** Measured on Hedera testnet; Gavel run.

## Only the order's taker may submit a quote

**What happens.** Quotes are public on the HCS topic, so anyone can read a maker's signed quote and call `fillWithQuote` with it.

**In GavelDesk.** `fillWithQuote` and `cancel` revert `OnlyTaker` for any other caller. A stranger cannot settle someone else's order with the worst valid quote on the board; only the taker picks which maker wins. The signature binds order id, maker, amount, deadline and nonce, and the EIP-712 domain binds the chain id and the desk address.

**Reproduce.**

```bash
cast sig "OnlyTaker()"      # 0xae10b561
```

Unit tests: `test_fill_aStrangerCannotSettleWithTheWorstQuoteOnTheBoard` and the `test_signature_*` set.

**Source.** Gavel design.

## Quote nonces are a bitmap and only a fill spends one

**What happens.** A maker signs many quotes. The desk must stop a quote from filling twice and let a maker withdraw quotes in bulk.

**In GavelDesk.** `nonceBitmap[maker][nonce / 256]` holds one bit per nonce. A fill sets the bit; a fill that reverts, for example because the maker is short of allowance, leaves the bit unset so the quote stays usable. `cancelNonces(wordPos, mask)` retires up to 256 quotes in one transaction.

**Reproduce.** Order 1 was filled with the maker's nonce 1791141698:

```bash
cast call $D "nonceUsed(address,uint256)(bool)" $MAKER 1791141698 --rpc-url $RPC   # true
cast call $D "nonceUsed(address,uint256)(bool)" $MAKER 1791141699 --rpc-url $RPC   # false
```

**Source.** Gavel design: a Permit2-style unordered nonce bitmap. Unit tests: `test_nonce_aRevertedFillDoesNotBurnIt`, `test_nonce_bulkCancelRetiresManyQuotesInOneTransaction`, `test_nonce_wordBoundariesAreIndependent`.

## An HTS token can carry custom fees

**What happens.** Fixed, fractional and royalty fees are charged inside a transfer, so the amount that arrives differs from the amount sent. A fee schedule key lets the issuer change them later.

**In GavelDesk.** `postOrder` reads `getTokenCustomFees` on precompile 0x167 for both tokens and reverts `CustomFees(token)` when either schedule is non-empty. It requires the balance delta of the intake to equal `amountIn` (`UnexpectedReceived`), and every payout of tokenIn re-checks that the desk still holds what it owes (`Insolvent`). WHBAR, USDC and SAUCE have empty schedules and no fee schedule key.

**Reproduce.**

```bash
for t in 0.0.5449 0.0.15058 0.0.1183558; do
  curl -s $M/tokens/$t | jq -c '{token_id,fixed:.custom_fees.fixed_fees,fractional:.custom_fees.fractional_fees,fee_schedule_key}'
done
# every line: empty fixed, empty fractional, fee_schedule_key null
```

Unit tests: `GavelFees.t.sol` (9 tests) pins the refusal for fixed, fractional and royalty fees, the intake delta and the cover check.

**Source.** Gavel design; HTS custom fee documentation.

## HCS is a public, ordered quote board that anyone can write to

**What happens.** A topic without a submit key accepts a message from any account, up to 1024 bytes, and the network assigns a consensus timestamp. Messages reach the mirror node a few seconds later: the first quote of the canonical run was readable about 7 seconds after submission.

**In GavelDesk.** The board is public by design, and settlement never depends on message order. The contract trusts only a maker's signature over the price, the deadline and the order's expiry. Readers treat the board as untrusted input: the app and the maker bot parse each message strictly (decimal strings, a 65-byte signature) and verify the signature against the desk's EIP-712 domain before showing a quote as fillable. Quotes carry integers as decimal strings so no consumer loses precision, and sorting is by amount with the earlier consensus timestamp breaking ties.

**Reproduce.**

```bash
curl -s $M/topics/0.0.10861214/messages/1 | jq -r '.consensus_timestamp, (.message|@base64d)'
# 1791141700.859219104
# {"orderId":"1","maker":"0x9Cad...","amountOut":"5525525","deadline":"...","nonce":"...","signature":"0x..."}
```

Unit tests: `packages/nextjs/utils/desk/quotes.test.mjs` verifies this live message against the Gavel domain, rejects malformed variants, and checks the sort order.

**Source.** Gavel run; HCS documentation.

## Foundry 1.8 cannot reach Hashio

**What happens.** Foundry 1.8 sends the EIP-1898 object form for block parameters, which Hashio rejects with `-32602` (hiero-json-rpc-relay#5826).

**In the template.** `template.json` and the README pin `foundryup --install v1.7.1`. Unit tests need no network, so the pin only matters for `foundry:live`.

**Source.** Measured on Hedera testnet.

## Hashio caps eth_getLogs at a 7 day span

**What happens.** A log query that spans more than 7 days is refused with error -32004.

**In GavelDesk.** The app and the maker bot read events from the mirror node `/contracts/{id}/results/logs` instead of `eth_getLogs`.

**Reproduce.**

```bash
cast logs --from-block 1 --to-block latest --address $D --rpc-url $RPC   # -32004 ... exceed the maximum allowed duration of 7 days
```

**Source.** Measured on Hedera testnet; Gavel run.
