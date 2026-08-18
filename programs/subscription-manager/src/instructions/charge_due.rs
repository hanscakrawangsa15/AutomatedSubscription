use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{Token, TokenAccount};

use crate::{
    constants::*,
    error::SubscriptionError,
    instructions::pull_payment::pull_payment,
    state::{Config, Plan, Subscription, SubStatus},
};

// Permissionless — anyone (a keeper bot) can call this. `user` is passed as
// plain pubkey material (not a Signer) purely to derive the Subscription/
// user_token_account addresses, mirroring chargeDue(address user) in
// SubscriptionManager.sol.
#[derive(Accounts)]
pub struct ChargeDue<'info> {
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
    // Required only when config.keeper_reward_bps > 0 — the keeper must
    // create its own reward ATA up front (see the plan doc: the program
    // deliberately never auto-creates it, to avoid a permissionless
    // instruction paying unbounded rent-creation griefing costs).
    #[account(mut)]
    pub keeper_reward_token_account: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_charge_due(ctx: Context<ChargeDue>) -> Result<()> {
    require!(ctx.accounts.subscription.status == SubStatus::Active, SubscriptionError::NotActive);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= ctx.accounts.subscription.next_charge_at, SubscriptionError::NotDueYet);

    let plan_price = ctx.accounts.plan.price;
    let plan_interval = ctx.accounts.plan.interval;
    let user_ata = &ctx.accounts.user_token_account;

    // Pre-check BEFORE attempting the CPI transfer — unlike Solidity's
    // try/catch-free-but-still-per-call-isolated safeTransferFrom, a Solana
    // transaction that hits ANY instruction error reverts entirely. This
    // must never let the transfer itself fail for the routine "insufficient
    // funds" case, or a permissionless keeper's batch would get stuck the
    // same way Solidity's chargeDue explicitly avoids (see its comment).
    let insufficient = user_ata.delegate != COption::Some(ctx.accounts.config.key())
        || user_ata.delegated_amount < plan_price
        || user_ata.amount < plan_price;
    if insufficient {
        let sub = &mut ctx.accounts.subscription;
        sub.status = SubStatus::Overdue;
        sub.overdue_since = clock.unix_timestamp;
        return Ok(());
    }

    pull_payment(
        &ctx.accounts.config,
        &ctx.accounts.user_token_account.to_account_info(),
        &ctx.accounts.treasury_token_account.to_account_info(),
        ctx.accounts
            .keeper_reward_token_account
            .as_ref()
            .map(|a| a.to_account_info())
            .as_ref(),
        &ctx.accounts.token_program,
        plan_price,
        ctx.accounts.config.keeper_reward_bps,
    )?;

    let sub = &mut ctx.accounts.subscription;
    sub.next_charge_at += plan_interval;
    sub.periods_paid += 1;

    Ok(())
}
