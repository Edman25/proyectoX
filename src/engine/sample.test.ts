import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAYBACK, newId, type AssetId, type SliceId } from '../model'
import { LruRenderCache, renderKeyString, type RenderKey } from './renderCache'
import { ReverseCache, combinePlayback, effectiveFades, makeRegion, resolveSampleRef } from './sample'
import { assetFor, bufferOf, dc, offlineContext } from './testing'
import { velocityToGain } from './util'

describe('resolveSampleRef', () => {
  const ctx = offlineContext(0.01)
  const asset = assetFor(dc(ctx, 1000))
  const sliceId = newId<SliceId>()
  asset.slices = [
    { id: sliceId, start: 100, end: 400, playback: { ...DEFAULT_PLAYBACK, gainDb: -3, reverse: true, pitch: 2 } },
  ]
  const assets = { [asset.id]: asset }

  it('asset completo', () => {
    expect(resolveSampleRef(assets, { kind: 'asset', assetId: asset.id })).toEqual({
      assetId: asset.id,
      start: 0,
      end: 1000,
      playback: DEFAULT_PLAYBACK,
    })
  })

  it('slice: usa sus marcadores y suma sus ajustes a los de quien lo usa', () => {
    const extra = { ...DEFAULT_PLAYBACK, gainDb: -2, pitch: -5, reverse: true, fadeOutMs: 20 }
    const r = resolveSampleRef(assets, { kind: 'slice', assetId: asset.id, sliceId }, extra)
    expect(r).toMatchObject({ start: 100, end: 400 })
    // Dos reversas se cancelan.
    expect(r!.playback).toEqual({ gainDb: -5, pitch: -3, reverse: false, fadeInMs: 0, fadeOutMs: 20 })
  })

  it('range: se recorta al tamaño del asset', () => {
    const r = resolveSampleRef(assets, { kind: 'range', assetId: asset.id, start: -5, end: 5000 })
    expect(r).toMatchObject({ start: 0, end: 1000 })
  })

  it('null si falta algo o el rango está vacío', () => {
    expect(resolveSampleRef(assets, null)).toBeNull()
    expect(resolveSampleRef(assets, { kind: 'asset', assetId: newId<AssetId>() })).toBeNull()
    expect(
      resolveSampleRef(assets, { kind: 'slice', assetId: asset.id, sliceId: newId<SliceId>() }),
    ).toBeNull()
    expect(resolveSampleRef(assets, { kind: 'range', assetId: asset.id, start: 50, end: 50 })).toBeNull()
  })

  it('combinePlayback es neutro con DEFAULT_PLAYBACK', () => {
    const p = { gainDb: 1, pitch: 2, reverse: true, fadeInMs: 3, fadeOutMs: 4 }
    expect(combinePlayback(p, DEFAULT_PLAYBACK)).toEqual(p)
  })
})

describe('regiones y reversa', () => {
  const ctx = offlineContext(0.01)
  const buffer = bufferOf(ctx, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  const cache = new ReverseCache()

  it('la reversa se cachea y el rango se refleja', () => {
    const region = makeRegion(ctx, cache, buffer, 2, 5, true)!
    expect(region.buffer).toBe(cache.get(ctx, buffer))
    const played = region.buffer.getChannelData(0).slice(region.startFrame, region.endFrame)
    expect([...played]).toEqual([4, 3, 2])
  })

  it('micro-fade solo en los bordes que son cortes dentro del audio', () => {
    const whole = makeRegion(ctx, cache, buffer, 0, 10, false)!
    expect(effectiveFades(whole, DEFAULT_PLAYBACK)).toEqual({ fadeInSec: 0, fadeOutSec: 0 })
    const head = makeRegion(ctx, cache, buffer, 0, 5, false)!
    expect(effectiveFades(head, DEFAULT_PLAYBACK)).toEqual({ fadeInSec: 0, fadeOutSec: 0.002 })
    // En reversa los bordes se intercambian.
    const reversed = makeRegion(ctx, cache, buffer, 0, 5, true)!
    expect(effectiveFades(reversed, DEFAULT_PLAYBACK)).toEqual({ fadeInSec: 0.002, fadeOutSec: 0 })
    expect(effectiveFades(head, { ...DEFAULT_PLAYBACK, fadeOutMs: 50 }).fadeOutSec).toBe(0.05)
  })
})

describe('caché de renders (LRU)', () => {
  const ctx = offlineContext(0.01)
  const assetId = newId<AssetId>()
  const key = (semitones: number): RenderKey => ({
    assetId,
    start: 0,
    end: 100,
    stretchRatio: 1,
    semitones,
    mode: 'preserve',
  })

  it('la clave distingue cada parámetro y redondea el ruido numérico', () => {
    expect(renderKeyString(key(1))).not.toBe(renderKeyString(key(2)))
    expect(renderKeyString({ ...key(1), stretchRatio: 1.50000001 })).toBe(
      renderKeyString({ ...key(1), stretchRatio: 1.5 }),
    )
    expect(renderKeyString({ ...key(1), mode: 'resample' })).not.toBe(renderKeyString(key(1)))
  })

  it('al pasar el límite de memoria saca el que lleva más tiempo sin usarse', () => {
    // Cada buffer mono de 1000 frames pesa 4000 bytes.
    const cache = new LruRenderCache({ maxBytes: 10000 })
    cache.set(key(1), dc(ctx, 1000))
    cache.set(key(2), dc(ctx, 1000))
    expect(cache.bytes).toBe(8000)
    cache.get(key(1)) // el 1 pasa a ser el más reciente
    cache.set(key(3), dc(ctx, 1000))
    expect(cache.has(key(1))).toBe(true)
    expect(cache.has(key(2))).toBe(false)
    expect(cache.has(key(3))).toBe(true)
    expect(cache.bytes).toBe(8000)
    cache.deleteAsset(assetId)
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  it('request pide el render al provider una sola vez y lo guarda', async () => {
    const source = dc(ctx, 100)
    let calls = 0
    const ready: number[] = []
    const cache = new LruRenderCache({
      maxBytes: 1e6,
      buffers: { getBuffer: () => source },
      provider: {
        render: async () => {
          calls++
          return dc(ctx, 50)
        },
      },
      onReady: (k) => ready.push(k.semitones),
    })
    expect(cache.get(key(7))).toBeUndefined()
    cache.request(key(7))
    cache.request(key(7))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    expect(cache.get(key(7))?.length).toBe(50)
    expect(ready).toEqual([7])
  })
})

describe('velocity', () => {
  it('127 es ganancia 1 y la curva es monótona', () => {
    expect(velocityToGain(127)).toBe(1)
    expect(velocityToGain(64)).toBeCloseTo(0.254, 3)
    expect(velocityToGain(1)).toBeGreaterThan(0)
    expect(velocityToGain(0)).toBe(velocityToGain(1))
  })
})
