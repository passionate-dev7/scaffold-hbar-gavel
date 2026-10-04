import { formatUnits, parseUnits } from "viem";

export const BPS = 10_000n;
export const Q192 = 1n << 192n;
/** JSON-RPC counts HBAR in weibar (18 decimals); the EVM inside Hedera counts tinybar (8). */
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/** Parses a plain decimal with at most `decimals` places into raw token units. Throws on anything else, and on zero. */
export function parseAmount(text: string, decimals: number, label = "amount"): bigint {
  const t = text.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(t)) throw new Error(`${label} must be a plain decimal with at most ${decimals} decimals, got "${text}"`);
  const value = parseUnits(t, decimals);
  if (value === 0n) throw new Error(`${label} must be above zero`);
  return value;
}

export const fmt = (value: bigint, decimals: number) => formatUnits(value, decimals);

/** Raw-unit value of `amountIn` of tokenIn at a V3-style pool price (sqrtPriceX96 is token1 per token0 in raw units), before the pool fee. */
export function spotOut(args: { amountIn: bigint; sqrtPriceX96: bigint; tokenInIsToken0: boolean }): bigint {
  const p = args.sqrtPriceX96 * args.sqrtPriceX96;
  return args.tokenInIsToken0 ? (args.amountIn * p) / Q192 : (args.amountIn * Q192) / p;
}

/** `amount` less `bps` basis points, rounded down. Refuses a bps outside [0, 10000). */
export function lessBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error(`bps out of range: ${bps}`);
  return (amount * (BPS - BigInt(bps))) / BPS;
}

/** (a - b) / b in basis points with two decimals; null when b is zero. */
export function bpsOver(a: bigint, b: bigint): number | null {
  if (b === 0n) return null;
  return Number(((a - b) * 1_000_000n) / b) / 100;
}
