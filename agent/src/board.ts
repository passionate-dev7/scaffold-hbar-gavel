import type { Address } from "viem";
import type { DeskReader, Order } from "./chain";
import { type RankedQuote, type SignedQuote, parseWireQuote, screenQuote, sortQuotes, verifyQuote } from "./quote";
import { bpsOver, spotOut } from "./units";

export type BoardQuote = RankedQuote & {
  secondsLeft: number;
  /** Premium over the order's minOut, the floor the network fallback guarantees. */
  vsMinOutBps: number | null;
  /** Premium over what the fallback swap would pay at the current pool price, after the pool fee. */
  vsFallbackBps: number | null;
  /** The maker holds and has approved enough tokenOut for the desk to pull. A quote without cover reverts on fill. */
  makerCovered: boolean;
};

export type Board = {
  read: number;
  fallbackEstimate: bigint | null;
  oracleFloor: bigint | null;
  quotes: BoardQuote[];
  rejected: { total: number; byReason: Record<string, number> };
};

const MAX_COVER_CHECKS = 25;

/**
 * The verified quote board for one order: reads the newest topic messages, drops everything that is not a quote for
 * this order, fails a screen on chain facts, fails a signature check, or reuses a spent nonce, then sorts best first.
 * Anyone can post to the topic, so nothing is shown that did not pass every check.
 */
export async function loadBoard(
  chain: DeskReader,
  args: { orderId: bigint; order: Order; topicId: string; maxMessages: number; nowSec: number; minRemainingSec?: number },
): Promise<Board> {
  const { orderId, order, nowSec } = args;
  const [domain, floor, messages, pool] = await Promise.all([
    chain.domain(),
    chain.oracleFloor(orderId),
    chain.topicMessages(args.topicId, args.maxMessages),
    chain.pool(order.tokenIn, order.tokenOut, order.fee),
  ]);
  const fallbackEstimate = pool ? (spotOut({ amountIn: order.amountIn, sqrtPriceX96: pool.sqrtPriceX96, tokenInIsToken0: pool.tokenInIsToken0 }) * BigInt(1_000_000 - order.fee)) / 1_000_000n : null;

  const byReason: Record<string, number> = {};
  const reject = (reason: string) => (byReason[reason] = (byReason[reason] ?? 0) + 1);
  const seen = new Set<string>();
  const survivors: (SignedQuote & { consensusTimestamp: string; sequence: number })[] = [];

  for (const m of messages) {
    const parsed = parseWireQuote(m.text);
    if (!parsed.ok) {
      reject(parsed.reason);
      continue;
    }
    const q = parsed.quote;
    if (q.orderId !== orderId) continue;
    if (seen.has(q.signature)) {
      reject("duplicate");
      continue;
    }
    seen.add(q.signature);
    if (floor === null) {
      reject("Chainlink feed stale: the desk would reject any fill");
      continue;
    }
    const why = screenQuote(q, { orderId, minOut: order.minOut, oracleFloor: floor, nowSec, orderExpiry: order.expiry, minRemainingSec: args.minRemainingSec });
    if (why) {
      reject(why);
      continue;
    }
    survivors.push({ ...q, consensusTimestamp: m.consensusTimestamp, sequence: m.sequence });
  }

  const signed = await Promise.all(survivors.map(async (q) => ((await verifyQuote(domain, q)) ? q : null)));
  const verified = signed.filter((q): q is NonNullable<typeof q> => {
    if (!q) reject("signature does not recover to the maker");
    return q !== null;
  });
  const spent = await Promise.all(verified.map((q) => chain.nonceUsed(q.maker, q.nonce)));
  const live = verified.filter((_, i) => {
    if (spent[i]) reject("nonce already used or cancelled");
    return !spent[i];
  });

  const ranked = sortQuotes(live);
  const covered = new Map<string, boolean>();
  await Promise.all(
    ranked.slice(0, MAX_COVER_CHECKS).map(async (q) => {
      const [bal, allow] = await Promise.all([chain.balanceOf(order.tokenOut, q.maker as Address), chain.allowance(order.tokenOut, q.maker as Address, chain.cfg.desk)]);
      covered.set(`${q.maker}:${q.nonce}`, bal >= q.amountOut && allow >= q.amountOut);
    }),
  );
  const quotes: BoardQuote[] = ranked.map((q) => ({
    ...q,
    secondsLeft: Number(q.deadline) - nowSec,
    vsMinOutBps: bpsOver(q.amountOut, order.minOut),
    vsFallbackBps: fallbackEstimate === null ? null : bpsOver(q.amountOut, fallbackEstimate),
    makerCovered: covered.get(`${q.maker}:${q.nonce}`) ?? false,
  }));
  return { read: messages.length, fallbackEstimate, oracleFloor: floor, quotes, rejected: { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason } };
}
