use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::{error::SubscriptionError, state::Config};

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    #[account(mut, has_one = admin @ SubscriptionError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(constraint = new_treasury_token_account.mint == config.payment_mint @ SubscriptionError::MintMismatch)]
    pub new_treasury_token_account: Account<'info, TokenAccount>,
}

pub fn handle_set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
    ctx.accounts.config.treasury_token_account = ctx.accounts.new_treasury_token_account.key();
    Ok(())
}
