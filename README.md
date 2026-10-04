# Gavel

An RFQ desk on Hedera. A taker escrows a swap order, market makers answer with signed quotes on a Hedera Consensus Service topic, the best quote settles on chain through HTS allowances, and an order nobody fills is swapped on SaucerSwap V2 by its own Hedera Schedule Service call.

```bash
yarn install
yarn foundry:test
```

See AGENTS.md for the map, units and invariants.
