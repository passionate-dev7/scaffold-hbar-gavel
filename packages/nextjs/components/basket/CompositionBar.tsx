import type { Address } from "viem";
import { type Snapshot } from "~~/hooks/basket/useVault";
import { WHBAR_DECIMALS } from "~~/utils/basket/constants";
import { fmtPercentFromBps, fmtUnits, fmtUsd } from "~~/utils/basket/format";
import { hashscan } from "~~/utils/basket/hedera";

type Row = {
  index: number;
  symbol: string;
  token: Address;
  decimals: number;
  balance: bigint;
  valueWhbar: bigint;
  targetBps: number;
  /** Share of NAV, percent, four places. */
  actualPct: number;
  driftBps: number;
  outside: boolean;
};

/** Below lg each table row becomes a card, and every cell prints its own column name from data-label. */
const CELL =
  "[&>td]:p-0 [&>td[data-label]]:before:mb-1 [&>td[data-label]]:before:block [&>td[data-label]]:before:text-xs [&>td[data-label]]:before:font-medium [&>td[data-label]]:before:text-base-content/70 [&>td[data-label]]:before:content-[attr(data-label)] lg:[&>td]:px-3 lg:[&>td]:py-2 lg:[&>td[data-label]]:before:hidden";

const segColor = (index: number) => `var(--seg-${index % 5})`;

/** Rows in holdings() order: WHBAR first, then the legs. Drift is measured in basis points of NAV, as the contract does. */
export function buildRows({ cfg, lv }: Pick<Snapshot, "cfg" | "lv">): Row[] {
  return lv.holdings.map((h, index) => {
    const meta = cfg.tokens[index];
    const actualPct = lv.nav > 0n ? Number((h.valueWhbar * 1_000_000n) / lv.nav) / 10_000 : 0;
    const driftBps = lv.nav > 0n ? Math.round(actualPct * 100) - h.targetBps : 0;
    return {
      index,
      symbol: meta.symbol,
      token: meta.address,
      decimals: meta.decimals,
      balance: h.balance,
      valueWhbar: h.valueWhbar,
      targetBps: h.targetBps,
      actualPct,
      driftBps,
      outside: index > 0 && Math.abs(driftBps) > cfg.driftBps,
    };
  });
}

const cumulative = (values: number[]) => values.map((_, i) => values.slice(0, i).reduce((a, b) => a + b, 0));

function Bar({ label, values, rows, hollow }: { label: string; values: number[]; rows: Row[]; hollow?: string }) {
  const summary = rows.map((r, i) => `${r.symbol} ${values[i].toFixed(1)}%`).join(", ");
  return (
    <div className="grid grid-cols-[4.5rem_1fr] items-center gap-4">
      <span className="text-xs font-medium text-base-content/70">{label}</span>
      {hollow ? (
        <div className="flex h-10 items-center rounded-md border border-dashed border-base-content/30 px-3 text-sm text-base-content/70">
          {hollow}
        </div>
      ) : (
        <div className="flex h-10 gap-px overflow-hidden rounded-md" role="img" aria-label={`${label}: ${summary}`}>
          {rows.map((r, i) => (
            <div
              key={r.token}
              title={`${r.symbol} ${values[i].toFixed(2)}%`}
              className="flex min-w-0 items-center overflow-hidden px-2 text-xs font-medium"
              style={{ width: `${values[i]}%`, background: segColor(r.index), color: "var(--seg-ink)" }}
            >
              {values[i] >= 12 && (
                <span className="truncate">
                  {r.symbol} {values[i].toFixed(1)}%
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ribbons from each target segment to the same token's actual segment: where the lines lean, the basket has drifted. */
function Ribbons({ rows, target, actual }: { rows: Row[]; target: number[]; actual: number[] }) {
  const t0 = cumulative(target);
  const a0 = cumulative(actual);
  return (
    <div className="grid grid-cols-[4.5rem_1fr] gap-4" aria-hidden>
      <span />
      <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="block h-12 w-full">
        {rows.map((r, i) => (
          <g key={r.token}>
            <polygon
              points={`${t0[i]},0 ${t0[i] + target[i]},0 ${a0[i] + actual[i]},10 ${a0[i]},10`}
              fill={segColor(r.index)}
              fillOpacity={r.outside ? 0.42 : 0.22}
            />
            <line
              x1={t0[i]}
              y1={0}
              x2={a0[i]}
              y2={10}
              stroke={segColor(r.index)}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}

function DriftGauge({ row, band }: { row: Row; band: number }) {
  const scale = band * 1.5;
  const at = 50 + 50 * Math.max(-1, Math.min(1, row.driftBps / scale));
  return (
    <div className="relative h-2 w-28 rounded-sm bg-base-300" role="presentation">
      <div className="absolute inset-y-0 rounded-sm bg-success/25" style={{ left: "16.67%", width: "66.67%" }} />
      <div className="absolute inset-y-[-2px] left-1/2 w-px bg-base-content/40" />
      <div
        className={`absolute top-1/2 h-3 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm ${
          row.outside ? "bg-error" : "bg-base-content"
        }`}
        style={{ left: `${at}%` }}
      />
    </div>
  );
}

export function Composition({ snap }: { snap: Snapshot }) {
  const { cfg, lv } = snap;
  const rows = buildRows(snap);
  const empty = lv.nav === 0n;
  const target = rows.map(r => r.targetBps / 100);
  const actual = rows.map(r => r.actualPct);
  const legs = rows.slice(1);
  const worst = legs.reduce<Row | undefined>(
    (w, r) => (!w || Math.abs(r.driftBps) > Math.abs(w.driftBps) ? r : w),
    undefined,
  );
  const bandText = `${fmtPercentFromBps(cfg.driftBps)} of NAV`;

  return (
    <section aria-labelledby="composition-title" className="rounded-box border border-base-300 bg-base-100 p-6 lg:p-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h2 id="composition-title" className="m-0 text-xl font-semibold">
            Target against actual
          </h2>
          <p className="m-0 mt-1 max-w-xl text-sm text-base-content/70">
            The vault trades a token back to target once it sits more than {bandText} away from its weight.
          </p>
        </div>
        {!empty && worst && (
          <p
            className={`m-0 text-sm tabular-nums ${worst.outside ? "font-medium text-error" : "text-base-content/70"}`}
            role="status"
          >
            {worst.outside
              ? `${worst.symbol} is ${worst.driftBps > 0 ? "over" : "under"} target by ${Math.abs(worst.driftBps)} bps, outside the band. A rebalance trades it back.`
              : `Widest drift: ${worst.symbol} ${worst.driftBps > 0 ? "+" : ""}${worst.driftBps} bps, inside the ${cfg.driftBps} bps band.`}
          </p>
        )}
      </div>

      <div className="mt-8 flex flex-col">
        <Bar label="Target" values={target} rows={rows} />
        {empty ? <div className="h-8" /> : <Ribbons rows={rows} target={target} actual={actual} />}
        <Bar
          label="Actual"
          values={actual}
          rows={rows}
          hollow={
            empty ? "The vault holds nothing yet. The first deposit buys the basket at target weights." : undefined
          }
        />
      </div>

      <div className="mt-8">
        <table className="table table-sm w-full max-lg:block">
          <thead className="hidden lg:table-header-group">
            <tr className="text-xs text-base-content/70">
              <th className="font-medium">Token</th>
              <th className="text-right font-medium">Balance</th>
              <th className="text-right font-medium">Value (WHBAR)</th>
              <th className="text-right font-medium">Target</th>
              <th className="text-right font-medium">Actual</th>
              <th className="font-medium">Drift against ±{cfg.driftBps} bps</th>
            </tr>
          </thead>
          <tbody className="block tabular-nums lg:table-row-group">
            {rows.map(r => (
              <tr
                key={r.token}
                className={`${CELL} grid grid-cols-2 gap-x-4 gap-y-3 border-b border-base-300 py-4 last:border-b-0 sm:grid-cols-4 lg:table-row lg:py-0`}
              >
                <td className="col-span-full lg:table-cell">
                  <a
                    className="link-hover inline-flex min-h-8 items-center gap-2 font-medium"
                    href={hashscan.token(r.token)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="h-3 w-3 rounded-sm" style={{ background: segColor(r.index) }} aria-hidden />
                    {r.symbol}
                  </a>
                </td>
                <td data-label={`Balance (${r.symbol})`} className="font-mono lg:text-right">
                  {fmtUnits(r.balance, r.decimals, 4)}
                </td>
                <td data-label="Value (WHBAR)" className="font-mono lg:text-right">
                  {fmtUnits(r.valueWhbar, WHBAR_DECIMALS, 4)}
                  {lv.hbarUsd !== undefined && (
                    <div className="text-xs text-base-content/70">
                      {fmtUsd((r.valueWhbar * lv.hbarUsd) / 10n ** 8n)}
                    </div>
                  )}
                </td>
                <td data-label="Target" className="font-mono lg:text-right">
                  {(r.targetBps / 100).toFixed(2)}%
                </td>
                <td data-label="Actual" className="font-mono lg:text-right">
                  {empty ? "n/a" : `${r.actualPct.toFixed(2)}%`}
                </td>
                <td
                  data-label={`Drift against ±${cfg.driftBps} bps`}
                  className="col-span-full sm:col-span-2 lg:table-cell"
                >
                  {empty ? (
                    <span className="text-base-content/70">n/a</span>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <DriftGauge row={r} band={cfg.driftBps} />
                      <span className={`font-mono text-xs ${r.outside ? "font-medium text-error" : ""}`}>
                        {r.driftBps > 0 ? "+" : ""}
                        {r.driftBps} bps
                      </span>
                      {r.index === 0 && <span className="text-xs text-base-content/70">residual</span>}
                      {r.outside && <span className="text-xs font-medium text-error">outside band</span>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
