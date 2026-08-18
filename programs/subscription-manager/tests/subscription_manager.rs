// Covers the critical go/no-go paths from the Solana integration plan's
// Phase 1 checkpoint: initialize, create_plan, subscribe (first charge +
// SPL delegate pull), charge_due success (fixed-schedule advance),
// charge_due non-revert-on-insufficient-funds (the one behavior with no
// direct Solidity equivalent — see charge_due.rs's comment), and cancel.
// Further instructions (retry_charge/expire_overdue/pay_now/rescue_token)
// follow the exact same pull_payment + status-transition pattern already
// exercised here and are lower-risk to add later.
use {
    anchor_lang::{
        prelude::Pubkey as AnchorPubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    litesvm_token::{spl_token, Approve, CreateAssociatedTokenAccount, CreateMint, MintTo},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

// anchor_lang::Pubkey and litesvm-token's Address are distinct Rust types
// under the hood (different major versions of the same underlying 32-byte
// wrapper, a byproduct of the Solana SDK's ongoing crate-splitting) even
// though they represent identical data — convert explicitly at the
// boundary rather than assuming interchangeability.
fn to_anchor_pubkey(addr: &solana_address::Address) -> AnchorPubkey {
    AnchorPubkey::new_from_array(addr.to_bytes())
}
fn to_addr(pk: &AnchorPubkey) -> solana_address::Address {
    solana_address::Address::new_from_array(pk.to_bytes())
}

const DAY: i64 = 86_400;
const PLAN_PRICE: u64 = 10_000_000; // 10.0 tokens @ 6 decimals
const KEEPER_REWARD_BPS: u16 = 0;

struct Harness {
    svm: LiteSVM,
    program_id: AnchorPubkey,
    payer: Keypair,
    mint: AnchorPubkey,
    config: AnchorPubkey,
    // Kept alive on the harness even though no test currently asserts on
    // it directly — it's the signing authority behind treasury_ata and
    // must not be dropped while that account is in use.
    #[allow(dead_code)]
    treasury_owner: Keypair,
    treasury_ata: AnchorPubkey,
}

fn setup() -> Harness {
    let program_id = subscription_manager::id();
    let payer = Keypair::new();

    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/subscription_manager.so"));
    svm.add_program(to_addr(&program_id), bytes).unwrap();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    let mint_addr = CreateMint::new(&mut svm, &payer).decimals(6).send().unwrap();
    let mint = to_anchor_pubkey(&mint_addr);

    let treasury_owner = Keypair::new();
    svm.airdrop(&treasury_owner.pubkey(), 1_000_000_000).unwrap();
    let treasury_ata_addr = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint_addr)
        .owner(&treasury_owner.pubkey())
        .send()
        .unwrap();
    let treasury_ata = to_anchor_pubkey(&treasury_ata_addr);

    let config = AnchorPubkey::find_program_address(
        &[subscription_manager::constants::CONFIG_SEED, mint.as_ref()],
        &program_id,
    )
    .0;

    let ix = Instruction::new_with_bytes(
        to_addr(&program_id),
        &subscription_manager::instruction::Initialize {
            keeper_reward_bps: KEEPER_REWARD_BPS,
        }
        .data(),
        subscription_manager::accounts::Initialize {
            admin: payer.pubkey(),
            payment_mint: mint,
            treasury_token_account: treasury_ata,
            config,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &payer, &[ix]).expect("initialize should succeed");

    Harness {
        svm,
        program_id,
        payer,
        mint,
        config,
        treasury_owner,
        treasury_ata,
    }
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction]) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{e:?}"))
}

fn create_plan(h: &mut Harness, price: u64, interval: i64, grace_period: i64) -> (AnchorPubkey, u64) {
    let config_acc: subscription_manager::state::Config = {
        let data = h.svm.get_account(&to_addr(&h.config)).unwrap().data;
        subscription_manager::state::Config::try_deserialize(&mut &data[..]).unwrap()
    };
    let plan_id = config_acc.plan_count;
    let plan = AnchorPubkey::find_program_address(
        &[
            subscription_manager::constants::PLAN_SEED,
            h.config.as_ref(),
            plan_id.to_le_bytes().as_ref(),
        ],
        &h.program_id,
    )
    .0;

    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::CreatePlan {
            price,
            interval,
            grace_period,
        }
        .data(),
        subscription_manager::accounts::CreatePlan {
            config: h.config,
            admin: h.payer.pubkey(),
            plan,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let payer = h.payer.insecure_clone();
    send(&mut h.svm, &payer, &[ix]).expect("create_plan should succeed");
    (plan, plan_id)
}

/// Sets up a fresh user with `funded` tokens minted and `approved` delegated
/// to the Config PDA (the direct SPL equivalent of an ERC20 `approve`).
fn setup_user(h: &mut Harness, funded: u64, approved: u64) -> (Keypair, AnchorPubkey) {
    let user = Keypair::new();
    h.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();

    let mint_addr = to_addr(&h.mint);
    let user_ata_addr = CreateAssociatedTokenAccount::new(&mut h.svm, &h.payer, &mint_addr)
        .owner(&user.pubkey())
        .send()
        .unwrap();

    if funded > 0 {
        MintTo::new(&mut h.svm, &h.payer, &mint_addr, &user_ata_addr, funded)
            .send()
            .unwrap();
    }
    if approved > 0 {
        let config_addr = to_addr(&h.config);
        Approve::new(&mut h.svm, &h.payer, &config_addr, &user_ata_addr, approved)
            .owner(&user)
            .send()
            .unwrap();
    }

    (user, to_anchor_pubkey(&user_ata_addr))
}

fn subscribe(h: &mut Harness, user: &Keypair, user_ata: AnchorPubkey, plan: AnchorPubkey) -> Result<(), String> {
    let subscription = AnchorPubkey::find_program_address(
        &[
            subscription_manager::constants::SUBSCRIPTION_SEED,
            h.config.as_ref(),
            user.pubkey().to_bytes().as_ref(),
        ],
        &h.program_id,
    )
    .0;

    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::Subscribe {}.data(),
        subscription_manager::accounts::Subscribe {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            token_program: to_anchor_pubkey(&spl_token::ID),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut h.svm, user, &[ix])
}

fn subscription_pda(h: &Harness, user: &AnchorPubkey) -> AnchorPubkey {
    AnchorPubkey::find_program_address(
        &[
            subscription_manager::constants::SUBSCRIPTION_SEED,
            h.config.as_ref(),
            user.as_ref(),
        ],
        &h.program_id,
    )
    .0
}

fn get_subscription(h: &Harness, user: &AnchorPubkey) -> subscription_manager::state::Subscription {
    let addr = to_addr(&subscription_pda(h, user));
    let data = h.svm.get_account(&addr).unwrap().data;
    subscription_manager::state::Subscription::try_deserialize(&mut &data[..]).unwrap()
}

#[test]
fn initialize_creates_config() {
    let h = setup();
    let data = h.svm.get_account(&to_addr(&h.config)).unwrap().data;
    let config = subscription_manager::state::Config::try_deserialize(&mut &data[..]).unwrap();
    assert_eq!(config.admin, h.payer.pubkey_anchor());
    assert_eq!(config.payment_mint, h.mint);
    assert_eq!(config.plan_count, 0);
    assert!(!config.paused);
}

#[test]
fn create_plan_increments_count_and_stores_fields() {
    let mut h = setup();
    let (plan_addr, plan_id) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    assert_eq!(plan_id, 0);

    let data = h.svm.get_account(&to_addr(&plan_addr)).unwrap().data;
    let plan = subscription_manager::state::Plan::try_deserialize(&mut &data[..]).unwrap();
    assert_eq!(plan.price, PLAN_PRICE);
    assert_eq!(plan.interval, 30 * DAY);
    assert_eq!(plan.grace_period, 5 * DAY);
    assert!(plan.active);

    let data = h.svm.get_account(&to_addr(&h.config)).unwrap().data;
    let config = subscription_manager::state::Config::try_deserialize(&mut &data[..]).unwrap();
    assert_eq!(config.plan_count, 1);
}

#[test]
fn subscribe_pulls_first_period_and_activates() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 5, PLAN_PRICE * 3);

    subscribe(&mut h, &user, user_ata, plan).expect("subscribe should succeed");

    let sub = get_subscription(&h, &user.pubkey_anchor());
    assert_eq!(sub.status, subscription_manager::state::SubStatus::Active);
    assert_eq!(sub.plan_id, 0);
    assert_eq!(sub.periods_paid, 1);
    assert_eq!(sub.overdue_since, 0);

    // First period's payment landed in the treasury immediately, same as
    // SubscriptionManager.sol's subscribe() pulling period 1 in-transaction.
    let treasury_data = h.svm.get_account(&to_addr(&h.treasury_ata)).unwrap().data;
    let treasury_account =
        litesvm_token::get_spl_account::<spl_token::state::Account>(&h.svm, &to_addr(&h.treasury_ata)).unwrap();
    let _ = treasury_data;
    assert_eq!(treasury_account.amount, PLAN_PRICE);
}

#[test]
fn charge_due_advances_schedule_on_success() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 5, PLAN_PRICE * 3);
    subscribe(&mut h, &user, user_ata, plan).unwrap();

    let sub_before = get_subscription(&h, &user.pubkey_anchor());

    // Warp the clock past next_charge_at (fixed-schedule renewal, like the
    // EVM keeper's block.timestamp check).
    warp_clock(&mut h.svm, sub_before.next_charge_at + 1);

    let subscription = subscription_pda(&h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::ChargeDue {}.data(),
        subscription_manager::accounts::ChargeDue {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            keeper_reward_token_account: None,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let keeper = Keypair::new();
    h.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    send(&mut h.svm, &keeper, &[ix]).expect("charge_due should succeed when funded and due");

    let sub_after = get_subscription(&h, &user.pubkey_anchor());
    assert_eq!(sub_after.status, subscription_manager::state::SubStatus::Active);
    assert_eq!(sub_after.periods_paid, 2);
    assert_eq!(sub_after.next_charge_at, sub_before.next_charge_at + 30 * DAY);
}

#[test]
fn charge_due_marks_overdue_without_reverting_when_underfunded() {
    // The one behavior with no direct Solidity try/catch equivalent: a
    // Solana transaction that hits an instruction error reverts entirely,
    // so charge_due must pre-check and take the Overdue branch WITHOUT
    // attempting the CPI transfer for the routine "insufficient funds"
    // case — this test is the go/no-go check for that guarantee.
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    // Approve exactly one period only — the second charge_due should find
    // the delegated_amount already spent down to zero after subscribe.
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 5, PLAN_PRICE);
    subscribe(&mut h, &user, user_ata, plan).unwrap();

    let sub_before = get_subscription(&h, &user.pubkey_anchor());
    warp_clock(&mut h.svm, sub_before.next_charge_at + 1);

    let subscription = subscription_pda(&h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::ChargeDue {}.data(),
        subscription_manager::accounts::ChargeDue {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            keeper_reward_token_account: None,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let keeper = Keypair::new();
    h.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    send(&mut h.svm, &keeper, &[ix]).expect("charge_due must return Ok, never revert, on routine insufficient funds");

    let sub_after = get_subscription(&h, &user.pubkey_anchor());
    assert_eq!(sub_after.status, subscription_manager::state::SubStatus::Overdue);
    assert_eq!(sub_after.periods_paid, 1, "no charge should have been pulled");
    assert_eq!(sub_after.overdue_since, sub_before.next_charge_at + 1);
}

#[test]
fn cancel_sets_inactive_and_blocks_double_cancel() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 5, PLAN_PRICE * 3);
    subscribe(&mut h, &user, user_ata, plan).unwrap();

    let subscription = subscription_pda(&h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::Cancel {}.data(),
        subscription_manager::accounts::Cancel {
            config: h.config,
            user: user.pubkey(),
            subscription,
        }
        .to_account_metas(None),
    );
    send(&mut h.svm, &user, std::slice::from_ref(&ix)).expect("cancel should succeed while Active");

    let sub = get_subscription(&h, &user.pubkey_anchor());
    assert_eq!(sub.status, subscription_manager::state::SubStatus::Inactive);

    // Cancelling again must fail (NotActive) — mirrors
    // SubscriptionManager.sol's require(status Active || Overdue).
    let result = send(&mut h.svm, &user, &[ix]);
    assert!(result.is_err(), "double-cancel should fail");
}

fn retry_charge(h: &mut Harness, user: &Keypair, user_ata: AnchorPubkey, plan: AnchorPubkey) -> Result<(), String> {
    let subscription = subscription_pda(h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::RetryCharge {}.data(),
        subscription_manager::accounts::RetryCharge {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let keeper = Keypair::new();
    h.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    send(&mut h.svm, &keeper, &[ix])
}

fn expire_overdue(h: &mut Harness, user: &Keypair, plan: AnchorPubkey) -> Result<(), String> {
    let subscription = subscription_pda(h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::ExpireOverdue {}.data(),
        subscription_manager::accounts::ExpireOverdue {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
        }
        .to_account_metas(None),
    );
    let keeper = Keypair::new();
    h.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    send(&mut h.svm, &keeper, &[ix])
}

fn pay_now(h: &mut Harness, user: &Keypair, user_ata: AnchorPubkey, plan: AnchorPubkey) -> Result<(), String> {
    let subscription = subscription_pda(h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::PayNow {}.data(),
        subscription_manager::accounts::PayNow {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    send(&mut h.svm, user, &[ix])
}

fn set_plan_active(h: &mut Harness, signer: &Keypair, plan: AnchorPubkey, active: bool) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::SetPlanActive { active }.data(),
        subscription_manager::accounts::SetPlanActive {
            config: h.config,
            admin: signer.pubkey(),
            plan,
        }
        .to_account_metas(None),
    );
    send(&mut h.svm, signer, &[ix])
}

fn pause(h: &mut Harness, signer: &Keypair) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::Pause {}.data(),
        subscription_manager::accounts::SetPaused { config: h.config, admin: signer.pubkey() }.to_account_metas(None),
    );
    send(&mut h.svm, signer, &[ix])
}

fn get_config(h: &Harness) -> subscription_manager::state::Config {
    let data = h.svm.get_account(&to_addr(&h.config)).unwrap().data;
    subscription_manager::state::Config::try_deserialize(&mut &data[..]).unwrap()
}

fn get_plan(h: &Harness, plan: AnchorPubkey) -> subscription_manager::state::Plan {
    let data = h.svm.get_account(&to_addr(&plan)).unwrap().data;
    subscription_manager::state::Plan::try_deserialize(&mut &data[..]).unwrap()
}

#[test]
fn retry_charge_reactivates_when_topped_up_after_overdue() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    // Approve only 1 period — subscribe consumes it, next charge goes Overdue.
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 10, PLAN_PRICE);
    subscribe(&mut h, &user, user_ata, plan).unwrap();

    let sub_before = get_subscription(&h, &user.pubkey_anchor());
    warp_clock(&mut h.svm, sub_before.next_charge_at + 1);
    // Drive it Overdue via charge_due (already proven correct behavior).
    let subscription = subscription_pda(&h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::ChargeDue {}.data(),
        subscription_manager::accounts::ChargeDue {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            keeper_reward_token_account: None,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let keeper = Keypair::new();
    h.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    send(&mut h.svm, &keeper, &[ix]).unwrap();
    assert_eq!(get_subscription(&h, &user.pubkey_anchor()).status, subscription_manager::state::SubStatus::Overdue);

    // Top up the delegated amount, then retry_charge should succeed.
    // expire_blockhash() first: this approve is otherwise byte-identical to
    // the one setup_user() already sent (same instruction/accounts/amount)
    // — without a fresh blockhash LiteSVM dedupes it as AlreadyProcessed,
    // a test-harness quirk with no real-cluster equivalent (a live cluster
    // naturally advances blockhashes between transactions).
    h.svm.expire_blockhash();
    let config_addr = to_addr(&h.config);
    Approve::new(&mut h.svm, &h.payer, &config_addr, &to_addr(&user_ata), PLAN_PRICE)
        .owner(&user)
        .send()
        .unwrap();

    retry_charge(&mut h, &user, user_ata, plan).expect("retry_charge should succeed once funded/approved again");

    let sub_after = get_subscription(&h, &user.pubkey_anchor());
    assert_eq!(sub_after.status, subscription_manager::state::SubStatus::Active);
    assert_eq!(sub_after.overdue_since, 0);
    assert_eq!(sub_after.periods_paid, 2);
}

#[test]
fn retry_charge_fails_when_still_insufficient() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 10, PLAN_PRICE);
    subscribe(&mut h, &user, user_ata, plan).unwrap();

    let sub_before = get_subscription(&h, &user.pubkey_anchor());
    warp_clock(&mut h.svm, sub_before.next_charge_at + 1);
    let subscription = subscription_pda(&h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::ChargeDue {}.data(),
        subscription_manager::accounts::ChargeDue {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            keeper_reward_token_account: None,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let keeper = Keypair::new();
    h.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    send(&mut h.svm, &keeper, &[ix]).unwrap();

    // No top-up this time — retry_charge must fail, mirroring Solidity's
    // require(allowance >= price && balance >= price, "still insufficient").
    let result = retry_charge(&mut h, &user, user_ata, plan);
    assert!(result.is_err(), "retry_charge should fail without a fresh approval");
    assert_eq!(get_subscription(&h, &user.pubkey_anchor()).status, subscription_manager::state::SubStatus::Overdue);
}

#[test]
fn expire_overdue_after_grace_period_passes() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 10, PLAN_PRICE);
    subscribe(&mut h, &user, user_ata, plan).unwrap();

    let sub_before = get_subscription(&h, &user.pubkey_anchor());
    warp_clock(&mut h.svm, sub_before.next_charge_at + 1);
    let subscription = subscription_pda(&h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::ChargeDue {}.data(),
        subscription_manager::accounts::ChargeDue {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            keeper_reward_token_account: None,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let keeper = Keypair::new();
    h.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    send(&mut h.svm, &keeper, &[ix]).unwrap();
    let overdue_since = get_subscription(&h, &user.pubkey_anchor()).overdue_since;

    // Before grace period passes: must fail.
    let too_early = expire_overdue(&mut h, &user, plan);
    assert!(too_early.is_err(), "expire_overdue should fail before the grace period passes");

    // After grace period passes: must succeed.
    warp_clock(&mut h.svm, overdue_since + 5 * DAY + 1);
    expire_overdue(&mut h, &user, plan).expect("expire_overdue should succeed once the grace period has passed");
    assert_eq!(get_subscription(&h, &user.pubkey_anchor()).status, subscription_manager::state::SubStatus::Expired);
}

#[test]
fn pay_now_reactivates_overdue_subscription() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 10, PLAN_PRICE);
    subscribe(&mut h, &user, user_ata, plan).unwrap();

    let sub_before = get_subscription(&h, &user.pubkey_anchor());
    warp_clock(&mut h.svm, sub_before.next_charge_at + 1);
    let subscription = subscription_pda(&h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::ChargeDue {}.data(),
        subscription_manager::accounts::ChargeDue {
            config: h.config,
            user: user.pubkey(),
            plan,
            subscription,
            user_token_account: user_ata,
            treasury_token_account: h.treasury_ata,
            keeper_reward_token_account: None,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let keeper = Keypair::new();
    h.svm.airdrop(&keeper.pubkey(), 1_000_000_000).unwrap();
    send(&mut h.svm, &keeper, &[ix]).unwrap();

    h.svm.expire_blockhash();
    let config_addr = to_addr(&h.config);
    Approve::new(&mut h.svm, &h.payer, &config_addr, &to_addr(&user_ata), PLAN_PRICE)
        .owner(&user)
        .send()
        .unwrap();

    pay_now(&mut h, &user, user_ata, plan).expect("pay_now should succeed once funded/approved again");

    let sub_after = get_subscription(&h, &user.pubkey_anchor());
    assert_eq!(sub_after.status, subscription_manager::state::SubStatus::Active);
    assert_eq!(sub_after.periods_paid, 2);
}

#[test]
fn rescue_token_transfers_non_payment_token_but_rejects_payment_mint() {
    let mut h = setup();

    // A second, unrelated mint accidentally sent to a token account owned
    // by the Config PDA — the scenario rescue_token exists for.
    let other_mint = CreateMint::new(&mut h.svm, &h.payer).decimals(6).send().unwrap();
    let config_addr = to_addr(&h.config);
    let stray_ata = CreateAssociatedTokenAccount::new(&mut h.svm, &h.payer, &other_mint)
        .owner(&config_addr)
        .send()
        .unwrap();
    MintTo::new(&mut h.svm, &h.payer, &other_mint, &stray_ata, 500).send().unwrap();

    let admin_other_ata = CreateAssociatedTokenAccount::new(&mut h.svm, &h.payer, &other_mint)
        .owner(&h.payer.pubkey())
        .send()
        .unwrap();

    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::RescueToken { amount: 500 }.data(),
        subscription_manager::accounts::RescueToken {
            config: h.config,
            admin: h.payer.pubkey(),
            from: to_anchor_pubkey(&stray_ata),
            to: to_anchor_pubkey(&admin_other_ata),
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let payer = h.payer.insecure_clone();
    send(&mut h.svm, &payer, &[ix]).expect("rescue_token should move a non-payment-mint token out");

    let rescued = litesvm_token::get_spl_account::<spl_token::state::Account>(&h.svm, &admin_other_ata).unwrap();
    assert_eq!(rescued.amount, 500);

    // Now force a payment_mint balance into a Config-owned account and
    // confirm the guard rejects rescuing it — this is the one rescue path
    // that must never be allowed, since the whole pull-payment design
    // assumes the Config PDA never legitimately holds payment_mint funds.
    let mint_addr = to_addr(&h.mint);
    let stray_payment_ata = CreateAssociatedTokenAccount::new(&mut h.svm, &h.payer, &mint_addr)
        .owner(&config_addr)
        .send()
        .unwrap();
    MintTo::new(&mut h.svm, &h.payer, &mint_addr, &stray_payment_ata, 500).send().unwrap();

    let ix2 = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::RescueToken { amount: 500 }.data(),
        subscription_manager::accounts::RescueToken {
            config: h.config,
            admin: h.payer.pubkey(),
            from: to_anchor_pubkey(&stray_payment_ata),
            to: h.treasury_ata,
            token_program: to_anchor_pubkey(&spl_token::ID),
        }
        .to_account_metas(None),
    );
    let payer2 = h.payer.insecure_clone();
    let result = send(&mut h.svm, &payer2, &[ix2]);
    assert!(result.is_err(), "rescue_token must reject the payment mint");
}

#[test]
fn admin_only_instructions_reject_non_admin_signer() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);

    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();

    let result = set_plan_active(&mut h, &stranger, plan, false);
    assert!(result.is_err(), "set_plan_active must reject a non-admin signer");
    assert!(get_plan(&h, plan).active, "plan must remain untouched after the rejected call");

    let result = pause(&mut h, &stranger);
    assert!(result.is_err(), "pause must reject a non-admin signer");
    assert!(!get_config(&h).paused, "config must remain untouched after the rejected call");
}

#[test]
fn pause_blocks_subscribe_but_still_allows_cancel() {
    let mut h = setup();
    let (plan, _) = create_plan(&mut h, PLAN_PRICE, 30 * DAY, 5 * DAY);
    let (user, user_ata) = setup_user(&mut h, PLAN_PRICE * 10, PLAN_PRICE * 3);
    subscribe(&mut h, &user, user_ata, plan).expect("subscribe before pause should succeed");

    let payer = h.payer.insecure_clone();
    pause(&mut h, &payer).expect("admin pause should succeed");
    assert!(get_config(&h).paused);

    // A second user trying to subscribe while paused must be rejected.
    let (user2, user2_ata) = setup_user(&mut h, PLAN_PRICE * 10, PLAN_PRICE * 3);
    let result = subscribe(&mut h, &user2, user2_ata, plan);
    assert!(result.is_err(), "subscribe must be blocked while the config is paused");

    // The already-subscribed user must still be able to cancel — opt-out
    // always works, even mid-incident (see cancel.rs's comment).
    let subscription = subscription_pda(&h, &user.pubkey_anchor());
    let ix = Instruction::new_with_bytes(
        to_addr(&h.program_id),
        &subscription_manager::instruction::Cancel {}.data(),
        subscription_manager::accounts::Cancel { config: h.config, user: user.pubkey(), subscription }.to_account_metas(None),
    );
    send(&mut h.svm, &user, &[ix]).expect("cancel must still work while paused");
    assert_eq!(get_subscription(&h, &user.pubkey_anchor()).status, subscription_manager::state::SubStatus::Inactive);
}

fn warp_clock(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

trait PubkeyAnchorExt {
    fn pubkey_anchor(&self) -> AnchorPubkey;
}
impl PubkeyAnchorExt for Keypair {
    fn pubkey_anchor(&self) -> AnchorPubkey {
        AnchorPubkey::new_from_array(self.pubkey().to_bytes())
    }
}
