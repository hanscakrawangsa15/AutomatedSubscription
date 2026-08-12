// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Standard TronBox/Truffle migration-bookkeeping contract — required by
/// `tronbox migrate` to track which migration scripts have already run on
/// TRON Nile testnet. Not part of the application; never referenced by the
/// EVM Hardhat deployments or by SubscriptionManager itself.
contract Migrations {
    address public owner = msg.sender;
    uint256 public last_completed_migration;

    modifier restricted() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function setCompleted(uint256 completed) public restricted {
        last_completed_migration = completed;
    }
}
