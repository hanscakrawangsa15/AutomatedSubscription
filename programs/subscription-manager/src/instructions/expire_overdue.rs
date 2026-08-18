use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::SubscriptionError,
    state::{Config, Plan, Subscription, SubStatus},
};

// Permissionless. No config.paused gate — matches SubscriptionManager.sol's
// expireOverdue, which has no whenNotPaused modifier either (moving an
// already-broken subscription to Expired isn't something an incident
// pause needs to block).
#[derive(Accounts)]
pub struct ExpireOverdue<'info> {
    pub config: Account<'info, Config>,
    /// CHECK: only used for pubkey-based PDA derivation below.
    pub user: UncheckedAccount<'info>,
    #[account(
        has_one = config @ SubscriptionError::InvalidPlan,
        seeds = [PLAN_SEED, config.key().as_ref(), subscription.plan_id.to_le_bytes().as_ref()],
        bump = plan.bump,
    )]
    pub plan: Account<'info, Plan>,
    #[account(
        mut,
        has_one = config @ SubscriptionError::InvalidPlan,
        seeds = [SUBSCRIPTION_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = subscription.bump,
    )]
    pub subscription: Account<'info, Subscription>,
}

pub fn handle_expire_overdue(ctx: Context<ExpireOverdue>) -> Result<()> {
    require!(ctx.accounts.subscription.status == SubStatus::Overdue, SubscriptionError::NotOverdue);

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= ctx.accounts.subscription.overdue_since + ctx.accounts.plan.grace_period,
        SubscriptionError::GracePeriodNotPassed
    );

    ctx.accounts.subscription.status = SubStatus::Expired;
    Ok(())
}
