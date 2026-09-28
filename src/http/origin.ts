/**
 * Which hosts this server answers to, for the same-origin check on writes.
 *
 * Comparing the browser's `Origin` against the `Host` header alone was wrong
 * behind a proxy, and it broke every sign-in in production: OpenLiteSpeed
 * rewrites Host to the backend address, so `Origin: https://pepl.onrol.in` was
 * compared against `127.0.0.1:4010` and every POST came back "Request origin
 * is not allowed" -- the login included.
 *
 * `PEPL_PUBLIC_URL` is the authoritative entry because it is CONFIGURATION: a
 * request cannot influence it. The forwarded and direct hosts are accepted too,
 * so a dev box and an unproxied hit still work.
 *
 * This is a same-origin check on state-changing requests, NOT an authorisation
 * boundary. What authorises is the session token; spoofing a header does not
 * produce one.
 */
export const allowedHosts = (
  headers: { host?: string | undefined; 'x-forwarded-host'?: string | string[] | undefined },
  publicUrl: string | undefined = process.env.PEPL_PUBLIC_URL,
): Set<string> => {
  const hosts = new Set<string>()
  if (publicUrl) {
    try {
      hosts.add(new URL(publicUrl).host)
    } catch {
      // Misconfigured. The other entries still apply, so a typo in the env
      // degrades to the old behaviour rather than locking everyone out.
    }
  }
  const forwardedRaw = headers['x-forwarded-host']
  const forwarded = (Array.isArray(forwardedRaw) ? forwardedRaw[0] : forwardedRaw)?.split(',')[0]?.trim()
  if (forwarded) hosts.add(forwarded)
  if (headers.host) hosts.add(headers.host)
  return hosts
}

/** True when a write may proceed. A request with no Origin at all is not a browser form post. */
export const originAllowed = (
  origin: string | undefined,
  headers: { host?: string | undefined; 'x-forwarded-host'?: string | string[] | undefined },
  publicUrl?: string,
): boolean => {
  if (!origin) return true
  try {
    return allowedHosts(headers, publicUrl).has(new URL(origin).host)
  } catch {
    // An unparseable Origin is not something a browser sends.
    return false
  }
}
