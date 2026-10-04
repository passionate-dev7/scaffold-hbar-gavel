import { BaseError, ContractFunctionRevertedError } from "viem";

const REVERT_TEXT: Record<string, string> = {
  ZeroAmount: "Enter an amount above zero.",
  BadTtl: "That time to live is outside the range the desk accepts.",
  SameToken: "Pick two different tokens.",
  NoPool: "SaucerSwap has no pool for that pair and fee tier, so the desk cannot guarantee a fallback.",
  InsufficientValue: "The HBAR sent does not cover the amount plus the desk's fuel for the scheduled fallback.",
  ScheduleFailed: "Hedera refused to book the fallback schedule, so the desk refused the order. Try again in a moment.",
  HtsCallFailed: "A Hedera Token Service call inside the desk failed.",
  TransferFailed: "A token transfer inside the desk failed. Check that you are associated with the output token.",
  NotOpen: "That order is no longer open.",
  UnknownOrder: "No order has that id.",
  OrderExpired: "The order passed its expiry. The scheduled fallback settles it.",
  QuoteExpired: "That quote's deadline has passed.",
  BadSignature: "The quote's signature does not recover to its maker.",
  NonceAlreadyUsed: "That quote was already used or cancelled by its maker.",
  QuoteBelowMin: "That quote pays less than the order's minimum.",
  QuoteOutsideBand: "That quote is outside the Chainlink band the desk enforces for HBAR against USDC.",
  StaleOracle: "The Chainlink HBAR/USD feed is older than the desk allows, so quotes cannot be checked right now.",
  BadOraclePrice: "Chainlink returned a non-positive HBAR/USD answer.",
  OnlyTaker: "Only the account that posted the order can do that.",
  CustomFees: "That token charges custom fees, which the desk does not escrow.",
  UnexpectedReceived: "The token delivered a different amount than the desk asked it to move.",
  Insolvent: "The desk would be left short of what it owes. The call was refused.",
  NothingToClaim: "There is nothing to claim on that order.",
};

/** Name of the custom error a call reverted with, when the node returned revert data. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(e => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

export function explainError(error: unknown): string {
  const name = revertName(error);
  if (name) return REVERT_TEXT[name] ?? `The desk reverted with ${name}.`;
  const code = (error as { code?: number } | undefined)?.code;
  const text = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : "";
  if (code === 4001 || /user rejected|user denied/i.test(text)) return "Rejected in the wallet.";
  return text || "The transaction failed.";
}
