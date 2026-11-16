import { describe, expect, it } from 'vitest'
import { PPQ, gridTicks, secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from './time'

describe('time', () => {
  it('una negra a 120 BPM dura medio segundo', () => {
    expect(ticksToSeconds(PPQ, 120)).toBeCloseTo(0.5, 12)
  })

  it('segundos → ticks es la inversa', () => {
    for (const bpm of [60, 90, 127.5, 140, 174]) {
      expect(secondsToTicks(ticksToSeconds(12345, bpm), bpm)).toBeCloseTo(12345, 6)
    }
  })

  it('compases según el compás', () => {
    expect(ticksPerBar({ numerator: 4, denominator: 4 })).toBe(PPQ * 4)
    expect(ticksPerBar({ numerator: 3, denominator: 4 })).toBe(PPQ * 3)
    expect(ticksPerBeat({ numerator: 6, denominator: 8 })).toBe(PPQ / 2)
    expect(ticksPerBar({ numerator: 6, denominator: 8 })).toBe(PPQ * 3)
  })

  it('subdivisiones', () => {
    expect(gridTicks(4)).toBe(PPQ)
    expect(gridTicks(16)).toBe(PPQ / 4)
    expect(gridTicks(8, true)).toBe(PPQ / 3)
    expect(Number.isInteger(gridTicks(32, true))).toBe(true)
  })
})
