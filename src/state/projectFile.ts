/**
 * Proyectos como archivo: un .zip con `project.json` y el audio de cada
 * sample en `audio/<id>.wav` (float de 32 bits, sin pérdida). Se puede
 * guardar, mover a otra compu y volver a abrir.
 */
import { ensureLoaded, getLoadedAudio, storeAssetAudio } from '../audio/library'
import { decodeWav, encodeWav } from '../io/wav'
import { readZip, writeZip } from '../io/zip'
import { PROJECT_FORMAT_VERSION, createEmptyProject, type Project } from '../model'
import { useApp } from './store'

export const PROJECT_EXT = '.pxproj.zip'

export function download(data: Uint8Array<ArrayBuffer> | Blob, fileName: string, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Nombre de archivo seguro en cualquier sistema: sin acentos ni caracteres
 * reservados (algunos navegadores descartan nombres no ASCII en descargas).
 */
export function safeFileName(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ñ/g, 'n')
      .replace(/Ñ/g, 'N')
      .replace(/[^\w .()-]+/g, '_')
      .trim() || 'proyecto'
  )
}

/** Arma el .zip del proyecto actual. Avisa qué samples no tenían audio cargado. */
export async function buildProjectZip(project: Project): Promise<{ zip: Uint8Array<ArrayBuffer>; missing: string[] }> {
  await ensureLoaded(Object.values(project.assets))
  const entries = [{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(project, null, 1)) }]
  const missing: string[] = []
  for (const asset of Object.values(project.assets)) {
    const audio = getLoadedAudio(asset.id)
    if (!audio) {
      missing.push(asset.name)
      continue
    }
    const channels = Array.from({ length: audio.buffer.numberOfChannels }, (_, c) => audio.buffer.getChannelData(c))
    entries.push({ name: `audio/${asset.id}.wav`, data: encodeWav({ sampleRate: audio.buffer.sampleRate, channels }, 32) })
  }
  return { zip: writeZip(entries), missing }
}

export async function saveProjectFile(): Promise<string[]> {
  const project = useApp.getState().history.present
  const { zip, missing } = await buildProjectZip(project)
  download(zip, `${safeFileName(project.name)}${PROJECT_EXT}`, 'application/zip')
  return missing
}

/** Abre un proyecto .zip: guarda su audio en el navegador y lo carga (sin historial). */
export async function openProjectFile(file: File): Promise<void> {
  const entries = await readZip(new Uint8Array(await file.arrayBuffer()))
  const json = entries.find((e) => e.name === 'project.json')
  if (!json) throw new Error('El archivo no tiene project.json')
  const project = JSON.parse(new TextDecoder().decode(json.data)) as Project
  if (project.formatVersion !== PROJECT_FORMAT_VERSION) throw new Error(`Formato de proyecto ${String(project.formatVersion)} no soportado`)
  const byName = new Map(entries.map((e) => [e.name, e.data]))
  for (const asset of Object.values(project.assets)) {
    const data = byName.get(`audio/${asset.id}.wav`)
    if (!data) continue
    const pcm = decodeWav(data)
    await storeAssetAudio(asset, pcm.sampleRate, pcm.channels as Float32Array<ArrayBuffer>[])
  }
  useApp.getState().load(project)
}

export function newProject(): void {
  useApp.getState().load(createEmptyProject())
}

export function renameProject(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  useApp.getState().change('Nombre del proyecto', (p) => {
    p.name = trimmed
  })
}
