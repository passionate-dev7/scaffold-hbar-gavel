// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { LowLevelCall } from "@openzeppelin/contracts/utils/LowLevelCall.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";
import { IHRC719 } from "./interfaces/IHRC719.sol";
import { ISaucerSwapV2Router, ISaucerSwapV2Factory, IWhbarHelper } from "./interfaces/ISaucerSwapV2.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";

/// @title BackstopDesk
/// @notice An RFQ desk with a guaranteed exit. A taker escrows a swap order. Market makers answer with EIP-712 quotes
/// posted to a Hedera Consensus Service topic; the best quote settles atomically here through HTS allowances, inside
/// a Chainlink sanity band. If nobody fills before the order expires, the order's own Hedera Schedule Service call
/// swaps the escrow on SaucerSwap V2 and pays the taker, so every order ends in tokens or a refund.
/// @dev No owner, no admin, no fee. Native HBAR in the desk is fuel for scheduled fallbacks. Each order pays
/// `fuelPerOrder` up front; a fill or a cancel deletes the schedule and refunds that fuel in full, a fallback keeps it
/// to pay for the run and to keep the pool deep for the next one.
contract BackstopDesk is EIP712, ReentrancyGuard {
    enum Status {
        Open,
        Filled,
        FellBack,
        Cancelled,
        Refunded
    }

    /// @notice One escrowed swap. `claimable` is tokenIn still held for the taker after a refund that could not be
    /// paid (the taker was not associated with tokenIn); `claim` pays it.
    struct Order {
        address taker;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        uint256 amountIn;
        uint256 minOut;
        uint64 expiry;
        address schedule;
        Status status;
        uint8 rearms;
        uint256 fuel;
        uint256 claimable;
    }

    /// @notice A maker's offer for one order: pay `amountOut` of the order's tokenOut to the taker.
    struct Quote {
        address maker;
        uint256 amountOut;
        uint64 deadline;
        uint256 nonce;
    }

    struct Config {
        address router;
        address factory;
        address whbarHelper;
        address whbar;
        address hbarUsdFeed;
        address usdToken;
        uint8 usdDecimals;
        uint256 maxOracleAge;
        uint256 maxDeviationBps;
        uint256 fuelPerOrder;
        uint256 scheduledGas;
    }

    IHederaTokenService private constant HTS = IHederaTokenService(address(0x167));
    IHederaScheduleService private constant HSS = IHederaScheduleService(address(0x16b));
    int64 private constant SUCCESS = 22;
    int64 private constant TOKEN_ALREADY_ASSOCIATED = 194;
    uint256 private constant BPS = 10_000;
    bytes32 private constant QUOTE_TYPEHASH =
        keccak256("Quote(uint256 orderId,address maker,uint256 amountOut,uint64 deadline,uint256 nonce)");

    /// @notice A self-contained scheduled call under 3M gas is not reliable on Hedera; see docs/hedera-gotchas.md.
    uint256 public constant MIN_SCHEDULED_GAS = 3_000_000;
    uint256 public constant MIN_TTL = 60;
    /// @notice Hedera refuses expiries more than 62 days out.
    uint256 public constant MAX_TTL = 60 days;
    /// @notice Seconds past expiry before a stale schedule may be replaced, and how many times.
    uint256 public constant RETRY_GRACE = 300;
    uint8 public constant MAX_REARMS = 3;
    /// Gas a failed swap leaves for the refund transfer and its events.
    uint256 private constant REFUND_RESERVE = 400_000;
    /// Seconds past the ideal second to probe for a free slot: 1, 2, 4, 8, 16, 32, 64.
    uint256 private constant MAX_CAPACITY_DELAY = 64;

    ISaucerSwapV2Router public immutable router;
    ISaucerSwapV2Factory public immutable factory;
    IWhbarHelper public immutable whbarHelper;
    address public immutable whbar;
    AggregatorV3Interface public immutable hbarUsdFeed;
    /// @notice The USD stablecoin the Chainlink band applies to when paired with WHBAR.
    address public immutable usdToken;
    /// @notice Decimals of `usdToken`, set at deployment because an HTS token cannot be called from a script simulation.
    uint8 public immutable usdDecimals;
    uint256 public immutable maxOracleAge;
    /// @notice Most a quote may fall below the Chainlink-implied amount, in basis points.
    uint256 public immutable maxDeviationBps;
    /// @notice Native HBAR (tinybar) every order must send on top of any HBAR it swaps.
    uint256 public immutable fuelPerOrder;
    uint256 public immutable scheduledGas;

    uint256 public orderCount;
    /// @notice tokenIn held in escrow per token: open orders plus unclaimed refunds.
    mapping(address token => uint256) public escrowed;
    mapping(address token => bool) public associated;
    /// @notice Permit2-style unordered nonces: bit `nonce % 256` of word `nonce / 256`. A set bit is a used or cancelled
    /// nonce.
    mapping(address maker => mapping(uint256 wordPos => uint256)) public nonceBitmap;
    mapping(uint256 id => Order) private _orders;

    event OrderPosted(
        uint256 indexed id,
        address indexed taker,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        uint64 expiry,
        address schedule,
        uint256 fallbackAt
    );
    event Filled(uint256 indexed id, address indexed maker, uint256 amountOut);
    event FellBack(uint256 indexed id, uint256 amountOut);
    event Refunded(uint256 indexed id, bytes reason);
    event Claimed(uint256 indexed id, uint256 amount);
    event Cancelled(uint256 indexed id);
    /// @notice The Schedule Service's answer to deleting an order's schedule. 22 is success.
    event ScheduleDeleted(uint256 indexed id, address schedule, int64 responseCode);
    event Rearmed(uint256 indexed id, address schedule, uint256 fallbackAt);
    event FallbackSkipped(uint256 indexed id, Status status);
    event FuelRefundFailed(uint256 indexed id, address taker, uint256 amount);
    event NoncesCancelled(address indexed maker, uint256 wordPos, uint256 mask);
    event Associated(address indexed token);

    error BadConfig();
    error ZeroAmount();
    error BadTtl(uint256 ttl);
    error SameToken();
    error NoPool(address tokenIn, address tokenOut, uint24 fee);
    error InsufficientValue(uint256 sent, uint256 required);
    error ScheduleFailed(int64 responseCode);
    error HtsCallFailed(int64 responseCode);
    error TransferFailed(address token);
    error NotOpen(uint256 id, Status status);
    error UnknownOrder(uint256 id);
    error OrderExpired(uint256 id);
    error QuoteExpired(uint64 deadline);
    error BadSignature();
    error NonceAlreadyUsed(address maker, uint256 nonce);
    error QuoteBelowMin(uint256 amountOut, uint256 minOut);
    error QuoteOutsideBand(uint256 amountOut, uint256 floor);
    error StaleOracle(uint256 updatedAt);
    error BadOraclePrice(int256 answer);
    error OnlyTaker();
    error CustomFees(address token);
    error UnexpectedReceived(uint256 expected, uint256 received);
    error Insolvent(address token);
    error OnlySelf();
    error NothingToClaim(uint256 id);
    error CannotRearm(uint256 id);

    constructor(Config memory c) EIP712("Backstop", "1") {
        if (
            c.router == address(0) || c.factory == address(0) || c.whbarHelper == address(0) || c.whbar == address(0)
                || c.hbarUsdFeed == address(0) || c.usdToken == address(0) || c.usdDecimals > 18 || c.maxOracleAge == 0
                || c.maxDeviationBps == 0 || c.maxDeviationBps >= BPS || c.fuelPerOrder == 0
                || c.scheduledGas < MIN_SCHEDULED_GAS || AggregatorV3Interface(c.hbarUsdFeed).decimals() != 8
        ) revert BadConfig();
        router = ISaucerSwapV2Router(c.router);
        factory = ISaucerSwapV2Factory(c.factory);
        whbarHelper = IWhbarHelper(c.whbarHelper);
        whbar = c.whbar;
        hbarUsdFeed = AggregatorV3Interface(c.hbarUsdFeed);
        usdToken = c.usdToken;
        usdDecimals = c.usdDecimals;
        maxOracleAge = c.maxOracleAge;
        maxDeviationBps = c.maxDeviationBps;
        fuelPerOrder = c.fuelPerOrder;
        scheduledGas = c.scheduledGas;
    }

    /// @notice Native HBAR sent here is fuel for scheduled fallbacks.
    receive() external payable { }

    // ---------------------------------------------------------------- setup

    /// @notice Associates the desk with `tokens` so it can hold them (HIP-719). Anyone may call; already associated
    /// tokens are skipped. `postOrder` associates its own tokenIn on first use, so this only pre-pays the gas.
    function associateTokens(address[] calldata tokens) external {
        for (uint256 i; i < tokens.length; ++i) {
            _associate(tokens[i]);
        }
    }

    // ---------------------------------------------------------------- orders

    /// @notice Escrows `amountIn` of `tokenIn` and books the fallback swap for `ttl` seconds from now.
    /// @dev With tokenIn == WHBAR the order is funded in native HBAR: send `amountIn + fuel` and the desk wraps
    /// `amountIn`. With any other tokenIn the desk pulls `amountIn` through the taker's allowance and `msg.value` is
    /// all fuel. Either way fuel is at least `fuelPerOrder`.
    /// @param fee SaucerSwap V2 fee tier of the fallback pool, which must exist.
    /// @param minOut Floor for both the fallback swap and every quote. Must be non-zero.
    function postOrder(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut, uint256 ttl)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (amountIn == 0 || minOut == 0) revert ZeroAmount();
        if (ttl < MIN_TTL || ttl > MAX_TTL) revert BadTtl(ttl);
        if (tokenIn == tokenOut) revert SameToken();
        if (factory.getPool(tokenIn, tokenOut, fee) == address(0)) revert NoPool(tokenIn, tokenOut, fee);
        _requireNoCustomFees(tokenIn);
        _requireNoCustomFees(tokenOut);

        uint256 fuel = _escrowIn(tokenIn, amountIn);

        id = ++orderCount;
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 expiry = uint64(block.timestamp + ttl);
        Order storage o = _orders[id];
        o.taker = msg.sender;
        o.tokenIn = tokenIn;
        o.tokenOut = tokenOut;
        o.fee = fee;
        o.amountIn = amountIn;
        o.minOut = minOut;
        o.expiry = expiry;
        o.fuel = fuel;

        (uint256 fallbackAt, address schedule) = _book(id, expiry);
        o.schedule = schedule;
        emit OrderPosted(id, msg.sender, tokenIn, tokenOut, fee, amountIn, minOut, expiry, schedule, fallbackAt);
    }

    /// @notice Settles an open order with a maker's signed quote. The maker must have approved this desk for
    /// `amountOut` of tokenOut and hold it; the taker must be associated with tokenOut. Only the order's taker may submit it.
    function fillWithQuote(uint256 id, Quote calldata quote, bytes calldata signature) external nonReentrant {
        Order storage o = _openOrder(id);
        // Quotes are public on the topic. If anyone could submit one, a stranger could settle an order with the worst
        // valid quote on the board; only the taker picks which maker wins.
        if (msg.sender != o.taker) revert OnlyTaker();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= o.expiry) revert OrderExpired(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > quote.deadline) revert QuoteExpired(quote.deadline);
        if (quote.amountOut < o.minOut) revert QuoteBelowMin(quote.amountOut, o.minOut);

        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(_digest(id, quote), signature);
        if (err != ECDSA.RecoverError.NoError || signer != quote.maker || signer == address(0)) revert BadSignature();
        if (nonceUsed(signer, quote.nonce)) revert NonceAlreadyUsed(signer, quote.nonce);

        uint256 floor = _oracleFloor(o);
        if (quote.amountOut < floor) revert QuoteOutsideBand(quote.amountOut, floor);

        nonceBitmap[signer][quote.nonce >> 8] |= _nonceBit(quote.nonce);
        o.status = Status.Filled;
        escrowed[o.tokenIn] -= o.amountIn;
        address taker = o.taker;

        if (!IERC20(o.tokenOut).transferFrom(signer, taker, quote.amountOut)) revert TransferFailed(o.tokenOut);
        if (!IERC20(o.tokenIn).transfer(signer, o.amountIn)) revert TransferFailed(o.tokenIn);
        _requireCovered(o.tokenIn);

        _deleteSchedule(id, o);
        uint256 fuel = o.fuel;
        o.fuel = 0;
        if (fuel != 0) {
            if (!LowLevelCall.callNoReturn(taker, fuel, "")) emit FuelRefundFailed(id, taker, fuel);
        }
        emit Filled(id, signer, quote.amountOut);
    }

    /// @notice Cancels an open order before it expires: deletes its schedule and returns the escrow and the fuel.
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _openOrder(id);
        if (msg.sender != o.taker) revert OnlyTaker();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= o.expiry) revert OrderExpired(id);
        o.status = Status.Cancelled;
        escrowed[o.tokenIn] -= o.amountIn;
        _deleteSchedule(id, o);
        uint256 fuel = o.fuel;
        o.fuel = 0;
        if (!IERC20(o.tokenIn).transfer(o.taker, o.amountIn)) revert TransferFailed(o.tokenIn);
        _requireCovered(o.tokenIn);
        if (fuel != 0) {
            if (!LowLevelCall.callNoReturn(o.taker, fuel, "")) revert TransferFailed(address(0));
        }
        emit Cancelled(id);
    }

    /// @notice Entry point of the scheduled fallback. The network runs it with msg.sender set to this desk.
    /// @dev Never reverts after the caller check: an order that is no longer open is skipped, a swap that fails
    /// refunds the escrow, and a refund that fails leaves the escrow claimable. Reverting here would waste the only
    /// attempt the schedule gets.
    function fallbackFill(uint256 id) external {
        if (msg.sender != address(this)) revert OnlySelf();
        Order storage o = _orders[id];
        if (o.status != Status.Open || o.taker == address(0)) {
            emit FallbackSkipped(id, o.status);
            return;
        }
        o.status = Status.FellBack;
        escrowed[o.tokenIn] -= o.amountIn;
        // The swap runs in its own frame with all but REFUND_RESERVE of the gas, and its return data is read as two words
        // at most, so a pool or token that burns gas or reverts with a huge payload still leaves room to refund.
        (bool ok, bytes32 first, bytes32 second, uint256 size) = _selfCall(abi.encodeCall(this.swapEscrow, (id)));
        if (ok) {
            emit FellBack(id, uint256(first));
            return;
        }
        bytes memory reason = abi.encodePacked(first, second);
        size = Math.min(size, 64);
        assembly ("memory-safe") {
            mstore(reason, size)
        }
        o.status = Status.Refunded;
        (bool sent, bytes32 word,) =
            LowLevelCall.callReturn64Bytes(o.tokenIn, abi.encodeCall(IERC20.transfer, (o.taker, o.amountIn)));
        if (!(sent && LowLevelCall.returnDataSize() >= 32 && word == bytes32(uint256(1)))) _holdForClaim(o);
        emit Refunded(id, reason);
    }

    /// @notice Swaps an order's escrow on SaucerSwap V2 straight to the taker. Only `fallbackFill` calls it, from an
    /// external frame so a failed swap unwinds on its own.
    function swapEscrow(uint256 id) external returns (uint256 amountOut) {
        if (msg.sender != address(this)) revert OnlySelf();
        Order storage o = _orders[id];
        address tokenIn = o.tokenIn;
        uint256 amountIn = o.amountIn;
        // An HTS approval from a contract costs about 700k gas and HTS refuses one above max supply: approve the
        // token's total supply once, then only when short.
        if (IERC20(tokenIn).allowance(address(this), address(router)) < amountIn) {
            if (!IERC20(tokenIn).approve(address(router), IERC20(tokenIn).totalSupply())) {
                revert TransferFailed(tokenIn);
            }
        }
        amountOut = router.exactInput(
            ISaucerSwapV2Router.ExactInputParams({
                path: abi.encodePacked(tokenIn, o.fee, o.tokenOut),
                recipient: o.taker,
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: o.minOut
            })
        );
    }

    /// @notice Pays out an escrow that a failed refund left behind, once the taker can receive the token.
    function claim(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        uint256 amount = o.claimable;
        if (amount == 0) revert NothingToClaim(id);
        if (msg.sender != o.taker) revert OnlyTaker();
        o.claimable = 0;
        escrowed[o.tokenIn] -= amount;
        if (!IERC20(o.tokenIn).transfer(o.taker, amount)) revert TransferFailed(o.tokenIn);
        _requireCovered(o.tokenIn);
        emit Claimed(id, amount);
    }

    /// @notice Books a fresh fallback for an open order whose schedule did not settle it: the run was refused or
    /// could not be paid. Allowed `RETRY_GRACE` seconds after expiry, at most `MAX_REARMS` times. A stale schedule
    /// that still runs finds the order settled and skips it.
    function rearm(uint256 id) external nonReentrant {
        Order storage o = _openOrder(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < o.expiry + RETRY_GRACE || o.rearms >= MAX_REARMS) revert CannotRearm(id);
        ++o.rearms;
        (uint256 fallbackAt, address schedule) = _book(id, block.timestamp);
        o.schedule = schedule;
        emit Rearmed(id, schedule, fallbackAt);
    }

    /// @notice Cancels signed quotes in bulk: every bit set in `mask` withdraws nonce `wordPos * 256 + bit`, so one
    /// transaction can retire up to 256 quotes.
    function cancelNonces(uint256 wordPos, uint256 mask) external {
        nonceBitmap[msg.sender][wordPos] |= mask;
        emit NoncesCancelled(msg.sender, wordPos, mask);
    }

    // ---------------------------------------------------------------- views

    /// @notice Whether `maker`'s nonce is spent or cancelled.
    function nonceUsed(address maker, uint256 nonce) public view returns (bool) {
        return nonceBitmap[maker][nonce >> 8] & _nonceBit(nonce) != 0;
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    /// @notice The EIP-712 digest a maker signs for `quote` on order `id`.
    function quoteDigest(uint256 id, Quote calldata quote) external view returns (bytes32) {
        return _digest(id, quote);
    }

    /// @notice Chainlink HBAR/USD with 8 decimals. Reverts if the answer is stale or not positive.
    function hbarUsd() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = hbarUsdFeed.latestRoundData();
        if (answer <= 0) revert BadOraclePrice(answer);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > updatedAt + maxOracleAge) revert StaleOracle(updatedAt);
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(answer);
    }

    /// @notice Lowest quote the Chainlink band admits for order `id`, or 0 when the pair is not WHBAR against the USD
    /// token (the order's own `minOut` is then the only floor). Reverts when the feed is stale and the band applies.
    function oracleFloor(uint256 id) external view returns (uint256) {
        return _oracleFloor(_orders[id]);
    }

    // ---------------------------------------------------------------- internals

    function _nonceBit(uint256 nonce) private pure returns (uint256) {
        return uint256(1) << (nonce & 0xff);
    }

    function _openOrder(uint256 id) private view returns (Order storage o) {
        o = _orders[id];
        if (o.taker == address(0)) revert UnknownOrder(id);
        if (o.status != Status.Open) revert NotOpen(id, o.status);
    }

    function _digest(uint256 id, Quote calldata q) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, id, q.maker, q.amountOut, q.deadline, q.nonce)));
    }

    function _oracleFloor(Order storage o) private view returns (uint256 floor) {
        uint256 implied;
        if (o.tokenIn == whbar && o.tokenOut == usdToken) {
            // tinybar (1e8) x USD/HBAR (1e8) -> USD token units
            implied = Math.mulDiv(o.amountIn, hbarUsd() * 10 ** usdDecimals, 1e16);
        } else if (o.tokenIn == usdToken && o.tokenOut == whbar) {
            implied = Math.mulDiv(o.amountIn, 1e16, hbarUsd() * 10 ** usdDecimals);
        } else {
            return 0;
        }
        floor = implied * (BPS - maxDeviationBps) / BPS;
    }

    /// Books `fallbackFill(id)` at the first second from `ideal` with capacity. Reverts when the Schedule Service
    /// refuses: an order with no fallback is not an order this desk takes.
    function _book(uint256 id, uint256 ideal) private returns (uint256 second, address schedule) {
        second = _secondWithCapacity(ideal);
        int64 rc;
        (rc, schedule) =
            HSS.scheduleCall(address(this), second, scheduledGas, 0, abi.encodeCall(this.fallbackFill, (id)));
        if (rc != SUCCESS) revert ScheduleFailed(rc);
    }

    /// HIP-1215's probe for a busy second: +1, +2, +4 ... +64 seconds. If none has capacity, scheduleCall reports
    /// SCHEDULE_EXPIRY_IS_BUSY.
    function _secondWithCapacity(uint256 ideal) private view returns (uint256) {
        if (HSS.hasScheduleCapacity(ideal, scheduledGas)) return ideal;
        for (uint256 delay = 1; delay <= MAX_CAPACITY_DELAY; delay *= 2) {
            if (HSS.hasScheduleCapacity(ideal + delay, scheduledGas)) return ideal + delay;
        }
        return ideal;
    }

    function _selfCall(bytes memory data) private returns (bool ok, bytes32 first, bytes32 second, uint256 size) {
        uint256 available = gasleft();
        uint256 cap = available > 2 * REFUND_RESERVE ? available - REFUND_RESERVE : available / 2;
        assembly ("memory-safe") {
            ok := call(cap, address(), 0, add(data, 0x20), mload(data), 0x00, 0x40)
            first := mload(0x00)
            second := mload(0x20)
            size := returndatasize()
        }
    }

    function _deleteSchedule(uint256 id, Order storage o) private {
        address schedule = o.schedule;
        o.schedule = address(0);
        emit ScheduleDeleted(id, schedule, HSS.deleteSchedule(schedule));
    }

    function _holdForClaim(Order storage o) private {
        o.claimable = o.amountIn;
        escrowed[o.tokenIn] += o.amountIn;
    }

    /// Checks the order's fuel, associates the desk with tokenIn, pulls the escrow and returns the fuel. What arrives is
    /// measured, not trusted: a token that delivers less than it was asked to move cannot back an escrow.
    function _escrowIn(address tokenIn, uint256 amountIn) private returns (uint256 fuel) {
        fuel = msg.value;
        if (tokenIn == whbar) {
            fuel = msg.value > amountIn ? msg.value - amountIn : 0;
        }
        if (fuel < fuelPerOrder) {
            revert InsufficientValue(msg.value, tokenIn == whbar ? amountIn + fuelPerOrder : fuelPerOrder);
        }

        _associate(tokenIn);
        uint256 heldBefore = IERC20(tokenIn).balanceOf(address(this));
        if (tokenIn == whbar) {
            whbarHelper.deposit{ value: amountIn }();
        } else if (!IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn)) {
            revert TransferFailed(tokenIn);
        }
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - heldBefore;
        if (received != amountIn) revert UnexpectedReceived(amountIn, received);
        escrowed[tokenIn] += amountIn;
    }

    /// A token with a custom fee schedule moves a different amount than it is told to, so the desk's books would drift
    /// from its balances. Refuse it at the door; WHBAR, USDC and SAUCE carry none and have no fee schedule key.
    function _requireNoCustomFees(address token) private {
        (
            int64 rc,
            IHederaTokenService.FixedFee[] memory fixedFees,
            IHederaTokenService.FractionalFee[] memory fractionalFees,
            IHederaTokenService.RoyaltyFee[] memory royaltyFees
        ) = HTS.getTokenCustomFees(token);
        if (rc != SUCCESS) revert HtsCallFailed(rc);
        if (fixedFees.length + fractionalFees.length + royaltyFees.length != 0) revert CustomFees(token);
    }

    /// After a payout the desk must still hold everything it owes. A transfer that cost the desk more than it
    /// delivered would be paid out of other orders' escrow; revert instead.
    function _requireCovered(address token) private view {
        if (IERC20(token).balanceOf(address(this)) < escrowed[token]) revert Insolvent(token);
    }

    function _associate(address token) private {
        if (associated[token]) return;
        int64 rc = IHRC719(token).associate();
        if (rc != SUCCESS && rc != TOKEN_ALREADY_ASSOCIATED) revert HtsCallFailed(rc);
        associated[token] = true;
        emit Associated(token);
    }
}
