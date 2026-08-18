use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{constants::*, error::SubscriptionError, state::Config};

// Rescues tokens accidentally sent to a token account owned by the Config
// PDA — mirrors SubscriptionManager.sol's rescueERC20, including the same
// guard forbidding rescue of the payment mint itself: this program's
// pull-payment design never lets the Config PDA hold a payment_mint
// balance (every transfer goes user -> treasury/keeper directly via the
// delegate-authority CPI in pull_payment.rs), so this is a pure safety
// rail, not a recovery path for "trapped" subscriber funds.
#[derive(Accounts)]
pub struct RescueToken<'info> {
    #[account(has_one = admin @ SubscriptionError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = from.owner == config.key() @ SubscriptionError::InvalidRescueSource,
        constraint = from.mint != config.payment_mint @ SubscriptionError::CannotRescuePaymentMint,
    )]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, constraint = to.mint == from.mint @ SubscriptionError::MintMismatch)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_rescue_token(ctx: Context<RescueToken>, amount: u64) -> Result<()> {
    let payment_mint = ctx.accounts.config.payment_mint;
    let config_bump = ctx.accounts.config.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, payment_mint.as_ref(), &[config_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.from.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;
    Ok(())
}
