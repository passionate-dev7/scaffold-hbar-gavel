import { BaseError, ContractFunctionRevertedError } from "viem";

const REVERT_TEXT: Record<string, string> = {
  StaleOracle: "Chainlink HBAR/USD is older than the vault allows. Deposits and rebalances wait for the next update.",
  BadOraclePrice: "Chainlink returned a non-positive HBAR/USD answer.",
  PoolPriceDeviates: "The stablecoin pool price disagrees with Chainlink beyond the guard. Try again later.",
  InsufficientShares: "That deposit would mint fewer shares than your minimum. Raise slippage or retry.",
  ZeroAmount: "Enter an amount above zero.",
  NotInitialized: "The vault has not created its share token yet.",
  HtsCallFailed: "A Hedera Token Service call inside the vault failed.",
  TransferFailed: "A token transfer inside the vault failed. Check that you are associated with every basket token.",
  AutomationActive: "Automation is already running. Stop it before starting with a new interval.",
  BadInterval: "Interval is outside the vault's allowed range.",
  ScheduleFailed: "Hedera refused to book the schedule. Check the vault's fuel balance.",
  OnlyOwnerOrSelf: "Only the vault owner or the vault's own schedule can rebalance.",
  NotAutomated: "Automation is off, so there is no run to book.",
  RunAlreadyPending: "A run is already booked. Nothing to do.",
  BadSkipMask: "That skip selection names a token the basket does not have.",
  OwnableUnauthorizedAccount: "Only the vault owner can do that.",
};

/** Name of the custom error a call reverted with, when the node returned revert data. */
export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(e => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
}

export function explainError(error: unknown): string {
  const name = revertName(error);
  if (name) return REVERT_TEXT[name] ?? `The vault reverted with ${name}.`;
  const code = (error as { code?: number } | undefined)?.code;
  const text = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : "";
  if (code === 4001 || /user rejected|user denied/i.test(text)) return "Rejected in the wallet.";
  return text || "The transaction failed.";
}
