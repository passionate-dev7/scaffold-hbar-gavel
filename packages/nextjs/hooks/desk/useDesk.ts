import { useQueries, useQuery } from "@tanstack/react-query";
import { type Address, zeroAddress } from "viem";
import { usePublicClient } from "wagmi";
import {
  CHAIN_ID,
  DESK_ABI,
  DESK_ADDRESS,
  ERC20_ABI,
  FACTORY_ABI,
  POLL_MS,
  POOL_ABI,
  QUOTE_TOPIC_ID,
} from "~~/utils/desk/constants";
import { fetchDeskEvents, fetchSchedule, fetchTopicMessages } from "~~/utils/desk/mirror";
import { type QuoteDomain, type SignedQuote, parseQuote, verifyQuote } from "~~/utils/desk/quotes";

/** What `getOrder` returns, named as the contract names it. */
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

const RECENT_ORDERS = 20;

function useDeskClient() {
  return usePublicClient({ chainId: CHAIN_ID });
}

/** Desk constants and the counters that move: all read from the contract. */
export function useDeskParams() {
  const client = useDeskClient();
  return useQuery({
    queryKey: ["desk", "params"],
    enabled: !!client,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const read = { address: DESK_ADDRESS, abi: DESK_ABI } as const;
      const [orderCount, fuelPerOrder, minTtl, maxTtl, factory, domain] = await Promise.all([
        client!.readContract({ ...read, functionName: "orderCount" }),
        client!.readContract({ ...read, functionName: "fuelPerOrder" }),
        client!.readContract({ ...read, functionName: "MIN_TTL" }),
        client!.readContract({ ...read, functionName: "MAX_TTL" }),
        client!.readContract({ ...read, functionName: "factory" }),
        client!.readContract({ ...read, functionName: "eip712Domain" }),
      ]);
      const quoteDomain: QuoteDomain = {
        name: domain[1],
        version: domain[2],
        chainId: Number(domain[3]),
        verifyingContract: domain[4],
      };
      return { orderCount, fuelPerOrder, minTtl, maxTtl, factory, quoteDomain };
    },
  });
}

/** Orders by id. A settled order never changes again, so only open ones keep polling. */
export function useOrders(ids: readonly bigint[]) {
  const client = useDeskClient();
  const results = useQueries({
    queries: ids.map(id => ({
      queryKey: ["desk", "order", id.toString()],
      enabled: !!client,
      refetchInterval: (query: { state: { data?: Order } }) =>
        query.state.data && query.state.data.status !== 0 ? false : POLL_MS,
      queryFn: async (): Promise<Order> => {
        const o = await client!.readContract({
          address: DESK_ADDRESS,
          abi: DESK_ABI,
          functionName: "getOrder",
          args: [id],
        });
        return o as Order;
      },
    })),
  });
  return ids.map((id, i) => ({ id, order: results[i].data, error: results[i].error }));
}

/** The newest `RECENT_ORDERS` ids, newest first. Ids start at 1. */
export function recentIds(orderCount: bigint | undefined): bigint[] {
  if (!orderCount) return [];
  const ids: bigint[] = [];
  for (let id = orderCount; id >= 1n && ids.length < RECENT_ORDERS; id--) ids.push(id);
  return ids;
}

export type PoolSpot = { pool: Address; sqrtPriceX96: bigint; tokenInIsToken0: boolean };

/** The SaucerSwap V2 pool for a pair and its price right now. */
export function usePoolSpot(
  pair: { tokenIn: Address; tokenOut: Address; fee: number } | undefined,
  factory: Address | undefined,
) {
  const client = useDeskClient();
  return useQuery({
    queryKey: ["desk", "pool", pair?.tokenIn, pair?.tokenOut, pair?.fee, factory],
    enabled: !!client && !!pair && !!factory,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<PoolSpot> => {
      const { tokenIn, tokenOut, fee } = pair!;
      const pool = await client!.readContract({
        address: factory!,
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [tokenIn, tokenOut, fee],
      });
      if (pool === zeroAddress) throw new Error("SaucerSwap has no pool for this pair.");
      const [token0, slot0] = await Promise.all([
        client!.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
        client!.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }),
      ]);
      return { pool, sqrtPriceX96: slot0[0], tokenInIsToken0: token0.toLowerCase() === tokenIn.toLowerCase() };
    },
  });
}

export function useDeskEvents() {
  return useQuery({
    queryKey: ["desk", "events"],
    refetchInterval: POLL_MS,
    queryFn: () => fetchDeskEvents(DESK_ADDRESS, 100),
  });
}

/** The scheduled fallback as the network holds it: when it runs, whether it ran, whether it was deleted. */
export function useSchedule(schedule: Address | undefined) {
  return useQuery({
    queryKey: ["desk", "schedule", schedule],
    enabled: !!schedule && schedule !== zeroAddress,
    refetchInterval: 5_000,
    queryFn: () => fetchSchedule(schedule!),
  });
}

export type BoardQuote = SignedQuote & { signatureOk: boolean; nonceSpent: boolean; funded: boolean | null };

export type QuoteBoardData = {
  quotes: BoardQuote[];
  /** Messages read from the topic, whatever they were. */
  messagesRead: number;
  /** Lowest amount the Chainlink band admits, 0 when the pair is not bandable. */
  oracleFloor: bigint;
};

/**
 * Every quote on the HCS topic for one order, with the three things only the chain can say: does the signature
 * recover to the maker, is the nonce unspent, does the maker hold and have approved the amount.
 */
export function useQuoteBoard(id: bigint | undefined, order: Order | undefined, domain: QuoteDomain | undefined) {
  const client = useDeskClient();
  return useQuery({
    queryKey: ["desk", "quotes", id?.toString(), order?.tokenOut],
    enabled: !!client && id !== undefined && !!order && !!domain,
    refetchInterval: 10_000,
    queryFn: async (): Promise<QuoteBoardData> => {
      const messages = await fetchTopicMessages(QUOTE_TOPIC_ID);
      const forOrder = messages.flatMap(m => parseQuote(m) ?? []).filter(q => q.orderId === id);
      const signatures = await Promise.all(forOrder.map(q => verifyQuote(q, domain!)));
      const oracleFloor = await client!
        .readContract({ address: DESK_ADDRESS, abi: DESK_ABI, functionName: "oracleFloor", args: [id!] })
        // A stale feed reverts; the quote's own checks still apply, only the band is unknown.
        .catch(() => 0n);
      const quotes = await Promise.all(
        forOrder.map(async (q, i): Promise<BoardQuote> => {
          const signatureOk = signatures[i];
          if (!signatureOk) return { ...q, signatureOk, nonceSpent: false, funded: null };
          const [nonceSpent, balance, allowance] = await Promise.all([
            client!.readContract({
              address: DESK_ADDRESS,
              abi: DESK_ABI,
              functionName: "nonceUsed",
              args: [q.maker, q.nonce],
            }),
            client!.readContract({
              address: order!.tokenOut,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [q.maker],
            }),
            client!.readContract({
              address: order!.tokenOut,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [q.maker, DESK_ADDRESS],
            }),
          ]);
          return { ...q, signatureOk, nonceSpent, funded: balance >= q.amountOut && allowance >= q.amountOut };
        }),
      );
      return { quotes, messagesRead: messages.length, oracleFloor };
    },
  });
}
