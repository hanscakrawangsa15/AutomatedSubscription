# Mainnet payment token addresses

Per the mainnet launch-readiness plan, Phase 3: never hardcode a payment
token address from memory — verify fresh, per chain, before it ever reaches
a deploy command. This file is that audit trail.

**Status: NOT YET RE-VERIFIED BY A HUMAN ON THE OFFICIAL EXPLORERS.**
The addresses below were found via web search and cross-referenced across
multiple independent sources (BaseScan/Etherscan/BscScan listing pages,
CoinGecko), but this session's sandboxed environment had broken outbound
HTTPS (expired-certificate errors on every direct RPC/fetch attempt,
apparently tied to the sandbox clock), so a live on-chain read (`symbol()`,
`decimals()`, verified-source check) could not be independently confirmed
by me. **Before wiring any of these into a real deploy, open each address
below directly on its official explorer, confirm the verified-source badge,
symbol, name, and decimals match this table, and update the "Verified by"
row.**

## Ethereum Mainnet (chainId 1)

- Token: USDC (Circle-native)
- Address: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
  ("...1D19D..." was a checksum-casing typo from the original transcription
  — ethers.js's checksum validation caught it before any transaction was
  sent when it was used in a real deploy attempt. Corrected here on
  2026-08-12 and **live-verified** via a direct `name()`/`symbol()`/
  `decimals()`/`totalSupply()` read against Ethereum Mainnet: `{ name:
  "USD Coin", symbol: "USDC", decimals: 6, totalSupply: ~49.7B USDC }` —
  matches expectations exactly.)
- Decimals: 6
- Explorer: https://etherscan.io/address/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
- Found: 2026-08-07, cross-referenced via Etherscan listing + Circle docs references in search results
- Verified by: Claude (live on-chain read, 2026-08-12) — a human should still
  glance at the Etherscan link above before this is used in any further
  deploys.

## Base (chainId 8453)

- Token: USDC (Circle-native)
- Address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Decimals: 6
- Explorer: https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- Found: 2026-08-07, cross-referenced via BaseScan listing
- Verified by: _(pending — human must confirm on BaseScan before deploy)_

## Ethereum Mainnet — USDT (secondary payment method)

**This is a second `SubscriptionManager` instance on chainId 1, not a new
chain.** `paymentToken` is immutable, so a second payment token on an
already-listed chain means a second deployment (env var suffix `_USDT`,
e.g. `USDC_ADDRESS_1_USDT` / `SUBSCRIPTION_MANAGER_ADDRESS_1_USDT`) — see
the pilot plan for the multi-token infrastructure this depends on.

- Token: Tether USD (USDT), the canonical Ethereum-mainnet contract
- Address: `0xdAC17F958D2ee523a2206206994597C13D831ec7`
- Decimals: 6
- Explorer: https://etherscan.io/address/0xdAC17F958D2ee523a2206206994597C13D831ec7
- Found: 2026-08-17, well-known canonical address — **live-verified** via a
  direct `name()`/`symbol()`/`decimals()`/`totalSupply()` read against
  Ethereum Mainnet: `{ name: "Tether USD", symbol: "USDT", decimals: 6,
  totalSupply: ~90.3B USDT }` — matches expectations exactly.
- Verified by: Claude (live on-chain read, 2026-08-17) — a human should
  still glance at the Etherscan link above before this is used in any
  deploy.
- Note: real USDT's `approve()` reverts if changing a nonzero allowance
  directly to another nonzero value (must reset to 0 first) — handled
  generically in `ConfirmSubscription.tsx`, and deliberately replicated in
  `contracts/mocks/MockUSDT.sol` so the testnet pilot actually exercises
  that path before it meets the real contract.

## Ethereum Mainnet — WETH (secondary payment method)

**Second `SubscriptionManager` instance on chainId 1** (env var suffix
`_WETH`). Unlike USDC/USDT, WETH is not pegged to USD — plan prices are a
**fixed WETH amount set at creation time** (via
`REFERENCE_TOKEN_PRICE_USD` passed to `scripts/create-plans-safe.js`), not
a live oracle conversion. This drifts from the tier's true $ value as
ETH's price moves and needs a periodic manual re-price (new plans +
deactivate old) — a deliberate tradeoff to avoid a much larger contract
change (see the wrapped-token planning discussion), not an oversight.

- Token: Wrapped Ether (WETH)
- Address: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
- Decimals: 18
- Explorer: https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
- Found: 2026-08-18, well-known canonical address — **live-verified** via a
  direct `name()`/`symbol()`/`decimals()`/`totalSupply()` read: `{ name:
  "Wrapped Ether", symbol: "WETH", decimals: 18, totalSupply: ~2.23M WETH }`
  — matches expectations exactly.
- Verified by: Claude (live on-chain read, 2026-08-18) — a human should
  still glance at the Etherscan link above before this is used in any
  further deploy.
- Plans created at ETH ≈ $1906.58 (CoinGecko, 2026-08-18) — cross-checked
  against CoinMarketCap same day (ETH $1906.12, ~0.02% difference,
  negligible). `CMC_API_KEY` is available in `.env` for cross-checking
  future re-prices.

## Base — WETH (secondary payment method)

Same pattern as Ethereum's WETH entry above (second `SubscriptionManager`
instance, suffix `_WETH`, fixed-amount pricing at creation time).

- Token: Wrapped Ether (WETH) — Base's canonical predeploy address
- Address: `0x4200000000000000000000000000000000000006`
- Decimals: 18
- Explorer: https://basescan.org/address/0x4200000000000000000000000000000000000006
- Found: 2026-08-18, well-known canonical address — **live-verified** via a
  direct `name()`/`symbol()`/`decimals()`/`totalSupply()` read: `{ name:
  "Wrapped Ether", symbol: "WETH", decimals: 18, totalSupply: ~263K WETH }`
  — matches expectations exactly.
- Verified by: Claude (live on-chain read, 2026-08-18).
- Plans created at ETH ≈ $1906.58 (CoinGecko, 2026-08-18).

## BNB Chain — WBNB (secondary payment method)

Same pattern again (second `SubscriptionManager` instance, suffix
`_WBNB`, fixed-amount pricing at creation time).

- Token: Wrapped BNB (WBNB)
- Address: `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`
- Decimals: 18
- Explorer: https://bscscan.com/address/0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
- Found: 2026-08-18, well-known canonical address — **live-verified** via a
  direct `name()`/`symbol()`/`decimals()`/`totalSupply()` read: `{ name:
  "Wrapped BNB", symbol: "WBNB", decimals: 18, totalSupply: ~1.78M WBNB }`
  — matches expectations exactly.
- Verified by: Claude (live on-chain read, 2026-08-18).
- Plans created at BNB ≈ $605.68 (CoinGecko, 2026-08-18).

## BNB Chain (chainId 56)

**Decision (2026-08-07): use USDT here, not USDC.** BNB Chain has no
Circle-native USDC — the "USDC" token there (`0x8AC76a51...`) is
Binance-Peg, backed by Binance-controlled reserves rather than Circle, an
explicitly different trust/custody model than the Ethereum/Base deployments.
After flagging this tradeoff, the call was made to use Binance-Peg USDT
instead, which is the dominant stablecoin on BSC by liquidity. **This means
the BNB Chain deployment's payment token is USDT, not USDC** — despite the
env var still being named `USDC_ADDRESS_56` / `VITE_USDC_ADDRESS_56` (kept
generic/per-chain rather than renamed, since `deploy.js`/`keeper.js`/
`contracts.ts` already treat it as "this chain's payment token," not
literally USDC-typed). State this explicitly in the audit spec doc so the
auditor doesn't assume all three chains use the same token.

- Token: Binance-Peg BSC-USD (USDT, BEP-20)
- Address: `0x55d398326f99059fF775485246999027B3197955`
- Decimals: 18 (not 6 — `SubscriptionManager` reads `decimals()` dynamically
  at deploy time via `deploy.js`, so this requires no contract change, but
  double-check any UI/off-chain code that assumes 6 decimals)
- Explorer: https://bscscan.com/token/0x55d398326f99059fF775485246999027B3197955
- Found: 2026-08-07, cross-referenced via BscScan listing + CoinGecko
- Verified by: _(pending — human must confirm on BscScan before deploy)_

## Next steps before these go into `.env`

1. Open each explorer link above in a browser, confirm verified-source,
   symbol/name, and decimals match.
2. Fill in "Verified by" (name + date) once confirmed.
3. Copy into `.env` as `USDC_ADDRESS_1`, `USDC_ADDRESS_8453`,
   `USDC_ADDRESS_56` per `scripts/deploy.js`'s production path — never paste
   directly into a deploy transaction by hand.
4. Do one small real-money test `approve` + `subscribe` before advertising
   any chain live (plan Phase 3, step 5).
