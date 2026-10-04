// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IHRC719 } from "../../contracts/interfaces/IHRC719.sol";
import { ISaucerSwapV2Router } from "../../contracts/interfaces/ISaucerSwapV2.sol";
import { MockHtsToken } from "./MockHtsToken.sol";

/// @notice A SaucerSwap V2 pool as the vault sees it: sorted token0/token1, a fee tier and a settable
/// `sqrtPriceX96` (token1 per token0 in raw units, as Uniswap V3 defines it).
contract MockPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint160 public sqrtPriceX96;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function setSqrtPriceX96(uint160 sqrtPrice) external {
        sqrtPriceX96 = sqrtPrice;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 1, 1, 0, true);
    }
}

/// @notice SaucerSwap V2 router on a single-hop `tokenIn | fee | tokenOut` path. It prices the swap from the
/// registered pool's `sqrtPriceX96`, takes the pool fee off the output, and applies `haircutBps` on top so a test
/// can make the market worse than the spot the caller read. It pulls `tokenIn` with `transferFrom` and mints
/// `tokenOut` to the recipient. It reverts with SaucerSwap's own "Too little received" below `amountOutMinimum`.
contract MockRouter is ISaucerSwapV2Router {
    uint256 private constant Q96 = 2 ** 96;

    mapping(address tokenIn => mapping(address tokenOut => mapping(uint24 fee => address))) public poolFor;
    uint256 public haircutBps;
    uint256 public swapCount;
    bytes public lastPath;
    uint256 public lastAmountIn;
    uint256 public lastAmountOutMinimum;

    function registerPool(address pool) external {
        MockPool p = MockPool(pool);
        poolFor[p.token0()][p.token1()][p.fee()] = pool;
        poolFor[p.token1()][p.token0()][p.fee()] = pool;
        // A router must be associated with a token before it can take it in (HTS rule).
        IHRC719(p.token0()).associate();
        IHRC719(p.token1()).associate();
    }

    function setHaircutBps(uint256 bps) external {
        haircutBps = bps;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp <= params.deadline, "Transaction too old");
        require(params.path.length == 43, "single hop only");
        address tokenIn = address(bytes20(params.path[:20]));
        uint24 fee = uint24(bytes3(params.path[20:23]));
        address tokenOut = address(bytes20(params.path[23:]));
        MockPool pool = MockPool(poolFor[tokenIn][tokenOut][fee]);
        require(address(pool) != address(0), "no pool");

        uint160 sqrtPrice = pool.sqrtPriceX96();
        amountOut = tokenIn == pool.token0()
            ? Math.mulDiv(Math.mulDiv(params.amountIn, sqrtPrice, Q96), sqrtPrice, Q96)
            : Math.mulDiv(Math.mulDiv(params.amountIn, Q96, sqrtPrice), Q96, sqrtPrice);
        amountOut = amountOut * (1_000_000 - fee) / 1_000_000;
        amountOut = amountOut * (10_000 - haircutBps) / 10_000;
        require(amountOut >= params.amountOutMinimum, "Too little received");

        ++swapCount;
        lastPath = params.path;
        lastAmountIn = params.amountIn;
        lastAmountOutMinimum = params.amountOutMinimum;
        require(MockHtsToken(tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "pull failed");
        MockHtsToken(tokenOut).mint(params.recipient, amountOut);
    }
}

/// @notice The SaucerSwap V2 factory: the one place that says which pool is canonical for a pair and fee.
contract MockFactory {
    mapping(address tokenA => mapping(address tokenB => mapping(uint24 fee => address))) public getPool;

    function registerPool(address pool) external {
        MockPool p = MockPool(pool);
        getPool[p.token0()][p.token1()][p.fee()] = pool;
        getPool[p.token1()][p.token0()][p.fee()] = pool;
    }
}

/// @notice SaucerSwap's WhbarHelper: `deposit()` credits the caller with WHBAR 1:1 for the HBAR sent (tinybars).
contract MockWhbarHelper {
    MockHtsToken public immutable whbar;
    uint256 public depositCount;

    constructor(address whbar_) {
        whbar = MockHtsToken(whbar_);
    }

    function deposit() external payable {
        ++depositCount;
        whbar.mint(msg.sender, msg.value);
    }
}

/// @notice Chainlink AggregatorV3 for HBAR/USD, 8 decimals.
contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public decimals = 8;

    function setDecimals(uint8 decimals_) external {
        decimals = decimals_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
