// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev TEST ONLY. An ERC20 that attempts to re-enter an arbitrary target
/// during transferFrom, used solely to verify SubscriptionManager's
/// nonReentrant guards actually block reentrancy. Never deploy for real use.
contract ReentrantToken is ERC20 {
    address public attackTarget;
    bytes public attackCalldata;
    bool public attackSucceeded;
    bool private attacking;

    constructor() ERC20("Reentrant Token", "RTK") {
        _mint(msg.sender, 1_000_000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setAttack(address target, bytes calldata data) external {
        attackTarget = target;
        attackCalldata = data;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (attackTarget != address(0) && !attacking) {
            attacking = true;
            (bool ok, ) = attackTarget.call(attackCalldata);
            attackSucceeded = ok;
            attacking = false;
        }
        return super.transferFrom(from, to, amount);
    }
}
