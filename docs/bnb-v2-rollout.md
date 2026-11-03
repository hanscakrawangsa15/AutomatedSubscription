# Rollout plan — SubscriptionManager v2 on BNB Chain

**Status: NOTHING HAS BEEN DEPLOYED.** This is a runbook; every step marked
🛑 needs explicit approval before it is run. Prepared 2026-11-03.

## What changes for users

Billing rule (monthly and yearly alike), for a subscription bought on day 0:

| | Monthly | Yearly |
|---|---|---|
| Period | 30 days | 365 days |
| Attempt 1 (charged immediately if balance + allowance cover the price) | day 28 | day 363 |
| Attempt 2 (only if attempt 1 found too little balance) | day 29 | day 364 |
| Attempt 3 / last | day 30 (= period end) | day 365 |
| All 3 failed | subscription cancelled (Expired) | same |

Example: bought 25 Sep 2026 → 23, 24, 25 Oct 2026 (monthly) / 23, 24, 25 Sep 2027 (yearly).
The user stays `Active` during attempts 1–2; the contract itself refuses to move
anyone to `Overdue` before the period end (a third party cannot grief them).

Existing v1 subscribers are **not** migrated and keep their current price/schedule.

## Facts verified read-only (2026-11-02)

- BNB Chain v1 USDT manager: `0x34f02a2cf53aD696AE9F8541AE51e37b1cBCF468`, owner = treasury = Safe `0xccD26Af8599109a582179F7099fa6980a2c9A5F5` (1-of-3, deployer key `0xE612…8C1A` is an owner).
- Token: Binance-Peg USDT `0x55d398326f99059fF775485246999027B3197955`, 18 decimals.
- Deployer BNB balance 0.0154; the deploy tx needs ≈ 0.00012 BNB at the current 0.05 gwei.
- `npx hardhat test`: 36 passing. Local end-to-end keeper test against the v2 contract passed (attempts day 28 / 29 / 30, top-up between attempts, cancel after the 3rd failure).

## Before anything else

1. **Remove `CONFIRM_MAINNET_DEPLOY` from `.env`.** It is currently set there, which
   makes `deploy.js`'s "are you sure" guard always pass: running the deploy
   command *without* `DRY_RUN=1` deploys immediately. Pass it inline per run instead.
2. **Audit decision.** v2 is a small diff (see `docs/audit-spec.md`, "v2 change") but it is
   unaudited code handling real funds. At minimum re-run Slither/Mythril and have the
   auditor review that diff before step 3.
3. Add to `.env` (repo root): `USDC_ADDRESS_56_V2=0x55d398326f99059fF775485246999027B3197955`

## Steps

### 0. Dry run (safe, sends nothing)
```bash
DRY_RUN=1 DEPLOY_TOKEN_SUFFIX=_V2 \
TREASURY_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 \
TRANSFER_OWNERSHIP_TO=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 \
npx hardhat run scripts/deploy.js --network bsc
```
Check: token = USDT, decimals 18, treasury and new owner = the Safe.

### 1. 🛑 Deploy the manager
```bash
CONFIRM_MAINNET_DEPLOY=yes-i-am-sure DEPLOY_TOKEN_SUFFIX=_V2 \
TREASURY_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 \
TRANSFER_OWNERSHIP_TO=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 \
npx hardhat run scripts/deploy.js --network bsc
```
It deploys, transfers ownership to the Safe (after checking it really is a Safe)
and prints the `.env` lines. Save the manager address and deploy block.
Production + suffix skips the placeholder plans on purpose.

### 2. Verify the source on BscScan
`npx hardhat verify --network bsc <manager> 0x55d398326f99059fF775485246999027B3197955 0xccD26Af8599109a582179F7099fa6980a2c9A5F5`

### 3. Read-back checks (read-only)
`owner()` = Safe, `treasury()` = Safe, `paymentToken()` = USDT, `paused()` = false, `planCount()` = 0.

### 4. 🛑 Create the 5 plans (through the Safe)
Dry run first, then the real one (new manager address in `MANAGER_ADDRESS`):
```bash
DRY_RUN=1 SAFE_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 MANAGER_ADDRESS=<v2> \
  npx hardhat run scripts/create-plans-safe.js --network bsc
# then, without DRY_RUN=1:
SAFE_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 MANAGER_ADDRESS=<v2> \
  npx hardhat run scripts/create-plans-safe.js --network bsc
```
Expected read-back — ids 0–4 (matches the frontend's fixed id order), each with
`lead 2d`, `0d grace`: Starter $15, Basic $39, Basic yearly $374.40, Advance $79,
Advance yearly $758.40. The script refuses to run against a v1 manager.
**Run it once only** — it always appends.

### 4b. 🛑 Create the Tokocrypto partner-discount plans (through the Safe)
Only after step 4 (each discounted plan points at its normal plan). Dry run first:
```bash
DRY_RUN=1 SAFE_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 MANAGER_ADDRESS=<v2> \
  npx hardhat run scripts/create-tokocrypto-plans-safe.js --network bsc
# then, without DRY_RUN=1:
SAFE_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 MANAGER_ADDRESS=<v2> \
  npx hardhat run scripts/create-tokocrypto-plans-safe.js --network bsc
```
One Safe transaction: 5 `createPlan` + 5 `setPromo`. Expected read-back (ids 5–9):
Starter $13.50 / Basic $35.10 / Advance $71.10 monthly (12 discounted payments,
then plans #0 / #1 / #3 at $15 / $39 / $79) and Basic $327.60 / Advance $663.60
yearly (1 discounted payment, then plans #2 / #4 at $374.40 / $758.40). The script
finds each successor on-chain and refuses if it is missing/ambiguous or the promo
plan already exists. **Run it once only.** `setPromo` is set-once per plan.

Later, to switch the partner offer off/on without a redeploy:
`setPlanActive(<promo plan id>, false|true)` through the Safe (new sign-ups only;
existing subscribers keep their discount schedule). A different discount = new
`createPlan` + `setPromo` and an entry in `CAMPAIGNS` (`frontend/src/lib/pricingTiers.ts`).

### 5. Config (no deploy yet)
- Repo `.env`: `SUBSCRIPTION_MANAGER_ADDRESS_56_V2`, `SUBSCRIPTION_MANAGER_DEPLOY_BLOCK_56_V2` (and `USDC_ADDRESS_56_V2` from above). The notify server's tx verification picks the manager up from the same variable.
- `frontend/.env`: `VITE_USDC_ADDRESS_56_V2`, `VITE_SUBSCRIPTION_MANAGER_ADDRESS_56_V2`.

### 6. Keepers
- Restart the existing `npm run keeper:bsc` (v1) so it runs the new retry policy; v1 subscribers keep being renewed.
- Start the new one: `npm run keeper:bsc-v2`.
- Server: restart so the new env is read.

### 7. 🛑 Frontend cutover
In `frontend/src/components/PaymentNetworkStep.tsx` change the BNB Chain entry's
`suffix` from `""` to `"_V2"`, then build and deploy. New BNB purchases then go to
v2; people with a v1 subscription still see it under Manage (the app looks across
all managers on the chain).

Partner pages: `cpay.xenorize.com/tokocrypto` must be served by the same SPA
(the static host needs the `index.html` fallback for this path, like `/admin`).
The main site must link referred users to the checkout with `?ref=tokocrypto`
(e.g. `https://cpay.xenorize.com/?ref=tokocrypto&email=…`): the page remembers it
and sends referred visitors to `/tokocrypto` and everyone else away from it. This
only separates what each visitor *sees* — see the voucher note under "Known gaps".

### 8. Smoke test with a real (small) subscription
Subscribe to Starter on BNB, confirm the DB row and the email, and read
`subscriptions(you)`: `nextChargeAt` must be `subscribe time + 28 days`. Cancel
afterwards if it was only a test.

### 9. Retire the v1 BNB plans — only after the smoke test passes
`PLAN_IDS=0,1,2,3,4,5 SAFE_ADDRESS=… MANAGER_ADDRESS=0x34f0…F468 npx hardhat run scripts/deactivate-plans-safe.js --network bsc`
(keep the Test plan #6). Existing v1 subscribers are unaffected.

## Rollback
v2 never touches v1. If something is wrong before step 9: Safe → `pause()` on v2,
set the frontend suffix back to `""`. After step 9 the v1 plans would have to be
re-activated through the Safe first.

## Known gaps to decide on
- **The partner discount is not access-controlled.** The `/tokocrypto` page is only shown to referred visitors, but the discounted plans are public on-chain: anyone who calls `subscribe(<promo id>)` directly gets the discount (once per wallet). If that matters, add a server-signed voucher checked by the contract (not built).
- **Yearly Tokocrypto prices are not 10% off the normal yearly price** ($327.60 vs $374.40 is 12.5% off; $663.60 vs $758.40 is 12.5%). They were applied exactly as given; the card ribbon says "10% OFF" on every plan (`CAMPAIGNS.tokocrypto.ribbon`) — change the prices or the wording if this is unintended.
- Promo usage is tracked per wallet **and per promo plan**: a wallet can use one promo on Starter and another on Basic. Cancelling and re-buying the same promo does not restart it.
- Allowance: the checkout approves 12 × the higher (normal) price so renewals after the switch don't fail; as for every plan, a user who exhausts the cap must re-approve.
- **Ethereum is still v1.** Until it gets its own v2 manager, new Ethereum subscribers get the old rules (single charge at the period end, then retries after it, grace 5/10 days on plans #6–#10). Do the same runbook for Ethereum right after BNB, or hide the Ethereum option meanwhile.
- v1 subscribers (both chains) follow the new keeper retry policy but their plans have a 5/10-day grace period, so after the 3rd failed attempt they sit `Overdue` (access still on) until grace ends and are then cancelled — not immediately.
- The lead-time behaviour is covered by unit tests and a local end-to-end run, not by a mainnet test (it would need a real 28-day wait or a purpose-made short-interval plan).
