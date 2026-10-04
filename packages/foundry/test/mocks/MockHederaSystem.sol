// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHederaTokenService } from "../../contracts/interfaces/IHederaTokenService.sol";

/// @notice Test stand-in for the part of the HTS system contract at 0x167 the desk reads (`vm.etch`): a token's
/// custom fee schedule. Every token is fee-free until a test gives it a fee, as WHBAR, USDC and SAUCE are on testnet.
contract MockHtsFees {
    int64 private constant SUCCESS = 22;

    int64 public forcedCode;
    mapping(address token => uint256) public fixedFeeCount;
    mapping(address token => uint256) public fractionalFeeCount;
    mapping(address token => uint256) public royaltyFeeCount;

    function setForcedCode(int64 code) external {
        forcedCode = code;
    }

    function setFeeCounts(address token, uint256 fixedFees, uint256 fractionalFees, uint256 royaltyFees) external {
        fixedFeeCount[token] = fixedFees;
        fractionalFeeCount[token] = fractionalFees;
        royaltyFeeCount[token] = royaltyFees;
    }

    function getTokenCustomFees(address token)
        external
        view
        returns (
            int64 responseCode,
            IHederaTokenService.FixedFee[] memory fixedFees,
            IHederaTokenService.FractionalFee[] memory fractionalFees,
            IHederaTokenService.RoyaltyFee[] memory royaltyFees
        )
    {
        responseCode = forcedCode == 0 ? SUCCESS : forcedCode;
        fixedFees = new IHederaTokenService.FixedFee[](fixedFeeCount[token]);
        fractionalFees = new IHederaTokenService.FractionalFee[](fractionalFeeCount[token]);
        royaltyFees = new IHederaTokenService.RoyaltyFee[](royaltyFeeCount[token]);
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
    mapping(address schedule => bool) public deleted;
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
        if (forcedDeleteCode == 0) deleted[scheduleAddress] = true;
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
