// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev DEV/TESTNET ONLY. Never deploy to a production/mainnet network —
/// mint() below is public and unrestricted. Explicitly OUT OF SCOPE for the
/// SubscriptionManager security audit; production deployments must point
/// SubscriptionManager at the real USDC contract for that chain instead
/// (see scripts/deploy.js's PRODUCTION_NETWORKS handling).
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {
        _mint(msg.sender, 1_000_000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
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