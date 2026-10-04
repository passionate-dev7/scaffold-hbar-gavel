import { VAULT_ABI } from "./constants";
import { evmToEntityId } from "./hedera";
import { type Address, type Hex, decodeEventLog, toEventSelector } from "viem";

export const MIRROR_URL = process.env.NEXT_PUBLIC_HEDERA_TESTNET_MIRROR_URL || "https://testnet.mirrornode.hedera.com";

export class MirrorError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`Mirror node answered ${status} for ${path}`);
  }
}

export async function mirrorGet<T>(path: string): Promise<T> {
  const res = await fetch(`${MIRROR_URL}/api/v1${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new MirrorError(res.status, path);
  return (await res.json()) as T;
}

export type Association = "associated" | "auto" | "needs";

/**
 * Whether `account` can receive `token`. Throws on any lookup failure so the caller can show "unknown"
 * rather than guess: an unreadable answer is never reported as associated.
 */
export async function fetchAssociation(account: Address, token: Address): Promise<Association> {
  const tokenId = evmToEntityId(token);
  const rel = await mirrorGet<{ tokens: { token_id: string }[] }>(`/accounts/${account}/tokens?token.id=${tokenId}`);
  if (rel.tokens.some(t => t.token_id === tokenId)) return "associated";
  const info = await mirrorGet<{ max_automatic_token_associations: number }>(`/accounts/${account}`);
  return info.max_automatic_token_associations === -1 ? "auto" : "needs";
}

type ContractResult = { result: string; call_result: Hex | null };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A call's own outcome on the mirror node. A receipt only says the transaction ran; HTS calls such as
 * `associate()` report failure as a returned response code, which lives in `call_result`.
 */
export async function waitForContractResult(hash: Hex): Promise<ContractResult> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await mirrorGet<ContractResult>(`/contracts/results/${hash}`);
    } catch (error) {
      if (!(error instanceof MirrorError) || error.status !== 404) throw error;
    }
    await sleep(1500);
  }
  throw new Error("The mirror node has not recorded the transaction yet. Look it up on HashScan.");
}

export type MirrorLog = {
  data: Hex;
  topics: Hex[];
  index: number;
  timestamp: string;
  transaction_hash: Hex;
};

export type VaultEvent = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Consensus time, unix seconds. */
  at: number;
  hash: Hex;
};

/** Newest vault logs first. The JSON-RPC getLogs on hashio is range-limited, the mirror node is not. */
export async function fetchVaultEvents(vault: Address, limit = 25): Promise<VaultEvent[]> {
  const { logs } = await mirrorGet<{ logs: MirrorLog[] }>(`/contracts/${vault}/results/logs?order=desc&limit=${limit}`);
  return logs.flatMap(log => decodeVaultLog(log) ?? []);
}

/** Null for a log the vault ABI cannot decode: it is not one of the vault's events, so it gets no row. */
function decodeVaultLog(log: MirrorLog): VaultEvent | null {
  try {
    const decoded = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return {
      id: `${log.transaction_hash}-${log.index}`,
      name: decoded.eventName,
      args: (decoded.args ?? {}) as Record<string, unknown>,
      at: Number(log.timestamp.split(".")[0]),
      hash: log.transaction_hash,
    };
  } catch {
    return null;
  }
}

const SCHEDULED_RUN_TOPIC = toEventSelector("ScheduledRun(bool)");
const RUN_LOOKBACK_SECONDS = 6 * 24 * 3600;

/**
 * What the vault's most recent scheduled run actually cost it, in tinybar, or null if it has not run in the
 * last six days. Topic searches on the mirror node need a closed timestamp range.
 */
export async function fetchLastRunFee(vault: Address): Promise<bigint | null> {
  const now = Math.floor(Date.now() / 1000);
  const { logs } = await mirrorGet<{ logs: MirrorLog[] }>(
    `/contracts/${vault}/results/logs?topic0=${SCHEDULED_RUN_TOPIC}&timestamp=gte:${now - RUN_LOOKBACK_SECONDS}&timestamp=lte:${now}&order=desc&limit=1`,
  );
  if (logs.length === 0) return null;
  const { transactions } = await mirrorGet<{ transactions: { charged_tx_fee: number }[] }>(
    `/transactions?timestamp=${logs[0].timestamp}`,
  );
  return transactions.length > 0 ? BigInt(transactions[0].charged_tx_fee) : null;
}
