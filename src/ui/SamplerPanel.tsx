/**
 * Ajustes del Sampler: qué sample, nota raíz, modo de tono, afinación,
 * envolvente, loop de sostenido y voces.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { peaksForView } from '../analysis/peaks'
import { getRenderCache, prerenderTrack, useLive } from '../audio/engineHost'
import { getLoadedAudio, subscribeLoadedAudio } from '../audio/library'
import { resolveSampleRef, samplerRenderKeys } from '../engine'
import { noteName, type SamplerTrack } from '../model'
import { useProject } from '../state/store'
import { detectRoot } from '../state/actions'
import { updateSampler } from '../state/trackActions'
import { Fader } from './Fader'
import { NumberField } from './NumberField'
import { SampleSelect } from './StepGrid'

const WAVE_H = 64

function LoopWave({ track, start, end }: { track: SamplerTrack; start: number; end: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const assetId = track.sample?.assetId
  const audio = useSyncExternalStore(subscribeLoadedAudio, () => (assetId ? getLoadedAudio(assetId) : undefined))
  useEffect(() => {
    const c = ref.current
    if (!c || !audio) return
    const width = c.clientWidth || 400
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = WAVE_H * dpr
    const g = c.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const css = getComputedStyle(document.documentElement)
    g.fillStyle = css.getPropertyValue('--wave-bg')
    g.fillRect(0, 0, width, WAVE_H)
    const len = end - start
    if (track.loop.enabled && len > 0) {
      g.fillStyle = css.getPropertyValue('--slice-selected')
      const x0 = (track.loop.start / len) * width
      const x1 = (track.loop.end / len) * width
      g.fillRect(x0, 0, x1 - x0, WAVE_H)
      g.fillStyle = css.getPropertyValue('--accent')
      g.fillRect(x0, 0, 1, WAVE_H)
      g.fillRect(x1 - 1, 0, 1, WAVE_H)
    }
    const { min, max } = peaksForView(audio.peaks, start, end, width)
    g.fillStyle = css.getPropertyValue('--wave')
    const mid = WAVE_H / 2
    for (let x = 0; x < width; x++) {
      const y0 = mid - max[x]! * mid
      g.fillRect(x, y0, 1, Math.max(1, mid - min[x]! * mid - y0))
    }
  }, [audio, start, end, track.loop])
  return <canvas ref={ref} className="sampler-wave" style={{ height: WAVE_H }} />
}

export function SamplerPanel({ track }: { track: SamplerTrack }) {
  const project = useProject((p) => p)
  const region = resolveSampleRef(project.assets, track.sample)
  const len = region ? region.end - region.start : 0
  const asset = track.sample ? project.assets[track.sample.assetId] : undefined
  const id = track.id
  const env = track.envelope

  // "Mantener duración": dejar listos todos los semitonos para tocar sin latencia.
  useLive((s) => s.rendersReady) // re-render con cada render listo (progreso)
  const keys = samplerRenderKeys(project, id)
  const ready = keys.filter((k) => getRenderCache().has(k)).length
  useEffect(() => {
    if (track.pitchMode === 'preserve') prerenderTrack(id)
  }, [id, track.pitchMode, track.sample, track.rootNote, track.playback.pitch, track.playback.reverse, asset])

  return (
    <div className="sampler">
      <div className="sampler-row">
        <label className="field">
          <span>Sample</span>
          <SampleSelect project={project} value={track.sample} onChange={(r) => updateSampler(id, 'Sample del sampler', (t) => void (t.sample = r))} />
        </label>
        <label className="field">
          <span>Raíz</span>
          <select value={track.rootNote} onChange={(e) => updateSampler(id, 'Nota raíz', (t) => void (t.rootNote = Number(e.target.value)))}>
            {Array.from({ length: 73 }, (_, i) => i + 24).map((p) => (
              <option key={p} value={p}>
                {noteName(p)}
              </option>
            ))}
          </select>
        </label>
        {region && (
          <button
            title="Detectar la nota de este sample y usarla como raíz"
            onClick={() => {
              const r = detectRoot(region.assetId, region.start, region.end)
              if (r) updateSampler(id, 'Nota raíz', (t) => void (t.rootNote = r.midi))
            }}
          >
            Detectar
          </button>
        )}
        {asset?.rootNote != null && asset.rootNote !== track.rootNote && (
          <button onClick={() => updateSampler(id, 'Nota raíz', (t) => void (t.rootNote = asset.rootNote!))}>Usar {noteName(asset.rootNote)}</button>
        )}
        <nav className="segmented" title="Resample: cambia tono y duración juntos (sonido clásico de sampler). Mantener duración: cambia el tono sin cambiar el largo.">
          <button className={track.pitchMode === 'resample' ? 'active' : ''} onClick={() => updateSampler(id, 'Modo de tono', (t) => void (t.pitchMode = 'resample'))}>
            Resample
          </button>
          <button className={track.pitchMode === 'preserve' ? 'active' : ''} onClick={() => updateSampler(id, 'Modo de tono', (t) => void (t.pitchMode = 'preserve'))}>
            Mantener duración
          </button>
        </nav>
        {track.pitchMode === 'preserve' && keys.length > 0 && (
          <span className={`small ${ready < keys.length ? 'toast' : 'muted'}`}>
            {ready < keys.length ? `Preparando notas ${ready}/${keys.length}… (mientras, suenan en resample)` : `${keys.length} notas listas`}
          </span>
        )}
      </div>

      <div className="sampler-row">
        <span className="group-label">Afinación</span>
        <NumberField label="Fino" unit="st" value={track.playback.pitch} min={-24} max={24} step={0.01} onCommit={(v) => updateSampler(id, 'Afinación', (t) => void (t.playback.pitch = v))} />
        <NumberField label="Ganancia" unit="dB" value={track.playback.gainDb} min={-48} max={12} step={0.5} onCommit={(v) => updateSampler(id, 'Ganancia', (t) => void (t.playback.gainDb = v))} />
        <label className="check">
          <input type="checkbox" checked={track.playback.reverse} onChange={(e) => updateSampler(id, 'Reversa', (t) => void (t.playback.reverse = e.target.checked))} />
          Reversa
        </label>
        <span className="group-label">Envolvente</span>
        <NumberField label="A" unit="ms" value={env.attackMs} min={0} max={10000} step={1} width={56} onCommit={(v) => updateSampler(id, 'Ataque', (t) => void (t.envelope.attackMs = v))} />
        <NumberField label="D" unit="ms" value={env.decayMs} min={0} max={10000} step={1} width={56} onCommit={(v) => updateSampler(id, 'Decaimiento', (t) => void (t.envelope.decayMs = v))} />
        <NumberField
          label="S"
          unit="%"
          value={Math.round(env.sustain * 100)}
          min={0}
          max={100}
          step={1}
          width={52}
          onCommit={(v) => updateSampler(id, 'Sostenido', (t) => void (t.envelope.sustain = v / 100))}
        />
        <NumberField label="R" unit="ms" value={env.releaseMs} min={0} max={20000} step={1} width={56} onCommit={(v) => updateSampler(id, 'Release', (t) => void (t.envelope.releaseMs = v))} />
      </div>

      <div className="sampler-row">
        <span className="group-label">Voces</span>
        <nav className="segmented">
          <button className={track.voiceMode === 'poly' ? 'active' : ''} onClick={() => updateSampler(id, 'Voces', (t) => void (t.voiceMode = 'poly'))}>
            Poly
          </button>
          <button className={track.voiceMode === 'mono' ? 'active' : ''} onClick={() => updateSampler(id, 'Voces', (t) => void (t.voiceMode = 'mono'))}>
            Mono
          </button>
        </nav>
        {track.voiceMode === 'poly' ? (
          <NumberField label="Máx." value={track.maxVoices} min={1} max={64} step={1} width={52} onCommit={(v) => updateSampler(id, 'Máximo de voces', (t) => void (t.maxVoices = v))} />
        ) : (
          <NumberField label="Glide" unit="ms" value={track.glideMs} min={0} max={2000} step={5} width={60} onCommit={(v) => updateSampler(id, 'Glide', (t) => void (t.glideMs = v))} />
        )}
        <span className="group-label">Loop</span>
        <label className="check" title="Al mantener la nota, repite esta zona hasta soltar">
          <input
            type="checkbox"
            checked={track.loop.enabled}
            disabled={!len}
            onChange={(e) =>
              updateSampler(id, 'Loop', (t) => {
                t.loop.enabled = e.target.checked
                if (e.target.checked && (t.loop.end <= t.loop.start || t.loop.end > len)) {
                  t.loop.start = Math.round(len * 0.5)
                  t.loop.end = len
                }
              })
            }
          />
          Sostenido
        </label>
        {track.loop.enabled && len > 0 && (
          <>
            <span className="muted small">inicio</span>
            <Fader
              value={Math.round((track.loop.start / len) * 1000) / 10}
              min={0}
              max={99}
              step={0.1}
              title="Inicio del loop (%)"
              onCommit={(v) => updateSampler(id, 'Inicio del loop', (t) => void (t.loop.start = Math.min(Math.round((v / 100) * len), t.loop.end - 64)))}
            />
            <span className="muted small">fin</span>
            <Fader
              value={Math.round((track.loop.end / len) * 1000) / 10}
              min={1}
              max={100}
              step={0.1}
              title="Fin del loop (%)"
              onCommit={(v) => updateSampler(id, 'Fin del loop', (t) => void (t.loop.end = Math.max(Math.round((v / 100) * len), t.loop.start + 64)))}
            />
          </>
        )}
      </div>
      {region && <LoopWave track={track} start={region.start} end={region.end} />}
      {!track.sample && <p className="muted small">Elige un sample (o un slice) para tocarlo como instrumento. La nota raíz suena sin transponer.</p>}
    </div>
  )
}
