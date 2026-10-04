import { z } from "zod";

/** A positive decimal, given as a string or a number (models send either). Decimal places are checked against the token later. */
const decimal = (what: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" ? v.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 }) : v.trim()))
    .pipe(z.string().regex(/^\d+(\.\d+)?$/, `${what} must be a plain decimal such as "2" or "0.5"`).refine((v) => /[1-9]/.test(v), `${what} must be above zero`));

const orderId = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,30}$/, "orderId must be a whole number"))
  .describe("The desk's order id, as returned by post_order");

const tokenRef = (what: string) => z.string().min(1).describe(`${what}: WHBAR, USDC, SAUCE, or a 0x token address`);

const topicId = z
  .string()
  .regex(/^0\.0\.\d+$/, "topicId must look like 0.0.1234")
  .optional()
  .describe("HCS quote topic. Defaults to QUOTE_TOPIC_ID.");

export const postOrderSchema = z.object({
  tokenIn: tokenRef("Token to sell").default("WHBAR"),
  tokenOut: tokenRef("Token to buy").default("USDC"),
  amount: decimal("amount").describe('Amount of tokenIn to sell, in whole tokens, for example "2" for 2 HBAR'),
  slippageBps: z
    .number()
    .int()
    .min(10)
    .max(5000)
    .default(1000)
    .describe("Shortfall against the pool spot the order accepts, in basis points (1000 = 10%). It becomes minOut, the floor the network fallback swap must meet or the escrow is refunded."),
  ttlSeconds: z.number().int().min(1).default(600).describe("Seconds the order stays open for quotes before the network settles it itself. The desk allows MIN_TTL to MAX_TTL; the tool checks."),
  fee: z.number().int().default(3000).describe("SaucerSwap V2 pool fee tier of the pair, in hundredths of a basis point (3000 = 0.30%)."),
});

export const listQuotesSchema = z.object({
  orderId,
  topicId,
  maxMessages: z.number().int().min(1).max(1000).default(300).describe("How many of the newest topic messages to read."),
});

export const acceptQuoteSchema = z.object({
  orderId,
  maker: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "maker must be a 0x EVM address")
    .optional()
    .describe("Accept this maker's best quote instead of the best quote overall."),
  topicId,
  maxMessages: z.number().int().min(1).max(1000).default(300),
});

export const cancelOrderSchema = z.object({ orderId });
export const getOrderStatusSchema = z.object({ orderId });

export const quoteOrderSchema = z.object({
  orderId,
  spreadBps: z.number().int().min(0).max(2000).default(30).describe("Spread below the pool spot the maker quotes at, in basis points (30 = 0.30%)."),
  ttlSeconds: z.number().int().min(30).max(3600).default(300).describe("Seconds the quote stays fillable (never past the order's own expiry)."),
  topicId,
});

export const cancelQuotesSchema = z.object({
  nonces: z
    .array(z.union([z.string(), z.number().int().nonnegative()]).transform((v) => String(v).trim()).pipe(z.string().regex(/^\d{1,30}$/)))
    .min(1)
    .max(256)
    .describe("Quote nonces to retire. quote_order uses the order id as the nonce. All must sit in the same block of 256 (nonce / 256); one call retires the lot."),
});
