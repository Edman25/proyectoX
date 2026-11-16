import { describe, expect, it } from 'vitest'
import { PPQ, createPattern, gridTicks, newId, type Pattern, type TrackId } from '../model'
import { collectNotes } from './sequence'
import { applySwing, swungGridTick } from './swing'
import { note } from './testing'

const TS = { numerator: 4, denominator: 4 }

function pattern(lengthTicks: number, ticks: number[], extra: Partial<Pattern> = {}): Pattern {
  return {
    ...createPattern(newId<TrackId>(), TS),
    lengthTicks,
    notes: ticks.map((t) => note(t)),
    ...extra,
  }
}

/** Generador determinista para ventanas de tamaño irregular. */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

describe('swing', () => {
  const g = gridTicks(16)

  it('sin swing no cambia nada', () => {
    expect(applySwing(123, 0, g)).toBe(123)
  })

  it('los tiempos fuertes no se mueven', () => {
    for (const k of [0, 2, 4, 16]) expect(applySwing(k * g, 0.5, g)).toBeCloseTo(k * g, 9)
  })

  it('swing 0.5 pone el paso débil al 66.7 % del par (tresillo)', () => {
    expect(applySwing(g, 0.5, g)).toBeCloseTo((2 * g * 2) / 3, 9)
    expect(applySwing(3 * g, 0.5, g)).toBeCloseTo(2 * g + (2 * g * 2) / 3, 9)
  })

  it('swing 1 lo lleva al 83.3 %', () => {
    expect(applySwing(g, 1, g)).toBeCloseTo((2 * g * 5) / 6, 9)
  })

  it('es monótono: nunca cambia el orden de las notas', () => {
    let prev = -1
    for (let t = 0; t < 4 * g; t += 7) {
      const s = applySwing(t, 0.8, g)
      expect(s).toBeGreaterThan(prev)
      prev = s
    }
  })

  it('swungGridTick coincide con applySwing en los puntos de la rejilla', () => {
    for (let k = -4; k < 8; k++) {
      expect(swungGridTick(k, 0.4, g)).toBeCloseTo(applySwing(k * g, 0.4, g), 9)
    }
  })
})

describe('collectNotes: bordes de loop', () => {
  it('ventanas contiguas irregulares: cada repetición sale exactamente una vez', () => {
    for (const len of [PPQ * 4, PPQ * 3, 1000, 777]) {
      const ticks = [0, 1, len / 2, len - 1].map(Math.floor)
      const p = pattern(len, ticks)
      const random = lcg(len)
      const seen: number[] = []
      let cursor = 0
      const total = len * 9.5
      while (cursor < total) {
        const next = Math.min(total, cursor + random() * 300 + 0.001)
        for (const n of collectNotes(p, 0, cursor, next)) seen.push(n.onTick)
        cursor = next
      }
      const expected: number[] = []
      for (let k = 0; k * len < total; k++) {
        for (const t of ticks) if (k * len + t < total) expected.push(k * len + t)
      }
      expect(seen).toEqual(expected.sort((a, b) => a - b))
    }
  })

  it('una nota justo en el borde pertenece a la ventana que empieza ahí', () => {
    const p = pattern(960, [0])
    expect(collectNotes(p, 0, 0, 960)).toHaveLength(1)
    expect(collectNotes(p, 0, 960, 1920).map((n) => n.onTick)).toEqual([960])
    expect(collectNotes(p, 0, 959.999, 960)).toHaveLength(0)
  })

  it('con swing tampoco se pierden ni duplican', () => {
    const g = gridTicks(16)
    const len = PPQ * 4
    const ticks = Array.from({ length: 16 }, (_, i) => i * g)
    const p = pattern(len, ticks, { swing: 0.6, swingGridTicks: g })
    const seen: number[] = []
    for (let c = 0; c < len * 3; c += 48) {
      for (const n of collectNotes(p, 0, c, c + 48)) seen.push(n.onTick)
    }
    expect(seen).toHaveLength(48)
    expect(seen[1]).toBeCloseTo(applySwing(g, 0.6, g), 9)
    expect(seen[17]).toBeCloseTo(len + applySwing(g, 0.6, g), 9)
  })

  it('una nota que dura más allá del final termina en la siguiente vuelta, sin pisarse', () => {
    const p = pattern(960, [])
    p.notes = [note(900, 36, 200), note(0, 37, 5000)]
    const [long, late] = collectNotes(p, 0, 0, 960)
    expect(late).toMatchObject({ onTick: 900, offTick: 1100 })
    // Nunca más larga que el patrón: su final coincide con su siguiente inicio.
    expect(long).toMatchObject({ onTick: 0, offTick: 960 })
  })

  it('las notas fuera del largo del patrón no suenan', () => {
    const p = pattern(960, [0, 960, 2000])
    expect(collectNotes(p, 0, 0, 4000).map((n) => n.onTick)).toEqual([0, 960, 1920, 2880, 3840])
  })

  it('clip: respeta inicio, final y offset', () => {
    const p = pattern(960, [0, 480])
    p.notes[1]!.durationTicks = 600
    // Clip de 1200 ticks en 10000, empezando 480 ticks dentro del patrón.
    const notes = collectNotes(p, 10000 - 480, 0, 20000, 10000, 11200)
    expect(notes.map((n) => n.onTick)).toEqual([10000, 10480, 10960])
    // La última nota se corta en el final del clip.
    expect(notes.map((n) => n.offTick)).toEqual([10600, 10600, 11200])
  })
})
