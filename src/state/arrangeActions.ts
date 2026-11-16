/**
 * Fase 6: patrones por pista, arreglo (clips en la línea de tiempo), pistas
 * de audio y consolidar (tira de chops). Cada cambio al proyecto es un paso
 * de deshacer.
 */
import { createAsset, getLoadedAudio } from '../audio/library'
import {
  PPQ,
  consolidate,
  createAudioTrack,
  createPattern,
  newId,
  ticksPerBar,
  type AudioClip,
  type ClipId,
  type PatternClip,
  type PatternId,
  type Project,
  type SampleAsset,
  type SampleRef,
  type Segment,
  type TrackId,
  type Warp,
} from '../model'
import { slicesFromBoundaries } from '../model/sliceOps'
import { getProject, useApp } from './store'

const { change, setUi } = useApp.getState()

function bar(p: Project): number {
  return ticksPerBar(p.timeSignature)
}

// --- Modo ------------------------------------------------------------------

export function setTransportMode(mode: 'pattern' | 'song'): void {
  change(mode === 'song' ? 'Modo canción' : 'Modo patrón', (p) => {
    p.transportMode = mode
    // La grabación lineal solo tiene sentido con línea de tiempo.
    if (mode === 'pattern' && p.recordMode === 'linear') p.recordMode = 'overdub'
  })
}

export function setSongLoop(patch: Partial<Project['songLoop']>): void {
  change('Loop de canción', (p) => {
    Object.assign(p.songLoop, patch)
    if (p.songLoop.endTick < p.songLoop.startTick) {
      ;[p.songLoop.startTick, p.songLoop.endTick] = [p.songLoop.endTick, p.songLoop.startTick]
    }
  })
}

// --- Patrones --------------------------------------------------------------

export function patternsOf(p: Project, trackId: TrackId) {
  return Object.values(p.patterns).filter((pt) => pt.trackId === trackId)
}

export function selectPattern(trackId: TrackId, patternId: PatternId): void {
  change('Elegir patrón', (p) => {
    const t = p.tracks[trackId]
    if (t) t.activePatternId = patternId
  })
}

export function newPattern(trackId: TrackId, duplicateOf?: PatternId): void {
  const project = getProject()
  const count = patternsOf(project, trackId).length
  const source = duplicateOf ? project.patterns[duplicateOf] : undefined
  const fresh = createPattern(trackId, project.timeSignature, 1)
  const pattern = source
    ? { ...source, id: fresh.id, name: `${source.name} (copia)`, notes: source.notes.map((n) => ({ ...n, id: newId<typeof n.id>() })) }
    : { ...fresh, name: `Patrón ${count + 1}` }
  change(source ? 'Duplicar patrón' : 'Patrón nuevo', (p) => {
    p.patterns[pattern.id] = pattern
    const t = p.tracks[trackId]
    if (t) t.activePatternId = pattern.id
  })
}

export function renamePattern(patternId: PatternId, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  change('Renombrar patrón', (p) => {
    const pt = p.patterns[patternId]
    if (pt) pt.name = trimmed
  })
}

// --- Clips -----------------------------------------------------------------

export function snapTick(tick: number, grid: number): number {
  return Math.max(0, Math.round(tick / grid) * grid)
}

/** Clip del patrón activo de la pista en `tick` (redondeado al compás). */
export function addPatternClip(trackId: TrackId, tick: number): ClipId | null {
  const p = getProject()
  const track = p.tracks[trackId]
  const pattern = track?.activePatternId ? p.patterns[track.activePatternId] : undefined
  if (!track || track.kind === 'audio' || !pattern) return null
  const clip: PatternClip = {
    id: newId<ClipId>(),
    kind: 'pattern',
    trackId,
    patternId: pattern.id,
    startTick: Math.floor(tick / bar(p)) * bar(p),
    lengthTicks: pattern.lengthTicks,
    offsetTicks: 0,
  }
  change('Clip de patrón', (d) => {
    d.clips[clip.id] = clip
  })
  setUi({ selectedClipIds: [clip.id] })
  return clip.id
}

/** Largo musical de un audio: con BPM conocido, al BPM de origen; si no, al del proyecto. */
export function audioLengthTicks(p: Project, asset: SampleAsset, start = 0, end = asset.frames): number {
  const sec = (end - start) / asset.sampleRate
  return Math.max(1, Math.round((sec * (asset.bpm ?? p.bpm) * PPQ) / 60))
}

export function addAudioClip(trackId: TrackId, sample: SampleRef, tick: number): ClipId | null {
  const p = getProject()
  const asset = p.assets[sample.assetId]
  if (p.tracks[trackId]?.kind !== 'audio' || !asset) return null
  let start = 0
  let end = asset.frames
  if (sample.kind === 'slice') {
    const s = asset.slices.find((x) => x.id === sample.sliceId)
    if (s) ({ start, end } = s)
  } else if (sample.kind === 'range') ({ start, end } = sample)
  const warp: Warp = asset.bpm ? { mode: 'preserve', sourceBpm: null, semitones: 0 } : { mode: 'off', sourceBpm: null, semitones: 0 }
  const clip: AudioClip = {
    id: newId<ClipId>(),
    kind: 'audio',
    trackId,
    sample,
    startTick: snapTick(tick, PPQ),
    lengthTicks: audioLengthTicks(p, asset, start, end),
    offsetTicks: 0,
    warp,
    gainDb: 0,
  }
  change('Clip de audio', (d) => {
    d.clips[clip.id] = clip
  })
  setUi({ selectedClipIds: [clip.id] })
  return clip.id
}

export function moveClips(edits: { id: ClipId; startTick: number; trackId?: TrackId | undefined }[]): void {
  change('Mover clips', (p) => {
    for (const e of edits) {
      const c = p.clips[e.id]
      if (!c) continue
      c.startTick = Math.max(0, Math.round(e.startTick))
      // Solo se cambia de pista si la nueva es del mismo tipo (notas ↔ notas, audio ↔ audio).
      const to = e.trackId ? p.tracks[e.trackId] : undefined
      if (to && (to.kind === 'audio') === (c.kind === 'audio')) {
        if (c.kind === 'pattern' && to.kind !== 'audio') {
          // El patrón pertenece a su pista: al mover el clip a otra, se queda en la suya.
          if (p.patterns[c.patternId]?.trackId === to.id) c.trackId = to.id
        } else c.trackId = to.id
      }
    }
  })
}

export function resizeClip(id: ClipId, lengthTicks: number): void {
  change('Largo del clip', (p) => {
    const c = p.clips[id]
    if (c) c.lengthTicks = Math.max(PPQ / 4, Math.round(lengthTicks))
  })
}

export function deleteClips(ids: readonly ClipId[]): void {
  change('Borrar clips', (p) => {
    for (const id of ids) delete p.clips[id]
  })
  setUi({ selectedClipIds: [] })
}

/** Duplica los clips justo después de sí mismos. */
export function duplicateClips(ids: readonly ClipId[]): void {
  const p = getProject()
  const copies = ids.flatMap((id) => {
    const c = p.clips[id]
    return c ? [{ ...c, id: newId<ClipId>(), startTick: c.startTick + c.lengthTicks }] : []
  })
  change('Duplicar clips', (d) => {
    for (const c of copies) d.clips[c.id] = c
  })
  setUi({ selectedClipIds: copies.map((c) => c.id) })
}

export function setClipPattern(id: ClipId, patternId: PatternId): void {
  change('Patrón del clip', (p) => {
    const c = p.clips[id]
    if (c?.kind === 'pattern') c.patternId = patternId
  })
}

export function updateAudioClip(id: ClipId, label: string, patch: (c: AudioClip) => void): void {
  change(label, (p) => {
    const c = p.clips[id]
    if (c?.kind === 'audio') patch(c as AudioClip)
  })
}

export function addAudioTrack(): TrackId {
  const p = getProject()
  const n = Object.values(p.tracks).filter((t) => t.kind === 'audio').length
  const track = createAudioTrack(n ? `Audio ${n + 1}` : 'Audio')
  change('Pista de audio', (d) => {
    d.tracks[track.id] = track
    d.trackOrder.push(track.id)
  })
  setUi({ selectedTrackId: track.id, view: 'arrange' })
  return track.id
}

// --- Consolidar ------------------------------------------------------------

/**
 * Une los slices dados (de uno o varios samples, en ese orden) en un sample
 * nuevo, ya cortado en las mismas porciones. Devuelve el asset creado.
 */
export async function consolidateSlices(refs: readonly Extract<SampleRef, { kind: 'slice' }>[], name: string): Promise<SampleAsset | null> {
  const p = getProject()
  const segments: Segment[] = []
  let sampleRate = 0
  for (const ref of refs) {
    const asset = p.assets[ref.assetId]
    const slice = asset?.slices.find((s) => s.id === ref.sliceId)
    const audio = getLoadedAudio(ref.assetId)
    if (!asset || !slice || !audio) continue
    sampleRate ||= audio.buffer.sampleRate
    const channels = Array.from({ length: audio.buffer.numberOfChannels }, (_, c) => audio.buffer.getChannelData(c))
    segments.push({ channels, start: slice.start, end: slice.end, playback: slice.playback })
  }
  if (!segments.length || !sampleRate) return null
  const { channels, boundaries } = consolidate(segments, sampleRate)
  const asset = await createAsset(name, channels as Float32Array<ArrayBuffer>[], sampleRate, { kind: 'consolidated', from: [...refs] })
  // Si todo viene de samples con el mismo BPM, el nuevo lo hereda.
  const bpms = new Set(refs.map((r) => p.assets[r.assetId]?.bpm ?? null))
  const bpm = bpms.size === 1 ? [...bpms][0]! : null
  const full: SampleAsset = { ...asset, bpm, slices: slicesFromBoundaries(asset.frames, boundaries) }
  change(`Consolidar ${name}`, (d) => {
    d.assets[full.id] = full
  })
  setUi({ selectedAssetId: full.id, selectedSliceIds: [], view: 'sample', padBank: 0 })
  return full
}

// --- Tira de chops (estado de trabajo, no se deshace) -----------------------

export function addToStrip(refs: readonly Extract<SampleRef, { kind: 'slice' }>[]): void {
  const { ui } = useApp.getState()
  setUi({ chopStrip: [...ui.chopStrip, ...refs] })
}

export function moveInStrip(index: number, to: number): void {
  const strip = [...useApp.getState().ui.chopStrip]
  const [item] = strip.splice(index, 1)
  if (!item) return
  strip.splice(Math.max(0, Math.min(strip.length, to)), 0, item)
  setUi({ chopStrip: strip })
}

export function removeFromStrip(index: number): void {
  setUi({ chopStrip: useApp.getState().ui.chopStrip.filter((_, i) => i !== index) })
}

export function clearStrip(): void {
  setUi({ chopStrip: [] })
}
