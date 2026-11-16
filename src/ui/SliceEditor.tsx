import { useState } from 'react'
import { useSyncExternalStore } from 'react'
import { getLoadedAudio, subscribeLoadedAudio } from '../audio/library'
import type { SampleAsset } from '../model'
import {
  autoSliceEqual,
  autoSliceGrid,
  autoSliceTransients,
  clearSlices,
  mergeSelected,
  setAssetBpm,
  updateSlicePlayback,
} from '../state/actions'
import { useApp } from '../state/store'
import { NumberField } from './NumberField'
import { Waveform } from './Waveform'

const GRID_STEPS = [
  { label: '1 compás', beats: 4 },
  { label: '1/2', beats: 2 },
  { label: '1/4', beats: 1 },
  { label: '1/8', beats: 0.5 },
  { label: '1/16', beats: 0.25 },
]

function formatTime(frames: number, sr: number): string {
  const s = frames / sr
  return s < 60 ? `${s.toFixed(2)} s` : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

export function SliceEditor({ asset }: { asset: SampleAsset }) {
  const audio = useSyncExternalStore(subscribeLoadedAudio, () => getLoadedAudio(asset.id))
  const selected = useApp((s) => s.ui.selectedSliceIds)
  const snapToZero = useApp((s) => s.ui.snapToZero)
  const setUi = useApp((s) => s.setUi)
  const [sensitivity, setSensitivity] = useState(0.5)
  const [divisions, setDivisions] = useState(8)
  const [gridStep, setGridStep] = useState(1)
  const [bars, setBars] = useState(1)
  const [message, setMessage] = useState<string | null>(null)

  if (!audio) return <div className="editor empty">Cargando audio…</div>

  const selectedSlices = asset.slices.filter((s) => selected.includes(s.id))
  const first = selectedSlices[0]
  const canMerge = selectedSlices.length >= 2

  const flash = (m: string) => {
    setMessage(m)
    window.setTimeout(() => setMessage((cur) => (cur === m ? null : cur)), 2500)
  }

  return (
    <section className="editor">
      <header className="editor-head">
        <h2>{asset.name}</h2>
        <span className="meta">
          {formatTime(asset.frames, asset.sampleRate)} · {asset.channels === 1 ? 'mono' : 'estéreo'} ·{' '}
          {asset.slices.length} slices
        </span>
        <div className="spacer" />
        <NumberField
          label="BPM del sample"
          value={asset.bpm ?? 0}
          min={0}
          max={300}
          step={0.01}
          width={72}
          onCommit={(v) => setAssetBpm(asset.id, v > 0 ? v : null)}
        />
        <label className="field">
          <span>dura</span>
          <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>
            {[1, 2, 4, 8, 16].map((b) => (
              <option key={b} value={b}>
                {b} {b === 1 ? 'compás' : 'compases'}
              </option>
            ))}
          </select>
        </label>
        <button
          title="Calcula el BPM suponiendo que el sample dura esos compases de 4/4"
          onClick={() => {
            const bpm = (bars * 4 * 60) / (asset.frames / asset.sampleRate)
            setAssetBpm(asset.id, Math.round(bpm * 100) / 100)
          }}
        >
          Calcular BPM
        </button>
      </header>

      <div className="toolbar">
        <div className="tool-group">
          <span className="group-label">Golpes</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={sensitivity}
            title={`Sensibilidad ${Math.round(sensitivity * 100)}%`}
            onChange={(e) => setSensitivity(Number(e.target.value))}
          />
          <button onClick={() => flash(`${autoSliceTransients(asset.id, sensitivity)} slices`)}>Cortar</button>
        </div>
        <div className="tool-group">
          <span className="group-label">Dividir en</span>
          <select value={divisions} onChange={(e) => setDivisions(Number(e.target.value))}>
            {[2, 4, 8, 16, 32, 64].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <button onClick={() => autoSliceEqual(asset.id, divisions)}>Cortar</button>
        </div>
        <div className="tool-group">
          <span className="group-label">Rejilla</span>
          <select value={gridStep} onChange={(e) => setGridStep(Number(e.target.value))}>
            {GRID_STEPS.map((g) => (
              <option key={g.beats} value={g.beats}>
                {g.label}
              </option>
            ))}
          </select>
          <button
            disabled={!asset.bpm}
            title={asset.bpm ? '' : 'Pon el BPM del sample primero'}
            onClick={() => asset.bpm && autoSliceGrid(asset.id, asset.bpm, gridStep)}
          >
            Cortar
          </button>
        </div>
        <div className="tool-group">
          <button disabled={!canMerge} title="Unir slices seleccionados (M)" onClick={() => mergeSelected(asset.id) || flash('Solo se pueden unir slices consecutivos')}>
            Unir
          </button>
          <button disabled={asset.slices.length === 0} onClick={() => clearSlices(asset.id)}>
            Quitar slices
          </button>
          <label className="check" title="Mover los marcadores al cruce por cero más cercano para evitar clicks">
            <input type="checkbox" checked={snapToZero} onChange={(e) => setUi({ snapToZero: e.target.checked })} />
            Cruce por cero
          </label>
        </div>
        {message && <span className="toast">{message}</span>}
      </div>

      <Waveform key={asset.id} asset={asset} audio={audio} selected={selected} />

      <div className="inspector">
        {first ? (
          <>
            <span className="group-label">
              {selectedSlices.length === 1
                ? `Slice ${asset.slices.indexOf(first) + 1}`
                : `${selectedSlices.length} slices`}
            </span>
            <NumberField
              label="Ganancia"
              unit="dB"
              value={first.playback.gainDb}
              min={-48}
              max={12}
              step={0.5}
              onCommit={(v) => updateSlicePlayback(asset.id, selected, { gainDb: v }, 'Ganancia')}
            />
            <NumberField
              label="Tono"
              unit="st"
              value={first.playback.pitch}
              min={-24}
              max={24}
              step={1}
              onCommit={(v) => updateSlicePlayback(asset.id, selected, { pitch: v }, 'Tono')}
            />
            <NumberField
              label="Fade in"
              unit="ms"
              value={first.playback.fadeInMs}
              min={0}
              max={5000}
              step={5}
              onCommit={(v) => updateSlicePlayback(asset.id, selected, { fadeInMs: v }, 'Fade in')}
            />
            <NumberField
              label="Fade out"
              unit="ms"
              value={first.playback.fadeOutMs}
              min={0}
              max={5000}
              step={5}
              onCommit={(v) => updateSlicePlayback(asset.id, selected, { fadeOutMs: v }, 'Fade out')}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={first.playback.reverse}
                onChange={(e) => updateSlicePlayback(asset.id, selected, { reverse: e.target.checked }, 'Reversa')}
              />
              Reversa
            </label>
          </>
        ) : (
          <span className="muted">Clic en un slice para escucharlo y ajustarlo. Shift o Ctrl/Cmd para seleccionar varios.</span>
        )}
      </div>
    </section>
  )
}
