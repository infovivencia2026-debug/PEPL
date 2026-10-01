export interface Fix { lat: number; lng: number }

/**
 * One location fix, or undefined when there is none. Resolves exactly once: with the fix when the
 * browser delivers it, or with undefined when it refuses, times out, or does not exist.
 *
 * It used to read `geolocation?.getCurrentPosition(ok, fail) ?? resolve(undefined)`.
 * getCurrentPosition returns nothing, so `??` ALWAYS ran the right side and resolved with no
 * location before the browser had answered: a field visit never recorded where it was.
 */
export function locate(
  geolocation: Pick<Geolocation, 'getCurrentPosition'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.geolocation,
): Promise<Fix | undefined> {
  return new Promise((resolve) => {
    if (!geolocation) { resolve(undefined); return }
    geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 8000 },
    )
  })
}
