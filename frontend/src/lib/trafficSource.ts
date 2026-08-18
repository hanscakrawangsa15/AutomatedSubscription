// Reads the `source` URL query param (e.g. ?source=twitter-ad) — this app
// never changes the URL client-side (no router, single page), so the param
// set on first load is still there whenever this is called later in the
// flow, no need to persist it to sessionStorage separately.
export function getTrafficSource(): string | null {
  return new URLSearchParams(window.location.search).get("source");
}
