/**
 * Acciones de la fase 2: pistas, pads, patrones y transporte. Cada una es un
 * paso de deshacer.
 */
import type { Draft } from 'immer'
import { quantizePattern } from '../engine'
import {
  MAX_BPM,
  MIN_BPM,
  createDrumRack,
  createPattern,
  createSamplerTrack,
  createSlicerTrack,
  newId,
  ticksPerBar,
  type AssetId,
  type ControlId,
  type ControllerProfileId,
  type MixerChannel,
  type NoteTarget,
  type Project,
  type NoteId,
  type SampleRef,
  type SamplerTrack,
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

// --- Grabación -------------------------------------------------------------

export function toggleArm(id: TrackId): void {
  change('Armar pista', (p) => {
    const t = p.tracks[id]
    if (t) t.armed = !t.armed
  })
}

export function setRecordMode(mode: 'overdub' | 'replace' | 'linear'): void {
  change('Modo de grabación', (p) => {
    p.recordMode = mode
  })
}

export function setCountIn(bars: number): void {
  change('Cuenta previa', (p) => {
    p.metronome.countInBars = bars
  })
}

export function setNoteRepeat(patch: Partial<{ enabled: boolean; intervalTicks: number }>): void {
  change('Note repeat', (p) => {
    Object.assign(p.noteRepeat, patch)
  })
}

export function quantizeTrack(trackId: TrackId, grid: number, strength: number, noteIds?: readonly NoteId[]): void {
  const project = getProject()
  const t = project.tracks[trackId]
  const pattern = t?.activePatternId ? project.patterns[t.activePatternId] : undefined
  if (!pattern) return
  const next = quantizePattern(project, pattern.id, { gridTicks: grid, strength, swing: pattern.swing }, noteIds)
  useApp.getState().replace('Cuantizar', next)
}

// --- Notas (piano roll) ----------------------------------------------------

export interface NoteEdit {
  id: NoteId
  tick: number
  durationTicks: number
  pitch: number
}

export function addNote(trackId: TrackId, tick: number, durationTicks: number, pitch: number, velocity = 100): NoteId | null {
  const id = newId<NoteId>()
  let ok = false
  change('Nota', (p) => {
    const t = p.tracks[trackId]
    const pattern = t?.activePatternId ? p.patterns[t.activePatternId] : undefined
    if (!pattern) return
    pattern.notes.push({ id, tick: Math.round(tick), durationTicks: Math.max(1, Math.round(durationTicks)), pitch, velocity })
    ok = true
  })
  return ok ? id : null
}

/** Mueve/redimensiona notas. Una nota movida a mano pierde su timing grabado. */
export function editNotes(trackId: TrackId, edits: readonly NoteEdit[], label: string): void {
  const byId = new Map(edits.map((e) => [e.id, e]))
  change(label, (p) => {
    const t = p.tracks[trackId]
    const pattern = t?.activePatternId ? p.patterns[t.activePatternId] : undefined
    if (!pattern) return
    for (const n of pattern.notes) {
      const e = byId.get(n.id)
      if (!e) continue
      n.tick = Math.round(e.tick)
      n.durationTicks = Math.max(1, Math.round(e.durationTicks))
      n.pitch = e.pitch
      delete n.recorded
    }
  })
}

export function deleteNotes(trackId: TrackId, ids: readonly NoteId[]): void {
  const set = new Set(ids)
  change('Borrar notas', (p) => {
    const t = p.tracks[trackId]
    const pattern = t?.activePatternId ? p.patterns[t.activePatternId] : undefined
    if (pattern) pattern.notes = pattern.notes.filter((n) => !set.has(n.id))
  })
}

export function setNotesVelocity(trackId: TrackId, ids: readonly NoteId[], velocity: number): void {
  const set = new Set(ids)
  change('Velocity', (p) => {
    const t = p.tracks[trackId]
    const pattern = t?.activePatternId ? p.patterns[t.activePatternId] : undefined
    for (const n of pattern?.notes ?? []) if (set.has(n.id)) n.velocity = Math.min(127, Math.max(1, Math.round(velocity)))
  })
}

// --- Controladores (lo que decide el proyecto) -----------------------------

function assignmentFor(p: Draft<Project>, profileId: ControllerProfileId) {
  let a = p.controllers.find((c) => c.profileId === profileId)
  if (!a) {
    p.controllers.push({ profileId, padTargets: {}, defaultTrackId: null })
    a = p.controllers.at(-1)!
  }
  return a
}

export function setPadTarget(profileId: ControllerProfileId, controlId: ControlId, target: NoteTarget | null): void {
  change('Destino del pad', (p) => {
    const a = assignmentFor(p, profileId)
    if (target) a.padTargets[controlId] = target
    else delete a.padTargets[controlId]
  })
}

export function setControllerDefaultTrack(profileId: ControllerProfileId, trackId: TrackId | null): void {
  change('Pista del controlador', (p) => {
    assignmentFor(p, profileId).defaultTrackId = trackId
  })
}

// --- Sampler ---------------------------------------------------------------

export function addSampler(sample: SampleRef | null, name = 'Sampler'): void {
  const project = getProject()
  const rootNote = sample ? (project.assets[sample.assetId]?.rootNote ?? undefined) : undefined
  addTrack(createSamplerTrack(nextName(name), sample, rootNote), 'Nuevo sampler')
  useApp.getState().setUi({ trackEditor: 'roll' })
}

/** Cambia la configuración de un Sampler. `label` agrupa el paso de deshacer. */
export function updateSampler(id: TrackId, label: string, patch: (t: Draft<SamplerTrack>) => void): void {
  change(label, (p) => {
    const t = p.tracks[id]
    if (t?.kind === 'sampler') patch(t)
  })
}

/** Sampler con lo seleccionado: el slice elegido, o el sample completo. */
export function addSamplerFromSelection(): void {
  const { ui } = useApp.getState()
  const asset = ui.selectedAssetId ? getProject().assets[ui.selectedAssetId] : undefined
  if (!asset) return addSampler(null)
  const sliceId = ui.selectedSliceIds.length === 1 ? ui.selectedSliceIds[0] : undefined
  const index = sliceId ? asset.slices.findIndex((s) => s.id === sliceId) : -1
  if (sliceId && index >= 0) addSampler({ kind: 'slice', assetId: asset.id, sliceId }, `${asset.name} ${index + 1}`)
  else addSampler({ kind: 'asset', assetId: asset.id }, asset.name)
}
