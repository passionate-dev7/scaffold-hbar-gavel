import { useState } from "react";
import { TxSteps } from "./TxSteps";
import { formatUnits } from "viem";
import { useTx, useWalletReady } from "~~/hooks/basket/useTx";
import type { Snapshot } from "~~/hooks/basket/useVault";
import { GAS_FLOOR, VAULT_ABI, VAULT_ADDRESS, WEIBAR_PER_TINYBAR } from "~~/utils/basket/constants";
import { fmtDuration, parseAmount } from "~~/utils/basket/format";

const UNITS = { minutes: 60, hours: 3600, days: 86400 } as const;

/** Owner-only: shown when the connected account is the vault's owner(). */
export function OwnerControls({ snap, runs }: { snap: Snapshot; runs: bigint | undefined }) {
  const { vault, cfg, lv } = snap;
  const ready = useWalletReady();
  const tx = useTx();
  const [interval, setIntervalValue] = useState("1");
  const [unit, setUnit] = useState<keyof typeof UNITS>("hours");
  const [withdraw, setWithdraw] = useState("");
  const [topUp, setTopUp] = useState("");
  const [last, setLast] = useState<{ id: string; label: string } | null>(null);

  const seconds = (() => {
    const n = parseAmount(interval, 0);
    return n === null ? null : Number(n) * UNITS[unit];
  })();
  const intervalOk = seconds !== null && seconds >= cfg.minInterval && seconds <= cfg.maxInterval;
  const fuelTiny = vault.fuel.data ? vault.fuel.data.value / WEIBAR_PER_TINYBAR : 0n;
  const withdrawTiny = parseAmount(withdraw, 8);
  const topUpTiny = parseAmount(topUp, 8);

  const go = (id: string, label: string, send: () => Promise<`0x${string}`>) => {
    setLast({ id, label });
    return tx.run([{ id, send }]);
  };

  return (
    <div className="mt-8 border-t border-base-300 pt-6">
      <h3 className="m-0 text-base font-semibold">Owner controls</h3>
      <p className="m-0 mt-1 text-xs text-base-content/70">Visible because your wallet is the vault owner.</p>

      <div className="mt-4 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            {lv.rebalanceInterval > 0 ? "Stop automation" : "Start automation"}
          </span>
          {lv.rebalanceInterval > 0 ? (
            <button
              type="button"
              className="btn btn-outline"
              disabled={tx.running}
              onClick={() =>
                go("stop", "Stop automation", () =>
                  tx.call(
                    { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "stopAutomation" },
                    GAS_FLOOR.stopAutomation,
                  ),
                )
              }
            >
              Stop and delete the pending schedule
            </button>
          ) : (
            <>
              <div className="join w-full">
                <input
                  inputMode="numeric"
                  className="input join-item w-full font-mono tabular-nums"
                  value={interval}
                  onChange={e => setIntervalValue(e.target.value)}
                  aria-label="Interval"
                />
                <select
                  className="select join-item w-auto"
                  value={unit}
                  onChange={e => setUnit(e.target.value as keyof typeof UNITS)}
                  aria-label="Interval unit"
                >
                  {Object.keys(UNITS).map(u => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </div>
              <p className="m-0 text-xs text-base-content/70">
                Between {fmtDuration(cfg.minInterval)} and {fmtDuration(cfg.maxInterval)}.
                {runs === 0n && " The vault holds no fuel for a run yet, so top it up first."}
              </p>
              <button
                type="button"
                className="btn btn-outline"
                disabled={!intervalOk || tx.running || runs === 0n}
                onClick={() =>
                  go("start", `Start automation every ${fmtDuration(seconds!)}`, () =>
                    tx.call(
                      {
                        address: VAULT_ADDRESS,
                        abi: VAULT_ABI,
                        functionName: "startAutomation",
                        args: [BigInt(seconds!)],
                      },
                      GAS_FLOOR.startAutomation,
                    ),
                  )
                }
              >
                Start automation
              </button>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Add fuel</span>
          <div className="join w-full">
            <input
              inputMode="decimal"
              className="input join-item w-full font-mono tabular-nums"
              placeholder="HBAR"
              value={topUp}
              onChange={e => setTopUp(e.target.value)}
              aria-label="HBAR to send to the vault"
            />
            <button
              type="button"
              className="btn join-item"
              disabled={!topUpTiny || tx.running}
              onClick={() =>
                go("topup", `Send ${topUp} HBAR to the vault`, () =>
                  tx.sendValue(VAULT_ADDRESS, topUpTiny! * WEIBAR_PER_TINYBAR),
                )
              }
            >
              Send
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Withdraw fuel</span>
          <div className="join w-full">
            <input
              inputMode="decimal"
              className="input join-item w-full font-mono tabular-nums"
              placeholder="HBAR"
              value={withdraw}
              onChange={e => setWithdraw(e.target.value)}
              aria-label="HBAR to withdraw"
            />
            <button
              type="button"
              className="btn join-item"
              onClick={() => setWithdraw(formatUnits(fuelTiny, 8))}
              disabled={fuelTiny === 0n}
            >
              Max
            </button>
            <button
              type="button"
              className="btn join-item"
              disabled={!withdrawTiny || withdrawTiny > fuelTiny || tx.running || !ready.address}
              onClick={() =>
                go("withdraw", `Withdraw ${withdraw} HBAR`, () =>
                  // The contract counts in tinybars, the wallet in weibars: this argument is tinybars.
                  tx.call(
                    {
                      address: VAULT_ADDRESS,
                      abi: VAULT_ABI,
                      functionName: "withdrawFuel",
                      args: [ready.address!, withdrawTiny!],
                    },
                    GAS_FLOOR.withdrawFuel,
                  ),
                )
              }
            >
              Withdraw
            </button>
          </div>
          <p className="m-0 text-xs text-base-content/70">
            Basket tokens are out of reach of this call. Only native HBAR leaves.
          </p>
        </div>

        {last && Object.keys(tx.runs).length > 0 && (
          <TxSteps steps={[{ id: last.id, label: last.label, needed: true }]} runs={tx.runs} />
        )}
      </div>
    </div>
  );
}
