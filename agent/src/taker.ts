import type { Context } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { type Address, encodeFunctionData, erc20Abi } from "viem";
import type { z } from "zod";
import { type Board, loadBoard } from "./board";
import { ORDER_STATUS, type DeskReader, type Order, STATUS_CANCELLED, STATUS_FILLED, STATUS_OPEN, type Token } from "./chain";
import { DeskQueryTool, DeskTxTool, type Envelope, GAS, type TxPlan, blocked, contractCall, defaultAccount, ok, requireOperator } from "./base";
import { linkBuilder, mirrorTxId } from "./links";
import { acceptQuoteSchema, cancelOrderSchema, getOrderStatusSchema, listQuotesSchema, postOrderSchema } from "./schemas";
import { WEIBAR_PER_TINYBAR, bpsOver, fmt, lessBps, parseAmount, spotOut } from "./units";

export const TAKER_TOOLS = {
  post: "post_order",
  list: "list_quotes",
  accept: "accept_quote",
  cancel: "cancel_order",
  status: "get_order_status",
} as const;

const now = () => Math.floor(Date.now() / 1000);
const iso = (sec: bigint | number) => new Date(Number(sec) * 1000).toISOString();

async function pairTokens(chain: DeskReader, order: Order): Promise<{ tIn: Token; tOut: Token }> {
  const [tIn, tOut] = await Promise.all([chain.token(order.tokenIn), chain.token(order.tokenOut)]);
  return { tIn, tOut };
}

function orderView(chain: DeskReader, id: bigint, o: Order, t: { tIn: Token; tOut: Token }, nowSec: number) {
  const L = linksOf(chain);
  const secondsLeft = Number(o.expiry) - nowSec;
  return {
    orderId: id.toString(),
    orderStatus: ORDER_STATUS[o.status] ?? `status ${o.status}`,
    taker: o.taker,
    sells: `${fmt(o.amountIn, t.tIn.decimals)} ${t.tIn.symbol}`,
    minBuys: `${fmt(o.minOut, t.tOut.decimals)} ${t.tOut.symbol}`,
    amountInRaw: o.amountIn.toString(),
    minOutRaw: o.minOut.toString(),
    fee: o.fee,
    expiresAt: iso(o.expiry),
    secondsLeft,
    fallbackSchedule: /^0x0{40}$/i.test(o.schedule) ? null : L.schedule(o.schedule),
    rearms: o.rearms,
    claimable: o.claimable.toString(),
  };
}

const linksOf = (chain: DeskReader) => linkBuilder(chain.cfg.hashscanUrl, chain.cfg.mirrorUrl);

const topicFor = (chain: DeskReader, param?: string) => param ?? chain.cfg.topicId;
const NO_TOPIC = "No HCS quote topic is configured. Set QUOTE_TOPIC_ID or pass topicId.";

// ------------------------------------------------------------------ get_order_status

export class GetOrderStatus extends DeskQueryTool {
  method = TAKER_TOOLS.status;
  name = "Get order status";
  description = `Read one RFQ order from the desk: status (Open, Filled, FellBack, Cancelled, Refunded), what it sells and its minimum, when quotes close, the booked fallback schedule, any claimable refund, and what happens next. Read-only, no signature needed.`;
  parameters = getOrderStatusSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return getOrderStatusSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof getOrderStatusSchema>, context: Context, client: Client): Promise<Envelope> {
    const id = BigInt(p.orderId);
    const order = await this.chain.order(id);
    if (!order) return blocked([`Order ${id} does not exist on the desk ${this.chain.cfg.desk}.`]);
    const t = await pairTokens(this.chain, order);
    const nowSec = now();
    const view = orderView(this.chain, id, order, t, nowSec);
    const who = defaultAccount(client, context);
    const agentIsTaker = who ? (await this.chain.account(who)).evmAddress.toLowerCase() === order.taker.toLowerCase() : null;
    const next =
      order.status === STATUS_OPEN
        ? view.secondsLeft > 0
          ? `Open for quotes for ${view.secondsLeft} more seconds, then the booked fallback swaps the escrow on SaucerSwap and pays the taker at least ${view.minBuys}.`
          : "Quotes are closed. The network's scheduled fallback settles the order; if it has not run, rearm() is allowed shortly after expiry."
        : order.status === STATUS_FILLED
          ? "Filled by a maker's signed quote."
          : order.status === STATUS_CANCELLED
            ? "Cancelled by the taker; the escrow and fuel were returned."
            : `Settled by the fallback (${view.orderStatus}).`;
    return ok({ ...view, agentIsTaker, links: { desk: this.links.contract(this.chain.cfg.desk), taker: this.links.account(order.taker) } }, `Order ${id} is ${view.orderStatus}: sells ${view.sells}, floor ${view.minBuys}. ${next}`);
  }
}

// ------------------------------------------------------------------ list_quotes

function describeBoard(id: bigint, o: Order, t: { tIn: Token; tOut: Token }, b: Board) {
  const quotes = b.quotes.map((q, rank) => ({
    rank: rank + 1,
    maker: q.maker,
    amountOut: fmt(q.amountOut, t.tOut.decimals),
    amountOutRaw: q.amountOut.toString(),
    vsFallbackBps: q.vsFallbackBps,
    vsMinOutBps: q.vsMinOutBps,
    secondsLeft: q.secondsLeft,
    deadline: iso(q.deadline),
    nonce: q.nonce.toString(),
    makerCovered: q.makerCovered,
    topicSequence: q.sequence,
    consensusTimestamp: q.consensusTimestamp,
  }));
  return {
    orderId: id.toString(),
    sells: `${fmt(o.amountIn, t.tIn.decimals)} ${t.tIn.symbol}`,
    minBuys: `${fmt(o.minOut, t.tOut.decimals)} ${t.tOut.symbol}`,
    fallbackEstimate: b.fallbackEstimate === null ? null : `${fmt(b.fallbackEstimate, t.tOut.decimals)} ${t.tOut.symbol}`,
    oracleFloor: b.oracleFloor === null ? null : b.oracleFloor.toString(),
    messagesRead: b.read,
    verifiedQuotes: quotes.length,
    rejected: b.rejected,
    quotes,
  };
}

export class ListQuotes extends DeskQueryTool {
  method = TAKER_TOOLS.list;
  name = "List quotes";
  description = `List the market-maker quotes for an open order, best first. Reads the desk's HCS quote topic from the mirror node, base64-decodes each message, drops anything that is not a quote for this order, and keeps only quotes whose EIP-712 signature recovers to the maker (verifyTypedData), that clear the order's minOut and the Chainlink band, that have not expired, and whose nonce is unspent. Shows each quote against the fallback: the premium in basis points over what the network fallback swap would pay at the current pool price, and over the guaranteed minOut. Read-only.`;
  parameters = listQuotesSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return listQuotesSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof listQuotesSchema>): Promise<Envelope> {
    const topicId = topicFor(this.chain, p.topicId);
    if (!topicId) return blocked([NO_TOPIC]);
    const id = BigInt(p.orderId);
    const order = await this.chain.order(id);
    if (!order) return blocked([`Order ${id} does not exist on the desk ${this.chain.cfg.desk}.`]);
    const t = await pairTokens(this.chain, order);
    if (order.status !== STATUS_OPEN) return blocked([`Order ${id} is ${ORDER_STATUS[order.status]}, so it takes no more quotes.`], { orderStatus: ORDER_STATUS[order.status] });
    const board = await loadBoard(this.chain, { orderId: id, order, topicId, maxMessages: p.maxMessages, nowSec: now() });
    const view = describeBoard(id, order, t, board);
    const best = view.quotes[0];
    const msg = best
      ? `Order ${id}: ${view.verifiedQuotes} verified quote(s). Best ${best.amountOut} ${t.tOut.symbol} from ${best.maker}, ${best.vsFallbackBps ?? "n/a"} bps over the fallback estimate, ${best.secondsLeft}s left${best.makerCovered ? "" : " (maker lacks balance or allowance)"}.`
      : `Order ${id}: no verified quote yet (${board.read} topic messages read, ${board.rejected.total} rejected). The fallback guarantees at least ${view.minBuys}.`;
    return ok({ ...view, topic: { id: topicId, link: this.links.topic(topicId) } }, msg);
  }
}

// ------------------------------------------------------------------ post_order

export class PostOrder extends DeskTxTool {
  method = TAKER_TOOLS.post;
  name = "Post order";
  description = `Post an RFQ swap order to the desk as the agent's account. The tool prices the floor itself: minOut is the SaucerSwap V2 pool spot for the amount less slippageBps, so the order cannot settle below it. The desk escrows the amount (HBAR is wrapped to WHBAR), books a Hedera Schedule Service fallback at expiry, and market makers answer with signed quotes (see list_quotes). Checks the TTL window, the pool, the balance, the allowance and the receiving association first, then verifies the OrderPosted event and reads the order back from the desk. Moves real funds.`;
  parameters = postOrderSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return postOrderSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof postOrderSchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const op = await requireOperator(this.chain, client, context);
    const [limits, tIn, tOut] = await Promise.all([this.chain.limits(), this.chain.token(p.tokenIn), this.chain.token(p.tokenOut)]);
    const reasons: string[] = [];
    if (tIn.address.toLowerCase() === tOut.address.toLowerCase()) reasons.push("tokenIn and tokenOut are the same token.");
    if (BigInt(p.ttlSeconds) < limits.minTtl || BigInt(p.ttlSeconds) > limits.maxTtl)
      reasons.push(`ttlSeconds ${p.ttlSeconds} is outside the desk's window of ${limits.minTtl} to ${limits.maxTtl} seconds.`);
    let amountIn = 0n;
    try {
      amountIn = parseAmount(p.amount, tIn.decimals, "amount");
    } catch (e) {
      reasons.push((e as Error).message);
    }
    if (reasons.length) return blocked(reasons, { account: op.accountId });

    const pool = await this.chain.pool(tIn.address, tOut.address, p.fee);
    if (!pool) return blocked([`SaucerSwap V2 has no ${tIn.symbol}/${tOut.symbol} pool at fee ${p.fee}, so the desk would revert NoPool and no fallback could be booked.`]);
    const spot = spotOut({ amountIn, sqrtPriceX96: pool.sqrtPriceX96, tokenInIsToken0: pool.tokenInIsToken0 });
    const minOut = lessBps(spot, p.slippageBps);
    if (minOut === 0n) return blocked([`${p.amount} ${tIn.symbol} is too small to price: the pool spot rounds to zero ${tOut.symbol}.`]);

    const isHbarIn = tIn.address.toLowerCase() === limits.whbar.toLowerCase();
    const valueTinybar = limits.fuelPerOrder + (isHbarIn ? amountIn : 0n);
    const gasPrice = await this.chain.gasPrice();
    const needWeibar = valueTinybar * WEIBAR_PER_TINYBAR + BigInt(GAS.postOrder) * gasPrice;
    const haveWeibar = await this.chain.hbarBalance(op.evmAddress);
    if (haveWeibar < needWeibar)
      reasons.push(`${op.accountId} holds ${fmt(haveWeibar / WEIBAR_PER_TINYBAR, 8)} HBAR; the order${isHbarIn ? " amount" : ""} plus ${fmt(limits.fuelPerOrder, 8)} HBAR of fallback fuel and the gas reservation needs ${fmt(needWeibar / WEIBAR_PER_TINYBAR, 8)}.`);
    let allowance = 0n;
    if (!isHbarIn) {
      const bal = await this.chain.balanceOf(tIn.address, op.evmAddress);
      if (bal < amountIn) reasons.push(`${op.accountId} holds ${fmt(bal, tIn.decimals)} ${tIn.symbol}, less than the ${p.amount} requested.`);
      allowance = await this.chain.allowance(tIn.address, op.evmAddress, this.chain.cfg.desk);
    }
    const assoc = (await this.chain.associations(op.accountId, [tOut.address]))[tOut.address.toLowerCase()];
    if (assoc === "needs") reasons.push(`${op.accountId} is not associated with ${tOut.symbol} (${tOut.address}), so the fill or the fallback could not pay it. Associate it first, for example with the Agent Kit associate_token_tool.`);
    if (reasons.length) return blocked(reasons, { account: op.accountId });

    const warnings: string[] = [];
    const usesBand = [tIn.address, tOut.address].some((a) => a.toLowerCase() === limits.usdToken.toLowerCase()) && [tIn.address, tOut.address].some((a) => a.toLowerCase() === limits.whbar.toLowerCase());
    if (usesBand && !(await this.chain.hbarUsdFresh())) warnings.push("The Chainlink HBAR/USD feed is stale, so the desk rejects every maker quote for this pair until it updates. The fallback still settles the order.");

    const desk = this.chain.cfg.desk;
    const L = this.links;
    const data = encodeFunctionData({ abi: this.chain.cfg.abi, functionName: "postOrder", args: [tIn.address, tOut.address, p.fee, amountIn, minOut, BigInt(p.ttlSeconds)] });
    const summary = { account: op.accountId, sells: `${p.amount} ${tIn.symbol}`, minOut: `${fmt(minOut, tOut.decimals)} ${tOut.symbol}`, spotOut: fmt(spot, tOut.decimals), slippageBps: p.slippageBps, ttlSeconds: p.ttlSeconds, fuel: `${fmt(limits.fuelPerOrder, 8)} HBAR`, warnings };
    return {
      tx: contractCall(desk, data, GAS.postOrder, valueTinybar),
      summary,
      pre:
        isHbarIn || allowance >= amountIn
          ? undefined
          : {
              tx: contractCall(tIn.address, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [desk, amountIn] }), GAS.approve),
              label: `Approve ${p.amount} ${tIn.symbol} to the desk`,
              verify: async () => {
                const now = await this.chain.allowance(tIn.address, op.evmAddress, desk);
                if (now < amountIn) throw new Error(`The approval went through but the allowance reads ${now}, below ${amountIn}.`);
              },
            },
      finish: async (txId) => {
        const result = await this.chain.waitForResult(mirrorTxId(txId));
        if (result.result !== "SUCCESS") throw new Error(`Mirror node reports ${result.result} for ${txId}`);
        const posted = this.chain.deskEvents(result).find((e) => e.name === "OrderPosted");
        if (!posted) throw new Error(`Transaction ${txId} succeeded but the desk emitted no OrderPosted event.`);
        const id = posted.args.id as bigint;
        const order = await this.chain.order(id);
        if (!order) throw new Error(`OrderPosted says order ${id} but the desk has no such order.`);
        const bad = [
          order.taker.toLowerCase() !== op.evmAddress.toLowerCase() && "taker",
          order.status !== STATUS_OPEN && "status",
          order.amountIn !== amountIn && "amountIn",
          order.minOut !== minOut && "minOut",
          /^0x0{40}$/i.test(order.schedule) && "fallback schedule",
        ].filter(Boolean);
        if (bad.length) throw new Error(`Order ${id} read back from the desk differs from what was posted: ${bad.join(", ")}.`);
        const topic = this.chain.cfg.topicId;
        return ok(
          {
            transactionId: txId,
            hash: result.hash,
            account: op.accountId,
            orderId: id.toString(),
            orderStatus: ORDER_STATUS[order.status],
            sells: `${p.amount} ${tIn.symbol}`,
            minOut: fmt(minOut, tOut.decimals),
            minOutRaw: minOut.toString(),
            spotOut: fmt(spot, tOut.decimals),
            expiresAt: iso(order.expiry),
            fallbackAt: iso(posted.args.fallbackAt as bigint),
            warnings,
            gasUsed: result.gas_used,
            quoteTopic: topic ? { id: topic, link: L.topic(topic) } : null,
            links: { tx: L.tx(txId), desk: L.contract(desk), fallbackSchedule: L.schedule(order.schedule) },
          },
          `Posted order ${id}: sell ${p.amount} ${tIn.symbol} for at least ${fmt(minOut, tOut.decimals)} ${tOut.symbol}, open until ${iso(order.expiry)}. ${L.tx(txId)}`,
        );
      },
    };
  }
}

// ------------------------------------------------------------------ accept_quote

export class AcceptQuote extends DeskTxTool {
  method = TAKER_TOOLS.accept;
  name = "Accept quote";
  description = `Settle an open order with a maker's signed quote by calling fillWithQuote. Only the order's own taker may do this, and the tool refuses any other account before sending. It re-reads and re-verifies the topic itself (signature, deadline, minOut, Chainlink band, unspent nonce), skips quotes whose maker lacks the balance or allowance, takes the best remaining one (or the best from the given maker), then verifies the Filled event, the order status and the exact tokenOut the taker received. Moves real funds.`;
  parameters = acceptQuoteSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return acceptQuoteSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof acceptQuoteSchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const topicId = topicFor(this.chain, p.topicId);
    if (!topicId) return blocked([NO_TOPIC]);
    const op = await requireOperator(this.chain, client, context);
    const id = BigInt(p.orderId);
    const order = await this.chain.order(id);
    if (!order) return blocked([`Order ${id} does not exist on the desk ${this.chain.cfg.desk}.`]);
    if (order.taker.toLowerCase() !== op.evmAddress.toLowerCase())
      return blocked([`Only the order's taker ${order.taker} can fill it (the desk reverts OnlyTaker); ${op.accountId} is ${op.evmAddress}.`], { taker: order.taker });
    if (order.status !== STATUS_OPEN) return blocked([`Order ${id} is ${ORDER_STATUS[order.status]}, not Open.`], { orderStatus: ORDER_STATUS[order.status] });
    const t = await pairTokens(this.chain, order);
    const nowSec = now();
    if (order.expiry <= BigInt(nowSec)) return blocked([`Order ${id} expired at ${iso(order.expiry)}; quotes close at expiry and the network fallback settles it.`]);

    const assoc = (await this.chain.associations(op.accountId, [order.tokenOut]))[order.tokenOut.toLowerCase()];
    if (assoc === "needs") return blocked([`${op.accountId} is not associated with ${t.tOut.symbol} (${order.tokenOut}), so the payout would fail. Associate it first.`]);

    const board = await loadBoard(this.chain, { orderId: id, order, topicId, maxMessages: p.maxMessages, nowSec, minRemainingSec: 20 });
    const onlyMaker = p.maker?.toLowerCase();
    const candidates = board.quotes.filter((q) => !onlyMaker || q.maker.toLowerCase() === onlyMaker);
    const chosen = candidates.find((q) => q.makerCovered);
    if (!chosen) {
      const why = candidates.length
        ? `${candidates.length} verified quote(s), but every maker lacks the ${t.tOut.symbol} balance or allowance for the desk to pull, so a fill would revert.`
        : onlyMaker
          ? `No verified quote from ${p.maker} (${board.quotes.length} from other makers).`
          : `No verified, unexpired quote for order ${id} (${board.read} topic messages read, ${board.rejected.total} rejected).`;
      return blocked([why, `The fallback still guarantees at least ${fmt(order.minOut, t.tOut.decimals)} ${t.tOut.symbol}.`], { rejected: board.rejected });
    }

    const before = await this.chain.balanceOf(order.tokenOut, op.evmAddress);
    const L = this.links;
    const quote = { maker: chosen.maker, amountOut: chosen.amountOut, deadline: chosen.deadline, nonce: chosen.nonce };
    const data = encodeFunctionData({ abi: this.chain.cfg.abi, functionName: "fillWithQuote", args: [id, quote, chosen.signature] });
    const summary = {
      account: op.accountId,
      orderId: id.toString(),
      maker: chosen.maker,
      amountOut: fmt(chosen.amountOut, t.tOut.decimals),
      vsFallbackBps: chosen.vsFallbackBps,
      vsMinOutBps: chosen.vsMinOutBps,
      secondsLeft: chosen.secondsLeft,
    };
    return {
      tx: contractCall(this.chain.cfg.desk, data, GAS.fill),
      summary,
      finish: async (txId) => {
        const result = await this.chain.waitForResult(mirrorTxId(txId));
        if (result.result !== "SUCCESS") throw new Error(`Mirror node reports ${result.result} for ${txId}`);
        const filled = this.chain.deskEvents(result).find((e) => e.name === "Filled");
        if (!filled) throw new Error(`Transaction ${txId} succeeded but the desk emitted no Filled event.`);
        if (filled.args.amountOut !== chosen.amountOut || (filled.args.maker as string).toLowerCase() !== chosen.maker.toLowerCase())
          throw new Error(`Filled says ${filled.args.amountOut} from ${filled.args.maker}, not the accepted ${chosen.amountOut} from ${chosen.maker}.`);
        const [after, settled, spent] = await Promise.all([this.chain.balanceOf(order.tokenOut, op.evmAddress), this.chain.order(id), this.chain.nonceUsed(chosen.maker, chosen.nonce)]);
        if (settled?.status !== STATUS_FILLED) throw new Error(`Order ${id} reads status ${settled ? ORDER_STATUS[settled.status] : "missing"} after the fill, not Filled.`);
        if (after - before !== chosen.amountOut) throw new Error(`Filled says ${chosen.amountOut} but the ${t.tOut.symbol} balance moved by ${after - before}.`);
        if (!spent) throw new Error(`The quote's nonce ${chosen.nonce} still reads unspent after the fill.`);
        return ok(
          {
            transactionId: txId,
            hash: result.hash,
            account: op.accountId,
            orderId: id.toString(),
            orderStatus: ORDER_STATUS[settled.status],
            maker: chosen.maker,
            received: `${fmt(chosen.amountOut, t.tOut.decimals)} ${t.tOut.symbol}`,
            receivedRaw: chosen.amountOut.toString(),
            balanceBefore: fmt(before, t.tOut.decimals),
            balanceAfter: fmt(after, t.tOut.decimals),
            overFallbackEstimateBps: board.fallbackEstimate === null ? null : bpsOver(chosen.amountOut, board.fallbackEstimate),
            overMinOutBps: bpsOver(chosen.amountOut, order.minOut),
            gasUsed: result.gas_used,
            quoteMessage: { topic: topicId, sequence: chosen.sequence, link: L.topicMessage(topicId, chosen.sequence) },
            links: { tx: L.tx(txId), desk: L.contract(this.chain.cfg.desk), maker: L.account(chosen.maker) },
          },
          `Filled order ${id}: received ${fmt(chosen.amountOut, t.tOut.decimals)} ${t.tOut.symbol} from ${chosen.maker}. ${L.tx(txId)}`,
        );
      },
    };
  }
}

// ------------------------------------------------------------------ cancel_order

export class CancelOrder extends DeskTxTool {
  method = TAKER_TOOLS.cancel;
  name = "Cancel order";
  description = `Cancel the agent's own open order before it expires: the desk returns the escrow and the fallback fuel and deletes the booked schedule. Only the order's taker can cancel; the tool refuses any other account, a closed order and an expired order before sending, then verifies the Cancelled event, the order status and the exact tokenIn refunded. Moves real funds.`;
  parameters = cancelOrderSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return cancelOrderSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof cancelOrderSchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const op = await requireOperator(this.chain, client, context);
    const id = BigInt(p.orderId);
    const order = await this.chain.order(id);
    if (!order) return blocked([`Order ${id} does not exist on the desk ${this.chain.cfg.desk}.`]);
    if (order.taker.toLowerCase() !== op.evmAddress.toLowerCase())
      return blocked([`Only the order's taker ${order.taker} can cancel it (the desk reverts OnlyTaker); ${op.accountId} is ${op.evmAddress}.`], { taker: order.taker });
    if (order.status !== STATUS_OPEN) return blocked([`Order ${id} is ${ORDER_STATUS[order.status]}, not Open.`], { orderStatus: ORDER_STATUS[order.status] });
    if (order.expiry <= BigInt(now())) return blocked([`Order ${id} expired at ${iso(order.expiry)}; it can no longer be cancelled and the network fallback settles it.`]);
    const t = await pairTokens(this.chain, order);
    const before = await this.chain.balanceOf(order.tokenIn, op.evmAddress);
    const L = this.links;
    return {
      tx: contractCall(this.chain.cfg.desk, encodeFunctionData({ abi: this.chain.cfg.abi, functionName: "cancel", args: [id] }), GAS.cancel),
      summary: { account: op.accountId, orderId: id.toString(), refund: `${fmt(order.amountIn, t.tIn.decimals)} ${t.tIn.symbol}` },
      finish: async (txId) => {
        const result = await this.chain.waitForResult(mirrorTxId(txId));
        if (result.result !== "SUCCESS") throw new Error(`Mirror node reports ${result.result} for ${txId}`);
        if (!this.chain.deskEvents(result).some((e) => e.name === "Cancelled")) throw new Error(`Transaction ${txId} succeeded but the desk emitted no Cancelled event.`);
        const [after, settled] = await Promise.all([this.chain.balanceOf(order.tokenIn, op.evmAddress), this.chain.order(id)]);
        if (settled?.status !== STATUS_CANCELLED) throw new Error(`Order ${id} reads status ${settled ? ORDER_STATUS[settled.status] : "missing"} after the cancel, not Cancelled.`);
        if (after - before !== order.amountIn) throw new Error(`Expected ${order.amountIn} ${t.tIn.symbol} back but the balance moved by ${after - before}.`);
        return ok(
          { transactionId: txId, hash: result.hash, account: op.accountId, orderId: id.toString(), orderStatus: ORDER_STATUS[settled.status], refunded: `${fmt(after - before, t.tIn.decimals)} ${t.tIn.symbol}`, gasUsed: result.gas_used, links: { tx: L.tx(txId), desk: L.contract(this.chain.cfg.desk) } },
          `Cancelled order ${id}; ${fmt(after - before, t.tIn.decimals)} ${t.tIn.symbol} returned. ${L.tx(txId)}`,
        );
      },
    };
  }
}
