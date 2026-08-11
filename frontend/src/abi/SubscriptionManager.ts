export const SUBSCRIPTION_MANAGER_ABI = [
  "function owner() view returns (address)",
  "function paymentToken() view returns (address)",
  "function treasury() view returns (address)",
  "function keeperRewardBps() view returns (uint256)",
  "function planCount() view returns (uint256)",
  "function plans(uint256) view returns (uint256 price, uint256 interval, uint256 gracePeriod, bool active)",
  "function subscriptions(address) view returns (uint256 planId, uint8 status, uint256 nextChargeAt, uint256 overdueSince, uint256 periodsPaid)",
  "function hasActiveAccess(address user) view returns (bool)",
  "function isDue(address user) view returns (bool)",

  "function createPlan(uint256 price, uint256 interval, uint256 gracePeriod) returns (uint256 planId)",
  "function setPlanActive(uint256 planId, bool active)",
  "function setTreasury(address _treasury)",
  "function setKeeperRewardBps(uint256 bps)",

  "function subscribe(uint256 planId)",
  "function cancel()",
  "function payNow()",
  "function chargeDue(address user)",
  "function expireOverdue(address user)",
  "function retryCharge(address user)",

  "event PlanCreated(uint256 indexed planId, uint256 price, uint256 interval, uint256 gracePeriod)",
  "event PlanUpdated(uint256 indexed planId, bool active)",
  "event Subscribed(address indexed user, uint256 indexed planId, uint256 nextChargeAt)",
  "event Charged(address indexed user, uint256 indexed planId, uint256 amount, uint256 nextChargeAt)",
  "event ChargeFailed(address indexed user, uint256 indexed planId, string reason)",
  "event MarkedOverdue(address indexed user, uint256 overdueSince)",
  "event Expired(address indexed user)",
  "event Cancelled(address indexed user)",
  "event Reactivated(address indexed user, uint256 nextChargeAt)",
];

export const SUBSCRIPTION_STATUS = ["Inactive", "Active", "Overdue", "Expired"] as const;
