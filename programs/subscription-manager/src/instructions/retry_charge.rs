use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    error::SubscriptionError,
    instructions::pull_payment::pull_payment,
    state::{Config, Plan, Subscription, SubStatus},
};

// Permissionless, like charge_due — the user themself or a keeper can call
// this while a subscription is Overdue.
#[derive(Accounts)]
pub struct RetryCharge<'info> {
    #[account(constraint = !config.paused @ SubscriptionError::ContractPaused)]
    pub config: Account<'info, Config>,
    /// CHECK: only used for pubkey-based PDA derivation / token account owner checks below.
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

pub fn handle_retry_charge(ctx: Context<RetryCharge>) -> Result<()> {
    require!(ctx.accounts.subscription.status == SubStatus::Overdue, SubscriptionError::NotOverdue);

    let plan_price = ctx.accounts.plan.price;
    let plan_interval = ctx.accounts.plan.interval;
    let user_ata = &ctx.accounts.user_token_account;

    let sufficient = user_ata.delegate == COption::Some(ctx.accounts.config.key())
        && user_ata.delegated_amount >= plan_price
        && user_ata.amount >= plan_price;
    require!(sufficient, SubscriptionError::StillInsufficient);

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
    // Recovery path, same as pay_now: reset from the time of payment, not
    // the stale next_charge_at, so a long-overdue user isn't immediately
    // due again.
    sub.next_charge_at = clock.unix_timestamp + plan_interval;
    sub.periods_paid += 1;

    Ok(())
}
