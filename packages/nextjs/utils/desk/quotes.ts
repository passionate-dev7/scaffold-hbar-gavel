import { type Address, type Hex, isAddress, verifyTypedData } from "viem";

/** Must match QUOTE_TYPEHASH in BackstopDesk.sol. */
export const QUOTE_TYPES = {
  Quote: [
    { name: "orderId", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "amountOut", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export type QuoteDomain = { name: string; version: string; chainId: number; verifyingContract: Address };

export type SignedQuote = {
  orderId: bigint;
  maker: Address;
  amountOut: bigint;
  deadline: bigint;
  nonce: bigint;
  signature: Hex;
  /** HCS sequence number. */
  sequence: number;
  /** Network-assigned consensus timestamp, "seconds.nanos". */
  consensusTimestamp: string;
};

const UINT = /^\d{1,78}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * One HCS message as a quote, or null when it is not one: not base64 JSON, a field missing, a number that is not a
 * decimal string, an address that is not an address, a signature that is not 65 bytes. Anyone can write to the topic,
 * so nothing here is trusted until `verifyQuote` recovers the maker.
 */
export function parseQuote(message: {
  sequence: number;
  consensusTimestamp: string;
  message: string;
}): SignedQuote | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(message.message), c => c.charCodeAt(0))));
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const q = body as Record<string, unknown>;
  const { orderId, maker, amountOut, deadline, nonce, signature } = q;
  if (![orderId, amountOut, deadline, nonce].every(v => typeof v === "string" && UINT.test(v))) return null;
  if (typeof maker !== "string" || !isAddress(maker, { strict: false })) return null;
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return null;
  return {
    orderId: BigInt(orderId as string),
    maker: maker as Address,
    amountOut: BigInt(amountOut as string),
    deadline: BigInt(deadline as string),
    nonce: BigInt(nonce as string),
    signature: signature as Hex,
    sequence: message.sequence,
    consensusTimestamp: message.consensusTimestamp,
  };
}

/** True only when `signature` is the quote's maker signing exactly these fields under the desk's EIP-712 domain. */
export async function verifyQuote(quote: SignedQuote, domain: QuoteDomain): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: quote.maker,
      domain,
      types: QUOTE_TYPES,
      primaryType: "Quote",
      message: {
        orderId: quote.orderId,
        maker: quote.maker,
        amountOut: quote.amountOut,
        deadline: quote.deadline,
        nonce: quote.nonce,
      },
      signature: quote.signature,
    });
  } catch {
    return false;
  }
}

export type Verdict = "live" | "bad-signature" | "nonce-spent" | "expired" | "below-min" | "outside-band" | "unfunded";

export type Checks = {
  signatureOk: boolean;
  nonceSpent: boolean;
  /** Maker holds the amount and has approved the desk for it. Null while unread. */
  funded: boolean | null;
};

/** The first reason `fillWithQuote` would refuse the quote, in the order the contract checks them. */
export function assessQuote(
  q: Pick<SignedQuote, "amountOut" | "deadline">,
  checks: Checks,
  ctx: { nowSec: number; minOut: bigint; oracleFloor: bigint },
): Verdict {
  if (!checks.signatureOk) return "bad-signature";
  if (checks.nonceSpent) return "nonce-spent";
  if (q.deadline < BigInt(ctx.nowSec)) return "expired";
  if (q.amountOut < ctx.minOut) return "below-min";
  if (q.amountOut < ctx.oracleFloor) return "outside-band";
  if (checks.funded === false) return "unfunded";
  return "live";
}

const nanos = (ts: string) => {
  const [s, n = "0"] = ts.split(".");
  return BigInt(s) * 1_000_000_000n + BigInt(n.padEnd(9, "0"));
};

/** Highest amountOut first. Equal amounts keep the quote the network saw first. */
export function sortQuotes<T extends Pick<SignedQuote, "amountOut" | "consensusTimestamp">>(quotes: T[]): T[] {
  return [...quotes].sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    const [ta, tb] = [nanos(a.consensusTimestamp), nanos(b.consensusTimestamp)];
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
}

/** Signed basis points of `amount` over `reference`, rounded toward zero. Null when the reference is zero. */
export function bpsOver(amount: bigint, reference: bigint): number | null {
  if (reference === 0n) return null;
  return Number(((amount - reference) * 10_000n) / reference);
}
