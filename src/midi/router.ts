/**
 * Router de entradas: mensajes MIDI crudos → InstrumentEvents o acciones
 * de transporte, pasando por el ControllerProfile (global: qué manda cada
 * control físico) y el ControllerAssignment del proyecto (a dónde suena).
 *
 * Reglas:
 *  1. Si el mensaje es un control aprendido del perfil:
 *     - con acción de transporte asignada → acción (play/stop/record/noteRepeat);
 *     - perilla o fader → `onControl` (valor 0–1; MIDI learn de parámetros, más adelante);
 *     - pad (o botón sin acción) → nota. Destino = `padTargets[control]` del
 *       proyecto o, si no tiene, la pista por defecto con altura = base de la
 *       pista + índice del pad entre los controles tipo pad.
 *  2. Si no es un control aprendido y llega por el canal de teclas
 *     (`keysChannel`, o cualquiera si es null): nota con altura = nota MIDI
 *     en la pista por defecto; CC64 = pedal de sustain.
 *  3. Un equipo sin perfil se trata como un teclado en cualquier canal.
 *
 * El note-off siempre va al mismo destino que su note-on, aunque en medio
 * cambie el mapa o la pista seleccionada: nunca queda una nota colgada.
 */
import type {
  ControlDef,
  ControlId,
  ControllerAssignment,
  ControllerProfile,
  ControllerProfileId,
  InstrumentEvent,
  NoteTarget,
  Project,
  Track,
  TrackId,
  TransportAction,
} from '../model'
import type { AudioClock } from './clock'
import { matchesControl, parseMidi, type MidiMessage, type MidiSource, type RawMidiMessage } from './message'

const SUSTAIN_CC = 64

export interface ControlChange {
  profileId: ControllerProfileId
  controlId: ControlId
  /** 0–1 */
  value: number
  time: number
}

export interface InputRouterOptions {
  clock: AudioClock
  getProject(): Project | null
  /** Perfiles de controlador guardados (globales). */
  getProfiles(): readonly ControllerProfile[]
  /** Pista seleccionada en la UI: destino cuando el proyecto no fija uno. */
  getSelectedTrackId(): TrackId | null
  onEvent(event: InstrumentEvent): void
  /** Botón de transporte. `pressed` distingue pulsar de soltar. */
  onTransport?(action: TransportAction, pressed: boolean, time: number): void
  onControl?(change: ControlChange): void
}

/** Altura que dispara el "elemento 0" de una pista. null si la pista no recibe notas. */
export function trackBaseNote(track: Track): number | null {
  switch (track.kind) {
    case 'drumRack':
    case 'slicer':
      return track.baseNote
    case 'sampler':
      return track.rootNote
    case 'audio':
      return null
  }
}

/** Destino de un pad según el proyecto y la regla por defecto. Pura. */
export function resolvePadTarget(
  profile: ControllerProfile,
  control: ControlDef,
  assignment: ControllerAssignment | undefined,
  project: Project,
  defaultTrackId: TrackId | null,
): NoteTarget | null {
  const explicit = assignment?.padTargets[control.id]
  if (explicit) return project.tracks[explicit.trackId] ? explicit : null
  if (control.kind !== 'pad' || !defaultTrackId) return null
  const track = project.tracks[defaultTrackId]
  const base = track ? trackBaseNote(track) : null
  if (base === null) return null
  const index = profile.controls.filter((c) => c.kind === 'pad').indexOf(control)
  return { trackId: defaultTrackId, pitch: base + index }
}

export class InputRouter {
  private readonly options: InputRouterOptions
  /** Notas pulsadas → destino al que se mandó su note-on. */
  private readonly held = new Map<string, NoteTarget>()

  constructor(options: InputRouterOptions) {
    this.options = options
  }

  /** Conecta una fuente MIDI. Devuelve la función para desconectarla. */
  connect(source: MidiSource): () => void {
    return source.subscribe((message) => this.handleMidi(message))
  }

  handleMidi(raw: RawMidiMessage): void {
    const message = parseMidi(raw.data)
    if (!message) return
    const { options } = this
    const time = options.clock.toAudioTime(raw.timeStamp)
    const project = options.getProject()
    const profile = options.getProfiles().find((p) => p.deviceName === raw.deviceName)
    const assignment = profile && project?.controllers.find((a) => a.profileId === profile.id)
    const assigned = assignment?.defaultTrackId
    const defaultTrackId =
      assigned && project?.tracks[assigned] ? assigned : options.getSelectedTrackId()

    const control = profile?.controls.find((c) => matchesControl(c.message, message))
    if (profile && control) {
      const pressed = message.kind === 'noteOn' || (message.kind === 'cc' && message.value > 0)
      const action = (Object.keys(profile.transport) as TransportAction[]).find(
        (a) => profile.transport[a] === control.id,
      )
      if (action) {
        options.onTransport?.(action, pressed, time)
        return
      }
      if (control.kind === 'knob' || control.kind === 'fader') {
        if (message.kind === 'cc') {
          options.onControl?.({
            profileId: profile.id,
            controlId: control.id,
            value: message.value / 127,
            time,
          })
        }
        return
      }
      const key = `${raw.deviceName}|c|${control.id}`
      if (!pressed) {
        this.release(key, time)
        return
      }
      // Un control por CC puede repetir valores mientras está pulsado.
      if (message.kind === 'cc' && this.held.has(key)) return
      const target = project
        ? resolvePadTarget(profile, control, assignment, project, defaultTrackId)
        : null
      if (target) this.press(key, target, velocityOf(message), time)
      return
    }

    if (profile && profile.keysChannel !== null && message.channel !== profile.keysChannel) return
    if (message.kind === 'cc') {
      if (message.cc === SUSTAIN_CC && defaultTrackId) {
        options.onEvent({
          type: 'sustain',
          time,
          trackId: defaultTrackId,
          on: message.value >= 64,
          source: 'live',
        })
      }
      return
    }
    const key = `${raw.deviceName}|n|${message.channel}|${message.note}`
    if (message.kind === 'noteOff') {
      this.release(key, time)
    } else if (defaultTrackId && project?.tracks[defaultTrackId]?.kind !== 'audio') {
      this.press(key, { trackId: defaultTrackId, pitch: message.note }, message.velocity, time)
    }
  }

  /**
   * Entrada local (pads en pantalla, teclado de la compu): misma ruta que
   * MIDI. `performanceMs` es el timeStamp del evento del DOM.
   */
  localNoteOn(target: NoteTarget, velocity: number, performanceMs: number): void {
    const time = this.options.clock.toAudioTime(performanceMs)
    this.press(`local|${target.trackId}|${target.pitch}`, target, velocity, time)
  }

  localNoteOff(target: NoteTarget, performanceMs: number): void {
    const time = this.options.clock.toAudioTime(performanceMs)
    this.release(`local|${target.trackId}|${target.pitch}`, time)
  }

  private press(key: string, target: NoteTarget, velocity: number, time: number): void {
    // Re-pulsar sin haber soltado (rebote, CC): se cierra la anterior primero.
    this.release(key, time)
    this.held.set(key, target)
    this.options.onEvent({
      type: 'noteOn',
      time,
      target,
      velocity: Math.min(127, Math.max(1, Math.round(velocity))),
      source: 'live',
    })
  }

  private release(key: string, time: number): void {
    const target = this.held.get(key)
    if (!target) return
    this.held.delete(key)
    this.options.onEvent({ type: 'noteOff', time, target, source: 'live' })
  }
}

function velocityOf(message: MidiMessage): number {
  if (message.kind === 'noteOn') return message.velocity
  return message.kind === 'cc' ? message.value : 0
}
