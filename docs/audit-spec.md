# Audit Spec — SubscriptionManager

Prepared for third-party security audit engagement, per the mainnet
launch-readiness plan's Phase 2. Hand this + `TESTING.md` directly to the
audit firm.

## Scope

**In scope:** `contracts/SubscriptionManager.sol` only.

**Out of scope:** `contracts/mocks/MockUSDC.sol`, `contracts/mocks/ReentrantToken.sol`
(test fixtures, never deployed to production), `contracts/Migrations.sol`
(TronBox tooling bookkeeping, not application logic). Same bytecode deploys
to Base, Ethereum Mainnet, BNB Chain, and (pending its own deploy) TRON —
one engagement covers all deployments.

## What this contract does

A pull-payment recurring subscription system. The core design goal: **the
subscriber signs only once.** After an initial `approve()` + `subscribe()`,
all future renewal charges are pulled by a permissionless off-chain "keeper"
process (a bot/cron/Chainlink Automation/Gelato job) calling the contract —
no further wallet signature is ever required from the subscriber for
renewals to keep working.

### Actors

- **Subscriber**: any EOA. Calls `subscribe`, `cancel`, `payNow`.
- **Keeper**: anyone, permissionless. Calls `chargeDue`, `retryCharge`,
  `expireOverdue`. No special privilege — these are callable by any address,
  by design, so no single operator's downtime can stop renewals. An
  optional small reward (`keeperRewardBps`, capped at 2%) incentivizes
  third parties to run keepers, but the reference implementation runs its
  own (`scripts/keeper.js` / `scripts/keeper.tron.js`).
- **Owner**: a single EOA today; **must be transferred to a Safe multisig
  immediately after each mainnet deploy**, before any real subscriber is
  invited in (see "Trust assumptions" below). Controls `createPlan`,
  `setPlanActive`, `setTreasury`, `setKeeperRewardBps`, `pause`/`unpause`,
  `rescueERC20`.

### State machine

```
Inactive --subscribe()--> Active
Active --chargeDue() success--> Active (nextChargeAt advances)
Active --chargeDue() insufficient balance/allowance--> Overdue
Overdue --retryCharge() success--> Active
Overdue --payNow() (subscriber-initiated)--> Active
Overdue --expireOverdue() after gracePeriod--> Expired
Active/Overdue --cancel()--> Inactive
Inactive --subscribe() again--> Active (re-subscription allowed)
```

`Expired` is terminal — no function transitions out of it; the only way
back to `Active` is a fresh `subscribe()` call, i.e. a new subscription.

### Fixed-schedule billing (intentional, not a bug)

`chargeDue`'s successful path sets `nextChargeAt = nextChargeAt + interval`
— computed from the **previous scheduled time**, not `block.timestamp +
interval`. This is deliberate: if a keeper is late (network congestion,
downtime), the subscriber's next charge doesn't silently drift later —
the schedule stays anchored to the original cadence. Confirm this is the
intended production behavior, not something to flag as a bug.

The two **recovery** paths (`payNow`, `retryCharge`) reset from
`block.timestamp + interval` instead, deliberately — a subscriber recovering
from a lapsed/overdue state starts their next cycle from when they actually
paid, not from a stale pre-lapse schedule.

## Trust assumptions

- **`owner` is a single EOA at initial deploy, moved to a Safe multisig
  (2-of-3 or 3-of-5) immediately post-deploy** — flag if the mainnet
  deployment you're reviewing hasn't completed this transfer yet.
  `setTreasury` specifically (redirects all future revenue with no delay)
  is planned to sit behind a `TimelockController` in front of the Safe —
  confirm this is in place for the deployment under review, or flag its
  absence.
- **`treasury` should be a Safe multisig too**, never a plaintext-key EOA
  receiving real revenue.
- **`paymentToken` is `immutable`**, fixed at construction — cannot be
  swapped post-deploy, reducing rug-pull surface. Verify the deployed
  address on each chain is the real, canonical token (see
  `docs/mainnet-addresses.md`) — this is an off-chain verification step,
  not something the contract itself can enforce.
- **Keepers hold no privilege.** `chargeDue`/`retryCharge`/`expireOverdue`
  are permissionless by design — a leaked/compromised keeper key's blast
  radius is limited to "attacker drains its own gas balance" or "spams
  redundant calls" (idempotent/no-op against already-settled state), never
  subscriber funds.
- **MEV/front-running of the keeper reward**: a competing keeper could in
  principle front-run a `chargeDue`/`retryCharge` call to claim
  `keeperReward` first. No subscriber-fund risk — this only affects which
  keeper collects the (capped, small) incentive.

## Known, intentional design properties (not defects — please confirm agreement rather than re-flagging)

- **Check-Effects-Interactions ordering**: `subscribe`, `payNow`,
  `chargeDue`, and `retryCharge` all call `safeTransferFrom` *before*
  writing the corresponding `Subscription` state update. This isn't
  textbook CEI order — it's mitigated by `nonReentrant` on all four
  functions (a full mutex per call), verified by a dedicated reentrancy
  test using a malicious ERC20 that attempts to re-enter mid-`transferFrom`
  (see `TESTING.md`). Flagging this upfront since CEI-order is a common
  audit checklist item; the mitigation is the reentrancy guard, not
  incidental ordering.
- **`cancel()` deliberately has no `whenNotPaused` guard** — a subscriber
  must always be able to opt out, even while the contract is paused for an
  incident. Every other state-changing subscriber/keeper function does
  have the guard.
- **`chargeDue` degrades to `Overdue` instead of reverting** on
  insufficient balance/allowance — intentional batch-safety: a keeper
  iterating many subscribers in separate transactions shouldn't have its
  whole operation logic depend on any single user's transient failure.
- **Timestamp-dependence** (`block.timestamp` used throughout for
  due-dates/grace-periods): expected and accepted for a billing contract
  at day/minute-level granularity — a miner/validator's ~seconds of
  timestamp manipulation range is immaterial here. Static analysis (SWC-116)
  will flag this; it's reviewed and accepted, not a gap.
- **`MAX_KEEPER_REWARD_BPS = 200` (2% cap)**: an economics/business
  parameter, not a security bound — see the mainnet plan's Phase 8 for gas
  cost analysis (particularly on Ethereum L1, where 2% of a low-price plan
  may not fully cover keeper gas cost). Not something to fix in the
  contract; `keeperRewardBps` is owner-adjustable at runtime without
  redeploy.
- **Payment token differs by chain, including decimals** — Ethereum/Base
  use USDC (6 decimals), BNB Chain uses USDT (18 decimals), see
  `docs/mainnet-addresses.md`. The contract never hardcodes a decimals
  assumption (`plan.price` is just a raw token-unit `uint256`); this is
  handled entirely off-chain in `deploy.js`/the frontend. No contract
  change needed, but don't assume all three deployments share one decimals
  value.
- **No on-chain refund logic** in `cancel()` — a subscriber who cancels
  mid-period gets no partial refund of the current period. This is a
  product/legal decision (see the mainnet plan's Phase 9 — refund/dispute
  policy is a ToS matter), not a contract gap to fix.

## Automated analysis already run (pre-audit, per plan Phase 2.5)

- **Slither** (Trail of Bits, v0.11.6): no findings specific to
  `SubscriptionManager.sol`'s own logic beyond the intentional
  `arbitrary-from-in-transferFrom` pattern (the pull-payment mechanism
  itself — `chargeDue`/`retryCharge` pull from `user`, not `msg.sender`, by
  design) and expected timestamp/strict-equality low-severity notes
  already covered above. One cosmetic naming-convention nit
  (`setTreasury`'s `_treasury` param) — no security impact, left as-is.
- **Mythril** (v0.24.8, symbolic execution, 240s budget per function path):
  no issues detected. Note this is a bounded exploration, not an
  exhaustive proof — flagged honestly, not claimed as a guarantee.
- Full raw output available on request; not attached here to keep this doc
  short.

## What we'd like from the audit

1. Confirmation (or challenge) of the "known, intentional" list above —
   especially the CEI-ordering-via-mutex pattern and the fixed-schedule
   billing behavior.
2. Standard coverage: access control correctness, reentrancy, integer
   arithmetic (Solidity 0.8.x has built-in overflow/underflow checks —
   confirm no gaps), permissionless-function abuse surface
   (`chargeDue`/`retryCharge`/`expireOverdue` callable by anyone — any
   griefing vector beyond the accepted MEV note above?).
3. Anything specific to TVM (TRON Virtual Machine) if reviewing the TRON
   deployment — same Solidity source, but a different `solc` fork compiles
   it (see `tron/README.md`); flag if any EVM-vs-TVM semantic gap is found.

## Deliverable this doc pairs with

`TESTING.md` — 29 tests, 100% statement/line/function coverage,
88.75% branch coverage on `SubscriptionManager.sol`, plus real gas figures
per function.
