/**
 * Cuantizar. Funciones puras: no se graba cuantizado, se cuantiza después
 * y siempre a partir del timing original (`note.recorded`), así se puede
 * volver a cuantizar con otra rejilla o intensidad sin perder nada.
 *
 * Si la nota no tiene `recorded` (dibujada o movida a mano), su posición
 * actual se toma como original y se guarda ahí, por la misma razón.
 */
import { produce } from 'immer'
import type { Note, NoteId, PatternId, Project, Ticks } from '../../model'
import { swungGridTick } from '../swing'
import { clamp, posMod } from '../util'

export interface QuantizeOptions {
  /** Rejilla, p. ej. gridTicks(16). */
  gridTicks: Ticks
  /** 0 = no mover, 1 = pegar a la rejilla. Por defecto 1. */
  strength?: number
  /** Swing de la rejilla destino (misma escala que Pattern.swing). Por defecto 0. */
  swing?: number
  /** También cuantizar el final de las notas. Por defecto se conserva la duración. */
  quantizeEnds?: boolean
}

/** Punto de la rejilla (con swing) más cercano a `tick`. */
export function nearestGridTick(tick: number, grid: Ticks, swing = 0): number {
  const k = Math.round(tick / grid)
  let best = swungGridTick(k, swing, grid)
  for (const candidate of [swungGridTick(k - 1, swing, grid), swungGridTick(k + 1, swing, grid)]) {
    if (Math.abs(candidate - tick) < Math.abs(best - tick)) best = candidate
  }
  return best
}

/**
 * Cuantiza una nota. Con `patternLength`, una nota que cae en el final del
 * patrón da la vuelta al tick 0 (el golpe adelantado al tiempo 1).
 */
export function quantizeNote(note: Note, options: QuantizeOptions, patternLength?: Ticks): Note {
  const grid = options.gridTicks
  if (!(grid > 0)) return note
  const strength = clamp(options.strength ?? 1, 0, 1)
  const swing = options.swing ?? 0
  const source = note.recorded ?? { tick: note.tick, durationTicks: note.durationTicks }

  const start = source.tick + (nearestGridTick(source.tick, grid, swing) - source.tick) * strength
  let durationTicks = source.durationTicks
  if (options.quantizeEnds) {
    const sourceEnd = source.tick + source.durationTicks
    let targetEnd = nearestGridTick(sourceEnd, grid, swing)
    // El final nunca se pega al mismo punto que el inicio: mínimo un paso.
    const targetStart = nearestGridTick(source.tick, grid, swing)
    if (targetEnd <= targetStart) targetEnd = nearestGridTick(targetStart + grid, grid, swing)
    const end = sourceEnd + (targetEnd - sourceEnd) * strength
    durationTicks = Math.max(1, Math.round(end - start))
  }
  let tick = Math.round(start)
  if (patternLength !== undefined && patternLength > 0) tick = posMod(tick, patternLength)
  return { ...note, tick: Math.max(0, tick), durationTicks, recorded: source }
}

export function quantizeNotes(
  notes: readonly Note[],
  options: QuantizeOptions,
  patternLength?: Ticks,
): Note[] {
  return notes.map((n) => quantizeNote(n, options, patternLength))
}

/** Cuantiza un patrón del proyecto (todas sus notas, o solo `noteIds`). Pura. */
export function quantizePattern(
  project: Project,
  patternId: PatternId,
  options: QuantizeOptions,
  noteIds?: Iterable<NoteId>,
): Project {
  const only = noteIds ? new Set(noteIds) : null
  return produce(project, (draft) => {
    const pattern = draft.patterns[patternId]
    if (!pattern) return
    pattern.notes = pattern.notes.map((n) =>
      only && !only.has(n.id) ? n : quantizeNote(n, options, pattern.lengthTicks),
    )
  })
}
