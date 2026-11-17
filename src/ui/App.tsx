import { useEffect, useRef, useState } from 'react'
import { resumeAudio } from '../audio/context'
import { ensureLoaded } from '../audio/library'
import { startOrStopRecording, togglePlay } from '../audio/engineHost'
import { importFiles, mergeSelected, removeMarker, selectSlice } from '../state/actions'
import { restoreProject, startAutosave } from '../state/persistence'
import { loadSettings } from '../state/settings'
import { getProject, useApp, useProject } from '../state/store'
import { Library } from './Library'
import { startPadLights } from './padLights'
import { Pads } from './Pads'
import { PAD_KEYS, PADS_PER_BANK, padDown, padUp } from './pads'
import { isPreviewPlaying, previewFrom, stopAll } from './preview'
import { SliceEditor } from './SliceEditor'
import { Arrangement } from './Arrangement'
import { Mixer } from './Mixer'
import { ProjectMenu } from './ProjectMenu'
import { ChopStrip } from './ChopStrip'
import { ControllerPanel } from './ControllerPanel'
import { TrackView } from './TrackView'
import { Tracks } from './Tracks'
import { Transport } from './Transport'

const TEXT_INPUTS = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'password'])

/** Solo los campos donde se escribe bloquean los atajos; menús, casillas y sliders no. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true
  return target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type)
}

export function App() {
  const [ready, setReady] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [controllerOpen, setControllerOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const selectedId = useApp((s) => s.ui.selectedAssetId)
  const view = useApp((s) => s.ui.view)
  const trackId = useApp((s) => s.ui.selectedTrackId)
  const setUi = useApp((s) => s.setUi)
  const asset = useProject((p) => (selectedId ? p.assets[selectedId] ?? null : null))
  const track = useProject((p) => (trackId ? p.tracks[trackId] ?? null : null))
  const canUndo = useApp((s) => s.history.past.at(-1)?.label ?? null)
  const canRedo = useApp((s) => s.history.future[0]?.label ?? null)
  const { undo, redo } = useApp.getState()

  // Abrir el último proyecto y autoguardar.
  useEffect(() => {
    let stop = () => {}
    void (async () => {
      try {
        await loadSettings()
        const saved = await restoreProject()
        if (saved) {
          const missing = await ensureLoaded(Object.values(saved.assets))
          useApp.getState().load(saved)
          if (missing.length) setNotice(`No se encontró el audio de ${missing.length} sample(s).`)
        }
      } catch (err) {
        console.error(err)
        setNotice('No se pudo abrir el proyecto guardado.')
      }
      stop = startAutosave()
      startPadLights()
      setReady(true)
    })()
    return () => stop()
  }, [])

  const doImport = async (files: File[]) => {
    if (!files.length) return
    resumeAudio()
    setNotice(`Importando ${files.length}…`)
    const { imported, failed } = await importFiles(files)
    setNotice(
      failed.length
        ? `${imported} importado(s). No se pudieron leer: ${failed.join(', ')}`
        : `${imported} importado(s).`,
    )
    window.setTimeout(() => setNotice(null), 4000)
  }

  // Arrastrar y soltar en cualquier parte.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      void doImport(Array.from(e.dataTransfer?.files ?? []))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // Atajos de teclado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      resumeAudio()
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (mod || e.altKey) return
      if (document.querySelector('.modal')) return

      const { ui } = useApp.getState()
      const pad = PAD_KEYS.indexOf(key as (typeof PAD_KEYS)[number])
      if (pad >= 0) {
        if (!e.repeat) padDown(ui.padBank * PADS_PER_BANK + pad, e.timeStamp)
        e.preventDefault()
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        if (e.shiftKey) startOrStopRecording()
        else togglePlay()
        return
      }

      const current = ui.view === 'sample' && ui.selectedAssetId ? getProject().assets[ui.selectedAssetId] : undefined
      if (!current) return
      const selIdx = current.slices.findIndex((s) => s.id === ui.selectedSliceIds.at(-1))
      switch (e.key) {
        case 'Enter':
          e.preventDefault()
          if (isPreviewPlaying()) stopAll()
          else previewFrom(current.id, 0)
          break
        case 'm':
        case 'M':
          mergeSelected(current.id)
          break
        case 'Backspace':
        case 'Delete': {
          const s = current.slices[selIdx]
          if (s) removeMarker(current.id, s.id)
          break
        }
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault()
          const next = current.slices[Math.min(current.slices.length - 1, Math.max(0, selIdx + (e.key === 'ArrowLeft' ? -1 : 1)))]
          if (next) selectSlice(next.id, e.shiftKey ? 'range' : 'replace')
          break
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const pad = PAD_KEYS.indexOf(e.key.toLowerCase() as (typeof PAD_KEYS)[number])
      if (pad >= 0) padUp(useApp.getState().ui.padBank * PADS_PER_BANK + pad, e.timeStamp)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [undo, redo])

  return (
    <div className="app" onPointerDown={resumeAudio}>
      <header className="topbar">
        <h1>proyectoX</h1>
        <ProjectMenu
          notify={(m) => {
            setNotice(m)
            window.setTimeout(() => setNotice((cur) => (cur === m ? null : cur)), 5000)
          }}
        />
        <Transport onOpenController={() => setControllerOpen(true)} />
        <button disabled={!canUndo} title={canUndo ? `Deshacer: ${canUndo} (Ctrl/Cmd+Z)` : 'Nada que deshacer'} onClick={undo}>
          ↶
        </button>
        <button disabled={!canRedo} title={canRedo ? `Rehacer: ${canRedo} (Ctrl/Cmd+Shift+Z)` : 'Nada que rehacer'} onClick={redo}>
          ↷
        </button>
        <div className="spacer" />
        {notice && <span className="notice">{notice}</span>}
        <span
          className="muted small shortcuts"
          title={'Espacio: play/stop\nShift+Espacio: grabar\nZXCV ASDF QWER 1234: pads\nEnter: escuchar el sample\nM: unir slices · Supr: quitar marcador\nCtrl/Cmd+Z: deshacer'}
        >
          Atajos ⓘ
        </span>
      </header>
      <aside className="sidebar">
        <Library onImport={() => fileRef.current?.click()} />
        <Tracks />
      </aside>
      <main className="center">
        <nav className="tabs">
          <button className={view === 'sample' ? 'active' : ''} onClick={() => setUi({ view: 'sample' })}>
            Sample{asset ? `: ${asset.name}` : ''}
          </button>
          <button className={view === 'track' ? 'active' : ''} disabled={!track || track.kind === 'audio'} onClick={() => setUi({ view: 'track' })}>
            Pista{track && track.kind !== 'audio' ? `: ${track.name}` : ''}
          </button>
          <button className={view === 'arrange' ? 'active' : ''} onClick={() => setUi({ view: 'arrange' })}>
            Arreglo
          </button>
          <button className={view === 'mixer' ? 'active' : ''} onClick={() => setUi({ view: 'mixer' })}>
            Mixer
          </button>
        </nav>
        {!ready ? (
          <div className="editor empty">Abriendo…</div>
        ) : view === 'arrange' ? (
          <Arrangement />
        ) : view === 'mixer' ? (
          <Mixer />
        ) : view === 'track' && track && track.kind !== 'audio' ? (
          <TrackView key={track.id} track={track} />
        ) : asset ? (
          <>
            <SliceEditor asset={asset} />
            <ChopStrip />
          </>
        ) : (
          <button className="editor empty dropzone" onClick={() => fileRef.current?.click()}>
            Arrastra audios aquí o haz clic para importar
            <span className="muted small">wav, mp3, flac, ogg, m4a, aiff</span>
          </button>
        )}
      </main>
      <aside className="pads-col">
        <Pads />
      </aside>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aif,.aiff"
        multiple
        hidden
        onChange={(e) => {
          void doImport(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      {dragging && <div className="drop-overlay">Suelta para importar</div>}
      {controllerOpen && <ControllerPanel onClose={() => setControllerOpen(false)} />}
    </div>
  )
}
