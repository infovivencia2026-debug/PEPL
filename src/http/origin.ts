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
  // Once PEPL_PUBLIC_URL is configured it is the answer, and the forwarded
  // header stops being consulted at all: a header the caller can set should
  // not widen the check when configuration already states the truth.
  if (hosts.size > 0) {
    if (headers.host) hosts.add(headers.host)
    return hosts
  }
  const forwardedRaw = headers['x-forwarded-host']
  const forwarded = (Array.isArray(forwardedRaw) ? forwardedRaw[0] : forwardedRaw)?.split(',')[0]?.trim()
  if (forwarded) hosts.add(forwarded)
  if (headers.host) hosts.add(headers.host)
  return hosts
}

/**
 * True when a write may proceed. A request with no Origin at all is not a
 * browser form post.
 *
 * Origin can arrive REPEATED: OpenLiteSpeed forwards it twice, and Node joins
 * duplicate headers with ", ", so the value is
 * "https://pepl.onrol.in, https://pepl.onrol.in". Passing that to `new URL()`
 * throws, which refused every write in production -- the login included.
 *
 * Every value must be allowed, not merely the first. Accepting the first would
 * let a caller prepend a permitted origin to their own and walk through.
 */
export const originAllowed = (
  origin: string | undefined,
  headers: { host?: string | undefined; 'x-forwarded-host'?: string | string[] | undefined },
  publicUrl?: string,
): boolean => {
  if (!origin) return true
  const values = origin.split(',').map((v) => v.trim()).filter(Boolean)
  if (!values.length) return false
  const allowed = allowedHosts(headers, publicUrl)
  return values.every((value) => {
    try {
      return allowed.has(new URL(value).host)
    } catch {
      // An unparseable Origin is not something a browser sends.
      return false
    }
  })
}
