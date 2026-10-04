// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { IHRC719 } from "../../contracts/interfaces/IHRC719.sol";

/// @notice Test stand-in for an HTS fungible token seen through its EVM facade: ERC-20 plus HIP-719
/// `associate()`. As on Hedera, an account cannot receive the token until it is associated with it, and
/// `transferFrom` over the allowance or the balance reverts without revert data. With `quietFailure` set
/// it returns false instead. Given a maximum supply, the token refuses an allowance above it, as a
/// finite-supply HTS token does. `freeze` blocks an account from sending or receiving, as a freeze key does. `approveCount` and `lastApproveValue` let tests assert how often, and
/// for how much, a contract pays for an approval.
contract MockHtsToken is ERC20, IHRC719 {
    int64 private constant SUCCESS = 22;
    int64 private constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    uint8 private immutable _decimals;
    mapping(address account => bool) public associated;
    bool public quietFailure;
    /// 0 for an infinite supply.
    uint256 public maxSupply;
    /// Non-zero makes `associate()` return this code without associating.
    int64 public forcedAssociateCode;
    uint256 public approveCount;
    uint256 public lastApproveValue;

    event Associated(address indexed account);

    /// Accounts the token's freeze key has frozen: they can neither send nor receive it.
    mapping(address account => bool) public frozen;

    error TokenNotAssociatedToAccount(address account);
    error AccountFrozenForToken(address account);
    error AmountExceedsTokenMaxSupply();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function freeze(address account, bool isFrozen) external {
        frozen[account] = isFrozen;
    }

    function setQuietFailure(bool quiet) external {
        quietFailure = quiet;
    }

    function setMaxSupply(uint256 maxSupply_) external {
        maxSupply = maxSupply_;
    }

    function setForcedAssociateCode(int64 code) external {
        forcedAssociateCode = code;
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        if (maxSupply != 0 && value > maxSupply) revert AmountExceedsTokenMaxSupply();
        ++approveCount;
        lastApproveValue = value;
        return super.approve(spender, value);
    }

    function transferFrom(address from, address to, uint256 value) public virtual override returns (bool) {
        if (allowance(from, msg.sender) < value || balanceOf(from) < value) {
            if (quietFailure) return false;
            revert();
        }
        return super.transferFrom(from, to, value);
    }

    function associate() external returns (int64 responseCode) {
        if (forcedAssociateCode != 0) return forcedAssociateCode;
        if (associated[msg.sender]) return TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT;
        associated[msg.sender] = true;
        emit Associated(msg.sender);
        return SUCCESS;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && !associated[to]) revert TokenNotAssociatedToAccount(to);
        if (frozen[from]) revert AccountFrozenForToken(from);
        if (frozen[to]) revert AccountFrozenForToken(to);
        super._update(from, to, value);
    }
}
