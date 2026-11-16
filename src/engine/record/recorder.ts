/**
 * Grabador: convierte los eventos en vivo de las pistas armadas en una
 * toma (ticks). No toca el proyecto: la toma se aplica con `applyTake`.
 *
 * Latencia. El `time` de un evento en vivo es el punto del audio que se
 * oía al tocar (ver midi/clock.ts). `latencySec` es la calibración manual
 * que se resta además de eso: es un ajuste global del usuario (no del
 * proyecto) para lo que el navegador no sabe medir — audífonos Bluetooth,
 * drivers que reportan mal, el retardo del propio controlador. Positivo =
 * las notas se graban más temprano.
 */
import {
  PPQ,
  newId,
  type ClipId,
  type InstrumentEvent,
  type NoteId,
  type PatternId,
  type Project,
  type TrackId,
} from '../../model'
import type { TransportClock } from '../engine'
import type { Take, TakeNote } from './take'

/** Por defecto se aceptan golpes hasta una corchea antes del inicio. */
export const DEFAULT_PRE_ROLL_TICKS = PPQ / 2

export interface RecorderOptions {
  clock: TransportClock
  /** Calibración manual de latencia, en segundos. */
  latencySec?: number
  /** Cuánto antes del inicio se acepta un golpe adelantado. */
  preRollTicks?: number
}

export interface RecordStart {
  /** Posición del transporte donde empieza la grabación. */
  startTick: number
  /** El mismo punto en ticks lineales (0 si se graba desde el arranque). */
  startLinearTick: number
}

interface OpenNote {
  note: TakeNote
  /** Tick lineal del note-on, para medir la duración sin vueltas de loop. */
  linear: number
  /** Tecla soltada con el pedal puesto: se cierra al levantar el pedal. */
  pedal: boolean
}

export class Recorder {
  latencySec: number
  preRollTicks: number
  private readonly clock: TransportClock
  private take: Take | null = null
  private startLinear = 0
  private readonly open = new Map<string, OpenNote>()
  private readonly sustain = new Set<TrackId>()

  constructor(options: RecorderOptions) {
    this.clock = options.clock
    this.latencySec = options.latencySec ?? 0
    this.preRollTicks = options.preRollTicks ?? DEFAULT_PRE_ROLL_TICKS
  }

  get isRecording(): boolean {
    return this.take !== null
  }

  /** Empieza una toma sobre las pistas armadas del proyecto en este momento. */
  start(project: Project, at: RecordStart): void {
    const armedTrackIds = Object.values(project.tracks)
      .filter((t) => t.armed && t.kind !== 'audio')
      .map((t) => t.id)
    const reserved: Take['reserved'] = {}
    for (const id of armedTrackIds) {
      reserved[id] = { patternId: newId<PatternId>(), clipId: newId<ClipId>() }
    }
    this.take = {
      mode: project.recordMode,
      transportMode: project.transportMode,
      armedTrackIds,
      startTick: Math.round(at.startTick),
      lengthTicks: null,
      notes: [],
      reserved,
    }
    this.startLinear = at.startLinearTick
    this.open.clear()
    this.sustain.clear()
  }

  /**
   * Recibe un evento en vivo. `exact` marca los eventos generados sobre la
   * rejilla (note repeat): su tiempo ya es el programado, no se compensa
   * latencia. Devuelve true si la toma cambió (hay una nota nueva completa).
   */
  capture(event: InstrumentEvent, exact = false): boolean {
    const take = this.take
    if (!take || event.source !== 'live') return false
    const trackId = event.type === 'sustain' ? event.trackId : event.target.trackId
    if (!take.armedTrackIds.includes(trackId)) return false
    const time = exact ? event.time : event.time - this.latencySec
    const linear = this.clock.linearTickAtTime(time)
    const tick = this.clock.tickAtTime(time)
    if (linear === null || tick === null) return false

    if (event.type === 'sustain') {
      if (event.on) {
        this.sustain.add(trackId)
        return false
      }
      this.sustain.delete(trackId)
      let changed = false
      for (const [key, open] of this.open) {
        if (open.pedal && open.note.trackId === trackId) {
          this.close(key, linear)
          changed = true
        }
      }
      return changed
    }

    const key = `${trackId}|${event.target.pitch}`
    if (event.type === 'noteOff') {
      const open = this.open.get(key)
      if (!open) return false
      if (this.sustain.has(trackId)) {
        open.pedal = true
        return false
      }
      this.close(key, linear)
      return true
    }

    // Lo tocado durante el count-in se descarta, salvo un golpe adelantado
    // al tiempo 1 (dentro del pre-roll).
    if (linear < this.startLinear - this.preRollTicks) return false
    const changed = this.close(key, linear)
    this.open.set(key, {
      linear,
      pedal: false,
      note: {
        id: newId<NoteId>(),
        trackId,
        pitch: event.target.pitch,
        velocity: event.velocity,
        tick: Math.round(tick),
        durationTicks: 1,
      },
    })
    return changed
  }

  private close(key: string, linear: number): boolean {
    const open = this.open.get(key)
    if (!open || !this.take) return false
    this.open.delete(key)
    open.note.durationTicks = Math.max(1, Math.round(linear - open.linear))
    this.take.notes.push(open.note)
    return true
  }

  /** La toma hasta ahora (sin las notas aún pulsadas), marcada como en curso. */
  snapshot(): Take | null {
    return this.take ? { ...this.take, notes: [...this.take.notes] } : null
  }

  /**
   * Termina la toma en el tiempo de audio `time`. Las notas aún pulsadas se
   * cierran ahí. Hay que llamarlo ANTES de parar el transporte.
   */
  finish(time: number): Take | null {
    const take = this.take
    if (!take) return null
    const endLinear = this.clock.linearTickAtTime(time) ?? this.startLinear
    for (const key of [...this.open.keys()]) this.close(key, endLinear)
    this.take = null
    this.sustain.clear()
    return { ...take, lengthTicks: Math.max(0, Math.round(endLinear - this.startLinear)) }
  }

  /** Descarta la toma en curso. */
  cancel(): void {
    this.take = null
    this.open.clear()
    this.sustain.clear()
  }
}
