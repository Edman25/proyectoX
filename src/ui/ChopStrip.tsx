/**
 * Tira de chops: slices de cualquier sample, en el orden que quieras, para
 * consolidarlos en un loop nuevo (que queda cortado en las mismas piezas).
 */
import { useState } from 'react'
import { getLoadedAudio } from '../audio/library'
import { clearStrip, consolidateSlices, moveInStrip, removeFromStrip } from '../state/arrangeActions'
import { useApp, useProject } from '../state/store'
import { refLabel } from './pads'
import { previewSlice } from './preview'

export function ChopStrip() {
  const strip = useApp((s) => s.ui.chopStrip)
  const project = useProject((p) => p)
  const [busy, setBusy] = useState(false)
  if (strip.length === 0) return null

  const seconds = strip.reduce((sum, ref) => {
    const a = project.assets[ref.assetId]
    const s = a?.slices.find((x) => x.id === ref.sliceId)
    return sum + (a && s ? (s.end - s.start) / a.sampleRate : 0)
  }, 0)

  return (
    <section className="chop-strip">
      <header className="editor-head">
        <h2>Tira de chops</h2>
        <span className="meta">
          {strip.length} piezas · {seconds.toFixed(2)} s
        </span>
        <div className="spacer" />
        <button
          disabled={busy}
          title="Crear un sample nuevo con estas piezas en este orden (queda cortado igual)"
          onClick={async () => {
            setBusy(true)
            const n = Object.values(project.assets).filter((a) => a.origin.kind === 'consolidated').length
            const created = await consolidateSlices(strip, `Chop ${n + 1}`)
            setBusy(false)
            if (created) clearStrip()
          }}
        >
          {busy ? 'Consolidando…' : 'Consolidar en sample nuevo'}
        </button>
        <button onClick={clearStrip}>Vaciar</button>
      </header>
      <ol className="strip">
        {strip.map((ref, i) => {
          const asset = project.assets[ref.assetId]
          const index = asset?.slices.findIndex((s) => s.id === ref.sliceId) ?? -1
          const slice = asset?.slices[index]
          return (
            <li key={`${i}-${ref.sliceId}`} className={slice ? '' : 'missing'}>
              <button
                className="chip"
                disabled={!slice || !asset || !getLoadedAudio(ref.assetId)}
                title="Escuchar"
                onClick={() => asset && slice && previewSlice(asset.id, slice, index, true)}
              >
                {refLabel(project, ref)}
              </button>
              <button className="mini" disabled={i === 0} title="Mover a la izquierda" onClick={() => moveInStrip(i, i - 1)}>
                ←
              </button>
              <button className="mini" disabled={i === strip.length - 1} title="Mover a la derecha" onClick={() => moveInStrip(i, i + 1)}>
                →
              </button>
              <button className="mini" title="Quitar" onClick={() => removeFromStrip(i)}>
                ×
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
