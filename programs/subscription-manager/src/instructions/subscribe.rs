use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    error::SubscriptionError,
    instructions::pull_payment::pull_payment,
    state::{Config, Plan, Subscription, SubStatus},
};

#[derive(Accounts)]
pub struct Subscribe<'info> {
    #[account(constraint = !config.paused @ SubscriptionError::ContractPaused)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(has_one = config @ SubscriptionError::InvalidPlan, constraint = plan.active @ SubscriptionError::PlanNotActive)]
    pub plan: Account<'info, Plan>,
    // init_if_needed: a user's Subscription PDA persists across cancel (see
    // state.rs) so re-subscribing after cancelling loads the existing
    // account rather than re-initializing it — the require! below is what
    // actually gates re-subscription, not account creation.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Subscription::INIT_SPACE,
        seeds = [SUBSCRIPTION_SEED, config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub subscription: Account<'info, Subscription>,
    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ SubscriptionError::InvalidUserTokenAccount,
        constraint = user_token_account.mint == config.payment_mint @ SubscriptionError::MintMismatch,
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury_token_account @ SubscriptionError::InvalidTreasuryAccount)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_subscribe(ctx: Context<Subscribe>) -> Result<()> {
    require!(
        ctx.accounts.subscription.status != SubStatus::Active && ctx.accounts.subscription.status != SubStatus::Overdue,
        SubscriptionError::AlreadySubscribed
    );

    let plan_id = ctx.accounts.plan.plan_id;
    let plan_price = ctx.accounts.plan.price;
    let plan_interval = ctx.accounts.plan.interval;

    pull_payment(
        &ctx.accounts.config,
        &ctx.accounts.user_token_account.to_account_info(),
        &ctx.accounts.treasury_token_account.to_account_info(),
        None,
        &ctx.accounts.token_program,
        plan_price,
        0,
    )?;

    let clock = Clock::get()?;
    let sub = &mut ctx.accounts.subscription;
    sub.user = ctx.accounts.user.key();
    sub.config = ctx.accounts.config.key();
    sub.plan_id = plan_id;
    sub.status = SubStatus::Active;
    sub.next_charge_at = clock.unix_timestamp + plan_interval;
    sub.overdue_since = 0;
    sub.periods_paid += 1;
    sub.bump = ctx.bumps.subscription;

    Ok(())
}
