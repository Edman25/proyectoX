import { describe, expect, it } from 'vitest'
import { commit, createHistory, redo, undo } from './history'

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
})
