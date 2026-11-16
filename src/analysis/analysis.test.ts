import { describe, expect, it } from 'vitest'
import { detectOnsets, nearestZeroCrossing } from './onsets'
import { computePeaks, mixToMono, peaksForView } from './peaks'

const SR = 44100

/** Golpes sintéticos: ruido con decaimiento rápido sobre un fondo tenue. */
function hits(positions: number[], length: number, seed = 1): Float32Array {
  let x = seed
  const rand = () => {
    x = (x * 1103515245 + 12345) % 2147483648
    return x / 1073741824 - 1
  }
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = rand() * 0.002
  for (const p of positions) {
    for (let i = 0; i < 6000 && p + i < length; i++) {
      out[p + i]! += rand() * 0.8 * Math.exp(-i / 1200)
    }
  }
  return out
}

describe('onsets', () => {
  it('encuentra golpes con error menor a ~6 ms', () => {
    const positions = [4410, 26460, 48510, 61740, 83790]
    const found = detectOnsets(hits(positions, SR * 2), { sampleRate: SR, sensitivity: 0.5 })
    expect(found).toHaveLength(positions.length)
    found.forEach((f, i) => expect(Math.abs(f - positions[i]!)).toBeLessThan(0.006 * SR))
  })

  it('más sensibilidad no encuentra menos golpes', () => {
    const sig = hits([10000, 30000, 50000], SR * 2)
    const low = detectOnsets(sig, { sampleRate: SR, sensitivity: 0.1 })
    const high = detectOnsets(sig, { sampleRate: SR, sensitivity: 0.9 })
    expect(high.length).toBeGreaterThanOrEqual(low.length)
  })

  it('silencio no tiene golpes', () => {
    expect(detectOnsets(new Float32Array(SR), { sampleRate: SR, sensitivity: 1 })).toEqual([])
  })

  it('cruce por cero cercano', () => {
    const sine = new Float32Array(1000).map((_, i) => Math.sin((2 * Math.PI * i) / 100))
    const z = nearestZeroCrossing(sine, 140)
    expect([150, 151]).toContain(z)
  })
})

describe('peaks', () => {
  it('min/max por vista', () => {
    const sig = new Float32Array(1024).fill(0)
    sig[10] = 0.9
    sig[700] = -0.5
    const p = computePeaks(sig, 128)
    const v = peaksForView(p, 0, 1024, 2)
    expect(v.max[0]).toBeCloseTo(0.9)
    expect(v.min[1]).toBeCloseTo(-0.5)
  })

  it('mezcla a mono', () => {
    const m = mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])])
    expect(Array.from(m)).toEqual([0.5, 0.5])
  })
})
