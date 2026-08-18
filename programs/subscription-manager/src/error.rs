use anchor_lang::prelude::*;

#[error_code]
pub enum SubscriptionError {
    #[msg("Only the config admin can perform this action")]
    Unauthorized,
    #[msg("Price must be greater than zero")]
    ZeroPrice,
    #[msg("Interval is too short")]
    IntervalTooShort,
    #[msg("Plan is not active")]
    PlanNotActive,
    #[msg("Plan does not belong to this config")]
    InvalidPlan,
    #[msg("User is already subscribed (Active or Overdue)")]
    AlreadySubscribed,
    #[msg("Subscription is not Active")]
    NotActive,
    #[msg("Subscription is not Overdue")]
    NotOverdue,
    #[msg("Subscription is not due for charging yet")]
    NotDueYet,
    #[msg("Balance or delegated amount is still insufficient")]
    StillInsufficient,
    #[msg("Grace period has not passed yet")]
    GracePeriodNotPassed,
    #[msg("Keeper reward bps exceeds the maximum allowed")]
    RewardTooHigh,
    #[msg("The payment mint can never be rescued from here — pull-payment design never lets this program hold a payment_mint balance")]
    CannotRescuePaymentMint,
    #[msg("Rescue source token account must be owned by the config PDA")]
    InvalidRescueSource,
    #[msg("Program is paused")]
    ContractPaused,
    #[msg("A keeper reward token account is required when this config's keeper_reward_bps > 0")]
    MissingKeeperRewardAccount,
    #[msg("Token account mint does not match the config's payment mint")]
    MintMismatch,
    #[msg("Token account owner does not match the expected user")]
    InvalidUserTokenAccount,
    #[msg("Treasury token account does not match config.treasury_token_account")]
    InvalidTreasuryAccount,
}
