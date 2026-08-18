pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("ZANo1AAyHkJQN5ghsg8Ft7Ye6d1YWihEbdw1Ed33bip");

/// Solana/Anchor port of contracts/SubscriptionManager.sol — same
/// pull-payment model (approve once, permissionless keeper charges every
/// period without the user re-signing), replicated via SPL Token's
/// delegate-authority mechanism instead of ERC20 allowance. See
/// docs/mainnet-addresses.md and the Solana integration plan for the full
/// design rationale (why a PDA can safely act as the delegate, why
/// charge_due must pre-check before transferring, etc).
#[program]
pub mod subscription_manager {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, keeper_reward_bps: u16) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, keeper_reward_bps)
    }

    pub fn create_plan(ctx: Context<CreatePlan>, price: u64, interval: i64, grace_period: i64) -> Result<u64> {
        instructions::create_plan::handle_create_plan(ctx, price, interval, grace_period)
    }

    pub fn set_plan_active(ctx: Context<SetPlanActive>, active: bool) -> Result<()> {
        instructions::set_plan_active::handle_set_plan_active(ctx, active)
    }

    pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
        instructions::set_treasury::handle_set_treasury(ctx)
    }

    pub fn set_keeper_reward_bps(ctx: Context<SetKeeperRewardBps>, bps: u16) -> Result<()> {
        instructions::set_keeper_reward_bps::handle_set_keeper_reward_bps(ctx, bps)
    }

    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::set_paused::handle_pause(ctx)
    }

    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::set_paused::handle_unpause(ctx)
    }

    pub fn subscribe(ctx: Context<Subscribe>) -> Result<()> {
        instructions::subscribe::handle_subscribe(ctx)
    }

    pub fn charge_due(ctx: Context<ChargeDue>) -> Result<()> {
        instructions::charge_due::handle_charge_due(ctx)
    }

    pub fn retry_charge(ctx: Context<RetryCharge>) -> Result<()> {
        instructions::retry_charge::handle_retry_charge(ctx)
    }

    pub fn expire_overdue(ctx: Context<ExpireOverdue>) -> Result<()> {
        instructions::expire_overdue::handle_expire_overdue(ctx)
    }

    pub fn pay_now(ctx: Context<PayNow>) -> Result<()> {
        instructions::pay_now::handle_pay_now(ctx)
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::cancel::handle_cancel(ctx)
    }

    pub fn rescue_token(ctx: Context<RescueToken>, amount: u64) -> Result<()> {
        instructions::rescue_token::handle_rescue_token(ctx, amount)
    }
}
