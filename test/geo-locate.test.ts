/** locate() resolved before the browser answered, so a field visit never captured where it was (UI1-01). */
import { describe, it, expect } from 'vitest'
import { locate } from '../web/src/geo.ts'

describe('locate', () => {
  it('waits for the browser and returns the fix', async () => {
    const fake = { getCurrentPosition: (ok: PositionCallback) => { setTimeout(() => ok({ coords: { latitude: 17.4, longitude: 78.4 } } as GeolocationPosition), 30) } }
    expect(await locate(fake)).toEqual({ lat: 17.4, lng: 78.4 })
  })
  it('returns undefined when refused', async () => {
    const fake = { getCurrentPosition: (_: PositionCallback, fail?: PositionErrorCallback | null) => { fail?.({} as GeolocationPositionError) } }
    expect(await locate(fake)).toBeUndefined()
  })
  it('returns undefined when there is no geolocation at all', async () => {
    expect(await locate(undefined)).toBeUndefined()
  })
})
