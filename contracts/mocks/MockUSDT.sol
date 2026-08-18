// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev DEV/TESTNET ONLY. Never deploy to a production/mainnet network —
/// mint() below is public and unrestricted. Explicitly OUT OF SCOPE for the
/// SubscriptionManager security audit; production deployments must point
/// SubscriptionManager at the real USDT contract for that chain instead
/// (see scripts/deploy.js's PRODUCTION_NETWORKS handling).
///
/// approve() deliberately replicates real Ethereum-mainnet USDT's quirk:
/// it reverts when changing a nonzero allowance directly to another nonzero
/// value (caller must reset to 0 first) — this mock exists specifically so
/// that quirk gets exercised on testnet before ConfirmSubscription's
/// reset-to-zero handling ever meets the real contract on mainnet.
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {
        _mint(msg.sender, 1_000_000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        require(value == 0 || allowance(msg.sender, spender) == 0, "USDT: reset allowance to 0 first");
        return super.approve(spender, value);
    }

    /**
     * @notice Faucet publik untuk testing multi-akun di Remix/testnet.
     *         HANYA untuk mock token — JANGAN pernah taruh mint publik
     *         di token produksi yang punya nilai riil.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
