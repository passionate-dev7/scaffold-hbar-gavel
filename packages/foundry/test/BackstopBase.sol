// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test, Vm } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { BackstopDesk } from "../contracts/BackstopDesk.sol";
import { MockHtsToken } from "./mocks/MockHtsToken.sol";
import { MockHss, MockHtsFees } from "./mocks/MockHederaSystem.sol";
import { MockPool, MockRouter, MockFactory, MockWhbarHelper, MockAggregator } from "./mocks/MockSaucerSwap.sol";

/// Fixture for every BackstopDesk test: the Hedera Schedule Service etched at 0x16b, WHBAR, USDC and SAUCE at fixed
/// addresses, a priced SaucerSwap V2 pool per pair (WHBAR/USDC 0.30%, WHBAR/SAUCE 0.30%), a router that trades at
/// those prices, a Chainlink feed, a taker, and a maker holding a signing key and an allowance for the desk.
abstract contract BackstopBase is Test {
    address internal constant HTS_ADDR = address(0x167);
    address internal constant HSS_ADDR = address(0x16b);
    address internal constant USDC_ADDR = address(0x1549);
    address internal constant WHBAR_ADDR = address(0x3ad2);
    address internal constant SAUCE_ADDR = address(0x9000);

    uint256 internal constant T0 = 1_700_000_000;
    /// HBAR at 0.20 USD, 8 decimals.
    int256 internal constant HBAR_USD = 20_000_000;
    uint256 internal constant MAX_ORACLE_AGE = 26 hours;
    uint256 internal constant MAX_DEVIATION_BPS = 300;
    uint256 internal constant FUEL = 4e8;
    uint256 internal constant SCHEDULED_GAS = 3_000_000;
    uint24 internal constant FEE = 3000;
    uint256 internal constant TTL = 120;

    // Raw-unit prices (WHBAR tinybar per raw unit of the token): 1 USDC (6 dp) = 5 HBAR, which is 0.20 USD per HBAR and
    // agrees with the feed; 1 SAUCE (6 dp) = 0.025 HBAR.
    uint256 internal constant USDC_PRICE_NUM = 500;
    uint256 internal constant SAUCE_PRICE_NUM = 25;
    uint256 internal constant SAUCE_PRICE_DEN = 10;

    /// 100 HBAR in tinybar and the USDC it is worth at the oracle: 20 USDC.
    uint256 internal constant AMOUNT_IN = 100e8;
    uint256 internal constant ORACLE_USDC = 20e6;
    /// A taker floor 5% under the oracle.
    uint256 internal constant MIN_OUT = 19e6;

    uint256 internal makerPk = 0xA11CE;
    address internal maker;
    address internal taker = makeAddr("taker");
    address internal keeper = makeAddr("keeper");

    MockHtsToken internal whbar;
    MockHtsToken internal usdc;
    MockHtsToken internal sauce;
    MockPool internal usdcPool;
    MockPool internal saucePool;
    MockRouter internal router;
    MockFactory internal factory;
    MockWhbarHelper internal helper;
    MockAggregator internal feed;
    MockHss internal hss = MockHss(HSS_ADDR);
    MockHtsFees internal htsFees = MockHtsFees(HTS_ADDR);

    BackstopDesk internal desk;

    function setUp() public virtual {
        vm.warp(T0);
        vm.chainId(296);
        maker = vm.addr(makerPk);
        vm.etch(HSS_ADDR, address(new MockHss()).code);
        vm.etch(HTS_ADDR, address(new MockHtsFees()).code);

        deployCodeTo("MockHtsToken.sol:MockHtsToken", abi.encode("Wrapped HBAR", "WHBAR", uint8(8)), WHBAR_ADDR);
        deployCodeTo("MockHtsToken.sol:MockHtsToken", abi.encode("SaucerSwap", "SAUCE", uint8(6)), SAUCE_ADDR);
        deployCodeTo("MockHtsToken.sol:MockHtsToken", abi.encode("USD Coin", "USDC", uint8(6)), USDC_ADDR);
        whbar = MockHtsToken(WHBAR_ADDR);
        sauce = MockHtsToken(SAUCE_ADDR);
        usdc = MockHtsToken(USDC_ADDR);

        router = new MockRouter();
        factory = new MockFactory();
        helper = new MockWhbarHelper(WHBAR_ADDR);
        feed = new MockAggregator();
        feed.set(HBAR_USD, T0);

        usdcPool = new MockPool(USDC_ADDR, WHBAR_ADDR, FEE);
        saucePool = new MockPool(SAUCE_ADDR, WHBAR_ADDR, FEE);
        _setPrice(usdcPool, USDC_ADDR, USDC_PRICE_NUM, 1);
        _setPrice(saucePool, SAUCE_ADDR, SAUCE_PRICE_NUM, SAUCE_PRICE_DEN);
        router.registerPool(address(usdcPool));
        router.registerPool(address(saucePool));
        factory.registerPool(address(usdcPool));
        factory.registerPool(address(saucePool));

        desk = _deployDesk(_config());
        _fund(taker);
        _fund(maker);
        _fund(keeper);
        usdc.mint(maker, 1_000_000e6);
        sauce.mint(maker, 1_000_000e6);
        vm.startPrank(maker);
        usdc.approve(address(desk), type(uint256).max);
        sauce.approve(address(desk), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ builders

    function _config() internal view returns (BackstopDesk.Config memory) {
        return BackstopDesk.Config({
            router: address(router),
            factory: address(factory),
            whbarHelper: address(helper),
            whbar: WHBAR_ADDR,
            hbarUsdFeed: address(feed),
            usdToken: USDC_ADDR,
            usdDecimals: 6,
            maxOracleAge: MAX_ORACLE_AGE,
            maxDeviationBps: MAX_DEVIATION_BPS,
            fuelPerOrder: FUEL,
            scheduledGas: SCHEDULED_GAS
        });
    }

    function _deployDesk(BackstopDesk.Config memory config) internal returns (BackstopDesk d) {
        d = new BackstopDesk(config);
    }

    /// Funds a user with HBAR and associates them with every token they can receive.
    function _fund(address user) internal {
        vm.deal(user, 1_000_000e18);
        vm.startPrank(user);
        whbar.associate();
        sauce.associate();
        usdc.associate();
        vm.stopPrank();
    }

    /// Sets a pool so one raw unit of `token` is worth `num / den` raw WHBAR. Uniswap V3 prices token1 per token0, so
    /// the ratio is inverted when the token is token1.
    function _setPrice(MockPool pool, address token, uint256 num, uint256 den) internal {
        (uint256 n, uint256 d) = pool.token0() == token ? (num, den) : (den, num);
        pool.setSqrtPriceX96(uint160(Math.sqrt(Math.mulDiv(n, uint256(1) << 192, d))));
    }

    // ------------------------------------------------------------ actions

    /// Posts a WHBAR -> USDC order for `amountIn` tinybar, funded in native HBAR with the standard fuel.
    function _post(uint256 amountIn, uint256 minOut) internal returns (uint256 id) {
        vm.prank(taker);
        id = desk.postOrder{ value: amountIn + FUEL }(WHBAR_ADDR, USDC_ADDR, FEE, amountIn, minOut, TTL);
    }

    function _post() internal returns (uint256 id) {
        return _post(AMOUNT_IN, MIN_OUT);
    }

    function _quote(uint256 amountOut, uint256 nonce) internal view returns (BackstopDesk.Quote memory) {
        return BackstopDesk.Quote({
            maker: maker, amountOut: amountOut, deadline: uint64(block.timestamp + 60), nonce: nonce
        });
    }

    function _sign(uint256 pk, uint256 id, BackstopDesk.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, desk.quoteDigest(id, q));
        return abi.encodePacked(r, s, v);
    }

    function _fill(uint256 id, uint256 amountOut, uint256 nonce) internal {
        BackstopDesk.Quote memory q = _quote(amountOut, nonce);
        bytes memory sig = _sign(makerPk, id, q); // reads the desk, so it must come before the prank
        vm.prank(taker);
        desk.fillWithQuote(id, q, sig);
    }

    /// Plays the network's part: warps to a recorded schedule's second and runs the call as the scheduling contract
    /// with the gas it was booked with, unless the schedule was deleted.
    function _runSchedule(uint256 index) internal returns (bool ran, bool ok, bytes memory ret) {
        MockHss.ScheduledCall memory c = hss.callAt(index);
        if (hss.deleted(c.schedule)) return (false, false, "");
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < c.expirySecond) vm.warp(c.expirySecond);
        feed.set(HBAR_USD, block.timestamp);
        vm.prank(c.to);
        (ok, ret) = c.to.call{ gas: c.gasLimit }(c.callData);
        ran = true;
    }

    // ------------------------------------------------------------ reads

    function _indexOf(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) return i;
        }
        return type(uint256).max;
    }

    function _countOf(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) ++n;
        }
    }

    function _status(uint256 id) internal view returns (BackstopDesk.Status) {
        return desk.getOrder(id).status;
    }
}
