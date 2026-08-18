use anchor_lang::prelude::*;

use crate::{constants::MAX_KEEPER_REWARD_BPS, error::SubscriptionError, state::Config};

#[derive(Accounts)]
pub struct SetKeeperRewardBps<'info> {
    #[account(mut, has_one = admin @ SubscriptionError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

pub fn handle_set_keeper_reward_bps(ctx: Context<SetKeeperRewardBps>, bps: u16) -> Result<()> {
    require!(bps <= MAX_KEEPER_REWARD_BPS, SubscriptionError::RewardTooHigh);
    ctx.accounts.config.keeper_reward_bps = bps;
    Ok(())
}
