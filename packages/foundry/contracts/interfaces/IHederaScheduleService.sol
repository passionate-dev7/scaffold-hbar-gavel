// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

/// Hedera Schedule Service system contract at 0x16b (HIP-755, HIP-1215).
interface IHederaScheduleService {
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);

    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
