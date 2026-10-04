import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const HEDERA_TESTNET_CHAIN_ID = 296;
export const BPS = 10_000n;
export const Q192 = 1n << 192n;

export const DOMAIN_NAME = "Backstop";
export const DOMAIN_VERSION = "1";

// Must equal the QUOTE_TYPEHASH string in BackstopDesk.sol.
export const QUOTE_TYPES = {
  Quote: [
    { name: "orderId", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "amountOut", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

export function quoteDomain(desk, chainId = HEDERA_TESTNET_CHAIN_ID) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: desk };
}

function quoteMessage(q) {
  return {
    orderId: BigInt(q.orderId),
    maker: q.maker,
    amountOut: BigInt(q.amountOut),
    deadline: BigInt(q.deadline),
    nonce: BigInt(q.nonce),
  };
}

export function quoteDigest({ desk, chainId, quote }) {
  return hashTypedData({
    domain: quoteDomain(desk, chainId),
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: quoteMessage(quote),
  });
}

export async function signQuote({ privateKey, desk, chainId, quote }) {
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData({
    domain: quoteDomain(desk, chainId),
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: quoteMessage({ ...quote, maker: account.address }),
  });
}

export function recoverQuoteSigner({ desk, chainId, quote, signature }) {
  return recoverTypedDataAddress({
    domain: quoteDomain(desk, chainId),
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: quoteMessage(quote),
    signature,
  });
}

// The wire format of one HCS message. Integers are decimal strings so no consumer loses precision.
export function quoteJson({ orderId, maker, amountOut, deadline, nonce, signature }) {
  return JSON.stringify({
    orderId: BigInt(orderId).toString(),
    maker,
    amountOut: BigInt(amountOut).toString(),
    deadline: BigInt(deadline).toString(),
    nonce: BigInt(nonce).toString(),
    signature,
  });
}

// Raw-unit spot value of amountIn of tokenIn, from a V3-style sqrtPriceX96 (token1 per token0, raw units).
export function spotOut({ amountIn, sqrtPriceX96, tokenInIsToken0 }) {
  const p = BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96);
  return tokenInIsToken0 ? (BigInt(amountIn) * p) / Q192 : (BigInt(amountIn) * Q192) / p;
}

export function applySpread(amount, spreadBps) {
  const s = BigInt(spreadBps);
  if (s < 0n || s >= BPS) throw new Error(`SPREAD_BPS out of range: ${spreadBps}`);
  return (BigInt(amount) * (BPS - s)) / BPS;
}

export const STATUS = { Open: 0, Filled: 1, FellBack: 2, Cancelled: 3, Refunded: 4 };

// Returns { ok: true, amountOut } or { ok: false, reason }.
export function decideQuote({ order, sqrtPriceX96, tokenInIsToken0, spreadBps, nowSec, oracleFloor }) {
  if (Number(order.status) !== STATUS.Open) return { ok: false, reason: "not open" };
  if (BigInt(order.expiry) <= BigInt(nowSec)) return { ok: false, reason: "expired" };
  const spot = spotOut({ amountIn: order.amountIn, sqrtPriceX96, tokenInIsToken0 });
  const amountOut = applySpread(spot, spreadBps);
  if (amountOut < BigInt(order.minOut)) return { ok: false, reason: `below minOut (${amountOut} < ${order.minOut})` };
  if (oracleFloor !== undefined && amountOut < BigInt(oracleFloor))
    return { ok: false, reason: `below oracle floor (${amountOut} < ${oracleFloor})` };
  return { ok: true, amountOut };
}

export function quoteDeadline({ orderExpiry, nowSec, ttlSec }) {
  const d = BigInt(nowSec) + BigInt(ttlSec);
  const e = BigInt(orderExpiry);
  return d < e ? d : e;
}
