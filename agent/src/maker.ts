import type { Context } from "@hashgraph/hedera-agent-kit";
import { type Client, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { type Address, type Hex, encodeFunctionData, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { z } from "zod";
import { loadBoard } from "./board";
import { DeskTxTool, type Envelope, GAS, type TxPlan, blocked, contractCall, noop, ok, requireOperator } from "./base";
import { ORDER_STATUS, STATUS_OPEN } from "./chain";
import { mirrorTxId } from "./links";
import { priceQuote, quoteDeadline, quoteHash, quoteJson, signQuote, verifyQuote } from "./quote";
import { cancelQuotesSchema, quoteOrderSchema } from "./schemas";
import { fmt, spotOut } from "./units";

export const MAKER_TOOLS = { quote: "quote_order", cancelQuotes: "cancel_quotes" } as const;

const HCS_MAX_BYTES = 1024;

// ------------------------------------------------------------------ quote_order

export class QuoteOrder extends DeskTxTool {
  method = MAKER_TOOLS.quote;
  name = "Quote order";
  description = `Market-maker side. Price an open order from the SaucerSwap V2 pool slot0 less a spread, sign the quote as EIP-712 typed data with the maker key, and submit it to the desk's HCS quote topic. The nonce is the order id, so a re-quote of the same order replaces the previous one once either fills. Declines orders below the price floor (minOut or the Chainlink band) and orders the maker cannot pay for; raises the maker's tokenOut allowance to the desk when it is short. Verifies the quote appears verified on the topic. Needs the maker key configured on the plugin and the agent's account to be that key's Hedera account.`;
  parameters = quoteOrderSchema;

  constructor(
    chain: ConstructorParameters<typeof DeskTxTool>[0],
    private readonly makerKey: Hex | undefined,
  ) {
    super(chain);
  }

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return quoteOrderSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof quoteOrderSchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const topicId = p.topicId ?? this.chain.cfg.topicId;
    if (!topicId) return blocked(["No HCS quote topic is configured. Set QUOTE_TOPIC_ID or pass topicId."]);
    if (!this.makerKey) return blocked(["No maker key is configured on this plugin, so it cannot sign quotes. Create the plugin with makerKey (MAKER_PRIVATE_KEY) to quote."]);
    const maker = privateKeyToAccount(this.makerKey).address;
    const op = await requireOperator(this.chain, client, context);
    if (op.evmAddress.toLowerCase() !== maker.toLowerCase())
      return blocked([`The agent's account ${op.accountId} (${op.evmAddress}) is not the maker key's account ${maker}. Allowances and funds belong to the signing address, so they must be the same account.`]);

    const id = BigInt(p.orderId);
    const order = await this.chain.order(id);
    if (!order) return blocked([`Order ${id} does not exist on the desk ${this.chain.cfg.desk}.`]);
    const nowSec = Math.floor(Date.now() / 1000);
    const [tIn, tOut, pool, floor, domain] = await Promise.all([
      this.chain.token(order.tokenIn),
      this.chain.token(order.tokenOut),
      this.chain.pool(order.tokenIn, order.tokenOut, order.fee),
      this.chain.oracleFloor(id),
      this.chain.domain(),
    ]);
    if (order.status !== STATUS_OPEN) return blocked([`Order ${id} is ${ORDER_STATUS[order.status]}, not Open.`]);
    if (!pool) return blocked([`No ${tIn.symbol}/${tOut.symbol} pool at fee ${order.fee}, so there is no price to quote from.`]);
    if (floor === null) return blocked(["The Chainlink HBAR/USD feed is stale, so the desk would reject any fill of this order."]);
    const price = priceQuote({
      status: order.status,
      expiry: order.expiry,
      minOut: order.minOut,
      nowSec,
      spotOut: spotOut({ amountIn: order.amountIn, sqrtPriceX96: pool.sqrtPriceX96, tokenInIsToken0: pool.tokenInIsToken0 }),
      spreadBps: p.spreadBps,
      oracleFloor: floor,
    });
    if (!price.ok) return blocked([`Declined: ${price.reason}.`]);

    const nonce = id;
    if (await this.chain.nonceUsed(maker, nonce)) return blocked([`Nonce ${nonce} is already spent or cancelled for ${maker}; the desk would reject a quote that reuses it.`]);
    const balance = await this.chain.balanceOf(order.tokenOut, maker);
    if (balance < price.amountOut) return blocked([`${op.accountId} holds ${fmt(balance, tOut.decimals)} ${tOut.symbol}, less than the ${fmt(price.amountOut, tOut.decimals)} this quote pays.`]);

    const quote = { orderId: id, maker, amountOut: price.amountOut, deadline: quoteDeadline({ orderExpiry: order.expiry, nowSec, ttlSec: p.ttlSeconds }), nonce };
    const signed = await signQuote(this.makerKey, domain, quote);
    if (!(await verifyQuote(domain, signed))) throw new Error("self-check failed: the signature does not recover to the maker");
    const digest = await this.chain.quoteDigest(id, { maker, amountOut: quote.amountOut, deadline: quote.deadline, nonce });
    if (digest !== quoteHash(domain, quote)) throw new Error(`self-check failed: the desk's quoteDigest ${digest} differs from the local EIP-712 hash, the signing domain is wrong`);
    const message = quoteJson(signed);
    if (Buffer.byteLength(message) > HCS_MAX_BYTES) throw new Error(`quote message is ${Buffer.byteLength(message)} bytes, over the ${HCS_MAX_BYTES} byte HCS limit`);

    const allowance = await this.chain.allowance(order.tokenOut, maker, this.chain.cfg.desk);
    const L = this.links;
    const desk = this.chain.cfg.desk;
    const summary = {
      account: op.accountId,
      maker,
      orderId: id.toString(),
      amountOut: `${fmt(price.amountOut, tOut.decimals)} ${tOut.symbol}`,
      spreadBps: p.spreadBps,
      deadline: new Date(Number(quote.deadline) * 1000).toISOString(),
    };
    return {
      tx: new TopicMessageSubmitTransaction().setTopicId(TopicId.fromString(topicId)).setMessage(message),
      summary,
      pre:
        allowance >= price.amountOut
          ? undefined
          : {
              tx: contractCall(order.tokenOut, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [desk, price.amountOut] }), GAS.approve),
              label: `Approve ${fmt(price.amountOut, tOut.decimals)} ${tOut.symbol} to the desk`,
              verify: async () => {
                const now = await this.chain.allowance(order.tokenOut, maker, desk);
                if (now < price.amountOut) throw new Error(`The approval went through but the allowance reads ${now}, below ${price.amountOut}.`);
              },
            },
      finish: async (txId) => {
        const posted = await this.chain.waitForTopicMessage(topicId, message);
        const board = await loadBoard(this.chain, { orderId: id, order, topicId, maxMessages: 100, nowSec: Math.floor(Date.now() / 1000) });
        const seen = board.quotes.find((q) => q.sequence === posted.sequence);
        if (!seen) throw new Error(`The quote is on topic ${topicId} as message ${posted.sequence} but does not pass the board's checks (rejections: ${JSON.stringify(board.rejected.byReason)}).`);
        return ok(
          {
            transactionId: txId,
            account: op.accountId,
            maker,
            orderId: id.toString(),
            amountOut: fmt(price.amountOut, tOut.decimals),
            amountOutRaw: price.amountOut.toString(),
            poolSpotOut: fmt(spotOut({ amountIn: order.amountIn, sqrtPriceX96: pool.sqrtPriceX96, tokenInIsToken0: pool.tokenInIsToken0 }), tOut.decimals),
            spreadBps: p.spreadBps,
            vsFallbackBps: seen.vsFallbackBps,
            vsMinOutBps: seen.vsMinOutBps,
            deadline: summary.deadline,
            nonce: nonce.toString(),
            topicMessage: { topic: topicId, sequence: posted.sequence, consensusTimestamp: posted.consensusTimestamp, link: L.topicMessage(topicId, posted.sequence) },
            links: { tx: L.tx(txId), topic: L.topic(topicId), desk: L.contract(desk) },
          },
          `Quoted order ${id}: ${fmt(price.amountOut, tOut.decimals)} ${tOut.symbol} until ${summary.deadline}, topic ${topicId} message ${posted.sequence}. ${L.tx(txId)}`,
        );
      },
    };
  }
}

// ------------------------------------------------------------------ cancel_quotes

export class CancelQuotes extends DeskTxTool {
  method = MAKER_TOOLS.cancelQuotes;
  name = "Cancel quotes";
  description = `Market-maker side. Withdraw signed quotes before they are filled by spending their nonces on the desk with one cancelNonces call (a bitmap: up to 256 quotes in one transaction). Quote nonces are the order ids. Skips nonces already spent, refuses nonces from different blocks of 256, then verifies every nonce reads as used afterwards. The cancel is on chain, so a quote still sitting on the topic can no longer be filled.`;
  parameters = cancelQuotesSchema;

  async normalizeParams(params: unknown, _c: Context, _cl: Client) {
    return cancelQuotesSchema.parse(params);
  }

  async coreAction(p: z.infer<typeof cancelQuotesSchema>, context: Context, client: Client): Promise<Envelope | TxPlan> {
    const op = await requireOperator(this.chain, client, context);
    const nonces = [...new Set(p.nonces.map((n) => BigInt(n)))];
    const words = new Set(nonces.map((n) => n >> 8n));
    if (words.size > 1) return blocked([`The nonces span blocks ${[...words].join(", ")} of 256; cancelNonces retires one block per call. Call this tool once per block.`]);
    const wordPos = nonces[0]! >> 8n;
    const spentFlags = await Promise.all(nonces.map((n) => this.chain.nonceUsed(op.evmAddress, n)));
    const open = nonces.filter((_, i) => !spentFlags[i]);
    if (open.length === 0) return noop(`Every nonce is already spent or cancelled for ${op.evmAddress}; nothing to send.`, { nonces: nonces.map(String) });
    const mask = open.reduce((m, n) => m | (1n << (n & 0xffn)), 0n);
    const L = this.links;
    return {
      tx: contractCall(this.chain.cfg.desk, encodeFunctionData({ abi: this.chain.cfg.abi, functionName: "cancelNonces", args: [wordPos, mask] }), GAS.cancelNonces),
      summary: { account: op.accountId, wordPos: wordPos.toString(), cancelling: open.map(String), alreadySpent: nonces.filter((_, i) => spentFlags[i]).map(String) },
      finish: async (txId) => {
        const result = await this.chain.waitForResult(mirrorTxId(txId));
        if (result.result !== "SUCCESS") throw new Error(`Mirror node reports ${result.result} for ${txId}`);
        const ev = this.chain.deskEvents(result).find((e) => e.name === "NoncesCancelled");
        if (!ev) throw new Error(`Transaction ${txId} succeeded but the desk emitted no NoncesCancelled event.`);
        if ((ev.args.maker as Address).toLowerCase() !== op.evmAddress.toLowerCase() || ev.args.wordPos !== wordPos || ev.args.mask !== mask)
          throw new Error(`NoncesCancelled reports word ${ev.args.wordPos} mask ${ev.args.mask} for ${ev.args.maker}, not what was sent.`);
        const after = await Promise.all(open.map((n) => this.chain.nonceUsed(op.evmAddress, n)));
        const still = open.filter((_, i) => !after[i]);
        if (still.length) throw new Error(`Nonces ${still.join(", ")} still read as unspent after the cancel.`);
        return ok(
          { transactionId: txId, hash: result.hash, account: op.accountId, cancelled: open.map(String), wordPos: wordPos.toString(), mask: mask.toString(), gasUsed: result.gas_used, links: { tx: L.tx(txId), desk: L.contract(this.chain.cfg.desk) } },
          `Cancelled ${open.length} quote nonce(s): ${open.join(", ")}. ${L.tx(txId)}`,
        );
      },
    };
  }
}
