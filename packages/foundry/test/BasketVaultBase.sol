// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test, Vm } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { BasketVault } from "../contracts/BasketVault.sol";
import { MockHtsToken } from "./mocks/MockHtsToken.sol";
import { MockShareToken, MockHts, MockHss } from "./mocks/MockHederaSystem.sol";
import { MockPool, MockRouter, MockFactory, MockWhbarHelper, MockAggregator } from "./mocks/MockSaucerSwap.sol";

/// Fixture for every BasketVault test: Hedera system contracts etched at 0x167 and 0x16b, three HTS tokens at fixed
/// addresses chosen so one leg sorts below WHBAR in its pool and the other above it, a priced pool per leg, a router
/// that trades at those pools' prices, and a Chainlink feed. Basket: WHBAR 40%, SAUCE 30%, USDC 30% (the guard leg).
abstract contract BasketVaultBase is Test {
    address internal constant HTS_ADDR = address(0x167);
    address internal constant HSS_ADDR = address(0x16b);
    // USDC < WHBAR < SAUCE, so the USDC pool has the leg as token0 and the SAUCE pool has it as token1.
    address internal constant USDC_ADDR = address(0x1549);
    address internal constant WHBAR_ADDR = address(0x3ad2);
    address internal constant SAUCE_ADDR = address(0x9000);

    uint256 internal constant T0 = 1_700_000_000;
    /// HBAR at 0.20 USD, 8 decimals.
    int256 internal constant HBAR_USD = 20_000_000;
    uint256 internal constant HBAR_USD_U = 20_000_000;
    uint256 internal constant MAX_ORACLE_AGE = 26 hours;
    uint256 internal constant DRIFT_BPS = 200;
    uint256 internal constant SLIPPAGE_BPS = 100;
    uint256 internal constant MAX_TRADE_BPS = 2000;
    uint256 internal constant GUARD_DEVIATION_BPS = 500;
    uint256 internal constant SCHEDULED_GAS = 3_000_000;
    uint24 internal constant SAUCE_FEE = 3000;
    uint24 internal constant USDC_FEE = 500;
    /// HBAR sent to initialize: the mock creation fee plus 5 HBAR of fuel.
    uint256 internal constant CREATE_FEE = 15e8;
    uint256 internal constant INIT_VALUE = 20e8;

    // Raw-unit prices (WHBAR tinybars per raw unit of the leg token): 1 SAUCE (6 dp) = 0.025 HBAR, 1 USDC (6 dp)
    // = 5 HBAR, which is 0.20 USD per HBAR and agrees with the feed.
    uint256 internal constant SAUCE_PRICE_NUM = 25;
    uint256 internal constant SAUCE_PRICE_DEN = 10;
    uint256 internal constant USDC_PRICE_NUM = 500;
    uint256 internal constant USDC_PRICE_DEN = 1;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    MockHtsToken internal whbar;
    MockHtsToken internal sauce;
    MockHtsToken internal usdc;
    MockPool internal saucePool;
    MockPool internal usdcPool;
    MockRouter internal router;
    MockFactory internal factory;
    MockWhbarHelper internal helper;
    MockAggregator internal feed;
    MockHts internal hts = MockHts(HTS_ADDR);
    MockHss internal hss = MockHss(HSS_ADDR);

    BasketVault internal vault;
    MockShareToken internal share;

    function setUp() public virtual {
        vm.warp(T0);
        vm.etch(HTS_ADDR, address(new MockHts()).code);
        vm.etch(HSS_ADDR, address(new MockHss()).code);
        hts.setCreateFee(CREATE_FEE);

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

        saucePool = new MockPool(SAUCE_ADDR, WHBAR_ADDR, SAUCE_FEE);
        usdcPool = new MockPool(USDC_ADDR, WHBAR_ADDR, USDC_FEE);
        _setPrice(saucePool, SAUCE_ADDR, SAUCE_PRICE_NUM, SAUCE_PRICE_DEN);
        _setPrice(usdcPool, USDC_ADDR, USDC_PRICE_NUM, USDC_PRICE_DEN);
        router.registerPool(address(saucePool));
        router.registerPool(address(usdcPool));
        factory.registerPool(address(saucePool));
        factory.registerPool(address(usdcPool));

        vault = _deployVault(_config(), _legs());
        _initialize();
        _fund(alice);
        _fund(bob);
    }

    // ------------------------------------------------------------ builders

    function _config() internal view returns (BasketVault.Config memory) {
        return BasketVault.Config({
            router: address(router),
            factory: address(factory),
            whbarHelper: address(helper),
            whbar: WHBAR_ADDR,
            hbarUsdFeed: address(feed),
            maxOracleAge: MAX_ORACLE_AGE,
            driftBps: DRIFT_BPS,
            slippageBps: SLIPPAGE_BPS,
            maxTradeBps: MAX_TRADE_BPS,
            scheduledGas: SCHEDULED_GAS,
            guardLeg: 1,
            maxDeviationBps: GUARD_DEVIATION_BPS
        });
    }

    function _legs() internal view returns (BasketVault.LegConfig[] memory legs) {
        legs = new BasketVault.LegConfig[](2);
        legs[0] = BasketVault.LegConfig(SAUCE_ADDR, address(saucePool), 3000);
        legs[1] = BasketVault.LegConfig(USDC_ADDR, address(usdcPool), 3000);
    }

    function _deployVault(BasketVault.Config memory config, BasketVault.LegConfig[] memory legs)
        internal
        returns (BasketVault v)
    {
        vm.prank(owner);
        v = new BasketVault(config, legs);
    }

    function _initialize() internal {
        vm.deal(owner, INIT_VALUE);
        vm.prank(owner);
        vault.initialize{ value: INIT_VALUE }("Hedera Index Basket", "HIB");
        share = MockShareToken(vault.shareToken());
    }

    /// Funds a user with HBAR and associates them with every token they can receive.
    function _fund(address user) internal {
        vm.deal(user, 1_000_000e18);
        vm.startPrank(user);
        whbar.associate();
        sauce.associate();
        usdc.associate();
        share.associate();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ pool prices

    /// Sets a pool so one raw unit of `leg` is worth `num / den` raw WHBAR. Uniswap V3 prices token1 per token0, so
    /// the ratio is inverted when the leg is token1.
    function _setPrice(MockPool pool, address leg, uint256 num, uint256 den) internal {
        (uint256 n, uint256 d) = pool.token0() == leg ? (num, den) : (den, num);
        pool.setSqrtPriceX96(uint160(Math.sqrt(Math.mulDiv(n, uint256(1) << 192, d))));
    }

    /// Multiplies a leg's price by `numerator / denominator`, from the ratio the fixture started with.
    function _scaleSaucePrice(uint256 numerator, uint256 denominator) internal {
        _setPrice(saucePool, SAUCE_ADDR, SAUCE_PRICE_NUM * numerator, SAUCE_PRICE_DEN * denominator);
    }

    function _scaleUsdcPrice(uint256 numerator, uint256 denominator) internal {
        _setPrice(usdcPool, USDC_ADDR, USDC_PRICE_NUM * numerator, USDC_PRICE_DEN * denominator);
    }

    // ------------------------------------------------------------ actions

    function _deposit(address user, uint256 amount) internal returns (uint256 shares) {
        vm.prank(user);
        shares = vault.deposit{ value: amount }(0);
    }

    /// The owner is the only outside caller `rebalance` accepts.
    function _rebalance() internal returns (bool traded) {
        vm.prank(owner);
        traded = vault.rebalance();
    }

    /// The second a booking lands past the ideal one. Mirrors the vault's draw, so tests can aim at it.
    function _jitter() internal view returns (uint256) {
        return uint256(keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao))) % 30;
    }

    function _redeem(address user, uint256 shares) internal returns (uint256 whbarOut, uint256[] memory legAmounts) {
        vm.startPrank(user);
        share.approve(address(vault), shares);
        (whbarOut, legAmounts) = vault.redeem(shares);
        vm.stopPrank();
    }

    /// Plays the network's part: warps to a recorded schedule's second, optionally keeps the oracle fresh, and runs the
    /// call as the scheduling contract with the gas it was booked with.
    function _runSchedule(uint256 index, bool refreshOracle) internal returns (bool ok, bytes memory ret) {
        MockHss.ScheduledCall memory c = hss.callAt(index);
        vm.warp(c.expirySecond);
        if (refreshOracle) feed.set(HBAR_USD, block.timestamp);
        vm.prank(c.to);
        (ok, ret) = c.to.call{ gas: c.gasLimit }(c.callData);
    }

    // ------------------------------------------------------------ reads

    /// WHBAR value of a share balance at current spot prices: the holder's pro-rata slice of NAV.
    function _valueOf(uint256 shares) internal view returns (uint256) {
        return vault.nav() * shares / share.totalSupply();
    }

    /// WHBAR value, at the fixture's spot prices, of a bundle of in-kind redemption proceeds.
    function _bundleValue(uint256 whbarOut, uint256[] memory legAmounts) internal pure returns (uint256 total) {
        total = whbarOut;
        total += legAmounts[0] * SAUCE_PRICE_NUM / SAUCE_PRICE_DEN;
        total += legAmounts[1] * USDC_PRICE_NUM / USDC_PRICE_DEN;
    }

    /// Basis-point weight of each holding row against NAV.
    function _weightsBps() internal view returns (uint256[3] memory w) {
        BasketVault.Holding[] memory rows = vault.holdings();
        uint256 navNow = vault.nav();
        for (uint256 i; i < 3; ++i) {
            w[i] = rows[i].valueWhbar * 10_000 / navNow;
        }
    }

    /// Index of the first log in `logs` whose first topic is `sig`, or type(uint256).max.
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
}
