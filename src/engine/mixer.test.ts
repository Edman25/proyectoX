import { describe, expect, it } from 'vitest'
import { PPQ, defaultFx, ticksToSeconds } from '../model'
import { renderOffline } from './offline'
import { softClipCurve } from './mixer'
import { ProjectBuilder, SR, dc, impulse, note, offlineContext, onsets } from './testing'

const scratch = () => offlineContext(0.01)

async function render(b: ProjectBuilder, seconds: number): Promise<AudioBuffer> {
  return renderOffline(b.project, b.buffers, {
    sampleRate: SR,
    durationSec: seconds,
    createContext: (channels, length, sampleRate) => offlineContext(length / sampleRate, channels, sampleRate),
  })
}

function oneHit(fx: ReturnType<typeof defaultFx>, buffer?: (ctx: BaseAudioContext) => AudioBuffer) {
  const ctx = scratch()
  const b = new ProjectBuilder(ctx, 120)
  const drums = b.drumRack([buffer ? buffer(ctx) : impulse(ctx)])
  b.pattern(drums.id, [note(0)], PPQ * 16) // un solo golpe en 8 s
  drums.mixer = { ...drums.mixer, fx }
  b.project.tracks[drums.id] = drums
  return b
}

describe('mixer: efectos', () => {
  it('delay: ecos al tiempo de la rejilla, cada vez más bajos', async () => {
    const fx = defaultFx()
    fx.delay = { enabled: true, timeTicks: PPQ / 2, feedback: 0.5, mix: 0.5 } // corchea a 120 = 0.25 s
    const out = (await render(oneHit(fx), 1.2)).getChannelData(0)
    const step = Math.round(ticksToSeconds(PPQ / 2, 120) * SR)
    expect(onsets(out, 0.01, 1000).slice(0, 4)).toEqual([0, step, 2 * step, 3 * step].map((f) => expect.closeTo(f, 0)))
    const peak = (f: number) => Math.max(...Array.from(out.subarray(f, f + 64), Math.abs))
    expect(peak(step)).toBeGreaterThan(peak(2 * step))
  })

  it('sin efectos activos, la señal pasa igual', async () => {
    const out = (await render(oneHit(defaultFx()), 0.5)).getChannelData(0)
    expect(onsets(out, 0.01, 1000)).toEqual([0])
  })

  it('reverb: deja cola después del golpe', async () => {
    const fx = defaultFx()
    fx.reverb = { enabled: true, sizeSec: 1, mix: 0.5 }
    const tailOf = (d: Float32Array) => Math.max(...Array.from(d.subarray(Math.round(0.3 * SR), Math.round(0.35 * SR)), Math.abs))
    const wet = tailOf((await render(oneHit(fx), 1)).getChannelData(0))
    const dry = tailOf((await render(oneHit(defaultFx()), 1)).getChannelData(0))
    expect(dry).toBe(0)
    expect(wet).toBeGreaterThan(0.0001)
  })

  it('filtro pasa bajos: atenúa un tono agudo', async () => {
    const tone = (ctx: BaseAudioContext) => {
      const n = SR / 2
      const buf = ctx.createBuffer(1, n, SR)
      buf.getChannelData(0).forEach((_, i, a) => (a[i] = 0.5 * Math.sin((2 * Math.PI * 8000 * i) / SR)))
      return buf
    }
    const rms = (d: Float32Array) => Math.sqrt(d.subarray(4800, 19200).reduce((s, v) => s + v * v, 0) / 14400)
    const dry = (await render(oneHit(defaultFx(), tone), 0.5)).getChannelData(0)
    const fx = defaultFx()
    fx.filter = { enabled: true, type: 'lowpass', cutoffHz: 500, q: 0.7 }
    const wet = (await render(oneHit(fx, tone), 0.5)).getChannelData(0)
    expect(rms(wet)).toBeLessThan(rms(dry) * 0.05)
  })

  it('protección del master: nunca pasa de 1 y no toca lo que está bajo 0.8', async () => {
    const curve = softClipCurve()
    const at = (x: number) => curve[Math.round(((x + 2) / 4) * (curve.length - 1))]!
    expect(at(0.5)).toBeCloseTo(0.5, 2)
    expect(at(1.5)).toBeLessThan(1)
    expect(at(-2)).toBeGreaterThan(-1.0001)
    const b = oneHit(defaultFx(), (ctx) => dc(ctx, 4800, 1.8))
    b.project.master = { ...b.project.master, limiter: true }
    const out = (await render(b, 0.2)).getChannelData(0)
    expect(Math.max(...Array.from(out, Math.abs))).toBeLessThanOrEqual(1)
  })
})
