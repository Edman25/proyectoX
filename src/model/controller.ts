/**
 * Perfil de un controlador MIDI: su disposición física, aprendida con "learn".
 * Es global (no pertenece a un proyecto): lo aprendes una vez por equipo.
 * A dónde suena cada pad lo decide cada proyecto (ver ControllerAssignment).
 */
import type { ControlId, ControllerProfileId } from './ids'

/** Canal MIDI 0–15 (en pantalla se muestra 1–16). */
export type MidiChannel = number

export type MidiMessageMatch =
  | { type: 'note'; channel: MidiChannel; note: number }
  | { type: 'cc'; channel: MidiChannel; cc: number }

export type ControlKind = 'pad' | 'button' | 'knob' | 'fader'

export interface ControlDef {
  id: ControlId
  kind: ControlKind
  label: string
  message: MidiMessageMatch
}

export type TransportAction = 'play' | 'stop' | 'record' | 'noteRepeat'

export interface ControllerProfile {
  id: ControllerProfileId
  /** Se compara con MIDIInput.name para reconocer el equipo al conectarlo. */
  deviceName: string
  /** Controles aprendidos, en el orden en que se mapean a pads por defecto. */
  controls: ControlDef[]
  /** Botón → acción de transporte. */
  transport: Partial<Record<TransportAction, ControlId>>
  /**
   * Canal por donde llegan las teclas de un teclado. Las notas de este canal
   * que no sean un control aprendido se tocan como notas (altura = nota MIDI).
   * null = cualquier canal.
   */
  keysChannel: MidiChannel | null
}
