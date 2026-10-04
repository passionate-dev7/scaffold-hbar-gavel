import { describe, expect, it } from "vitest";
import { CONTRACT_NAME, configFromEnv, parseDeployedContracts } from "../src/config";
import { QUOTE_TYPES, parseWireQuote, priceQuote, quoteDeadline, quoteHash, quoteJson, screenQuote, signQuote, sortQuotes, verifyQuote } from "../src/quote";
import { acceptQuoteSchema, cancelQuotesSchema, postOrderSchema, quoteOrderSchema } from "../src/schemas";
import { bpsOver, lessBps, parseAmount, spotOut } from "../src/units";
import { DOMAIN, ID, MAKER, MAKER_KEY, NOW, OTHER, OTHER_KEY, signed } from "./fixture";

describe("config: the desk comes from deployedContracts.ts at runtime", () => {
  const fake = (name: string, address: string, fns: string[] = []) =>
    `const deployedContracts = { 296: { ${name}: { address: "${address}", abi: [${fns.map((n) => `{ type: "function", name: "${n}", inputs: [], outputs: [], stateMutability: "view" }`).join(",")}] } } } as const;\nexport default deployedContracts;`;
  const all = ["postOrder", "getOrder", "fillWithQuote", "cancel", "cancelNonces", "nonceUsed", "oracleFloor", "quoteDigest", "eip712Domain", "factory", "whbar", "usdToken", "fuelPerOrder", "MIN_TTL", "MAX_TTL"];

  it("reads the address and ABI of CONTRACT_NAME from the real generated file", () => {
    const c = configFromEnv({});
    expect(c.contractName).toBe(CONTRACT_NAME);
    expect(c.desk).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(c.abi.some((x) => x.type === "function" && x.name === "fillWithQuote")).toBe(true);
  });

  it("follows the file, not a constant: a redeploy at another address is picked up", () => {
    const a = "0x1111111111111111111111111111111111111111";
    expect(configFromEnv({}, () => fake(CONTRACT_NAME, a, all)).desk).toBe(a);
  });

  it("names the contracts it found when CONTRACT_NAME is missing", () => {
    expect(() => configFromEnv({}, () => fake("OldDesk", "0x1111111111111111111111111111111111111111", all))).toThrow(/no .* on chain 296 \(found: OldDesk\)/);
  });

  it("refuses an ABI that is not a desk, and a malformed topic", () => {
    expect(() => configFromEnv({}, () => fake(CONTRACT_NAME, "0x1111111111111111111111111111111111111111", ["postOrder"]))).toThrow(/lacks/);
    expect(() => configFromEnv({ QUOTE_TOPIC_ID: "10860170" })).toThrow(/QUOTE_TOPIC_ID/);
  });

  it("refuses a file that is not the generated shape", () => {
    expect(() => parseDeployedContracts("export const x = 1;")).toThrow(/deployedContracts/);
  });
});

describe("amounts", () => {
  it("parses decimals against the token's own precision and refuses zero and excess places", () => {
    expect(parseAmount("2", 8)).toBe(200_000_000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(() => parseAmount("0.0000001", 6)).toThrow(/at most 6/);
    expect(() => parseAmount("0", 8)).toThrow(/above zero/);
    expect(() => parseAmount("-1", 8)).toThrow();
    expect(() => parseAmount("1e3", 8)).toThrow();
  });

  it("prices from a V3 sqrtPrice in both directions", () => {
    const one = 1n << 96n;
    expect(spotOut({ amountIn: 1000n, sqrtPriceX96: one, tokenInIsToken0: true })).toBe(1000n);
    expect(spotOut({ amountIn: 1000n, sqrtPriceX96: one * 2n, tokenInIsToken0: true })).toBe(4000n);
    expect(spotOut({ amountIn: 1000n, sqrtPriceX96: one * 2n, tokenInIsToken0: false })).toBe(250n);
  });

  it("lessBps rounds down and rejects a spread of 100% or more", () => {
    expect(lessBps(10_000n, 30)).toBe(9_970n);
    expect(lessBps(999n, 1)).toBe(998n);
    expect(() => lessBps(1n, 10_000)).toThrow();
    expect(() => lessBps(1n, -1)).toThrow();
    expect(bpsOver(10_053n, 10_000n)).toBe(53);
    expect(bpsOver(1n, 0n)).toBeNull();
  });
});

describe("quote wire format", () => {
  it("round-trips a signed quote through the JSON the maker posts", async () => {
    const q = await signed();
    const parsed = parseWireQuote(quoteJson(q));
    expect(parsed).toEqual({ ok: true, quote: q });
    expect(JSON.parse(quoteJson(q)).amountOut).toBe("5300000");
  });

  it("turns every kind of junk into a reason, never an exception", async () => {
    const q = await signed();
    const w = JSON.parse(quoteJson(q));
    expect(parseWireQuote("not json")).toEqual({ ok: false, reason: "not JSON" });
    expect(parseWireQuote("[]")).toMatchObject({ ok: false });
    expect(parseWireQuote(JSON.stringify({ ...w, amountOut: "-5" }))).toMatchObject({ ok: false });
    expect(parseWireQuote(JSON.stringify({ ...w, amountOut: 5 }))).toMatchObject({ ok: false });
    expect(parseWireQuote(JSON.stringify({ ...w, maker: "0x12" }))).toMatchObject({ ok: false });
    expect(parseWireQuote(JSON.stringify({ ...w, signature: "0x12" }))).toMatchObject({ ok: false });
    expect(parseWireQuote(JSON.stringify({ ...w, deadline: (2n ** 64n).toString() }))).toMatchObject({ ok: false });
    expect(parseWireQuote(JSON.stringify({ ...w, nonce: (2n ** 256n).toString() }))).toMatchObject({ ok: false });
  });
});

describe("signature verification", () => {
  it("accepts a quote signed by its maker under the desk's domain", async () => {
    expect(await verifyQuote(DOMAIN, await signed())).toBe(true);
  });

  it("rejects a changed amount, order, deadline or nonce (each is bound by the signature)", async () => {
    const q = await signed();
    for (const bad of [{ amountOut: q.amountOut + 1n }, { orderId: q.orderId + 1n }, { deadline: q.deadline + 1n }, { nonce: q.nonce + 1n }]) {
      expect(await verifyQuote(DOMAIN, { ...q, ...bad })).toBe(false);
    }
  });

  it("rejects a quote claimed by a maker who did not sign it", async () => {
    const q = await signed();
    expect(await verifyQuote(DOMAIN, { ...q, maker: OTHER })).toBe(false);
    const other = await signed({}, OTHER_KEY);
    expect(await verifyQuote(DOMAIN, { ...other, maker: MAKER })).toBe(false);
  });

  it("rejects a signature made for another desk or chain (domain separation)", async () => {
    const q = await signed();
    expect(await verifyQuote({ ...DOMAIN, verifyingContract: "0x00000000000000000000000000000000000000dE" }, q)).toBe(false);
    expect(await verifyQuote({ ...DOMAIN, chainId: 295 }, q)).toBe(false);
    expect(await verifyQuote({ ...DOMAIN, name: "Backstop" }, q)).toBe(false);
  });

  it("a malformed signature is false, not a throw; a signer key must be the maker", async () => {
    const q = await signed();
    expect(await verifyQuote(DOMAIN, { ...q, signature: `0x${"00".repeat(65)}` })).toBe(false);
    await expect(signQuote(OTHER_KEY, DOMAIN, { orderId: ID, maker: MAKER, amountOut: 1n, deadline: 1n, nonce: 1n })).rejects.toThrow(/not the quote's maker/);
  });

  it("pins the EIP-712 vector of the desk's contract tests", () => {
    // The type string the contract hashes: QUOTE_TYPEHASH in BackstopDesk.sol / GavelDesk.sol.
    const type = `Quote(${QUOTE_TYPES.Quote.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(type).toBe("Quote(uint256 orderId,address maker,uint256 amountOut,uint64 deadline,uint256 nonce)");
    expect(quoteHash(DOMAIN, { orderId: 1n, maker: MAKER, amountOut: 2n, deadline: 3n, nonce: 4n })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("screening a quote against chain facts", () => {
  const ctx = { orderId: ID, minOut: 4_800_000n, oracleFloor: 4_500_000n as bigint | null, nowSec: NOW, orderExpiry: BigInt(NOW + 600) };
  const q = { orderId: ID, maker: MAKER, amountOut: 5_300_000n, deadline: BigInt(NOW + 300), nonce: ID };

  it("passes a good quote", () => expect(screenQuote(q, ctx)).toBeNull());
  it("rejects another order, an expired deadline, an expired order", () => {
    expect(screenQuote({ ...q, orderId: 6n }, ctx)).toBe("other order");
    expect(screenQuote({ ...q, deadline: BigInt(NOW) }, ctx)).toBe("deadline passed");
    expect(screenQuote(q, { ...ctx, orderExpiry: BigInt(NOW) })).toBe("order expired");
  });
  it("keeps a margin when asked, so a quote about to lapse is not accepted", () => {
    expect(screenQuote({ ...q, deadline: BigInt(NOW + 10) }, { ...ctx, minRemainingSec: 20 })).toBe("deadline passed");
  });
  it("rejects below minOut and below the Chainlink band, but a zero band floor adds nothing", () => {
    expect(screenQuote({ ...q, amountOut: 4_799_999n }, ctx)).toBe("below the order's minOut");
    expect(screenQuote({ ...q, amountOut: 5_000_000n }, { ...ctx, minOut: 1n, oracleFloor: 5_100_000n })).toBe("below the Chainlink band");
    expect(screenQuote({ ...q, amountOut: 5_000_000n }, { ...ctx, oracleFloor: 0n })).toBeNull();
  });
});

describe("sorting", () => {
  const base = { orderId: ID, deadline: 1n, nonce: 1n, signature: "0x00" as const };
  const mk = (amountOut: bigint, ts: string, maker: `0x${string}`, sequence: number) => ({ ...base, maker, amountOut, consensusTimestamp: ts, sequence });

  it("best amount first; ties go to the earlier consensus time, then the lower maker address", () => {
    const a = mk(100n, "5.000000000", MAKER, 1);
    const b = mk(300n, "9.000000000", OTHER, 2);
    const c = mk(300n, "4.000000000", MAKER, 3);
    const d = mk(300n, "4.000000000", OTHER, 4);
    const sorted = sortQuotes([a, b, c, d]);
    const lowerFirst = MAKER.toLowerCase() < OTHER.toLowerCase() ? [c, d] : [d, c];
    expect(sorted.map((x) => x.sequence)).toEqual([...lowerFirst, b, a].map((x) => x.sequence));
  });

  it("does not mutate its input and handles an empty board", () => {
    const input = [mk(1n, "1.0", MAKER, 1), mk(2n, "1.0", OTHER, 2)];
    sortQuotes(input);
    expect(input[0]!.amountOut).toBe(1n);
    expect(sortQuotes([])).toEqual([]);
  });
});

describe("maker pricing", () => {
  const args = { status: 0, expiry: BigInt(NOW + 600), minOut: 4_800_000n, nowSec: NOW, spotOut: 5_328_102n, spreadBps: 30, oracleFloor: 4_500_000n as bigint | null };

  it("quotes the pool spot less the spread", () => {
    expect(priceQuote(args)).toEqual({ ok: true, amountOut: (5_328_102n * 9_970n) / 10_000n });
  });
  it("declines a closed or expired order", () => {
    expect(priceQuote({ ...args, status: 1 })).toMatchObject({ ok: false, reason: "order is not open" });
    expect(priceQuote({ ...args, expiry: BigInt(NOW) })).toMatchObject({ ok: false, reason: "order expired" });
  });
  it("declines a price the desk would reject: under minOut or under the Chainlink band", () => {
    expect(priceQuote({ ...args, spotOut: 4_800_000n })).toMatchObject({ ok: false, reason: expect.stringContaining("below the order's minOut") });
    expect(priceQuote({ ...args, minOut: 1n, oracleFloor: 5_400_000n })).toMatchObject({ ok: false, reason: expect.stringContaining("Chainlink band") });
  });
  it("refuses a spread that would invert the price, and a price that rounds to zero", () => {
    expect(priceQuote({ ...args, spreadBps: 10_000 })).toMatchObject({ ok: false });
    expect(priceQuote({ ...args, spreadBps: -1 })).toMatchObject({ ok: false });
    expect(priceQuote({ ...args, spotOut: 0n, minOut: 0n })).toMatchObject({ ok: false });
  });
  it("never lets a quote outlive its order", () => {
    expect(quoteDeadline({ orderExpiry: BigInt(NOW + 100), nowSec: NOW, ttlSec: 300 })).toBe(BigInt(NOW + 100));
    expect(quoteDeadline({ orderExpiry: BigInt(NOW + 1000), nowSec: NOW, ttlSec: 300 })).toBe(BigInt(NOW + 300));
  });
});

describe("tool parameter schemas", () => {
  it("post_order defaults to a WHBAR to USDC order and accepts numbers or strings", () => {
    expect(postOrderSchema.parse({ amount: 2 })).toMatchObject({ tokenIn: "WHBAR", tokenOut: "USDC", amount: "2", slippageBps: 1000, ttlSeconds: 600, fee: 3000 });
    expect(postOrderSchema.parse({ amount: "0.5" }).amount).toBe("0.5");
  });
  it("rejects zero, negative, scientific and absurd slippage", () => {
    for (const amount of ["0", "-1", "1e5", "two", ""]) expect(postOrderSchema.safeParse({ amount }).success).toBe(false);
    expect(postOrderSchema.safeParse({ amount: "1", slippageBps: 9000 }).success).toBe(false);
    expect(postOrderSchema.safeParse({ amount: "1", ttlSeconds: 0 }).success).toBe(false);
  });
  it("order ids are whole numbers; makers are 0x addresses; nonce lists are bounded", () => {
    expect(acceptQuoteSchema.safeParse({ orderId: "5" }).success).toBe(true);
    expect(acceptQuoteSchema.safeParse({ orderId: "-5" }).success).toBe(false);
    expect(acceptQuoteSchema.safeParse({ orderId: "5", maker: "bob" }).success).toBe(false);
    expect(quoteOrderSchema.safeParse({ orderId: 5, spreadBps: 5000 }).success).toBe(false);
    expect(cancelQuotesSchema.safeParse({ nonces: [] }).success).toBe(false);
    expect(cancelQuotesSchema.safeParse({ nonces: Array.from({ length: 257 }, (_, i) => i) }).success).toBe(false);
    expect(cancelQuotesSchema.parse({ nonces: [1, "2"] }).nonces).toEqual(["1", "2"]);
  });
});
