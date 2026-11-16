import { describe, expect, it } from 'vitest'
import { detectRootNote } from './pitch'
import { estimateBpm } from './tempo'

const SR = 44100

function noise(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648
    return x / 1073741824 - 1
  }
}

interface LoopOptions {
  bars?: number
  /** Platos en corcheas además del bombo en negras. */
  hats?: boolean
  /** Segundos extra al final (loop mal recortado). */
  extraSec?: number
}

/** Loop sintético: bombo en negras, caja en 2 y 4, platos en corcheas. */
function drumLoop(bpm: number, { bars = 2, hats = true, extraSec = 0 }: LoopOptions = {}): Float32Array {
  const beat = (60 / bpm) * SR
  const length = Math.round(bars * 4 * beat + extraSec * SR)
  const out = new Float32Array(length)
  const rand = noise(7)
  for (let i = 0; i < length; i++) out[i] = rand() * 0.001
  const add = (at: number, fn: (i: number) => number, frames: number): void => {
    const start = Math.round(at)
    for (let i = 0; i < frames && start + i < length; i++) out[start + i]! += fn(i)
  }
  for (let b = 0; b * beat < length; b++) {
    add(b * beat, (i) => 0.8 * Math.sin((2 * Math.PI * 55 * i) / SR) * Math.exp(-i / 2500), 9000)
    if (b % 2 === 1) add(b * beat, (i) => 0.4 * rand() * Math.exp(-i / 1500), 6000)
    if (hats) {
      add(b * beat, (i) => 0.15 * rand() * Math.exp(-i / 300), 1500)
      add((b + 0.5) * beat, (i) => 0.15 * rand() * Math.exp(-i / 300), 1500)
    }
  }
  return out
}

describe('estimateBpm', () => {
  it('acierta el tempo de loops de varios tempos', () => {
    for (const bpm of [90, 100, 110, 120, 128, 140, 160]) {
      const found = estimateBpm(drumLoop(bpm), SR)
      expect(Math.abs(found.bpm - bpm), `${bpm} BPM → ${found.bpm}`).toBeLessThan(0.5)
      expect(found.confidence).toBeGreaterThan(0.3)
    }
  })

  it('un loop lento solo con negras no se confunde con el doble', () => {
    for (const bpm of [70, 80]) {
      const found = estimateBpm(drumLoop(bpm, { hats: false }), SR)
      expect(Math.abs(found.bpm - bpm), `${bpm} BPM → ${found.bpm}`).toBeLessThan(0.5)
    }
  })

  it('entre doble y mitad sin más pistas, prefiere el más cercano a 120', () => {
    expect(estimateBpm(drumLoop(174, { bars: 4 }), SR).bpm).toBeCloseTo(87, 0)
    expect(estimateBpm(drumLoop(150, { bars: 4 }), SR).bpm).toBeCloseTo(150, 0)
  })

  it('un loop mal recortado sigue saliendo cerca (±1.5 %)', () => {
    for (const bpm of [95, 124]) {
      const found = estimateBpm(drumLoop(bpm, { bars: 4, extraSec: 0.37 }), SR)
      expect(Math.abs(found.bpm - bpm) / bpm, `${bpm} BPM → ${found.bpm}`).toBeLessThan(0.015)
    }
  })

  it('funciona con un solo compás', () => {
    const loop = drumLoop(120, { bars: 1 })
    expect(Math.abs(estimateBpm(loop, SR).bpm - 120)).toBeLessThan(1)
  })

  it('silencio o audio demasiado corto: confianza 0', () => {
    expect(estimateBpm(new Float32Array(SR * 2), SR).confidence).toBe(0)
    expect(estimateBpm(new Float32Array(0), SR).confidence).toBe(0)
    expect(estimateBpm(new Float32Array(100).fill(0.5), SR).confidence).toBe(0)
  })
})

function tone(hz: number, seconds: number, harmonics: number[] = [1], sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) {
    let v = 0
    harmonics.forEach((gain, h) => (v += gain * Math.sin((2 * Math.PI * hz * (h + 1) * i) / sampleRate)))
    out[i] = 0.3 * v
  }
  return out
}

const hzOf = (midi: number, cents = 0): number => 440 * 2 ** ((midi - 69 + cents / 100) / 12)

describe('detectRootNote', () => {
  it('senos en varias octavas', () => {
    for (const midi of [28, 40, 57, 69, 76, 93]) {
      const found = detectRootNote(tone(hzOf(midi), 0.8), SR)
      expect(found?.midi, `midi ${midi}`).toBe(midi)
      expect(Math.abs(found!.cents)).toBeLessThan(5)
      expect(found!.confidence).toBeGreaterThan(0.8)
    }
  })

  it('mide la desafinación en cents', () => {
    const sharp = detectRootNote(tone(hzOf(60, 30), 0.8), SR)
    expect(sharp?.midi).toBe(60)
    expect(sharp!.cents).toBeGreaterThan(25)
    expect(sharp!.cents).toBeLessThan(35)
    const flat = detectRootNote(tone(hzOf(60, -40), 0.8, [1], 48000), 48000)
    expect(flat?.midi).toBe(60)
    expect(Math.abs(flat!.cents + 40)).toBeLessThan(5)
  })

  it('nota con armónicos más fuertes que la fundamental: da la fundamental', () => {
    const found = detectRootNote(tone(hzOf(45), 1, [0.4, 1, 0.7, 0.5, 0.3, 0.2]), SR)
    expect(found?.midi).toBe(45)
    expect(Math.abs(found!.cents)).toBeLessThan(10)
  })

  it('nota con ataque ruidoso y decaimiento: usa la parte estable', () => {
    const note = tone(hzOf(52), 1.5, [1, 0.5, 0.3])
    const rand = noise(3)
    for (let i = 0; i < note.length; i++) {
      note[i]! *= Math.exp(-i / (SR * 0.5))
      if (i < 1500) note[i]! += rand() * 0.8 * Math.exp(-i / 300)
    }
    const found = detectRootNote(note, SR)
    expect(found?.midi).toBe(52)
    expect(Math.abs(found!.cents)).toBeLessThan(10)
  })

  it('silencio, ruido o algo demasiado corto: null o confianza baja', () => {
    expect(detectRootNote(new Float32Array(SR), SR)).toBeNull()
    expect(detectRootNote(new Float32Array(16).fill(0.5), SR)).toBeNull()
    const rand = noise(11)
    const hiss = Float32Array.from({ length: SR }, () => rand() * 0.5)
    const found = detectRootNote(hiss, SR)
    expect(found === null || found.confidence < 0.3).toBe(true)
  })
})
