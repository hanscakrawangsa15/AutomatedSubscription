use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::SubscriptionError,
    state::{Config, Plan},
};

#[derive(Accounts)]
pub struct CreatePlan<'info> {
    #[account(mut, has_one = admin @ SubscriptionError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Plan::INIT_SPACE,
        seeds = [PLAN_SEED, config.key().as_ref(), config.plan_count.to_le_bytes().as_ref()],
        bump
    )]
    pub plan: Account<'info, Plan>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_plan(ctx: Context<CreatePlan>, price: u64, interval: i64, grace_period: i64) -> Result<u64> {
    require!(price > 0, SubscriptionError::ZeroPrice);
    require!(interval >= MIN_PLAN_INTERVAL_SECONDS, SubscriptionError::IntervalTooShort);

    let plan_id = ctx.accounts.config.plan_count;
    let plan = &mut ctx.accounts.plan;
    plan.config = ctx.accounts.config.key();
    plan.plan_id = plan_id;
    plan.price = price;
    plan.interval = interval;
    plan.grace_period = grace_period;
    plan.active = true;
    plan.bump = ctx.bumps.plan;

    ctx.accounts.config.plan_count = plan_id.checked_add(1).unwrap();
    Ok(plan_id)
}
