/**
 * Ajustes globales (no pertenecen a un proyecto ni se deshacen): perfiles de
 * controlador y calibración de latencia. Se guardan en IndexedDB.
 */
import { create } from 'zustand'
import { newId, type ControllerProfile, type ControllerProfileId } from '../model'
import { dbGet, dbPut } from '../storage/db'

export interface Settings {
  profiles: ControllerProfile[]
  /** Calibración manual de latencia de grabación en ms (positivo = las notas se graban antes). */
  latencyMs: number
}

const KEY = 'global'
const DEFAULTS: Settings = { profiles: [], latencyMs: 0 }

export const useSettings = create<Settings>()(() => DEFAULTS)

export async function loadSettings(): Promise<void> {
  const saved = await dbGet<Partial<Settings>>('settings', KEY)
  if (saved) useSettings.setState({ ...DEFAULTS, ...saved })
  useSettings.subscribe((s) => {
    dbPut('settings', KEY, { profiles: s.profiles, latencyMs: s.latencyMs }).catch((err: unknown) =>
      console.error('No se pudieron guardar los ajustes', err),
    )
  })
}

export function getProfileFor(deviceName: string): ControllerProfile | undefined {
  return useSettings.getState().profiles.find((p) => p.deviceName === deviceName)
}

/** Perfil del equipo (lo crea vacío si no existe). */
export function ensureProfile(deviceName: string): ControllerProfile {
  const existing = getProfileFor(deviceName)
  if (existing) return existing
  const profile: ControllerProfile = {
    id: newId<ControllerProfileId>(),
    deviceName,
    controls: [],
    transport: {},
    keysChannel: null,
  }
  useSettings.setState((s) => ({ profiles: [...s.profiles, profile] }))
  return profile
}

export function updateProfile(id: ControllerProfileId, update: (p: ControllerProfile) => ControllerProfile): void {
  useSettings.setState((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? update(p) : p)) }))
}

export function setLatencyMs(ms: number): void {
  useSettings.setState({ latencyMs: ms })
}
