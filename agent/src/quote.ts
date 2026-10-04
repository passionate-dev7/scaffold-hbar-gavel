import { type Address, type Hex, hashTypedData, isAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { BPS } from "./units";

/**
 * The EIP-712 Quote type. Copied from scripts/maker/lib.mjs (QUOTE_TYPES), which must equal QUOTE_TYPEHASH in
 * the desk contract: Quote(uint256 orderId,address maker,uint256 amountOut,uint64 deadline,uint256 nonce).
 */
export const QUOTE_TYPES = {
  Quote: [
    { name: "orderId", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "amountOut", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The domain the desk reports through eip712Domain(): name, version, chain and the desk itself. */
export type QuoteDomain = { name: string; version: string; chainId: number; verifyingContract: Address };

export type Quote = { orderId: bigint; maker: Address; amountOut: bigint; deadline: bigint; nonce: bigint };
export type SignedQuote = Quote & { signature: Hex };

const U256 = (1n << 256n) - 1n;
const U64 = (1n << 64n) - 1n;

const uint = (max: bigint) =>
  z
    .string()
    .regex(/^\d{1,78}$/)
    .transform((s) => BigInt(s))
    .refine((v) => v <= max);

/** One HCS message as the maker bot posts it: every integer a decimal string. */
const wireSchema = z.object({
  orderId: uint(U256),
  maker: z.string().refine((a) => isAddress(a, { strict: false })),
  amountOut: uint(U256),
  deadline: uint(U64),
  nonce: uint(U256),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

/** Parses the text of one topic message. Anyone can post anything to the topic, so every failure is a reason, never a throw. */
export function parseWireQuote(text: string): { ok: true; quote: SignedQuote } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const parsed = wireSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "not a quote" };
  const v = parsed.data;
  return { ok: true, quote: { orderId: v.orderId, maker: v.maker as Address, amountOut: v.amountOut, deadline: v.deadline, nonce: v.nonce, signature: v.signature as Hex } };
}

/** The HCS wire format of a signed quote: integers as decimal strings so no consumer loses precision. */
export const quoteJson = (q: SignedQuote) =>
  JSON.stringify({ orderId: q.orderId.toString(), maker: q.maker, amountOut: q.amountOut.toString(), deadline: q.deadline.toString(), nonce: q.nonce.toString(), signature: q.signature });

const message = (q: Quote) => ({ orderId: q.orderId, maker: q.maker, amountOut: q.amountOut, deadline: q.deadline, nonce: q.nonce });

/** The digest the desk's quoteDigest(id, quote) must return for this quote. */
export const quoteHash = (domain: QuoteDomain, q: Quote) => hashTypedData({ domain, types: QUOTE_TYPES, primaryType: "Quote", message: message(q) });

export async function signQuote(privateKey: Hex, domain: QuoteDomain, q: Quote): Promise<SignedQuote> {
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== q.maker.toLowerCase()) throw new Error("the signing key is not the quote's maker");
  const signature = await account.signTypedData({ domain, types: QUOTE_TYPES, primaryType: "Quote", message: message(q) });
  return { ...q, signature };
}

/** True when `signature` recovers to `q.maker` under `domain`. Malformed signatures are false, not exceptions. */
export async function verifyQuote(domain: QuoteDomain, q: SignedQuote): Promise<boolean> {
  try {
    return await verifyTypedData({ address: q.maker, domain, types: QUOTE_TYPES, primaryType: "Quote", message: message(q), signature: q.signature });
  } catch {
    return false;
  }
}

/** Why a quote cannot settle this order right now, or null when it can. Chain facts the desk enforces on fillWithQuote. */
export function screenQuote(
  q: Quote,
  ctx: { orderId: bigint; minOut: bigint; oracleFloor: bigint | null; nowSec: number; orderExpiry: bigint; minRemainingSec?: number },
): string | null {
  if (q.orderId !== ctx.orderId) return "other order";
  const now = BigInt(ctx.nowSec);
  if (q.deadline <= now + BigInt(ctx.minRemainingSec ?? 0)) return "deadline passed";
  if (ctx.orderExpiry <= now) return "order expired";
  if (q.amountOut < ctx.minOut) return "below the order's minOut";
  if (ctx.oracleFloor !== null && q.amountOut < ctx.oracleFloor) return "below the Chainlink band";
  return null;
}

export type RankedQuote = SignedQuote & { consensusTimestamp: string; sequence: number };

/** Best first: highest amountOut, then earliest consensus time, then maker address so the order is total. */
export function sortQuotes<T extends RankedQuote>(quotes: readonly T[]): T[] {
  return [...quotes].sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    if (a.consensusTimestamp !== b.consensusTimestamp) return a.consensusTimestamp < b.consensusTimestamp ? -1 : 1;
    return a.maker.toLowerCase() < b.maker.toLowerCase() ? -1 : 1;
  });
}

/** A maker's price for an order: the pool spot less the spread, or the reason to decline. */
export function priceQuote(args: {
  status: number;
  expiry: bigint;
  minOut: bigint;
  nowSec: number;
  spotOut: bigint;
  spreadBps: number;
  oracleFloor: bigint | null;
}): { ok: true; amountOut: bigint } | { ok: false; reason: string } {
  if (args.status !== 0) return { ok: false, reason: "order is not open" };
  if (args.expiry <= BigInt(args.nowSec)) return { ok: false, reason: "order expired" };
  if (!Number.isInteger(args.spreadBps) || args.spreadBps < 0 || args.spreadBps >= 10_000) return { ok: false, reason: `spread out of range: ${args.spreadBps}` };
  const amountOut = (args.spotOut * (BPS - BigInt(args.spreadBps))) / BPS;
  if (amountOut === 0n) return { ok: false, reason: "price rounds to zero" };
  if (amountOut < args.minOut) return { ok: false, reason: `price ${amountOut} is below the order's minOut ${args.minOut}` };
  if (args.oracleFloor !== null && amountOut < args.oracleFloor) return { ok: false, reason: `price ${amountOut} is below the Chainlink band floor ${args.oracleFloor}` };
  return { ok: true, amountOut };
}

/** A quote deadline: `ttlSec` from now, never past the order's own expiry (quotes close at expiry). */
export function quoteDeadline(args: { orderExpiry: bigint; nowSec: number; ttlSec: number }): bigint {
  const d = BigInt(args.nowSec) + BigInt(args.ttlSec);
  return d < args.orderExpiry ? d : args.orderExpiry;
}
