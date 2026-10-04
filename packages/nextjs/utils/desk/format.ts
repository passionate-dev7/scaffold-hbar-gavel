import { WHBAR, tokenOf } from "./constants";

/**
 * Fixed-point display. Rounds half up on the bigint, never through a float, so a balance of
 * 123456789.12345678 prints the digits the chain holds.
 */
export function fmtUnits(value: bigint, decimals: number, digits = 4, pad = false): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const places = Math.min(digits, decimals);
  const unit = 10n ** BigInt(decimals - places);
  const rounded = (abs + unit / 2n) / unit;
  if (rounded === 0n && abs > 0n) return `<0.${"0".repeat(Math.max(places - 1, 0))}1`;
  const s = rounded.toString().padStart(places + 1, "0");
  const whole = s.slice(0, s.length - places).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = places ? s.slice(-places) : "";
  const shown = pad ? frac : frac.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${shown ? `.${shown}` : ""}`;
}

/** USD amounts from the contract carry 8 decimals. */
export const fmtUsd = (value8: bigint, digits = 2) => `$${fmtUnits(value8, 8, digits, true)}`;

/** Signed basis points as a percentage: +0.42%, -0.30%. */
export const fmtSignedBps = (bps: number) =>
  `${bps > 0 ? "+" : bps < 0 ? "-" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`;

export const fmtPercentFromBps = (bps: number | bigint) => `${(Number(bps) / 100).toFixed(2)}%`;

export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec && m < 10 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/** Unix seconds as "Oct 3, 2026, 5:45 PM" in the viewer's locale. A numeric date reads as day-first or month-first depending on who looks. */
export const fmtDateTime = (unixSeconds: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(unixSeconds * 1000));

export const fmtAgo = (seconds: number) => `${fmtDuration(seconds)} ago`;

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Parses a decimal string into base units. Null when empty, malformed, or finer than `decimals`. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const text = input.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return null;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** A raw token amount with its symbol. Tokens the desk does not list print raw so a wrong scale is never guessed. */
export function fmtToken(amount: bigint, address: string, digits = 4): string {
  const token = tokenOf(address);
  return token ? `${fmtUnits(amount, token.decimals, digits)} ${token.symbol}` : `${amount} (raw units)`;
}

/** HBAR in tinybar. */
export const fmtHbar = (tinybar: bigint, digits = 4) => `${fmtUnits(tinybar, 8, digits)} HBAR`;

/** What an order escrowed: WHBAR is HBAR the desk wrapped for the taker, so it reads as HBAR. */
export const fmtEscrow = (amount: bigint, tokenIn: string) =>
  tokenIn.toLowerCase() === WHBAR.address.toLowerCase() ? fmtHbar(amount) : fmtToken(amount, tokenIn);
