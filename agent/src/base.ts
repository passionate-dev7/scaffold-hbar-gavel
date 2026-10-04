import {
  BaseQueryTool,
  BaseTransactionTool,
  type Context,
  type RawTransactionResponse,
  handleTransaction,
  isReturnBytesMode,
  transactionToolOutputParser,
  untypedQueryOutputParser,
} from "@hashgraph/hedera-agent-kit";
import { ContractExecuteTransaction, ContractId, Hbar, type Client, type Transaction } from "@hiero-ledger/sdk";
import { type Address, type Hex, hexToBytes } from "viem";
import type { DeskReader } from "./chain";
import { entityNum, linkBuilder, mirrorTxId } from "./links";

export type Envelope = { raw: Record<string, unknown>; humanMessage: string };
/** A write tool's plan: the transaction to send, an optional approval to send first, and how to prove it worked. */
export type TxPlan = {
  tx: Transaction;
  summary: Record<string, unknown>;
  pre?: { tx: Transaction; label: string; verify: () => Promise<void> };
  finish: (txId: string) => Promise<Envelope>;
};
export const isPlan = (r: Envelope | TxPlan): r is TxPlan => "tx" in r;

export const ok = (raw: Record<string, unknown>, humanMessage: string): Envelope => ({ raw: { ...raw, status: "SUCCESS" }, humanMessage });
/** A refused write: nothing was sent. status is ERROR so callers classify it as a failure, `blocked` says why. */
export const blocked = (reasons: string[], raw: Record<string, unknown> = {}): Envelope => ({
  raw: { ...raw, status: "ERROR", blocked: true, reasons },
  humanMessage: `Not sent: ${reasons.join(" ")}`,
});
export const noop = (reason: string, raw: Record<string, unknown> = {}): Envelope => ({ raw: { ...raw, status: "SUCCESS", noop: true, reason }, humanMessage: reason });

/** Gas limits per call. Hedera bills gas used but checks the payer against the whole limit. */
export const GAS = { postOrder: 5_000_000, fill: 3_000_000, cancel: 2_000_000, cancelNonces: 1_000_000, approve: 1_500_000 } as const;

export function toContractId(address: Address): ContractId {
  const num = entityNum(address);
  return num === null ? ContractId.fromEvmAddress(0, 0, address) : ContractId.fromString(`0.0.${num}`);
}

/** A ContractExecuteTransaction for already-encoded calldata, optionally carrying HBAR (in tinybar). */
export function contractCall(target: Address, data: Hex, gas: number, tinybar?: bigint): ContractExecuteTransaction {
  const tx = new ContractExecuteTransaction().setContractId(toContractId(target)).setGas(gas).setFunctionParameters(hexToBytes(data)).setMaxTransactionFee(new Hbar(15));
  if (tinybar !== undefined) tx.setPayableAmount(Hbar.fromTinybars(tinybar.toString()));
  return tx;
}

/** The account the agent acts as: the Context account (return-bytes setups), else the client's operator, else null. */
export function defaultAccount(client: Client, context: Context): string | null {
  return context.accountId ?? client.operatorAccountId?.toString() ?? null;
}

export async function requireOperator(chain: DeskReader, client: Client, context: Context) {
  const id = defaultAccount(client, context);
  if (!id) throw new Error("This tool signs as the agent's account, but the client has no operator and the context has no accountId.");
  return chain.account(id);
}

export abstract class DeskQueryTool extends BaseQueryTool {
  outputParser = untypedQueryOutputParser;
  constructor(protected readonly chain: DeskReader) {
    super();
  }
  protected get links() {
    return linkBuilder(this.chain.cfg.hashscanUrl, this.chain.cfg.mirrorUrl);
  }
  async shouldSecondaryAction() {
    return false;
  }
}

export abstract class DeskTxTool extends BaseTransactionTool {
  outputParser = transactionToolOutputParser;
  constructor(protected readonly chain: DeskReader) {
    super();
  }
  protected get links() {
    return linkBuilder(this.chain.cfg.hashscanUrl, this.chain.cfg.mirrorUrl);
  }
  async shouldSecondaryAction(result: Envelope | TxPlan) {
    return isPlan(result);
  }

  async secondaryAction(plan: TxPlan, client: Client, context: Context) {
    const bytesMode = isReturnBytesMode(context.mode);
    if (plan.pre) {
      const pre = await handleTransaction(plan.pre.tx, client, context);
      if (bytesMode) {
        return { ...(pre as object), plan: plan.summary, nextStep: `${plan.pre.label} first. Sign and submit these bytes, then call ${this.method} again for the transaction itself.` };
      }
      const preRaw = (pre as { raw: RawTransactionResponse }).raw;
      await this.chain.waitForResult(mirrorTxId(preRaw.transactionId));
      await plan.pre.verify();
    }
    const res = await handleTransaction(plan.tx, client, context);
    if (bytesMode) return { ...(res as object), plan: plan.summary };
    return plan.finish((res as { raw: RawTransactionResponse }).raw.transactionId);
  }

  /** A failed receipt carries only a status code. Read the mirror node for the desk's own revert reason. */
  async handleError(error: unknown, context: Context) {
    const base = await super.handleError(error, context);
    const txId = base?.raw?.transactionId;
    if (!txId || base.raw.errorCode === undefined) return base;
    try {
      const result = await this.chain.waitForResult(mirrorTxId(txId));
      const revert = this.chain.decodeRevert(result.error_message);
      const raw = { ...base.raw, links: { tx: this.links.tx(txId) }, ...(revert ? { revert } : {}), mirrorResult: result.result };
      return { raw, humanMessage: `${base.humanMessage}${revert ? ` Desk revert: ${revert.name}(${revert.args.join(", ")}).` : ""} ${this.links.tx(txId)}` };
    } catch (lookup) {
      return { ...base, raw: { ...base.raw, links: { tx: this.links.tx(txId) }, revertLookupError: String(lookup) } };
    }
  }
}
