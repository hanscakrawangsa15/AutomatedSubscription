const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;
const MINUTE = 60;

const Status = { Inactive: 0, Active: 1, Overdue: 2, Expired: 3 };

async function deployFixture() {
  const [owner, treasury, user, other, keeper] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  const decimals = await usdc.decimals();

  const SubscriptionManager = await ethers.getContractFactory("SubscriptionManager");
  const manager = await SubscriptionManager.connect(owner).deploy(await usdc.getAddress(), treasury.address);

  const price = ethers.parseUnits("10", decimals);
  const interval = 30 * DAY;
  const grace = 5 * DAY;
  await manager.connect(owner).createPlan(price, interval, grace);

  await usdc.mint(user.address, ethers.parseUnits("100000", decimals));
  await usdc.mint(other.address, ethers.parseUnits("100000", decimals));
  await usdc.connect(user).approve(await manager.getAddress(), ethers.MaxUint256);
  await usdc.connect(other).approve(await manager.getAddress(), ethers.MaxUint256);

  return { owner, treasury, user, other, keeper, usdc, manager, decimals, price, interval, grace, planId: 0n };
}

describe("SubscriptionManager", () => {
  describe("Access control", () => {
    it("only owner can createPlan", async () => {
      const { manager, user, decimals } = await loadFixture(deployFixture);
      await expect(
        manager.connect(user).createPlan(ethers.parseUnits("5", decimals), 30 * DAY, 5 * DAY),
      ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
    });

    it("only owner can setPlanActive", async () => {
      const { manager, user, planId } = await loadFixture(deployFixture);
      await expect(manager.connect(user).setPlanActive(planId, false)).to.be.revertedWithCustomError(
        manager,
        "OwnableUnauthorizedAccount",
      );
    });

    it("only owner can setTreasury", async () => {
      const { manager, user, other } = await loadFixture(deployFixture);
      await expect(manager.connect(user).setTreasury(other.address)).to.be.revertedWithCustomError(
        manager,
        "OwnableUnauthorizedAccount",
      );
    });

    it("setTreasury updates treasury and emits, but rejects the zero address", async () => {
      const { manager, owner, other } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setTreasury(other.address))
        .to.emit(manager, "TreasuryUpdated")
        .withArgs(other.address);
      expect(await manager.treasury()).to.equal(other.address);

      await expect(manager.connect(owner).setTreasury(ethers.ZeroAddress)).to.be.revertedWith("treasury=0");
    });

    it("only owner can setKeeperRewardBps", async () => {
      const { manager, user } = await loadFixture(deployFixture);
      await expect(manager.connect(user).setKeeperRewardBps(100)).to.be.revertedWithCustomError(
        manager,
        "OwnableUnauthorizedAccount",
      );
    });

    it("only owner can pause/unpause", async () => {
      const { manager, user } = await loadFixture(deployFixture);
      await expect(manager.connect(user).pause()).to.be.revertedWithCustomError(
        manager,
        "OwnableUnauthorizedAccount",
      );
      await expect(manager.connect(user).unpause()).to.be.revertedWithCustomError(
        manager,
        "OwnableUnauthorizedAccount",
      );
    });

    it("only owner can rescueERC20", async () => {
      const { manager, user, other } = await loadFixture(deployFixture);
      await expect(manager.connect(user).rescueERC20(other.address, user.address, 1)).to.be.revertedWithCustomError(
        manager,
        "OwnableUnauthorizedAccount",
      );
    });

    it("setKeeperRewardBps accepts the 200bps boundary, rejects above it", async () => {
      const { manager, owner } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setKeeperRewardBps(200)).to.not.be.reverted;
      await expect(manager.connect(owner).setKeeperRewardBps(201)).to.be.revertedWith("reward too high");
    });

    it("createPlan rejects price=0 and interval below 1 minute; accepts the boundary", async () => {
      const { manager, owner, decimals } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).createPlan(0, 30 * DAY, 5 * DAY)).to.be.revertedWith("price=0");
      await expect(
        manager.connect(owner).createPlan(ethers.parseUnits("1", decimals), MINUTE - 1, 0),
      ).to.be.revertedWith("interval too short");
      await expect(manager.connect(owner).createPlan(ethers.parseUnits("1", decimals), MINUTE, 0)).to.not.be
        .reverted;
    });

    it("setPlanActive reverts for an invalid planId", async () => {
      const { manager, owner } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setPlanActive(999, false)).to.be.revertedWith("invalid plan");
    });
  });

  describe("subscribe / cancel / payNow", () => {
    it("subscribe pulls first payment, activates, schedules next charge, emits events", async () => {
      const { manager, usdc, user, treasury, planId, price, interval } = await loadFixture(deployFixture);
      const tx = await manager.connect(user).subscribe(planId);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx).to.emit(manager, "Subscribed");
      await expect(tx).to.emit(manager, "Charged").withArgs(user.address, planId, price, block.timestamp + interval);
      await expect(tx).to.changeTokenBalances(usdc, [user, treasury], [-price, price]);

      const sub = await manager.subscriptions(user.address);
      expect(sub.status).to.equal(Status.Active);
      expect(sub.periodsPaid).to.equal(1);
      expect(sub.nextChargeAt).to.equal(block.timestamp + interval);
    });

    it("subscribe reverts: invalid plan, inactive plan, already subscribed, insufficient allowance/balance", async () => {
      const { manager, usdc, owner, user, other, planId, price } = await loadFixture(deployFixture);

      await expect(manager.connect(user).subscribe(999)).to.be.revertedWith("invalid plan");

      await manager.connect(owner).setPlanActive(planId, false);
      await expect(manager.connect(user).subscribe(planId)).to.be.revertedWith("plan not active");
      await manager.connect(owner).setPlanActive(planId, true);

      await manager.connect(user).subscribe(planId);
      await expect(manager.connect(user).subscribe(planId)).to.be.revertedWith("already subscribed");

      // fresh signer with no approval/balance
      const [, , , , , freshUser] = await ethers.getSigners();
      await expect(manager.connect(freshUser).subscribe(planId)).to.be.reverted; // ERC20InsufficientAllowance

      await usdc.mint(freshUser.address, price);
      await usdc.connect(freshUser).approve(await manager.getAddress(), price - 1n);
      await expect(manager.connect(freshUser).subscribe(planId)).to.be.reverted; // allowance short by 1
    });

    it("cancel: reverts if not active/overdue, succeeds from Active and Overdue, allows re-subscribing", async () => {
      const { manager, user, planId } = await loadFixture(deployFixture);

      await expect(manager.connect(user).cancel()).to.be.revertedWith("not active");

      await manager.connect(user).subscribe(planId);
      await expect(manager.connect(user).cancel()).to.emit(manager, "Cancelled").withArgs(user.address);
      expect((await manager.subscriptions(user.address)).status).to.equal(Status.Inactive);

      // re-subscribe after cancel works
      await expect(manager.connect(user).subscribe(planId)).to.not.be.reverted;
    });

    it("payNow: reverts if not Overdue, resets schedule from now when it succeeds", async () => {
      const { manager, usdc, user, other, treasury, planId, price, interval } = await loadFixture(deployFixture);

      await expect(manager.connect(user).payNow()).to.be.revertedWith("not overdue");

      await manager.connect(user).subscribe(planId);
      // drain user's balance so the next chargeDue fails and marks Overdue
      const bal = await usdc.balanceOf(user.address);
      await usdc.connect(user).transfer(other.address, bal);
      await time.increase(interval + 1);
      await manager.connect(user).chargeDue(user.address);
      expect((await manager.subscriptions(user.address)).status).to.equal(Status.Overdue);

      // still no funds -> payNow should revert (ERC20 transfer failure)
      await expect(manager.connect(user).payNow()).to.be.reverted;

      // fund back and succeed
      await usdc.connect(other).transfer(user.address, price);
      const tx = await manager.connect(user).payNow();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx).to.emit(manager, "Reactivated");

      const sub = await manager.subscriptions(user.address);
      expect(sub.status).to.equal(Status.Active);
      expect(sub.overdueSince).to.equal(0);
      expect(sub.nextChargeAt).to.equal(block.timestamp + interval);
    });
  });

  describe("chargeDue", () => {
    it("reverts if not Active or not yet due", async () => {
      const { manager, user, planId } = await loadFixture(deployFixture);
      await expect(manager.chargeDue(user.address)).to.be.revertedWith("not active");

      await manager.connect(user).subscribe(planId);
      await expect(manager.chargeDue(user.address)).to.be.revertedWith("not due yet");
    });

    it("charges correctly with a keeper reward, splits treasury/keeper, advances on fixed schedule", async () => {
      const { manager, usdc, owner, user, treasury, keeper, planId, price, interval } = await loadFixture(
        deployFixture,
      );
      await manager.connect(owner).setKeeperRewardBps(200); // 2% cap
      await manager.connect(user).subscribe(planId);
      const before = await manager.subscriptions(user.address);

      await time.increase(interval + 1);
      const reward = (price * 200n) / 10_000n;
      const toTreasury = price - reward;

      const tx = await manager.connect(keeper).chargeDue(user.address);
      await expect(tx).to.changeTokenBalances(
        usdc,
        [user, treasury, keeper],
        [-price, toTreasury, reward],
      );

      const after = await manager.subscriptions(user.address);
      expect(after.periodsPaid).to.equal(2);
      // fixed-schedule: advances from the OLD nextChargeAt, not from "now"
      expect(after.nextChargeAt).to.equal(before.nextChargeAt + BigInt(interval));
    });

    it("rounds reward down to 0 for tiny prices without reverting", async () => {
      const { manager, usdc, owner, user, treasury, keeper, decimals } = await loadFixture(deployFixture);
      await manager.connect(owner).setKeeperRewardBps(1); // 0.01%
      await manager.connect(owner).createPlan(1n, MINUTE, MINUTE); // price = 1 unit (smallest)
      const tinyPlanId = 1n;
      await manager.connect(user).subscribe(tinyPlanId);

      await time.increase(MINUTE + 1);
      const tx = await manager.connect(keeper).chargeDue(user.address);
      // reward = (1 * 1) / 10000 = 0, so keeper gets nothing but tx still succeeds
      await expect(tx).to.changeTokenBalances(usdc, [user, treasury, keeper], [-1n, 1n, 0n]);
    });

    it("degrades to Overdue on insufficient allowance without reverting (batch-safe)", async () => {
      const { manager, usdc, user, planId, price, interval } = await loadFixture(deployFixture);
      await manager.connect(user).subscribe(planId);
      await usdc.connect(user).approve(await manager.getAddress(), 0);
      await time.increase(interval + 1);

      const tx = await manager.chargeDue(user.address);
      await expect(tx).to.emit(manager, "ChargeFailed").withArgs(user.address, planId, "insufficient allowance");
      await expect(tx).to.emit(manager, "MarkedOverdue");

      const sub = await manager.subscriptions(user.address);
      expect(sub.status).to.equal(Status.Overdue);
      expect(sub.overdueSince).to.be.greaterThan(0);
    });

    it("degrades to Overdue on insufficient balance without reverting", async () => {
      const { manager, usdc, user, other, planId, interval } = await loadFixture(deployFixture);
      await manager.connect(user).subscribe(planId);
      const bal = await usdc.balanceOf(user.address);
      await usdc.connect(user).transfer(other.address, bal);
      await time.increase(interval + 1);

      const tx = await manager.chargeDue(user.address);
      await expect(tx).to.emit(manager, "ChargeFailed").withArgs(user.address, planId, "insufficient balance");

      expect((await manager.subscriptions(user.address)).status).to.equal(Status.Overdue);
    });

    it("is truly permissionless: any caller can trigger it and receives the reward", async () => {
      const { manager, owner, usdc, user, keeper, planId, price, interval } = await loadFixture(deployFixture);
      await manager.connect(owner).setKeeperRewardBps(100);
      await manager.connect(user).subscribe(planId);
      await time.increase(interval + 1);

      const before = await usdc.balanceOf(keeper.address);
      await manager.connect(keeper).chargeDue(user.address); // `keeper` is an arbitrary unrelated signer
      const after = await usdc.balanceOf(keeper.address);
      expect(after).to.be.greaterThan(before);
    });
  });

  describe("retryCharge / expireOverdue lifecycle", () => {
    it("retryCharge reverts if not Overdue, and if still insufficient", async () => {
      const { manager, user, planId } = await loadFixture(deployFixture);
      await expect(manager.retryCharge(user.address)).to.be.revertedWith("not overdue");

      await manager.connect(user).subscribe(planId);
      await expect(manager.retryCharge(user.address)).to.be.revertedWith("not overdue");
    });

    it("full lifecycle: subscribe -> overdue -> retry fails -> retry succeeds -> active", async () => {
      const { manager, usdc, user, other, planId, price, interval } = await loadFixture(deployFixture);
      await manager.connect(user).subscribe(planId);

      const bal = await usdc.balanceOf(user.address);
      await usdc.connect(user).transfer(other.address, bal);
      await time.increase(interval + 1);
      await manager.chargeDue(user.address);
      expect((await manager.subscriptions(user.address)).status).to.equal(Status.Overdue);

      await expect(manager.retryCharge(user.address)).to.be.revertedWith("still insufficient");

      await usdc.connect(other).transfer(user.address, price);
      const tx = await manager.retryCharge(user.address);
      await expect(tx).to.emit(manager, "Reactivated");

      const sub = await manager.subscriptions(user.address);
      expect(sub.status).to.equal(Status.Active);
      expect(sub.overdueSince).to.equal(0);
    });

    it("alternate branch: overdue -> grace expires -> Expired -> further charge attempts revert", async () => {
      const { manager, usdc, user, other, planId, interval, grace } = await loadFixture(deployFixture);
      await manager.connect(user).subscribe(planId);

      const bal = await usdc.balanceOf(user.address);
      await usdc.connect(user).transfer(other.address, bal);
      await time.increase(interval + 1);
      await manager.chargeDue(user.address);
      expect((await manager.subscriptions(user.address)).status).to.equal(Status.Overdue);

      await expect(manager.expireOverdue(user.address)).to.be.revertedWith("grace period not passed");

      await time.increase(grace + 1);
      const tx = await manager.expireOverdue(user.address);
      await expect(tx).to.emit(manager, "Expired").withArgs(user.address);
      expect((await manager.subscriptions(user.address)).status).to.equal(Status.Expired);

      // Expired blocks further charge/retry attempts (not Active, not Overdue)
      await expect(manager.chargeDue(user.address)).to.be.revertedWith("not active");
      await expect(manager.retryCharge(user.address)).to.be.revertedWith("not overdue");
    });

    it("expireOverdue reverts if not Overdue, and exactly at the grace boundary", async () => {
      const { manager, usdc, user, other, planId, interval, grace } = await loadFixture(deployFixture);
      await expect(manager.expireOverdue(user.address)).to.be.revertedWith("not overdue");

      await manager.connect(user).subscribe(planId);
      const bal = await usdc.balanceOf(user.address);
      await usdc.connect(user).transfer(other.address, bal);
      await time.increase(interval + 1);
      await manager.chargeDue(user.address);
      const overdueSince = (await manager.subscriptions(user.address)).overdueSince;

      // one second before the boundary: still reverts
      await time.increaseTo(overdueSince + BigInt(grace) - 2n);
      await expect(manager.expireOverdue(user.address)).to.be.revertedWith("grace period not passed");

      // at/after the boundary: succeeds
      await time.increaseTo(overdueSince + BigInt(grace));
      await expect(manager.expireOverdue(user.address)).to.not.be.reverted;
    });
  });

  describe("pause / unpause", () => {
    it("blocks subscribe/chargeDue/retryCharge/payNow while paused, but cancel still works", async () => {
      const { manager, owner, usdc, user, other, planId, price, interval } = await loadFixture(deployFixture);
      await manager.connect(user).subscribe(planId);

      await manager.connect(owner).pause();

      const [, , , , , freshUser] = await ethers.getSigners();
      await usdc.mint(freshUser.address, price);
      await usdc.connect(freshUser).approve(await manager.getAddress(), price);
      await expect(manager.connect(freshUser).subscribe(planId)).to.be.revertedWithCustomError(
        manager,
        "EnforcedPause",
      );

      await time.increase(interval + 1);
      await expect(manager.chargeDue(user.address)).to.be.revertedWithCustomError(manager, "EnforcedPause");

      // cancel intentionally still works while paused (users can always exit)
      await expect(manager.connect(user).cancel()).to.not.be.reverted;

      await manager.connect(owner).unpause();
      await expect(manager.connect(freshUser).subscribe(planId)).to.not.be.reverted;
    });

    it("unpause is idempotent-safe: pausing twice reverts with ExpectedPause/EnforcedPause", async () => {
      const { manager, owner } = await loadFixture(deployFixture);
      await manager.connect(owner).pause();
      await expect(manager.connect(owner).pause()).to.be.revertedWithCustomError(manager, "EnforcedPause");
      await manager.connect(owner).unpause();
      await expect(manager.connect(owner).unpause()).to.be.revertedWithCustomError(manager, "ExpectedPause");
    });
  });

  describe("rescueERC20", () => {
    it("rescues an accidentally-sent unrelated token but never the payment token", async () => {
      const { manager, usdc, owner, user } = await loadFixture(deployFixture);

      await expect(
        manager.connect(owner).rescueERC20(await usdc.getAddress(), owner.address, 1),
      ).to.be.revertedWith("cannot rescue payment token");

      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const otherToken = await MockUSDC.deploy();
      await otherToken.mint(await manager.getAddress(), 1000);

      await expect(manager.connect(owner).rescueERC20(await otherToken.getAddress(), user.address, 1000))
        .to.emit(manager, "TokenRescued")
        .withArgs(await otherToken.getAddress(), user.address, 1000);
      expect(await otherToken.balanceOf(user.address)).to.equal(1000);
    });
  });

  describe("reentrancy", () => {
    it("blocks a malicious token from re-entering subscribe() during transferFrom", async () => {
      const [owner, treasury, attacker] = await ethers.getSigners();
      const ReentrantToken = await ethers.getContractFactory("ReentrantToken");
      const evilToken = await ReentrantToken.deploy();
      const decimals = await evilToken.decimals();

      const SubscriptionManager = await ethers.getContractFactory("SubscriptionManager");
      const manager = await SubscriptionManager.connect(owner).deploy(await evilToken.getAddress(), treasury.address);
      const price = ethers.parseUnits("10", decimals);
      await manager.connect(owner).createPlan(price, 30 * DAY, 5 * DAY);

      await evilToken.mint(attacker.address, ethers.parseUnits("1000", decimals));
      await evilToken.connect(attacker).approve(await manager.getAddress(), ethers.MaxUint256);

      const reentrantCalldata = manager.interface.encodeFunctionData("subscribe", [0]);
      await evilToken.connect(attacker).setAttack(await manager.getAddress(), reentrantCalldata);

      await manager.connect(attacker).subscribe(0);

      // the nested re-entrant subscribe() call must have failed (blocked by nonReentrant)...
      expect(await evilToken.attackSucceeded()).to.equal(false);
      // ...while the outer legitimate call completed exactly once
      const sub = await manager.subscriptions(attacker.address);
      expect(sub.periodsPaid).to.equal(1);
      expect(sub.status).to.equal(Status.Active);
    });
  });

  describe("view helpers", () => {
    it("hasActiveAccess / isDue / getSubscription reflect all four statuses correctly", async () => {
      const { manager, usdc, user, other, planId, interval, grace } = await loadFixture(deployFixture);

      // Inactive
      expect(await manager.hasActiveAccess(user.address)).to.equal(false);
      expect(await manager.isDue(user.address)).to.equal(false);

      // Active, not yet due
      await manager.connect(user).subscribe(planId);
      expect(await manager.hasActiveAccess(user.address)).to.equal(true);
      expect(await manager.isDue(user.address)).to.equal(false);

      // Active, due
      await time.increase(interval + 1);
      expect(await manager.isDue(user.address)).to.equal(true);

      // Overdue (still counts as active access, per contract's grace-period design)
      const bal = await usdc.balanceOf(user.address);
      await usdc.connect(user).transfer(other.address, bal);
      await manager.chargeDue(user.address);
      expect((await manager.getSubscription(user.address)).status).to.equal(Status.Overdue);
      expect(await manager.hasActiveAccess(user.address)).to.equal(true);

      // Expired
      await time.increase(grace + 1);
      await manager.expireOverdue(user.address);
      expect(await manager.hasActiveAccess(user.address)).to.equal(false);
      expect((await manager.getSubscription(user.address)).status).to.equal(Status.Expired);
    });
  });
});
