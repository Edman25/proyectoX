/**
 * Autoguardado: el proyecto actual se guarda en IndexedDB poco después de
 * cada cambio, y se recupera al abrir la app. Nada se pierde al recargar.
 */
import { PROJECT_FORMAT_VERSION, type Project } from '../model'
import { dbGet, dbPut } from '../storage/db'
import { useApp } from './store'

const KEY = 'current'
const DELAY_MS = 400

export async function restoreProject(): Promise<Project | null> {
  const saved = await dbGet<Project>('projects', KEY)
  if (!saved || saved.formatVersion !== PROJECT_FORMAT_VERSION) return null
  return saved
}

export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = useApp.getState().history.present
  const unsub = useApp.subscribe((s) => {
    const p = s.history.present
    if (p === last) return
    last = p
    clearTimeout(timer)
    timer = setTimeout(() => {
      dbPut('projects', KEY, p).catch((err: unknown) => console.error('No se pudo autoguardar', err))
    }, DELAY_MS)
  })
  return () => {
    clearTimeout(timer)
    unsub()
  }
}
