// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { GavelDesk } from "../contracts/GavelDesk.sol";
import { MockHss } from "./mocks/MockHederaSystem.sol";
import { MockHtsToken } from "./mocks/MockHtsToken.sol";
import { GavelBase } from "./GavelBase.sol";

contract GavelPostTest is GavelBase {
    // ------------------------------------------------------------ constructor

    function test_constructor_storesTheConfig() public view {
        assertEq(address(desk.router()), address(router));
        assertEq(address(desk.factory()), address(factory));
        assertEq(desk.whbar(), WHBAR_ADDR);
        assertEq(desk.usdToken(), USDC_ADDR);
        assertEq(desk.fuelPerOrder(), FUEL);
        assertEq(desk.scheduledGas(), SCHEDULED_GAS);
        assertEq(desk.maxDeviationBps(), MAX_DEVIATION_BPS);
        assertEq(desk.maxOracleAge(), MAX_ORACLE_AGE);
    }

    function test_constructor_rejectsScheduledGasBelowThreeMillion() public {
        GavelDesk.Config memory c = _config();
        c.scheduledGas = 2_999_999;
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(c);
    }

    function test_constructor_rejectsZeroFuel() public {
        GavelDesk.Config memory c = _config();
        c.fuelPerOrder = 0;
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(c);
    }

    function test_constructor_rejectsBadBand() public {
        GavelDesk.Config memory c = _config();
        c.maxDeviationBps = 0;
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(c);
        c.maxDeviationBps = 10_000;
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(c);
    }

    function test_constructor_rejectsZeroAddressesAndZeroOracleAge() public {
        GavelDesk.Config memory c = _config();
        c.router = address(0);
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(c);
        c = _config();
        c.usdToken = address(0);
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(c);
        c = _config();
        c.maxOracleAge = 0;
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(c);
    }

    function test_constructor_rejectsAbsurdStablecoinDecimals() public {
        GavelDesk.Config memory c = _config();
        c.usdDecimals = 19;
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(c);
        assertEq(desk.usdDecimals(), 6);
    }

    function test_constructor_rejectsAFeedThatIsNotEightDecimals() public {
        feed.setDecimals(18);
        vm.expectRevert(GavelDesk.BadConfig.selector);
        _deployDesk(_config());
    }

    // ------------------------------------------------------------ native HBAR orders

    function test_post_wrapsNativeHbarAndEscrowsIt() public {
        uint256 id = _post();
        assertEq(id, 1);
        assertEq(desk.orderCount(), 1);
        assertEq(whbar.balanceOf(address(desk)), AMOUNT_IN, "escrow is WHBAR");
        assertEq(address(desk).balance, FUEL, "the rest is fuel");
        assertEq(desk.escrowed(WHBAR_ADDR), AMOUNT_IN);
        assertEq(helper.depositCount(), 1);
        GavelDesk.Order memory o = desk.getOrder(id);
        assertEq(o.taker, taker);
        assertEq(o.tokenIn, WHBAR_ADDR);
        assertEq(o.tokenOut, USDC_ADDR);
        assertEq(o.fee, FEE);
        assertEq(o.amountIn, AMOUNT_IN);
        assertEq(o.minOut, MIN_OUT);
        assertEq(o.expiry, T0 + TTL);
        assertEq(o.fuel, FUEL);
        assertEq(uint8(o.status), uint8(GavelDesk.Status.Open));
    }

    function test_post_extraValueBecomesRefundableFuel() public {
        vm.prank(taker);
        uint256 id = desk.postOrder{ value: AMOUNT_IN + 9e8 }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        assertEq(desk.getOrder(id).fuel, 9e8);
        assertEq(whbar.balanceOf(address(desk)), AMOUNT_IN);
    }

    function test_post_revertsWhenFuelIsShort() public {
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(GavelDesk.InsufficientValue.selector, AMOUNT_IN + FUEL - 1, AMOUNT_IN + FUEL)
        );
        desk.postOrder{ value: AMOUNT_IN + FUEL - 1 }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
    }

    function test_post_nativeValueBelowAmountInReverts() public {
        vm.prank(taker);
        vm.expectRevert();
        desk.postOrder{ value: AMOUNT_IN - 1 }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
    }

    function test_post_associatesTheDeskWithTokenInOnce() public {
        assertFalse(whbar.associated(address(desk)));
        _post();
        assertTrue(whbar.associated(address(desk)));
        assertTrue(desk.associated(WHBAR_ADDR));
        vm.recordLogs();
        _post();
        assertEq(_countOf(vm.getRecordedLogs(), keccak256("Associated(address)")), 0, "second order skips association");
    }

    // ------------------------------------------------------------ token orders

    function test_post_pullsATokenThroughTheTakersAllowance() public {
        usdc.mint(taker, 50e6);
        vm.startPrank(taker);
        usdc.approve(address(desk), 50e6);
        uint256 id = desk.postOrder{ value: FUEL }(USDC_ADDR, WHBAR_ADDR, FEE, 50e6, 200e8, TTL);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(desk)), 50e6);
        assertEq(usdc.balanceOf(taker), 0);
        assertEq(desk.escrowed(USDC_ADDR), 50e6);
        assertEq(desk.getOrder(id).fuel, FUEL);
        assertEq(address(desk).balance, FUEL);
    }

    function test_post_tokenOrderWithoutAllowanceReverts() public {
        usdc.mint(taker, 50e6);
        vm.prank(taker);
        vm.expectRevert();
        desk.postOrder{ value: FUEL }(USDC_ADDR, WHBAR_ADDR, FEE, 50e6, 200e8, TTL);
    }

    function test_post_tokenOrderNeedsFuel() public {
        usdc.mint(taker, 50e6);
        vm.startPrank(taker);
        usdc.approve(address(desk), 50e6);
        vm.expectRevert(abi.encodeWithSelector(GavelDesk.InsufficientValue.selector, FUEL - 1, FUEL));
        desk.postOrder{ value: FUEL - 1 }(USDC_ADDR, WHBAR_ADDR, FEE, 50e6, 200e8, TTL);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ validation

    function test_post_rejectsZeroAmountAndZeroMinOut() public {
        vm.startPrank(taker);
        vm.expectRevert(GavelDesk.ZeroAmount.selector);
        desk.postOrder{ value: FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, 0, MIN_OUT, TTL);
        vm.expectRevert(GavelDesk.ZeroAmount.selector);
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, 0, TTL);
        vm.stopPrank();
    }

    function test_post_rejectsTtlOutsideTheWindow() public {
        vm.startPrank(taker);
        vm.expectRevert(abi.encodeWithSelector(GavelDesk.BadTtl.selector, 59));
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, 59);
        vm.expectRevert(abi.encodeWithSelector(GavelDesk.BadTtl.selector, 60 days + 1));
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, 60 days + 1);
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, 60);
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, 60 days);
        vm.stopPrank();
    }

    function test_post_rejectsSameToken() public {
        vm.prank(taker);
        vm.expectRevert(GavelDesk.SameToken.selector);
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, WHBAR_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
    }

    function test_post_rejectsAPairWithoutAFactoryPool() public {
        // SAUCE/USDC has no pool, and WHBAR/USDC has none at fee 500.
        usdc.mint(taker, 1e6);
        vm.startPrank(taker);
        usdc.approve(address(desk), 1e6);
        vm.expectRevert(abi.encodeWithSelector(GavelDesk.NoPool.selector, USDC_ADDR, SAUCE_ADDR, FEE));
        desk.postOrder{ value: FUEL }(USDC_ADDR, SAUCE_ADDR, FEE, 1e6, 1, TTL);
        vm.expectRevert(abi.encodeWithSelector(GavelDesk.NoPool.selector, WHBAR_ADDR, USDC_ADDR, uint24(500)));
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, 500, AMOUNT_IN, MIN_OUT, TTL);
        vm.stopPrank();
    }

    function test_post_revertsWhenTheDeskCannotAssociate() public {
        whbar.setForcedAssociateCode(167);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(GavelDesk.HtsCallFailed.selector, int64(167)));
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
    }

    // ------------------------------------------------------------ the booked fallback

    function test_post_booksTheFallbackWithTheOrdersOwnCall() public {
        uint256 id = _post();
        assertEq(hss.callCount(), 1);
        MockHss.ScheduledCall memory c = hss.callAt(0);
        assertEq(c.to, address(desk), "the desk calls itself");
        assertEq(c.expirySecond, T0 + TTL);
        assertEq(c.gasLimit, SCHEDULED_GAS);
        assertEq(c.value, 0);
        assertEq(c.callData, abi.encodeCall(GavelDesk.fallbackFill, (id)));
        assertEq(desk.getOrder(id).schedule, c.schedule);
        assertTrue(c.schedule != address(0));
    }

    function test_post_emitsTheOrderForMakersToRead() public {
        vm.expectEmit(true, true, false, true);
        emit GavelDesk.OrderPosted(
            1,
            taker,
            WHBAR_ADDR,
            USDC_ADDR,
            FEE,
            AMOUNT_IN,
            MIN_OUT,
            uint64(T0 + TTL), // forge-lint: disable-line(unsafe-typecast)
            address(0x5c4ed000),
            T0 + TTL
        );
        _post();
    }

    function test_post_skipsABusySecond() public {
        hss.setBusy(T0 + TTL, true);
        uint256 id = _post();
        assertEq(hss.callAt(0).expirySecond, T0 + TTL + 1);
        assertEq(desk.getOrder(id).expiry, T0 + TTL, "quotes still close at the order's own expiry");
    }

    function test_post_backsOffExponentially() public {
        hss.setBusy(T0 + TTL, true);
        hss.setBusy(T0 + TTL + 1, true);
        hss.setBusy(T0 + TTL + 2, true);
        _post();
        assertEq(hss.callAt(0).expirySecond, T0 + TTL + 4);
    }

    function test_post_revertsWhenEverySlotIsTaken() public {
        hss.setBusy(T0 + TTL, true);
        for (uint256 d = 1; d <= 64; d *= 2) {
            hss.setBusy(T0 + TTL + d, true);
        }
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(GavelDesk.ScheduleFailed.selector, int64(370)));
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        assertEq(desk.orderCount(), 0, "an order without a fallback is not taken");
        assertEq(whbar.balanceOf(address(desk)), 0);
    }

    function test_post_revertsWhenTheScheduleServiceRefuses() public {
        hss.setForcedCodes(373, 0);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(GavelDesk.ScheduleFailed.selector, int64(373)));
        desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
    }

    function test_post_idsCountUp() public {
        assertEq(_post(), 1);
        assertEq(_post(), 2);
        assertEq(_post(), 3);
        assertEq(desk.escrowed(WHBAR_ADDR), 3 * AMOUNT_IN);
    }

    function test_associateTokens_isIdempotentAndOpen() public {
        address[] memory tokens = new address[](3);
        tokens[0] = WHBAR_ADDR;
        tokens[1] = USDC_ADDR;
        tokens[2] = SAUCE_ADDR;
        vm.prank(keeper);
        desk.associateTokens(tokens);
        assertTrue(whbar.associated(address(desk)));
        assertTrue(usdc.associated(address(desk)));
        assertTrue(sauce.associated(address(desk)));
        desk.associateTokens(tokens);
    }

    function test_getOrder_unknownIdIsEmpty() public view {
        assertEq(desk.getOrder(99).taker, address(0));
    }
}
