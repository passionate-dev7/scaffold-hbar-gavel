import { OwnerControls } from "./OwnerControls";
import { TxSteps } from "./TxSteps";
import { WalletGate } from "./WalletGate";
import { useQuery } from "@tanstack/react-query";
import { useNow } from "~~/hooks/basket/useNow";
import { useTx, useWalletReady } from "~~/hooks/basket/useTx";
import type { Snapshot } from "~~/hooks/basket/useVault";
import { GAS_FLOOR, VAULT_ABI, VAULT_ADDRESS } from "~~/utils/basket/constants";
import { fmtDateTime, fmtDuration, fmtPercentFromBps, fmtUnits } from "~~/utils/basket/format";
import { evmToEntityId, hashscan } from "~~/utils/basket/hedera";
import { fetchLastRunFee } from "~~/utils/basket/mirror";

const Row = ({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-base-300 py-3 last:border-b-0">
    <dt className="text-sm text-base-content/70">{label}</dt>
    <dd className="m-0 text-right">
      <div className="font-mono text-sm tabular-nums">{children}</div>
      {note && <div className="mt-0.5 text-xs text-base-content/70">{note}</div>}
    </dd>
  </div>
);

export function AutomationCard({ snap }: { snap: Snapshot }) {
  const { vault, cfg, lv } = snap;
  const now = useNow(1000);
  const ready = useWalletReady();
  const tx = useTx();

  const fuel = vault.fuel.data?.value;
  const gasPrice = vault.gasPrice.data;
  const perRun = gasPrice !== undefined ? cfg.scheduledGas * gasPrice : undefined;
  // The payer must hold a whole reservation to start a run, but a run is charged only the gas it burns:
  // runs covered = (fuel - reservation) / cost per run + 1, with the cost read from the last run the vault paid for.
  const lastRunFee = useQuery({
    queryKey: ["basket", "lastRunFee", VAULT_ADDRESS],
    queryFn: () => fetchLastRunFee(VAULT_ADDRESS),
    refetchInterval: 60_000,
  });
  const costPerRun = lastRunFee.data ? lastRunFee.data * 10_000_000_000n : undefined; // tinybar to weibar
  const runs = (() => {
    if (fuel === undefined || !perRun) return undefined;
    if (fuel < perRun) return 0n;
    return costPerRun ? (fuel - perRun) / costPerRun + 1n : fuel / perRun;
  })();
  const on = lv.rebalanceInterval > 0;
  const isOwner = !!ready.address && ready.address.toLowerCase() === cfg.owner.toLowerCase();

  const nextRun = (() => {
    if (!on) return { text: "Off", note: "The basket rebalances only when the owner triggers it." };
    if (!lv.pendingSchedule) {
      return {
        text: "No run booked",
        note: "Automation is on but Hedera has no pending schedule. Anyone can book the next run below.",
        bad: true,
      };
    }
    if (now === null) return { text: "n/a" };
    const left = lv.nextRunAt - now;
    return left > 0
      ? { text: `in ${fmtDuration(left)}`, note: fmtDateTime(lv.nextRunAt) }
      : { text: `${fmtDuration(-left)} past due`, note: "Waiting for the network to execute the schedule." };
  })();

  const orphaned = on && !lv.pendingSchedule;
  const rearm = () =>
    tx.run([
      {
        id: "rearm",
        send: () => tx.call({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "rearm" }, GAS_FLOOR.rearm),
      },
    ]);

  const rebalance = () =>
    tx.run([
      {
        id: "rebalance",
        send: () => tx.call({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "rebalance" }, GAS_FLOOR.rebalance),
      },
    ]);

  return (
    <section
      className="flex flex-col rounded-box border border-base-300 bg-base-100 p-6"
      aria-labelledby="automation-title"
    >
      <h2 id="automation-title" className="m-0 text-xl font-semibold">
        Automation
      </h2>
      <p className="m-0 mt-1 text-sm text-base-content/70">
        The vault books its own rebalances with the Hedera Schedule Service, paid from its HBAR fuel.
      </p>

      <dl className="m-0 mt-4">
        <Row label="Interval">{on ? `Every ${fmtDuration(lv.rebalanceInterval)}` : "Off"}</Row>
        <Row label="Next run" note={nextRun.note}>
          <span className={nextRun.bad ? "text-error" : ""}>{nextRun.text}</span>
        </Row>
        <Row label="Pending schedule">
          {lv.pendingSchedule ? (
            <a
              className="link link-primary -my-2 inline-block py-2"
              href={hashscan.schedule(lv.pendingSchedule)}
              target="_blank"
              rel="noreferrer"
            >
              {evmToEntityId(lv.pendingSchedule)}
            </a>
          ) : (
            "None"
          )}
        </Row>
        <Row
          label="Fuel"
          note={
            perRun !== undefined
              ? `Each run reserves ${fmtUnits(cfg.scheduledGas, 0, 0)} gas, about ${fmtUnits(perRun, 18, 2)} HBAR at the current gas price${costPerRun ? `, and the last run cost ${fmtUnits(costPerRun, 18, 3)} HBAR` : ""}.`
              : undefined
          }
        >
          {fuel !== undefined ? `${fmtUnits(fuel, 18, 4)} HBAR` : "n/a"}
        </Row>
        <Row label="Runs covered">
          <span className={on && runs === 0n ? "text-error" : ""}>
            {runs !== undefined ? `${runs} ${runs === 1n ? "run" : "runs"}` : "n/a"}
          </span>
        </Row>
        <Row label="Drift band">{`±${fmtPercentFromBps(cfg.driftBps)} of NAV`}</Row>
        <Row label="Swap slippage guard">{fmtPercentFromBps(cfg.slippageBps)}</Row>
      </dl>

      {on && runs === 0n && (
        <p className="m-0 mt-3 text-sm text-error" role="alert">
          The fuel does not cover one more scheduled run. Hedera checks the payer against the gas reserved, so the
          schedule will fail until the vault is topped up.
        </p>
      )}

      {orphaned && (
        <div className="mt-6 flex flex-col gap-3">
          {!isOwner && Object.keys(tx.runs).length > 0 && (
            <TxSteps steps={[{ id: "rearm", label: "Book the next run", needed: true }]} runs={tx.runs} />
          )}
          <WalletGate ready={ready}>
            <button type="button" className="btn btn-primary w-full" disabled={tx.running} onClick={rearm}>
              {tx.running ? "Working" : "Book the next run"}
            </button>
          </WalletGate>
          <p className="m-0 text-xs text-base-content/70">
            Any connected wallet can press this. The vault pays for the booking from its own fuel, not you; you only pay
            the transaction fee.
          </p>
        </div>
      )}

      {isOwner && (
        <>
          <div className="mt-6 flex flex-col gap-4">
            {Object.keys(tx.runs).length > 0 && (
              <TxSteps
                steps={[
                  { id: "rebalance", label: "Rebalance", needed: true },
                  { id: "rearm", label: "Book the next run", needed: true },
                ].filter(step => step.id in tx.runs)}
                runs={tx.runs}
              />
            )}
            {lv.hbarUsd === undefined && (
              <p className="m-0 text-sm text-warning">Rebalancing waits for a fresh Chainlink answer.</p>
            )}
            <WalletGate ready={ready}>
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={tx.running || lv.hbarUsd === undefined}
                onClick={rebalance}
              >
                {tx.running ? "Working" : "Rebalance now"}
              </button>
            </WalletGate>
            <p className="m-0 text-xs text-base-content/70">
              Trades only the tokens that sit outside the band, and only toward their targets.
            </p>
          </div>
          <OwnerControls snap={snap} runs={runs} />
        </>
      )}
    </section>
  );
}
