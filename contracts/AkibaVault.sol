// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract AkibaVault {
    error AmountMustBePositive();
    error InsufficientBankroll();
    error SavingsStillLocked(uint256 unlockAt);
    error TransferFailed();

    event Deposited(address indexed user, uint256 amount);
    event ProtectionRulesUpdated(address indexed user, uint256 monthlyLossLimit, uint256 lockSeconds);
    event SavingsProtected(address indexed user, uint256 amount, uint256 unlockAt);
    event SavingsUnlockedToBankroll(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    struct Account {
        uint256 bankroll;
        uint256 protectedSavings;
        uint256 unlockAt;
        uint256 monthlyLossLimit;
        uint256 lockSeconds;
    }

    IERC20 public immutable stableToken;
    mapping(address => Account) public accounts;

    constructor(address stableTokenAddress) {
        stableToken = IERC20(stableTokenAddress);
    }

    function deposit(uint256 amount) external {
        if (amount == 0) revert AmountMustBePositive();
        if (!stableToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        accounts[msg.sender].bankroll += amount;
        emit Deposited(msg.sender, amount);
    }

    function setProtectionRulesSeconds(uint256 monthlyLossLimit, uint256 lockSeconds) external {
        Account storage account = accounts[msg.sender];
        account.monthlyLossLimit = monthlyLossLimit;
        account.lockSeconds = lockSeconds;

        emit ProtectionRulesUpdated(msg.sender, monthlyLossLimit, lockSeconds);
    }

    function protectBalance() external {
        Account storage account = accounts[msg.sender];
        uint256 amount = account.bankroll;
        if (amount == 0) revert AmountMustBePositive();

        account.bankroll = 0;
        account.protectedSavings += amount;
        account.unlockAt =
            block.timestamp + (account.lockSeconds == 0 ? 5 minutes : account.lockSeconds);

        emit SavingsProtected(msg.sender, amount, account.unlockAt);
    }

    function withdrawBankroll(uint256 amount) external {
        if (amount == 0) revert AmountMustBePositive();

        Account storage account = accounts[msg.sender];
        if (account.bankroll < amount) revert InsufficientBankroll();

        account.bankroll -= amount;
        if (!stableToken.transfer(msg.sender, amount)) revert TransferFailed();

        emit Withdrawn(msg.sender, amount);
    }

    function unlockProtectedToBankroll() external {
        Account storage account = accounts[msg.sender];
        uint256 amount = account.protectedSavings;

        if (amount == 0) revert AmountMustBePositive();
        if (block.timestamp < account.unlockAt) revert SavingsStillLocked(account.unlockAt);

        account.protectedSavings = 0;
        account.unlockAt = 0;
        account.bankroll += amount;

        emit SavingsUnlockedToBankroll(msg.sender, amount);
    }
}
