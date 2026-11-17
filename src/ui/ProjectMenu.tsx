/**
 * Proyecto: nombre, nuevo, abrir y guardar (.zip con el audio) y exportar a WAV.
 */
import { useRef, useState } from 'react'
import { exportAudio, exportDurationSec, type ExportOptions } from '../state/exportAudio'
import { PROJECT_EXT, newProject, openProjectFile, renameProject, saveProjectFile } from '../state/projectFile'
import { useProject } from '../state/store'

function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useProject((p) => p)
  const [opts, setOpts] = useState<ExportOptions>({ stems: false, bars: 4, tailSec: 2, sampleRate: 48000, format: 24 })
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const song = project.transportMode === 'song'
  const seconds = exportDurationSec(project, opts)
  const empty = song ? !Object.keys(project.clips).length : !Object.values(project.patterns).some((p) => p.notes.length)

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !progress && onClose()}>
      <div className="modal" role="dialog" aria-label="Exportar">
        <header>
          <h2>Exportar a WAV</h2>
          <div className="spacer" />
          <button disabled={!!progress} onClick={onClose}>
            Cerrar
          </button>
        </header>
        <p className="muted small">
          {song ? 'Modo canción: se exporta el arreglo completo.' : 'Modo patrón: se exportan los patrones en loop.'} Sin metrónomo. Duración: {seconds.toFixed(1)} s.
        </p>
        <div className="device-block">
          <div className="row">
            <span className="action-label">Qué</span>
            <nav className="segmented">
              <button className={!opts.stems ? 'active' : ''} onClick={() => setOpts({ ...opts, stems: false })}>
                Mezcla
              </button>
              <button className={opts.stems ? 'active' : ''} onClick={() => setOpts({ ...opts, stems: true })}>
                Una pista por archivo (stems)
              </button>
            </nav>
          </div>
          {!song && (
            <div className="row">
              <span className="action-label">Compases</span>
              <select value={opts.bars} onChange={(e) => setOpts({ ...opts, bars: Number(e.target.value) })}>
                {[1, 2, 4, 8, 16, 32].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="row">
            <span className="action-label">Cola al final</span>
            <select value={opts.tailSec} onChange={(e) => setOpts({ ...opts, tailSec: Number(e.target.value) })}>
              {[0, 1, 2, 4].map((s) => (
                <option key={s} value={s}>
                  {s} s
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="action-label">Formato</span>
            <select value={opts.sampleRate} onChange={(e) => setOpts({ ...opts, sampleRate: Number(e.target.value) })}>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
            </select>
            <select value={opts.format} onChange={(e) => setOpts({ ...opts, format: Number(e.target.value) as ExportOptions['format'] })}>
              <option value={16}>16 bits</option>
              <option value={24}>24 bits</option>
              <option value={32}>32 bits float</option>
            </select>
          </div>
        </div>
        {error && <p className="toast">{error}</p>}
        <div className="row">
          <div className="spacer" />
          <button
            className="active"
            disabled={!!progress || empty}
            title={empty ? 'No hay nada que exportar todavía' : ''}
            onClick={async () => {
              setError(null)
              try {
                await exportAudio(opts, (done, total) => setProgress(total > 1 ? `Exportando ${done}/${total}…` : 'Exportando…'))
                onClose()
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setProgress(null)
              }
            }}
          >
            {progress ?? 'Exportar'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ProjectMenu({ notify }: { notify: (msg: string) => void }) {
  const name = useProject((p) => p.name)
  const [editing, setEditing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="project-menu">
      {editing ? (
        <input
          type="text"
          autoFocus
          defaultValue={name}
          style={{ width: 160 }}
          onBlur={(e) => {
            renameProject(e.target.value)
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <button className="project-name" title="Renombrar el proyecto" onClick={() => setEditing(true)}>
          {name}
        </button>
      )}
      <select
        className="mini"
        value=""
        title="Proyecto"
        onChange={async (e) => {
          const action = e.target.value
          e.target.value = ''
          if (action === 'new') {
            if (window.confirm('¿Empezar un proyecto nuevo? El actual se reemplaza: guárdalo antes si lo quieres conservar.')) newProject()
          } else if (action === 'open') fileRef.current?.click()
          else if (action === 'save') {
            notify('Guardando…')
            const missing = await saveProjectFile()
            notify(missing.length ? `Guardado, pero falta el audio de: ${missing.join(', ')}` : 'Proyecto guardado.')
          } else if (action === 'export') setExporting(true)
        }}
      >
        <option value="">Proyecto ▾</option>
        <option value="save">Guardar (.zip con el audio)</option>
        <option value="open">Abrir…</option>
        <option value="new">Nuevo</option>
        <option value="export">Exportar a WAV…</option>
      </select>
      <input
        ref={fileRef}
        type="file"
        accept={`${PROJECT_EXT},.zip`}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (!file) return
          if (!window.confirm(`¿Abrir "${file.name}"? El proyecto actual se reemplaza.`)) return
          try {
            await openProjectFile(file)
            notify(`Abierto: ${file.name}`)
          } catch (err) {
            notify(`No se pudo abrir: ${err instanceof Error ? err.message : String(err)}`)
          }
        }}
      />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  )
}
