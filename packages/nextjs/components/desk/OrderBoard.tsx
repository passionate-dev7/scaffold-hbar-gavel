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

const STATUS_TONE = ["text-link", "text-ok", "text-ok", "text-mute", "text-warn"];

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
      <section className="tui px-5 py-8 sm:px-8">
        <p className="m-0 text-sm text-bad" role="alert">
          Order #{id.toString()} could not be read from the desk.
        </p>
      </section>
    );
  }
  if (!order || order.taker === "0x0000000000000000000000000000000000000000") {
    return (
      <section className="tui px-5 py-8 sm:px-8" aria-busy={!order}>
        <p className="m-0 text-sm text-mute">
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
    <section className="tui" aria-labelledby="board-title">
      <div className="px-5 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h2 id="board-title" className="m-0 text-base font-bold">
              Order #{id.toString()}{" "}
              <span className={`ml-1 font-normal ${STATUS_TONE[order.status]}`}>
                [{STATUS_LABEL[STATUS[order.status]]}]
              </span>
            </h2>
            <p className="m-0 mt-2 text-xl font-bold leading-snug sm:text-[1.5rem]">
              <span className="tabular-nums">{fmtEscrow(order.amountIn, order.tokenIn)}</span>{" "}
              <span className="font-normal text-mute">for at least</span>{" "}
              <span className="tabular-nums">{fmtToken(order.minOut, order.tokenOut, 6)}</span>
            </p>
            <p className="m-0 mt-2 text-xs text-mute">
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
          postedAt={posted?.at}
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
      </div>
    </section>
  );
}

const BAR_CELLS = 24;

/** A block-character bar: how far the clock has run between posting and its deadline. */
function Bar({ now, from, to }: { now: number | null; from: number | undefined; to: number | null }) {
  if (now === null || from === undefined || to === null || to <= from) return null;
  const filled = Math.round(Math.min(1, Math.max(0, (now - from) / (to - from))) * BAR_CELLS);
  return (
    <div aria-hidden className="mt-3 overflow-hidden whitespace-nowrap text-sm leading-none">
      <span className="text-fg">{"█".repeat(filled)}</span>
      <span className="text-mute">{"░".repeat(BAR_CELLS - filled)}</span>
    </div>
  );
}

function Clock({
  label,
  value,
  live,
  children,
  bar,
}: {
  label: string;
  value: string;
  live: boolean;
  children: React.ReactNode;
  bar: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="m-0 text-xs text-mute">{label}</p>
      <p
        className={`m-0 mt-1 text-[1.875rem] font-bold leading-tight tabular-nums sm:text-[2.375rem] ${live ? "caret" : ""}`}
      >
        {value}
      </p>
      {bar}
      <p className="m-0 mt-3 text-xs text-mute">{children}</p>
    </div>
  );
}

function FallbackClock({
  order,
  now,
  postedAt,
  scheduleAddress,
  schedule,
  scheduleError,
}: {
  order: Order;
  now: number | null;
  postedAt: number | undefined;
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
      <div className="mt-6 border-t border-hair pt-4 text-sm text-mute">
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
    <div className="mt-8 grid gap-8 border-t border-hair pt-6 md:grid-cols-2 md:gap-12">
      <Clock
        label="Quotes can be accepted for"
        value={untilClose === null ? "-" : untilClose > 0 ? fmtDuration(untilClose) : "Closed"}
        live={untilClose !== null && untilClose > 0}
        bar={<Bar now={now} from={postedAt} to={quotesCloseAt} />}
      >
        until {fmtDateTime(quotesCloseAt)} (the order expiry)
      </Clock>
      <Clock
        label="The gavel falls in (scheduled fallback swap)"
        value={
          untilFallback === null
            ? scheduleError
              ? "Unavailable"
              : "-"
            : untilFallback > 0
              ? fmtDuration(untilFallback)
              : "Due"
        }
        live={untilFallback !== null && untilFallback > 0}
        bar={<Bar now={now} from={postedAt} to={fallbackAt} />}
      >
        {untilFallback !== null && untilFallback <= 0
          ? "The network runs it at consensus. This page updates when it lands. "
          : "Pays at least the floor, whatever the makers do. "}
        {scheduleLink}
      </Clock>
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

  const COLS = "lg:grid-cols-[2ch_minmax(0,19ch)_9ch_11ch_12ch_19ch_minmax(0,1fr)_8rem] lg:items-baseline";

  return (
    <div className="mt-10 border-t border-hair pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="m-0 text-base font-bold">
          <span className="font-normal text-mute">[+]</span> Quote tape
        </h3>
        <span className="text-xs text-mute">
          Read from topic{" "}
          <a className="link" href={hashscan.topic(QUOTE_TOPIC_ID)} target="_blank" rel="noreferrer">
            {QUOTE_TOPIC_ID}
          </a>
          , every signature checked here, best {tokenOutSymbol} first
        </span>
      </div>

      {board.isLoading && <p className="m-0 mt-4 text-sm text-mute">Reading the quote topic</p>}
      {board.isError && (
        <p className="m-0 mt-4 text-sm text-bad" role="alert">
          Could not read the quote topic.{" "}
          <button type="button" className="link" onClick={() => void board.refetch()}>
            Retry
          </button>
        </p>
      )}
      {board.data && rows.length === 0 && (
        <p className="m-0 mt-4 text-sm text-mute">
          No maker has quoted this order in the {board.data.messagesRead} messages on the topic. The fallback swap is
          booked either way.
        </p>
      )}
      {open && !isTaker && rows.length > 0 && (
        <p className="m-0 mt-3 text-sm text-mute">Only the account that posted this order can accept a quote.</p>
      )}

      {shown.length > 0 && (
        <div className="mt-4 text-[0.8125rem]">
          <div
            aria-hidden
            className={`hidden gap-x-3 border-b border-hair px-3 pb-2 text-xs text-mute lg:grid ${COLS}`}
          >
            <span />
            <span>Amount out</span>
            <span>Over floor</span>
            <span>{fallbackRef ? fallbackRef.label : "vs pool"}</span>
            <span>Maker</span>
            <span>Consensus time</span>
            <span>State</span>
            <span />
          </div>
          <ol className="m-0 list-none p-0">
            {shown.map(({ q, verdict }, i) => {
              const vsFloor = bpsOver(q.amountOut, order.minOut);
              const vsFallback = fallbackRef ? bpsOver(q.amountOut, fallbackRef.amount) : null;
              const wasFill = settledMaker?.toLowerCase() === q.maker.toLowerCase() && settledAmount === q.amountOut;
              const best = i === bestIndex;
              const live = verdict === "live";
              const stateTone = wasFill || live ? "text-ok" : verdict === "bad-signature" ? "text-bad" : "text-mute";
              const stateMark = wasFill || live ? "[x]" : verdict === "bad-signature" ? "[!]" : "[-]";
              return (
                <li
                  key={`${q.sequence}`}
                  className={`print-in grid grid-cols-2 gap-x-3 gap-y-1 border-b border-hair px-3 py-3 ${COLS} ${
                    best ? "bg-dark-2 shadow-[inset_2px_0_0_var(--tone-link)]" : ""
                  }`}
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <span aria-hidden className="hidden font-bold text-link lg:block">
                    {best ? ">" : ""}
                  </span>
                  <span
                    className={`col-span-2 text-base font-bold tabular-nums lg:col-span-1 ${
                      live || wasFill ? "text-fg" : "text-mute"
                    }`}
                  >
                    {fmtToken(q.amountOut, order.tokenOut, 6)}
                    {best && <span className="ml-2 text-xs font-bold text-link">best</span>}
                  </span>
                  <span className="cell tabular-nums" data-l="over floor">
                    {vsFloor === null ? "-" : fmtSignedBps(vsFloor)}
                  </span>
                  <span className="cell tabular-nums" data-l={fallbackRef ? fallbackRef.label : "vs pool"}>
                    {vsFallback === null ? "-" : `${vsFallback > 0 ? "+" : ""}${vsFallback} bps`}
                  </span>
                  <span className="cell col-span-2 lg:col-span-1" data-l="maker">
                    <a className="link" href={hashscan.account(q.maker)} target="_blank" rel="noreferrer">
                      {shortAddress(q.maker)}
                    </a>
                  </span>
                  <span
                    className="cell col-span-2 tabular-nums lg:col-span-1"
                    data-l="consensus"
                    title={`HCS message ${q.sequence}`}
                  >
                    {q.consensusTimestamp}
                  </span>
                  <span className="col-span-2 min-w-0 lg:col-span-1">
                    <span className={stateTone}>{stateMark}</span>{" "}
                    <span className={live || wasFill ? "text-fg" : "text-sub"}>
                      {wasFill ? "This quote settled the order." : VERDICT_TEXT[verdict]}
                    </span>
                    <span className="block text-xs text-mute">
                      signature {q.signatureOk ? "ok" : "bad"} <span aria-hidden>·</span> deadline{" "}
                      {fmtDateTime(Number(q.deadline))}
                    </span>
                  </span>
                  <span className="col-span-2 lg:col-span-1">
                    {open && isTaker && live && now !== null && now < Number(order.expiry) && (
                      <WalletGate ready={ready}>
                        <button
                          type="button"
                          className={`act act-sm act-block ${best ? "" : "act-line"}`}
                          disabled={tx.running}
                          onClick={() => accept(q)}
                        >
                          Accept quote
                        </button>
                      </WalletGate>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {rows.length > MAX_ROWS && (
        <p className="m-0 mt-2 text-xs text-mute">{rows.length - MAX_ROWS} lower quotes not shown.</p>
      )}

      <dl className="m-0 mt-6 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="font-bold">Fallback floor (guaranteed minimum)</dt>
        <dd className="m-0 text-right font-bold tabular-nums">{fmtToken(order.minOut, order.tokenOut, 6)}</dd>
        {fallbackRef && (
          <>
            <dt className="text-mute">{open ? "Pool spot output now" : "Fallback paid"}</dt>
            <dd className="m-0 text-right tabular-nums">{fmtToken(fallbackRef.amount, order.tokenOut, 6)}</dd>
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
