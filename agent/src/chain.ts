import {
  type Abi,
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  createPublicClient,
  decodeErrorResult,
  decodeEventLog,
  erc20Abi,
  http,
  parseAbi,
} from "viem";
import { hederaTestnet } from "viem/chains";
import type { DeskConfig } from "./config";
import { entityRef } from "./links";
import type { QuoteDomain } from "./quote";

export const ORDER_STATUS = ["Open", "Filled", "FellBack", "Cancelled", "Refunded"] as const;
export const STATUS_OPEN = 0;
export const STATUS_FILLED = 1;
export const STATUS_CANCELLED = 3;

export type Order = {
  taker: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  minOut: bigint;
  expiry: bigint;
  schedule: Address;
  status: number;
  rearms: number;
  fuel: bigint;
  claimable: bigint;
};

export type Token = { address: Address; symbol: string; decimals: number };
export type Association = "associated" | "auto" | "needs";
export type MirrorLog = { address: string; data: Hex; topics: Hex[]; index: number };
export type ContractResult = { result: string; hash: string; gas_used: number; error_message: string | null; logs: MirrorLog[] };
export type TopicMessage = { sequence: number; consensusTimestamp: string; payer: string; text: string };
export type DeskLimits = { minTtl: bigint; maxTtl: bigint; fuelPerOrder: bigint; whbar: Address; usdToken: Address; factory: Address };
export type QuoteStruct = { maker: Address; amountOut: bigint; deadline: bigint; nonce: bigint };

const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const factoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const ZERO = /^0x0{40}$/i;

/** What the tools need from the chain. `DeskChain` is the live implementation; tests pass a stub. */
export interface DeskReader {
  readonly cfg: DeskConfig;
  domain(): Promise<QuoteDomain>;
  limits(): Promise<DeskLimits>;
  token(ref: string): Promise<Token>;
  pool(tokenIn: Address, tokenOut: Address, fee: number): Promise<{ pool: Address; tokenInIsToken0: boolean; sqrtPriceX96: bigint } | null>;
  orderCount(): Promise<bigint>;
  order(id: bigint): Promise<Order | null>;
  oracleFloor(id: bigint): Promise<bigint | null>;
  hbarUsdFresh(): Promise<boolean>;
  quoteDigest(id: bigint, quote: QuoteStruct): Promise<Hex>;
  nonceUsed(maker: Address, nonce: bigint): Promise<boolean>;
  balanceOf(token: Address, account: Address): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  hbarBalance(account: Address): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  account(idOrAddress: string): Promise<{ accountId: string; evmAddress: Address }>;
  associations(accountId: string, tokens: readonly Address[]): Promise<Record<string, Association>>;
  waitForResult(txId: string): Promise<ContractResult>;
  topicMessages(topicId: string, maxMessages: number): Promise<TopicMessage[]>;
  waitForTopicMessage(topicId: string, text: string): Promise<TopicMessage>;
  deskEvents(result: ContractResult): { name: string; args: Record<string, unknown> }[];
  decodeRevert(data: string | null | undefined): { name: string; args: string[] } | null;
}

export class MirrorError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`Mirror node answered ${status} for ${path}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The desk's custom error behind a failed eth_call, or null when the error carries no revert data. */
export function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const hit = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return hit instanceof ContractFunctionRevertedError ? (hit.data?.errorName ?? hit.reason ?? null) : null;
}

export class DeskChain implements DeskReader {
  private readonly rpc;
  private tokens = new Map<string, Token>();

  constructor(readonly cfg: DeskConfig) {
    this.rpc = createPublicClient({ chain: hederaTestnet, transport: http(cfg.rpcUrl, { retryCount: 3, retryDelay: 400 }) });
  }

  async mirror<T>(path: string): Promise<T> {
    const res = await fetch(path.startsWith("http") ? path : `${this.cfg.mirrorUrl}/api/v1${path}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new MirrorError(res.status, path);
    return (await res.json()) as T;
  }

  // The ABI is read from deployedContracts.ts at runtime, so it cannot be a compile-time `as const`; config.ts checks the functions this file calls exist.
  private desk<T>(functionName: string, args: unknown[] = []) {
    return this.rpc.readContract({ address: this.cfg.desk, abi: this.cfg.abi, functionName, args } as never) as Promise<T>;
  }

  async domain(): Promise<QuoteDomain> {
    const [, name, version, chainId, verifyingContract] = await this.desk<readonly [Hex, string, string, bigint, Address]>("eip712Domain");
    return { name, version, chainId: Number(chainId), verifyingContract };
  }

  async limits(): Promise<DeskLimits> {
    const [minTtl, maxTtl, fuelPerOrder, whbar, usdToken, factory] = await Promise.all([
      this.desk<bigint>("MIN_TTL"),
      this.desk<bigint>("MAX_TTL"),
      this.desk<bigint>("fuelPerOrder"),
      this.desk<Address>("whbar"),
      this.desk<Address>("usdToken"),
      this.desk<Address>("factory"),
    ]);
    return { minTtl, maxTtl, fuelPerOrder, whbar, usdToken, factory };
  }

  /** Resolves WHBAR, USDC, SAUCE (by symbol, WHBAR and USDC from the desk) or any 0x token address, and reads its symbol and decimals. */
  async token(ref: string): Promise<Token> {
    const key = ref.toLowerCase();
    const cached = this.tokens.get(key);
    if (cached) return cached;
    let address: Address;
    if (/^0x[0-9a-f]{40}$/.test(key)) address = ref as Address;
    else {
      const { whbar, usdToken } = await this.limits();
      const bySymbol: Record<string, Address> = { whbar, usdc: usdToken, sauce: "0x0000000000000000000000000000000000120f46" };
      const hit = bySymbol[key];
      if (!hit) throw new Error(`unknown token "${ref}": use WHBAR, USDC, SAUCE or a 0x token address`);
      address = hit;
    }
    const [symbol, decimals] = await Promise.all([
      this.rpc.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      this.rpc.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    const token = { address, symbol, decimals: Number(decimals) };
    this.tokens.set(key, token);
    this.tokens.set(address.toLowerCase(), token);
    return token;
  }

  async pool(tokenIn: Address, tokenOut: Address, fee: number) {
    const { factory } = await this.limits();
    const pool = await this.rpc.readContract({ address: factory, abi: factoryAbi, functionName: "getPool", args: [tokenIn, tokenOut, fee] });
    if (ZERO.test(pool)) return null;
    const [token0, slot] = await Promise.all([
      this.rpc.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
      this.rpc.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    ]);
    return { pool, tokenInIsToken0: token0.toLowerCase() === tokenIn.toLowerCase(), sqrtPriceX96: slot[0] };
  }

  /** The order, or null when the id was never posted (getOrder returns an empty struct then). */
  async order(id: bigint): Promise<Order | null> {
    const o = await this.desk<Order & { fee: number; status: number; rearms: number }>("getOrder", [id]);
    if (ZERO.test(o.taker)) return null;
    return { ...o, fee: Number(o.fee), status: Number(o.status), rearms: Number(o.rearms) };
  }

  /** The Chainlink band floor for the order, 0n when the pair has no band, null when the feed is stale and the desk would reject any fill. */
  async oracleFloor(id: bigint): Promise<bigint | null> {
    try {
      return await this.desk<bigint>("oracleFloor", [id]);
    } catch (error) {
      const name = revertName(error);
      if (name === "StaleOracle" || name === "BadOraclePrice") return null;
      throw error;
    }
  }

  async hbarUsdFresh(): Promise<boolean> {
    try {
      await this.desk<bigint>("hbarUsd");
      return true;
    } catch (error) {
      const name = revertName(error);
      if (name === "StaleOracle" || name === "BadOraclePrice") return false;
      throw error;
    }
  }

  orderCount() {
    return this.desk<bigint>("orderCount");
  }

  quoteDigest(id: bigint, quote: QuoteStruct) {
    return this.desk<Hex>("quoteDigest", [id, quote]);
  }

  nonceUsed(maker: Address, nonce: bigint) {
    return this.desk<boolean>("nonceUsed", [maker, nonce]);
  }

  balanceOf(token: Address, account: Address) {
    return this.rpc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  }

  allowance(token: Address, owner: Address, spender: Address) {
    return this.rpc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  }

  hbarBalance(account: Address) {
    return this.rpc.getBalance({ address: account });
  }

  gasPrice() {
    return this.rpc.getGasPrice();
  }

  /** Accepts 0.0.N or an EVM address; returns both forms from the mirror node. */
  async account(idOrAddress: string) {
    const info = await this.mirror<{ account: string; evm_address: Address }>(`/accounts/${idOrAddress}`);
    return { accountId: info.account, evmAddress: info.evm_address };
  }

  /** Whether `accountId` can receive each token. A failed lookup throws; it is never reported as associated. */
  async associations(accountId: string, tokens: readonly Address[]) {
    const out: Record<string, Association> = {};
    let auto: boolean | undefined;
    for (const token of tokens) {
      const id = entityRef(token);
      const rel = await this.mirror<{ tokens: { token_id: string }[] }>(`/accounts/${accountId}/tokens?token.id=${id}`);
      if (rel.tokens.some((t) => t.token_id === id)) {
        out[token.toLowerCase()] = "associated";
        continue;
      }
      if (auto === undefined) auto = (await this.mirror<{ max_automatic_token_associations: number }>(`/accounts/${accountId}`)).max_automatic_token_associations === -1;
      out[token.toLowerCase()] = auto ? "auto" : "needs";
    }
    return out;
  }

  /** Polls the mirror node until the transaction's contract result is there. Throws after ~45 s. */
  async waitForResult(txId: string): Promise<ContractResult> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return await this.mirror<ContractResult>(`/contracts/results/${txId}`);
      } catch (error) {
        if (!(error instanceof MirrorError) || error.status !== 404) throw error;
      }
      await sleep(1500);
    }
    throw new Error(`The mirror node has not recorded ${txId} after 45 s. Look it up on HashScan.`);
  }

  /** The newest `maxMessages` messages of a topic, newest first, base64 decoded. Junk is returned as text; the caller judges it. */
  async topicMessages(topicId: string, maxMessages: number): Promise<TopicMessage[]> {
    const out: TopicMessage[] = [];
    let next: string | null = `/topics/${topicId}/messages?order=desc&limit=${Math.min(100, maxMessages)}`;
    while (next && out.length < maxMessages) {
      const page: { messages: { sequence_number: number; consensus_timestamp: string; payer_account_id: string; message: string }[]; links?: { next?: string | null } } =
        await this.mirror(next);
      for (const m of page.messages) {
        out.push({ sequence: m.sequence_number, consensusTimestamp: m.consensus_timestamp, payer: m.payer_account_id, text: Buffer.from(m.message, "base64").toString("utf8") });
        if (out.length >= maxMessages) break;
      }
      next = page.links?.next ? `${this.cfg.mirrorUrl}${page.links.next}` : null;
    }
    return out;
  }

  /** Waits until a message with exactly this text is readable on the topic, the proof that a submit reached consensus and the mirror. */
  async waitForTopicMessage(topicId: string, text: string): Promise<TopicMessage> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const hit = (await this.topicMessages(topicId, 50)).find((m) => m.text === text);
      if (hit) return hit;
      await sleep(1500);
    }
    throw new Error(`The message is not on topic ${topicId} on the mirror node after 45 s.`);
  }

  /** The desk's events in a contract result's logs, decoded. Logs of other contracts and unknown events are skipped. */
  deskEvents(result: ContractResult) {
    const desk = this.cfg.desk.toLowerCase();
    return result.logs
      .filter((l) => l.address.toLowerCase() === desk)
      .flatMap((l) => {
        try {
          const e = decodeEventLog({ abi: this.cfg.abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
          return [{ name: String(e.eventName), args: e.args as unknown as Record<string, unknown> }];
        } catch {
          return [];
        }
      });
  }

  /** Decodes the revert bytes the mirror node stores for a failed call, e.g. `OnlyTaker()`. */
  decodeRevert(data: string | null | undefined) {
    return decodeRevert(this.cfg.abi, data);
  }
}

export function decodeRevert(abi: Abi, data: string | null | undefined): { name: string; args: string[] } | null {
  if (!data || data === "0x") return null;
  try {
    const decoded = decodeErrorResult({ abi, data: data as Hex });
    return { name: decoded.errorName, args: (decoded.args ?? []).map((a) => String(a)) };
  } catch {
    return null;
  }
}
