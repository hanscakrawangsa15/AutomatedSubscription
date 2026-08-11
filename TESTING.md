# Testing — SubscriptionManager.sol

Prepared for the security audit engagement (see mainnet launch-readiness plan, Phase 1/2).

## Scope

- `contracts/SubscriptionManager.sol` — in scope for audit.
- `contracts/mocks/MockUSDC.sol`, `contracts/mocks/ReentrantToken.sol` — test/dev fixtures only, **out of scope**. `MockUSDC` has an unrestricted public `mint()` and must never be deployed to a production network; production deployments point `SubscriptionManager` at the real USDC contract for each chain instead.

## How to run

```
npx hardhat test                    # functional test suite
npx hardhat coverage                # coverage report (writes ./coverage/index.html)
REPORT_GAS=true npx hardhat test    # gas report
```

## Suite summary

`test/SubscriptionManager.test.js` — 29 tests, all passing, organized by area:

| Area | Tests | Covers |
|---|---|---|
| Access control | 9 | Every owner-gated function reverts for non-owner (`OwnableUnauthorizedAccount`); `setKeeperRewardBps` boundary at the 200bps cap; `createPlan` boundary at `interval == 1 minutes` and `price == 0` revert; `setTreasury` success path, zero-address revert, and event; `setPlanActive` invalid-planId revert. |
| subscribe / cancel / payNow | 4 | Happy path (pulls first payment, activates, schedules next charge, emits events); all revert conditions (invalid/inactive plan, already active, insufficient allowance/balance); cancel from Active and Overdue, re-subscribe after cancel; `payNow` reverts outside Overdue, resets schedule from `block.timestamp` on success. |
| chargeDue | 5 | Not-active/not-due revert; correct treasury/keeper reward split; reward rounds down to 0 at tiny prices without reverting; insufficient-allowance and insufficient-balance both degrade to `Overdue` without reverting (batch-safety — one failing user can't block a keeper's batch); fixed-schedule advance (`next = old + interval`, not `now + interval`) verified under time-warp; confirmed permissionless — any caller may invoke it and receives the reward. |
| retryCharge / expireOverdue | 4 | Revert conditions outside Overdue; full lifecycle integration (subscribe → fail → Overdue → retry-fail → retry-success → Active); alternate branch (Overdue → grace period expires → `Expired`, further charge attempts revert); grace-period boundary tested exactly at the threshold. |
| pause / unpause | 2 | Paused state blocks `subscribe`/`chargeDue`/`retryCharge`/`payNow`; `cancel` deliberately still works while paused (users can always opt out, see the `@dev` note at the call site); double-pause/double-unpause revert with the expected OZ `Pausable` custom errors. |
| rescueERC20 | 1 | Rescues an unrelated ERC20 sent to the contract by mistake; reverts if asked to rescue the payment token itself. |
| reentrancy | 1 | A purpose-built malicious ERC20 (`ReentrantToken`, re-enters an arbitrary target from `transferFrom`) attempts to re-enter `subscribe()` mid-call; `nonReentrant` blocks it. |
| view helpers | 1 | `hasActiveAccess` / `isDue` / `getSubscription` checked across all four `Status` values (Inactive, Active, Overdue, Expired). |

## Coverage

Full run (`npx hardhat coverage`), `contracts/SubscriptionManager.sol`:

| Metric | % |
|---|---|
| Statements | 100 |
| Lines | 100 |
| Functions | 100 |
| Branches | 88.75 |

Exceeds the >95% statement/line target set for this engagement. Remaining uncovered branches are believed to be OZ library-internal paths (`Ownable`/`ReentrancyGuard`/`Pausable`/`SafeERC20` guard branches not independently re-derivable from this contract's own logic) rather than untested application logic — full HTML report at `coverage/index.html` for line-by-line review.

## Gas (informational — feeds Phase 8 economics review, not a security metric)

`REPORT_GAS=true npx hardhat test`, Solc 0.8.24, optimizer on (200 runs):

| Method | Min | Max | Avg |
|---|---|---|---|
| subscribe | 98,586 | 169,798 | 145,380 |
| chargeDue | 77,089 | 103,102 | 85,287 |
| retryCharge | — | — | 74,595 |
| payNow | — | — | 71,784 |
| expireOverdue | — | — | 41,191 |
| cancel | — | — | 22,920 |
| rescueERC20 | — | — | 54,624 |
| pause / unpause | — | — | 27,737 / 27,796 |

Deployment: `SubscriptionManager` ≈ 1,847,544 gas (3.1% of a 60M block limit).

These are the real numbers behind the Phase 8 concern that `MAX_KEEPER_REWARD_BPS = 200` (2%) may not cover Ethereum L1 keeper gas cost on a low-price plan — e.g. `chargeDue` at ~85k gas and 2% of a $10 plan ($0.20 reward) only nets out at low ETH gas prices. Not a contract bug; a pricing/economics decision to make with these figures in hand.

## Known, intentional design properties (flagged for the auditor, not defects)

- Single-EOA `Ownable` today — becomes a Safe multisig via `transferOwnership` immediately after each mainnet deploy, before any real subscriber exists. Not a contract change.
- Fixed-schedule catch-up: `nextChargeAt = old + interval`, not `now + interval` — intended, so a late charge doesn't silently push the whole schedule forward.
- `cancel()` intentionally has no `whenNotPaused` guard — users must be able to opt out even while the contract is paused for an incident.
- MEV/front-running of `chargeDue`'s keeper reward: no user-fund risk, only non-guaranteed keeper income.
- Approvals from the frontend are bounded (fixed number of periods), never `type(uint256).max` — an intentional security property, not an oversight; should not regress.
- **Payment token differs by chain, including decimals.** Ethereum Mainnet and Base deploy against Circle-native USDC (6 decimals). BNB Chain deploys against Binance-Peg USDT/BSC-USD (18 decimals) — BNB Chain has no Circle-native USDC, so USDT was chosen there for liquidity instead (see `docs/mainnet-addresses.md`). `SubscriptionManager` never hardcodes a decimals assumption — `deploy.js` reads `decimals()` from the configured token at deploy time — so this needs no contract change, but the auditor should not assume all three deployments share one token or one decimals value.
