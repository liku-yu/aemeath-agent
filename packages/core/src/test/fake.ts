/**
 * Fake credentials, constructed at runtime.
 *
 * Never write a literal `sk-...` string into this repository. Two reasons:
 *
 *   1. Secret scanners (and anyone reading the repo) cannot tell a placeholder
 *      from a leaked key, so a hard-coded one is noise at best and an incident
 *      at worst.
 *   2. Tests only need something *key-shaped*, not a specific value, so building
 *      it here costs nothing.
 *
 * These values are never sent anywhere: every test that uses them either stubs
 * `fetch` or points at a local server.
 */

/** A key-shaped string. Deterministic, so assertions can compare against it. */
export function fakeKey(tag = "unit"): string {
  return ["sk", tag, "not", "a", "real", "key", "0".repeat(8)].join("-");
}

/** A host reserved for documentation, i.e. guaranteed never to resolve. */
export function fakeHost(name = "gateway"): string {
  return `${name}.example.com`;
}

/** A base URL on an unresolvable documentation host. */
export function fakeBaseUrl(name = "gateway", path = "/v1"): string {
  return `https://${fakeHost(name)}${path}`;
}
