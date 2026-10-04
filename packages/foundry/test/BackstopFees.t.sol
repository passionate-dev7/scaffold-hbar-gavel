// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { BackstopDesk } from "../contracts/BackstopDesk.sol";
import { MockHtsToken } from "./mocks/MockHtsToken.sol";
import { MockPool } from "./mocks/MockSaucerSwap.sol";
import { BackstopBase } from "./BackstopBase.sol";

/// An HTS token with a fractional custom fee, as the Token Service applies one: \`senderBps\` is charged to the sender on
/// top of the amount (the desk's balance drops by more than it sends), \`receiverBps\` is taken out of the amount (the
/// receiver gets less than it was sent).
contract FeeToken is MockHtsToken {
    uint256 public senderBps;
    uint256 public receiverBps;
    address public collector = address(0xFEE);

    constructor() MockHtsToken("Fee", "FEE", 6) {
        associated[collector] = true;
    }

    function setFees(uint256 sender_, uint256 receiver_) external {
        senderBps = sender_;
        receiverBps = receiver_;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        return _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _spendAllowance(from, msg.sender, value);
        return _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) private returns (bool) {
        uint256 senderFee = value * senderBps / 10_000;
        uint256 receiverFee = value * receiverBps / 10_000;
        if (senderFee != 0) _update(from, collector, senderFee);
        _update(from, to, value - receiverFee);
        if (receiverFee != 0) _update(from, collector, receiverFee);
        return true;
    }
}

contract BackstopFeesTest is BackstopBase {
    FeeToken internal feeToken;

    function setUp() public override {
        super.setUp();
        feeToken = new FeeToken();
        MockPool pool = new MockPool(address(feeToken), USDC_ADDR, FEE);
        factory.registerPool(address(pool));
        vm.startPrank(taker);
        feeToken.associate();
        vm.stopPrank();
        feeToken.mint(taker, 10_000e6);
        vm.prank(taker);
        feeToken.approve(address(desk), type(uint256).max);
    }

    function _postFee(uint256 amount) internal returns (uint256) {
        vm.prank(taker);
        return desk.postOrder{ value: FUEL }(address(feeToken), USDC_ADDR, FEE, amount, 1, TTL);
    }

    // ------------------------------------------------------------ the Token Service's own fee schedule

    function test_fees_theTestnetTokensCarryNone() public {
        // The mock, like WHBAR, USDC and SAUCE on testnet, reports empty fee schedules.
        _post();
        vm.prank(taker);
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, SAUCE_ADDR, FEE, AMOUNT_IN, 1e6, TTL);
        assertEq(desk.orderCount(), 2);
    }

    function test_fees_aTokenInWithAFixedFeeIsRefused() public {
        htsFees.setFeeCounts(address(feeToken), 1, 0, 0);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.CustomFees.selector, address(feeToken)));
        desk.postOrder{ value: FUEL }(address(feeToken), USDC_ADDR, FEE, 100e6, 1, TTL);
        assertEq(feeToken.balanceOf(address(desk)), 0);
    }

    function test_fees_aFractionalFeeIsRefused() public {
        htsFees.setFeeCounts(address(feeToken), 0, 1, 0);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.CustomFees.selector, address(feeToken)));
        desk.postOrder{ value: FUEL }(address(feeToken), USDC_ADDR, FEE, 100e6, 1, TTL);
    }

    function test_fees_aRoyaltyFeeIsRefused() public {
        htsFees.setFeeCounts(address(feeToken), 0, 0, 1);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.CustomFees.selector, address(feeToken)));
        desk.postOrder{ value: FUEL }(address(feeToken), USDC_ADDR, FEE, 100e6, 1, TTL);
    }

    function test_fees_aTokenOutWithAFeeIsRefusedToo() public {
        // The taker would receive less than the quote promises.
        htsFees.setFeeCounts(USDC_ADDR, 0, 1, 0);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.CustomFees.selector, USDC_ADDR));
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
    }

    function test_fees_aFailedFeeQueryBlocksThePost() public {
        htsFees.setForcedCode(167);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.HtsCallFailed.selector, int64(167)));
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
    }

    // ------------------------------------------------------------ balance deltas, if a schedule slips past the query

    function test_fees_theDeskMeasuresWhatArrivesNotWhatWasSent() public {
        feeToken.setFees(0, 100); // the receiver gets 1% less than sent
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.UnexpectedReceived.selector, 100e6, 99e6));
        desk.postOrder{ value: FUEL }(address(feeToken), USDC_ADDR, FEE, 100e6, 1, TTL);
        assertEq(desk.escrowed(address(feeToken)), 0, "nothing was booked for the short delivery");
    }

    function test_fees_aPayoutThatCostsTheDeskMoreThanItSendsCannotEatOtherEscrow() public {
        uint256 first = _postFee(100e6);
        uint256 second = _postFee(100e6);
        feeToken.setFees(100, 0); // from now on a transfer costs the sender 1% extra
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.Insolvent.selector, address(feeToken)));
        desk.cancel(first);
        assertEq(uint8(desk.getOrder(first).status), uint8(BackstopDesk.Status.Open), "the payout rolled back");
        assertEq(feeToken.balanceOf(address(desk)), 200e6, "no escrow leaked");
        assertEq(desk.escrowed(address(feeToken)), 200e6);
        assertEq(uint8(desk.getOrder(second).status), uint8(BackstopDesk.Status.Open));
    }

    function test_fees_aNormalTokenPaysOutWithoutTrippingTheCoverCheck() public {
        uint256 first = _postFee(100e6);
        _postFee(100e6);
        vm.prank(taker);
        desk.cancel(first);
        assertEq(feeToken.balanceOf(address(desk)), 100e6);
        assertEq(desk.escrowed(address(feeToken)), 100e6);
    }
}
