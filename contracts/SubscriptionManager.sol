// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SubscriptionManager
 * @notice Pull-payment subscription. Kompatibel dengan semua wallet EOA
 *         (via WalletConnect/AppKit) karena hanya butuh SATU approve() di awal.
 *         Setelah itu, charge bulanan dieksekusi oleh keeper (bot/cron/Chainlink
 *         Automation/Gelato) tanpa perlu wallet user tanda tangan lagi.
 *
 * Alur:
 *  1. User approve(token, thisContract, cukupUntukBeberapaBulan)
 *  2. User subscribe(planId)               <- konfirmasi awal, sekali saja
 *  3. Keeper panggil chargeDue(user) tiap siklus jatuh tempo
 *  4. Jika allowance/saldo user tidak cukup -> subscription masuk status
 *     Overdue, ada grace period, lalu auto-expire kalau tidak dibayar
 */
contract SubscriptionManager is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    enum Status {
        Inactive,   // belum pernah subscribe / sudah dibatalkan
        Active,     // berjalan normal
        Overdue,    // gagal charge, masih dalam grace period
        Expired     // grace period habis, akses dicabut
    }

    struct Plan {
        uint256 price;          // harga per periode, dalam unit terkecil paymentToken (desimal beda-beda per chain, mis. 6 utk USDC, 18 utk BEP-20 USDT)
        uint256 interval;       // panjang periode dalam detik (mis. 30 days)
        uint256 gracePeriod;    // toleransi keterlambatan sebelum Expired
        bool active;            // admin bisa nonaktifkan plan baru, subscriber lama tetap jalan
    }

    struct Subscription {
        uint256 planId;
        Status status;
        uint256 nextChargeAt;   // timestamp target charge berikutnya
        uint256 overdueSince;   // 0 jika tidak overdue
        uint256 periodsPaid;    // total periode yang sudah dibayar (histori)
    }

    // ---------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------

    IERC20 public immutable paymentToken;
    address public treasury;              // penerima dana subscription

    uint256 public keeperRewardBps = 0;   // insentif keeper dlm basis poin dari price (mis. 50 = 0.5%)
    uint256 public constant MAX_KEEPER_REWARD_BPS = 200; // cap 2%, safety limit

    mapping(uint256 => Plan) public plans;
    uint256 public planCount;

    mapping(address => Subscription) public subscriptions;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event PlanCreated(uint256 indexed planId, uint256 price, uint256 interval, uint256 gracePeriod);
    event PlanUpdated(uint256 indexed planId, bool active);
    event Subscribed(address indexed user, uint256 indexed planId, uint256 nextChargeAt);
    event Charged(address indexed user, uint256 indexed planId, uint256 amount, uint256 nextChargeAt);
    event ChargeFailed(address indexed user, uint256 indexed planId, string reason);
    event MarkedOverdue(address indexed user, uint256 overdueSince);
    event Expired(address indexed user);
    event Cancelled(address indexed user);
    event Reactivated(address indexed user, uint256 nextChargeAt);
    event TreasuryUpdated(address indexed newTreasury);
    event KeeperRewardBpsUpdated(uint256 newBps);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    constructor(address _paymentToken, address _treasury) Ownable(msg.sender) {
        require(_paymentToken != address(0), "token=0");
        require(_treasury != address(0), "treasury=0");
        paymentToken = IERC20(_paymentToken);
        treasury = _treasury;
    }

    // ---------------------------------------------------------------
    // Admin: kelola plan
    // ---------------------------------------------------------------

    function createPlan(
        uint256 price,
        uint256 interval,
        uint256 gracePeriod
    ) external onlyOwner returns (uint256 planId) {
        require(price > 0, "price=0");
        // Floor lowered from 1 days to 1 minutes to allow a fast-interval
        // plan for local testing (e.g. a 3-minute renewal cycle).
        require(interval >= 1 minutes, "interval too short");

        planId = planCount++;
        plans[planId] = Plan({
            price: price,
            interval: interval,
            gracePeriod: gracePeriod,
            active: true
        });

        emit PlanCreated(planId, price, interval, gracePeriod);
    }

    function setPlanActive(uint256 planId, bool active) external onlyOwner {
        require(planId < planCount, "invalid plan");
        plans[planId].active = active;
        emit PlanUpdated(planId, active);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "treasury=0");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setKeeperRewardBps(uint256 bps) external onlyOwner {
        require(bps <= MAX_KEEPER_REWARD_BPS, "reward too high");
        keeperRewardBps = bps;
        emit KeeperRewardBpsUpdated(bps);
    }

    /**
     * @notice Circuit breaker. Menghentikan subscribe/chargeDue/retryCharge/
     *         payNow kalau ada insiden (bug, token bermasalah, dll).
     *         cancel() SENGAJA tetap jalan walau paused (lihat catatan di
     *         fungsi cancel) supaya user tetap bisa keluar kapan saja.
     */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Selamatkan token yang salah kirim langsung ke kontrak ini.
     *         paymentToken TIDAK PERNAH boleh diselamatkan lewat sini —
     *         kontrak ini secara desain tidak pernah menahan paymentToken
     *         (semua transfer langsung user -> treasury/keeper), jadi
     *         pengecualian ini murni safety rail, bukan asumsi ada dana
     *         subscriber yang "tersimpan" di sini.
     */
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(paymentToken), "cannot rescue payment token");
        require(to != address(0), "to=0");
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    // ---------------------------------------------------------------
    // User: subscribe / cancel
    // ---------------------------------------------------------------

    /**
     * @notice Konfirmasi awal subscription. User HARUS sudah approve()
     *         token ke contract ini sebelum/saat memanggil fungsi ini.
     *         Fungsi ini langsung menagih periode pertama supaya konsisten
     *         dengan siklus billing berikutnya.
     */
    function subscribe(uint256 planId) external nonReentrant whenNotPaused {
        require(planId < planCount, "invalid plan");
        Plan memory plan = plans[planId];
        require(plan.active, "plan not active");

        Subscription storage sub = subscriptions[msg.sender];
        require(sub.status != Status.Active && sub.status != Status.Overdue, "already subscribed");

        // Tarik pembayaran periode pertama langsung (di transaksi yang sama)
        paymentToken.safeTransferFrom(msg.sender, treasury, plan.price);

        sub.planId = planId;
        sub.status = Status.Active;
        // block.timestamp di sini jadi "titik nol" siklus; charge berikutnya
        // dihitung dari sini secara fixed-schedule (lihat chargeDue/retryCharge)
        sub.nextChargeAt = block.timestamp + plan.interval;
        sub.overdueSince = 0;
        sub.periodsPaid += 1;

        emit Subscribed(msg.sender, planId, sub.nextChargeAt);
        emit Charged(msg.sender, planId, plan.price, sub.nextChargeAt);
    }

    /**
     * @notice User batalkan subscription kapan saja. Tidak ada refund
     *         otomatis untuk periode berjalan (sesuaikan dengan kebijakanmu).
     * @dev Sengaja TIDAK whenNotPaused — user harus tetap bisa keluar
     *      (opt out) walaupun kontrak sedang di-pause karena insiden.
     */
    function cancel() external {
        Subscription storage sub = subscriptions[msg.sender];
        require(sub.status == Status.Active || sub.status == Status.Overdue, "not active");
        sub.status = Status.Inactive;
        emit Cancelled(msg.sender);
    }

    /**
     * @notice User yang statusnya Overdue bisa reaktivasi manual kalau mau
     *         bayar duluan sebelum keeper sempat charge ulang.
     */
    function payNow() external nonReentrant whenNotPaused {
        Subscription storage sub = subscriptions[msg.sender];
        require(sub.status == Status.Overdue, "not overdue");
        Plan memory plan = plans[sub.planId];

        paymentToken.safeTransferFrom(msg.sender, treasury, plan.price);

        sub.status = Status.Active;
        sub.overdueSince = 0;
        // Recovery path: reset dari waktu bayar (bukan nextChargeAt lama),
        // supaya user yang baru saja bayar tidak langsung dianggap due lagi
        // kalau overdue-nya sudah berlangsung lama.
        sub.nextChargeAt = block.timestamp + plan.interval;
        sub.periodsPaid += 1;

        emit Reactivated(msg.sender, sub.nextChargeAt);
        emit Charged(msg.sender, sub.planId, plan.price, sub.nextChargeAt);
    }

    // ---------------------------------------------------------------
    // Keeper: trigger charge bulanan
    // ---------------------------------------------------------------

    /**
     * @notice Dipanggil oleh keeper (bot/cron/Chainlink Automation/Gelato)
     *         saat subscription jatuh tempo. Siapa pun boleh memanggil ini
     *         (permissionless) — insentif kecil opsional lewat keeperRewardBps.
     */
    function chargeDue(address user) external nonReentrant whenNotPaused {
        Subscription storage sub = subscriptions[user];
        require(sub.status == Status.Active, "not active");
        require(block.timestamp >= sub.nextChargeAt, "not due yet");

        Plan memory plan = plans[sub.planId];

        uint256 allowance = paymentToken.allowance(user, address(this));
        uint256 balance = paymentToken.balanceOf(user);

        if (allowance < plan.price || balance < plan.price) {
            // Gagal charge -> masuk grace period, JANGAN revert supaya
            // keeper batch job tidak stuck di satu user yang gagal
            sub.status = Status.Overdue;
            sub.overdueSince = block.timestamp;
            emit ChargeFailed(user, sub.planId, allowance < plan.price ? "insufficient allowance" : "insufficient balance");
            emit MarkedOverdue(user, block.timestamp);
            return;
        }

        uint256 keeperReward = (plan.price * keeperRewardBps) / 10_000;
        uint256 amountToTreasury = plan.price - keeperReward;

        paymentToken.safeTransferFrom(user, treasury, amountToTreasury);
        if (keeperReward > 0) {
            paymentToken.safeTransferFrom(user, msg.sender, keeperReward);
        }

        // fixed-schedule: dari nextChargeAt sebelumnya, bukan dari waktu
        // keeper benar-benar trigger, supaya jadwal tidak drift kalau keeper telat
        sub.nextChargeAt = sub.nextChargeAt + plan.interval;
        sub.periodsPaid += 1;

        emit Charged(user, sub.planId, plan.price, sub.nextChargeAt);
    }

    /**
     * @notice Dipanggil keeper untuk user yang sudah Overdue melewati
     *         gracePeriod -> pindahkan ke Expired (akses dicabut).
     */
    function expireOverdue(address user) external {
        Subscription storage sub = subscriptions[user];
        require(sub.status == Status.Overdue, "not overdue");
        Plan memory plan = plans[sub.planId];

        require(
            block.timestamp >= sub.overdueSince + plan.gracePeriod,
            "grace period not passed"
        );

        sub.status = Status.Expired;
        emit Expired(user);
    }

    /**
     * @notice Coba charge ulang user yang Overdue (dipanggil keeper secara
     *         berkala selama masih dalam grace period).
     */
    function retryCharge(address user) external nonReentrant whenNotPaused {
        Subscription storage sub = subscriptions[user];
        require(sub.status == Status.Overdue, "not overdue");
        Plan memory plan = plans[sub.planId];

        uint256 allowance = paymentToken.allowance(user, address(this));
        uint256 balance = paymentToken.balanceOf(user);
        require(allowance >= plan.price && balance >= plan.price, "still insufficient");

        paymentToken.safeTransferFrom(user, treasury, plan.price);

        sub.status = Status.Active;
        sub.overdueSince = 0;
        // Recovery path, sama seperti payNow: reset dari waktu bayar
        sub.nextChargeAt = block.timestamp + plan.interval;
        sub.periodsPaid += 1;

        emit Reactivated(user, sub.nextChargeAt);
        emit Charged(user, sub.planId, plan.price, sub.nextChargeAt);
    }

    // ---------------------------------------------------------------
    // View helpers
    // ---------------------------------------------------------------

    function hasActiveAccess(address user) external view returns (bool) {
        Subscription memory sub = subscriptions[user];
        return sub.status == Status.Active || sub.status == Status.Overdue;
    }

    function isDue(address user) external view returns (bool) {
        Subscription memory sub = subscriptions[user];
        return sub.status == Status.Active && block.timestamp >= sub.nextChargeAt;
    }

    function getSubscription(address user) external view returns (Subscription memory) {
        return subscriptions[user];
    }
}
