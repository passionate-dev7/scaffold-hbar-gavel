import { useQuery } from "@tanstack/react-query";
import { type Address, zeroAddress } from "viem";
import { useAccount, useBalance, useGasPrice, usePublicClient } from "wagmi";
import {
  CHAIN_ID,
  ERC20_ABI,
  FEED_ABI,
  IS_DEPLOYED,
  POLL_MS,
  VAULT_ABI,
  VAULT_ADDRESS,
} from "~~/utils/basket/constants";

export type BasketToken = { address: Address; symbol: string; decimals: number; targetBps: number };

const isSet = (address: Address) => address.toLowerCase() !== zeroAddress;

/** Values the contract fixes at deploy or changes rarely: ownership, limits, and each basket token's metadata. */
function useVaultConfig() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["basket", "config", VAULT_ADDRESS],
    enabled: !!client && IS_DEPLOYED,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const read = client!.readContract;
      const base = { address: VAULT_ADDRESS, abi: VAULT_ABI } as const;
      const [owner, shareToken, whbar, feed, driftBps, slippageBps, scheduledGas, maxOracleAge, deadShares, rows] =
        await Promise.all([
          read({ ...base, functionName: "owner" }),
          read({ ...base, functionName: "shareToken" }),
          read({ ...base, functionName: "whbar" }),
          read({ ...base, functionName: "hbarUsdFeed" }),
          read({ ...base, functionName: "driftBps" }),
          read({ ...base, functionName: "slippageBps" }),
          read({ ...base, functionName: "scheduledGas" }),
          read({ ...base, functionName: "maxOracleAge" }),
          read({ ...base, functionName: "DEAD_SHARES" }),
          read({ ...base, functionName: "holdings" }),
        ]);
      const [minInterval, maxInterval] = await Promise.all([
        read({ ...base, functionName: "MIN_INTERVAL" }),
        read({ ...base, functionName: "MAX_INTERVAL" }),
      ]);
      const shareSymbol = isSet(shareToken)
        ? await read({ address: shareToken, abi: ERC20_ABI, functionName: "symbol" })
        : undefined;
      const tokens: BasketToken[] = await Promise.all(
        rows.map(async row => {
          const [symbol, decimals] = await Promise.all([
            read({ address: row.token, abi: ERC20_ABI, functionName: "symbol" }),
            read({ address: row.token, abi: ERC20_ABI, functionName: "decimals" }),
          ]);
          return { address: row.token, symbol, decimals, targetBps: row.targetBps };
        }),
      );
      return {
        owner,
        shareToken: isSet(shareToken) ? shareToken : undefined,
        shareSymbol,
        whbar,
        feed,
        driftBps: Number(driftBps),
        slippageBps: Number(slippageBps),
        scheduledGas,
        maxOracleAge: Number(maxOracleAge),
        deadShares,
        minInterval: Number(minInterval),
        maxInterval: Number(maxInterval),
        tokens,
      };
    },
  });
}

export type VaultConfig = NonNullable<ReturnType<typeof useVaultConfig>["data"]>;
type Config = VaultConfig;

/** Everything that moves: balances, NAV, the schedule and the oracle. The oracle reads fail apart from the rest. */
function useVaultLive(config: Config | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["basket", "live", VAULT_ADDRESS, config?.shareToken],
    enabled: !!client && !!config,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const read = client!.readContract;
      const base = { address: VAULT_ADDRESS, abi: VAULT_ABI } as const;
      const [holdings, nav, rebalanceInterval, nextRunAt, pendingSchedule, supply] = await Promise.all([
        read({ ...base, functionName: "holdings" }),
        read({ ...base, functionName: "nav" }),
        read({ ...base, functionName: "rebalanceInterval" }),
        read({ ...base, functionName: "nextRunAt" }),
        read({ ...base, functionName: "pendingSchedule" }),
        config!.shareToken
          ? read({ address: config!.shareToken, abi: ERC20_ABI, functionName: "totalSupply" })
          : Promise.resolve(0n),
      ]);
      const [navUsd, sharePriceUsd, hbarUsd, round] = await Promise.allSettled([
        read({ ...base, functionName: "navUsd" }),
        read({ ...base, functionName: "sharePriceUsd" }),
        read({ ...base, functionName: "hbarUsd" }),
        read({ address: config!.feed, abi: FEED_ABI, functionName: "latestRoundData" }),
      ]);
      const val = <T>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : undefined);
      const feedRound = val(round);
      return {
        holdings,
        nav,
        supply,
        rebalanceInterval: Number(rebalanceInterval),
        nextRunAt: Number(nextRunAt),
        pendingSchedule: isSet(pendingSchedule) ? pendingSchedule : undefined,
        navUsd: val(navUsd),
        sharePriceUsd: val(sharePriceUsd),
        hbarUsd: val(hbarUsd),
        feed: feedRound ? { answer: feedRound[1], updatedAt: Number(feedRound[3]) } : undefined,
      };
    },
  });
}

export type VaultLive = NonNullable<ReturnType<typeof useVaultLive>["data"]>;

function useAccountShares(config: Config | undefined, account: Address | undefined) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["basket", "account", account, config?.shareToken],
    enabled: !!client && !!account && !!config?.shareToken,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      const [balance, allowance] = await Promise.all([
        client!.readContract({
          address: config!.shareToken!,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account!],
        }),
        client!.readContract({
          address: config!.shareToken!,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [account!, VAULT_ADDRESS],
        }),
      ]);
      return { balance, allowance };
    },
  });
}

/** One read model of the vault for the whole page. */
export function useVault() {
  const { address } = useAccount();
  const config = useVaultConfig();
  const live = useVaultLive(config.data);
  const shares = useAccountShares(config.data, address);
  const fuel = useBalance({
    address: VAULT_ADDRESS,
    chainId: CHAIN_ID,
    query: { enabled: IS_DEPLOYED, refetchInterval: POLL_MS },
  });
  const wallet = useBalance({ address, chainId: CHAIN_ID, query: { enabled: !!address, refetchInterval: POLL_MS } });
  const gasPrice = useGasPrice({ chainId: CHAIN_ID, query: { refetchInterval: POLL_MS } });
  return { deployed: IS_DEPLOYED, config, live, shares, fuel, wallet, gasPrice };
}

export type Vault = ReturnType<typeof useVault>;
/** A vault read model whose config and live state have both arrived. */
export type Snapshot = { vault: Vault; cfg: VaultConfig; lv: VaultLive };
