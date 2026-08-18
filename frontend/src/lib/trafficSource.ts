// Reads the `source` URL query param (e.g. ?source=twitter-ad) — this app
// never changes the URL client-side (no router, single page), so the param
// set on first load is still there whenever this is called later in the
// flow, no need to persist it to sessionStorage separately.
export function getTrafficSource(): string | null {
  return new URLSearchParams(window.location.search).get("source");
}

// Reads the `email` URL query param (e.g.
// https://cpay.xenorize.com/?email=user@example.com&source=stg) — set by
// the main Xenorize site when it links a logged-in user into this checkout,
// so the renewal-receipt email can be pre-filled instead of asking them to
// retype an address they already gave the main site.
export function getEmailFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("email");
}
