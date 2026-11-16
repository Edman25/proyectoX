/**
 * Operaciones puras sobre los slices de un asset. Nunca tocan el audio: los
 * slices son marcadores. Invariante: ordenados por `start`, sin traslapes,
 * cada uno con al menos MIN_SLICE_FRAMES.
 *
 * Al partir o unir, el primer slice conserva su id para que lo que ya lo
 * usaba (pads, Sampler) siga apuntando a algo con sentido.
 */
import { DEFAULT_PLAYBACK } from './defaults'
import { newId, type SliceId } from './ids'
import type { Slice } from './project'

export const MIN_SLICE_FRAMES = 64

function makeSlice(start: number, end: number, base?: Slice): Slice {
  return {
    id: newId<SliceId>(),
    start,
    end,
    playback: base ? { ...base.playback } : { ...DEFAULT_PLAYBACK },
  }
}

/** Slices contiguos que cubren todo el audio, cortando en `boundaries`. */
export function slicesFromBoundaries(totalFrames: number, boundaries: readonly number[]): Slice[] {
  const cuts = [...new Set(boundaries.map(Math.round))]
    .filter((b) => b > 0 && b < totalFrames)
    .sort((a, b) => a - b)
  const edges = [0, ...cuts, totalFrames]
  const out: Slice[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i]!
    const end = edges[i + 1]!
    const prev = out.at(-1)
    if (end - start < MIN_SLICE_FRAMES && prev) {
      prev.end = end
      continue
    }
    out.push(makeSlice(start, end))
  }
  return out
}

export function equalDivisionBoundaries(totalFrames: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count))
  return Array.from({ length: n - 1 }, (_, i) => Math.round(((i + 1) * totalFrames) / n))
}

/**
 * Cortes cada `stepBeats` tiempos a `bpm`, empezando en `offsetFrames`
 * (para alinear con el primer golpe del loop).
 */
export function gridBoundaries(
  totalFrames: number,
  sampleRate: number,
  bpm: number,
  stepBeats: number,
  offsetFrames = 0,
): number[] {
  const step = (60 / bpm) * stepBeats * sampleRate
  if (!(step > 0)) return []
  const out: number[] = []
  if (offsetFrames > 0) out.push(offsetFrames)
  for (let f = offsetFrames + step; f < totalFrames; f += step) out.push(Math.round(f))
  return out
}

/** Pone un marcador en `frame`: si cae dentro de un slice lo parte; si no hay slices, crea dos. */
export function addMarker(slices: readonly Slice[], totalFrames: number, frame: number): Slice[] {
  if (slices.length === 0) return slicesFromBoundaries(totalFrames, [frame])
  const target = slices.find((s) => frame > s.start && frame < s.end)
  return target ? splitSlice(slices, target.id, frame) : [...slices]
}

export function splitSlice(slices: readonly Slice[], id: SliceId, frame: number): Slice[] {
  const i = slices.findIndex((s) => s.id === id)
  const s = slices[i]
  if (!s) return [...slices]
  const at = Math.round(frame)
  if (at - s.start < MIN_SLICE_FRAMES || s.end - at < MIN_SLICE_FRAMES) return [...slices]
  const first: Slice = { ...s, end: at }
  const second = makeSlice(at, s.end, s)
  return [...slices.slice(0, i), first, second, ...slices.slice(i + 1)]
}

/**
 * Une slices adyacentes en la lista (si hay hueco entre ellos, el hueco
 * queda incluido). Devuelve null si los ids no forman un bloque consecutivo.
 */
export function mergeSlices(slices: readonly Slice[], ids: readonly SliceId[]): Slice[] | null {
  const idx = ids.map((id) => slices.findIndex((s) => s.id === id)).sort((a, b) => a - b)
  if (idx.length < 2 || idx[0]! < 0) return null
  for (let k = 1; k < idx.length; k++) if (idx[k] !== idx[k - 1]! + 1) return null
  const firstIdx = idx[0]!
  const lastIdx = idx.at(-1)!
  const first = slices[firstIdx]!
  const merged: Slice = { ...first, end: slices[lastIdx]!.end }
  return [...slices.slice(0, firstIdx), merged, ...slices.slice(lastIdx + 1)]
}

/** Quita el marcador al inicio del slice: lo une con el anterior si se tocan. */
export function removeMarkerBefore(slices: readonly Slice[], id: SliceId): Slice[] {
  const i = slices.findIndex((s) => s.id === id)
  const prev = slices[i - 1]
  const cur = slices[i]
  if (!prev || !cur || prev.end !== cur.start) return [...slices]
  return mergeSlices(slices, [prev.id, cur.id]) ?? [...slices]
}

/** Borra la región del slice (queda un hueco). */
export function deleteSlice(slices: readonly Slice[], id: SliceId): Slice[] {
  return slices.filter((s) => s.id !== id)
}

/**
 * Mueve un borde. Si el borde lo comparte con el vecino (se tocan), el
 * vecino se mueve también. Se limita para no invadir ni dejar slices diminutos.
 */
export function moveEdge(
  slices: readonly Slice[],
  totalFrames: number,
  id: SliceId,
  edge: 'start' | 'end',
  frame: number,
): Slice[] {
  const i = slices.findIndex((s) => s.id === id)
  const s = slices[i]
  if (!s) return [...slices]
  const out = slices.map((x) => ({ ...x }))
  const cur = out[i]!
  const f = Math.round(frame)
  if (edge === 'start') {
    const prev = out[i - 1]
    const shared = prev && prev.end === s.start
    const lo = prev ? (shared ? prev.start + MIN_SLICE_FRAMES : prev.end) : 0
    const hi = s.end - MIN_SLICE_FRAMES
    cur.start = clamp(f, lo, hi)
    if (prev && shared) prev.end = cur.start
  } else {
    const next = out[i + 1]
    const shared = next && next.start === s.end
    const lo = s.start + MIN_SLICE_FRAMES
    const hi = next ? (shared ? next.end - MIN_SLICE_FRAMES : next.start) : totalFrames
    cur.end = clamp(f, lo, hi)
    if (next && shared) next.start = cur.end
  }
  return out
}

/** Slice que contiene el frame, si hay. */
export function sliceAt(slices: readonly Slice[], frame: number): Slice | undefined {
  return slices.find((s) => frame >= s.start && frame < s.end)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
