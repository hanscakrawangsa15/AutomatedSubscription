import { CAMPAIGNS, type CampaignId } from "./pricingTiers";

// Which partner campaign (if any) this visitor belongs to.
//
//   cpay.xenorize.com/            normal prices      (visitors WITHOUT a referral)
//   cpay.xenorize.com/tokocrypto  discounted prices  (visitors WITH a Tokocrypto referral)
//
// The main Xenorize site marks a referred user by linking into the checkout
// with `?ref=tokocrypto`. That is remembered in localStorage so a returning
// visitor (or one who opens the bare URL later) is still routed to their own
// price page, and each visitor is bounced away from the other page.
//
// IMPORTANT: this separates what people SEE — it is not access control. The
// contract's discounted plans are public on-chain like every plan, so anyone
// who calls the contract directly can still take one. If the discount must be
// restricted, that needs a server-signed voucher checked by the contract.
const STORAGE_KEY = "xenorize_campaign";

function campaignFromValue(value: string | null | undefined): CampaignId | null {
  const v = value?.trim().toLowerCase();
  return v && v in CAMPAIGNS ? (v as CampaignId) : null;
}

function storedCampaign(): CampaignId | null {
  try {
    return campaignFromValue(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null; // storage blocked (private mode etc.) — URL param still works
  }
}

/** Campaign named by the URL path (`/tokocrypto`), regardless of referral. */
export function campaignFromPath(pathname = window.location.pathname): CampaignId | null {
  return campaignFromValue(pathname.replace(/^\/+|\/+$/g, ""));
}

/** Referral from `?ref=` (remembered) or from an earlier visit. */
export function referralCampaign(): CampaignId | null {
  const fromUrl = campaignFromValue(new URLSearchParams(window.location.search).get("ref"));
  if (fromUrl) {
    try {
      window.localStorage.setItem(STORAGE_KEY, fromUrl);
    } catch {
      /* ignore */
    }
    return fromUrl;
  }
  return storedCampaign();
}

/**
 * Where this visitor must be sent before anything renders, or null if the
 * current URL is already right. Query string is preserved (email, source…).
 */
export function campaignRedirect(): string | null {
  const here = campaignFromPath();
  const referral = referralCampaign();
  const search = window.location.search;
  if (here && referral !== here) return `/${search}`; // no referral -> normal prices
  if (!here && window.location.pathname === "/" && referral) return `/${referral}${search}`;
  return null;
}
