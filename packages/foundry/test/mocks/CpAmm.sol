// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ISaucerSwapV2Router } from "../../contracts/interfaces/ISaucerSwapV2.sol";
import { IHRC719 } from "../../contracts/interfaces/IHRC719.sol";
import { MockHtsToken } from "../mocks/MockHtsToken.sol";

/// Full-range constant-product pool exposed through a V3-shaped slot0. Price impact is real: every swap moves
/// the reserves and therefore sqrtPriceX96. The fee stays in the pool (k grows).
contract CpPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint256 public r0;
    uint256 public r1;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function setReserves(uint256 a0, uint256 a1) external {
        r0 = a0;
        r1 = a1;
    }

    function sqrtPriceX96() public view returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(r1, uint256(1) << 192, r0)));
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96(), 0, 0, 1, 1, 0, true);
    }

    function quote(address tokenIn, uint256 amountIn) public view returns (uint256) {
        (uint256 rin, uint256 rout) = tokenIn == token0 ? (r0, r1) : (r1, r0);
        uint256 inAf = amountIn * (1_000_000 - fee) / 1_000_000;
        return rout * inAf / (rin + inAf);
    }

    function swap(address tokenIn, uint256 amountIn) external returns (uint256 out) {
        out = quote(tokenIn, amountIn);
        if (tokenIn == token0) {
            r0 += amountIn;
            r1 -= out;
        } else {
            r1 += amountIn;
            r0 -= out;
        }
    }
}

contract CpRouter is ISaucerSwapV2Router {
    mapping(address => mapping(address => address)) public poolFor;

    function registerPool(CpPool p) external {
        poolFor[p.token0()][p.token1()] = address(p);
        poolFor[p.token1()][p.token0()] = address(p);
        IHRC719(p.token0()).associate();
        IHRC719(p.token1()).associate();
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        // forge-lint: disable-next-line(block-timestamp)
        require(block.timestamp <= params.deadline, "Transaction too old");
        address tokenIn = address(bytes20(params.path[:20]));
        address tokenOut = address(bytes20(params.path[23:]));
        CpPool pool = CpPool(poolFor[tokenIn][tokenOut]);
        amountOut = pool.swap(tokenIn, params.amountIn);
        require(amountOut >= params.amountOutMinimum, "Too little received");
        require(MockHtsToken(tokenIn).transferFrom(msg.sender, address(this), params.amountIn), "pull failed");
        MockHtsToken(tokenOut).mint(params.recipient, amountOut);
    }
}
