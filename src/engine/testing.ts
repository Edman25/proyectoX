/**
 * Utilidades para los tests del motor. No forman parte de la app: usan
 * node-web-audio-api (dependencia de desarrollo) como implementación de
 * Web Audio en Node.
 */
import { OfflineAudioContext as NodeOfflineAudioContext } from 'node-web-audio-api'
import {
  DEFAULT_ENVELOPE,
  DEFAULT_MIXER,
  DEFAULT_PLAYBACK,
  createDrumRack,
  createEmptyProject,
  createPattern,
  newId,
  type AssetId,
  type DrumRackTrack,
  type InstrumentEvent,
  type Note,
  type NoteId,
  type Pattern,
  type Project,
  type SampleAsset,
  type SamplerTrack,
  type SliceId,
  type SlicerTrack,
  type TrackId,
} from '../model'
import { Engine, type EngineOptions } from './engine'
import type { BufferProvider } from './sample'
import { ManualTimer } from './timer'

export const SR = 48000

export function offlineContext(seconds: number, channels = 2, sampleRate = SR): OfflineAudioContext {
  const ctx = new NodeOfflineAudioContext(channels, Math.ceil(seconds * sampleRate), sampleRate)
  return ctx as unknown as OfflineAudioContext
}

/** Proveedor de buffers en memoria. */
export class MemoryBuffers implements BufferProvider {
  private readonly map = new Map<AssetId, AudioBuffer>()

  set(assetId: AssetId, buffer: AudioBuffer): void {
    this.map.set(assetId, buffer)
  }

  getBuffer(assetId: AssetId): AudioBuffer | undefined {
    return this.map.get(assetId)
  }
}

/** Buffer mono con las muestras dadas. */
export function bufferOf(ctx: BaseAudioContext, samples: ArrayLike<number>): AudioBuffer {
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
  buffer.copyToChannel(Float32Array.from(samples), 0)
  return buffer
}

/** Un impulso (1.0) en el frame 0 seguido de silencio. */
export function impulse(ctx: BaseAudioContext, frames = 64): AudioBuffer {
  const data = new Float32Array(frames)
  data[0] = 1
  return bufferOf(ctx, data)
}

/** Señal constante (DC) de `frames` muestras: sirve para medir duraciones. */
export function dc(ctx: BaseAudioContext, frames: number, value = 1): AudioBuffer {
  return bufferOf(ctx, new Float32Array(frames).fill(value))
}

export function assetFor(buffer: AudioBuffer, name = 'test'): SampleAsset {
  return {
    id: newId<AssetId>(),
    name,
    storageKey: name,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    frames: buffer.length,
    bpm: null,
    rootNote: null,
    origin: { kind: 'imported', fileName: `${name}.wav` },
    slices: [],
  }
}

export function note(tick: number, pitch = 36, durationTicks = 120, velocity = 127): Note {
  return { id: newId<NoteId>(), tick, durationTicks, pitch, velocity }
}

/** Paneo a la izquierda: el canal 0 del render lleva el nivel exacto (sin los -3 dB del centro). */
const LEFT = { ...DEFAULT_MIXER, pan: -1 }

/** Constructor de proyectos de prueba. Slicer y Sampler salen paneados a la izquierda. */
export class ProjectBuilder {
  project: Project
  readonly buffers = new MemoryBuffers()
  private readonly ctx: BaseAudioContext

  constructor(ctx: BaseAudioContext, bpm = 120) {
    this.ctx = ctx
    this.project = { ...createEmptyProject('test'), bpm }
    this.project.metronome = { ...this.project.metronome, enabled: false, countInBars: 0 }
    // Los tests miden el motor tal cual: sin la protección del master.
    this.project.master = { ...this.project.master, limiter: false }
  }

  asset(buffer: AudioBuffer, sliceBounds: [number, number][] = []): SampleAsset {
    const asset = assetFor(buffer)
    asset.slices = sliceBounds.map(([start, end]) => ({
      id: newId<SliceId>(),
      start,
      end,
      playback: { ...DEFAULT_PLAYBACK },
    }))
    this.project.assets[asset.id] = asset
    this.buffers.set(asset.id, buffer)
    return asset
  }

  /** Drum rack cuyos pads tocan, cada uno, el asset completo dado (por defecto un impulso). */
  drumRack(padBuffers?: AudioBuffer[], padCount = 4): DrumRackTrack {
    const track = createDrumRack('Drums', padCount)
    const sources = padBuffers ?? Array.from({ length: padCount }, () => impulse(this.ctx))
    sources.forEach((buffer, i) => {
      const pad = track.pads[i]
      if (pad) pad.sample = { kind: 'asset', assetId: this.asset(buffer).id }
    })
    return this.track(track)
  }

  slicer(asset: SampleAsset): SlicerTrack {
    return this.track({
      id: newId<TrackId>(),
      kind: 'slicer',
      name: 'Slicer',
      color: '#fff',
      mixer: { ...LEFT },
      armed: false,
      activePatternId: null,
      assetId: asset.id,
      baseNote: 36,
      triggerMode: 'oneShot',
      monophonic: false,
    })
  }

  sampler(asset: SampleAsset): SamplerTrack {
    return this.track({
      id: newId<TrackId>(),
      kind: 'sampler',
      name: 'Sampler',
      color: '#fff',
      mixer: { ...LEFT },
      armed: false,
      activePatternId: null,
      sample: { kind: 'asset', assetId: asset.id },
      rootNote: 60,
      pitchMode: 'resample',
      playback: { ...DEFAULT_PLAYBACK },
      envelope: { ...DEFAULT_ENVELOPE, attackMs: 0, releaseMs: 5 },
      loop: { enabled: false, start: 0, end: 0 },
      voiceMode: 'poly',
      maxVoices: 8,
      glideMs: 0,
    })
  }

  track<T extends Project['tracks'][TrackId]>(track: T): T {
    this.project.tracks[track.id] = track
    this.project.trackOrder.push(track.id)
    return track
  }

  /** Crea un patrón para la pista y lo deja como activo. */
  pattern(trackId: TrackId, notes: Note[], lengthTicks = 3840): Pattern {
    const pattern = { ...createPattern(trackId, this.project.timeSignature), lengthTicks, notes }
    this.project.patterns[pattern.id] = pattern
    const track = this.project.tracks[trackId]
    if (track) track.activePatternId = pattern.id
    return pattern
  }
}

export interface TestRig {
  ctx: OfflineAudioContext
  engine: Engine
  timer: ManualTimer
  events: InstrumentEvent[]
  /** Note-on del secuenciador, en orden de llegada. */
  ons(): { time: number; pitch: number; trackId: TrackId }[]
}

export function createRig(
  seconds: number,
  buffers: BufferProvider,
  options: Partial<EngineOptions> = {},
): TestRig {
  const ctx = offlineContext(seconds)
  const timer = new ManualTimer()
  const engine = new Engine({
    context: ctx,
    buffers,
    timer,
    startDelaySec: 0,
    metronomeOutput: null,
    ...options,
  })
  const events: InstrumentEvent[] = []
  engine.onEvent((e) => events.push(e))
  return {
    ctx,
    engine,
    timer,
    events,
    ons: () =>
      events.flatMap((e) =>
        e.type === 'noteOn' && e.source === 'sequencer'
          ? [{ time: e.time, pitch: e.target.pitch, trackId: e.target.trackId }]
          : [],
      ),
  }
}

/** Primer frame de cada tramo donde |señal| supera el umbral. */
export function onsets(data: Float32Array, threshold = 0.001, minGap = 8): number[] {
  const out: number[] = []
  let last = -Infinity
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]!) > threshold) {
      if (i - last > minGap) out.push(i)
      last = i
    }
  }
  return out
}

/** Último frame donde |señal| supera el umbral, o -1. */
export function lastActive(data: Float32Array, threshold = 0.001): number {
  for (let i = data.length - 1; i >= 0; i--) if (Math.abs(data[i]!) > threshold) return i
  return -1
}
