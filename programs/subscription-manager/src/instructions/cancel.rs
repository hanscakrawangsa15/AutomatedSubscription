use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::SubscriptionError,
    state::{Subscription, SubStatus},
};

// Deliberately NOT gated on config.paused, and `config` is intentionally an
// UncheckedAccount here (only used as PDA seed material, never read) —
// mirrors SubscriptionManager.sol's comment that cancel() must always work
// so a user can opt out even during an incident, independent of whatever
// state Config is in.
#[derive(Accounts)]
pub struct Cancel<'info> {
    /// CHECK: only used to derive the subscription PDA's seed; never read.
    pub config: UncheckedAccount<'info>,
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [SUBSCRIPTION_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = subscription.bump,
    )]
    pub subscription: Account<'info, Subscription>,
}

pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    let sub = &mut ctx.accounts.subscription;
    require!(
        sub.status == SubStatus::Active || sub.status == SubStatus::Overdue,
        SubscriptionError::NotActive
    );
    sub.status = SubStatus::Inactive;
    Ok(())
}
