import { describe, expect, it } from 'vitest'
import { detectRootNote } from '../analysis/pitch'
import { prerenderSampler, samplerRenderKeys } from '../engine/prerender'
import { LruRenderCache, type RenderKey } from '../engine/renderCache'
import { ProjectBuilder, SR, bufferOf, offlineContext } from '../engine/testing'
import type { AssetId } from '../model'
import { handleStretchRequest, stretch, stretchedLength, type StretchRequest, type StretchResponse } from './stretchCore'
import { createStretchProvider, createWorkerRunner, type StretchRunner, type StretchWorkerLike } from './stretchProvider'

function sine(hz: number, seconds: number, sampleRate = SR, gain = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) out[i] = gain * Math.sin((2 * Math.PI * hz * i) / sampleRate)
  return out
}

/** Click corto (1 ms) que empieza en `at`. */
function click(at: number, length: number): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < 48; i++) out[at + i] = Math.sin((i / 48) * Math.PI) * Math.sin((2 * Math.PI * 4000 * i) / SR)
  return out
}

function peakIndex(data: Float32Array): number {
  let best = 0
  for (let i = 1; i < data.length; i++) if (Math.abs(data[i]!) > Math.abs(data[best]!)) best = i
  return best
}

function rms(data: Float32Array, from = 0, to = data.length): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += data[i]! ** 2
  return Math.sqrt(sum / (to - from))
}

/** Transporte sin Worker: el mismo núcleo, en el hilo del test. */
const inline: StretchRunner = (job) => stretch(job.channels, job.sampleRate, job)

describe('núcleo de stretch', () => {
  it('la duración sigue al ratio (±1 %)', async () => {
    const input = sine(220, 1.5)
    for (const ratio of [0.5, 0.8, 1.25, 2]) {
      const [out] = await stretch([input], SR, { stretchRatio: ratio, semitones: 0 })
      const expected = input.length / ratio
      expect(Math.abs(out!.length - expected) / expected).toBeLessThan(0.01)
      expect(out!.length).toBe(stretchedLength(input.length, ratio))
      // Suena hasta el final (no queda silencio de relleno) y sin cambiar de tono.
      expect(rms(out!, out!.length - 4800 - 2400, out!.length - 2400)).toBeGreaterThan(0.2)
      const note = detectRootNote(out!, SR)
      expect(note?.midi).toBe(57)
      expect(Math.abs(note!.cents)).toBeLessThan(15)
    }
  })

  it('transpone N semitonos (±15 cents) sin cambiar la duración', async () => {
    const input = sine(220, 1) // A3 = 57
    for (const semitones of [-12, -5, 3, 7, 12]) {
      const [out] = await stretch([input], SR, { stretchRatio: 1, semitones })
      expect(out!.length).toBe(input.length)
      const note = detectRootNote(out!, SR)
      expect(note).not.toBeNull()
      const cents = (note!.midi - (57 + semitones)) * 100 + note!.cents
      expect(Math.abs(cents)).toBeLessThan(15)
      expect(rms(out!, 4800, out!.length - 4800)).toBeGreaterThan(0.25)
    }
  })

  it('un click al inicio queda alineado (±5 ms): la latencia está compensada', async () => {
    const tolerance = 0.005 * SR
    for (const at of [0, 12000]) {
      const input = click(at, SR)
      const expectedAt = peakIndex(input)
      for (const params of [
        { stretchRatio: 1, semitones: 3 },
        { stretchRatio: 1, semitones: -7 },
        { stretchRatio: 0.8, semitones: 0 },
        { stretchRatio: 1.5, semitones: 0 },
        { stretchRatio: 1.25, semitones: 2 },
      ]) {
        const [out] = await stretch([input], SR, params)
        expect(Math.abs(peakIndex(out!) - expectedAt / params.stretchRatio)).toBeLessThan(tolerance)
      }
    }
  })

  it('sin cambios devuelve una copia exacta, y no toca la entrada', async () => {
    const input = sine(330, 0.2)
    const before = Float32Array.from(input)
    const [same] = await stretch([input], SR, { stretchRatio: 1, semitones: 0 })
    expect(same).not.toBe(input)
    expect(same).toEqual(before)
    await stretch([input], SR, { stretchRatio: 1.3, semitones: 4 })
    expect(input).toEqual(before)
  })

  it('estéreo: cada canal conserva lo suyo', async () => {
    const left = sine(220, 0.5)
    const right = new Float32Array(left.length)
    const out = await stretch([left, right], SR, { stretchRatio: 1, semitones: 5 })
    expect(out).toHaveLength(2)
    expect(rms(out[0]!)).toBeGreaterThan(0.2)
    expect(rms(out[1]!)).toBeLessThan(0.01)
  })

  it('rechaza parámetros sin sentido', async () => {
    await expect(stretch([sine(220, 0.1)], SR, { stretchRatio: 0, semitones: 0 })).rejects.toThrow()
    await expect(stretch([sine(220, 0.1)], SR, { stretchRatio: 1, semitones: NaN })).rejects.toThrow()
  })
})

/** Worker falso: mismo protocolo que el real, y anota qué se transfirió. */
class FakeWorker implements StretchWorkerLike {
  onmessage: ((event: { data: StretchResponse }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  transfers: Transferable[][] = []
  terminated = false

  postMessage(message: StretchRequest, transfer: Transferable[]): void {
    this.transfers.push(transfer)
    void handleStretchRequest(message).then(({ message: response }) => this.onmessage?.({ data: response }))
  }

  terminate(): void {
    this.terminated = true
  }
}

describe('transporte por Worker', () => {
  it('manda los buffers transferidos y resuelve con el resultado', async () => {
    const worker = new FakeWorker()
    let created = 0
    const runner = createWorkerRunner(() => {
      created++
      return worker
    })
    const a = sine(220, 0.3)
    const b = sine(220, 0.3)
    const [first, second] = await Promise.all([
      runner.run({ channels: [a], sampleRate: SR, stretchRatio: 2, semitones: 0 }),
      runner.run({ channels: [b], sampleRate: SR, stretchRatio: 1, semitones: 12 }),
    ])
    expect(created).toBe(1)
    expect(worker.transfers[0]).toEqual([a.buffer])
    expect(worker.transfers[1]).toEqual([b.buffer])
    expect(first![0]!.length).toBe(a.length / 2)
    expect(second![0]!.length).toBe(b.length)
    expect(runner.pending).toBe(0)
  })

  it('un error del núcleo o del Worker rechaza la promesa', async () => {
    const worker = new FakeWorker()
    const runner = createWorkerRunner(() => worker)
    await expect(runner.run({ channels: [sine(220, 0.1)], sampleRate: SR, stretchRatio: -1, semitones: 0 })).rejects.toThrow()

    const dead: StretchWorkerLike = { postMessage: () => {}, onmessage: null, onerror: null, terminate: () => {} }
    const broken = createWorkerRunner(() => dead)
    const job = broken.run({ channels: [sine(220, 0.1)], sampleRate: SR, stretchRatio: 1, semitones: 1 })
    dead.onerror?.(new Error('boom'))
    await expect(job).rejects.toThrow()
    expect(broken.pending).toBe(0)
  })
})

describe('caché + proveedor', () => {
  function setup(onReady?: (key: RenderKey) => void) {
    const ctx = offlineContext(1, 1)
    const builder = new ProjectBuilder(ctx)
    const asset = builder.asset(bufferOf(ctx, sine(220, 1)))
    let renders = 0
    const provider = createStretchProvider({
      run: (job) => {
        renders++
        return inline(job)
      },
      createBuffer: (channels, length, sampleRate) => ctx.createBuffer(channels, length, sampleRate),
    })
    const cache = new LruRenderCache({
      maxBytes: 64 * 1024 * 1024,
      provider,
      buffers: builder.buffers,
      ...(onReady ? { onReady } : {}),
    })
    return { builder, asset, cache, renderCount: () => renders }
  }

  function keyFor(assetId: AssetId, extra: Partial<RenderKey> = {}): RenderKey {
    return { assetId, start: 0, end: SR, stretchRatio: 1, semitones: 4, mode: 'preserve', ...extra }
  }

  it('request → onReady → get devuelve el buffer', async () => {
    let ready: (key: RenderKey) => void = () => {}
    const done = new Promise<RenderKey>((resolve) => (ready = resolve))
    const { asset, cache, renderCount } = setup((key) => ready(key))
    const key = keyFor(asset.id, { start: 4800, end: 4800 + 24000, stretchRatio: 1.5 })

    expect(cache.get(key)).toBeUndefined()
    cache.request(key)
    cache.request(key) // en curso: no se duplica
    expect(await done).toEqual(key)

    const buffer = cache.get(key)
    expect(buffer).toBeDefined()
    expect(buffer!.sampleRate).toBe(SR)
    expect(buffer!.length).toBe(16000) // solo la porción pedida, a 1.5×
    expect(rms(buffer!.getChannelData(0))).toBeGreaterThan(0.2)
    cache.request(key) // ya está: no se vuelve a renderizar
    expect(renderCount()).toBe(1)
  })

  it('una clave `resample` no produce render', async () => {
    const { asset, cache } = setup()
    const key = keyFor(asset.id, { mode: 'resample' })
    cache.request(key)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cache.get(key)).toBeUndefined()
  })

  it('prerenderSampler pide el rango una sola vez y luego sale barato', async () => {
    let count = 0
    const { builder, asset, cache, renderCount } = setup(() => count++)
    const track = builder.sampler(asset)
    expect(prerenderSampler(builder.project, track.id, cache, 2)).toEqual({ total: 0, ready: 0 }) // resample

    track.pitchMode = 'preserve'
    const keys = samplerRenderKeys(builder.project, track.id, 2)
    expect(keys.map((k) => k.semitones)).toEqual([1, -1, 2, -2])
    expect(prerenderSampler(builder.project, track.id, cache, 2)).toEqual({ total: 4, ready: 0 })
    expect(prerenderSampler(builder.project, track.id, cache, 2)).toEqual({ total: 4, ready: 0 })
    await expect.poll(() => count, { timeout: 10000 }).toBe(4)
    expect(renderCount()).toBe(4)

    expect(prerenderSampler(builder.project, track.id, cache, 2)).toEqual({ total: 4, ready: 4 })
    expect(renderCount()).toBe(4)
    // Son las claves que usa el motor: mismo asset, porción completa, ratio 1.
    expect(cache.get({ assetId: asset.id, start: 0, end: SR, stretchRatio: 1, semitones: -2, mode: 'preserve' })).toBeDefined()
  })
})
