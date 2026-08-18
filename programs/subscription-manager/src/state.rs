use anchor_lang::prelude::*;

// Mirrors SubscriptionManager.sol's Status enum exactly (order matters —
// serialized as a u8 discriminant).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum SubStatus {
    Inactive,
    Active,
    Overdue,
    Expired,
}

// One Config per (program, payment_mint) pair — a second payment token is a
// second Config, not a second program deployment (see the plan doc: this is
// cheaper on Solana than EVM's "second token = second contract instance").
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub payment_mint: Pubkey,
    pub treasury_token_account: Pubkey,
    pub keeper_reward_bps: u16,
    pub paused: bool,
    pub plan_count: u64,
    pub bump: u8,
}

// Mirrors SubscriptionManager.sol's Plan struct. price/interval/gracePeriod
// keep the Solidity names' meaning: price in payment_mint's smallest unit,
// interval/grace_period in seconds.
#[account]
#[derive(InitSpace)]
pub struct Plan {
    pub config: Pubkey,
    pub plan_id: u64,
    pub price: u64,
    pub interval: i64,
    pub grace_period: i64,
    pub active: bool,
    pub bump: u8,
}

// Mirrors SubscriptionManager.sol's `mapping(address => Subscription)` —
// seeded by (config, user) only, NOT plan_id, so there's exactly one
// subscription per user per Config, matching the Solidity guarantee that a
// user can't hold two simultaneous subscriptions on the same manager.
//
// Deliberately never closed on cancel/expire (see the plan doc's Phase 1
// design note) — keeps periods_paid history forever, at the cost of a small
// one-time rent deposit, matching Solidity's storage-never-expires behavior.
#[account]
#[derive(InitSpace)]
pub struct Subscription {
    pub user: Pubkey,
    pub config: Pubkey,
    pub plan_id: u64,
    pub status: SubStatus,
    pub next_charge_at: i64,
    pub overdue_since: i64,
    pub periods_paid: u64,
    pub bump: u8,
}
