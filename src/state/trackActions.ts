/**
 * Acciones de la fase 2: pistas, pads, patrones y transporte. Cada una es un
 * paso de deshacer.
 */
import {
  MAX_BPM,
  MIN_BPM,
  createDrumRack,
  createPattern,
  createSlicerTrack,
  newId,
  ticksPerBar,
  type AssetId,
  type MixerChannel,
  type NoteId,
  type SampleRef,
  type SliceId,
  type Track,
  type TrackId,
} from '../model'
import { getProject, useApp } from './store'

const { change, setUi } = useApp.getState()

function nextName(base: string): string {
  const names = new Set(Object.values(getProject().tracks).map((t) => t.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}

function addTrack(track: Track, label: string): void {
  const project = getProject()
  const pattern = createPattern(track.id, project.timeSignature, 1)
  change(label, (p) => {
    p.tracks[track.id] = { ...track, activePatternId: pattern.id }
    p.patterns[pattern.id] = pattern
    p.trackOrder.push(track.id)
  })
  setUi({ selectedTrackId: track.id, view: 'track', padBank: 0 })
}

export function addDrumRack(padCount = 16): void {
  addTrack(createDrumRack(nextName('Batería'), padCount), 'Nueva batería')
}

export function addSlicer(assetId: AssetId): void {
  const asset = getProject().assets[assetId]
  addTrack(createSlicerTrack(nextName(asset?.name ?? 'Slicer'), assetId), 'Nuevo slicer')
}

export function selectTrack(id: TrackId): void {
  setUi({ selectedTrackId: id, view: 'track', padBank: 0 })
}

export function removeTrack(id: TrackId): void {
  change('Quitar pista', (p) => {
    delete p.tracks[id]
    p.trackOrder = p.trackOrder.filter((t) => t !== id)
    for (const [pid, pattern] of Object.entries(p.patterns)) {
      if (pattern.trackId === id) delete p.patterns[pid as keyof typeof p.patterns]
    }
    for (const [cid, clip] of Object.entries(p.clips)) {
      if (clip.trackId === id) delete p.clips[cid as keyof typeof p.clips]
    }
  })
  const ui = useApp.getState().ui
  if (ui.selectedTrackId === id) {
    setUi({ selectedTrackId: getProject().trackOrder[0] ?? null, view: getProject().trackOrder.length ? 'track' : 'sample' })
  }
}

export function renameTrack(id: TrackId, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  change('Renombrar pista', (p) => {
    const t = p.tracks[id]
    if (t) t.name = trimmed
  })
}

export function setMixer(id: TrackId, patch: Partial<MixerChannel>, label: string): void {
  change(label, (p) => {
    const t = p.tracks[id]
    if (t) Object.assign(t.mixer, patch)
  })
}

// --- Drum Rack -------------------------------------------------------------

export function assignPad(trackId: TrackId, padIndex: number, ref: SampleRef | null): void {
  change('Asignar pad', (p) => {
    const t = p.tracks[trackId]
    const pad = t?.kind === 'drumRack' ? t.pads[padIndex] : undefined
    if (pad) pad.sample = ref
  })
}

/** Pone los slices dados en los pads vacíos del Drum Rack, en orden. Devuelve cuántos puso. */
export function sendSlicesToPads(trackId: TrackId, assetId: AssetId, sliceIds: readonly SliceId[]): number {
  let placed = 0
  change('Enviar a pads', (p) => {
    const t = p.tracks[trackId]
    if (t?.kind !== 'drumRack') return
    const queue = [...sliceIds]
    for (const pad of t.pads) {
      if (!queue.length) break
      if (pad.sample) continue
      pad.sample = { kind: 'slice', assetId, sliceId: queue.shift()! }
      placed++
    }
  })
  return placed
}

export function setChokeGroup(trackId: TrackId, padIndex: number, group: number | null): void {
  change('Choke', (p) => {
    const t = p.tracks[trackId]
    const pad = t?.kind === 'drumRack' ? t.pads[padIndex] : undefined
    if (pad) pad.chokeGroup = group
  })
}

export function setPadTrigger(trackId: TrackId, padIndex: number, mode: 'oneShot' | 'gate'): void {
  change('Modo del pad', (p) => {
    const t = p.tracks[trackId]
    const pad = t?.kind === 'drumRack' ? t.pads[padIndex] : undefined
    if (pad) pad.triggerMode = mode
  })
}

// --- Patrones --------------------------------------------------------------

/** Prende o apaga el paso: si hay una nota de esa altura dentro del paso, la quita; si no, crea una. */
export function toggleStep(trackId: TrackId, pitch: number, stepTick: number, stepTicks: number, velocity = 100): void {
  change('Paso', (p) => {
    const t = p.tracks[trackId]
    const pattern = t?.activePatternId ? p.patterns[t.activePatternId] : undefined
    if (!pattern) return
    const idx = pattern.notes.findIndex((n) => n.pitch === pitch && n.tick >= stepTick && n.tick < stepTick + stepTicks)
    if (idx >= 0) pattern.notes.splice(idx, 1)
    else pattern.notes.push({ id: newId<NoteId>(), tick: stepTick, durationTicks: stepTicks, pitch, velocity })
  })
}

export function setPatternBars(trackId: TrackId, bars: number): void {
  change('Largo del patrón', (p) => {
    const t = p.tracks[trackId]
    const pattern = t?.activePatternId ? p.patterns[t.activePatternId] : undefined
    if (pattern) pattern.lengthTicks = ticksPerBar(p.timeSignature) * bars
  })
}

export function setSwing(trackId: TrackId, swing: number): void {
  change('Swing', (p) => {
    const t = p.tracks[trackId]
    const pattern = t?.activePatternId ? p.patterns[t.activePatternId] : undefined
    if (pattern) pattern.swing = swing
  })
}

export function clearPattern(trackId: TrackId): void {
  change('Borrar patrón', (p) => {
    const t = p.tracks[trackId]
    const pattern = t?.activePatternId ? p.patterns[t.activePatternId] : undefined
    if (pattern) pattern.notes = []
  })
}

// --- Proyecto --------------------------------------------------------------

export function setBpm(bpm: number): void {
  change('BPM', (p) => {
    p.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, bpm))
  })
}

export function setMetronome(enabled: boolean): void {
  change('Metrónomo', (p) => {
    p.metronome.enabled = enabled
  })
}
