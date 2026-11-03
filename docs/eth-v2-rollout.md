# Rollout plan — SubscriptionManager v2 on Ethereum

**Status: NOTHING HAS BEEN DEPLOYED.** Same rules as BNB (`docs/bnb-v2-rollout.md`):
lead time 2 days, attempts at day -2/-1/0, cancel after the 3rd failure, Tokocrypto
promo (12 monthly payments / 1 yearly payment, then normal price). Every step marked
🛑 needs explicit approval.

## Differences from BNB
- Token: USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`, **6 decimals** (scripts read decimals; prices are computed from cents).
- Env suffix for v2: **`_USDT_V2`** (v1 stays on `_USDT`). Keys: `USDC_ADDRESS_1_USDT_V2`, `SUBSCRIPTION_MANAGER_ADDRESS_1_USDT_V2`, `SUBSCRIPTION_MANAGER_DEPLOY_BLOCK_1_USDT_V2`.
- Network name for hardhat: `mainnet`. Keeper: `npm run keeper:mainnet-usdt-v2`.
- v1 Ethereum USDT manager: `0x8011F30979412C9BFE066824fB99284640B25e13` (plans #6–#10, grace 5/10 days). Untouched; its subscribers keep their price.
- **Gas is the constraint.** Deployer ETH balance was ~0.00148 at 0.19 gwei (checked 2026-11-03). Deploy + Safe batches should fit, but top up the deployer (`0xE612…8C1A`) with a little ETH before starting; a gas spike would stall step 4.

## Before anything else
1. Add to `.env`: `USDC_ADDRESS_1_USDT_V2=0xdAC17F958D2ee523a2206206994597C13D831ec7`
2. Confirm `CONFIRM_MAINNET_DEPLOY` is not in `.env` (it is not).

## Steps
### 0. Dry run (verified OK on 2026-11-03: token USDT, decimals 6, owner/treasury = Safe)
```bash
DRY_RUN=1 DEPLOY_TOKEN_SUFFIX=_USDT_V2 \
TREASURY_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 \
TRANSFER_OWNERSHIP_TO=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 \
npx hardhat run scripts/deploy.js --network mainnet
```
### 1. 🛑 Deploy
Same command with `CONFIRM_MAINNET_DEPLOY=yes-i-am-sure` and without `DRY_RUN`.
### 2. Verify source on Etherscan, then read back
`owner()` = Safe, `treasury()` = Safe, `paymentToken()` = USDT, `paused()` = false, `planCount()` = 0.
### 3. 🛑 Normal plans (Safe) — dry run first, run once
```bash
SAFE_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 MANAGER_ADDRESS=<eth v2> \
  npx hardhat run scripts/create-plans-safe.js --network mainnet
```
### 4. 🛑 Tokocrypto plans (Safe) — dry run first, run once
```bash
SAFE_ADDRESS=0xccD26Af8599109a582179F7099fa6980a2c9A5F5 MANAGER_ADDRESS=<eth v2> \
  npx hardhat run scripts/create-tokocrypto-plans-safe.js --network mainnet
```
### 5. Config
- Repo `.env`: `SUBSCRIPTION_MANAGER_ADDRESS_1_USDT_V2`, `SUBSCRIPTION_MANAGER_DEPLOY_BLOCK_1_USDT_V2`. The server's tx verification now accepts multi-part suffixes like `_USDT_V2` (fixed in `server/verifyTx.js`).
- `frontend/.env`: `VITE_USDC_ADDRESS_1_USDT_V2`, `VITE_SUBSCRIPTION_MANAGER_ADDRESS_1_USDT_V2`.
### 6. Keepers
Restart `npm run keeper:mainnet-usdt` (v1, new retry policy), start `npm run keeper:mainnet-usdt-v2`. Restart the server.
### 7. 🛑 Frontend cutover
`frontend/src/lib/chains.ts`: `PAYMENT_SUFFIX = { 1: "_USDT_V2", 56: "_V2" }`, then build/deploy.
### 8. Smoke test with a small real subscription
`nextChargeAt` must be subscribe time + 28 days (monthly).
### 9. Retire v1 Ethereum USDT plans
Only after the smoke test: `PLAN_IDS=6,7,8,9,10 SAFE_ADDRESS=… MANAGER_ADDRESS=0x8011…5e13 npx hardhat run scripts/deactivate-plans-safe.js --network mainnet`. Existing v1 subscribers are unaffected.

## Rollback
Safe → `pause()` on the v2 manager and set the frontend suffix back to `_USDT`.
