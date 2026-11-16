import { describe, expect, it } from 'vitest'
import { createDrumRack, createEmptyProject, createPattern } from './defaults'
import { PPQ } from './time'

describe('defaults', () => {
  it('un proyecto vacío es JSON puro', () => {
    const p = createEmptyProject()
    expect(JSON.parse(JSON.stringify(p))).toEqual(p)
  })

  it('drum rack con número de pads variable e ids únicos', () => {
    const rack = createDrumRack('EP-133', 12)
    expect(rack.pads).toHaveLength(12)
    expect(new Set(rack.pads.map((p) => p.id)).size).toBe(12)
  })

  it('patrón de un compás en 4/4', () => {
    const rack = createDrumRack('Batería')
    const pattern = createPattern(rack.id, { numerator: 4, denominator: 4 })
    expect(pattern.lengthTicks).toBe(PPQ * 4)
  })
})
