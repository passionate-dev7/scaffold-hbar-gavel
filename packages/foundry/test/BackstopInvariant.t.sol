// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { StdInvariant } from "forge-std/StdInvariant.sol";
import { Test } from "forge-std/Test.sol";

import { BackstopDesk } from "../contracts/BackstopDesk.sol";
import { MockHss } from "./mocks/MockHederaSystem.sol";
import { BackstopBase } from "./BackstopBase.sol";

/// Drives BackstopDesk through random sequences of posts (native and token funded, to takers that can and cannot
/// receive tokens), maker fills, cancels, network runs of the booked fallbacks (with a router that sometimes pays too
/// little), rearms, claims and time warps.
///
/// A reverting handler call is discarded by the fuzzer, so every action first checks that it can succeed and the
/// reach counters, asserted in `test_handlerReachesEveryAction`, prove each path executes.
contract BackstopHandler is BackstopBase {
    address[] internal takers;
    mapping(uint256 id => BackstopDesk.Status) internal seen;
    uint256 public ghostFuelKept;
    uint256 public ghostFuelRefunded;
    bool public statusWentBackwards;
    bool public scheduledRunReverted;

    uint256 public posts;
    uint256 public tokenPosts;
    uint256 public fills;
    uint256 public cancels;
    uint256 public fallbacks;
    uint256 public refunds;
    uint256 public unpaidRefunds;
    uint256 public claims;
    uint256 public rearms;
    uint256 public nonce;

    constructor() {
        setUp();
        // WHBAR's real supply dwarfs a handler run; keep the router allowance from running dry.
        whbar.mint(keeper, 1_000_000_000e8);
        usdc.mint(keeper, 1_000_000_000e6);
        takers.push(taker);
        takers.push(makeAddr("taker2"));
        address stranger = makeAddr("unassociated"); // cannot receive WHBAR or USDC until it claims
        vm.deal(stranger, 1_000_000e18);
        takers.push(stranger);
        vm.deal(takers[1], 1_000_000e18);
        vm.startPrank(takers[1]);
        whbar.associate();
        usdc.associate();
        vm.stopPrank();
    }

    function takerAt(uint256 i) external view returns (address) {
        return takers[i];
    }

    function deskAddr() external view returns (BackstopDesk) {
        return desk;
    }

    // ------------------------------------------------------------ actions

    function post(uint256 who, uint256 amount, uint256 extraFuel) external {
        address t = takers[who % takers.length];
        amount = bound(amount, 1e8, 500e8);
        extraFuel = bound(extraFuel, 0, 3e8);
        vm.prank(t);
        desk.postOrder{ value: amount + FUEL + extraFuel }(
            WHBAR_ADDR, USDC_ADDR, FEE, amount, amount / 5 * 95 / 100, TTL
        );
        ++posts;
        _track();
    }

    function postToken(uint256 who, uint256 amount) external {
        address t = takers[who % takers.length];
        amount = bound(amount, 1e6, 100e6);
        // the unassociated taker cannot hold USDC, so it only posts in native HBAR
        if (!usdc.associated(t)) return;
        usdc.mint(t, amount);
        vm.startPrank(t);
        usdc.approve(address(desk), amount);
        desk.postOrder{ value: FUEL }(USDC_ADDR, WHBAR_ADDR, FEE, amount, amount * 500 * 90 / 100, TTL);
        vm.stopPrank();
        ++tokenPosts;
        _track();
    }

    function fill(uint256 pick, uint256 bonus) external {
        uint256 id = _pickOpen(pick);
        if (id == 0) return;
        BackstopDesk.Order memory o = desk.getOrder(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= o.expiry) return;
        bonus = bound(bonus, 0, 1e6);
        uint256 floor = o.tokenOut == USDC_ADDR ? (o.amountIn * 97 / 500) : o.minOut;
        uint256 amountOut = (floor > o.minOut ? floor : o.minOut) + bonus;
        if (o.tokenOut == WHBAR_ADDR) {
            // reverse direction: the oracle implies amountIn(6dp) * 5 HBAR, in tinybar
            amountOut = o.amountIn * 500 * 97 / 100 + bonus;
            whbar.mint(maker, amountOut);
            vm.prank(maker);
            whbar.approve(address(desk), type(uint256).max);
        }
        BackstopDesk.Quote memory q = _quote(amountOut, ++nonce);
        bytes memory sig = _sign(makerPk, id, q);
        // a taker that is not associated with tokenOut cannot be paid; skip rather than revert
        if (o.tokenOut == USDC_ADDR && !usdc.associated(o.taker)) return;
        if (o.tokenOut == WHBAR_ADDR && !whbar.associated(o.taker)) return;
        vm.prank(o.taker);
        desk.fillWithQuote(id, q, sig);
        ghostFuelRefunded += o.fuel;
        ++fills;
        _track();
    }

    function cancel(uint256 pick) external {
        uint256 id = _pickOpen(pick);
        if (id == 0) return;
        BackstopDesk.Order memory o = desk.getOrder(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= o.expiry) return;
        if (!(o.tokenIn == WHBAR_ADDR ? whbar.associated(o.taker) : usdc.associated(o.taker))) return;
        vm.prank(o.taker);
        desk.cancel(id);
        ghostFuelRefunded += o.fuel;
        ++cancels;
        _track();
    }

    /// The network runs the oldest unsettled schedule, sometimes against a router that pays 10% short.
    function runNetwork(uint256 pick, bool badMarket) external {
        uint256 n = hss.callCount();
        if (n == 0) return;
        uint256 index = pick % n;
        MockHss.ScheduledCall memory c = hss.callAt(index);
        if (hss.deleted(c.schedule)) return;
        uint256 id = _idOfCall(c.callData);
        BackstopDesk.Order memory before = desk.getOrder(id);
        router.setHaircutBps(badMarket ? 1_000 : 0);
        (bool ran, bool ok,) = _runSchedule(index);
        router.setHaircutBps(0);
        if (!ran) return;
        if (!ok) scheduledRunReverted = true;
        BackstopDesk.Order memory after_ = desk.getOrder(id);
        if (before.status == BackstopDesk.Status.Open) {
            ghostFuelKept += before.fuel;
            ++fallbacks;
            if (after_.status == BackstopDesk.Status.Refunded) {
                ++refunds;
                if (after_.claimable != 0) ++unpaidRefunds;
            }
        }
        _track();
    }

    function claim(uint256 pick) external {
        uint256 count = desk.orderCount();
        if (count == 0) return;
        uint256 id = 1 + pick % count;
        BackstopDesk.Order memory o = desk.getOrder(id);
        if (o.claimable == 0) return;
        // the unassociated taker associates, then claims
        vm.startPrank(o.taker);
        if (o.tokenIn == WHBAR_ADDR) whbar.associate();
        else usdc.associate();
        desk.claim(id);
        vm.stopPrank();
        ++claims;
        _track();
    }

    function rearm(uint256 pick) external {
        uint256 id = _pickOpen(pick);
        if (id == 0) return;
        BackstopDesk.Order memory o = desk.getOrder(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < o.expiry + desk.RETRY_GRACE() || o.rearms >= desk.MAX_REARMS()) return;
        desk.rearm(id);
        ++rearms;
        _track();
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1, 400);
        vm.warp(block.timestamp + secs);
        feed.set(HBAR_USD, block.timestamp);
    }

    // ------------------------------------------------------------ helpers

    function _pickOpen(uint256 pick) internal view returns (uint256) {
        uint256 count = desk.orderCount();
        if (count == 0) return 0;
        for (uint256 k; k < count; ++k) {
            uint256 id = 1 + (pick % count + k) % count;
            if (desk.getOrder(id).status == BackstopDesk.Status.Open) return id;
        }
        return 0;
    }

    function _idOfCall(bytes memory data) internal pure returns (uint256 id) {
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
        id = abi.decode(args, (uint256));
    }

    function _track() internal {
        uint256 count = desk.orderCount();
        for (uint256 id = 1; id <= count; ++id) {
            BackstopDesk.Status s = desk.getOrder(id).status;
            // Open (0) may move to anything; a settled order never changes state again, except Refunded -> Refunded.
            if (seen[id] != BackstopDesk.Status.Open && seen[id] != s) statusWentBackwards = true;
            seen[id] = s;
        }
    }

    function sumOpen(address token) external view returns (uint256 total) {
        uint256 count = desk.orderCount();
        for (uint256 id = 1; id <= count; ++id) {
            BackstopDesk.Order memory o = desk.getOrder(id);
            if (o.tokenIn == token && o.status == BackstopDesk.Status.Open) total += o.amountIn;
        }
    }

    function sumClaimable(address token) external view returns (uint256 total) {
        uint256 count = desk.orderCount();
        for (uint256 id = 1; id <= count; ++id) {
            BackstopDesk.Order memory o = desk.getOrder(id);
            if (o.tokenIn == token) total += o.claimable;
        }
    }

    function sumOpenFuel() external view returns (uint256 total) {
        uint256 count = desk.orderCount();
        for (uint256 id = 1; id <= count; ++id) {
            BackstopDesk.Order memory o = desk.getOrder(id);
            if (o.status == BackstopDesk.Status.Open) total += o.fuel;
        }
    }

    function openWithoutLiveSchedule() external view returns (uint256 bad) {
        uint256 count = desk.orderCount();
        for (uint256 id = 1; id <= count; ++id) {
            BackstopDesk.Order memory o = desk.getOrder(id);
            if (o.status == BackstopDesk.Status.Open && (o.schedule == address(0) || hss.deleted(o.schedule))) ++bad;
            if (
                (o.status == BackstopDesk.Status.Filled || o.status == BackstopDesk.Status.Cancelled)
                    && o.schedule != address(0)
            ) {
                ++bad;
            }
        }
    }
}

contract BackstopInvariantTest is StdInvariant, Test {
    BackstopHandler internal h;
    BackstopDesk internal desk;
    address internal constant WHBAR_ADDR = address(0x3ad2);
    address internal constant USDC_ADDR = address(0x1549);

    function setUp() public {
        h = new BackstopHandler();
        desk = h.deskAddr();
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = BackstopHandler.post.selector;
        selectors[1] = BackstopHandler.postToken.selector;
        selectors[2] = BackstopHandler.fill.selector;
        selectors[3] = BackstopHandler.cancel.selector;
        selectors[4] = BackstopHandler.runNetwork.selector;
        selectors[5] = BackstopHandler.claim.selector;
        selectors[6] = BackstopHandler.rearm.selector;
        selectors[7] = BackstopHandler.warp.selector;
        targetSelector(FuzzSelector({ addr: address(h), selectors: selectors }));
    }

    /// The headline: escrow held equals the open orders plus unclaimed refunds, for every token the desk holds.
    function invariant_escrowEqualsOpenOrdersPlusUnclaimed() public view {
        assertEq(desk.escrowed(WHBAR_ADDR), h.sumOpen(WHBAR_ADDR) + h.sumClaimable(WHBAR_ADDR));
        assertEq(desk.escrowed(USDC_ADDR), h.sumOpen(USDC_ADDR) + h.sumClaimable(USDC_ADDR));
    }

    /// The tokens the desk actually holds are exactly that escrow: nothing leaks to a maker or taker.
    function invariant_balancesEqualEscrow() public view {
        assertEq(IBal(WHBAR_ADDR).balanceOf(address(desk)), desk.escrowed(WHBAR_ADDR));
        assertEq(IBal(USDC_ADDR).balanceOf(address(desk)), desk.escrowed(USDC_ADDR));
    }

    /// Native HBAR in the desk is the fuel of open orders plus the fuel fallbacks kept, and nothing else.
    function invariant_fuelIsAccountedFor() public view {
        assertEq(address(desk).balance, h.sumOpenFuel() + h.ghostFuelKept());
    }

    function invariant_everyOpenOrderHasALiveSchedule() public view {
        assertEq(h.openWithoutLiveSchedule(), 0);
    }

    function invariant_settledOrdersStaySettled() public view {
        assertFalse(h.statusWentBackwards());
    }

    function invariant_theScheduledPathNeverReverts() public view {
        assertFalse(h.scheduledRunReverted());
    }

    /// Without this the invariants above could pass on a handler that never reaches the desk.
    function test_handlerReachesEveryAction() public {
        h.post(0, 100e8, 0);
        h.post(1, 50e8, 2e8);
        h.postToken(0, 20e6);
        h.fill(0, 5);
        h.cancel(1);
        h.warp(200);
        h.runNetwork(2, false);
        // an unassociated taker's order falls back against a bad market and leaves a claimable refund
        h.post(2, 80e8, 0);
        h.runNetwork(3, true);
        h.claim(3);
        h.post(0, 60e8, 0);
        h.warp(400);
        h.warp(400);
        h.rearm(3);
        assertGt(h.posts(), 0);
        assertGt(h.tokenPosts(), 0);
        assertGt(h.fills(), 0);
        assertGt(h.cancels(), 0);
        assertGt(h.fallbacks(), 0);
        assertGt(h.refunds(), 0);
        assertGt(h.unpaidRefunds(), 0);
        assertGt(h.claims(), 0);
        assertGt(h.rearms(), 0);
        assertEq(h.sumOpenFuel() + h.ghostFuelKept(), address(desk).balance);
    }
}

interface IBal {
    function balanceOf(address) external view returns (uint256);
}
