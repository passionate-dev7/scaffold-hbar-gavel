import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ContractResult, DeskReader, Order, Token } from "../src/chain";
import { type DeskConfig, configFromEnv } from "../src/config";
import { type Quote, type QuoteDomain, quoteHash, quoteJson, signQuote } from "../src/quote";

/** Public Hardhat test keys. They hold nothing on any network. */
export const MAKER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const OTHER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const MAKER = privateKeyToAccount(MAKER_KEY).address;
export const OTHER = privateKeyToAccount(OTHER_KEY).address;
export const TAKER: Address = "0x11Cf661848D52aEdF638658E6b68762549f74a0C";
export const STRANGER: Address = "0x00000000000000000000000000000000000000dE";
export const WHBAR: Address = "0x0000000000000000000000000000000000003aD2";
export const USDC: Address = "0x0000000000000000000000000000000000001549";
export const POOL: Address = "0x914B98992d7eD602D1f5d9084ECe8160Fc0e741a";
export const NOW = 1_791_141_000;

export const cfg: DeskConfig = {
  ...configFromEnv({ QUOTE_TOPIC_ID: "0.0.10860170" }),
};
export const DOMAIN: QuoteDomain = { name: "Gavel", version: "1", chainId: 296, verifyingContract: cfg.desk };

export const TOKENS: Record<string, Token> = {
  whbar: { address: WHBAR, symbol: "WHBAR", decimals: 8 },
  usdc: { address: USDC, symbol: "USDC", decimals: 6 },
};

export function order(over: Partial<Order> = {}): Order {
  return {
    taker: TAKER,
    tokenIn: WHBAR,
    tokenOut: USDC,
    fee: 3000,
    amountIn: 300_000_000n,
    minOut: 4_800_000n,
    expiry: BigInt(NOW + 600),
    schedule: "0x0000000000000000000000000000000000A5B211",
    status: 0,
    rearms: 0,
    fuel: 400_000_000n,
    claimable: 0n,
    ...over,
  };
}

export const ID = 5n;
/** A pool price that values the 3 WHBAR order at about 5.3 USDC (raw 5,300,000). */
export const SQRT = BigInt(Math.round(0.132916 * 2 ** 53)) * 2n ** 43n;

export async function signed(over: Partial<Quote> = {}, key: Hex = MAKER_KEY, domain: QuoteDomain = DOMAIN) {
  const q: Quote = { orderId: ID, maker: privateKeyToAccount(key).address, amountOut: 5_300_000n, deadline: BigInt(NOW + 300), nonce: ID, ...over };
  return signQuote(key, domain, q);
}

/** One HCS message as the mirror node returns it. */
export const topicMessage = (text: string, sequence: number, ts = `${NOW - 100 + sequence}.000000000`) => ({ sequence, consensusTimestamp: ts, payer: "0.0.10859933", text });

type Stub = {
  order: Order | null;
  messages: ReturnType<typeof topicMessage>[];
  spent: Set<string>;
  floor: bigint | null;
  sqrtPriceX96: bigint;
  evm: Address;
  hbar: bigint;
  tokenBalance: bigint;
  tokenAllowance: bigint;
  makerCover: boolean;
  associated: boolean;
  fresh: boolean;
  domain: QuoteDomain;
};
export type StubChain = DeskReader & { calls: string[] };

export function stubChain(over: Partial<Stub> = {}): StubChain {
  const s: Stub = {
    order: order(),
    messages: [],
    spent: new Set(),
    floor: 4_500_000n,
    sqrtPriceX96: SQRT,
    evm: TAKER,
    hbar: 100n * 10n ** 18n,
    tokenBalance: 0n,
    tokenAllowance: 0n,
    makerCover: true,
    associated: true,
    fresh: true,
    domain: DOMAIN,
    ...over,
  };
  const calls: string[] = [];
  const result = (): ContractResult => ({ result: "SUCCESS", hash: "0x", gas_used: 1, error_message: null, logs: [] });
  return {
    cfg,
    calls,
    domain: async () => s.domain,
    limits: async () => ({ minTtl: 60n, maxTtl: 5_184_000n, fuelPerOrder: 400_000_000n, whbar: WHBAR, usdToken: USDC, factory: "0x00000000000000000000000000000000001243eE" }),
    token: async (ref) => {
      const t = TOKENS[ref.toLowerCase()] ?? Object.values(TOKENS).find((x) => x.address.toLowerCase() === ref.toLowerCase());
      if (!t) throw new Error(`unknown token "${ref}": use WHBAR, USDC, SAUCE or a 0x token address`);
      return t;
    },
    pool: async (a, b) => (a === b ? null : { pool: POOL, tokenInIsToken0: true, sqrtPriceX96: s.sqrtPriceX96 }),
    orderCount: async () => 5n,
    order: async () => s.order,
    oracleFloor: async () => s.floor,
    hbarUsdFresh: async () => s.fresh,
    quoteDigest: async (id, q) => quoteHash(s.domain, { orderId: id, ...q }),
    nonceUsed: async (maker, nonce) => s.spent.has(`${maker.toLowerCase()}:${nonce}`),
    balanceOf: async (_t, account) => (account.toLowerCase() === MAKER.toLowerCase() || account.toLowerCase() === OTHER.toLowerCase() ? (s.makerCover ? 10n ** 12n : 0n) : s.tokenBalance),
    allowance: async (_t, owner) => (owner.toLowerCase() === MAKER.toLowerCase() || owner.toLowerCase() === OTHER.toLowerCase() ? (s.makerCover ? 10n ** 12n : 0n) : s.tokenAllowance),
    hbarBalance: async () => s.hbar,
    gasPrice: async () => 870_000_000_000n,
    account: async (id) => ({ accountId: id.startsWith("0.0.") ? id : "0.0.10855086", evmAddress: id.startsWith("0x") ? (id as Address) : s.evm }),
    associations: async (_id, tokens) => Object.fromEntries(tokens.map((t) => [t.toLowerCase(), s.associated ? "associated" : "needs"] as const)),
    waitForResult: async (id) => (calls.push(`waitForResult ${id}`), result()),
    topicMessages: async () => s.messages,
    waitForTopicMessage: async (_t, text) => s.messages.find((m) => m.text === text) ?? Promise.reject(new Error("not on topic")),
    deskEvents: () => [],
    decodeRevert: () => null,
  };
}

export { quoteJson };
