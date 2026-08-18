use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const PLAN_SEED: &[u8] = b"plan";
#[constant]
pub const SUBSCRIPTION_SEED: &[u8] = b"subscription";

// Mirrors SubscriptionManager.sol's MAX_KEEPER_REWARD_BPS (2% cap, safety limit).
pub const MAX_KEEPER_REWARD_BPS: u16 = 200;

// Mirrors the Solidity contract's "interval >= 1 minutes" floor (lowered
// from 1 days to allow a fast-interval plan for local/devnet testing).
pub const MIN_PLAN_INTERVAL_SECONDS: i64 = 60;
