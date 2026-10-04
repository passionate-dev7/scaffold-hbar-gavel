import { parseAbi } from "viem";

export const deskAbi = parseAbi([
  "struct Order { address taker; address tokenIn; address tokenOut; uint24 fee; uint256 amountIn; uint256 minOut; uint64 expiry; address schedule; uint8 status; uint8 rearms; uint256 fuel; uint256 claimable; }",
  "struct Quote { address maker; uint256 amountOut; uint64 deadline; uint256 nonce; }",
  "event OrderPosted(uint256 indexed id, address indexed taker, address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut, uint64 expiry, address schedule, uint256 fallbackAt)",
  "function factory() view returns (address)",
  "function getOrder(uint256 id) view returns (Order)",
  "function oracleFloor(uint256 id) view returns (uint256)",
  "function quoteDigest(uint256 id, Quote quote) view returns (bytes32)",
  "function nonceUsed(address maker, uint256 nonce) view returns (bool)",
  "function fillWithQuote(uint256 id, Quote quote, bytes signature)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const factoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);

export const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
