// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Vm } from "forge-std/Vm.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { BackstopDesk } from "../contracts/BackstopDesk.sol";
import { MockHss } from "./mocks/MockHederaSystem.sol";
import { BackstopBase } from "./BackstopBase.sol";

/// A contract taker that refuses native HBAR, to prove a failed fuel refund cannot block a fill.
contract HbarRefuser {
    function post(BackstopDesk desk, uint256 amountIn, uint256 minOut, uint256 fuel)
        external
        payable
        returns (uint256)
    {
        return desk.postOrder{ value: amountIn + fuel }(address(0x3ad2), address(0x1549), 3000, amountIn, minOut, 120);
    }
}

contract BackstopFillTest is BackstopBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _post();
    }

    /// The taker submits the quote it picked.
    function _submit(uint256 orderId, BackstopDesk.Quote memory q, bytes memory sig) internal {
        vm.prank(taker);
        desk.fillWithQuote(orderId, q, sig);
    }

    // ------------------------------------------------------------ settlement

    function test_fill_paysTheTakerAndTheMakerAtomically() public {
        uint256 takerUsdc = usdc.balanceOf(taker);
        uint256 makerUsdc = usdc.balanceOf(maker);
        uint256 makerWhbar = whbar.balanceOf(maker);
        _fill(id, 19_500_000, 1);
        assertEq(usdc.balanceOf(taker), takerUsdc + 19_500_000, "taker receives the quote");
        assertEq(usdc.balanceOf(maker), makerUsdc - 19_500_000, "maker pays it");
        assertEq(whbar.balanceOf(maker), makerWhbar + AMOUNT_IN, "maker receives the escrow");
        assertEq(whbar.balanceOf(address(desk)), 0, "escrow is empty");
        assertEq(desk.escrowed(WHBAR_ADDR), 0);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Filled));
        assertTrue(desk.nonceUsed(maker, 1));
    }

    function test_fill_emitsFilled() public {
        vm.expectEmit(true, true, false, true);
        emit BackstopDesk.Filled(id, maker, 19_500_000);
        _fill(id, 19_500_000, 1);
    }

    function test_fill_deletesTheSchedule() public {
        address schedule = desk.getOrder(id).schedule;
        vm.expectEmit(true, false, false, true);
        emit BackstopDesk.ScheduleDeleted(id, schedule, 22);
        _fill(id, 19_500_000, 1);
        assertEq(hss.deleteCount(), 1);
        assertEq(hss.lastDeleted(), schedule);
        assertEq(desk.getOrder(id).schedule, address(0));
    }

    function test_fill_refundsTheFuelToTheTaker() public {
        uint256 before = taker.balance;
        _fill(id, 19_500_000, 1);
        assertEq(taker.balance, before + FUEL, "the schedule never ran, so the fuel comes back");
        assertEq(address(desk).balance, 0);
        assertEq(desk.getOrder(id).fuel, 0);
    }

    function test_fill_onlyTheTakerMaySubmitAQuote() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(BackstopDesk.OnlyTaker.selector);
        desk.fillWithQuote(id, q, sig);
        vm.prank(maker);
        vm.expectRevert(BackstopDesk.OnlyTaker.selector);
        desk.fillWithQuote(id, q, sig);
        vm.prank(keeper);
        vm.expectRevert(BackstopDesk.OnlyTaker.selector);
        desk.fillWithQuote(id, q, sig);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Open), "no outsider settled the order");
        assertFalse(desk.nonceUsed(maker, 1), "and no nonce was burned");
        _submit(id, q, sig);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Filled));
    }

    /// The worst valid quote on a public board is still valid. Taker-only submission is what stops a stranger from
    /// settling an order with it while a better quote is on its way.
    function test_fill_aStrangerCannotSettleWithTheWorstQuoteOnTheBoard() public {
        BackstopDesk.Quote memory worst = _quote(MIN_OUT + 500_000, 1); // valid: above minOut and inside the band
        bytes memory sig = _sign(makerPk, id, worst);
        vm.prank(makeAddr("frontRunner"));
        vm.expectRevert(BackstopDesk.OnlyTaker.selector);
        desk.fillWithQuote(id, worst, sig);
        BackstopDesk.Quote memory best = _quote(20_500_000, 2);
        _submit(id, best, _sign(makerPk, id, best));
        assertEq(usdc.balanceOf(taker), 20_500_000, "the taker chose the best quote");
    }

    function test_fill_aSecondFillOfTheSameOrderReverts() public {
        _fill(id, 19_500_000, 1);
        BackstopDesk.Quote memory q = _quote(19_600_000, 2);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NotOpen.selector, id, BackstopDesk.Status.Filled));
        _submit(id, q, sig);
    }

    function test_fill_unknownOrderReverts() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, 77, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.UnknownOrder.selector, 77));
        _submit(77, q, sig);
    }

    // ------------------------------------------------------------ EIP-712

    function test_signature_wrongSignerIsRejected() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(0xB0B, id, q);
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, sig);
    }

    function test_signature_aQuoteNamingAnotherMakerIsRejected() public {
        // A valid signature by the maker, but the quote claims a different maker address: the recovered signer
        // does not match, so nobody can attach their name to someone else's signature or the reverse.
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        q.maker = keeper;
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, sig);
    }

    function test_signature_tamperedAmountIsRejected() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        q.amountOut = 19_400_000;
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, sig);
    }

    function test_signature_tamperedDeadlineAndNonceAreRejected() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        q.deadline += 1;
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, sig);
        q.deadline -= 1;
        q.nonce = 2;
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, sig);
    }

    /// The signed digest names the order, so a quote for order A cannot be replayed onto order B even by the taker
    /// who owns both.
    function test_signature_isBoundToTheOrder() public {
        uint256 other = _post();
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(other, q, sig);
        assertEq(uint8(_status(other)), uint8(BackstopDesk.Status.Open));
        _submit(id, q, sig);
    }

    function test_signature_isBoundToTheDesk() public {
        BackstopDesk other = _deployDesk(_config());
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, other.quoteDigest(id, q));
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, abi.encodePacked(r, s, v));
    }

    function test_signature_isBoundToTheChain() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.chainId(295);
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, sig);
    }

    function test_signature_malformedBytesAreRejected() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, hex"1234");
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, new bytes(65));
    }

    function test_signature_highSValueIsRejected() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerPk, desk.quoteDigest(id, q));
        // The malleable twin (n - s, flipped v) recovers the same signer on a naive ecrecover.
        bytes32 highS = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;
        vm.expectRevert(BackstopDesk.BadSignature.selector);
        _submit(id, q, abi.encodePacked(r, highS, flipped));
    }

    /// A signature produced outside Solidity (viem signTypedData, scripts-js/sign-quote.mjs) recovers on the desk.
    /// Domain: name Backstop, version 1, chainId 296, verifyingContract 0xBAC5700D. Signer: 0xA18a...0236.
    function test_signature_viemVectorRecovers() public {
        address at = address(uint160(0xBAC5700D));
        // OZ EIP712 notices the new address and rebuilds the domain separator instead of using its cached one.
        vm.etch(at, address(_deployDesk(_config())).code);
        BackstopDesk d = BackstopDesk(payable(at));
        BackstopDesk.Quote memory q = BackstopDesk.Quote({
            maker: 0xA18aDF5693CbeeB045aC1877E5691ba5eB1B0236, amountOut: 19_500_000, deadline: 1_700_000_060, nonce: 42
        });
        bytes32 digest = d.quoteDigest(3, q);
        assertEq(digest, 0x1785acb776b56cc2d3730f723d709327a3c18f58457601bc9509ff1ff283d116, "digest matches viem");
        bytes memory sig =
            hex"bbc7e0a5e69dffd169096d2c18257c2546b5b98fb08f0c66992aa56c48c52cec7806bc396649c7164394b5bf279d982eeba2160390e3fae018aadabe5fb6cf951c";
        assertEq(ECDSA.recover(digest, sig), q.maker, "signer matches viem");
    }

    // ------------------------------------------------------------ nonces and deadlines

    function test_nonce_cannotBeReplayedOnAnotherOrder() public {
        _fill(id, 19_500_000, 7);
        uint256 second = _post();
        BackstopDesk.Quote memory q = _quote(19_500_000, 7);
        bytes memory sig = _sign(makerPk, second, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NonceAlreadyUsed.selector, maker, 7));
        _submit(second, q, sig);
    }

    function test_nonce_aRevertedFillDoesNotBurnIt() public {
        vm.prank(maker);
        usdc.approve(address(desk), 0);
        BackstopDesk.Quote memory q = _quote(19_500_000, 5);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectRevert();
        _submit(id, q, sig);
        assertFalse(desk.nonceUsed(maker, 5));
        vm.prank(maker);
        usdc.approve(address(desk), type(uint256).max);
        _submit(id, q, sig);
        assertTrue(desk.nonceUsed(maker, 5));
    }

    function test_nonce_makerCanCancelAQuote() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 9);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectEmit(true, false, false, true);
        emit BackstopDesk.NoncesCancelled(maker, 0, 1 << 9);
        vm.prank(maker);
        desk.cancelNonces(0, 1 << 9);
        assertTrue(desk.nonceUsed(maker, 9));
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NonceAlreadyUsed.selector, maker, 9));
        _submit(id, q, sig);
    }

    function test_nonce_bulkCancelRetiresManyQuotesInOneTransaction() public {
        // Nonces 256 to 511 are word 1; cancel bits 0, 3 and 255 and leave the rest.
        uint256 mask = (1 << 0) | (1 << 3) | (1 << 255);
        vm.prank(maker);
        desk.cancelNonces(1, mask);
        assertEq(desk.nonceBitmap(maker, 1), mask);
        assertTrue(desk.nonceUsed(maker, 256));
        assertTrue(desk.nonceUsed(maker, 259));
        assertTrue(desk.nonceUsed(maker, 511));
        assertFalse(desk.nonceUsed(maker, 257));
        assertFalse(desk.nonceUsed(maker, 510));
        assertFalse(desk.nonceUsed(maker, 3), "word 0 is untouched");
        BackstopDesk.Quote memory q = _quote(19_500_000, 259);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NonceAlreadyUsed.selector, maker, 259));
        _submit(id, q, sig);
        _fill(id, 19_500_000, 257); // a nonce the mask left alone still fills
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Filled));
    }

    function test_nonce_wordBoundariesAreIndependent() public {
        _fill(id, 19_500_000, 255);
        assertTrue(desk.nonceUsed(maker, 255));
        assertFalse(desk.nonceUsed(maker, 256));
        assertFalse(desk.nonceUsed(maker, 254));
        uint256 second = _post();
        _fill(second, 19_500_000, 256);
        assertEq(desk.nonceBitmap(maker, 0), 1 << 255);
        assertEq(desk.nonceBitmap(maker, 1), 1);
        uint256 third = _post();
        BackstopDesk.Quote memory q = _quote(19_500_000, 256);
        bytes memory sig = _sign(makerPk, third, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.NonceAlreadyUsed.selector, maker, 256));
        _submit(third, q, sig);
    }

    function test_nonce_hugeNonceDoesNotCollideWithLowOnes() public {
        uint256 huge = type(uint256).max;
        _fill(id, 19_500_000, huge);
        assertTrue(desk.nonceUsed(maker, huge));
        assertFalse(desk.nonceUsed(maker, huge - 1));
        assertFalse(desk.nonceUsed(maker, 255));
    }

    function test_nonce_cancellingIsPerMaker() public {
        vm.prank(keeper);
        desk.cancelNonces(0, type(uint256).max);
        _fill(id, 19_500_000, 1);
    }

    function test_deadline_expiredQuoteIsRejected() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.warp(q.deadline + 1);
        feed.set(HBAR_USD, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.QuoteExpired.selector, q.deadline));
        _submit(id, q, sig);
    }

    function test_deadline_lastSecondStillFills() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.warp(q.deadline);
        _submit(id, q, sig);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Filled));
    }

    function test_expiry_noFillAtOrAfterTheOrdersExpiry() public {
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        q.deadline = uint64(T0 + 1 days); // forge-lint: disable-line(unsafe-typecast)
        bytes memory sig = _sign(makerPk, id, q);
        vm.warp(T0 + TTL);
        feed.set(HBAR_USD, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.OrderExpired.selector, id));
        _submit(id, q, sig);
        vm.warp(T0 + TTL - 1);
        _submit(id, q, sig);
    }

    // ------------------------------------------------------------ price floors

    function test_minOut_aQuoteBelowTheTakersFloorIsRejected() public {
        BackstopDesk.Quote memory q = _quote(MIN_OUT - 1, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.QuoteBelowMin.selector, MIN_OUT - 1, MIN_OUT));
        _submit(id, q, sig);
    }

    function test_minOut_aQuoteAtTheFloorFills() public {
        vm.prank(taker);
        uint256 sid = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, SAUCE_ADDR, FEE, AMOUNT_IN, 3_900e6, TTL);
        BackstopDesk.Quote memory q = _quote(3_900e6, 1);
        _submit(sid, q, _sign(makerPk, sid, q));
        assertEq(uint8(_status(sid)), uint8(BackstopDesk.Status.Filled));
    }

    // ------------------------------------------------------------ the Chainlink band

    function test_band_floorIsOracleLessDeviation() public view {
        // 100 HBAR at 0.20 USD is 20 USDC; 300 bps off is 19.4.
        assertEq(desk.oracleFloor(id), 19_400_000);
    }

    function test_band_rejectsAQuoteBelowTheFloorEvenWhenAboveMinOut() public {
        // The taker was careless: minOut of 1 USDC. The oracle still protects them.
        uint256 careless = _post(AMOUNT_IN, 1e6);
        BackstopDesk.Quote memory q = _quote(19_399_999, 1);
        bytes memory sig = _sign(makerPk, careless, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.QuoteOutsideBand.selector, 19_399_999, 19_400_000));
        _submit(careless, q, sig);
    }

    function test_band_admitsAQuoteAtTheFloor() public {
        uint256 careless = _post(AMOUNT_IN, 1e6);
        _fill(careless, 19_400_000, 1);
        assertEq(uint8(_status(careless)), uint8(BackstopDesk.Status.Filled));
    }

    function test_band_movesWithTheOracle() public {
        feed.set(HBAR_USD * 2, block.timestamp);
        assertEq(desk.oracleFloor(id), 38_800_000);
    }

    function test_band_staleOracleBlocksTheFill() public {
        vm.warp(T0 + MAX_ORACLE_AGE + 1);
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        q.deadline = uint64(block.timestamp + 60);
        // the order itself is long expired by now, so book a fresh one at the stale time
        vm.prank(taker);
        uint256 fresh = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        bytes memory sig = _sign(makerPk, fresh, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.StaleOracle.selector, T0));
        _submit(fresh, q, sig);
    }

    function test_band_badOraclePriceBlocksTheFill() public {
        feed.set(0, block.timestamp);
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.BadOraclePrice.selector, int256(0)));
        _submit(id, q, sig);
    }

    function test_band_nonUsdPairsRelyOnMinOutAndIgnoreTheOracle() public {
        // WHBAR -> SAUCE: 100 HBAR buys 4000 SAUCE at 0.025 HBAR each.
        vm.prank(taker);
        uint256 sid = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, SAUCE_ADDR, FEE, AMOUNT_IN, 3_900e6, TTL);
        assertEq(desk.oracleFloor(sid), 0);
        feed.set(0, block.timestamp); // a broken oracle must not block a pair it does not price
        BackstopDesk.Quote memory q = _quote(3_900e6, 1);
        _submit(sid, q, _sign(makerPk, sid, q));
        assertEq(sauce.balanceOf(taker), 3_900e6);
    }

    function test_band_appliesToTheReverseDirectionToo() public {
        // 20 USDC -> HBAR: the oracle implies 100 HBAR; 300 bps off is 97 HBAR.
        usdc.mint(taker, 20e6);
        vm.startPrank(taker);
        usdc.approve(address(desk), 20e6);
        uint256 rid = desk.postOrder{ value: FUEL }(USDC_ADDR, WHBAR_ADDR, FEE, 20e6, 1e8, TTL);
        vm.stopPrank();
        assertEq(desk.oracleFloor(rid), 97e8);
        whbar.mint(maker, 100e8);
        vm.prank(maker);
        whbar.approve(address(desk), type(uint256).max);
        BackstopDesk.Quote memory q = _quote(97e8 - 1, 1);
        bytes memory sig = _sign(makerPk, rid, q);
        vm.expectRevert(abi.encodeWithSelector(BackstopDesk.QuoteOutsideBand.selector, 97e8 - 1, 97e8));
        _submit(rid, q, sig);
        q = _quote(97e8, 1);
        _submit(rid, q, _sign(makerPk, rid, q));
        assertEq(whbar.balanceOf(taker), 97e8);
    }

    function test_hbarUsd_readsTheFeed() public view {
        assertEq(desk.hbarUsd(), 20_000_000);
    }

    // ------------------------------------------------------------ failures that must not strand the order

    function test_fill_makerWithoutAllowanceReverts() public {
        vm.prank(maker);
        usdc.approve(address(desk), 0);
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectRevert();
        _submit(id, q, sig);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Open), "the order stays open for the next quote");
        assertEq(whbar.balanceOf(address(desk)), AMOUNT_IN);
    }

    function test_fill_makerWithoutBalanceReverts() public {
        uint256 all = usdc.balanceOf(maker);
        vm.prank(maker);
        assertTrue(usdc.transfer(keeper, all));
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, id, q);
        vm.expectRevert();
        _submit(id, q, sig);
        assertEq(uint8(_status(id)), uint8(BackstopDesk.Status.Open));
    }

    function test_fill_takerNotAssociatedWithTokenOutRevertsAndStaysOpen() public {
        address lonely = makeAddr("lonely");
        vm.deal(lonely, 1_000e18);
        vm.startPrank(lonely);
        whbar.associate();
        uint256 lid = desk.postOrder{ value: AMOUNT_IN + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, AMOUNT_IN, MIN_OUT, TTL);
        vm.stopPrank();
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, lid, q);
        vm.prank(lonely);
        vm.expectRevert();
        desk.fillWithQuote(lid, q, sig);
        assertEq(uint8(_status(lid)), uint8(BackstopDesk.Status.Open));
    }

    function test_fill_aTakerThatRefusesHbarCannotBlockTheFill() public {
        HbarRefuser refuser = new HbarRefuser();
        vm.deal(address(refuser), 1_000e18);
        // The refuser contract is the taker; it needs to hold and receive tokens.
        vm.startPrank(address(refuser));
        whbar.associate();
        usdc.associate();
        vm.stopPrank();
        uint256 rid = refuser.post(desk, AMOUNT_IN, MIN_OUT, FUEL);
        assertEq(desk.getOrder(rid).taker, address(refuser));
        BackstopDesk.Quote memory q = _quote(19_500_000, 1);
        bytes memory sig = _sign(makerPk, rid, q);
        vm.expectEmit(true, false, false, true);
        emit BackstopDesk.FuelRefundFailed(rid, address(refuser), FUEL);
        vm.prank(address(refuser));
        desk.fillWithQuote(rid, q, sig);
        assertEq(uint8(_status(rid)), uint8(BackstopDesk.Status.Filled));
        assertEq(usdc.balanceOf(address(refuser)), 19_500_000);
    }

    // ------------------------------------------------------------ accounting

    function test_fill_escrowAccountingAcrossSeveralOrders() public {
        uint256 b = _post(50e8, 9e6);
        uint256 c = _post(70e8, 13e6);
        assertEq(desk.escrowed(WHBAR_ADDR), AMOUNT_IN + 50e8 + 70e8);
        assertEq(whbar.balanceOf(address(desk)), desk.escrowed(WHBAR_ADDR));
        _fill(b, 9_800_000, 1);
        assertEq(desk.escrowed(WHBAR_ADDR), AMOUNT_IN + 70e8);
        assertEq(whbar.balanceOf(address(desk)), desk.escrowed(WHBAR_ADDR));
        _fill(id, 19_500_000, 2);
        _fill(c, 13_600_000, 3);
        assertEq(desk.escrowed(WHBAR_ADDR), 0);
        assertEq(whbar.balanceOf(address(desk)), 0);
        assertEq(address(desk).balance, 0, "every fuel unit came back");
    }
}
