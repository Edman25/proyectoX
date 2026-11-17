import { newId, type AssetId, type PadId, type PatternId, type ProjectId, type TrackId } from './ids'
import {
  PROJECT_FORMAT_VERSION,
  type DrumPad,
  type DrumRackTrack,
  type Envelope,
  type MixerChannel,
  type Pattern,
  type PlaybackOptions,
  type Project,
  type AudioTrack,
  type ChannelFx,
  type SampleRef,
  type SamplerTrack,
  type SlicerTrack,
} from './project'
import { gridTicks, ticksPerBar, type TimeSignature } from './time'

export const DEFAULT_PLAYBACK: Readonly<PlaybackOptions> = {
  gainDb: 0,
  pitch: 0,
  reverse: false,
  fadeInMs: 0,
  fadeOutMs: 0,
}

/** Micro-fade mínimo en bordes de slice para evitar clicks. */
export const EDGE_FADE_MS = 2

export const DEFAULT_ENVELOPE: Readonly<Envelope> = {
  attackMs: 1,
  decayMs: 0,
  sustain: 1,
  releaseMs: 30,
}

export function defaultFx(): ChannelFx {
  return {
    filter: { enabled: false, type: 'lowpass', cutoffHz: 18000, q: 0.7 },
    delay: { enabled: false, timeTicks: 720, feedback: 0.35, mix: 0.3 },
    reverb: { enabled: false, sizeSec: 2, mix: 0.25 },
  }
}

export const DEFAULT_MIXER: Readonly<MixerChannel> = {
  volumeDb: 0,
  pan: 0,
  mute: false,
  solo: false,
}

/** C1 en la convención donde 60 = C4: la base habitual de pads de batería. */
export const DEFAULT_PAD_BASE_NOTE = 36

export function createDrumPad(): DrumPad {
  return {
    id: newId<PadId>(),
    sample: null,
    playback: { ...DEFAULT_PLAYBACK },
    chokeGroup: null,
    triggerMode: 'oneShot',
  }
}

export function createDrumRack(name: string, padCount = 16): DrumRackTrack {
  return {
    id: newId<TrackId>(),
    kind: 'drumRack',
    name,
    color: '#e8a33d',
    mixer: { ...DEFAULT_MIXER },
    armed: false,
    activePatternId: null,
    baseNote: DEFAULT_PAD_BASE_NOTE,
    pads: Array.from({ length: padCount }, createDrumPad),
  }
}

export function createSlicerTrack(name: string, assetId: AssetId | null): SlicerTrack {
  return {
    id: newId<TrackId>(),
    kind: 'slicer',
    name,
    color: '#5fb3f0',
    mixer: { ...DEFAULT_MIXER },
    armed: false,
    activePatternId: null,
    assetId,
    baseNote: DEFAULT_PAD_BASE_NOTE,
    triggerMode: 'oneShot',
    monophonic: false,
  }
}

export function createAudioTrack(name: string): AudioTrack {
  return {
    id: newId<TrackId>(),
    kind: 'audio',
    name,
    color: '#6fd19a',
    mixer: { ...DEFAULT_MIXER },
    armed: false,
    activePatternId: null,
  }
}

/** C3 en la convención donde 60 = C4: raíz por defecto del Sampler. */
export const DEFAULT_ROOT_NOTE = 48

export function createSamplerTrack(name: string, sample: SampleRef | null, rootNote = DEFAULT_ROOT_NOTE): SamplerTrack {
  return {
    id: newId<TrackId>(),
    kind: 'sampler',
    name,
    color: '#9b7cf0',
    mixer: { ...DEFAULT_MIXER },
    armed: false,
    activePatternId: null,
    sample,
    rootNote,
    pitchMode: 'resample',
    playback: { ...DEFAULT_PLAYBACK },
    envelope: { ...DEFAULT_ENVELOPE },
    loop: { enabled: false, start: 0, end: 0 },
    voiceMode: 'poly',
    maxVoices: 16,
    glideMs: 0,
  }
}

export function createPattern(trackId: TrackId, ts: TimeSignature, bars = 1): Pattern {
  return {
    id: newId<PatternId>(),
    trackId,
    name: 'Patrón 1',
    lengthTicks: ticksPerBar(ts) * bars,
    notes: [],
    swing: 0,
    swingGridTicks: gridTicks(16),
  }
}

export function createEmptyProject(name = 'Sin título'): Project {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    id: newId<ProjectId>(),
    name,
    bpm: 90,
    timeSignature: { numerator: 4, denominator: 4 },
    transportMode: 'pattern',
    songLoop: { enabled: false, startTick: 0, endTick: 0 },
    metronome: { enabled: true, countInBars: 1, volumeDb: -6, sample: null },
    recordMode: 'overdub',
    noteRepeat: { enabled: false, intervalTicks: gridTicks(16) },
    assets: {},
    trackOrder: [],
    tracks: {},
    patterns: {},
    clips: {},
    controllers: [],
    master: { volumeDb: 0, limiter: true },
  }
}
