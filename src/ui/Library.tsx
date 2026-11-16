import { useState } from 'react'
import type { AssetId } from '../model'
import { removeAsset, renameAsset, selectAsset } from '../state/actions'
import { useApp, useProject } from '../state/store'

export function Library({ onImport }: { onImport: () => void }) {
  const assets = useProject((p) => p.assets)
  const selectedId = useApp((s) => s.ui.selectedAssetId)
  const [editing, setEditing] = useState<AssetId | null>(null)
  const list = Object.values(assets)

  return (
    <div className="library">
      <header>
        <h2>Biblioteca</h2>
        <button onClick={onImport}>+ Importar</button>
      </header>
      {list.length === 0 ? (
        <p className="muted small">Arrastra archivos de audio a cualquier parte de la ventana.</p>
      ) : (
        <ul>
          {list.map((a) => (
            <li
              key={a.id}
              className={a.id === selectedId ? 'active' : ''}
              onClick={() => selectAsset(a.id)}
              onDoubleClick={() => setEditing(a.id)}
            >
              {editing === a.id ? (
                <input
                  autoFocus
                  defaultValue={a.name}
                  onBlur={(e) => {
                    renameAsset(a.id, e.target.value)
                    setEditing(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <>
                  <span className="name" title={a.name}>
                    {a.name}
                  </span>
                  <span className="meta">
                    {(a.frames / a.sampleRate).toFixed(1)}s{a.slices.length ? ` · ${a.slices.length}` : ''}
                    {a.bpm ? ` · ${a.bpm}` : ''}
                  </span>
                  <button
                    className="icon"
                    title="Quitar de la biblioteca (se puede deshacer)"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeAsset(a.id)
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
