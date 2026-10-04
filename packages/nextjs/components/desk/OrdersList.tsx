"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { OrderActions } from "~~/components/desk/OrderActions";
import type { Order } from "~~/hooks/desk/useDesk";
import { useNow } from "~~/hooks/desk/useNow";
import { STATUS } from "~~/utils/desk/constants";
import { fmtDateTime, fmtEscrow, fmtToken } from "~~/utils/desk/format";

export type OrderRow = { id: bigint; order: Order | undefined };

const STATUS_TONE = ["text-primary", "text-success", "text-success", "text-base-content/70", "text-warning"];

export function OrdersList({
  rows,
  loading,
  selected,
  onSelect,
}: {
  rows: OrderRow[];
  loading: boolean;
  selected: bigint | undefined;
  onSelect: (id: bigint) => void;
}) {
  const { address } = useAccount();
  const now = useNow();
  const [scope, setScope] = useState<"mine" | "all">("all");
  const effective = address ? scope : "all";
  const visible = rows.filter(
    ({ order }) => order && (effective === "all" || order.taker.toLowerCase() === address?.toLowerCase()),
  );

  return (
    <section className="rounded-box border border-base-300 bg-base-100 p-5 sm:p-6" aria-labelledby="orders-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="orders-title" className="m-0 text-xl font-semibold">
          Orders
        </h2>
        <div className="join" role="group" aria-label="Which orders">
          {(["mine", "all"] as const).map(s => (
            <button
              key={s}
              type="button"
              className={`btn btn-sm join-item ${effective === s ? "btn-primary" : "btn-outline"}`}
              aria-pressed={effective === s}
              disabled={s === "mine" && !address}
              onClick={() => setScope(s)}
            >
              {s === "mine" ? "Mine" : "All recent"}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="m-0 mt-4 text-sm text-base-content/70">Reading orders from the desk</p>}
      {!loading && visible.length === 0 && (
        <p className="m-0 mt-4 text-sm text-base-content/70">
          {effective === "mine"
            ? "You have not posted an order yet. Post one and it appears here."
            : "The desk has no orders yet."}
        </p>
      )}

      <ul className="m-0 mt-3 list-none divide-y divide-base-300 p-0">
        {visible.map(({ id, order }) => {
          if (!order) return null;
          const expired = now !== null && order.status === 0 && Number(order.expiry) <= now;
          return (
            <li key={id.toString()} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <button
                type="button"
                className="min-w-0 grow cursor-pointer border-0 bg-transparent p-0 text-left"
                aria-current={selected === id}
                onClick={() => onSelect(id)}
              >
                <span className={`block text-sm ${selected === id ? "font-semibold text-primary" : "font-medium"}`}>
                  #{id.toString()} {fmtEscrow(order.amountIn, order.tokenIn)} for at least{" "}
                  <span className="font-mono tabular-nums">{fmtToken(order.minOut, order.tokenOut, 6)}</span>
                </span>
                <span className="block text-xs text-base-content/70">
                  <span className={`font-medium ${STATUS_TONE[order.status]}`}>
                    {expired ? "Open, fallback due" : STATUS[order.status]}
                  </span>{" "}
                  <span aria-hidden>·</span> expiry {fmtDateTime(Number(order.expiry))}
                </span>
              </button>
              <OrderActions id={id} order={order} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
