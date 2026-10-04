import { BPS } from "./constants";

const Q192 = 1n << 192n;

/**
 * Output of a zero-impact, zero-fee swap of `amountIn` at the pool's slot0 price, in raw token units.
 * `sqrtPriceX96` is sqrt(token1 / token0) in raw units, so token0 -> token1 multiplies by its square.
 */
export function spotOut(sqrtPriceX96: bigint, tokenInIsToken0: boolean, amountIn: bigint): bigint {
  const p = sqrtPriceX96 * sqrtPriceX96;
  return tokenInIsToken0 ? (amountIn * p) / Q192 : (amountIn * Q192) / p;
}

/** `amount` less `slippageBps`, rounded down so the floor never exceeds what the pool priced. */
export const applySlippage = (amount: bigint, slippageBps: number) => (amount * (BPS - BigInt(slippageBps))) / BPS;
