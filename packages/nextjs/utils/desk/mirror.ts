import { DESK_ABI } from "./constants";
import { evmToEntityId } from "./hedera";
import { type Address, type Hex, decodeEventLog } from "viem";

export const MIRROR_URL = process.env.NEXT_PUBLIC_HEDERA_TESTNET_MIRROR_URL || "https://testnet.mirrornode.hedera.com";

const API_PREFIX = "/api/v1";

export class MirrorError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`Mirror node answered ${status} for ${path}`);
  }
}

/** `path` is relative to /api/v1, or a `links.next` value the mirror node returned (which already carries the prefix). */
export async function mirrorGet<T>(path: string): Promise<T> {
  const url = path.startsWith(API_PREFIX) ? `${MIRROR_URL}${path}` : `${MIRROR_URL}${API_PREFIX}${path}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
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

export const DESK_EVENT_NAMES = [
  "OrderPosted",
  "Filled",
  "FellBack",
  "Refunded",
  "Cancelled",
  "Rearmed",
  "Claimed",
] as const;
export type DeskEventName = (typeof DESK_EVENT_NAMES)[number];

export type DeskEvent = {
  id: string;
  name: DeskEventName;
  args: Record<string, unknown>;
  /** Consensus time, unix seconds. */
  at: number;
  hash: Hex;
};

/**
 * Newest desk logs first, as many as `limit` raw logs. The JSON-RPC getLogs on hashio is range-limited, the mirror
 * node is not. Logs the desk ABI cannot decode (HTS token events) and events outside the headline set get no row.
 */
export async function fetchDeskEvents(desk: Address, limit = 100): Promise<DeskEvent[]> {
  const { logs } = await mirrorGet<{ logs: MirrorLog[] }>(`/contracts/${desk}/results/logs?order=desc&limit=${limit}`);
  return logs.flatMap(log => decodeDeskLog(log) ?? []);
}

function decodeDeskLog(log: MirrorLog): DeskEvent | null {
  try {
    const decoded = decodeEventLog({ abi: DESK_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    if (!(DESK_EVENT_NAMES as readonly string[]).includes(decoded.eventName)) return null;
    return {
      id: `${log.transaction_hash}-${log.index}`,
      name: decoded.eventName as DeskEventName,
      args: (decoded.args ?? {}) as Record<string, unknown>,
      at: Number(log.timestamp.split(".")[0]),
      hash: log.transaction_hash,
    };
  } catch {
    return null;
  }
}

export type TopicMessage = {
  sequence: number;
  /** Network-assigned consensus timestamp, "seconds.nanos". */
  consensusTimestamp: string;
  /** Base64 as the mirror node serves it. */
  message: string;
};

type TopicPage = {
  messages: { sequence_number: number; consensus_timestamp: string; message: string }[];
  links: { next: string | null };
};

const MAX_TOPIC_PAGES = 5;

/** Newest messages first, up to `MAX_TOPIC_PAGES` pages of 100. */
export async function fetchTopicMessages(topicId: string): Promise<TopicMessage[]> {
  const out: TopicMessage[] = [];
  let next: string | null = `/topics/${topicId}/messages?order=desc&limit=100`;
  for (let page = 0; next && page < MAX_TOPIC_PAGES; page++) {
    const body: TopicPage = await mirrorGet<TopicPage>(next);
    for (const m of body.messages) {
      out.push({ sequence: m.sequence_number, consensusTimestamp: m.consensus_timestamp, message: m.message });
    }
    next = body.links.next;
  }
  return out;
}

export type ScheduleInfo = {
  deleted: boolean;
  /** Set once the network has run the scheduled call. */
  executed_timestamp: string | null;
  /** When the scheduled call runs, "seconds.nanos". */
  expiration_time: string | null;
};

export const fetchSchedule = (scheduleAddress: Address) =>
  mirrorGet<ScheduleInfo>(`/schedules/${evmToEntityId(scheduleAddress)}`);
