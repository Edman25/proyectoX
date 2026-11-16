/**
 * Eventos que reciben los instrumentos. Vienen del secuenciador, de un
 * controlador MIDI, de los pads en pantalla o del teclado de la compu: todos
 * entran por la misma ruta.
 *
 * `time` está en segundos del reloj del AudioContext (BaseAudioContext.currentTime).
 * Un evento en vivo usa el momento en que ocurrió (ya convertido a ese reloj),
 * no el momento en que se procesa.
 */
import type { NoteTarget } from './project'
import type { TrackId } from './ids'

export type EventSource = 'sequencer' | 'live'

export interface NoteOnEvent {
  type: 'noteOn'
  time: number
  target: NoteTarget
  velocity: number
  source: EventSource
}

export interface NoteOffEvent {
  type: 'noteOff'
  time: number
  target: NoteTarget
  source: EventSource
}

/** Pedal de sustain (CC64). */
export interface SustainEvent {
  type: 'sustain'
  time: number
  trackId: TrackId
  on: boolean
  source: EventSource
}

export type InstrumentEvent = NoteOnEvent | NoteOffEvent | SustainEvent
