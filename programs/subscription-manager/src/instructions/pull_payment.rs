use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Transfer};

use crate::{constants::CONFIG_SEED, error::SubscriptionError, state::Config};

/// Shared by subscribe/charge_due/retry_charge/pay_now — the one place that
/// actually moves payment_mint tokens, all via the Config PDA's SPL Token
/// delegate authority (set once by the user's own `approve` instruction, the
/// direct equivalent of ERC20 allowance). Mirrors SubscriptionManager.sol's
/// single reused `safeTransferFrom` call site.
///
/// `reward_bps` is 0 for subscribe/retry_charge/pay_now (Solidity never
/// rewards the caller for those) and `config.keeper_reward_bps` only for
/// charge_due — matching the Solidity contract exactly rather than
/// generalizing a reward split that only one of the four call sites uses.
pub fn pull_payment<'info>(
    config: &Account<'info, Config>,
    user_token_account: &AccountInfo<'info>,
    treasury_token_account: &AccountInfo<'info>,
    keeper_reward_token_account: Option<&AccountInfo<'info>>,
    token_program: &Program<'info, Token>,
    price: u64,
    reward_bps: u16,
) -> Result<()> {
    let keeper_reward = ((price as u128) * (reward_bps as u128) / 10_000) as u64;
    let amount_to_treasury = price - keeper_reward;

    let payment_mint = config.payment_mint;
    let config_bump = config.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, payment_mint.as_ref(), &[config_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: user_token_account.clone(),
                to: treasury_token_account.clone(),
                authority: config.to_account_info(),
            },
            signer_seeds,
        ),
        amount_to_treasury,
    )?;

    if keeper_reward > 0 {
        let reward_account = keeper_reward_token_account.ok_or(SubscriptionError::MissingKeeperRewardAccount)?;
        token::transfer(
            CpiContext::new_with_signer(
                token_program.key(),
                Transfer {
                    from: user_token_account.clone(),
                    to: reward_account.clone(),
                    authority: config.to_account_info(),
                },
                signer_seeds,
            ),
            keeper_reward,
        )?;
    }

    Ok(())
}
