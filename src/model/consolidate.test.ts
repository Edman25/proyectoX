import { describe, expect, it } from 'vitest'
import { consolidate } from './consolidate'
import { DEFAULT_PLAYBACK } from './defaults'

const SR = 1000 // 1 frame = 1 ms, fácil de razonar
const ramp = (n: number) => new Float32Array(n).map((_, i) => i)

describe('consolidate', () => {
  it('une porciones en el orden dado y devuelve sus inicios', () => {
    const a = [ramp(100)]
    const r = consolidate(
      [
        { channels: a, start: 50, end: 60, playback: DEFAULT_PLAYBACK },
        { channels: a, start: 10, end: 30, playback: DEFAULT_PLAYBACK },
      ],
      SR,
    )
    expect(r.channels[0]!.length).toBe(30)
    expect(r.boundaries).toEqual([0, 10])
    // centro de cada porción intacto (fuera de los micro-fades de 2 ms)
    expect(r.channels[0]![5]).toBe(55)
    expect(r.channels[0]![20]).toBe(20)
  })

  it('las uniones empiezan y terminan en silencio (sin clicks)', () => {
    const ones = [new Float32Array(100).fill(1)]
    const r = consolidate(
      [
        { channels: ones, start: 0, end: 40, playback: DEFAULT_PLAYBACK },
        { channels: ones, start: 0, end: 40, playback: DEFAULT_PLAYBACK },
      ],
      SR,
    )
    const out = r.channels[0]!
    expect(out[0]).toBe(0)
    expect(out[39]).toBe(0)
    expect(out[40]).toBe(0)
    expect(out[20]).toBe(1)
  })

  it('reversa, ganancia y mezcla mono + estéreo', () => {
    const mono = [ramp(10)]
    const stereo = [new Float32Array(10).fill(1), new Float32Array(10).fill(-1)]
    const r = consolidate(
      [
        { channels: mono, start: 0, end: 10, playback: { ...DEFAULT_PLAYBACK, reverse: true, fadeInMs: 0, fadeOutMs: 0 } },
        { channels: stereo, start: 0, end: 10, playback: { ...DEFAULT_PLAYBACK, gainDb: -6.0206 } },
      ],
      100000, // fades de 2 ms = 200 frames → se limitan a la mitad de la porción
    )
    expect(r.channels).toHaveLength(2)
    expect(r.channels[0]![3]).toBeCloseTo(6 * (3 / 5), 5) // 9-3=6, con fade in
    expect(r.channels[1]![3]).toBeCloseTo(r.channels[0]![3]!, 5) // mono copiado al canal 2
    // -6 dB = ×0.5, y en el frame 5 de 10 ya empieza el fade out (4/5)
    expect(r.channels[1]![15]).toBeCloseTo(-0.5 * 0.8, 2)
  })
})
