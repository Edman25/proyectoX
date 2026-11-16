/**
 * Mensajes MIDI crudos y su interpretación mínima. Aquí no se asume nada
 * sobre qué notas o canales manda cada controlador: eso lo decide el
 * ControllerProfile aprendido con learn.
 */
import type { MidiMessageMatch } from '../model'

/** Un mensaje tal como llega de un dispositivo. */
export interface RawMidiMessage {
  /** Bytes del mensaje (status + datos). */
  data: ArrayLike<number>
  /** Momento del mensaje en el dominio de `performance.now()` (ms). */
  timeStamp: number
  /** Nombre del dispositivo (MIDIInput.name): se compara con ControllerProfile.deviceName. */
  deviceName: string
}

export type MidiMessage =
  | { kind: 'noteOn'; channel: number; note: number; velocity: number }
  | { kind: 'noteOff'; channel: number; note: number }
  | { kind: 'cc'; channel: number; cc: number; value: number }

/**
 * Interpreta note on / note off / control change. Un note-on con velocity 0
 * es un note-off (así lo mandan muchos equipos). Todo lo demás (clock,
 * aftertouch, pitch bend, sysex…) devuelve null: hoy no se usa.
 */
export function parseMidi(data: ArrayLike<number>): MidiMessage | null {
  const status = data[0]
  const d1 = data[1]
  const d2 = data[2]
  if (status === undefined || d1 === undefined || d2 === undefined) return null
  const channel = status & 0x0f
  switch (status & 0xf0) {
    case 0x90:
      return d2 > 0
        ? { kind: 'noteOn', channel, note: d1, velocity: d2 }
        : { kind: 'noteOff', channel, note: d1 }
    case 0x80:
      return { kind: 'noteOff', channel, note: d1 }
    case 0xb0:
      return { kind: 'cc', channel, cc: d1, value: d2 }
    default:
      return null
  }
}

/** ¿El mensaje es el que identifica a este control? */
export function matchesControl(match: MidiMessageMatch, message: MidiMessage): boolean {
  if (match.channel !== message.channel) return false
  if (match.type === 'note') return message.kind !== 'cc' && message.note === match.note
  return message.kind === 'cc' && message.cc === match.cc
}

/** Fuente de mensajes MIDI. Web MIDI en la app; mensajes sintéticos en tests. */
export interface MidiSource {
  /** Devuelve la función para dejar de escuchar. */
  subscribe(listener: (message: RawMidiMessage) => void): () => void
}

/** Fuente manual: lo que le das con `send` llega a quien escuche. */
export class ManualMidiSource implements MidiSource {
  private readonly listeners = new Set<(message: RawMidiMessage) => void>()

  subscribe(listener: (message: RawMidiMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(message: RawMidiMessage): void {
    for (const listener of this.listeners) listener(message)
  }
}

/** Bytes de mensajes comunes, para tests y para simular un controlador. */
export const midiBytes = {
  noteOn: (channel: number, note: number, velocity = 100): number[] => [0x90 | channel, note, velocity],
  noteOff: (channel: number, note: number): number[] => [0x80 | channel, note, 0],
  cc: (channel: number, cc: number, value: number): number[] => [0xb0 | channel, cc, value],
}
