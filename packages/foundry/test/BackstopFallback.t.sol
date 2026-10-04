// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Vm } from "forge-std/Vm.sol";

import { BackstopDesk } from "../contracts/BackstopDesk.sol";
import { ISaucerSwapV2Router } from "../contracts/interfaces/ISaucerSwapV2.sol";
import { MockHss } from "./mocks/MockHederaSystem.sol";
import { MockHtsToken } from "./mocks/MockHtsToken.sol";
import { MockPool } from "./mocks/MockSaucerSwap.sol";
import { BackstopBase } from "./BackstopBase.sol";

/// A router that burns every unit of gas it is given.
contract GasBurnRouter is ISaucerSwapV2Router {
    function exactInput(ExactInputParams calldata) external payable returns (uint256) {
        assembly {
            invalid()
        }
    }
}

/// A router that reverts with a payload far too big to copy.
contract ReturnBombRouter is ISaucerSwapV2Router {
    function exactInput(ExactInputParams calldata) external payable returns (uint256) {
        assembly {
            revert(0, 500000)
        }
    }
}

/// An HTS token whose transfer is expensive, like a Token Service transfer under load.
contract HeavyToken is MockHtsToken {
    constructor() MockHtsToken("Heavy", "HVY", 6) { }

    function transfer(address to, uint256 value) public override returns (bool) {
        uint256 start = gasleft();
        while (start - gasleft() < 150_000) { }
        return super.transfer(to, value);
    }
}

contract BackstopFallbackTest is BackstopBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _post();
    }

    /// WHBAR -> USDC at the fixture's pool: 100 HBAR is 20 USDC less the 0.30% pool fee, to within a unit of sqrt
    /// rounding.
    uint256 internal constant SWAP_OUT = 19_940_000;

    function _expectedStatus(BackstopDesk.Status s) internal view returns (bool) {
        return _status(id) == s;
    }

    // ------------------------------------------------------------ the swap succeeds

    function test_fallback_swapsTheEscrowAndPaysTheTaker() public {
        uint256 takerUsdc = usdc.balanceOf(taker);
        vm.recordLogs();
        (bool ran, bool ok,) = _runSchedule(0);
        assertTrue(ran);
        assertTrue(ok);
        uint256 got = usdc.balanceOf(taker) - takerUsdc;
        assertApproxEqAbs(got, SWAP_OUT, 1, "the taker holds the tokenOut");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 i = _indexOf(logs, keccak256("FellBack(uint256,uint256)"));
        assertTrue(i != type(uint256).max, "FellBack was emitted");
        assertEq(abi.decode(logs[i].data, (uint256)), got, "the event reports what the taker received");
        assertEq(whbar.balanceOf(address(desk)), 0, "the escrow was spent");
        assertEq(desk.escrowed(WHBAR_ADDR), 0);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.FellBack));
    }

    function test_fallback_swapsAtTheTakersOwnFloor() public {
        _runSchedule(0);
        assertEq(router.lastAmountOutMinimum(), MIN_OUT, "amountOutMinimum is the order's minOut");
        assertEq(router.lastAmountIn(), AMOUNT_IN);
        assertEq(router.lastPath(), abi.encodePacked(WHBAR_ADDR, FEE, USDC_ADDR));
    }

    function test_fallback_keepsTheFuelBecauseTheRunWasPaidFor() public {
        _runSchedule(0);
        assertEq(address(desk).balance, FUEL);
    }

    function test_fallback_approvesTheRouterOnceForTheTokensSupply() public {
        // WHBAR's real supply dwarfs any one order; the fixture's is only what the tests minted.
        whbar.mint(keeper, 1_000_000e8);
        _runSchedule(0);
        assertEq(whbar.approveCount(), 1);
        assertEq(whbar.lastApproveValue(), whbar.totalSupply());
        uint256 second = _post();
        assertEq(second, 2);
        _runSchedule(1);
        assertEq(whbar.approveCount(), 1, "the allowance covers the next order");
    }

    function test_fallback_runsInsideTheBookedGas() public {
        MockHss.ScheduledCall memory c = hss.callAt(0);
        vm.warp(c.expirySecond);
        feed.set(HBAR_USD, block.timestamp);
        vm.prank(c.to);
        uint256 g = gasleft();
        (bool ok,) = c.to.call{ gas: c.gasLimit }(c.callData);
        uint256 used = g - gasleft();
        assertTrue(ok);
        assertLt(used, c.gasLimit / 2, "the mock path is far under the 3M booking");
    }

    function test_fallback_aTokenOrderWorksInTheOtherDirection() public {
        usdc.mint(taker, 20e6);
        vm.startPrank(taker);
        usdc.approve(address(desk), 20e6);
        uint256 rid = desk.postOrder{ value: FUEL }(USDC_ADDR, WHBAR_ADDR, FEE, 20e6, 99e8, TTL);
        vm.stopPrank();
        uint256 before = whbar.balanceOf(taker);
        _runSchedule(1);
        assertEq(uint8(_status(rid)), uint8(BackstopDesk.Status.FellBack));
        assertApproxEqAbs(whbar.balanceOf(taker), before + 20e6 * 500 * 997_000 / 1_000_000, 20_000);
    }

    // ------------------------------------------------------------ the swap fails: refund, never revert

    function test_fallback_refundsWhenThePoolPaysLessThanMinOut() public {
        router.setHaircutBps(1_000);
        uint256 takerWhbar = whbar.balanceOf(taker);
        vm.recordLogs();
        (bool ran, bool ok,) = _runSchedule(0);
        assertTrue(ran);
        assertTrue(ok, "the scheduled call itself must not revert");
        assertEq(whbar.balanceOf(taker), takerWhbar + AMOUNT_IN, "the taker gets the escrow back");
        assertEq(usdc.balanceOf(taker), 0);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Refunded));
        assertEq(desk.escrowed(WHBAR_ADDR), 0);
        assertEq(desk.getOrder(id).claimable, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 i = _indexOf(logs, keccak256("Refunded(uint256,bytes)"));
        assertTrue(i != type(uint256).max, "Refunded was emitted");
        bytes memory reason = abi.decode(logs[i].data, (bytes));
        assertEq(reason.length, 64, "reason is the first two words of the revert");
        assertEq(bytes4(reason), bytes4(0x08c379a0), "Error(string): the router's own reason"); // forge-lint: disable-line(unsafe-typecast)
    }

    function test_fallback_refundsWhenTheTakerCannotReceiveTokenOut() public {
        address noUsdc = makeAddr("noUsdc");
        vm.deal(noUsdc, 1_000e18);
        vm.startPrank(noUsdc);
        whbar.associate();
        uint256 nid = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        vm.stopPrank();
        (, bool ok,) = _runSchedule(1);
        assertTrue(ok);
        assertEq(uint8(_status(nid)), uint8(BackstopDesk.Status.Refunded));
        assertEq(whbar.balanceOf(noUsdc), AMOUNT_IN, "the escrow went home instead of vanishing in the router");
    }

    function test_fallback_unpayableRefundStaysClaimable() public {
        router.setHaircutBps(1_000);
        address newcomer = makeAddr("newcomer"); // never associated with WHBAR
        vm.deal(newcomer, 1_000e18);
        vm.prank(newcomer);
        uint256 nid = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        (, bool ok,) = _runSchedule(1);
        assertTrue(ok, "an unpayable refund still does not revert the scheduled call");
        assertEq(uint8(_status(nid)), uint8(BackstopDesk.Status.Refunded));
        assertEq(desk.getOrder(nid).claimable, AMOUNT_IN);
        assertEq(desk.escrowed(WHBAR_ADDR), AMOUNT_IN + AMOUNT_IN, "the unpaid escrow stays on the books");
        assertEq(whbar.balanceOf(address(desk)), desk.escrowed(WHBAR_ADDR), "order 1 open plus the unpaid refund");
    }

    function test_claim_paysOnceTheTakerCanReceive() public {
        router.setHaircutBps(1_000);
        address newcomer = makeAddr("newcomer");
        vm.deal(newcomer, 1_000e18);
        vm.prank(newcomer);
        uint256 nid = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        _runSchedule(1);

        vm.prank(newcomer);
        vm.expectRevert();
        desk.claim(nid);
        assertEq(desk.getOrder(nid).claimable, AMOUNT_IN, "a failed claim changes nothing");

        vm.startPrank(newcomer);
        whbar.associate();
        vm.expectEmit(true, false, false, true);
        emit BackstopDesk.Claimed(nid, AMOUNT_IN);
        desk.claim(nid);
        vm.stopPrank();
        assertEq(whbar.balanceOf(newcomer), AMOUNT_IN);
        assertEq(desk.getOrder(nid).claimable, 0);
        assertEq(desk.escrowed(WHBAR_ADDR), AMOUNT_IN, "only order 1 remains escrowed");

        vm.prank(newcomer);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NothingToClaim.selector, nid));
        desk.claim(nid);
    }

    function test_claim_onlyTheTakerCanClaim() public {
        router.setHaircutBps(1_000);
        address newcomer = makeAddr("newcomer");
        vm.deal(newcomer, 1_000e18);
        vm.prank(newcomer);
        uint256 nid = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        _runSchedule(1);
        vm.prank(keeper);
        vm.expectRevert(BackstopDesk.OnlyTaker.selector);
        desk.claim(nid);
    }

    function test_claim_nothingToClaimOnAnOpenOrder() public {
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NothingToClaim.selector, id));
        desk.claim(id);
    }

    function test_fallback_aRouterThatBurnsAllItsGasStillRefunds() public {
        BackstopDesk.Config memory c = _config();
        c.router = address(new GasBurnRouter());
        BackstopDesk d = _deployDesk(c);
        vm.prank(taker);
        uint256 bid = d.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        uint256 takerWhbar = whbar.balanceOf(taker);
        MockHss.ScheduledCall memory call = hss.callAt(hss.callCount() - 1);
        vm.prank(address(d));
        (bool ok,) = address(d).call{ gas: call.gasLimit }(call.callData);
        assertTrue(ok, "the booked call completes");
        assertEq(uint8(d.getOrder(bid).status), uint8(BackstopDesk.Status.Refunded));
        assertEq(whbar.balanceOf(taker), takerWhbar + AMOUNT_IN);
    }

    /// The swap burns everything it is given and the refund transfer is expensive: the 63/64 rule alone would leave
    /// about 45k gas for it. The desk keeps REFUND_RESERVE back, so the refund still lands instead of becoming a claim.
    function test_fallback_reservesGasForAnExpensiveRefund() public {
        HeavyToken heavy = new HeavyToken();
        MockPool heavyPool = new MockPool(address(heavy), USDC_ADDR, FEE);
        factory.registerPool(address(heavyPool));
        BackstopDesk.Config memory c = _config();
        c.router = address(new GasBurnRouter());
        BackstopDesk d = _deployDesk(c);
        vm.startPrank(taker);
        heavy.associate();
        heavy.mint(taker, 1_000e6);
        heavy.approve(address(d), 1_000e6);
        uint256 hid = d.postOrder{ value: FUEL }(address(heavy), USDC_ADDR, FEE, 1_000e6, 1, TTL);
        vm.stopPrank();
        MockHss.ScheduledCall memory call = hss.callAt(hss.callCount() - 1);
        vm.prank(address(d));
        (bool ok,) = address(d).call{ gas: call.gasLimit }(call.callData);
        assertTrue(ok);
        BackstopDesk.Order memory o = d.getOrder(hid);
        assertEq(uint8(o.status), uint8(BackstopDesk.Status.Refunded));
        assertEq(o.claimable, 0, "the refund was paid, not parked");
        assertEq(heavy.balanceOf(taker), 1_000e6);
    }

    function test_fallback_aRevertPayloadBombCannotStopTheRefund() public {
        BackstopDesk.Config memory c = _config();
        c.router = address(new ReturnBombRouter());
        BackstopDesk d = _deployDesk(c);
        vm.prank(taker);
        uint256 bid = d.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        MockHss.ScheduledCall memory call = hss.callAt(hss.callCount() - 1);
        vm.prank(address(d));
        (bool ok,) = address(d).call{ gas: call.gasLimit }(call.callData);
        assertTrue(ok);
        assertEq(uint8(d.getOrder(bid).status), uint8(BackstopDesk.Status.Refunded));
    }

    // ------------------------------------------------------------ the scheduled path never reverts

    function test_fallback_onlyTheDeskItselfMayCall() public {
        vm.prank(keeper);
        vm.expectRevert(BackstopDesk.OnlySelf.selector);
        desk.fallbackFill(id);
        vm.prank(taker);
        vm.expectRevert(BackstopDesk.OnlySelf.selector);
        desk.swapEscrow(id);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Open));
    }

    function test_fallback_skipsAnOrderThatWasFilled() public {
        _fill(id, 19_500_000, 1);
        uint256 takerUsdc = usdc.balanceOf(taker);
        vm.expectEmit(true, false, false, true);
        emit BackstopDesk.FallbackSkipped(id, BackstopDesk.Status.Filled);
        vm.prank(address(desk));
        desk.fallbackFill(id);
        assertEq(usdc.balanceOf(taker), takerUsdc, "no second payout");
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Filled));
    }

    function test_fallback_skipsAnOrderThatWasCancelled() public {
        vm.prank(taker);
        desk.cancel(id);
        vm.prank(address(desk));
        desk.fallbackFill(id);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Cancelled));
        assertEq(router.swapCount(), 0);
    }

    function test_fallback_skipsAnUnknownOrder() public {
        vm.prank(address(desk));
        desk.fallbackFill(12345);
        assertEq(router.swapCount(), 0);
    }

    function test_fallback_aSecondRunOfTheSameOrderIsANoOp() public {
        _runSchedule(0);
        uint256 swaps = router.swapCount();
        vm.prank(address(desk));
        desk.fallbackFill(id);
        assertEq(router.swapCount(), swaps);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.FellBack));
    }

    function test_fallback_aDeletedScheduleNeverRuns() public {
        vm.prank(taker);
        desk.cancel(id);
        (bool ran,,) = _runSchedule(0);
        assertFalse(ran, "the harness plays the network and the network skips a deleted schedule");
    }

    // ------------------------------------------------------------ rearm

    function test_rearm_booksAFreshFallbackWhenTheFirstOneDidNotSettle() public {
        vm.warp(T0 + TTL + 300);
        feed.set(HBAR_USD, block.timestamp);
        vm.expectEmit(true, false, false, false);
        emit BackstopDesk.Rearmed(id, address(0), 0);
        vm.prank(keeper);
        desk.rearm(id);
        assertEq(hss.callCount(), 2);
        MockHss.ScheduledCall memory c = hss.callAt(1);
        assertEq(c.to, address(desk));
        assertEq(c.expirySecond, T0 + TTL + 300);
        assertEq(c.callData, abi.encodeCall(BackstopDesk.fallbackFill, (id)));
        assertEq(desk.getOrder(id).schedule, c.schedule);
        assertEq(desk.getOrder(id).rearms, 1);
        _runSchedule(1);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.FellBack));
    }

    function test_rearm_tooEarlyReverts() public {
        vm.warp(T0 + TTL + 299);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.CannotRearm.selector, id));
        desk.rearm(id);
        vm.warp(T0 + 10);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.CannotRearm.selector, id));
        desk.rearm(id);
    }

    function test_rearm_isCappedPerOrder() public {
        for (uint256 i; i < 3; ++i) {
            vm.warp(T0 + TTL + 300 + i * 1_000);
            desk.rearm(id);
        }
        vm.warp(T0 + TTL + 300 + 3_000);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.CannotRearm.selector, id));
        desk.rearm(id);
        assertEq(desk.getOrder(id).rearms, 3);
    }

    function test_rearm_settledOrdersCannotBeRearmed() public {
        _runSchedule(0);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NotOpen.selector, id, BackstopDesk.Status.FellBack));
        desk.rearm(id);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.UnknownOrder.selector, 50));
        desk.rearm(50);
    }

    function test_rearm_bothSchedulesRunningSettlesOnce() public {
        vm.warp(T0 + TTL + 300);
        desk.rearm(id);
        _runSchedule(1);
        uint256 swaps = router.swapCount();
        _runSchedule(0);
        assertEq(router.swapCount(), swaps, "the stale schedule finds the order settled");
        assertApproxEqAbs(usdc.balanceOf(taker), SWAP_OUT, 1);
    }

    function test_rearm_revertsWhenTheScheduleServiceRefuses() public {
        vm.warp(T0 + TTL + 300);
        hss.setForcedCodes(373, 0);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.ScheduleFailed.selector, int64(373)));
        desk.rearm(id);
        assertEq(desk.getOrder(id).rearms, 0, "a refused booking costs no attempt");
    }

    function test_rearm_aQuoteAfterExpiryIsStillRejected() public {
        vm.warp(T0 + TTL + 300);
        desk.rearm(id);
        feed.set(HBAR_USD, block.timestamp);
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.OrderExpired.selector, id));
        desk.fillWithQuote(id, q, sig);
    }

    // ------------------------------------------------------------ cancel

    function test_cancel_refundsEscrowAndFuel() public {
        uint256 takerWhbar = whbar.balanceOf(taker);
        uint256 takerHbar = taker.balance;
        vm.expectEmit(true, false, false, false);
        emit BackstopDesk.Cancelled(id);
        vm.prank(taker);
        desk.cancel(id);
        assertEq(whbar.balanceOf(taker), takerWhbar + AMOUNT_IN);
        assertEq(taker.balance, takerHbar + FUEL);
        assertEq(address(desk).balance, 0);
        assertEq(desk.escrowed(WHBAR_ADDR), 0);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Cancelled));
    }

    function test_cancel_deletesTheSchedule() public {
        address schedule = desk.getOrder(id).schedule;
        vm.expectEmit(true, false, false, true);
        emit BackstopDesk.ScheduleDeleted(id, schedule, 22);
        vm.prank(taker);
        desk.cancel(id);
        assertEq(hss.lastDeleted(), schedule);
        assertTrue(hss.deleted(schedule));
    }

    function test_cancel_stillCancelsWhenDeleteIsRefused() public {
        address schedule = desk.getOrder(id).schedule;
        hss.setForcedCodes(0, 213);
        vm.expectEmit(true, false, false, true);
        emit BackstopDesk.ScheduleDeleted(id, schedule, 213);
        vm.prank(taker);
        desk.cancel(id);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Cancelled));
        // The undeleted schedule fires later and finds nothing to do.
        (, bool ok,) = _runSchedule(0);
        assertTrue(ok);
        assertEq(router.swapCount(), 0);
    }

    function test_cancel_onlyTheTaker() public {
        vm.prank(keeper);
        vm.expectRevert(BackstopDesk.OnlyTaker.selector);
        desk.cancel(id);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Open));
    }

    function test_cancel_notAfterExpiry() public {
        vm.warp(T0 + TTL);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.OrderExpired.selector, id));
        desk.cancel(id);
    }

    function test_cancel_notTwiceAndNotAfterAFill() public {
        vm.prank(taker);
        desk.cancel(id);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NotOpen.selector, id, BackstopDesk.Status.Cancelled));
        desk.cancel(id);
        uint256 second = _post();
        _fill(second, 19_500_000, 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NotOpen.selector, second, BackstopDesk.Status.Filled));
        desk.cancel(second);
    }

    function test_cancel_unknownOrder() public {
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.UnknownOrder.selector, 9));
        desk.cancel(9);
    }

    function test_cancel_revertsWhenTheTakerCannotReceiveAndStaysOpen() public {
        address newcomer = makeAddr("newcomer");
        vm.deal(newcomer, 1_000e18);
        vm.prank(newcomer);
        uint256 nid = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        vm.prank(newcomer);
        vm.expectRevert();
        desk.cancel(nid);
        assertEq(uint8(_status(nid)), uint8(BackstopDesk.Status.Open));
        assertEq(desk.escrowed(WHBAR_ADDR), 2 * AMOUNT_IN);
    }
}
