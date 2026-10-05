import { useAccount, usePublicClient } from "wagmi";
import { WalletGate } from "~~/components/desk/WalletGate";
import { type Order } from "~~/hooks/desk/useDesk";
import { useTx, useWalletReady } from "~~/hooks/desk/useTx";
import { CHAIN_ID, DESK_ABI, DESK_ADDRESS, GAS_FLOOR } from "~~/utils/desk/constants";
import { fmtEscrow } from "~~/utils/desk/format";
import { hashscan } from "~~/utils/desk/hedera";

const STEP_TEXT = { signing: "Confirm in your wallet", confirming: "Waiting for consensus", done: "Done", failed: "" };

/** Cancel an open order, or claim escrow a refund could not deliver. Renders nothing for anyone but the taker. */
export function OrderActions({ id, order }: { id: bigint; order: Order }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const ready = useWalletReady();
  const tx = useTx();
  const mine = !!address && address.toLowerCase() === order.taker.toLowerCase();
  const canCancel = order.status === 0;
  const canClaim = order.claimable > 0n;
  if (!mine || (!canCancel && !canClaim)) return null;

  const expectStatus = async (status: number) => {
    const o = await client!.readContract({
      address: DESK_ADDRESS,
      abi: DESK_ABI,
      functionName: "getOrder",
      args: [id],
    });
    if (o.status !== status) throw new Error(`The desk still reports order #${id} with status ${o.status}.`);
  };

  const cancel = () =>
    tx.run([
      {
        id: "cancel",
        send: () =>
          tx.call({ address: DESK_ADDRESS, abi: DESK_ABI, functionName: "cancel", args: [id] }, GAS_FLOOR.cancel),
        verify: () => expectStatus(3),
      },
    ]);

  const claim = () =>
    tx.run([
      {
        id: "claim",
        send: () =>
          tx.call({ address: DESK_ADDRESS, abi: DESK_ABI, functionName: "claim", args: [id] }, GAS_FLOOR.claim),
        verify: async () => {
          const o = await client!.readContract({
            address: DESK_ADDRESS,
            abi: DESK_ABI,
            functionName: "getOrder",
            args: [id],
          });
          if (o.claimable !== 0n) throw new Error("The desk still holds the claim.");
        },
      },
    ]);

  const run = Object.values(tx.runs)[0];

  return (
    <div className="flex flex-col gap-1">
      <WalletGate ready={ready}>
        <div className="flex flex-wrap gap-2">
          {canCancel && (
            <button type="button" className="act act-sm act-danger" onClick={cancel} disabled={tx.running}>
              Cancel order
            </button>
          )}
          {canClaim && (
            <button type="button" className="act act-sm act-line" onClick={claim} disabled={tx.running}>
              Claim {fmtEscrow(order.claimable, order.tokenIn)}
            </button>
          )}
        </div>
      </WalletGate>
      {run && (
        <p className={`m-0 text-xs ${run.status === "failed" ? "text-bad" : "text-mute"}`} role="status">
          {run.status === "failed" ? run.error : STEP_TEXT[run.status]}{" "}
          {run.hash && (
            <a className="link" href={hashscan.tx(run.hash)} target="_blank" rel="noreferrer">
              HashScan
            </a>
          )}
        </p>
      )}
    </div>
  );
}
