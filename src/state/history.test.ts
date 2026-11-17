import { describe, expect, it } from 'vitest'
import { commit, commitMerged, createHistory, redo, undo } from './history'

describe('history', () => {
  it('deshace y rehace', () => {
    let h = createHistory({ bpm: 90, notes: [] as number[] })
    h = commit(h, 'bpm', (d) => {
      d.bpm = 120
    })
    h = commit(h, 'nota', (d) => {
      d.notes.push(1)
    })
    expect(h.present).toEqual({ bpm: 120, notes: [1] })

    h = undo(h)
    expect(h.present).toEqual({ bpm: 120, notes: [] })
    h = undo(h)
    expect(h.present).toEqual({ bpm: 90, notes: [] })
    h = undo(h)
    expect(h.present.bpm).toBe(90)

    h = redo(redo(h))
    expect(h.present).toEqual({ bpm: 120, notes: [1] })
  })

  it('un commit nuevo borra el futuro', () => {
    let h = createHistory({ v: 0 })
    h = commit(h, 'a', (d) => {
      d.v = 1
    })
    h = undo(h)
    h = commit(h, 'b', (d) => {
      d.v = 2
    })
    expect(h.future).toHaveLength(0)
    expect(redo(h).present.v).toBe(2)
  })

  it('un commit sin cambios no crea paso', () => {
    const h = createHistory({ v: 0 })
    expect(commit(h, 'nada', () => {})).toBe(h)
  })

  it('las partes que no cambian conservan su referencia', () => {
    let h = createHistory({ a: { x: 1 }, b: { y: 1 } })
    const b = h.present.b
    h = commit(h, 'a', (d) => {
      d.a.x = 2
    })
    expect(h.present.b).toBe(b)
  })

  it('cambios seguidos con la misma clave se funden en un paso', () => {
    let h = createHistory({ vol: 0, pan: 0 })
    h = commitMerged(h, 'Perilla', 'k1', (d) => void (d.vol = 1), 1000)
    h = commitMerged(h, 'Perilla', 'k1', (d) => void (d.vol = 2), 1500)
    h = commitMerged(h, 'Perilla', 'k1', (d) => void (d.vol = 3), 2000)
    expect(h.past).toHaveLength(1)
    h = commitMerged(h, 'Perilla', 'k2', (d) => void (d.pan = 1), 2100)
    h = commitMerged(h, 'Perilla', 'k1', (d) => void (d.vol = 9), 9000) // pasó la ventana
    expect(h.past).toHaveLength(3)
    h = undo(undo(h))
    expect(h.present).toEqual({ vol: 3, pan: 0 })
    h = undo(h)
    expect(h.present).toEqual({ vol: 0, pan: 0 })
  })
})
