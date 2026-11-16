import { describe, expect, it } from 'vitest'
import { PPQ, createEmptyProject, createPattern, gridTicks, newId, type Note, type TrackId } from '../../model'
import { note } from '../testing'
import { nearestGridTick, quantizeNote, quantizeNotes, quantizePattern } from './quantize'

const G16 = gridTicks(16) // 240

/** Nota "grabada": con su timing real guardado. */
function recorded(tick: number, durationTicks = 100): Note {
  return { ...note(tick, 36, durationTicks), recorded: { tick, durationTicks } }
}

describe('cuantizar', () => {
  it('intensidad 1 pega a la rejilla y conserva la duración', () => {
    const q = quantizeNotes([recorded(250), recorded(110), recorded(130), recorded(0)], { gridTicks: G16 })
    expect(q.map((n) => n.tick)).toEqual([240, 0, 240, 0])
    expect(q.every((n) => n.durationTicks === 100)).toBe(true)
  })

  it('intensidad parcial mueve solo una parte del camino', () => {
    const opts = { gridTicks: G16 }
    expect(quantizeNote(recorded(280), { ...opts, strength: 0.5 }).tick).toBe(260)
    expect(quantizeNote(recorded(280), { ...opts, strength: 0.25 }).tick).toBe(270)
    expect(quantizeNote(recorded(280), { ...opts, strength: 0 }).tick).toBe(280)
    expect(quantizeNote(recorded(200), { ...opts, strength: 0.5 }).tick).toBe(220)
  })

  it('re-cuantizar parte siempre de `recorded`: no se acumula ni se pierde el original', () => {
    const original = recorded(280)
    const half = quantizeNote(original, { gridTicks: G16, strength: 0.5 })
    const halfAgain = quantizeNote(half, { gridTicks: G16, strength: 0.5 })
    expect(halfAgain.tick).toBe(260)
    const full = quantizeNote(halfAgain, { gridTicks: G16 })
    expect(full.tick).toBe(240)
    // Otra rejilla, desde el original (280 → corchea más cercana = 480), no desde 240.
    expect(quantizeNote(full, { gridTicks: gridTicks(8) }).tick).toBe(480)
    // Con intensidad 0 vuelve a como se tocó.
    expect(quantizeNote(full, { gridTicks: G16, strength: 0 })).toMatchObject({ tick: 280, durationTicks: 100 })
    expect(full.recorded).toEqual({ tick: 280, durationTicks: 100 })
  })

  it('una nota sin `recorded` (dibujada o movida a mano) guarda su posición como original', () => {
    const manual = note(280, 36, 100)
    const half = quantizeNote(manual, { gridTicks: G16, strength: 0.5 })
    expect(half).toMatchObject({ tick: 260, recorded: { tick: 280, durationTicks: 100 } })
    expect(quantizeNote(half, { gridTicks: G16, strength: 0.5 }).tick).toBe(260)
  })

  it('swing: los pasos débiles de la rejilla destino van retrasados', () => {
    // Con swing 0.5 el segundo paso de cada par cae al 66.7 %: 240 → 320.
    expect(nearestGridTick(250, G16, 0.5)).toBe(320)
    expect(nearestGridTick(100, G16, 0.5)).toBe(0)
    expect(nearestGridTick(460, G16, 0.5)).toBe(480)
    const q = quantizeNotes([recorded(0), recorded(250), recorded(470), recorded(700)], {
      gridTicks: G16,
      swing: 0.5,
    })
    expect(q.map((n) => n.tick)).toEqual([0, 320, 480, 800])
    expect(quantizeNote(recorded(250), { gridTicks: G16, swing: 0.5, strength: 0.5 }).tick).toBe(285)
  })

  it('opción de cuantizar finales', () => {
    const opts = { gridTicks: G16, quantizeEnds: true }
    // 250–610 → 240–720
    expect(quantizeNote(recorded(250, 360), opts)).toMatchObject({ tick: 240, durationTicks: 480 })
    // Una nota muy corta no se queda en duración 0: mínimo un paso.
    expect(quantizeNote(recorded(250, 10), opts)).toMatchObject({ tick: 240, durationTicks: 240 })
    // Intensidad parcial también en el final: 250→245, 610→665.
    expect(quantizeNote(recorded(250, 360), { ...opts, strength: 0.5 })).toMatchObject({
      tick: 245,
      durationTicks: 420,
    })
    // Sin la opción, la duración es la grabada.
    expect(quantizeNote(recorded(250, 360), { gridTicks: G16 }).durationTicks).toBe(360)
  })

  it('en un patrón, lo que cae en el final da la vuelta al principio', () => {
    const length = PPQ * 4
    expect(quantizeNote(recorded(length - 20), { gridTicks: G16 }, length).tick).toBe(0)
    expect(quantizeNote(recorded(length - 20), { gridTicks: G16, strength: 0.5 }, length).tick).toBe(length - 10)
  })

  it('quantizePattern es pura y puede limitarse a unas notas', () => {
    const project = createEmptyProject()
    const pattern = createPattern(newId<TrackId>(), project.timeSignature)
    pattern.notes = [recorded(250), recorded(500), recorded(3835)]
    project.patterns[pattern.id] = pattern
    const all = quantizePattern(project, pattern.id, { gridTicks: G16 })
    expect(all.patterns[pattern.id]!.notes.map((n) => n.tick)).toEqual([240, 480, 0])
    expect(pattern.notes.map((n) => n.tick)).toEqual([250, 500, 3835])
    const some = quantizePattern(project, pattern.id, { gridTicks: G16 }, [pattern.notes[1]!.id])
    expect(some.patterns[pattern.id]!.notes.map((n) => n.tick)).toEqual([250, 480, 3835])
  })
})
