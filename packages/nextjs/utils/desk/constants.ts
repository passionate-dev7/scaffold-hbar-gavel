import { type Address, parseAbi } from "viem";
import { hederaTestnet } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";

/** The only place the product's display name lives. */
export const PRODUCT_NAME = "Backstop";

export const CHAIN_ID = hederaTestnet.id;

const deployed = deployedContracts[CHAIN_ID].BackstopDesk;

export const DESK_ABI = deployed.abi;
export const DESK_ADDRESS = deployed.address as Address;

/** HCS topic the makers publish signed quotes to. */
export const QUOTE_TOPIC_ID = process.env.NEXT_PUBLIC_QUOTE_TOPIC_ID || "0.0.10860170";

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** IHRC719: every HTS token answers `associate()` at its own address, for msg.sender. Returns an HTS response code. */
export const HRC719_ABI = parseAbi(["function associate() returns (int64)"]);

/** SaucerSwap V2 is a Uniswap V3 fork: the factory names the pool, the pool's slot0 holds the spot price. */
export const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
export const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

/** HTS response codes the associate step accepts. */
export const HTS_SUCCESS = 22n;
export const HTS_ALREADY_ASSOCIATED = 194n;

/** Contract-side HBAR is tinybars (8 decimals); the JSON-RPC layer counts weibars (18 decimals). */
export const TINYBAR_DECIMALS = 8;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

export type DeskToken = { address: Address; symbol: string; decimals: number };

/** HTS decimals are fixed at token creation; ids are 0.0.15058, 0.0.5449 and 0.0.1183558 on the mirror node. */
export const WHBAR: DeskToken = {
  address: "0x0000000000000000000000000000000000003aD2",
  symbol: "WHBAR",
  decimals: 8,
};
export const USDC: DeskToken = { address: "0x0000000000000000000000000000000000001549", symbol: "USDC", decimals: 6 };
export const SAUCE: DeskToken = { address: "0x0000000000000000000000000000000000120f46", symbol: "SAUCE", decimals: 6 };

export const TOKENS: readonly DeskToken[] = [WHBAR, USDC, SAUCE];

export const tokenOf = (address: string): DeskToken | undefined =>
  TOKENS.find(t => t.address.toLowerCase() === address.toLowerCase());

/** Pools the desk can price: HBAR in, one token out, at the 0.30% SaucerSwap V2 tier. */
export const PAIRS = [
  { id: "usdc", tokenIn: WHBAR, tokenOut: USDC, fee: 3000 },
  { id: "sauce", tokenIn: WHBAR, tokenOut: SAUCE, fee: 3000 },
] as const;
export type Pair = (typeof PAIRS)[number];

export const STATUS = ["Open", "Filled", "FellBack", "Cancelled", "Refunded"] as const;
export type StatusName = (typeof STATUS)[number];

/**
 * Gas floors per call. hashio's estimates undershoot HTS-heavy calls, so a final limit is max(1.25 x estimate, floor).
 * Hedera bills gas used but checks the payer's balance against the whole limit.
 */
export const GAS_FLOOR = {
  associate: 1_000_000n,
  post: 5_000_000n, // associates tokenIn, wraps, books the schedule (~1.4M reserved)
  fill: 3_000_000n,
  cancel: 1_000_000n, // includes deleteSchedule
  claim: 1_000_000n,
} as const;

export const GAS_CAP = 14_000_000n;

export const SLIPPAGE_OPTIONS_BPS = [50, 100, 300] as const;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const BPS = 10_000n;

export const TTL_OPTIONS = [
  { label: "2 min", seconds: 120 },
  { label: "10 min", seconds: 600 },
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86_400 },
] as const;

export const POLL_MS = 15_000;
