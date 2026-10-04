# Gavel maker bot

A market maker for the Gavel desk. It watches `OrderPosted` events, prices each open order from the SaucerSwap V2 pool, signs an EIP-712 `Quote`, and posts the quote to a Hedera Consensus Service topic. Takers read the topic from the mirror node, verify the signature, and settle the best quote with `fillWithQuote`. The bot keeps the desk's allowance on `tokenOut` topped up. Fills are taker-only (`OnlyTaker`): the order's taker accepts a quote, the maker never settles its own.

It is a plain Node script with its own `package.json` (viem and `@hiero-ledger/sdk` only) and sits outside the repo's yarn workspaces.

## Setup

```bash
cd scripts/maker
npm install
cp ../../packages/foundry/.env.example ../../packages/foundry/.env   # if you have no .env yet
```

Node 20.12 or newer. The bot reads `packages/foundry/.env` when it exists, so `MAKER_PRIVATE_KEY` (or the `DEPLOYER_PRIVATE_KEY` already there) never has to be exported. Keys are never printed.

The maker account needs `tokenOut` for the pairs it quotes (WHBAR, USDC or SAUCE), and a little HBAR for HCS fees and approvals. If `MAKER_ACCOUNT_ID` is unset the bot looks it up on the mirror node from the key's EVM address.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `DESK_ADDRESS` | required | GavelDesk contract address |
| `QUOTE_TOPIC_ID` | required unless `--dry-run` | HCS topic that carries the quotes, for example `0.0.12345` |
| `MAKER_PRIVATE_KEY` | `DEPLOYER_PRIVATE_KEY` | ECDSA (secp256k1) key, hex. Signs quotes, pays HCS fees, sends approvals |
| `MAKER_ACCOUNT_ID` | looked up on the mirror node | Hedera account id of that key, the HCS operator |
| `HEDERA_NETWORK` | `testnet` | `testnet`, `mainnet` or `previewnet` (sets the EIP-712 chain id: 296, 295, 297) |
| `SPREAD_BPS` | `30` | Quote = pool spot value minus this many basis points |
| `MIRROR_URL` | `https://<network>.mirrornode.hedera.com` | Mirror node base URL |
| `RPC_URL` | `https://testnet.hashio.io/api` | JSON-RPC endpoint |
| `QUOTE_TTL_SECONDS` | `300` | Quote validity, capped at the order's expiry |
| `POLL_SECONDS` | `10` | Loop interval |

## Commands

```bash
node scripts/maker/maker.mjs --once --dry-run   # print the quotes it would post, send nothing
node scripts/maker/maker.mjs --once             # quote every open order, then exit
node scripts/maker/maker.mjs                    # loop every POLL_SECONDS
node scripts/maker/maker.mjs --auto-fill        # accepted for old scripts, logs a notice and does nothing
npm test                                        # unit tests (node:test)
```

Run from the repo root as above, or from `scripts/maker` with `npm run dry-run`, `npm run once`, `npm start`.

## What one pass does

1. Reads `OrderPosted` logs from `/api/v1/contracts/{desk}/results/logs` and decodes them with the desk ABI.
2. Reads each tracked order with `getOrder`. Orders that are not `Open`, or are past `expiry`, are dropped.
3. Prices the order from the pool for `(tokenIn, tokenOut, fee)` returned by the desk's SaucerSwap V2 factory: `slot0().sqrtPriceX96` gives token1 per token0, converted in the direction of the order. `amountOut = spot * (10000 - SPREAD_BPS) / 10000`.
4. Skips the order when `amountOut < minOut`, when `amountOut` is under the desk's `oracleFloor(id)`, or when the maker balance cannot cover the quote together with its other live quotes.
5. Approves the desk for the total of its live quotes on that `tokenOut` when the allowance is short, and checks the allowance afterwards.
6. Signs the typed data, recovers the signer from its own signature, and submits the JSON to the topic. The receipt must say `SUCCESS` before the order counts as quoted.
7. Re-quotes an order when its previous quote is within 30 seconds of its deadline.

## The EIP-712 quote

```
domain: { name: "Gavel", version: "1", chainId: 296, verifyingContract: <desk> }
Quote(uint256 orderId,address maker,uint256 amountOut,uint64 deadline,uint256 nonce)
```

`lib.mjs` exports `quoteDigest`, which equals `GavelDesk.quoteDigest(orderId, quote)` byte for byte. The unit tests pin it to a digest produced by the compiled contract and to a signature produced by `cast wallet sign --data`. The nonce is the order id, so a quote can be re-posted with a later deadline without burning a second nonce, and `invalidateNonce` on the desk withdraws it.

## The HCS message

One topic message is one UTF-8 JSON object. Integers are decimal strings.

```json
{
  "orderId": "7",
  "maker": "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  "amountOut": "1850000",
  "deadline": "1790000000",
  "nonce": "7",
  "signature": "0xae2d...1b"
}
```

| Field | Type on the desk | Meaning |
| --- | --- | --- |
| `orderId` | `uint256` | Order the quote answers |
| `maker` | `address` | Signer and payer of `tokenOut` |
| `amountOut` | `uint256` | Raw units of the order's `tokenOut` paid to the taker |
| `deadline` | `uint64` | Unix seconds; the desk rejects the quote after it |
| `nonce` | `uint256` | Consumed on fill |
| `signature` | `bytes` | 65-byte EIP-712 signature, `0x` hex |

The consensus timestamp the network assigns to the message is the quote's fair arrival order.

## How a taker reads quotes

```bash
TOPIC=0.0.12345
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/$TOPIC/messages?order=asc&limit=100" \
  | jq -r '.messages[] | "\(.consensus_timestamp) \(.message | @base64d)"'
```

Each `message` is base64. Decode it, `JSON.parse` it, keep the objects whose `orderId` matches, verify the signature against the desk's domain (`verifyTypedData` in viem, or `lib.mjs` `recoverQuoteSigner`), drop quotes past `deadline` or below the order's `minOut`, and sort by `amountOut` descending with the consensus timestamp as the tie-break. Settle with:

```
fillWithQuote(orderId, { maker, amountOut, deadline, nonce }, signature)
```

The maker must hold and have approved `amountOut` of `tokenOut`; the taker must be associated with `tokenOut`.
