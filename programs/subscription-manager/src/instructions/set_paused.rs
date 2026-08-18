use anchor_lang::prelude::*;

use crate::{error::SubscriptionError, state::Config};

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, has_one = admin @ SubscriptionError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

// Circuit breaker, mirrors SubscriptionManager.sol's pause()/unpause() —
// blocks subscribe/charge_due/retry_charge/pay_now but never cancel (see
// cancel.rs's comment: opt-out must always work even during an incident).
pub fn handle_pause(ctx: Context<SetPaused>) -> Result<()> {
    ctx.accounts.config.paused = true;
    Ok(())
}

pub fn handle_unpause(ctx: Context<SetPaused>) -> Result<()> {
    ctx.accounts.config.paused = false;
    Ok(())
}
