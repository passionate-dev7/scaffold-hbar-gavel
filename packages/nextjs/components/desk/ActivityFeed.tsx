"use client";

import { useState } from "react";
import { useDeskEvents, useOrders } from "~~/hooks/desk/useDesk";
import { useNow } from "~~/hooks/desk/useNow";
import { fmtAgo, fmtDateTime, fmtEscrow, fmtToken, shortAddress } from "~~/utils/desk/format";
import { evmToEntityId, hashscan } from "~~/utils/desk/hedera";
import type { DeskEvent, DeskEventName } from "~~/utils/desk/mirror";

const COLLAPSED_ROWS = 10;

const KINDS: Record<DeskEventName, string> = {
  OrderPosted: "Posted",
  Filled: "Filled",
  FellBack: "Fell back",
  Refunded: "Refunded",
  Cancelled: "Cancelled",
  Rearmed: "Re-armed",
  Claimed: "Claimed",
};

type Orders = ReturnType<typeof useOrders>;

function describe(ev: DeskEvent, orders: Orders): React.ReactNode {
  const a = ev.args as Record<string, any>;
  const order = orders.find(o => o.id === a.id)?.order;
  const out = (amount: bigint) => (order ? fmtToken(amount, order.tokenOut, 6) : `${amount} raw units`);
  switch (ev.name) {
    case "OrderPosted":
      return (
        <>
          {shortAddress(a.taker)} sells {fmtEscrow(a.amountIn, a.tokenIn)} for at least{" "}
          {fmtToken(a.minOut, a.tokenOut, 6)}. Fallback booked for {fmtDateTime(Number(a.fallbackAt))},{" "}
          <a className="link" href={hashscan.schedule(a.schedule)} target="_blank" rel="noreferrer">
            schedule {evmToEntityId(a.schedule)}
          </a>
          .
        </>
      );
    case "Filled":
      return `Maker ${shortAddress(a.maker)} paid ${out(a.amountOut)} and took the escrow.`;
    case "FellBack":
      return `No quote filled it in time. The scheduled swap paid ${out(a.amountOut)}.`;
    case "Refunded":
      return `The fallback swap could not meet the floor, so the escrow went back to the taker.`;
    case "Cancelled":
      return "The taker cancelled and took the escrow back.";
    case "Rearmed":
      return (
        <>
          Fallback re-booked for {fmtDateTime(Number(a.fallbackAt))},{" "}
          <a className="link" href={hashscan.schedule(a.schedule)} target="_blank" rel="noreferrer">
            schedule {evmToEntityId(a.schedule)}
          </a>
          .
        </>
      );
    case "Claimed":
      return `The taker claimed ${order ? fmtEscrow(a.amount, order.tokenIn) : `${a.amount} raw units`} the refund could not deliver.`;
  }
}

export function ActivityFeed({ onSelect }: { onSelect: (id: bigint) => void }) {
  const events = useDeskEvents();
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  const ids = [...new Set((events.data ?? []).map(e => e.args.id as bigint))];
  const orders = useOrders(ids);
  const rows = expanded ? events.data : events.data?.slice(0, COLLAPSED_ROWS);

  return (
    <section aria-labelledby="activity-title">
      <div className="sec-h">
        <h2 id="activity-title">Desk activity</h2>
        <span className="sec-note">Decoded from the desk contract logs, refreshed every 15s</span>
      </div>

      {events.isLoading && <p className="m-0 mt-4 text-sm text-mute">Reading the desk logs from the mirror node</p>}
      {events.isError && (
        <p className="m-0 mt-4 text-sm text-bad" role="alert">
          Could not read the desk logs.{" "}
          <button type="button" className="link" onClick={() => void events.refetch()}>
            Retry
          </button>
        </p>
      )}
      {events.data && events.data.length === 0 && (
        <p className="m-0 mt-4 text-sm text-mute">The desk has not logged an event yet.</p>
      )}

      {rows && rows.length > 0 && (
        <ul className="m-0 list-none divide-y divide-hair p-0">
          {rows.map(ev => (
            <li key={ev.id} className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[7rem_9rem_1fr_auto] sm:items-baseline">
              <time
                className="text-xs tabular-nums text-mute"
                dateTime={new Date(ev.at * 1000).toISOString()}
                title={fmtDateTime(ev.at)}
              >
                {now === null ? "" : fmtAgo(Math.max(0, now - ev.at))}
              </time>
              <span className="flex items-baseline gap-2 text-xs font-bold">
                <button
                  type="button"
                  className="link text-xs"
                  onClick={() => onSelect(ev.args.id as bigint)}
                  aria-label={`Show order ${ev.args.id}`}
                >
                  #{String(ev.args.id)}
                </button>
                {KINDS[ev.name]}
              </span>
              <span className="text-sm">{describe(ev, orders)}</span>
              <a
                className="link -my-2 self-start py-2 text-xs sm:self-auto"
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
        <button type="button" className="act act-sm act-line mt-3" onClick={() => setExpanded(e => !e)}>
          {expanded ? "Show fewer" : `Show all ${events.data.length}`}
        </button>
      )}
    </section>
  );
}
