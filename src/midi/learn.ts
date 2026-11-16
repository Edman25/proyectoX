/**
 * Learn: "toca el control que quieres asignar". Captura el siguiente
 * mensaje útil y lo convierte en un ControlDef para el perfil.
 */
import {
  newId,
  type ControlDef,
  type ControlId,
  type ControlKind,
  type ControllerProfile,
  type MidiMessageMatch,
} from '../model'
import { parseMidi, type MidiMessage, type MidiSource } from './message'

export interface LearnOptions {
  kind: ControlKind
  label?: string
  /** Solo escuchar a este dispositivo. */
  deviceName?: string
  /** Cancela la espera (la promesa se rechaza). */
  signal?: AbortSignal
}

export interface LearnResult {
  control: ControlDef
  deviceName: string
}

/** Mensaje → identificador del control, o null si ese mensaje no sirve para aprender. */
export function matchFromMessage(message: MidiMessage, kind: ControlKind): MidiMessageMatch | null {
  if (message.kind === 'noteOn') {
    return { type: 'note', channel: message.channel, note: message.note }
  }
  if (message.kind === 'cc') {
    // Un botón/pad que manda CC: su "soltar" (valor 0) no cuenta como gesto.
    if ((kind === 'pad' || kind === 'button') && message.value === 0) return null
    return { type: 'cc', channel: message.channel, cc: message.cc }
  }
  return null
}

/** Espera el siguiente mensaje aprendible y devuelve el control. */
export function learnNext(source: MidiSource, options: LearnOptions): Promise<LearnResult> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      unsubscribe()
      options.signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(new Error('learn cancelado'))
    }
    const unsubscribe = source.subscribe((raw) => {
      if (options.deviceName !== undefined && raw.deviceName !== options.deviceName) return
      const message = parseMidi(raw.data)
      const match = message && matchFromMessage(message, options.kind)
      if (!match) return
      cleanup()
      resolve({
        deviceName: raw.deviceName,
        control: {
          id: newId<ControlId>(),
          kind: options.kind,
          label: options.label ?? defaultLabel(match),
          message: match,
        },
      })
    })
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort)
  })
}

function defaultLabel(match: MidiMessageMatch): string {
  return match.type === 'note'
    ? `Nota ${match.note} (canal ${match.channel + 1})`
    : `CC ${match.cc} (canal ${match.channel + 1})`
}

function sameMatch(a: MidiMessageMatch, b: MidiMessageMatch): boolean {
  if (a.channel !== b.channel) return false
  if (a.type === 'note') return b.type === 'note' && a.note === b.note
  return b.type === 'cc' && a.cc === b.cc
}

/**
 * Añade el control al perfil (función pura). Si ya había un control con el
 * mismo mensaje, lo sustituye en su misma posición y conserva su id, para
 * que los destinos y acciones que apuntaban a él sigan valiendo.
 */
export function addControl(profile: ControllerProfile, control: ControlDef): ControllerProfile {
  const index = profile.controls.findIndex((c) => sameMatch(c.message, control.message))
  if (index < 0) return { ...profile, controls: [...profile.controls, control] }
  const controls = [...profile.controls]
  controls[index] = { ...control, id: profile.controls[index]!.id }
  return { ...profile, controls }
}
