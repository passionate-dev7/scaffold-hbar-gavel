"use client";

import { useMemo } from "react";
import { type Address, zeroAddress } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { OrderActions } from "~~/components/desk/OrderActions";
import { TxSteps } from "~~/components/desk/TxSteps";
import { WalletGate } from "~~/components/desk/WalletGate";
import {
  type BoardQuote,
  type Order,
  useDeskEvents,
  useDeskParams,
  useOrders,
  usePoolSpot,
  useQuoteBoard,
  useSchedule,
} from "~~/hooks/desk/useDesk";
import { useNow } from "~~/hooks/desk/useNow";
import { useTx, useWalletReady } from "~~/hooks/desk/useTx";
import { CHAIN_ID, DESK_ABI, DESK_ADDRESS, GAS_FLOOR, QUOTE_TOPIC_ID, STATUS, tokenOf } from "~~/utils/desk/constants";
import { fmtDateTime, fmtDuration, fmtEscrow, fmtSignedBps, fmtToken, shortAddress } from "~~/utils/desk/format";
import { evmToEntityId, hashscan } from "~~/utils/desk/hedera";
import { spotOut } from "~~/utils/desk/pool";
import { type Verdict, assessQuote, bpsOver, sortQuotes } from "~~/utils/desk/quotes";

const MAX_ROWS = 12;

const STATUS_LABEL: Record<(typeof STATUS)[number], string> = {
  Open: "Open",
  Filled: "Filled by a maker",
  FellBack: "Settled by the fallback swap",
  Cancelled: "Cancelled",
  Refunded: "Refunded",
};

const STATUS_TONE = ["text-primary", "text-success", "text-success", "text-base-content/70", "text-warning"];

const VERDICT_TEXT: Record<Verdict, string> = {
  live: "Signature verified, ready to accept",
  "bad-signature": "Signature does not match the maker",
  "nonce-spent": "Already used or cancelled by its maker",
  expired: "Deadline passed",
  "below-min": "Pays less than the floor",
  "outside-band": "Below the Chainlink band the desk enforces",
  unfunded: "Maker lacks the balance or approval to pay it",
};

const secondsOf = (timestamp: string) => Number(timestamp.split(".")[0]);

export function OrderBoard({ id }: { id: bigint }) {
  const now = useNow();
  const params = useDeskParams();
  const [{ order, error: orderError }] = useOrders([id]);
  const events = useDeskEvents();
  // The desk clears an order's schedule when it settles; the OrderPosted log still names it.
  const posted = events.data?.find(e => e.name === "OrderPosted" && e.args.id === id);
  const scheduleAddress =
    order && order.schedule !== zeroAddress ? order.schedule : (posted?.args.schedule as Address | undefined);
  const schedule = useSchedule(scheduleAddress);
  const board = useQuoteBoard(id, order, params.data?.quoteDomain);
  const spot = usePoolSpot(
    order && { tokenIn: order.tokenIn, tokenOut: order.tokenOut, fee: order.fee },
    params.data?.factory,
  );

  if (orderError) {
    return (
      <section className="rounded-box border border-base-300 bg-base-100 p-5 sm:p-6">
        <p className="m-0 text-sm text-error" role="alert">
          Order #{id.toString()} could not be read from the desk.
        </p>
      </section>
    );
  }
  if (!order || order.taker === "0x0000000000000000000000000000000000000000") {
    return (
      <section className="rounded-box border border-base-300 bg-base-100 p-5 sm:p-6" aria-busy={!order}>
        <p className="m-0 text-sm text-base-content/70">
          {order ? `The desk has no order #${id.toString()}.` : `Reading order #${id.toString()}`}
        </p>
      </section>
    );
  }

  const settled = events.data?.find(
    e =>
      e.args.id === id &&
      (e.name === "Filled" || e.name === "FellBack" || e.name === "Refunded" || e.name === "Cancelled"),
  );
  const poolOut = spot.data ? spotOut(spot.data.sqrtPriceX96, spot.data.tokenInIsToken0, order.amountIn) : undefined;
  const fellBackAmount = settled?.name === "FellBack" ? (settled.args.amountOut as bigint) : undefined;
  const fallbackRef =
    order.status === 0 && poolOut !== undefined
      ? { amount: poolOut, label: "vs pool spot" }
      : fellBackAmount !== undefined
        ? { amount: fellBackAmount, label: "vs fallback payout" }
        : null;

  return (
    <section className="rounded-box border border-base-300 bg-base-100 p-5 sm:p-6" aria-labelledby="board-title">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h2 id="board-title" className="m-0 text-xl font-semibold">
            Order #{id.toString()}{" "}
            <span className={`text-base font-medium ${STATUS_TONE[order.status]}`}>
              {STATUS_LABEL[STATUS[order.status]]}
            </span>
          </h2>
          <p className="m-0 mt-1 text-sm">
            <span className="font-mono tabular-nums">{fmtEscrow(order.amountIn, order.tokenIn)}</span> for at least{" "}
            <span className="font-mono tabular-nums">{fmtToken(order.minOut, order.tokenOut, 6)}</span>
          </p>
          <p className="m-0 mt-1 text-xs text-base-content/70">
            Taker{" "}
            <a className="link" href={hashscan.account(order.taker)} target="_blank" rel="noreferrer">
              {shortAddress(order.taker)}
            </a>
            {settled && (
              <>
                {" "}
                <span aria-hidden>·</span>{" "}
                <a className="link" href={hashscan.tx(settled.hash)} target="_blank" rel="noreferrer">
                  {STATUS[order.status]} on HashScan
                </a>
              </>
            )}
          </p>
        </div>
        <OrderActions id={id} order={order} />
      </div>

      <FallbackClock
        order={order}
        now={now}
        scheduleAddress={scheduleAddress}
        schedule={schedule.data}
        scheduleError={schedule.isError}
      />

      <Ladder
        id={id}
        order={order}
        now={now}
        board={board}
        fallbackRef={fallbackRef}
        settledMaker={settled?.name === "Filled" ? (settled.args.maker as string) : undefined}
        settledAmount={settled?.name === "Filled" ? (settled.args.amountOut as bigint) : undefined}
      />
    </section>
  );
}

function FallbackClock({
  order,
  now,
  scheduleAddress,
  schedule,
  scheduleError,
}: {
  order: Order;
  now: number | null;
  scheduleAddress: Address | undefined;
  schedule: ReturnType<typeof useSchedule>["data"];
  scheduleError: boolean;
}) {
  const open = order.status === 0;
  const quotesCloseAt = Number(order.expiry);
  const fallbackAt = schedule?.expiration_time ? secondsOf(schedule.expiration_time) : null;
  const scheduleLink = scheduleAddress ? (
    <a className="link" href={hashscan.schedule(scheduleAddress!)} target="_blank" rel="noreferrer">
      Schedule {evmToEntityId(scheduleAddress!)} on HashScan
    </a>
  ) : null;

  if (!open) {
    const ran = schedule?.executed_timestamp ? `Ran at ${fmtDateTime(secondsOf(schedule.executed_timestamp))}.` : null;
    return (
      <div className="mt-5 border-t border-base-300 pt-4 text-sm text-base-content/70">
        {scheduleAddress ? (
          <p className="m-0">
            Fallback schedule: {ran ?? (schedule?.deleted ? "deleted when the order settled." : "not run.")}{" "}
            {scheduleLink}
          </p>
        ) : (
          <p className="m-0">No fallback schedule is on record for this order.</p>
        )}
      </div>
    );
  }

  const untilClose = now === null ? null : quotesCloseAt - now;
  const untilFallback = now === null || fallbackAt === null ? null : fallbackAt - now;
  return (
    <div className="mt-5 grid gap-4 border-t border-base-300 pt-4 sm:grid-cols-2">
      <div>
        <p className="m-0 text-xs text-base-content/70">Quotes can be accepted for</p>
        <p className="m-0 mt-1 font-mono text-2xl tabular-nums">
          {untilClose === null ? "-" : untilClose > 0 ? fmtDuration(untilClose) : "Closed"}
        </p>
        <p className="m-0 mt-1 text-xs text-base-content/70">until {fmtDateTime(quotesCloseAt)} (the order expiry)</p>
      </div>
      <div>
        <p className="m-0 text-xs text-base-content/70">Scheduled fallback swap in</p>
        <p className="m-0 mt-1 font-mono text-2xl tabular-nums">
          {untilFallback === null
            ? scheduleError
              ? "Unavailable"
              : "-"
            : untilFallback > 0
              ? fmtDuration(untilFallback)
              : "Due"}
        </p>
        <p className="m-0 mt-1 text-xs text-base-content/70">
          {untilFallback !== null && untilFallback <= 0
            ? "The network runs it at consensus. This page updates when it lands. "
            : "Pays at least the floor, whatever the makers do. "}
          {scheduleLink}
        </p>
      </div>
    </div>
  );
}

function Ladder({
  id,
  order,
  now,
  board,
  fallbackRef,
  settledMaker,
  settledAmount,
}: {
  id: bigint;
  order: Order;
  now: number | null;
  board: ReturnType<typeof useQuoteBoard>;
  fallbackRef: { amount: bigint; label: string } | null;
  settledMaker: string | undefined;
  settledAmount: bigint | undefined;
}) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const ready = useWalletReady();
  const tx = useTx();
  const open = order.status === 0;
  const isTaker = !!address && address.toLowerCase() === order.taker.toLowerCase();

  const rows = useMemo(() => {
    if (!board.data || now === null) return [];
    const sorted = sortQuotes(board.data.quotes);
    return sorted.map(q => ({
      q,
      verdict: assessQuote(q, q, { nowSec: now, minOut: order.minOut, oracleFloor: board.data.oracleFloor }),
    }));
  }, [board.data, now, order.minOut]);

  // An open order's best quote is the best one it can accept today. A settled order's is the best that was ever valid.
  const bestIndex = rows.findIndex(r =>
    open ? r.verdict === "live" : r.q.signatureOk && r.q.amountOut >= order.minOut,
  );

  const accept = (q: BoardQuote) =>
    tx.run([
      {
        id: "fill",
        send: () =>
          tx.call(
            {
              address: DESK_ADDRESS,
              abi: DESK_ABI,
              functionName: "fillWithQuote",
              args: [id, { maker: q.maker, amountOut: q.amountOut, deadline: q.deadline, nonce: q.nonce }, q.signature],
            },
            GAS_FLOOR.fill,
          ),
        verify: async () => {
          const o = await client!.readContract({
            address: DESK_ADDRESS,
            abi: DESK_ABI,
            functionName: "getOrder",
            args: [id],
          });
          if (o.status !== 1) throw new Error(`The desk still reports order #${id} with status ${o.status}.`);
        },
      },
    ]);

  const shown = rows.slice(0, MAX_ROWS);
  const tokenOutSymbol = tokenOf(order.tokenOut)?.symbol ?? "tokens";

  return (
    <div className="mt-6 border-t border-base-300 pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="m-0 text-lg font-semibold">Quotes from makers</h3>
        <span className="text-xs text-base-content/70">
          Read from topic{" "}
          <a className="link" href={hashscan.topic(QUOTE_TOPIC_ID)} target="_blank" rel="noreferrer">
            {QUOTE_TOPIC_ID}
          </a>
          , every signature checked here, best {tokenOutSymbol} first
        </span>
      </div>

      {board.isLoading && <p className="m-0 mt-4 text-sm text-base-content/70">Reading the quote topic</p>}
      {board.isError && (
        <p className="m-0 mt-4 text-sm text-error" role="alert">
          Could not read the quote topic.{" "}
          <button type="button" className="link" onClick={() => void board.refetch()}>
            Retry
          </button>
        </p>
      )}
      {board.data && rows.length === 0 && (
        <p className="m-0 mt-4 text-sm text-base-content/70">
          No maker has quoted this order in the {board.data.messagesRead} messages on the topic. The fallback swap is
          booked either way.
        </p>
      )}

      {open && !isTaker && rows.length > 0 && (
        <p className="m-0 mt-3 text-sm text-base-content/70">
          Only the account that posted this order can accept a quote.
        </p>
      )}

      {shown.length > 0 && (
        <ol className="m-0 mt-3 list-none divide-y divide-base-300 p-0">
          {shown.map(({ q, verdict }, i) => {
            const vsFloor = bpsOver(q.amountOut, order.minOut);
            const vsFallback = fallbackRef ? bpsOver(q.amountOut, fallbackRef.amount) : null;
            const wasFill = settledMaker?.toLowerCase() === q.maker.toLowerCase() && settledAmount === q.amountOut;
            const dim = verdict !== "live" && !wasFill;
            return (
              <li key={`${q.sequence}`} className={`py-3 ${dim ? "opacity-75" : ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 items-baseline gap-3">
                    <span className="font-mono text-lg font-medium tabular-nums">
                      {fmtToken(q.amountOut, order.tokenOut, 6)}
                    </span>
                    {i === bestIndex && <span className="text-xs font-semibold text-primary">Best</span>}
                    {wasFill && <span className="text-xs font-semibold text-success">Filled this order</span>}
                  </div>
                  {open && isTaker && verdict === "live" && now !== null && now < Number(order.expiry) && (
                    <div className="w-full sm:w-auto">
                      <WalletGate ready={ready}>
                        <button
                          type="button"
                          className={`btn btn-sm w-full ${i === bestIndex ? "btn-primary" : "btn-outline"}`}
                          disabled={tx.running}
                          onClick={() => accept(q)}
                        >
                          Accept this quote
                        </button>
                      </WalletGate>
                    </div>
                  )}
                </div>
                <dl className="m-0 mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-base-content/70 sm:grid-cols-4">
                  <div>
                    <dt className="inline">Over floor </dt>
                    <dd className="m-0 inline font-mono tabular-nums">
                      {vsFloor === null ? "-" : fmtSignedBps(vsFloor)}
                    </dd>
                  </div>
                  {fallbackRef && (
                    <div>
                      <dt className="inline">{fallbackRef!.label} </dt>
                      <dd className="m-0 inline font-mono tabular-nums">
                        {vsFallback === null ? "-" : `${vsFallback > 0 ? "+" : ""}${vsFallback} bps`}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline">Maker </dt>
                    <dd className="m-0 inline">
                      <a className="link" href={hashscan.account(q.maker)} target="_blank" rel="noreferrer">
                        {shortAddress(q.maker)}
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt className="inline">Consensus </dt>
                    <dd className="m-0 inline font-mono tabular-nums" title={`HCS message ${q.sequence}`}>
                      {q.consensusTimestamp}
                    </dd>
                  </div>
                </dl>
                <p className={`m-0 mt-1 text-xs ${verdict === "live" ? "text-success" : "text-base-content/70"}`}>
                  {wasFill ? "This quote settled the order." : VERDICT_TEXT[verdict]} <span aria-hidden>·</span>{" "}
                  deadline {fmtDateTime(Number(q.deadline))}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > MAX_ROWS && (
        <p className="m-0 mt-2 text-xs text-base-content/70">{rows.length - MAX_ROWS} lower quotes not shown.</p>
      )}

      <dl className="m-0 mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-base-300 pt-3 text-sm">
        <dt className="font-medium">Fallback floor (guaranteed minimum)</dt>
        <dd className="m-0 text-right font-mono font-medium tabular-nums">
          {fmtToken(order.minOut, order.tokenOut, 6)}
        </dd>
        {fallbackRef && (
          <>
            <dt className="text-base-content/70">{open ? "Pool spot output now" : "Fallback paid"}</dt>
            <dd className="m-0 text-right font-mono tabular-nums">{fmtToken(fallbackRef.amount, order.tokenOut, 6)}</dd>
          </>
        )}
      </dl>

      {Object.keys(tx.runs).length > 0 && (
        <div className="mt-4">
          <TxSteps
            steps={[
              {
                id: "fill",
                label: "Accept the quote",
                needed: true,
                hint: "The maker pays you and receives your escrow in one transaction.",
              },
            ]}
            runs={tx.runs}
          />
        </div>
      )}
    </div>
  );
}
