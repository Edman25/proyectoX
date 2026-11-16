/**
 * Binding real a Web MIDI. Es fino a propósito: solo reenvía los mensajes
 * de todas las entradas (incluidas las que se conecten después) como
 * RawMidiMessage. No tiene tests: todo lo demás se prueba con ManualMidiSource.
 */
import type { MidiSource, RawMidiMessage } from './message'

export interface WebMidiSource extends MidiSource {
  /** Nombres de las entradas conectadas ahora. */
  inputNames(): string[]
  /** Avisa cuando se conecta o desconecta un equipo. */
  onDevicesChange(listener: (names: string[]) => void): () => void
  dispose(): void
}

export function isWebMidiSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
}

/** Pide acceso a MIDI (el navegador puede preguntar al usuario) y devuelve la fuente. */
export async function requestWebMidi(): Promise<WebMidiSource> {
  if (!isWebMidiSupported()) throw new Error('Este navegador no soporta Web MIDI')
  const access = await navigator.requestMIDIAccess({ sysex: false })
  const listeners = new Set<(message: RawMidiMessage) => void>()
  const deviceListeners = new Set<(names: string[]) => void>()
  const bound = new Set<MIDIInput>()

  const inputNames = (): string[] => {
    const names: string[] = []
    access.inputs.forEach((input) => {
      if (input.state === 'connected') names.push(input.name ?? input.id)
    })
    return names
  }

  const bind = (): void => {
    access.inputs.forEach((input) => {
      if (bound.has(input)) return
      bound.add(input)
      input.onmidimessage = (event) => {
        if (!event.data) return
        const message: RawMidiMessage = {
          data: event.data,
          timeStamp: event.timeStamp,
          deviceName: input.name ?? input.id,
        }
        for (const listener of listeners) listener(message)
      }
    })
  }

  bind()
  access.onstatechange = () => {
    bind()
    const names = inputNames()
    for (const listener of deviceListeners) listener(names)
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    inputNames,
    onDevicesChange(listener) {
      deviceListeners.add(listener)
      return () => deviceListeners.delete(listener)
    },
    dispose() {
      access.onstatechange = null
      for (const input of bound) input.onmidimessage = null
      bound.clear()
      listeners.clear()
      deviceListeners.clear()
    },
  }
}
