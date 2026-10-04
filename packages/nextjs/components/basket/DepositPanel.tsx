import { useState } from "react";
import { AssociationWarning } from "./AssociationWarning";
import { type PlannedStep, TxSteps } from "./TxSteps";
import { WalletGate } from "./WalletGate";
import { useLocalStorage } from "usehooks-ts";
import { formatUnits } from "viem";
import { useAssociations } from "~~/hooks/basket/useAssociations";
import { type RunnableStep, useTx, useWalletReady } from "~~/hooks/basket/useTx";
import type { Snapshot } from "~~/hooks/basket/useVault";
import {
  BPS,
  DEFAULT_SLIPPAGE_BPS,
  GAS_FLOOR,
  SHARE_DECIMALS,
  VAULT_ABI,
  VAULT_ADDRESS,
  WEIBAR_PER_TINYBAR,
} from "~~/utils/basket/constants";
import { fmtUnits, fmtUsd, parseAmount } from "~~/utils/basket/format";

const SLIPPAGE_CHOICES = [100, 300, 500];

export function DepositPanel({ snap }: { snap: Snapshot }) {
  const { vault, cfg, lv } = snap;
  const ready = useWalletReady();
  const tx = useTx();
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useLocalStorage("basket:slippage-bps", DEFAULT_SLIPPAGE_BPS, {
    initializeWithValue: false,
  });
  const [shareAssoc] = useAssociations(ready.address, cfg.shareToken ? [cfg.shareToken] : []);

  const tiny = parseAmount(amount, 8);
  const weibar = tiny === null ? null : tiny * WEIBAR_PER_TINYBAR;
  const gasPrice = vault.gasPrice.data;
  const reserve = gasPrice !== undefined ? GAS_FLOOR.deposit * gasPrice : undefined;
  const walletBalance = vault.wallet.data?.value;
  const maxTiny =
    walletBalance !== undefined && reserve !== undefined && walletBalance > reserve
      ? (walletBalance - reserve) / WEIBAR_PER_TINYBAR
      : 0n;

  // Shares are value added x supply / NAV, and the first deposit mints 1 share unit per tinybar of value.
  const firstDeposit = lv.supply === 0n;
  const estShares =
    tiny === null || tiny === 0n
      ? null
      : firstDeposit
        ? tiny > cfg.deadShares
          ? tiny - cfg.deadShares
          : 0n
        : lv.nav > 0n
          ? (tiny * lv.supply) / lv.nav
          : null;
  const minShares = estShares === null ? null : (estShares * (BPS - BigInt(slippageBps))) / BPS;
  const usd = tiny !== null && lv.hbarUsd !== undefined ? (tiny * lv.hbarUsd) / 10n ** 8n : undefined;

  const assocKnown =
    shareAssoc?.state.kind === "associated" || shareAssoc?.state.kind === "auto" || shareAssoc?.state.kind === "needs";
  const needsAssoc = shareAssoc?.state.kind === "needs";

  const problem = (() => {
    if (!cfg.shareToken) return "The vault has not created its share token yet. The owner runs initialize() first.";
    if (lv.hbarUsd === undefined) return "Chainlink HBAR/USD is stale. Deposits resume at its next update.";
    if (amount && tiny === null) return "Enter an HBAR amount with at most 8 decimals.";
    if (tiny === 0n) return "Enter an amount above zero.";
    if (weibar !== null && walletBalance !== undefined && reserve !== undefined && weibar + reserve > walletBalance) {
      return `Your balance is short once the gas reserve of about ${fmtUnits(reserve, 18, 2)} HBAR is set aside.`;
    }
    if (estShares === 0n) return "That amount does not cover the dead shares the first deposit locks in.";
    return null;
  })();

  const steps: PlannedStep[] = [
    {
      id: "assoc-share",
      label: `Associate ${cfg.shareSymbol ?? "the share token"} with your account`,
      hint: "Hedera accounts receive a token only after associating with it.",
      needed: needsAssoc,
    },
    {
      id: "deposit",
      label: tiny ? `Deposit ${amount} HBAR` : "Deposit HBAR",
      hint: "The vault buys the basket at target weights and mints your shares.",
      needed: true,
    },
  ];

  const canSend = !!tiny && !problem && minShares !== null && assocKnown && !tx.running && weibar !== null;

  const submit = async () => {
    if (!canSend || !cfg.shareToken || weibar === null || minShares === null) return;
    const queue: RunnableStep[] = [];
    if (needsAssoc) queue.push(tx.associateStep(cfg.shareToken, "assoc-share"));
    queue.push({
      id: "deposit",
      send: () =>
        tx.call(
          { address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "deposit", args: [minShares], value: weibar },
          GAS_FLOOR.deposit,
        ),
    });
    if (await tx.run(queue)) setAmount("");
  };

  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-2">
        <span className="flex items-baseline justify-between text-sm font-medium">
          Amount
          <span className="text-xs font-normal text-base-content/70">
            Wallet{" "}
            <span className="font-mono tabular-nums">
              {walletBalance !== undefined ? `${fmtUnits(walletBalance, 18, 4)} HBAR` : "n/a"}
            </span>
          </span>
        </span>
        <div className="join w-full">
          <input
            inputMode="decimal"
            className="input join-item w-full font-mono tabular-nums"
            placeholder="0.0"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            aria-invalid={!!amount && tiny === null}
          />
          <button
            type="button"
            className="btn join-item"
            disabled={maxTiny === 0n}
            onClick={() => setAmount(formatUnits(maxTiny, 8))}
          >
            Max
          </button>
          <span className="join-item grid place-items-center border border-base-300 px-3 text-sm">HBAR</span>
        </div>
      </label>

      <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
        <dt className="text-base-content/70">Estimated shares</dt>
        <dd className="m-0 text-right font-mono tabular-nums">
          {estShares !== null ? `${fmtUnits(estShares, SHARE_DECIMALS, 4)} ${cfg.shareSymbol ?? ""}` : "n/a"}
        </dd>
        <dt className="text-base-content/70">Minimum shares</dt>
        <dd className="m-0 text-right font-mono tabular-nums">
          {minShares !== null ? `${fmtUnits(minShares, SHARE_DECIMALS, 4)} ${cfg.shareSymbol ?? ""}` : "n/a"}
        </dd>
        <dt className="text-base-content/70">Deposit value</dt>
        <dd className="m-0 text-right font-mono tabular-nums">{usd !== undefined ? fmtUsd(usd) : "n/a"}</dd>
        <dt className="flex items-center gap-2 text-base-content/70">Slippage</dt>
        <dd className="m-0 flex justify-end gap-1">
          {SLIPPAGE_CHOICES.map(bps => (
            <button
              key={bps}
              type="button"
              className={`btn btn-xs ${slippageBps === bps ? "btn-primary" : "btn-ghost border border-base-300"}`}
              aria-pressed={slippageBps === bps}
              onClick={() => setSlippageBps(bps)}
            >
              {bps / 100}%
            </button>
          ))}
        </dd>
      </dl>

      <p className="m-0 text-xs text-base-content/70">
        {firstDeposit
          ? `This is the first deposit. It sets the share price at 1 share per HBAR of value, and ${fmtUnits(cfg.deadShares, SHARE_DECIMALS, 5)} shares stay locked in the vault as dead shares so nobody can own the whole supply.`
          : "Estimate is value divided by share price. Pool fees and your own price impact come out of your shares, and the minimum reverts the deposit if they cost more than the slippage you allow."}
      </p>

      <AssociationWarning state={shareAssoc?.state} />
      {problem && amount && (
        <p className="m-0 text-sm text-error" role="alert">
          {problem}
        </p>
      )}
      {!amount && problem && <p className="m-0 text-sm text-warning">{problem}</p>}

      <TxSteps steps={steps} runs={tx.runs} />

      <WalletGate ready={ready}>
        <button type="button" className="btn btn-primary w-full" disabled={!canSend} onClick={submit}>
          {tx.running ? "Working" : needsAssoc ? "Associate and deposit" : "Deposit"}
        </button>
      </WalletGate>
    </div>
  );
}
