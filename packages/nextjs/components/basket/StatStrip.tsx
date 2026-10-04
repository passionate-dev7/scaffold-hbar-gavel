import { useNow } from "~~/hooks/basket/useNow";
import type { Snapshot } from "~~/hooks/basket/useVault";
import { SHARE_DECIMALS, WHBAR_DECIMALS } from "~~/utils/basket/constants";
import { fmtAgo, fmtDuration, fmtUnits, fmtUsd } from "~~/utils/basket/format";

const Stat = ({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  tone?: "error";
}) => (
  <div className="bg-base-100 p-5">
    <dt className="text-xs font-medium text-base-content/70">{label}</dt>
    <dd className="m-0 mt-2 font-mono text-2xl tabular-nums leading-none">{value}</dd>
    <dd className={`m-0 mt-2 text-xs ${tone === "error" ? "text-error" : "text-base-content/70"}`}>{sub}</dd>
  </div>
);

export function StatStrip({ snap }: { snap: Snapshot }) {
  const { vault, cfg, lv } = snap;
  const now = useNow(5000);
  const mine = vault.shares.data?.balance;
  const owned = mine !== undefined && lv.supply > 0n ? Number((mine * 10_000n) / lv.supply) / 100 : undefined;
  const age = lv.feed && now !== null ? Math.max(0, now - lv.feed.updatedAt) : undefined;
  const stale = lv.hbarUsd === undefined;

  return (
    <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-box border border-base-300 bg-base-300 lg:grid-cols-4">
      <Stat
        label="Net asset value"
        value={`${fmtUnits(lv.nav, WHBAR_DECIMALS, 4)} HBAR`}
        sub={lv.navUsd !== undefined ? fmtUsd(lv.navUsd) : "USD value waits for a fresh Chainlink answer"}
      />
      <Stat
        label="Share price"
        value={lv.sharePriceUsd ? fmtUsd(lv.sharePriceUsd, 4) : lv.supply === 0n ? "No shares yet" : "Unavailable"}
        sub={
          lv.supply === 0n
            ? "The first deposit sets it at 1 share per HBAR of value"
            : `${fmtUnits(lv.supply, SHARE_DECIMALS, 4)} ${cfg.shareSymbol ?? "shares"} outstanding`
        }
      />
      <Stat
        label="HBAR / USD"
        value={lv.hbarUsd !== undefined ? fmtUsd(lv.hbarUsd, 4) : lv.feed ? fmtUsd(lv.feed.answer, 4) : "Unreadable"}
        tone={stale ? "error" : undefined}
        sub={
          stale
            ? `Chainlink answer is older than ${fmtDuration(cfg.maxOracleAge)}. Deposits and rebalances wait.`
            : age !== undefined
              ? `Chainlink, updated ${fmtAgo(age)}`
              : "Chainlink"
        }
      />
      <Stat
        label="Your shares"
        value={mine !== undefined ? `${fmtUnits(mine, SHARE_DECIMALS, 4)} ${cfg.shareSymbol ?? ""}`.trim() : "n/a"}
        sub={
          mine === undefined
            ? vault.shares.isLoading
              ? "Reading your balance"
              : "Connect a wallet to see your slice"
            : mine === 0n
              ? "You hold none yet"
              : `${lv.sharePriceUsd ? `${fmtUsd((mine * lv.sharePriceUsd) / 10n ** 8n)}, ` : ""}${owned?.toFixed(2)}% of supply`
        }
      />
    </dl>
  );
}
