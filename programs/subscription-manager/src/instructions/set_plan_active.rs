use anchor_lang::prelude::*;

use crate::{
    error::SubscriptionError,
    state::{Config, Plan},
};

#[derive(Accounts)]
pub struct SetPlanActive<'info> {
    #[account(has_one = admin @ SubscriptionError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(mut, has_one = config @ SubscriptionError::InvalidPlan)]
    pub plan: Account<'info, Plan>,
}

pub fn handle_set_plan_active(ctx: Context<SetPlanActive>, active: bool) -> Result<()> {
    ctx.accounts.plan.active = active;
    Ok(())
}
