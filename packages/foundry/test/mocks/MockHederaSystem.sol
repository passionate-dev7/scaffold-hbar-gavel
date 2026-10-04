// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { MockHtsToken } from "./MockHtsToken.sol";
import { IHederaTokenService } from "../../contracts/interfaces/IHederaTokenService.sol";

/// @notice The share token the HTS mock creates: an HTS facade whose treasury is associated from birth and whose
/// supply only the HTS mock can change, by minting to and burning from the treasury.
contract MockShareToken is MockHtsToken {
    address public immutable hts;
    address public immutable treasury;

    error OnlyHts();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address treasury_)
        MockHtsToken(name_, symbol_, decimals_)
    {
        hts = msg.sender;
        treasury = treasury_;
        associated[treasury_] = true;
    }

    function htsMint(uint256 amount) external {
        if (msg.sender != hts) revert OnlyHts();
        _mint(treasury, amount);
    }

    function htsBurn(uint256 amount) external {
        if (msg.sender != hts) revert OnlyHts();
        _burn(treasury, amount);
    }
}

/// @notice Test stand-in for the HTS system contract at 0x167 (`vm.etch`, so storage starts empty and a zero
/// forced code means "behave"). `createFungibleToken` deploys a MockShareToken, returns to the caller the
/// HBAR the creation fee does not take, and records who holds the supply key; `mintToken` and `burnToken` act on the
/// treasury only for that key holder, as the real service does.
contract MockHts {
    int64 private constant SUCCESS = 22;
    int64 private constant INVALID_SIGNATURE = 7;
    int64 private constant INSUFFICIENT_TX_FEE = 9;
    int64 private constant INSUFFICIENT_TOKEN_BALANCE = 178;
    uint256 private constant SUPPLY_KEY = 16;

    int64 public forcedCreateCode;
    int64 public forcedMintCode;
    int64 public forcedBurnCode;
    /// HBAR the creation keeps; the rest of msg.value goes back to the caller.
    uint256 public createFee;

    uint256 public createCount;
    uint256 public mintCount;
    uint256 public burnCount;
    address public lastCreated;
    uint256 public lastCreateValue;
    uint256 public lastKeyCount;
    uint256 public lastKeyType;
    address public lastAutoRenewAccount;
    int64 public lastAutoRenewPeriod;
    bool public lastFiniteSupply;
    int64 public lastInitialSupply;
    mapping(address token => address) public supplyKeyHolder;

    function setForcedCodes(int64 create, int64 mint, int64 burn) external {
        forcedCreateCode = create;
        forcedMintCode = mint;
        forcedBurnCode = burn;
    }

    function setCreateFee(uint256 fee) external {
        createFee = fee;
    }

    function createFungibleToken(IHederaTokenService.HederaToken memory token, int64 initialTotalSupply, int32 decimals)
        external
        payable
        returns (int64 responseCode, address tokenAddress)
    {
        if (forcedCreateCode != 0) return (forcedCreateCode, address(0));
        if (msg.value < createFee) return (INSUFFICIENT_TX_FEE, address(0));
        // forge-lint: disable-next-line(unsafe-typecast)
        MockShareToken created = new MockShareToken(token.name, token.symbol, uint8(uint32(decimals)), token.treasury);
        tokenAddress = address(created);
        for (uint256 i; i < token.tokenKeys.length; ++i) {
            if (token.tokenKeys[i].keyType & SUPPLY_KEY != 0) {
                supplyKeyHolder[tokenAddress] = token.tokenKeys[i].key.contractId;
                lastKeyType = token.tokenKeys[i].keyType;
            }
        }
        lastKeyCount = token.tokenKeys.length;
        lastAutoRenewAccount = token.expiry.autoRenewAccount;
        lastAutoRenewPeriod = token.expiry.autoRenewPeriod;
        lastFiniteSupply = token.tokenSupplyType;
        lastInitialSupply = initialTotalSupply;
        lastCreated = tokenAddress;
        lastCreateValue = msg.value;
        ++createCount;
        if (msg.value > createFee) {
            (bool ok,) = msg.sender.call{ value: msg.value - createFee }("");
            require(ok, "refund failed");
        }
        return (SUCCESS, tokenAddress);
    }

    function mintToken(address token, int64 amount, bytes[] memory)
        external
        returns (int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers)
    {
        serialNumbers = new int64[](0);
        if (forcedMintCode != 0) return (forcedMintCode, 0, serialNumbers);
        if (msg.sender != supplyKeyHolder[token]) return (INVALID_SIGNATURE, 0, serialNumbers);
        // forge-lint: disable-next-line(unsafe-typecast)
        MockShareToken(token).htsMint(uint256(uint64(amount)));
        ++mintCount;
        // forge-lint: disable-next-line(unsafe-typecast)
        return (SUCCESS, int64(int256(MockShareToken(token).totalSupply())), serialNumbers);
    }

    function burnToken(address token, int64 amount, int64[] memory)
        external
        returns (int64 responseCode, int64 newTotalSupply)
    {
        if (forcedBurnCode != 0) return (forcedBurnCode, 0);
        if (msg.sender != supplyKeyHolder[token]) return (INVALID_SIGNATURE, 0);
        MockShareToken share = MockShareToken(token);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 value = uint256(uint64(amount));
        if (share.balanceOf(share.treasury()) < value) return (INSUFFICIENT_TOKEN_BALANCE, 0);
        share.htsBurn(value);
        ++burnCount;
        // forge-lint: disable-next-line(unsafe-typecast)
        return (SUCCESS, int64(int256(share.totalSupply())));
    }
}

/// @notice Test stand-in for the Hedera Schedule Service at 0x16b. Like the real service it never reverts: it
/// records every `scheduleCall` (refused ones included) and answers with SUCCESS unless told otherwise or the
/// requested second is marked busy. Tests replay a recorded call as the scheduling contract to play the network.
contract MockHss {
    struct ScheduledCall {
        address to;
        uint256 expirySecond;
        uint256 gasLimit;
        uint64 value;
        bytes callData;
        int64 responseCode;
        address schedule;
    }

    int64 private constant SUCCESS = 22;
    int64 private constant SCHEDULE_EXPIRY_IS_BUSY = 370;

    int64 public forcedScheduleCode;
    int64 public forcedDeleteCode;
    mapping(uint256 second => bool) public busy;
    address public lastDeleted;
    uint256 public deleteCount;
    ScheduledCall[] private _calls;

    function setForcedCodes(int64 schedule, int64 del) external {
        forcedScheduleCode = schedule;
        forcedDeleteCode = del;
    }

    function setBusy(uint256 second, bool isBusy) external {
        busy[second] = isBusy;
    }

    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address schedule)
    {
        responseCode =
            busy[expirySecond] ? SCHEDULE_EXPIRY_IS_BUSY : (forcedScheduleCode == 0 ? SUCCESS : forcedScheduleCode);
        // A schedule is a Hedera entity 0.0.N; its address is the long-zero form of N.
        if (responseCode == SUCCESS) schedule = address(uint160(0x5c4ed000 + _calls.length));
        _calls.push(ScheduledCall(to, expirySecond, gasLimit, value, callData, responseCode, schedule));
    }

    function hasScheduleCapacity(uint256 expirySecond, uint256) external view returns (bool) {
        return !busy[expirySecond];
    }

    function deleteSchedule(address scheduleAddress) external returns (int64) {
        lastDeleted = scheduleAddress;
        ++deleteCount;
        return forcedDeleteCode == 0 ? SUCCESS : forcedDeleteCode;
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 index) external view returns (ScheduledCall memory) {
        return _calls[index];
    }
}
