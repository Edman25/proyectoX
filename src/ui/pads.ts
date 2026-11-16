/**
 * Qué hay en los pads según lo que esté seleccionado:
 *  - vista Pista (Drum Rack o Slicer): las notas de esa pista, tocadas por el motor;
 *  - vista Sample: los slices del sample, en preview.
 *
 * El pad 1 está abajo a la izquierda (como en una MPC) y el teclado sigue la
 * misma forma:
 *
 *   1 2 3 4   → pads 13–16
 *   Q W E R   → pads 9–12
 *   A S D F   → pads 5–8
 *   Z X C V   → pads 1–4
 */
import { liveNoteOff, liveNoteOn } from '../audio/engineHost'
import { noteName, type Project, type SampleRef } from '../model'
import { selectSlice } from '../state/actions'
import { getProject, useApp, type UiState } from '../state/store'
import { lightPad } from './padLights'
import { previewSlice } from './preview'

export const PADS_PER_BANK = 16
export const PAD_KEYS = ['z', 'x', 'c', 'v', 'a', 's', 'd', 'f', 'q', 'w', 'e', 'r', '1', '2', '3', '4'] as const

export interface PadSource {
  kind: 'track' | 'sample' | 'none'
  count: number
  label(index: number): string | null
}

export function refLabel(project: Project, ref: SampleRef | null): string | null {
  if (!ref) return null
  const asset = project.assets[ref.assetId]
  if (!asset) return '(falta)'
  if (ref.kind === 'asset') return asset.name
  if (ref.kind === 'range') return `${asset.name}*`
  const i = asset.slices.findIndex((s) => s.id === ref.sliceId)
  return i >= 0 ? `${asset.name} · ${i + 1}` : '(slice borrado)'
}

export function padSource(project: Project, ui: UiState): PadSource {
  if (ui.view === 'track' && ui.selectedTrackId) {
    const track = project.tracks[ui.selectedTrackId]
    if (track?.kind === 'drumRack') {
      return { kind: 'track', count: track.pads.length, label: (i) => refLabel(project, track.pads[i]?.sample ?? null) }
    }
    if (track?.kind === 'sampler') {
      // Pads cromáticos desde la raíz: el banco A es la primera octava y pico.
      return { kind: 'track', count: 128 - track.rootNote, label: (i) => noteName(track.rootNote + i) }
    }
    if (track?.kind === 'slicer') {
      const n = (track.assetId && project.assets[track.assetId]?.slices.length) || 0
      return { kind: 'track', count: n, label: (i) => (i < n ? String(i + 1) : null) }
    }
    return { kind: 'none', count: 0, label: () => null }
  }
  const asset = ui.selectedAssetId ? project.assets[ui.selectedAssetId] : undefined
  if (!asset) return { kind: 'none', count: 0, label: () => null }
  return { kind: 'sample', count: asset.slices.length, label: (i) => (i < asset.slices.length ? String(i + 1) : null) }
}

function trackTarget(index: number) {
  const { ui } = useApp.getState()
  const track = ui.selectedTrackId ? getProject().tracks[ui.selectedTrackId] : undefined
  if (!track || track.kind === 'audio') return null
  const base = track.kind === 'sampler' ? track.rootNote : track.baseNote
  return { trackId: track.id, pitch: base + index }
}

/** Toca el pad `index` (índice global, ya con el banco aplicado). */
export function padDown(index: number, timeStamp = performance.now(), velocity = 100): void {
  const { ui } = useApp.getState()
  const project = getProject()
  const source = padSource(project, ui)
  if (index >= source.count) return
  if (source.kind === 'track') {
    const target = trackTarget(index)
    if (!target) return
    liveNoteOn(target, velocity, timeStamp)
    lightPad(index)
    return
  }
  if (source.kind === 'sample' && ui.selectedAssetId) {
    const asset = project.assets[ui.selectedAssetId]
    const slice = asset?.slices[index]
    if (!asset || !slice) return
    selectSlice(slice.id)
    previewSlice(asset.id, slice, index, false)
    lightPad(index)
  }
}

export function padUp(index: number, timeStamp = performance.now()): void {
  const { ui } = useApp.getState()
  if (ui.view !== 'track') return
  const target = trackTarget(index)
  if (target) liveNoteOff(target, timeStamp)
}
