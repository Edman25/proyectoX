/**
 * Modelo de datos del proyecto. Es JSON puro (sin AudioBuffers ni clases):
 * se puede guardar, clonar y versionar tal cual. El audio vive en IndexedDB
 * y se referencia por AssetId.
 *
 * Unidades:
 *  - tiempo musical en ticks (ver time.ts), siempre enteros dentro del proyecto
 *  - posiciones dentro de un audio en frames (muestras por canal)
 *  - alturas como número de nota MIDI (0–127, 60 = C4)
 *  - velocity 1–127, como en MIDI
 */
import type {
  AssetId,
  ClipId,
  ControlId,
  ControllerProfileId,
  NoteId,
  PadId,
  PatternId,
  ProjectId,
  SliceId,
  TrackId,
} from './ids'
import type { Ticks, TimeSignature } from './time'

export const PROJECT_FORMAT_VERSION = 1

// ---------------------------------------------------------------------------
// Biblioteca de samples
// ---------------------------------------------------------------------------

export type AssetOrigin =
  | { kind: 'imported'; fileName: string }
  /** Creado al consolidar slices/rangos (merge no contiguo, tira de chops). */
  | { kind: 'consolidated'; from: SampleRef[] }

export interface SampleAsset {
  id: AssetId
  name: string
  /** Clave del audio decodificado en IndexedDB. */
  storageKey: string
  sampleRate: number
  channels: number
  /** Duración en frames. */
  frames: number
  /** BPM original si se conoce (detectado o puesto a mano). */
  bpm: number | null
  /** Nota raíz si se conoce (para el Sampler). */
  rootNote: number | null
  origin: AssetOrigin
  /**
   * Slices no destructivos sobre este audio, ordenados por `start`.
   * Pueden tener huecos entre sí pero no se traslapan.
   */
  slices: Slice[]
}

/** Ajustes de reproducción de una porción de audio. Neutro = DEFAULT_PLAYBACK. */
export interface PlaybackOptions {
  gainDb: number
  /** Semitonos, se permiten fracciones (cents). */
  pitch: number
  reverse: boolean
  fadeInMs: number
  fadeOutMs: number
}

export interface Slice {
  id: SliceId
  /** Frame inicial (incluido). */
  start: number
  /** Frame final (excluido). */
  end: number
  playback: PlaybackOptions
}

/**
 * Referencia a una porción de audio. `slice` sigue al slice: si mueves sus
 * marcadores, todo lo que lo usa se actualiza.
 */
export type SampleRef =
  | { kind: 'asset'; assetId: AssetId }
  | { kind: 'slice'; assetId: AssetId; sliceId: SliceId }
  | { kind: 'range'; assetId: AssetId; start: number; end: number }

// ---------------------------------------------------------------------------
// Pistas
// ---------------------------------------------------------------------------

/**
 * Efectos del canal, en este orden: filtro (inserto) → paneo → envíos a
 * delay y reverb (se suman a la señal seca). Opcional: sin `fx`, no hay efectos.
 */
export interface ChannelFx {
  filter: { enabled: boolean; type: 'lowpass' | 'highpass'; cutoffHz: number; q: number }
  /** Delay sincronizado al tempo. `mix` es el nivel del envío (0–1). */
  delay: { enabled: boolean; timeTicks: Ticks; feedback: number; mix: number }
  /** Reverb con respuesta generada de `sizeSec` de cola. */
  reverb: { enabled: boolean; sizeSec: number; mix: number }
}

export interface MixerChannel {
  volumeDb: number
  /** -1 (izquierda) a 1 (derecha). */
  pan: number
  mute: boolean
  solo: boolean
  fx?: ChannelFx
}

/** one-shot: suena completo aunque sueltes. gate: se corta (con release) al soltar. */
export type TriggerMode = 'oneShot' | 'gate'

interface TrackBase {
  id: TrackId
  name: string
  color: string
  mixer: MixerChannel
  /** Armada para grabar: recibe notas en la próxima toma. */
  armed: boolean
  /** Patrón que suena en modo loop/patrón. */
  activePatternId: PatternId | null
}

export interface DrumPad {
  id: PadId
  sample: SampleRef | null
  playback: PlaybackOptions
  /** Pads del mismo grupo se cortan entre sí (hi-hat abierto/cerrado). */
  chokeGroup: number | null
  triggerMode: TriggerMode
}

/** Nota que dispara el pad i = baseNote + i. */
export interface DrumRackTrack extends TrackBase {
  kind: 'drumRack'
  baseNote: number
  pads: DrumPad[]
}

/** Nota que dispara el slice i del asset = baseNote + i. Usa los slices del asset. */
export interface SlicerTrack extends TrackBase {
  kind: 'slicer'
  assetId: AssetId | null
  baseNote: number
  triggerMode: TriggerMode
  /** Si es true, un slice nuevo corta al anterior (como un solo choke group). */
  monophonic: boolean
}

export interface Envelope {
  attackMs: number
  decayMs: number
  /** 0–1 */
  sustain: number
  releaseMs: number
}

/**
 * resample: cambiar el tono cambia la velocidad (y la duración). Tiempo real.
 * preserve: cambia el tono sin cambiar la duración. Usa renders pre-calculados.
 */
export type PitchMode = 'resample' | 'preserve'

export interface SamplerTrack extends TrackBase {
  kind: 'sampler'
  sample: SampleRef | null
  /** Nota en la que el sample suena sin transponer. */
  rootNote: number
  pitchMode: PitchMode
  playback: PlaybackOptions
  envelope: Envelope
  /** Loop de sostenido, en frames relativos al inicio de la porción referida. */
  loop: { enabled: boolean; start: number; end: number }
  voiceMode: 'poly' | 'mono'
  maxVoices: number
  /** Solo en mono. */
  glideMs: number
}

/** Pista de audio: sus clips viven en el arreglo. */
export interface AudioTrack extends TrackBase {
  kind: 'audio'
}

export type Track = DrumRackTrack | SlicerTrack | SamplerTrack | AudioTrack
export type TrackKind = Track['kind']

// ---------------------------------------------------------------------------
// Patrones y notas
// ---------------------------------------------------------------------------

export interface Note {
  id: NoteId
  tick: Ticks
  durationTicks: Ticks
  pitch: number
  velocity: number
  /**
   * Timing tal como se grabó. Cuantizar calcula a partir de aquí, así se
   * puede re-cuantizar con otra intensidad sin perder el original. Se borra
   * si el usuario mueve la nota a mano.
   */
  recorded?: { tick: Ticks; durationTicks: Ticks }
}

export interface Pattern {
  id: PatternId
  trackId: TrackId
  name: string
  lengthTicks: Ticks
  notes: Note[]
  /** 0 = recto. 0.5 ≈ 66% estilo MPC. Se aplica al reproducir, no modifica notas. */
  swing: number
  /** Rejilla a la que se aplica el swing (p. ej. gridTicks(16)). */
  swingGridTicks: Ticks
}

// ---------------------------------------------------------------------------
// Arreglo (línea de tiempo)
// ---------------------------------------------------------------------------

export interface PatternClip {
  id: ClipId
  kind: 'pattern'
  trackId: TrackId
  patternId: PatternId
  startTick: Ticks
  lengthTicks: Ticks
  /** Desde qué punto del patrón empieza (el patrón se repite dentro del clip). */
  offsetTicks: Ticks
}

export interface Warp {
  /** off: se reproduce tal cual. resample/preserve: se ajusta al BPM del proyecto. */
  mode: 'off' | PitchMode
  sourceBpm: number | null
  semitones: number
}

export interface AudioClip {
  id: ClipId
  kind: 'audio'
  trackId: TrackId
  sample: SampleRef
  startTick: Ticks
  lengthTicks: Ticks
  offsetTicks: Ticks
  warp: Warp
  gainDb: number
}

export type ArrangementClip = PatternClip | AudioClip

// ---------------------------------------------------------------------------
// Controladores
// ---------------------------------------------------------------------------

/** A qué suena una nota: una pista y una altura (que la pista interpreta). */
export interface NoteTarget {
  trackId: TrackId
  pitch: number
}

/**
 * Lo que el proyecto decide sobre un controlador: a dónde va cada pad.
 * La disposición física del controlador (qué nota manda cada pad) es global
 * y vive en ControllerProfile.
 */
export interface ControllerAssignment {
  profileId: ControllerProfileId
  /** Pads/botones de nota → destino. Los no listados siguen la regla por defecto. */
  padTargets: Partial<Record<ControlId, NoteTarget>>
  /** A dónde van las teclas (y pads sin destino). null = pista seleccionada. */
  defaultTrackId: TrackId | null
  /** Perillas/faders → parámetro (MIDI learn, solo control en vivo). */
  knobTargets?: Partial<Record<ControlId, ParamTarget>>
}

/** Parámetro que puede mover una perilla. `trackId` null = master. */
export type ParamTarget =
  | { param: 'volume' | 'pan'; trackId: TrackId | null }
  | { param: 'filterCutoff' | 'delayMix' | 'reverbMix'; trackId: TrackId }

// ---------------------------------------------------------------------------
// Proyecto
// ---------------------------------------------------------------------------

export interface MetronomeSettings {
  enabled: boolean
  countInBars: number
  volumeDb: number
  /** null = clic generado. */
  sample: SampleRef | null
}

export type RecordMode = 'overdub' | 'replace' | 'linear'

export interface NoteRepeatSettings {
  enabled: boolean
  /** Ticks entre repeticiones. */
  intervalTicks: Ticks
}

export type TransportMode = 'pattern' | 'song'

export interface Project {
  formatVersion: typeof PROJECT_FORMAT_VERSION
  id: ProjectId
  name: string
  bpm: number
  timeSignature: TimeSignature
  transportMode: TransportMode
  /** Región de loop en modo canción. */
  songLoop: { enabled: boolean; startTick: Ticks; endTick: Ticks }
  metronome: MetronomeSettings
  recordMode: RecordMode
  noteRepeat: NoteRepeatSettings
  /** Los ids de la biblioteca que usa el proyecto. */
  assets: Record<AssetId, SampleAsset>
  /** Orden visual de las pistas. */
  trackOrder: TrackId[]
  tracks: Record<TrackId, Track>
  patterns: Record<PatternId, Pattern>
  clips: Record<ClipId, ArrangementClip>
  controllers: ControllerAssignment[]
  /** `limiter`: limitador al final para que la mezcla no sature (por defecto, activo). */
  master: { volumeDb: number; limiter?: boolean }
}
