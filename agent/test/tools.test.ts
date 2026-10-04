import { AgentMode, type Context } from "@hashgraph/hedera-agent-kit";
import { HederaAIToolkit } from "@hashgraph/hedera-agent-kit-ai-sdk";
import { ContractExecuteTransaction, Client, Transaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { decodeFunctionData } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadBoard } from "../src/board";
import { createGavelPlugin, gavelToolNames as T } from "../src/plugin";
import { quoteJson } from "../src/quote";
import { spotOut } from "../src/units";
import { DOMAIN, ID, MAKER, MAKER_KEY, NOW, OTHER, OTHER_KEY, SQRT, STRANGER, TAKER, cfg, order, signed, stubChain, topicMessage } from "./fixture";

const ctx: Context = { mode: AgentMode.RETURN_BYTES, accountId: "0.0.10855086" };
let client: Client;
beforeAll(() => {
  client = Client.forTestnet();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
});

const tool = (chain: ReturnType<typeof stubChain>, method: string, opts: { makerKey?: `0x${string}`; context?: Context } = {}) => {
  const context = opts.context ?? ctx;
  const t = createGavelPlugin({ chain, makerKey: opts.makerKey }).tools(context).find((x) => x.method === method);
  if (!t) throw new Error(`no tool ${method}`);
  return (params: unknown) => t.execute(client, context, params);
};
const decodeTx = (out: { bytes: Uint8Array }) => {
  const tx = Transaction.fromBytes(out.bytes);
  return tx as ContractExecuteTransaction & TopicMessageSubmitTransaction;
};
const calldata = (out: { bytes: Uint8Array }) => decodeFunctionData({ abi: cfg.abi, data: `0x${Buffer.from(decodeTx(out).functionParameters!).toString("hex")}` });
const msg = async (over = {}, key = MAKER_KEY, seq = 1) => topicMessage(quoteJson(await signed(over, key)), seq);

describe("plugin", () => {
  it("exposes the five taker tools and the two maker tools, typed, each with a described schema", () => {
    const tools = createGavelPlugin({ chain: stubChain() }).tools(ctx);
    expect(tools.map((t) => t.method)).toEqual(["get_order_status", "list_quotes", "post_order", "accept_quote", "cancel_order", "quote_order", "cancel_quotes"]);
    expect(tools.map((t) => t.toolType)).toEqual(["query", "query", "transaction", "transaction", "transaction", "transaction", "transaction"]);
    expect(new Set(Object.values(T)).size).toBe(7);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(80);
  });

  it("loads into the Agent Kit AI SDK toolkit and runs a query tool through the adapter", async () => {
    const toolkit = new HederaAIToolkit({ client, configuration: { plugins: [createGavelPlugin({ chain: stubChain() })], context: ctx } });
    expect(Object.keys(toolkit.getTools())).toEqual(expect.arrayContaining(["post_order", "list_quotes", "accept_quote", "quote_order"]));
    const out = (await toolkit.getTools().get_order_status!.execute!({ orderId: "5" }, { toolCallId: "1", messages: [] } as never)) as { raw: { orderStatus: string }; humanMessage: string };
    expect(out.raw.orderStatus).toBe("Open");
    expect(out.humanMessage).toContain("Order 5 is Open");
  });
});

describe("the board verifies before it ranks", () => {
  const args = { orderId: ID, order: order(), topicId: "0.0.10860170", maxMessages: 100, nowSec: NOW };

  it("keeps only valid quotes, best first, and counts every rejection by reason", async () => {
    const good = await msg({ amountOut: 5_300_000n }, MAKER_KEY, 1);
    const better = await msg({ amountOut: 5_350_000n, nonce: 9n }, OTHER_KEY, 2);
    const forged = topicMessage(quoteJson({ ...(await signed({ amountOut: 5_000_000n })), amountOut: 9_000_000n }), 3);
    const wrongDomain = topicMessage(quoteJson(await signed({}, MAKER_KEY, { ...DOMAIN, chainId: 295 })), 4);
    const expired = await msg({ deadline: BigInt(NOW - 1) }, MAKER_KEY, 5);
    const lowball = await msg({ amountOut: 1_000_000n }, MAKER_KEY, 6);
    const otherOrder = await msg({ orderId: 99n }, MAKER_KEY, 7);
    const junk = topicMessage("hello topic", 8);
    const chain = stubChain({ messages: [junk, otherOrder, lowball, expired, wrongDomain, forged, better, good] });
    const board = await loadBoard(chain, args);
    expect(board.read).toBe(8);
    expect(board.quotes.map((q) => [q.maker, q.amountOut])).toEqual([[OTHER, 5_350_000n], [MAKER, 5_300_000n]]);
    expect(board.rejected.byReason).toEqual({
      "not JSON": 1,
      "below the order's minOut": 1,
      "deadline passed": 1,
      "signature does not recover to the maker": 2,
    });
    expect(board.quotes[0]!.vsMinOutBps).toBeCloseTo(((5_350_000 - 4_800_000) / 4_800_000) * 10_000, 0);
  });

  it("drops a quote whose nonce is spent or cancelled", async () => {
    const chain = stubChain({ messages: [await msg()], spent: new Set([`${MAKER.toLowerCase()}:${ID}`]) });
    const board = await loadBoard(chain, args);
    expect(board.quotes).toEqual([]);
    expect(board.rejected.byReason["nonce already used or cancelled"]).toBe(1);
  });

  it("drops a replayed copy of the same signed quote", async () => {
    const m = await msg();
    const board = await loadBoard(stubChain({ messages: [{ ...m, sequence: 2 }, m] }), args);
    expect(board.quotes).toHaveLength(1);
    expect(board.rejected.byReason.duplicate).toBe(1);
  });

  it("shows nothing when the Chainlink feed is stale, because the desk would reject every fill", async () => {
    const board = await loadBoard(stubChain({ messages: [await msg()], floor: null }), args);
    expect(board.quotes).toEqual([]);
    expect(Object.keys(board.rejected.byReason)[0]).toContain("Chainlink feed stale");
  });

  it("flags a quote whose maker cannot pay", async () => {
    const board = await loadBoard(stubChain({ messages: [await msg()], makerCover: false }), args);
    expect(board.quotes[0]!.makerCovered).toBe(false);
  });

  it("an empty topic is an empty board, not an error", async () => {
    const board = await loadBoard(stubChain({ messages: [] }), args);
    expect(board).toMatchObject({ read: 0, quotes: [], rejected: { total: 0 } });
  });
});

describe("list_quotes", () => {
  it("returns the ranked verified board with bps over the fallback and HashScan links", async () => {
    const chain = stubChain({ messages: [await msg({ amountOut: 5_300_000n }, MAKER_KEY, 1), await msg({ amountOut: 5_350_000n, nonce: 9n }, OTHER_KEY, 2), topicMessage("junk", 3)] });
    const out = await tool(chain, T.list)({ orderId: "5" });
    expect(out.raw).toMatchObject({ status: "SUCCESS", verifiedQuotes: 2, messagesRead: 3, rejected: { total: 1 } });
    expect(out.raw.quotes[0]).toMatchObject({ rank: 1, maker: OTHER, amountOut: "5.35", topicSequence: 2 });
    expect(out.raw.quotes[1]).toMatchObject({ rank: 2, maker: MAKER });
    expect(typeof out.raw.quotes[0].vsFallbackBps).toBe("number");
    expect(out.raw.topic.link).toBe("https://hashscan.io/testnet/topic/0.0.10860170");
    expect(out.humanMessage).toContain("Best 5.35 USDC");
  });

  it("says so when there is no quote, and states the guaranteed floor", async () => {
    const out = await tool(stubChain(), T.list)({ orderId: "5" });
    expect(out.raw.verifiedQuotes).toBe(0);
    expect(out.humanMessage).toContain("no verified quote yet");
    expect(out.humanMessage).toContain("4.8 USDC");
  });

  it("refuses an unknown order and a closed one", async () => {
    expect((await tool(stubChain({ order: null }), T.list)({ orderId: "5" })).raw).toMatchObject({ status: "ERROR", blocked: true });
    const closed = (await tool(stubChain({ order: order({ status: 1 }) }), T.list)({ orderId: "5" })).raw;
    expect(closed.reasons[0]).toContain("Filled");
    expect(closed).toMatchObject({ status: "ERROR", orderStatus: "Filled" });
  });

  it("rejects a malformed order id before touching the chain", async () => {
    expect((await tool(stubChain(), T.list)({ orderId: "five" })).raw.status).toBe("ERROR");
  });
});

describe("post_order", () => {
  it("builds postOrder from the pool spot: minOut = spot less slippage, HBAR value = amount + fuel", async () => {
    const out = await tool(stubChain(), T.post)({ amount: "3", slippageBps: 1000, ttlSeconds: 600 });
    const spot = spotOut({ amountIn: 300_000_000n, sqrtPriceX96: SQRT, tokenInIsToken0: true });
    const call = calldata(out);
    expect(call.functionName).toBe("postOrder");
    const [tokenIn, tokenOut, fee, amountIn, minOut, ttl] = call.args as bigint[];
    expect([tokenIn, tokenOut, fee, amountIn, ttl]).toEqual([expect.stringMatching(/3ad2$/i), expect.stringMatching(/1549$/), 3000, 300_000_000n, 600n]);
    expect(minOut).toBe((spot * 9000n) / 10000n);
    expect(decodeTx(out).payableAmount!.toTinybars().toString()).toBe((300_000_000n + 400_000_000n).toString());
    expect(out.plan.sells).toBe("3 WHBAR");
  });

  it("blocks a TTL outside the desk's window, instead of paying for a revert", async () => {
    for (const ttlSeconds of [30, 6_000_000]) {
      const out = await tool(stubChain(), T.post)({ amount: "3", ttlSeconds });
      expect(out.raw.status).toBe("ERROR");
      expect(out.raw.reasons[0]).toContain("outside the desk's window");
    }
  });

  it("blocks an amount the token cannot represent, the same token on both sides, and an unknown token", async () => {
    expect((await tool(stubChain(), T.post)({ amount: "1.123456789" })).raw.reasons[0]).toContain("at most 8");
    expect((await tool(stubChain(), T.post)({ amount: "1", tokenOut: "WHBAR" })).raw.reasons.join()).toContain("same token");
    expect((await tool(stubChain(), T.post)({ amount: "1", tokenOut: "DOGE" })).raw.status).toBe("ERROR");
  });

  it("blocks when the account cannot cover amount, fuel and gas", async () => {
    const out = await tool(stubChain({ hbar: 3n * 10n ** 18n }), T.post)({ amount: "3" });
    expect(out.raw.reasons[0]).toContain("holds 3 HBAR");
  });

  it("blocks when the account is not associated with the token it will receive", async () => {
    const out = await tool(stubChain({ associated: false }), T.post)({ amount: "3" });
    expect(out.raw.reasons[0]).toContain("not associated with USDC");
  });

  it("blocks when no pool exists for the pair and fee tier", async () => {
    const chain = stubChain();
    chain.pool = async () => null;
    expect((await tool(chain, T.post)({ amount: "3" })).raw.reasons[0]).toContain("no WHBAR/USDC pool");
  });

  it("a non-HBAR order plans an approval first when the allowance is short", async () => {
    const chain = stubChain({ tokenBalance: 10_000_000n, tokenAllowance: 0n });
    const out = await tool(chain, T.post)({ tokenIn: "USDC", tokenOut: "WHBAR", amount: "5" });
    expect(out.nextStep).toContain("Approve 5 USDC to the desk");
    expect(out.plan.sells).toBe("5 USDC");
  });
});

describe("accept_quote", () => {
  const withQuotes = async () => stubChain({ messages: [await msg({ amountOut: 5_300_000n }, MAKER_KEY, 1), await msg({ amountOut: 5_350_000n, nonce: 9n }, OTHER_KEY, 2)] });

  it("fills with the best verified quote: fillWithQuote(id, quote, signature) for the top maker", async () => {
    const out = await tool(await withQuotes(), T.accept)({ orderId: "5" });
    const call = calldata(out);
    expect(call.functionName).toBe("fillWithQuote");
    const [id, quote, signature] = call.args as [bigint, { maker: string; amountOut: bigint; nonce: bigint }, string];
    expect(id).toBe(5n);
    expect(quote).toMatchObject({ maker: OTHER, amountOut: 5_350_000n, nonce: 9n });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(out.plan.maker).toBe(OTHER);
  });

  it("can pin one maker, and says so when that maker has no quote", async () => {
    const chain = await withQuotes();
    const out = await tool(chain, T.accept)({ orderId: "5", maker: MAKER });
    expect(calldata(out).args![1]).toMatchObject({ maker: MAKER, amountOut: 5_300_000n });
    const none = await tool(chain, T.accept)({ orderId: "5", maker: STRANGER });
    expect(none.raw.reasons[0]).toContain(`No verified quote from ${STRANGER}`);
  });

  it("is taker-only: any other account is refused before a transaction is built", async () => {
    const chain = await withQuotes();
    const out = await tool(chain, T.accept)({ orderId: "5" });
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    const strangerChain = stubChain({ evm: STRANGER, messages: [await msg()] });
    const refused = await tool(strangerChain, T.accept)({ orderId: "5" });
    expect(refused.bytes).toBeUndefined();
    expect(refused.raw).toMatchObject({ status: "ERROR", blocked: true });
    expect(refused.raw.reasons[0]).toContain("Only the order's taker");
  });

  it("skips a quote whose maker cannot pay and refuses to send a fill that would revert", async () => {
    const out = await tool(stubChain({ messages: [await msg()], makerCover: false }), T.accept)({ orderId: "5" });
    expect(out.raw.status).toBe("ERROR");
    expect(out.raw.reasons[0]).toContain("lacks the USDC balance or allowance");
    expect(out.raw.reasons[1]).toContain("fallback still guarantees at least 4.8 USDC");
  });

  it("refuses a quote that is about to lapse (20 s margin) and an empty board", async () => {
    const chain = stubChain({ messages: [await msg({ deadline: BigInt(NOW + 10) })] });
    expect((await tool(chain, T.accept)({ orderId: "5" })).raw.reasons[0]).toContain("No verified, unexpired quote");
    expect((await tool(stubChain(), T.accept)({ orderId: "5" })).raw.status).toBe("ERROR");
  });

  it("refuses a closed, expired or unknown order, and an account not associated with tokenOut", async () => {
    expect((await tool(stubChain({ order: order({ status: 3 }) }), T.accept)({ orderId: "5" })).raw.reasons[0]).toContain("Cancelled");
    expect((await tool(stubChain({ order: order({ expiry: BigInt(NOW - 1) }) }), T.accept)({ orderId: "5" })).raw.reasons[0]).toContain("expired");
    expect((await tool(stubChain({ order: null }), T.accept)({ orderId: "5" })).raw.reasons[0]).toContain("does not exist");
    expect((await tool(stubChain({ associated: false, messages: [await msg()] }), T.accept)({ orderId: "5" })).raw.reasons[0]).toContain("not associated");
  });
});

describe("cancel_order and get_order_status", () => {
  it("cancel builds cancel(id) for the taker", async () => {
    const out = await tool(stubChain(), T.cancel)({ orderId: "5" });
    expect(calldata(out)).toMatchObject({ functionName: "cancel", args: [5n] });
  });

  it("cancel refuses a stranger, a settled order and an expired order", async () => {
    expect((await tool(stubChain({ evm: STRANGER }), T.cancel)({ orderId: "5" })).raw.reasons[0]).toContain("Only the order's taker");
    expect((await tool(stubChain({ order: order({ status: 2 }) }), T.cancel)({ orderId: "5" })).raw.reasons[0]).toContain("FellBack");
    expect((await tool(stubChain({ order: order({ expiry: BigInt(NOW) }) }), T.cancel)({ orderId: "5" })).raw.reasons[0]).toContain("expired");
  });

  it("status reports whether the agent is the taker and what happens next", async () => {
    const mine = await tool(stubChain(), T.status)({ orderId: "5" });
    expect(mine.raw).toMatchObject({ status: "SUCCESS", orderStatus: "Open", agentIsTaker: true, sells: "3 WHBAR", minBuys: "4.8 USDC", secondsLeft: 600 });
    expect(mine.humanMessage).toContain("fallback swaps the escrow");
    const theirs = await tool(stubChain({ evm: STRANGER }), T.status)({ orderId: "5" });
    expect(theirs.raw.agentIsTaker).toBe(false);
    expect((await tool(stubChain({ order: null }), T.status)({ orderId: "9" })).raw.status).toBe("ERROR");
  });
});

describe("maker tools", () => {
  const makerCtx: Context = { mode: AgentMode.RETURN_BYTES, accountId: "0.0.10859933" };
  const asMaker = (over = {}) => stubChain({ evm: MAKER, ...over });

  it("quote_order signs a quote that recovers to the maker and submits it to the topic", async () => {
    const out = await tool(asMaker(), T.quote, { makerKey: MAKER_KEY, context: makerCtx })({ orderId: "5", spreadBps: 30, ttlSeconds: 300 });
    const tx = decodeTx(out);
    expect(tx).toBeInstanceOf(TopicMessageSubmitTransaction);
    const wire = JSON.parse(Buffer.from(tx.message!).toString("utf8"));
    const spot = spotOut({ amountIn: 300_000_000n, sqrtPriceX96: SQRT, tokenInIsToken0: true });
    expect(wire).toMatchObject({ orderId: "5", maker: MAKER, nonce: "5", amountOut: ((spot * 9970n) / 10000n).toString() });
    expect(Number(wire.deadline)).toBe(NOW + 300);
    const { verifyQuote } = await import("../src/quote");
    expect(await verifyQuote(DOMAIN, { orderId: 5n, maker: MAKER, amountOut: BigInt(wire.amountOut), deadline: BigInt(wire.deadline), nonce: 5n, signature: wire.signature })).toBe(true);
    expect(out.plan.maker).toBe(MAKER);
  });

  it("quote_order caps the deadline at the order's expiry", async () => {
    const out = await tool(asMaker({ order: order({ expiry: BigInt(NOW + 100) }) }), T.quote, { makerKey: MAKER_KEY, context: makerCtx })({ orderId: "5", ttlSeconds: 3000 });
    expect(Number(JSON.parse(Buffer.from(decodeTx(out).message!).toString()).deadline)).toBe(NOW + 100);
  });

  it("quote_order declines what the desk would reject or the maker cannot pay", async () => {
    const q = (chain: ReturnType<typeof stubChain>, key: `0x${string}` | null = MAKER_KEY) => tool(chain, T.quote, { makerKey: key ?? undefined, context: makerCtx })({ orderId: "5" });
    expect((await q(asMaker(), null)).raw.reasons[0]).toContain("No maker key");
    expect((await q(stubChain({ evm: TAKER }))).raw.reasons[0]).toContain("is not the maker key's account");
    expect((await q(asMaker({ order: order({ minOut: 9_000_000n }) }))).raw.reasons[0]).toContain("below the order's minOut");
    expect((await q(asMaker({ floor: 9_000_000n, order: order({ minOut: 1n }) }))).raw.reasons[0]).toContain("Chainlink band");
    expect((await q(asMaker({ floor: null }))).raw.reasons[0]).toContain("stale");
    expect((await q(asMaker({ order: order({ status: 1 }) }))).raw.reasons[0]).toContain("Filled");
    expect((await q(asMaker({ spent: new Set([`${MAKER.toLowerCase()}:5`]) }))).raw.reasons[0]).toContain("already spent");
    expect((await q(asMaker({ makerCover: false }))).raw.reasons[0]).toContain("holds 0 USDC");
  });

  it("cancel_quotes builds one cancelNonces(word, mask) call for nonces in the same 256 block", async () => {
    const out = await tool(asMaker(), T.cancelQuotes, { makerKey: MAKER_KEY, context: makerCtx })({ nonces: [5, 7, "260"] });
    expect(out.raw?.status).toBe("ERROR");
    const ok = await tool(asMaker(), T.cancelQuotes, { makerKey: MAKER_KEY, context: makerCtx })({ nonces: [5, 7] });
    expect(calldata(ok)).toMatchObject({ functionName: "cancelNonces", args: [0n, (1n << 5n) | (1n << 7n)] });
    const hi = await tool(asMaker(), T.cancelQuotes, { context: makerCtx })({ nonces: [256, 258] });
    expect(calldata(hi).args).toEqual([1n, 0b101n]);
  });

  it("cancel_quotes sends nothing when every nonce is already spent", async () => {
    const out = await tool(asMaker({ spent: new Set([`${MAKER.toLowerCase()}:5`]) }), T.cancelQuotes, { context: makerCtx })({ nonces: [5] });
    expect(out.bytes).toBeUndefined();
    expect(out.raw).toMatchObject({ status: "SUCCESS", noop: true });
  });
});
