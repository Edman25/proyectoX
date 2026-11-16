/**
 * Historial de deshacer/rehacer basado en parches de Immer. Cada `commit`
 * es un paso: guarda los parches para ir hacia adelante y hacia atrás, no
 * copias completas del proyecto.
 */
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer'

enablePatches()

export interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
}

export interface History<T> {
  present: T
  past: HistoryEntry[]
  future: HistoryEntry[]
}

export const HISTORY_LIMIT = 500

export function createHistory<T>(present: T): History<T> {
  return { present, past: [], future: [] }
}

export function commit<T extends object>(h: History<T>, label: string, recipe: (draft: Draft<T>) => void): History<T> {
  const [next, patches, inverse] = produceWithPatches(h.present, recipe)
  if (patches.length === 0) return h
  const past = [...h.past, { label, patches, inverse }]
  if (past.length > HISTORY_LIMIT) past.shift()
  return { present: next, past, future: [] }
}

/** Reemplaza el presente sin registrar un paso (p. ej. al cargar un proyecto). */
export function reset<T>(present: T): History<T> {
  return createHistory(present)
}

export function undo<T extends object>(h: History<T>): History<T> {
  const entry = h.past.at(-1)
  if (!entry) return h
  return {
    present: applyPatches(h.present, entry.inverse) as T,
    past: h.past.slice(0, -1),
    future: [entry, ...h.future],
  }
}

export function redo<T extends object>(h: History<T>): History<T> {
  const entry = h.future[0]
  if (!entry) return h
  return {
    present: applyPatches(h.present, entry.patches) as T,
    past: [...h.past, entry],
    future: h.future.slice(1),
  }
}
