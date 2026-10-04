import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deskAbi } from "./abi.mjs";
import {
  applySpread,
  decideQuote,
  quoteDeadline,
  quoteDigest,
  quoteJson,
  recoverQuoteSigner,
  signQuote,
  spotOut,
  STATUS,
} from "./lib.mjs";
import { fetchOrderPosted, loadConfig } from "./maker.mjs";

// Vector produced by BackstopDesk.quoteDigest(7, quote) (compiled from packages/foundry, deployed on an anvil
// chain with id 296 at DESK) and by `cast wallet sign --data` for the key below.
const DESK = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const MAKER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const QUOTE = { orderId: 7, maker: MAKER, amountOut: 1_850_000, deadline: 1_790_000_000, nonce: 7 };
const CONTRACT_DIGEST = "0xee59ff1bff2c196906c6bc7ce744308259066f8ac19c3f4f3c7f16cb0c303acf";
const CAST_SIGNATURE =
  "0xae2d71234717156e0bcb3bf7995f0310a25913a73b559176112ed592d9a28ae55013c27fef178cfceca2c4d5528745f019d1bfb8b745621484c216eda37384f71b";

const Q96 = 1n << 96n;
const NOW = 1_790_000_000;
const order = (o = {}) => ({
  status: STATUS.Open,
  expiry: NOW + 600,
  amountIn: 1_000_000n,
  minOut: 900_000n,
  ...o,
});

test("digest equals the contract's quoteDigest", () => {
  assert.equal(quoteDigest({ desk: DESK, chainId: 296, quote: QUOTE }), CONTRACT_DIGEST);
});

test("digest changes with chain id and desk", () => {
  assert.notEqual(quoteDigest({ desk: DESK, chainId: 295, quote: QUOTE }), CONTRACT_DIGEST);
  assert.notEqual(quoteDigest({ desk: MAKER, chainId: 296, quote: QUOTE }), CONTRACT_DIGEST);
});

test("signature equals foundry cast and recovers to the maker", async () => {
  const signature = await signQuote({ privateKey: KEY, desk: DESK, chainId: 296, quote: QUOTE });
  assert.equal(signature, CAST_SIGNATURE);
  assert.equal(await recoverQuoteSigner({ desk: DESK, chainId: 296, quote: QUOTE, signature }), MAKER);
  assert.equal(privateKeyToAccount(KEY).address, MAKER);
});

test("quote JSON has exactly the six HCS fields, decimal strings, under the 1024 byte message cap", async () => {
  const signature = await signQuote({ privateKey: KEY, desk: DESK, chainId: 296, quote: QUOTE });
  const raw = quoteJson({ ...QUOTE, signature });
  const msg = JSON.parse(raw);
  assert.deepEqual(Object.keys(msg), ["orderId", "maker", "amountOut", "deadline", "nonce", "signature"]);
  assert.deepEqual(msg, {
    orderId: "7",
    maker: MAKER,
    amountOut: "1850000",
    deadline: "1790000000",
    nonce: "7",
    signature: CAST_SIGNATURE,
  });
  assert.ok(Buffer.byteLength(raw) < 1024);
  const parsed = { ...msg };
  assert.equal(await recoverQuoteSigner({ desk: DESK, chainId: 296, quote: parsed, signature: msg.signature }), MAKER);
});

test("spot value: price 1, price 4 in both directions, a uint256-sized amount keeps precision", () => {
  assert.equal(spotOut({ amountIn: 123n, sqrtPriceX96: Q96, tokenInIsToken0: true }), 123n);
  assert.equal(spotOut({ amountIn: 1000n, sqrtPriceX96: 2n * Q96, tokenInIsToken0: true }), 4000n);
  assert.equal(spotOut({ amountIn: 1000n, sqrtPriceX96: 2n * Q96, tokenInIsToken0: false }), 250n);
  const big = 10n ** 30n;
  assert.equal(spotOut({ amountIn: big, sqrtPriceX96: Q96, tokenInIsToken0: true }), big);
});

test("spot value matches the live WHBAR/USDC pool slot0 (token0 USDC, token1 WHBAR)", () => {
  // slot0 read from 0x914B9899...741a on testnet: tick 39883. 10 WHBAR in, USDC out.
  const sqrtPriceX96 = 581961779276239106252821611146n;
  const usdc = spotOut({ amountIn: 1_000_000_000n, sqrtPriceX96, tokenInIsToken0: false });
  assert.ok(usdc > 18_000_000n && usdc < 19_000_000n, `10 WHBAR should be ~18.5 USDC, got ${usdc}`);
});

test("spread is subtracted, in basis points, rounding down", () => {
  assert.equal(applySpread(1_000_000n, 30), 997_000n);
  assert.equal(applySpread(1_000_000n, 0), 1_000_000n);
  assert.equal(applySpread(999n, 30), 996n);
  assert.throws(() => applySpread(1n, 10_000));
  assert.throws(() => applySpread(1n, -1));
});

test("quote is the spot value minus the spread", () => {
  const d = decideQuote({ order: order(), sqrtPriceX96: Q96, tokenInIsToken0: true, spreadBps: 30, nowSec: NOW });
  assert.deepEqual(d, { ok: true, amountOut: 997_000n });
});

test("skips when the spread-adjusted quote falls below the order's minOut", () => {
  const d = decideQuote({ order: order({ minOut: 997_001n }), sqrtPriceX96: Q96, tokenInIsToken0: true, spreadBps: 30, nowSec: NOW });
  assert.equal(d.ok, false);
  assert.match(d.reason, /below minOut/);
  const eq = decideQuote({ order: order({ minOut: 997_000n }), sqrtPriceX96: Q96, tokenInIsToken0: true, spreadBps: 30, nowSec: NOW });
  assert.equal(eq.ok, true);
});

test("skips orders that are not Open or have expired", () => {
  for (const status of [STATUS.Filled, STATUS.FellBack, STATUS.Cancelled, STATUS.Refunded]) {
    const d = decideQuote({ order: order({ status }), sqrtPriceX96: Q96, tokenInIsToken0: true, spreadBps: 30, nowSec: NOW });
    assert.deepEqual(d, { ok: false, reason: "not open" });
  }
  const e = decideQuote({ order: order({ expiry: NOW }), sqrtPriceX96: Q96, tokenInIsToken0: true, spreadBps: 30, nowSec: NOW });
  assert.deepEqual(e, { ok: false, reason: "expired" });
});

test("skips when the quote would fall under the desk's oracle floor", () => {
  const args = { order: order(), sqrtPriceX96: Q96, tokenInIsToken0: true, spreadBps: 30, nowSec: NOW };
  assert.equal(decideQuote({ ...args, oracleFloor: 997_001n }).ok, false);
  assert.equal(decideQuote({ ...args, oracleFloor: 997_000n }).ok, true);
  assert.equal(decideQuote({ ...args, oracleFloor: 0n }).ok, true);
});

test("quote deadline is the earlier of now+ttl and the order expiry", () => {
  assert.equal(quoteDeadline({ orderExpiry: NOW + 600, nowSec: NOW, ttlSec: 300 }), BigInt(NOW + 300));
  assert.equal(quoteDeadline({ orderExpiry: NOW + 100, nowSec: NOW, ttlSec: 300 }), BigInt(NOW + 100));
});

test("config: defaults, required fields, and no key in errors", () => {
  const env = { DESK_ADDRESS: DESK, QUOTE_TOPIC_ID: "0.0.1", MAKER_PRIVATE_KEY: KEY };
  const c = loadConfig(env, ["--once", "--dry-run"]);
  assert.equal(c.spreadBps, 30);
  assert.equal(c.chainId, 296);
  assert.equal(c.rpcUrl, "https://testnet.hashio.io/api");
  assert.equal(c.once && c.dryRun && !c.autoFillIgnored, true);
  assert.equal(loadConfig(env, ["--auto-fill"]).autoFillIgnored, true);
  assert.equal("autoFill" in c, false);
  assert.throws(() => loadConfig({ ...env, DESK_ADDRESS: undefined }, []), /DESK_ADDRESS/);
  assert.throws(() => loadConfig({ ...env, QUOTE_TOPIC_ID: undefined }, []), /QUOTE_TOPIC_ID/);
  assert.doesNotThrow(() => loadConfig({ ...env, QUOTE_TOPIC_ID: undefined }, ["--dry-run"]));
  try {
    loadConfig({ DESK_ADDRESS: DESK, QUOTE_TOPIC_ID: "0.0.1" }, []);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(!e.message.includes(KEY));
  }
});

test("mirror log decoding keeps OrderPosted ids, ignores other events, follows paging", async () => {
  const ev = deskAbi.find((x) => x.type === "event" && x.name === "OrderPosted");
  const log = (id, ts) => ({
    timestamp: ts,
    topics: encodeEventTopics({ abi: [ev], eventName: "OrderPosted", args: { id, taker: MAKER } }),
    data: encodeAbiParameters(
      ev.inputs.filter((i) => !i.indexed),
      [DESK, DESK, 3000, 1000n, 900n, 1790000600n, DESK, 1790000600n],
    ),
  });
  const other = { timestamp: "1790000001.000000002", topics: ["0x" + "11".repeat(32)], data: "0x" };
  const pages = {
    first: { logs: [log(1n, "1790000001.000000001"), other], links: { next: "/api/v1/next" } },
    next: { logs: [log(2n, "1790000002.000000001")], links: { next: null } },
  };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes("/next") ? pages.next : pages.first;
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const cfg = { desk: DESK, mirrorUrl: "https://mirror.test" };
    const { ids, cursor } = await fetchOrderPosted(cfg, "0");
    assert.deepEqual(ids, [1n, 2n]);
    assert.equal(cursor, "1790000002.000000001");
    assert.match(calls[0], new RegExp(`/api/v1/contracts/${DESK}/results/logs\\?order=asc&limit=100&timestamp=gt:0$`));
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
