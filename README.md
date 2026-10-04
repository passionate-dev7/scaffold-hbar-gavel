# Gavel

**Live app:** [gavel-hbar.vercel.app](https://gavel-hbar.vercel.app)

An RFQ swap desk for Hedera, built as a [Scaffold-HBAR](https://docs.hedera.com/solutions/tools/scaffold-hbar/index) template. A taker escrows a swap order. Market makers answer with signed quotes on a Hedera Consensus Service topic. The taker accepts the best one and the desk settles it on chain. If nobody quotes, the order's own scheduled call swaps it on SaucerSwap V2 and pays the taker, so every order ends in tokens or a refund.

```bash
npm create scaffold-hbar@latest -- --template passionate-dev7/scaffold-hbar-gavel
```

## What does the work

| Protocol | Job in Gavel |
| --- | --- |
| Hedera Consensus Service | The public quote board. Makers post EIP-712 signed quotes to one topic, the app reads them from the mirror node and checks every signature in the browser |
| Hedera Token Service | Escrow and settlement. The desk holds the taker's WHBAR, pulls the maker's USDC through an HTS allowance, and refuses tokens with custom fees |
| Hedera Schedule Service | The fallback clock. `postOrder` books `fallbackFill(id)` for the order's expiry, a fill or cancel deletes it, and the network runs it with no human transaction |
| SaucerSwap V2 | The fallback venue and the price reference. The scheduled call swaps the escrow at the taker's own floor, straight to the taker |
| Chainlink on Hedera | A sanity band on HBAR/USD. A quote far below the oracle-implied amount is rejected, and a stale feed fails closed |

## Proof

**145 automated tests and 13 chain-read evidence rows.** 125 Foundry tests (unit, fuzz, and an invariant suite that holds escrow equal to open orders plus unclaimed refunds), 14 maker-bot tests, 6 app tests that verify a live HCS quote against the desk's EIP-712 domain. `scripts/verify-evidence.sh` re-reads the testnet run from the mirror node and Hashio and prints PASS or FAIL per row.

The canonical desk is `0x659380d965EE890fD93bf36C537dAd80ee76F73C` ([HashScan](https://hashscan.io/testnet/contract/0x659380d965EE890fD93bf36C537dAd80ee76F73C), Sourcify exact match). Three paths ran on it:

- **Maker quote over HCS:** order 1 settled by `fillWithQuote`, taker received 5,525,525 raw USDC, exactly the quote ([topic message](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10861214/messages/1)).
- **Network-run fallback:** order 2 swapped by the desk's own schedule, `scheduled: true` on the mirror, one `FellBack` event ([transaction](https://hashscan.io/testnet/transaction/1791141845.151550208)).
- **Cancel:** order 4 cancelled, its schedule reads `deleted: true` ([schedule](https://hashscan.io/testnet/schedule/0.0.10861248)).

The same three paths run through the app with a burner wallet, see [docs/testnet-evidence.md](docs/testnet-evidence.md).

## Five-minute path

Prerequisites: Node 20.18.3 or newer and Foundry 1.7.1 (`foundryup --install v1.7.1`; Hashio rejects Foundry 1.8, hiero-json-rpc-relay#5826).

```bash
npm create scaffold-hbar@latest -- --template passionate-dev7/scaffold-hbar-gavel my-desk
cd my-desk
yarn foundry:test                    # 125 tests, no network needed
```

1. Fund an ECDSA testnet account at the [Hedera faucet](https://portal.hedera.com/faucet) and put its key in `packages/foundry/.env` as `DEPLOYER_PRIVATE_KEY`.
2. `yarn foundry:live` deploys the desk, creates the quote topic, funds a maker, and runs the three paths with HashScan links.
3. `yarn next:dev` opens the desk at http://localhost:3000. Post an order, then run the maker (`cd scripts/maker && npm install && cd ../.. && node scripts/maker/maker.mjs --once`) and accept its quote on the board.
4. `bash scripts/verify-evidence.sh` re-reads the run from chain.

Use `npm run` in place of `yarn` for an npm project.

## Documentation

- [docs/architecture.md](docs/architecture.md): who can call what, and sequence diagrams for post, quote, fill, fallback and cancel.
- [docs/hedera-gotchas.md](docs/hedera-gotchas.md): the Hedera behaviours the desk is built around, each with a command that reproduces it.
- [docs/testnet-evidence.md](docs/testnet-evidence.md): every transaction of the testnet run and the app click-through.
- [scripts/maker/README.md](scripts/maker/README.md): the market-maker bot and its environment variables.
- [AGENTS.md](AGENTS.md): the briefing for coding agents, with invariants and environment variables.

## License

MIT, see [LICENCE](LICENCE). Built on Scaffold-HBAR.
