# Testnet evidence

Every figure below was read from Hedera testnet through Hashio JSON-RPC and the mirror node on 2026-10-04. Each section gives the transaction and a command that re-reads the result. `bash scripts/verify-evidence.sh` runs 13 of these checks and prints PASS or FAIL per row; it exits 1 on any FAIL.

Setup for the commands:

```bash
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=https://testnet.hashio.io/api
M=https://testnet.mirrornode.hedera.com/api/v1
D=0x659380d965EE890fD93bf36C537dAd80ee76F73C      # GavelDesk, contract 0.0.10861208
TOPIC=0.0.10861214
ORDER_SIG='getOrder(uint256)((address,address,address,uint24,uint256,uint256,uint64,address,uint8,uint8,uint256,uint256))'
```

Status codes in `getOrder(id)`: 0 Open, 1 Filled, 2 FellBack, 3 Cancelled, 4 Refunded.

## The deployment

| Item | Value |
| --- | --- |
| GavelDesk | `0x659380d965EE890fD93bf36C537dAd80ee76F73C`, [HashScan](https://hashscan.io/testnet/contract/0x659380d965EE890fD93bf36C537dAd80ee76F73C) |
| Source match | Sourcify exact match, [contract record](https://sourcify.dev/server/v2/contract/296/0x659380d965EE890fD93bf36C537dAd80ee76F73C) |
| Quote topic | 0.0.10861214, [HashScan](https://hashscan.io/testnet/topic/0.0.10861214), no submit key |
| Settings | fuel per order 4 HBAR, scheduled gas 3,000,000, band 300 bps, oracle age 90,000 s |
| Runtime size | 15,794 bytes |
| Token association | [2,221,902 gas](https://hashscan.io/testnet/transaction/0xfcbbed82d9d4eb8dfac995f1758970e62d506dd8909734fda5d2d74b65d2e804) for WHBAR, USDC and SAUCE |

```bash
cast codesize $D --rpc-url $RPC                                        # 15794
cast call $D "scheduledGas()(uint256)" --rpc-url $RPC                  # 3000000
cast call $D "fuelPerOrder()(uint256)" --rpc-url $RPC                  # 400000000
curl -s https://sourcify.dev/server/v2/contract/296/$D | jq -r .runtimeMatch   # exact_match
```

## Path A: a maker quote over HCS fills order 1

A 3 HBAR to USDC order with a floor of 4,963,047 raw USDC and a 600 second window. The maker bot signed a quote of 5,525,525 raw USDC, 0.20% above the pool spot of 5,514,497, and posted it to the topic. The taker submitted it.

| Step | Evidence |
| --- | --- |
| Post order | [gas 1,739,249](https://hashscan.io/testnet/transaction/0x19d5a8898828607be8a5cbd6bb3ec0c63cb415069dbd7c2eb23fdbcb5c56e7dc) |
| Quote on the topic | [sequence 1](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10861214/messages/1), consensus 1791141700.859219104 |
| Fill | [gas 220,127, fee 0.1827 HBAR](https://hashscan.io/testnet/transaction/0x62a9e738d563d8b4ed90665430ee8bc1f615c4b1bcbb745185b9b97a6e0956ea) |
| Outcome | status 1, the taker received 5,525,525 raw USDC, exactly the quote |

```bash
cast call $D "$ORDER_SIG" 1 --rpc-url $RPC | tr -s ' ' | cut -d, -f9           # 1 (Filled)
curl -s $M/topics/$TOPIC/messages/1 | jq -r '.message|@base64d'                # the signed quote JSON
cast call $D "nonceUsed(address,uint256)(bool)" 0x9Cad678f7D970afe0B9736Bae036877255a9dA84 1791141698 --rpc-url $RPC   # true
```

## Path B: nobody quotes, the network runs the fallback for order 2

The same order with a 120 second window and no quote. No transaction was sent after the post.

| Step | Evidence |
| --- | --- |
| Post order | [gas 1,722,137](https://hashscan.io/testnet/transaction/0xb7ac9633d8bd71028cd894f3b04c843bb323c075317e21805fa1a6dbb7f1fecb) |
| Scheduled execution | [1791141845.151550208](https://hashscan.io/testnet/transaction/1791141845.151550208), `scheduled: true`, SUCCESS, 0.7322 HBAR charged to the desk |
| Outcome | status 2, one `FellBack` event, the taker received 5,496,097 raw USDC against a floor of 4,963,047 |
| Compared with the quote | Path A's quote paid 53 bps more than the fallback on the same size |

```bash
curl -s "$M/transactions?timestamp=1791141845.151550208" | jq -c '.transactions[0]|{scheduled,result,charged_tx_fee,entity_id}'
# {"scheduled":true,"result":"SUCCESS","charged_tx_fee":73215711,"entity_id":"0.0.10861208"}
cast call $D "$ORDER_SIG" 2 --rpc-url $RPC | tr -s ' ' | cut -d, -f9           # 2 (FellBack)
```

## Path C: cancel order 4

| Step | Evidence |
| --- | --- |
| Post order | [gas 1,705,049](https://hashscan.io/testnet/transaction/0x76f58a8344ad522cdbccb74c2aafbf0f06d1ccbd51011aa2ceea5ac6f0a8a761) |
| Cancel | [gas 150,829, fee 0.1252 HBAR](https://hashscan.io/testnet/transaction/0x60befd9b873a8929f1a771781a90f1262e780b0c06abc1dcc15ca3480f0c598f) |
| Outcome | status 3, `ScheduleDeleted` response code 22, [schedule 0.0.10861248](https://hashscan.io/testnet/schedule/0.0.10861248) reads `deleted: true`, the order's 3 WHBAR left the desk with the cancel |

```bash
curl -s $M/schedules/0.0.10861248 | jq -c '{deleted,executed_timestamp}'       # {"deleted":true,"executed_timestamp":null}
```

## The same three paths through the app

The desk app ran from `yarn next:dev -p 3006` with a burner wallet (`0x670573733d8e5fA5ccF646eD186d52DCb3efb80C`) funded with 10 HBAR twice. Every click below was made in the browser; the contract state was then read back from chain.

| Action in the app | Evidence |
| --- | --- |
| Post order 6, 2 HBAR to USDC, floor 3.63711 USDC | [gas 1,722,149](https://hashscan.io/testnet/transaction/0x448c2e3354cbf08cf15794b15aa814dfdb5c79b942f10d8c29017f8413cac4f0), schedule 0.0.10861652 |
| `node scripts/maker/maker.mjs --once` | quote of 3,662,827 raw USDC, topic sequence 4, consensus 1791144313.781290727 |
| Board shows the quote | signature verified in the browser, +0.70% over the floor, -30 bps against pool spot |
| Accept | [gas 202,991](https://hashscan.io/testnet/transaction/0xb76bb4108fb872e6e8d3cccf321f25dfc337d482c63a9cc2e6923baa3d1bf668), `getOrder(6)` status 1, the burner's USDC balance read 3,662,827 |
| Post order 7, 1 HBAR | [gas 1,722,149](https://hashscan.io/testnet/transaction/0x655924bd098030946d08bff3ea7f70475644e8eefb3affaea69b1051b4ba05ed), schedule 0.0.10861684 |
| Cancel | [gas 146,029](https://hashscan.io/testnet/transaction/0xc724d4ae9a032ce14b0a920fab058d670a08c505c9d08a9bac19b2a0faf45860), `getOrder(7)` status 3, schedule 0.0.10861684 `deleted: true` |

```bash
cast call $D "$ORDER_SIG" 6 --rpc-url $RPC | tr -s ' ' | cut -d, -f9           # 1
cast call $D "$ORDER_SIG" 7 --rpc-url $RPC | tr -s ' ' | cut -d, -f9           # 3
cast call 0x0000000000000000000000000000000000001549 "balanceOf(address)(uint256)" 0x670573733d8e5fA5ccF646eD186d52DCb3efb80C --rpc-url $RPC   # 3662827
```

## How the evidence check can fail

`scripts/verify-evidence.sh` takes the order ids as environment variables. Pointing it at the wrong order turns rows red, which shows each row reads chain state rather than echoing a constant:

```bash
bash scripts/verify-evidence.sh                 # ORDER_A=1 ORDER_B=2 ORDER_C=4 by default: ALL ROWS PASS
ORDER_A=2 bash scripts/verify-evidence.sh       # order 2 is not Filled: 3 rows FAIL, exit 1
```

The suite behind the contract is 125 Foundry tests: unit, fuzz, and an invariant run (64 runs of depth 120) that holds escrow equal to open orders plus unclaimed refunds. Breaking the EIP-712 domain name in the contract turns `test_signature_viemVectorRecovers` red; restoring it turns the suite green.
