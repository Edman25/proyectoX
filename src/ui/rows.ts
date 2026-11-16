import type { DrumRackTrack, Project, SlicerTrack } from '../model'
import { refLabel } from './pads'

export interface Row {
  pitch: number
  label: string
  /** Solo en Drum Rack: índice del pad. */
  padIndex?: number
}

/** Filas del editor de una pista: un pad o un slice por fila. */
export function rowsFor(project: Project, track: DrumRackTrack | SlicerTrack): Row[] {
  if (track.kind === 'drumRack') {
    return track.pads.map((pad, i) => ({ pitch: track.baseNote + i, label: refLabel(project, pad.sample) ?? '', padIndex: i }))
  }
  const asset = track.assetId ? project.assets[track.assetId] : undefined
  return (asset?.slices ?? []).map((_, i) => ({ pitch: track.baseNote + i, label: `Slice ${i + 1}` }))
}
