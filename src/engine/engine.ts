/**
 * El motor: transporte + scheduler lookahead + instrumentos + mixer.
 *
 * Funciona sobre cualquier BaseAudioContext. En vivo, un temporizador llama
 * a `pump()` cada ~25 ms y se programa lo que cae en los próximos ~100 ms
 * sobre el reloj de audio. En offline (o en tests) no hay temporizador:
 * se llama `advanceTo(t)` y todo queda programado de forma determinista.
 *
 * El proyecto entra como snapshots inmutables (`setProject`); se compara
 * por referencia y los cambios se aplican en caliente.
 *
 * Posición del transporte: una lista de segmentos (tiempo de audio → tick,
 * con su BPM). Un cambio de BPM o una vuelta del loop de canción abren un
 * segmento nuevo justo en el horizonte ya programado, así nunca se pierde
 * la fase ni se reordena nada de lo que ya está en cola.
 */
import {
  MAX_BPM,
  MIN_BPM,
  PPQ,
  ticksPerBar,
  type InstrumentEvent,
  type NoteTarget,
  type Project,
  type Track,
  type TrackId,
} from '../model'
import { AudioClipPlayer } from './audioClips'
import type { Instrument, InstrumentDeps } from './instruments/instrument'
import { DrumRackInstrument, SlicerInstrument } from './instruments/oneShot'
import { SamplerInstrument } from './instruments/sampler'
import { Metronome, beatsInWindow } from './metronome'
import { Mixer } from './mixer'
import { NO_RENDERS, type RenderCache } from './renderCache'
import { ReverseCache, type BufferProvider } from './sample'
import { collectNotes } from './sequence'
import { intervalTimer, type SchedulerTimer } from './timer'
import { clamp } from './util'

export const DEFAULT_LOOKAHEAD_SEC = 0.1
/** Un golpe del secuenciador que llega así de tarde (pestaña dormida) ya no se toca. */
const LATE_DROP_SEC = 0.1
/** Loop de canción mínimo (una fusa); más corto se ignora. */
const MIN_LOOP_TICKS = PPQ / 8
/** Historia de posición que se conserva para convertir tiempos pasados a ticks. */
const HISTORY_SEC = 30

export interface EngineOptions {
  context: BaseAudioContext
  buffers: BufferProvider
  /** Caché de renders (stretch / preserve). Por defecto, vacía. */
  renders?: RenderCache
  /** Temporizador del scheduler. Por defecto setInterval de 25 ms. */
  timer?: SchedulerTimer
  lookaheadSec?: number
  /** Margen entre `play()` y el primer golpe, para que no salga tarde. */
  startDelaySec?: number
  /** A dónde va el metrónomo. Por defecto la salida; null = sin metrónomo. */
  metronomeOutput?: AudioNode | null
}

export interface PlayOptions {
  /** Posición donde arranca la música. */
  fromTick?: number
  /** Compases de cuenta previa (solo metrónomo) antes de `fromTick`. */
  countInBars?: number
}

export interface PlayInfo {
  /** Tiempo de audio en que arranca el transporte (inicio del count-in). */
  startTime: number
  /** Tiempo de audio en que la posición llega a `fromTick`. */
  musicStartTime: number
  fromTick: number
}

export interface TransportPosition {
  playing: boolean
  /** Posición en ticks. Negativa (o menor que fromTick) durante el count-in. */
  tick: number
  countingIn: boolean
  bpm: number
}

export interface GridPoint {
  time: number
  tick: number
}

/** Lo que el grabador y el note repeat necesitan saber del transporte. */
export interface TransportClock {
  readonly isPlaying: boolean
  /** Posición (con vueltas de loop) en un tiempo de audio. null si está parado. */
  tickAtTime(time: number): number | null
  /** Ticks transcurridos desde que arrancó la música, sin vueltas. null si está parado. */
  linearTickAtTime(time: number): number | null
  /** Puntos de la rejilla (múltiplos de `intervalTicks`) en [t0, t1). */
  gridTimesBetween(t0: number, t1: number, intervalTicks: number): GridPoint[]
}

interface Segment {
  time: number
  tick: number
  linear: number
  bpm: number
}

interface PendingOff {
  tick: number
  target: NoteTarget
}

interface Slot {
  kind: Track['kind']
  track: Track
  instrument: Instrument
}

function projectBpm(project: Project): number {
  return clamp(project.bpm, MIN_BPM, MAX_BPM)
}

export class Engine implements TransportClock {
  readonly context: BaseAudioContext
  private readonly timer: SchedulerTimer
  private readonly lookaheadSec: number
  private readonly startDelaySec: number
  private readonly buffers: BufferProvider
  private readonly renders: RenderCache
  private readonly reverse = new ReverseCache()
  private readonly mixer: Mixer
  private readonly metronome: Metronome | null
  private readonly audioClips: AudioClipPlayer
  private readonly slots = new Map<TrackId, Slot>()

  private project: Project | null = null
  private playing = false
  private segments: Segment[] = []
  /** Horizonte: hasta dónde está todo programado. */
  private cursorTime = 0
  private cursorTick = 0
  private playStartTick = 0
  private countInDone = true
  private stoppedTick = 0
  private pendingOffs: PendingOff[] = []
  private audioResync = false

  private readonly eventListeners = new Set<(event: InstrumentEvent) => void>()
  private readonly stateListeners = new Set<(playing: boolean) => void>()
  private readonly pumpListeners = new Set<(now: number) => void>()

  constructor(options: EngineOptions) {
    const ctx = options.context
    this.context = ctx
    this.buffers = options.buffers
    this.renders = options.renders ?? NO_RENDERS
    this.timer = options.timer ?? intervalTimer()
    this.lookaheadSec = options.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC
    this.startDelaySec = options.startDelaySec ?? 0.05
    this.mixer = new Mixer(ctx, ctx.destination)
    const metronomeOutput =
      options.metronomeOutput === undefined ? ctx.destination : options.metronomeOutput
    this.metronome = metronomeOutput
      ? new Metronome(ctx, metronomeOutput, this.buffers, this.reverse)
      : null
    this.audioClips = new AudioClipPlayer({
      ctx,
      buffers: this.buffers,
      renders: this.renders,
      reverse: this.reverse,
    })
  }

  // -------------------------------------------------------------------------
  // Proyecto
  // -------------------------------------------------------------------------

  getProject(): Project | null {
    return this.project
  }

  /** Nuevo snapshot del proyecto. Barato si nada relevante cambió. */
  setProject(project: Project): void {
    const prev = this.project
    if (project === prev) return
    this.project = project
    if (!prev || prev.tracks !== project.tracks || prev.master !== project.master) {
      this.mixer.sync(project)
      this.syncInstruments(project)
    }
    if (!this.playing || !prev) return
    if (projectBpm(prev) !== projectBpm(project)) {
      // El tempo cambia en el horizonte: lo ya programado no se mueve y lo
      // siguiente continúa desde el mismo tick.
      const last = this.lastSegment()
      this.segments.push({
        time: this.cursorTime,
        tick: this.cursorTick,
        linear: last.linear + (this.cursorTick - last.tick),
        bpm: projectBpm(project),
      })
      this.audioClips.setTempo(this.cursorTime, projectBpm(project))
    }
    if (prev.transportMode !== project.transportMode) this.flushOffs(this.cursorTime)
    if (
      prev.clips !== project.clips ||
      prev.tracks !== project.tracks ||
      prev.transportMode !== project.transportMode
    ) {
      this.audioResync = true
    }
  }

  private syncInstruments(project: Project): void {
    const now = this.context.currentTime
    for (const track of Object.values(project.tracks)) {
      const slot = this.slots.get(track.id)
      if (slot && slot.kind === track.kind) {
        if (slot.track !== track) {
          slot.track = track
          slot.instrument.setTrack(track)
        }
        continue
      }
      slot?.instrument.panic(now)
      this.slots.delete(track.id)
      const output = this.mixer.input(track.id)
      if (!output || track.kind === 'audio') continue
      const deps: InstrumentDeps = {
        ctx: this.context,
        output,
        buffers: this.buffers,
        renders: this.renders,
        reverse: this.reverse,
        getAssets: () => this.project?.assets ?? {},
      }
      const instrument =
        track.kind === 'drumRack'
          ? new DrumRackInstrument(deps, track)
          : track.kind === 'slicer'
            ? new SlicerInstrument(deps, track)
            : new SamplerInstrument(deps, track)
      this.slots.set(track.id, { kind: track.kind, track, instrument })
    }
    for (const [id, slot] of this.slots) {
      if (!project.tracks[id]) {
        slot.instrument.panic(now)
        this.slots.delete(id)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Transporte
  // -------------------------------------------------------------------------

  get isPlaying(): boolean {
    return this.playing
  }

  play(options: PlayOptions = {}): PlayInfo | null {
    const project = this.project
    if (!project) return null
    if (this.playing) this.stop()
    const bpm = projectBpm(project)
    const startTime = this.context.currentTime + this.startDelaySec
    const fromTick = options.fromTick ?? 0
    const countIn = Math.max(0, options.countInBars ?? 0) * ticksPerBar(project.timeSignature)
    this.segments = [{ time: startTime, tick: fromTick - countIn, linear: -countIn, bpm }]
    this.cursorTime = startTime
    this.cursorTick = fromTick - countIn
    this.playStartTick = fromTick
    this.countInDone = countIn === 0
    this.pendingOffs = []
    this.audioResync = true
    this.playing = true
    this.timer.start(() => this.pump())
    this.pump()
    for (const listener of this.stateListeners) listener(true)
    return { startTime, musicStartTime: startTime + (countIn * 60) / (bpm * PPQ), fromTick }
  }

  stop(): void {
    if (!this.playing) return
    const now = this.context.currentTime
    this.stoppedTick = this.tickAtTime(now) ?? 0
    this.timer.stop()
    // Se sueltan las notas del secuenciador y se quita lo programado que
    // aún no sonó. Los one-shots que ya suenan terminan solos (panic() los corta).
    this.flushOffs(now)
    for (const slot of this.slots.values()) slot.instrument.cancelFuture(now)
    this.audioClips.stopAll(now)
    this.metronome?.cancelFuture(now)
    this.playing = false
    this.segments = []
    for (const listener of this.stateListeners) listener(false)
  }

  /** Silencia todo de inmediato (también lo tocado en vivo). */
  panic(): void {
    const now = this.context.currentTime
    for (const slot of this.slots.values()) slot.instrument.panic(now)
    this.audioClips.stopAll(now)
  }

  getPosition(): TransportPosition {
    const bpm = this.project ? projectBpm(this.project) : 120
    if (!this.playing) return { playing: false, tick: this.stoppedTick, countingIn: false, bpm }
    const time = this.context.currentTime
    const tick = this.tickAtTime(time) ?? 0
    const linear = this.linearTickAtTime(time) ?? 0
    return { playing: true, tick, countingIn: linear < 0, bpm: this.segmentAt(time).bpm }
  }

  tickAtTime(time: number): number | null {
    if (!this.playing) return null
    const seg = this.segmentAt(time)
    return seg.tick + ((time - seg.time) * seg.bpm * PPQ) / 60
  }

  linearTickAtTime(time: number): number | null {
    if (!this.playing) return null
    const seg = this.segmentAt(time)
    return seg.linear + ((time - seg.time) * seg.bpm * PPQ) / 60
  }

  gridTimesBetween(t0: number, t1: number, intervalTicks: number): GridPoint[] {
    const out: GridPoint[] = []
    if (!this.playing || !(intervalTicks > 0)) return out
    const eps = 1e-6
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]!
      const next = this.segments[i + 1]
      const a = Math.max(t0, i === 0 ? -Infinity : seg.time)
      const b = Math.min(t1, next ? next.time : Infinity)
      if (a >= b) continue
      const tps = (seg.bpm * PPQ) / 60
      const tickA = seg.tick + (a - seg.time) * tps
      const tickB = seg.tick + (b - seg.time) * tps
      for (let n = Math.ceil(tickA / intervalTicks - eps); n * intervalTicks < tickB - eps; n++) {
        const tick = n * intervalTicks
        out.push({ time: seg.time + (tick - seg.tick) / tps, tick })
      }
    }
    return out
  }

  private lastSegment(): Segment {
    return this.segments[this.segments.length - 1]!
  }

  private segmentAt(time: number): Segment {
    let found = this.segments[0]!
    for (const seg of this.segments) {
      if (seg.time <= time) found = seg
      else break
    }
    return found
  }

  // -------------------------------------------------------------------------
  // Entrada en vivo
  // -------------------------------------------------------------------------

  /** Evento en vivo (o de cualquier fuente): misma ruta que el secuenciador. */
  handleEvent(event: InstrumentEvent): void {
    this.dispatch(event)
  }

  /** Todos los eventos que llegan a los instrumentos (para iluminar pads, etc.). */
  onEvent(listener: (event: InstrumentEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStateChange(listener: (playing: boolean) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Se llama en cada pasada del scheduler en vivo (lo usa el note repeat). */
  onPump(listener: (now: number) => void): () => void {
    this.pumpListeners.add(listener)
    return () => this.pumpListeners.delete(listener)
  }

  private dispatch(event: InstrumentEvent): void {
    const trackId = event.type === 'sustain' ? event.trackId : event.target.trackId
    this.slots.get(trackId)?.instrument.handle(event)
    for (const listener of this.eventListeners) listener(event)
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /** Una pasada en vivo: programa hasta ahora + lookahead. */
  pump(): void {
    const now = this.context.currentTime
    this.advanceTo(now + this.lookaheadSec)
    for (const listener of this.pumpListeners) listener(now)
  }

  /**
   * Programa todo lo que cae antes del tiempo de audio `targetTime`.
   * Determinista: es lo que usan el render offline y los tests.
   */
  advanceTo(targetTime: number): void {
    if (!this.playing || !this.project) return
    for (let guard = 0; this.cursorTime < targetTime && guard < 100000; guard++) {
      const project = this.project
      const seg = this.lastSegment()
      const tps = (seg.bpm * PPQ) / 60
      const endTick = seg.tick + (targetTime - seg.time) * tps
      const loop = this.activeLoop(project)
      if (loop && this.cursorTick < loop.end && endTick >= loop.end) {
        // Vuelta del loop de canción: se programa hasta el final, se sueltan
        // las notas que cruzaban y la posición salta al inicio.
        this.processWindow(project, this.cursorTick, loop.end)
        const time = seg.time + (loop.end - seg.tick) / tps
        this.flushOffs(time)
        this.audioClips.stopAll(time)
        this.segments.push({
          time,
          tick: loop.start,
          linear: seg.linear + (loop.end - seg.tick),
          bpm: seg.bpm,
        })
        this.cursorTime = time
        this.cursorTick = loop.start
        this.audioResync = true
      } else {
        this.processWindow(project, this.cursorTick, endTick)
        this.cursorTime = targetTime
        this.cursorTick = endTick
      }
    }
    const horizon = this.context.currentTime - HISTORY_SEC
    while (this.segments.length > 1 && this.segments[1]!.time < horizon) this.segments.shift()
  }

  private activeLoop(project: Project): { start: number; end: number } | null {
    const { enabled, startTick, endTick } = project.songLoop
    if (project.transportMode !== 'song' || !enabled) return null
    if (endTick - startTick < MIN_LOOP_TICKS) return null
    return { start: startTick, end: endTick }
  }

  /** Programa lo que empieza en [from, to) (ticks de posición, mismo segmento). */
  private processWindow(project: Project, from: number, to: number): void {
    const seg = this.lastSegment()
    const tps = (seg.bpm * PPQ) / 60
    const timeOf = (tick: number): number => seg.time + (tick - seg.tick) / tps

    if (this.metronome && (project.metronome.enabled || !this.countInDone)) {
      for (const beat of beatsInWindow(project, from, to)) {
        const inCountIn = !this.countInDone && beat.tick < this.playStartTick
        if (inCountIn || project.metronome.enabled) {
          this.metronome.click(timeOf(beat.tick), beat.accent, project)
        }
      }
    }
    if (!this.countInDone) {
      // Durante el count-in solo suena el metrónomo.
      if (to <= this.playStartTick) return
      from = Math.max(from, this.playStartTick)
      this.countInDone = true
    }

    const ons: { tick: number; target: NoteTarget; velocity: number }[] = []
    const collect = (
      trackId: TrackId,
      patternId: keyof Project['patterns'],
      origin: number,
      clipStart?: number,
      clipEnd?: number,
    ): void => {
      const pattern = project.patterns[patternId]
      if (!pattern) return
      for (const n of collectNotes(pattern, origin, from, to, clipStart, clipEnd)) {
        const target = { trackId, pitch: n.pitch }
        ons.push({ tick: n.onTick, target, velocity: n.velocity })
        this.pendingOffs.push({ tick: n.offTick, target })
      }
    }

    if (project.transportMode === 'pattern') {
      if (this.audioResync) {
        this.audioClips.stopAll(timeOf(from))
        this.audioResync = false
      }
      for (const track of Object.values(project.tracks)) {
        if (track.kind !== 'audio' && track.activePatternId) {
          collect(track.id, track.activePatternId, 0)
        }
      }
    } else {
      this.scheduleAudioClips(project, from, to, timeOf)
      for (const clip of Object.values(project.clips)) {
        if (clip.kind !== 'pattern') continue
        const track = project.tracks[clip.trackId]
        if (!track || track.kind === 'audio') continue
        collect(
          track.id,
          clip.patternId,
          clip.startTick - clip.offsetTicks,
          clip.startTick,
          clip.startTick + clip.lengthTicks,
        )
      }
    }

    // Una sola cola en orden de tiempo; en empate, los note-off van primero
    // para que una nota que termina justo donde empieza otra no la corte.
    const offs = this.pendingOffs.filter((o) => o.tick < to)
    if (offs.length > 0) this.pendingOffs = this.pendingOffs.filter((o) => o.tick >= to)
    const queue = [
      ...offs.map((o) => ({ tick: Math.max(o.tick, from), off: true, target: o.target, velocity: 0 })),
      ...ons.map((o) => ({ ...o, off: false })),
    ].sort((a, b) => a.tick - b.tick || Number(b.off) - Number(a.off))
    const lateLimit = this.context.currentTime - LATE_DROP_SEC
    for (const item of queue) {
      const time = timeOf(item.tick)
      if (item.off) {
        this.dispatch({ type: 'noteOff', time, target: item.target, source: 'sequencer' })
      } else if (time >= lateLimit) {
        this.dispatch({
          type: 'noteOn',
          time,
          target: item.target,
          velocity: item.velocity,
          source: 'sequencer',
        })
      }
    }
  }

  private scheduleAudioClips(
    project: Project,
    from: number,
    to: number,
    timeOf: (tick: number) => number,
  ): void {
    const audio = []
    for (const clip of Object.values(project.clips)) {
      if (clip.kind !== 'audio') continue
      const output = project.tracks[clip.trackId]?.kind === 'audio' && this.mixer.input(clip.trackId)
      if (output) audio.push({ clip, output, end: clip.startTick + clip.lengthTicks })
    }
    if (this.audioResync) {
      // Tras un salto (arranque, vuelta de loop) o una edición: lo que suena
      // debe ser exactamente lo que cubre la posición actual.
      this.audioResync = false
      const time = timeOf(from)
      const covering = audio.filter((a) => a.clip.startTick < from && from < a.end)
      for (const id of this.audioClips.playingIds()) {
        const current = covering.find((a) => a.clip.id === id)
        if (!current || current.clip !== this.audioClips.playing(id)) this.audioClips.stop(id, time)
      }
      for (const a of covering) {
        if (this.audioClips.playing(a.clip.id) !== a.clip) {
          this.audioClips.start(a.clip, a.output, project, time, from - a.clip.startTick)
        }
      }
    }
    for (const a of audio) {
      if (a.clip.startTick >= from && a.clip.startTick < to) {
        this.audioClips.start(a.clip, a.output, project, timeOf(a.clip.startTick), 0)
      }
      if (a.end > from && a.end <= to) this.audioClips.stop(a.clip.id, timeOf(a.end))
    }
  }

  private flushOffs(time: number): void {
    const offs = this.pendingOffs
    this.pendingOffs = []
    for (const off of offs) {
      this.dispatch({ type: 'noteOff', time, target: off.target, source: 'sequencer' })
    }
  }

  dispose(): void {
    this.stop()
    this.panic()
    this.mixer.dispose()
    this.eventListeners.clear()
    this.stateListeners.clear()
    this.pumpListeners.clear()
  }
}
