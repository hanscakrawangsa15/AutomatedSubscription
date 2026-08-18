use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    error::SubscriptionError,
    instructions::pull_payment::pull_payment,
    state::{Config, Plan, Subscription, SubStatus},
};

#[derive(Accounts)]
pub struct PayNow<'info> {
    #[account(constraint = !config.paused @ SubscriptionError::ContractPaused)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        has_one = config @ SubscriptionError::InvalidPlan,
        seeds = [PLAN_SEED, config.key().as_ref(), subscription.plan_id.to_le_bytes().as_ref()],
        bump = plan.bump,
    )]
    pub plan: Account<'info, Plan>,
    #[account(
        mut,
        seeds = [SUBSCRIPTION_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = subscription.bump,
        has_one = config @ SubscriptionError::InvalidPlan,
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
}

pub fn handle_pay_now(ctx: Context<PayNow>) -> Result<()> {
    require!(ctx.accounts.subscription.status == SubStatus::Overdue, SubscriptionError::NotOverdue);

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
    sub.status = SubStatus::Active;
    sub.overdue_since = 0;
    sub.next_charge_at = clock.unix_timestamp + plan_interval;
    sub.periods_paid += 1;

    Ok(())
}
