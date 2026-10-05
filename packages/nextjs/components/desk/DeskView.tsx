"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ActivityFeed } from "~~/components/desk/ActivityFeed";
import { OrderBoard } from "~~/components/desk/OrderBoard";
import { OrdersList } from "~~/components/desk/OrdersList";
import { PostOrderPanel } from "~~/components/desk/PostOrderPanel";
import { recentIds, useDeskParams, useOrders } from "~~/hooks/desk/useDesk";

function readOrderParam(): bigint | undefined {
  const raw = new URLSearchParams(window.location.search).get("order");
  return raw && /^\d{1,18}$/.test(raw) ? BigInt(raw) : undefined;
}

export function DeskView() {
  const { address } = useAccount();
  const params = useDeskParams();
  const ids = recentIds(params.data?.orderCount);
  const orders = useOrders(ids);
  const [selected, setSelected] = useState<bigint | undefined>();
  const [urlRead, setUrlRead] = useState(false);

  useEffect(() => {
    setSelected(readOrderParam());
    setUrlRead(true);
  }, []);

  const select = useCallback((id: bigint) => {
    setSelected(id);
    window.history.replaceState(null, "", `?order=${id}`);
  }, []);

  // With nothing chosen, show the taker's newest open order, else their newest, else the desk's newest.
  const fallbackId = (() => {
    const mine = orders.filter(o => o.order && address && o.order.taker.toLowerCase() === address.toLowerCase());
    return (mine.find(o => o.order?.status === 0) ?? mine[0] ?? orders[0])?.id;
  })();
  const shown = selected ?? (urlRead ? fallbackId : undefined);

  const loaded = orders.filter(o => o.order);
  const count = (status: number) => loaded.filter(o => o.order!.status === status).length;
  const stats = [
    { label: "Orders posted", value: params.data ? params.data.orderCount.toString() : "-" },
    { label: "Filled by makers", value: loaded.length ? String(count(1)) : "-" },
    { label: "Settled by fallback", value: loaded.length ? String(count(2)) : "-" },
    { label: "Open now", value: loaded.length ? String(count(0)) : "-" },
  ];

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
      <header className="pb-6 pt-8 sm:pt-10">
        <h1 className="m-0 max-w-[46ch] text-[1.375rem] font-bold leading-snug sm:text-[1.75rem] sm:leading-[1.4]">
          Post a swap. Makers outbid the pool, or the network swaps for you.
        </h1>
        <p className="m-0 mt-3 max-w-[80ch] text-sm text-sub">
          Your HBAR waits in escrow. Makers answer with signed quotes over Hedera Consensus Service, and you accept the
          best one. If none beats your floor, a swap scheduled on Hedera settles the order on SaucerSwap.{" "}
          <a className="link" href="#post">
            Post an order
          </a>
        </p>
      </header>

      <dl
        className="m-0 grid grid-cols-2 border-y border-hair sm:grid-cols-4"
        aria-label={`Settlement counts over the latest ${ids.length} orders`}
      >
        {stats.map((s, i) => (
          <div
            key={s.label}
            className={`py-3 pl-0 sm:pl-4 ${i % 2 === 1 ? "border-l pl-4" : ""} ${i > 1 ? "border-t" : ""} sm:border-t-0 ${i === 0 ? "sm:pl-0" : "sm:border-l"}`}
          >
            <dt className="text-xs text-mute">{s.label}</dt>
            <dd className="m-0 text-xl font-bold tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 mt-2 text-xs text-mute">Settlement counts cover the latest {ids.length} orders.</p>

      <div className="mt-8">
        {shown !== undefined ? (
          <OrderBoard id={shown} />
        ) : (
          <section className="tui px-6 py-12 sm:px-8" aria-busy={params.isLoading} aria-labelledby="board-idle">
            <h2 id="board-idle" className="m-0 text-base font-bold">
              Quote board
            </h2>
            <p className="m-0 mt-2 max-w-[60ch] text-sm text-sub">
              {params.isLoading
                ? "Reading the desk"
                : "Post an order and the quotes makers sign for it appear here, best first."}
            </p>
          </section>
        )}
      </div>

      <div className="mt-16 grid items-start gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
        <PostOrderPanel onPosted={select} />
        <div className="flex min-w-0 flex-col gap-12">
          <OrdersList
            rows={orders}
            loading={params.isLoading || orders.some(o => !o.order && !o.error)}
            selected={shown}
            onSelect={select}
          />
          <ActivityFeed onSelect={select} />
        </div>
      </div>
    </div>
  );
}
