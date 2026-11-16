/**
 * LiveSession: el pegamento entre entrada en vivo, motor y grabador. Es la
 * fachada que usa la UI para tocar y grabar:
 *
 *   router ──▶ session.input ──▶ note repeat ──▶ motor (suena)
 *                                           └──▶ grabador (si se graba)
 *
 * Durante una grabación, la sesión le pasa al motor el proyecto base con
 * la toma en curso ya aplicada, para que lo grabado suene en la siguiente
 * vuelta del loop. El proyecto de la UI no se toca hasta el final: al
 * terminar se entrega la toma (`onTake`) y la UI la aplica con `applyTake`
 * como un solo paso de deshacer.
 */
import type { InstrumentEvent, Project, TransportAction } from '../../model'
import type { Engine } from '../engine'
import { NoteRepeater } from './noteRepeat'
import { Recorder } from './recorder'
import { applyTake, type Take } from './take'

export interface LiveSessionOptions {
  engine: Engine
  /** Calibración manual de latencia (ajuste global del usuario), en segundos. */
  latencySec?: number
  /**
   * Toma terminada. La UI debe hacer `applyTake(proyecto, take)` en su store
   * (un paso de deshacer) y pasar el resultado a `session.setProject`.
   */
  onTake?(take: Take): void
  /** Cambió el estado de grabación (para el botón de grabar). */
  onRecordingChange?(recording: boolean): void
}

export class LiveSession {
  readonly engine: Engine
  readonly recorder: Recorder
  readonly repeater: NoteRepeater
  private readonly options: LiveSessionOptions
  /** Proyecto de la UI (sin la toma en curso). */
  private base: Project | null = null
  /** Botón de note repeat del controlador mantenido (momentáneo). */
  private repeatHeld = false
  private readonly unsubscribe: () => void

  constructor(options: LiveSessionOptions) {
    this.options = options
    this.engine = options.engine
    this.base = this.engine.getProject()
    this.recorder = new Recorder({
      clock: this.engine,
      ...(options.latencySec !== undefined ? { latencySec: options.latencySec } : {}),
    })
    this.repeater = new NoteRepeater({
      clock: this.engine,
      getProject: () => this.base,
      isEnabled: () => this.repeatHeld || (this.base?.noteRepeat.enabled ?? false),
      emit: (event, generated) => this.deliver(event, generated),
    })
    this.unsubscribe = this.engine.onPump((now) => this.repeater.pump(now))
  }

  get isRecording(): boolean {
    return this.recorder.isRecording
  }

  set latencySec(value: number) {
    this.recorder.latencySec = value
  }

  get latencySec(): number {
    return this.recorder.latencySec
  }

  /** Snapshot del proyecto de la UI. Usar esto en vez de `engine.setProject`. */
  setProject(project: Project): void {
    this.base = project
    this.refresh()
  }

  /** Evento en vivo (del InputRouter, de pads en pantalla o del teclado). */
  input(event: InstrumentEvent): void {
    this.repeater.handle(event, this.engine.now())
  }

  /** Acción de transporte (botón del controlador, de la UI o atajo). */
  transport(action: TransportAction, pressed = true): void {
    if (action === 'noteRepeat') {
      this.repeatHeld = pressed
      this.repeater.pump(this.engine.now())
      return
    }
    if (!pressed) return
    if (action === 'play') this.play()
    else if (action === 'stop') this.stop()
    else this.toggleRecord()
  }

  play(fromTick = 0): void {
    this.engine.play({ fromTick })
  }

  /** Para el transporte. Si se estaba grabando, entrega la toma. */
  stop(): void {
    const take = this.finishTake()
    this.engine.stop()
    if (take) this.options.onTake?.(take)
  }

  /**
   * Botón de grabar:
   *  - parado → count-in (según el proyecto) y a grabar;
   *  - reproduciendo → empieza a grabar en el acto (punch-in);
   *  - grabando → deja de grabar y entrega la toma; el transporte sigue.
   */
  toggleRecord(fromTick = 0): void {
    const project = this.base
    if (!project) return
    if (this.recorder.isRecording) {
      const take = this.finishTake()
      if (take) this.options.onTake?.(take)
      return
    }
    const wasPlaying = this.engine.isPlaying
    if (wasPlaying) {
      const now = this.engine.now()
      this.recorder.start(project, {
        startTick: this.engine.tickAtTime(now) ?? 0,
        startLinearTick: this.engine.linearTickAtTime(now) ?? 0,
      })
    } else {
      this.recorder.start(project, { startTick: fromTick, startLinearTick: 0 })
    }
    // El motor recibe ya el proyecto con la toma (vacía) aplicada: en
    // `replace`, lo anterior deja de sonar desde el primer tick.
    this.refresh()
    if (!wasPlaying) {
      this.engine.play({ fromTick, countInBars: project.metronome.countInBars })
    }
    this.options.onRecordingChange?.(true)
  }

  dispose(): void {
    this.unsubscribe()
    this.recorder.cancel()
  }

  private deliver(event: InstrumentEvent, generated: boolean): void {
    this.engine.handleEvent(event)
    if (this.recorder.capture(event, generated)) this.refresh()
  }

  private finishTake(): Take | null {
    if (!this.recorder.isRecording) return null
    const take = this.recorder.finish(this.engine.now())
    // El motor se queda con la toma aplicada hasta que la UI confirme con
    // setProject: así no hay un hueco en el que lo grabado deje de sonar.
    if (take && this.base) this.engine.setProject(applyTake(this.base, take))
    this.options.onRecordingChange?.(false)
    return take
  }

  /** Pone en el motor el proyecto base + la toma en curso. */
  private refresh(): void {
    if (!this.base) return
    const take = this.recorder.snapshot()
    this.engine.setProject(take ? applyTake(this.base, take) : this.base)
  }
}
