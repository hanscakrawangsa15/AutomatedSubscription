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
- Address: `0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48`
- Decimals: 6
- Explorer: https://etherscan.io/address/0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48
- Found: 2026-08-07, cross-referenced via Etherscan listing + Circle docs references in search results
- Verified by: _(pending — human must confirm on Etherscan before deploy)_

## Base (chainId 8453)

- Token: USDC (Circle-native)
- Address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Decimals: 6
- Explorer: https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- Found: 2026-08-07, cross-referenced via BaseScan listing
- Verified by: _(pending — human must confirm on BaseScan before deploy)_

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

## TRON Mainnet

**Not an EVM chain — no numeric chainId, no `SubscriptionManager` deployment yet.**
This entry is plumbing-only (frontend can point at the real USDT contract once
`SubscriptionManager` is actually deployed to TRON Mainnet — see
`VITE_TRON_MAINNET_MANAGER_ADDRESS` in `frontend/.env.example`, intentionally
left blank). That deployment needs a security audit specific to the TVM build
first, same bar as the other mainnet chains — see `tron/README.md` and the
mainnet-readiness plan.

- Token: Tether USD (USDT), TRC20 — the canonical/dominant USDT contract on
  TRON, used by essentially every wallet and exchange.
- Address: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
- Decimals: 6
- Explorer: https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
- Found: 2026-08-12, cross-referenced via web search (Bitget, Datawallet,
  Tether's own supported-protocols page, Bitquery) — **and live-verified**
  via a direct on-chain `name()`/`symbol()`/`decimals()` read against
  `api.trongrid.io`, returning `{ name: "Tether USD", symbol: "USDT",
  decimals: 6 }`, matching expectations exactly.
- Verified by: Claude (live on-chain read, 2026-08-12) — a human should still
  glance at the Tronscan link above before this is ever used in a real
  mainnet deploy, per this project's standing rule.

## Next steps before these go into `.env`

1. Open each explorer link above in a browser, confirm verified-source,
   symbol/name, and decimals match.
2. Fill in "Verified by" (name + date) once confirmed.
3. Copy into `.env` as `USDC_ADDRESS_1`, `USDC_ADDRESS_8453`,
   `USDC_ADDRESS_56` per `scripts/deploy.js`'s production path — never paste
   directly into a deploy transaction by hand.
4. Do one small real-money test `approve` + `subscribe` before advertising
   any chain live (plan Phase 3, step 5).
