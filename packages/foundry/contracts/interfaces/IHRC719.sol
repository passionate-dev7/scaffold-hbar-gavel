// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.19;

/// HIP-719: an HTS token's facade lets the caller associate itself with the token.
interface IHRC719 {
    function associate() external returns (int64 responseCode);
}
