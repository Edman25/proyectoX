import { isBlackKey, noteName, type DrumRackTrack, type Pattern, type Project, type SamplerTrack, type SlicerTrack } from '../model'
import { refLabel } from './pads'

export interface Row {
  pitch: number
  label: string
  /** Solo en Drum Rack: índice del pad. */
  padIndex?: number
  /** Solo en Sampler: tecla negra (para pintar el piano). */
  black?: boolean
}

export type NoteTrack = DrumRackTrack | SlicerTrack | SamplerTrack

/**
 * Filas del editor de una pista: un pad o un slice por fila, o en el Sampler
 * las teclas (de agudo a grave, como un piano roll), cubriendo de una octava
 * bajo la raíz a tres arriba y cualquier nota que ya tenga el patrón.
 */
export function rowsFor(project: Project, track: NoteTrack, pattern?: Pattern): Row[] {
  if (track.kind === 'drumRack') {
    return track.pads.map((pad, i) => ({ pitch: track.baseNote + i, label: refLabel(project, pad.sample) ?? '', padIndex: i }))
  }
  if (track.kind === 'slicer') {
    const asset = track.assetId ? project.assets[track.assetId] : undefined
    return (asset?.slices ?? []).map((_, i) => ({ pitch: track.baseNote + i, label: `Slice ${i + 1}` }))
  }
  let lo = track.rootNote - 12
  let hi = track.rootNote + 36
  for (const n of pattern?.notes ?? []) {
    lo = Math.min(lo, n.pitch)
    hi = Math.max(hi, n.pitch)
  }
  lo = Math.max(0, lo)
  hi = Math.min(127, hi)
  const rows: Row[] = []
  for (let p = hi; p >= lo; p--) {
    rows.push({ pitch: p, label: p === track.rootNote ? `${noteName(p)} (raíz)` : noteName(p), black: isBlackKey(p) })
  }
  return rows
}
