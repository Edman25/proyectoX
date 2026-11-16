/**
 * Panel del controlador MIDI:
 *  - conectar y ver los equipos;
 *  - aprender pads (tocándolos en orden) y botones de transporte;
 *  - a dónde suena cada pad en este proyecto;
 *  - calibrar la latencia de grabación.
 *
 * La disposición física (qué nota manda cada pad) es global por equipo; los
 * destinos son del proyecto.
 */
import { useEffect, useState } from 'react'
import { connectMidi, getMidiSource, useLive } from '../audio/engineHost'
import { addControl, learnNext } from '../midi'
import type { ControllerProfile, NoteTarget, Project, TrackId, TransportAction } from '../model'
import { ensureProfile, setLatencyMs, updateProfile, useSettings } from '../state/settings'
import { useProject } from '../state/store'
import { setControllerDefaultTrack, setPadTarget } from '../state/trackActions'
import { NumberField } from './NumberField'
import { refLabel } from './pads'

const ACTIONS: { action: TransportAction; label: string }[] = [
  { action: 'record', label: 'Grabar' },
  { action: 'play', label: 'Play' },
  { action: 'stop', label: 'Stop' },
  { action: 'noteRepeat', label: 'Note repeat (mantener)' },
]

type Learning = { deviceName: string; what: 'pads' } | { deviceName: string; what: TransportAction } | null

function targetOptions(project: Project): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  for (const id of project.trackOrder) {
    const t = project.tracks[id]
    if (t?.kind === 'drumRack') {
      t.pads.forEach((pad, i) =>
        out.push({ value: `${t.id}|${t.baseNote + i}`, label: `${t.name} · pad ${i + 1}${pad.sample ? ` (${refLabel(project, pad.sample)})` : ''}` }),
      )
    } else if (t?.kind === 'slicer') {
      const n = (t.assetId && project.assets[t.assetId]?.slices.length) || 0
      for (let i = 0; i < n; i++) out.push({ value: `${t.id}|${t.baseNote + i}`, label: `${t.name} · slice ${i + 1}` })
    }
  }
  return out
}

function DeviceSection({ deviceName, learning, setLearning }: { deviceName: string; learning: Learning; setLearning: (l: Learning) => void }) {
  const profile = useSettings((s) => s.profiles.find((p) => p.deviceName === deviceName))
  const project = useProject((p) => p)
  const assignment = profile ? project.controllers.find((a) => a.profileId === profile.id) : undefined
  const pads = profile?.controls.filter((c) => c.kind === 'pad') ?? []
  const options = targetOptions(project)
  const isLearning = learning?.deviceName === deviceName

  const controlLabel = (p: ControllerProfile, action: TransportAction) => {
    const id = p.transport[action]
    return id ? (p.controls.find((c) => c.id === id)?.label ?? '—') : '—'
  }

  return (
    <section className="device">
      <h3>{deviceName}</h3>

      <div className="device-block">
        <div className="row">
          <strong>Pads</strong>
          <span className="muted small">{pads.length ? `${pads.length} aprendidos` : 'Sin aprender: las notas se tocan como teclado (nota MIDI 36 = pad 1).'}</span>
          <div className="spacer" />
          {isLearning && learning.what === 'pads' ? (
            <button className="active" onClick={() => setLearning(null)}>
              Listo
            </button>
          ) : (
            <button onClick={() => setLearning({ deviceName, what: 'pads' })}>{pads.length ? 'Aprender más' : 'Aprender pads'}</button>
          )}
          {profile && pads.length > 0 && (
            <button
              onClick={() =>
                updateProfile(profile.id, (p) => ({ ...p, controls: p.controls.filter((c) => c.kind !== 'pad' || Object.values(p.transport).includes(c.id)) }))
              }
            >
              Olvidar pads
            </button>
          )}
        </div>
        {isLearning && learning.what === 'pads' && (
          <p className="learn-hint">Toca los pads en orden: el primero que toques será el pad 1. Pad {pads.length + 1}…</p>
        )}
      </div>

      <div className="device-block">
        <div className="row">
          <strong>Botones</strong>
        </div>
        {ACTIONS.map(({ action, label }) => (
          <div className="row" key={action}>
            <span className="action-label">{label}</span>
            <span className="muted small">{profile ? controlLabel(profile, action) : '—'}</span>
            <div className="spacer" />
            {isLearning && learning.what === action ? (
              <button className="active" onClick={() => setLearning(null)}>
                Toca el botón… (cancelar)
              </button>
            ) : (
              <button onClick={() => setLearning({ deviceName, what: action })}>Aprender</button>
            )}
            {profile?.transport[action] && (
              <button
                className="icon visible"
                title="Quitar"
                onClick={() =>
                  updateProfile(profile.id, (p) => {
                    const transport = { ...p.transport }
                    delete transport[action]
                    return { ...p, transport }
                  })
                }
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {profile && (
        <div className="device-block">
          <div className="row">
            <strong>En este proyecto</strong>
          </div>
          <div className="row">
            <span className="action-label">Toca en</span>
            <select
              value={assignment?.defaultTrackId ?? ''}
              onChange={(e) => setControllerDefaultTrack(profile.id, (e.target.value || null) as TrackId | null)}
            >
              <option value="">la pista seleccionada</option>
              {project.trackOrder.map((id) => (
                <option key={id} value={id}>
                  {project.tracks[id]?.name}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="action-label">Teclas en canal</span>
            <select
              value={profile.keysChannel ?? ''}
              onChange={(e) => updateProfile(profile.id, (p) => ({ ...p, keysChannel: e.target.value === '' ? null : Number(e.target.value) }))}
            >
              <option value="">cualquiera</option>
              {Array.from({ length: 16 }, (_, c) => (
                <option key={c} value={c}>
                  {c + 1}
                </option>
              ))}
            </select>
          </div>
          {pads.length > 0 && (
            <table className="pad-targets">
              <tbody>
                {pads.map((c, i) => {
                  const t = assignment?.padTargets[c.id]
                  return (
                    <tr key={c.id}>
                      <td>Pad {i + 1}</td>
                      <td className="muted small">{c.label}</td>
                      <td>
                        <select
                          value={t ? `${t.trackId}|${t.pitch}` : ''}
                          onChange={(e) => {
                            const [trackId, pitch] = e.target.value.split('|')
                            const target: NoteTarget | null = e.target.value ? { trackId: trackId as TrackId, pitch: Number(pitch) } : null
                            setPadTarget(profile.id, c.id, target)
                          }}
                        >
                          <option value="">por defecto (pad {i + 1} de la pista)</option>
                          {options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}

export function ControllerPanel({ onClose }: { onClose: () => void }) {
  const status = useLive((s) => s.midiStatus)
  const error = useLive((s) => s.midiError)
  const devices = useLive((s) => s.devices)
  const profiles = useSettings((s) => s.profiles)
  const latencyMs = useSettings((s) => s.latencyMs)
  const [learning, setLearning] = useState<Learning>(null)

  // Bucle de learn: escucha el siguiente mensaje del equipo y lo guarda en su perfil.
  useEffect(() => {
    const source = getMidiSource()
    const current = learning
    if (!current || !source) return
    const abort = new AbortController()
    void (async () => {
      try {
        for (;;) {
          if (abort.signal.aborted) return
          const profile = ensureProfile(current.deviceName)
          const isPads = current.what === 'pads'
          // Sin etiqueta: learn la pone con el mensaje ("Nota 36 (canal 10)"), que es lo útil de ver.
          const { control } = await learnNext(source, {
            kind: isPads ? 'pad' : 'button',
            deviceName: current.deviceName,
            signal: abort.signal,
          })
          updateProfile(profile.id, (p) => {
            const next = addControl(p, control)
            if (isPads) return next
            const id = next.controls.find((c) => c.message.channel === control.message.channel && JSON.stringify(c.message) === JSON.stringify(control.message))?.id
            return id ? { ...next, transport: { ...next.transport, [current.what]: id } } : next
          })
          if (!isPads) {
            setLearning(null)
            return
          }
        }
      } catch {
        // cancelado
      }
    })()
    return () => abort.abort()
  }, [learning])

  const names = [...new Set([...devices, ...profiles.map((p) => p.deviceName)])]

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Controlador MIDI">
        <header>
          <h2>Controlador MIDI</h2>
          <div className="spacer" />
          <button onClick={onClose}>Cerrar</button>
        </header>

        {status === 'unsupported' && <p>Este navegador no tiene Web MIDI. Usa Chrome o Edge.</p>}
        {status === 'error' && (
          <p>
            No se pudo conectar: {error}. <button onClick={() => void connectMidi()}>Reintentar</button>
          </p>
        )}
        {status === 'off' && <button onClick={() => void connectMidi()}>Conectar MIDI</button>}
        {status === 'connecting' && <p className="muted">Conectando… el navegador puede pedirte permiso.</p>}
        {status === 'on' && devices.length === 0 && <p className="muted">Conectado, pero no hay equipos. Conecta tu controlador por USB.</p>}

        {names.map((name) => (
          <DeviceSection key={name} deviceName={name} learning={learning} setLearning={setLearning} />
        ))}

        <section className="device">
          <h3>Latencia de grabación</h3>
          <div className="row">
            <NumberField label="Ajuste" unit="ms" value={latencyMs} min={-200} max={200} step={1} onCommit={setLatencyMs} />
            <span className="muted small">Si lo grabado queda sistemáticamente tarde, sube este valor (positivo = adelanta las notas).</span>
          </div>
        </section>
      </div>
    </div>
  )
}
