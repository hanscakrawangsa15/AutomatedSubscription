# v2 pre-deploy security check (internal)

Scope: `contracts/SubscriptionManager.sol` v2 — renewal lead time (`Plan.leadTime`)
and partner promo pricing (`setPromo`, `promos`, `promoPaid`, `planSold`,
`nextCharge`). Change description: `docs/audit-spec.md` ("v2 change" sections).

**This is an automated + self-review result, NOT an independent human audit.**
The contract moves real funds through `transferFrom`; a human review of the v2
diff is still recommended before mainnet.

| Check | Result |
|---|---|
| Unit tests (`npx hardhat test`) | 48 passing |
| Coverage (`npx hardhat coverage`) | `SubscriptionManager.sol`: 100% statements / functions / lines, 91.8% branches. Uncovered branches are only the short-circuit arms of `require(a \|\| b)` / `require(a && b)` — no promo logic is unexercised. |
| Slither | 4 detector types, all informational / by design: `arbitrary-send-erc20` (pull payment from `user` to treasury is the product), `timestamp` and `incorrect-equality` (status/time comparisons), `naming-convention` (`_treasury`). No High / Medium. |
| Mythril (runtime bytecode, depth 26, 3 tx, 420 s) | No issues detected. Bounded symbolic execution — absence of findings is not a proof. |
| Local keeper end-to-end (hardhat node) | Retries on day 28/29/30, cancels after the 3rd failure, funds check uses the price of the NEXT charge (normal price once a promo is spent), promo plan switches to normal plan. |
| Manual review of the diff | One issue found and fixed before deploy (below). |

## Finding fixed during review

**`setPromo` on a plan that already had subscribers.** Existing subscribers would
have been treated as promo subscribers (full discount quota) and then moved to the
dearer successor plan — a silent price rise on people who never agreed to a promo.
Fix: `planSold[planId]` is set on the first `subscribe()`, and `setPromo` reverts
`plan already sold`. Test: "a plan that already has subscribers can never become a promo".

## Known / accepted properties (not bugs)

- **Promo plans are public.** Anyone can call `subscribe(<promo id>)` directly (once per wallet). Restricting to referred users needs a signed voucher; not built.
- **Quota is per wallet and per promo plan.** A wallet may use one promo on each distinct promo plan. Cancelling and re-buying the same promo plan does not restart it.
- **`nextCharge(user)` for a never-subscribed address** returns plan 0's data (default `planId`); it is a view helper for active subscribers.
- **Allowance:** a wallet that exhausts its approved cap must re-approve (unchanged from v1). The checkout approves 12 × the higher (normal) price.
- Owner powers (`pause`, `setTreasury`, `setPlanActive`, `setPromo` once per plan, `createPlan`) are unchanged in kind; the owner is the Safe.

## Not covered

- Independent human audit.
- Formal verification / fuzzing beyond the unit tests (no Echidna/Foundry invariant run).
- Mainnet behaviour of the real BSC-USD token beyond the existing v1 deployment's experience (18 decimals, standard `transferFrom`).
