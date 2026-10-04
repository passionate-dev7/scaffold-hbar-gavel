import { type Address, parseAbi, zeroAddress } from "viem";
import { hederaTestnet } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";

export const CHAIN_ID = hederaTestnet.id;

const deployed = deployedContracts[CHAIN_ID].BasketVault;
export const VAULT_ABI = deployed.abi;
export const VAULT_ADDRESS = deployed.address as Address;
export const IS_DEPLOYED = VAULT_ADDRESS.toLowerCase() !== zeroAddress;

export const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** IHRC719: every HTS token answers `associate()` at its own address, for msg.sender. Returns an HTS response code. */
export const HRC719_ABI = parseAbi(["function associate() returns (int64)"]);

export const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** HTS response codes the associate step accepts. */
export const HTS_SUCCESS = 22n;
export const HTS_ALREADY_ASSOCIATED = 194n;

export const SHARE_DECIMALS = 8;
export const WHBAR_DECIMALS = 8;
export const USD_DECIMALS = 8;
/** Contract-side HBAR is tinybars (8 decimals); the JSON-RPC layer counts weibars (18 decimals). */
export const TINYBAR_DECIMALS = 8;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/**
 * Gas floors per call. hashio's estimates undershoot HTS-heavy calls (rebalance 117k, deposit 444k
 * against the 4M, 4M and 1M limits the live testnet script ran with), so a final limit is max(1.25 x estimate, floor).
 * Hedera bills gas used but checks the payer's balance against the whole limit.
 */
export const GAS_FLOOR = {
  associate: 1_000_000n,
  approve: 1_000_000n,
  deposit: 4_000_000n,
  redeem: 3_000_000n,
  rebalance: 4_000_000n,
  rearm: 2_000_000n, // scheduleCall reserves ~1.4M
  startAutomation: 3_000_000n,
  stopAutomation: 500_000n, // measured 99,452 on testnet, including deleteSchedule
  withdrawFuel: 200_000n, // measured 31,143
  topUp: 150_000n,
} as const;
export const GAS_CAP = 14_000_000n;

export const DEFAULT_SLIPPAGE_BPS = 300;
export const BPS = 10_000n;
export const POLL_MS = 15_000;
