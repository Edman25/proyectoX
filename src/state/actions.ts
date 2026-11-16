/**
 * Acciones de la fase 1 (biblioteca y slices). Cada una es un paso de deshacer.
 */
import { detectOnsets, nearestZeroCrossing } from '../analysis/onsets'
import { detectRootNote, type RootNote } from '../analysis/pitch'
import { estimateBpm } from '../analysis/tempo'
import { getLoadedAudio, importFile, isAudioFile } from '../audio/library'
import type { AssetId, PlaybackOptions, SampleAsset, Slice, SliceId } from '../model'
import {
  addMarker,
  equalDivisionBoundaries,
  gridBoundaries,
  mergeSlices,
  moveEdge,
  removeMarkerBefore,
  slicesFromBoundaries,
} from '../model/sliceOps'
import { getProject, useApp } from './store'

const { change, setUi } = useApp.getState()

function asset(id: AssetId): SampleAsset | undefined {
  return getProject().assets[id]
}

function setSlices(id: AssetId, label: string, slices: Slice[]): void {
  change(label, (p) => {
    const a = p.assets[id]
    if (a) a.slices = slices
  })
  const keep = new Set(slices.map((s) => s.id))
  const ui = useApp.getState().ui
  setUi({ selectedSliceIds: ui.selectedSliceIds.filter((s) => keep.has(s)) })
}

/** Ajusta al cruce por cero si está activado. */
function snap(id: AssetId, frame: number): number {
  const audio = getLoadedAudio(id)
  if (!audio || !useApp.getState().ui.snapToZero) return Math.round(frame)
  return nearestZeroCrossing(audio.mono, Math.round(frame), Math.round(audio.buffer.sampleRate * 0.003))
}

export async function importFiles(files: readonly File[]): Promise<{ imported: number; failed: string[] }> {
  const failed: string[] = []
  let imported = 0
  let lastId: AssetId | null = null
  for (const file of files) {
    if (!isAudioFile(file)) {
      failed.push(file.name)
      continue
    }
    try {
      const a = await importFile(file)
      change(`Importar ${a.name}`, (p) => {
        p.assets[a.id] = a
      })
      lastId = a.id
      imported++
    } catch {
      failed.push(file.name)
    }
  }
  if (lastId) setUi({ selectedAssetId: lastId, selectedSliceIds: [], padBank: 0, view: 'sample' })
  return { imported, failed }
}

export function selectAsset(id: AssetId | null): void {
  setUi({ selectedAssetId: id, selectedSliceIds: [], padBank: 0, view: 'sample' })
}

export function renameAsset(id: AssetId, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  change('Renombrar', (p) => {
    const a = p.assets[id]
    if (a) a.name = trimmed
  })
}

export function removeAsset(id: AssetId): void {
  change('Quitar sample', (p) => {
    delete p.assets[id]
  })
  if (useApp.getState().ui.selectedAssetId === id) selectAsset(null)
}

export function setAssetBpm(id: AssetId, bpm: number | null): void {
  change('BPM del sample', (p) => {
    const a = p.assets[id]
    if (a) a.bpm = bpm
  })
}

export function selectSlice(id: SliceId, mode: 'replace' | 'toggle' | 'range' = 'replace'): void {
  const { ui } = useApp.getState()
  if (mode === 'replace') return setUi({ selectedSliceIds: [id] })
  if (mode === 'toggle') {
    const has = ui.selectedSliceIds.includes(id)
    return setUi({ selectedSliceIds: has ? ui.selectedSliceIds.filter((s) => s !== id) : [...ui.selectedSliceIds, id] })
  }
  // range: del ancla (el primero de la selección) hasta este. Se guarda en
  // orden ancla → destino, así el último es siempre el extremo que se mueve.
  const a = ui.selectedAssetId ? asset(ui.selectedAssetId) : undefined
  const anchor = ui.selectedSliceIds[0]
  if (!a || !anchor) return setUi({ selectedSliceIds: [id] })
  const i0 = a.slices.findIndex((s) => s.id === anchor)
  const i1 = a.slices.findIndex((s) => s.id === id)
  if (i0 < 0 || i1 < 0) return setUi({ selectedSliceIds: [id] })
  const step = i1 >= i0 ? 1 : -1
  const ids: SliceId[] = []
  for (let i = i0; i !== i1 + step; i += step) ids.push(a.slices[i]!.id)
  setUi({ selectedSliceIds: ids })
}

export function addMarkerAt(id: AssetId, frame: number): void {
  const a = asset(id)
  if (!a) return
  setSlices(id, 'Agregar marcador', addMarker(a.slices, a.frames, snap(id, frame)))
}

export function moveSliceEdge(id: AssetId, sliceId: SliceId, edge: 'start' | 'end', frame: number, label: string): void {
  const a = asset(id)
  if (!a) return
  setSlices(id, label, moveEdge(a.slices, a.frames, sliceId, edge, snap(id, frame)))
}

export function mergeSelected(id: AssetId): boolean {
  const a = asset(id)
  const ids = useApp.getState().ui.selectedSliceIds
  if (!a) return false
  const merged = mergeSlices(a.slices, ids)
  if (!merged) return false
  setSlices(id, 'Unir slices', merged)
  return true
}

export function removeMarker(id: AssetId, sliceId: SliceId): void {
  const a = asset(id)
  if (!a) return
  setSlices(id, 'Quitar marcador', removeMarkerBefore(a.slices, sliceId))
}

export function clearSlices(id: AssetId): void {
  setSlices(id, 'Quitar slices', [])
}

export function autoSliceTransients(id: AssetId, sensitivity: number): number {
  const a = asset(id)
  const audio = getLoadedAudio(id)
  if (!a || !audio) return 0
  const onsets = detectOnsets(audio.mono, { sampleRate: audio.buffer.sampleRate, sensitivity })
  const slices = slicesFromBoundaries(a.frames, onsets.map((f) => snap(id, f)))
  setSlices(id, 'Cortar por golpes', slices)
  return slices.length
}

export function autoSliceEqual(id: AssetId, count: number): void {
  const a = asset(id)
  if (!a) return
  const cuts = equalDivisionBoundaries(a.frames, count).map((f) => snap(id, f))
  setSlices(id, `Dividir en ${count}`, slicesFromBoundaries(a.frames, cuts))
}

export function autoSliceGrid(id: AssetId, bpm: number, stepBeats: number): void {
  const a = asset(id)
  if (!a) return
  const cuts = gridBoundaries(a.frames, a.sampleRate, bpm, stepBeats).map((f) => snap(id, f))
  setSlices(id, 'Cortar por rejilla', slicesFromBoundaries(a.frames, cuts))
}

export function updateSlicePlayback(id: AssetId, sliceIds: readonly SliceId[], patch: Partial<PlaybackOptions>, label: string): void {
  const set = new Set(sliceIds)
  change(label, (p) => {
    for (const s of p.assets[id]?.slices ?? []) {
      if (set.has(s.id)) Object.assign(s.playback, patch)
    }
  })
}

export function setAssetRootNote(id: AssetId, rootNote: number | null): void {
  change('Nota del sample', (p) => {
    const a = p.assets[id]
    if (a) a.rootNote = rootNote
  })
}

/** Detecta el BPM del sample completo y lo guarda. Devuelve la confianza (0–1) o null. */
export function detectAssetBpm(id: AssetId): { bpm: number; confidence: number } | null {
  const audio = getLoadedAudio(id)
  if (!audio) return null
  const est = estimateBpm(audio.mono, audio.buffer.sampleRate)
  if (!(est.confidence > 0)) return est
  setAssetBpm(id, Math.round(est.bpm * 100) / 100)
  return est
}

/** Detecta la nota de una porción del sample (o de todo). */
export function detectRoot(id: AssetId, start = 0, end?: number): RootNote | null {
  const audio = getLoadedAudio(id)
  if (!audio) return null
  return detectRootNote(audio.mono.subarray(start, end ?? audio.mono.length), audio.buffer.sampleRate)
}
