import { useState } from "react";
import { type Hex, decodeErrorResult } from "viem";
import { useNow } from "~~/hooks/basket/useNow";
import type { Snapshot } from "~~/hooks/basket/useVault";
import { useVaultEvents } from "~~/hooks/basket/useVaultEvents";
import { SHARE_DECIMALS, VAULT_ABI, WHBAR_DECIMALS } from "~~/utils/basket/constants";
import { fmtAgo, fmtDateTime, fmtDuration, fmtUnits, shortAddress } from "~~/utils/basket/format";
import { evmToEntityId, hashscan } from "~~/utils/basket/hedera";
import type { VaultEvent } from "~~/utils/basket/mirror";

type Args = Record<string, any>;

const COLLAPSED_ROWS = 10;

const FAILURES = new Set(["ScheduledRunFailed", "BookingFailed"]);

/** What kind of event a row is, in words. Every event in the vault ABI has one; an unknown name falls back to spaced words. */
const KINDS: Record<string, string> = {
  Deposited: "Deposit",
  Redeemed: "Redeem",
  LegsSkipped: "Token skipped",
  ScheduleDeleted: "Schedule deleted",
  Swapped: "Swap",
  Rebalanced: "Rebalance",
  RunBooked: "Run booked",
  ScheduledRun: "Scheduled run",
  ScheduledRunFailed: "Run failed",
  BookingFailed: "Booking failed",
  AutomationStarted: "Automation on",
  AutomationStopped: "Automation off",
  Initialized: "Share token",
  OwnershipTransferred: "Ownership",
};

const kindOf = (name: string) => KINDS[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");

function revertText(reason: Hex): string {
  try {
    return decodeErrorResult({ abi: VAULT_ABI, data: reason }).errorName;
  } catch {
    return reason.length > 10 ? `${reason.slice(0, 10)}…` : "no revert data";
  }
}

function describe(ev: VaultEvent, snap: Snapshot): React.ReactNode {
  const a = ev.args as Args;
  const { tokens } = snap.cfg;
  const share = snap.cfg.shareSymbol ?? "shares";
  const bySymbol = new Map(tokens.map(t => [t.address.toLowerCase(), t]));
  const tok = (address: string, amount: bigint) => {
    const t = bySymbol.get(address.toLowerCase());
    return t ? `${fmtUnits(amount, t.decimals, 4)} ${t.symbol}` : `${amount} of ${shortAddress(address)}`;
  };

  switch (ev.name) {
    case "Deposited":
      return `${shortAddress(a.account)} deposited ${fmtUnits(a.hbarIn, 8, 4)} HBAR and received ${fmtUnits(a.shares, SHARE_DECIMALS, 4)} ${share}`;
    case "Redeemed": {
      const parts = [
        `${fmtUnits(a.whbarOut, WHBAR_DECIMALS, 4)} ${tokens[0]?.symbol ?? "WHBAR"}`,
        ...(a.legAmounts as bigint[]).map((amount, i) =>
          tokens[i + 1] ? `${fmtUnits(amount, tokens[i + 1].decimals, 4)} ${tokens[i + 1].symbol}` : `${amount}`,
        ),
      ];
      return `${shortAddress(a.account)} redeemed ${fmtUnits(a.shares, SHARE_DECIMALS, 4)} ${share} for ${parts.join(", ")}`;
    }
    case "LegsSkipped": {
      const names = tokens
        .slice(1)
        .filter((_, i) => (BigInt(a.skipLegsMask) >> BigInt(i)) & 1n)
        .map(t => t.symbol);
      return `${shortAddress(a.account)} skipped ${names.length ? names.join(", ") : "a token"} in a redemption. That share stays in the vault for the remaining holders.`;
    }
    case "ScheduleDeleted": {
      const code = Number(a.responseCode);
      const outcome =
        code === 22
          ? "The pending run was cancelled."
          : [201, 212, 213].includes(code)
            ? "The schedule had already run, expired or been deleted."
            : `Hedera answered with response code ${code}.`;
      return (
        <>
          Schedule{" "}
          <a
            className="link link-primary -my-2 inline-block py-2"
            href={hashscan.schedule(a.schedule)}
            target="_blank"
            rel="noreferrer"
          >
            {evmToEntityId(a.schedule)}
          </a>{" "}
          removed when automation stopped. {outcome}
        </>
      );
    }
    case "Swapped":
      return `Swapped ${tok(a.tokenIn, a.amountIn)} for ${tok(a.tokenOut, a.amountOut)}`;
    case "Rebalanced":
      return `NAV ${fmtUnits(a.navBefore, WHBAR_DECIMALS, 4)} to ${fmtUnits(a.navAfter, WHBAR_DECIMALS, 4)} HBAR. ${a.traded ? "Traded back to target." : "Nothing had drifted past the band."}`;
    case "RunBooked":
      return (
        <>
          Booked the next rebalance for {fmtDateTime(Number(a.expiry))} on schedule{" "}
          <a
            className="link link-primary -my-2 inline-block py-2"
            href={hashscan.schedule(a.schedule)}
            target="_blank"
            rel="noreferrer"
          >
            {evmToEntityId(a.schedule)}
          </a>
        </>
      );
    case "ScheduledRun":
      return a.traded
        ? "Scheduled rebalance ran and traded."
        : "Scheduled rebalance ran. Nothing had drifted past the band.";
    case "ScheduledRunFailed":
      return `Scheduled rebalance failed: ${revertText(a.reason)}. The next run is still booked.`;
    case "BookingFailed":
      return `Booking the next run failed with Hedera response code ${a.responseCode}.`;
    case "AutomationStarted":
      return `Automation started, one rebalance every ${fmtDuration(Number(a.interval))}.`;
    case "AutomationStopped":
      return "Automation stopped and the pending schedule was deleted.";
    case "Initialized":
      return "Share token created.";
    case "OwnershipTransferred":
      return BigInt(a.previousOwner) === 0n
        ? `Vault deployed, owner ${shortAddress(a.newOwner)}.`
        : `Ownership moved from ${shortAddress(a.previousOwner)} to ${shortAddress(a.newOwner)}.`;
    default:
      return ev.name;
  }
}

export function ActivityFeed({ snap }: { snap: Snapshot }) {
  const events = useVaultEvents();
  const now = useNow(10_000);
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? events.data : events.data?.slice(0, COLLAPSED_ROWS);

  return (
    <section className="rounded-box border border-base-300 bg-base-100 p-6 lg:p-8" aria-labelledby="activity-title">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="activity-title" className="m-0 text-xl font-semibold">
          Activity
        </h2>
        <span className="text-xs text-base-content/70">Decoded from the Hedera mirror node, refreshed every 15s</span>
      </div>

      {events.isLoading && <p className="m-0 mt-6 text-sm text-base-content/70">Reading the vault logs.</p>}
      {events.isError && (
        <p className="m-0 mt-6 text-sm text-error" role="alert">
          The mirror node did not answer.{" "}
          <button type="button" className="link" onClick={() => events.refetch()}>
            Retry
          </button>
        </p>
      )}
      {events.data && events.data.length === 0 && (
        <p className="m-0 mt-6 text-sm text-base-content/70">
          No deposits yet. The first deposit sets the share price at 1 share per HBAR of value.
        </p>
      )}
      {events.data && events.data.length > 0 && (
        <ul className="m-0 mt-4 list-none divide-y divide-base-300 p-0">
          {rows?.map(ev => (
            <li key={ev.id} className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[6rem_9rem_1fr_auto] sm:items-baseline">
              <div className="flex items-baseline gap-3 sm:contents">
                <time
                  className="font-mono text-xs tabular-nums text-base-content/70"
                  dateTime={new Date(ev.at * 1000).toISOString()}
                  title={fmtDateTime(ev.at)}
                >
                  {now === null ? "" : fmtAgo(Math.max(0, now - ev.at))}
                </time>
                <span
                  className={`text-xs font-medium ${FAILURES.has(ev.name) ? "text-error" : "text-base-content/70"}`}
                >
                  {kindOf(ev.name)}
                </span>
              </div>
              <span className={`text-sm ${FAILURES.has(ev.name) ? "text-error" : ""}`}>{describe(ev, snap)}</span>
              <a
                className="link link-primary -my-2 self-start py-2 text-xs sm:self-auto"
                href={hashscan.tx(ev.hash)}
                target="_blank"
                rel="noreferrer"
              >
                HashScan
              </a>
            </li>
          ))}
        </ul>
      )}
      {events.data && events.data.length > COLLAPSED_ROWS && (
        <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => setExpanded(e => !e)}>
          {expanded ? "Show the latest 10" : `Show all ${events.data.length} events`}
        </button>
      )}
    </section>
  );
}
