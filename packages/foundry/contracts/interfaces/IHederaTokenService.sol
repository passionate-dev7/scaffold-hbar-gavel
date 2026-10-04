// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/// The slice of the HTS precompile at 0x167 the desk reads: a token's custom fee schedule (HIP-514).
/// Struct layouts match the official IHederaTokenService for ABI compatibility.
interface IHederaTokenService {
    struct FixedFee {
        int64 amount;
        address tokenId;
        bool useHbarsForPayment;
        bool useCurrentTokenForPayment;
        address feeCollector;
    }

    struct FractionalFee {
        int64 numerator;
        int64 denominator;
        int64 minimumAmount;
        int64 maximumAmount;
        bool netOfTransfers;
        address feeCollector;
    }

    struct RoyaltyFee {
        int64 numerator;
        int64 denominator;
        int64 amount;
        address tokenId;
        bool useHbarsForPayment;
        address feeCollector;
    }

    /// @return responseCode SUCCESS is 22.
    function getTokenCustomFees(address token)
        external
        returns (
            int64 responseCode,
            FixedFee[] memory fixedFees,
            FractionalFee[] memory fractionalFees,
            RoyaltyFee[] memory royaltyFees
        );
}
