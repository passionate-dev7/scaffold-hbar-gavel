# Gavel agent: a Hedera Agent Kit plugin for the RFQ desk

An AI agent can sit on either side of the Gavel desk. As a **taker** it posts a swap order, reads and verifies the market makers' signed quotes from the Hedera Consensus Service topic, and settles with the best one. As a **market maker** it prices an order from the SaucerSwap V2 pool, signs an EIP-712 quote, and submits it to the same topic. Every order it posts is backed by a network-scheduled fallback swap, so the agent can reason about quotes against a guaranteed floor.

Built on `@hashgraph/hedera-agent-kit` 4.1.0. Standalone: its own `package.json`, not a root workspace.

## Tools

| Side | Tool | What it does |
| --- | --- | --- |
| taker | `post_order` | Prices `minOut` from the pool spot less `slippageBps`, checks the TTL window, pool, balance, allowance and association, escrows the amount (HBAR is wrapped) and books the fallback. Verifies `OrderPosted` and reads the order back. |
| taker | `list_quotes` | Reads the HCS topic from the mirror node, base64-decodes each message, and keeps only quotes whose EIP-712 signature recovers to the maker (`verifyTypedData`), that clear `minOut` and the Chainlink band, are unexpired and unspent. Sorted best first, with basis points over the fallback estimate and over `minOut`. |
| taker | `accept_quote` | `fillWithQuote` for the best verified quote whose maker holds and has approved the tokens. Refuses any account that is not the order's taker. Verifies `Filled`, the order status, the spent nonce and the exact token amount received. |
| taker | `cancel_order` | Returns the escrow and the fuel before expiry. Verifies `Cancelled` and the refunded amount. |
| taker | `get_order_status` | Status, floor, time left, the booked fallback schedule, whether the agent is the taker, and what happens next. Read-only. |
| maker | `quote_order` | Prices from `slot0` less `spreadBps`, signs the quote, checks the desk's own `quoteDigest` against the local hash, raises the allowance when short, submits to the topic with `TopicMessageSubmitTransaction`, and confirms the quote passes the board's checks. |
| maker | `cancel_quotes` | `cancelNonces(wordPos, mask)`: retires up to 256 quotes in one call, then verifies every nonce reads as spent. |

Results are structured (`raw`) with a human line (`humanMessage`), HashScan links for transactions, the desk, the topic and the fallback schedule, and the mirror node link of the topic message.

## Run it

```bash
cd agent && npm ci
npm test                       # 63 unit tests (vitest)
npm run typecheck
npx tsx examples/direct.ts     # read-only against the live desk, no LLM
npx tsx examples/direct.ts --roundtrip 1   # taker posts, maker quotes, taker lists and accepts
OPENAI_API_KEY=... npx tsx examples/ask.ts "Sell 1 HBAR for USDC and settle with the best quote"
ANTHROPIC_API_KEY=... npx tsx examples/ask.ts --maker "Quote the newest open order at 25 bps"
```

Keys are read from the environment or `packages/foundry/.env` and are never printed: `DEPLOYER_PRIVATE_KEY` is the taker, `MAKER_PRIVATE_KEY` (and `MAKER_ACCOUNT_ID`) is the maker. `examples/direct-readonly.txt` and `examples/roundtrip-testnet.txt` are saved runs.

## Load it into your own agent

```ts
import { HederaAIToolkit } from "@hashgraph/hedera-agent-kit-ai-sdk";
import { createGavelPlugin, gavelToolNames } from "./agent/src";

const toolkit = new HederaAIToolkit({
  client, // a @hiero-ledger/sdk Client with the agent's operator
  configuration: {
    plugins: [createGavelPlugin({ makerKey: process.env.MAKER_PRIVATE_KEY as `0x${string}` })], // makerKey only for a market maker
    tools: Object.values(gavelToolNames),
    context: { mode: AgentMode.AUTONOMOUS, accountId },
  },
});
```

`AgentMode.RETURN_BYTES` returns each transaction frozen and unsigned for a wallet to sign. The same plugin object works with the LangChain and MCP adapters of the Agent Kit.

The Hedera Agent Lab (https://portal.hedera.com/agent-lab) lists third-party Agent Kit plugins, CoinCap today. Gavel loads the same way: it is a standard `Plugin` with a `tools(context)` factory, and `createGavelPlugin()` returns it.

## One source for the desk

The desk address and ABI are read at runtime from `packages/nextjs/contracts/deployedContracts.ts`, the file every deploy regenerates, by the single `CONTRACT_NAME` constant in `src/config.ts` (override with `DESK_CONTRACT_NAME`). A redeploy or a contract rename needs no change here. The EIP-712 domain is read from the desk's `eip712Domain()`, so quotes are always signed and verified under the live contract's own name, version, chain and address.

| Variable | Purpose | Default |
| --- | --- | --- |
| `QUOTE_TOPIC_ID` | HCS quote topic | none, or pass `topicId` to a tool |
| `DEPLOYED_CONTRACTS_PATH` | Generated contracts file | `packages/nextjs/contracts/deployedContracts.ts` |
| `HEDERA_RPC_URL` | JSON-RPC relay | `https://testnet.hashio.io/api` |
| `HEDERA_MIRROR_URL` | Mirror node | `https://testnet.mirrornode.hedera.com` |
| `DESK_CONTRACT_NAME` | Key of the desk in the generated file | `GavelDesk` |

## Checks

- 63 tests cover parameter validation, quote parsing, signature verification (tampered amount, order, deadline or nonce; wrong maker; another desk or chain), quote sorting, maker pricing, the board's rejection reasons, the taker-only guard and the TTL window.
- Each guard was broken and the suite confirmed red, then restored: signature verification forced true (4 tests red), best-first sorting reversed (4 red), the taker-only check removed (1 red), the `minOut` screen removed (2 red), the zero-amount check removed (1 red), the TTL window check removed (1 red). Restored: 63 of 63 green.
- Anyone can post to the topic, so a message is shown only after it parses, names the order, clears the chain's own floors, recovers to its maker and carries an unspent nonce. Junk and forgeries are counted by reason in the result.
