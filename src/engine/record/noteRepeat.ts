/**
 * Note repeat. Se coloca entre la entrada en vivo y el motor: con el
 * repeat activo, una nota mantenida se convierte en golpes sobre la
 * rejilla del transporte (cada `intervalTicks`), con la velocity del
 * golpe original. Los golpes salen como eventos en vivo normales, así que
 * suenan y se graban por la misma ruta que todo lo demás.
 *
 * Comportamiento (como en una MPC):
 *  - Con el transporte en marcha, el pad no suena al pulsarlo sino en el
 *    siguiente punto de la rejilla. Si lo pulsas un pelo tarde
 *    (`lateToleranceSec`), ese punto todavía cuenta y suena de inmediato.
 *  - Con el transporte parado, el primer golpe suena al pulsar y los
 *    siguientes se cuentan desde ahí al BPM del proyecto.
 *  - Cada repetición cierra la anterior (importa en pads en modo gate).
 *
 * Las repeticiones se generan con un horizonte corto (`horizonSec`): al
 * soltar el pad puede sonar, como mucho, una repetición que ya estaba
 * programada dentro de ese horizonte.
 */
import {
  ticksToSeconds,
  type InstrumentEvent,
  type NoteOnEvent,
  type NoteTarget,
  type Project,
} from '../../model'
import type { TransportClock } from '../engine'

export interface NoteRepeaterOptions {
  clock: TransportClock
  getProject(): Project | null
  /** ¿Repeat activo ahora? Por defecto, `project.noteRepeat.enabled`. */
  isEnabled?(): boolean
  /**
   * Salida. `generated` = golpe creado sobre la rejilla (su tiempo es exacto,
   * el grabador no le compensa latencia).
   */
  emit(event: InstrumentEvent, generated: boolean): void
  horizonSec?: number
  lateToleranceSec?: number
}

interface Held {
  target: NoteTarget
  velocity: number
  /** Desde qué tiempo faltan repeticiones por generar. */
  from: number
  /** Tiempo del último golpe emitido (para no repetir un punto de la rejilla). */
  lastTime: number
  sounding: boolean
  /** Rejilla libre (transporte parado): tiempo del primer golpe. */
  anchor: number | null
}

export class NoteRepeater {
  private readonly options: NoteRepeaterOptions
  private readonly horizonSec: number
  private readonly lateToleranceSec: number
  private readonly held = new Map<string, Held>()

  constructor(options: NoteRepeaterOptions) {
    this.options = options
    this.horizonSec = options.horizonSec ?? 0.05
    this.lateToleranceSec = options.lateToleranceSec ?? 0.03
  }

  private enabled(): boolean {
    return this.options.isEnabled?.() ?? this.options.getProject()?.noteRepeat.enabled ?? false
  }

  /**
   * Entrada: eventos en vivo tal como llegan del router. `now` es el tiempo
   * de audio actual (currentTime).
   */
  handle(event: InstrumentEvent, now: number): void {
    if (event.type === 'sustain') {
      this.options.emit(event, false)
      return
    }
    const key = `${event.target.trackId}|${event.target.pitch}`
    if (event.type === 'noteOff') {
      const held = this.held.get(key)
      if (!held) {
        this.options.emit(event, false)
        return
      }
      this.held.delete(key)
      if (held.sounding) {
        this.options.emit({ ...event, time: Math.max(event.time, held.lastTime) }, false)
      }
      return
    }
    if (!this.enabled()) {
      this.options.emit(event, false)
      return
    }
    this.releaseHeld(key, event.time)
    const playing = this.options.clock.isPlaying
    const held: Held = {
      target: event.target,
      velocity: event.velocity,
      from: event.time - this.lateToleranceSec,
      lastTime: -Infinity,
      sounding: false,
      anchor: playing ? null : event.time,
    }
    this.held.set(key, held)
    if (!playing) {
      this.hit(held, event.time, event)
      held.from = event.time
    }
    this.generate(held, now)
  }

  /** Genera las repeticiones que caen hasta now + horizonte. Llamar en cada pasada del scheduler. */
  pump(now: number): void {
    if (this.held.size === 0) return
    if (!this.enabled()) {
      // Se apagó el repeat con pads pulsados: se sueltan.
      for (const key of [...this.held.keys()]) this.releaseHeld(key, now)
      return
    }
    for (const held of this.held.values()) this.generate(held, now)
  }

  private generate(held: Held, now: number): void {
    const project = this.options.getProject()
    if (!project) return
    const interval = project.noteRepeat.intervalTicks
    const until = now + this.horizonSec
    if (until <= held.from || !(interval > 0)) return
    const { clock } = this.options
    if (clock.isPlaying) {
      held.anchor = null
      for (const point of clock.gridTimesBetween(held.from, until, interval)) {
        this.hit(held, point.time)
      }
    } else {
      // Rejilla libre desde el primer golpe.
      held.anchor ??= held.lastTime > -Infinity ? held.lastTime : now
      const step = ticksToSeconds(interval, project.bpm)
      for (let n = Math.ceil((held.from - held.anchor) / step); ; n++) {
        const time = held.anchor + n * step
        if (time >= until) break
        this.hit(held, time)
      }
    }
    held.from = until
  }

  private hit(held: Held, time: number, original?: NoteOnEvent): void {
    if (time <= held.lastTime + 1e-6) return
    if (held.sounding) {
      this.options.emit({ type: 'noteOff', time, target: held.target, source: 'live' }, true)
    }
    held.sounding = true
    held.lastTime = time
    this.options.emit(
      original ?? {
        type: 'noteOn',
        time,
        target: held.target,
        velocity: held.velocity,
        source: 'live',
      },
      original === undefined,
    )
  }

  private releaseHeld(key: string, time: number): void {
    const held = this.held.get(key)
    if (!held) return
    this.held.delete(key)
    if (held.sounding) {
      this.options.emit(
        { type: 'noteOff', time: Math.max(time, held.lastTime), target: held.target, source: 'live' },
        false,
      )
    }
  }
}
