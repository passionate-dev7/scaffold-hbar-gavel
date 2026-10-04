import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hex } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { CHAIN_ID, GAS_CAP, GAS_FLOOR, HRC719_ABI, HTS_ALREADY_ASSOCIATED, HTS_SUCCESS } from "~~/utils/desk/constants";
import { explainError, revertName } from "~~/utils/desk/errors";
import { waitForContractResult } from "~~/utils/desk/mirror";

export type StepRun = { status: "signing" | "confirming" | "done" | "failed"; hash?: Hex; error?: string };

export type RunnableStep = {
  id: string;
  send: () => Promise<Hex>;
  /** Runs after the receipt: reads back what a successful receipt does not prove. */
  verify?: (hash: Hex) => Promise<void>;
};

/** Wallet readiness for writes: connected, and on the chain the desk lives on. */
export function useWalletReady() {
  const { address, chain } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  return {
    address,
    // The burner connector can sit in "connecting" with its address already restored, and still signs, so an
    // address is what sending needs. wagmi never reports an address while disconnected.
    isConnected: address !== undefined,
    onTarget: chain?.id === CHAIN_ID,
    switchToTarget: () => switchChain({ chainId: CHAIN_ID }),
    switching,
  };
}

/**
 * Sends contract calls with gas set explicitly, and runs a list of them in order while
 * tracking each one: waiting for the wallet, waiting for consensus, done, or failed with a readable reason.
 */
export function useTx() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const [runs, setRuns] = useState<Record<string, StepRun>>({});
  const [running, setRunning] = useState(false);

  /** Node estimate padded by a quarter, never below the floor. A revert the node can name stops the call here. */
  const gasFor = async (estimate: () => Promise<bigint>, floor: bigint) => {
    try {
      const padded = ((await estimate()) * 125n) / 100n;
      return padded > GAS_CAP ? GAS_CAP : padded > floor ? padded : floor;
    } catch (error) {
      if (revertName(error)) throw error;
      return floor;
    }
  };

  const call = async <const abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable" | "payable">>(
    params: {
      address: Address;
      abi: abi;
      functionName: fn;
      args?: ContractFunctionArgs<abi, "nonpayable" | "payable", fn>;
      value?: bigint;
    },
    floor: bigint,
  ): Promise<Hex> => {
    const gas = await gasFor(() => client!.estimateContractGas({ ...params, account: address } as never), floor);
    return writeContractAsync({ ...params, chainId: CHAIN_ID, gas } as never);
  };

  const run = useCallback(
    async (steps: RunnableStep[]): Promise<boolean> => {
      setRunning(true);
      setRuns({});
      const patch = (id: string, next: StepRun) => setRuns(prev => ({ ...prev, [id]: next }));
      try {
        for (const step of steps) {
          let hash: Hex | undefined;
          try {
            patch(step.id, { status: "signing" });
            hash = await step.send();
            patch(step.id, { status: "confirming", hash });
            const receipt = await client!.waitForTransactionReceipt({ hash, pollingInterval: 2000, timeout: 120_000 });
            if (receipt.status !== "success") {
              throw new Error("The transaction reverted on-chain. Open it on HashScan for the reason.");
            }
            await step.verify?.(hash);
            patch(step.id, { status: "done", hash });
            // Association answers stay as the HTS response code set them: the mirror node trails consensus.
            await queryClient.invalidateQueries({
              predicate: q => !(q.queryKey[0] === "desk" && q.queryKey[1] === "assoc"),
            });
          } catch (error) {
            patch(step.id, { status: "failed", hash, error: explainError(error) });
            return false;
          }
        }
        return true;
      } finally {
        setRunning(false);
      }
    },
    [client, queryClient],
  );

  /** HIP-719 `associate()` from the connected wallet, checked against the HTS response code the mirror node recorded. */
  const associateStep = (token: Address, id: string): RunnableStep => ({
    id,
    send: () => call({ address: token, abi: HRC719_ABI, functionName: "associate" }, GAS_FLOOR.associate),
    verify: async hash => {
      const { result, call_result } = await waitForContractResult(hash);
      const code = call_result ? BigInt(call_result) : undefined;
      if (result !== "SUCCESS" || (code !== HTS_SUCCESS && code !== HTS_ALREADY_ASSOCIATED)) {
        throw new Error(`Hedera Token Service answered ${code?.toString() ?? result}. The association did not happen.`);
      }
      queryClient.setQueryData(["desk", "assoc", address, token], "associated");
    },
  });

  return { runs, running, run, call, associateStep, reset: () => setRuns({}) };
}
