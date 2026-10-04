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
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="max-w-3xl">
        <h1 className="m-0 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Post a swap. Makers outbid the pool, or the network swaps for you.
        </h1>
        <p className="m-0 mt-3 text-base text-base-content/70">
          Your HBAR waits in escrow. Makers answer with signed quotes over Hedera Consensus Service, and you accept the
          best one. If none beats your floor, a swap scheduled on Hedera settles the order on SaucerSwap.
        </p>
      </header>

      <dl className="m-0 mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-box border border-base-300 bg-base-300 sm:grid-cols-4">
        {stats.map(s => (
          <div key={s.label} className="bg-base-100 px-4 py-3">
            <dt className="text-xs text-base-content/70">{s.label}</dt>
            <dd className="m-0 font-mono text-2xl tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 mt-2 text-xs text-base-content/70">Settlement counts cover the latest {ids.length} orders.</p>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <PostOrderPanel onPosted={select} />
        {shown !== undefined ? (
          <OrderBoard id={shown} />
        ) : (
          <section className="rounded-box border border-base-300 bg-base-100 p-5 sm:p-6" aria-busy={params.isLoading}>
            <h2 className="m-0 text-xl font-semibold">Quote board</h2>
            <p className="m-0 mt-2 text-sm text-base-content/70">
              {params.isLoading
                ? "Reading the desk"
                : "Post an order and the quotes makers sign for it appear here, best first."}
            </p>
          </section>
        )}
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <OrdersList
          rows={orders}
          loading={params.isLoading || orders.some(o => !o.order && !o.error)}
          selected={shown}
          onSelect={select}
        />
        <ActivityFeed onSelect={select} />
      </div>
    </div>
  );
}
