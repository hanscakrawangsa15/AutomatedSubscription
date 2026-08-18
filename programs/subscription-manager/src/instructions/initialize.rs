use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::{constants::*, error::SubscriptionError, state::Config};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub payment_mint: Account<'info, Mint>,
    #[account(constraint = treasury_token_account.mint == payment_mint.key() @ SubscriptionError::MintMismatch)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    // One Config per (program, payment_mint) — a second payment token later
    // is just a second `initialize` call with a different mint, no redeploy.
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED, payment_mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, keeper_reward_bps: u16) -> Result<()> {
    require!(keeper_reward_bps <= MAX_KEEPER_REWARD_BPS, SubscriptionError::RewardTooHigh);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.payment_mint = ctx.accounts.payment_mint.key();
    config.treasury_token_account = ctx.accounts.treasury_token_account.key();
    config.keeper_reward_bps = keeper_reward_bps;
    config.paused = false;
    config.plan_count = 0;
    config.bump = ctx.bumps.config;
    Ok(())
}
