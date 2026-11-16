/**
 * Estado de la app. El proyecto vive en un historial (deshacer/rehacer);
 * la selección y otras cosas de la interfaz van aparte y no se deshacen.
 */
import type { Draft } from 'immer'
import { create } from 'zustand'
import { createEmptyProject, type AssetId, type Project, type SliceId } from '../model'
import { commit, createHistory, redo, reset, undo, type History } from './history'

export interface UiState {
  selectedAssetId: AssetId | null
  /** Slices seleccionados del asset actual, en orden de selección. */
  selectedSliceIds: SliceId[]
  /** Ajustar marcadores al cruce por cero más cercano. */
  snapToZero: boolean
  /** Banco de pads visible (0 = slices 1–16). */
  padBank: number
}

interface AppState {
  history: History<Project>
  ui: UiState
  /** Aplica un cambio al proyecto como un paso de deshacer. */
  change(label: string, recipe: (draft: Draft<Project>) => void): void
  undo(): void
  redo(): void
  /** Carga un proyecto sin historial (al abrir). */
  load(project: Project): void
  setUi(patch: Partial<UiState>): void
}

export const useApp = create<AppState>()((set) => ({
  history: createHistory(createEmptyProject()),
  ui: { selectedAssetId: null, selectedSliceIds: [], snapToZero: true, padBank: 0 },
  change: (label, recipe) => set((s) => ({ history: commit(s.history, label, recipe) })),
  undo: () => set((s) => ({ history: undo(s.history) })),
  redo: () => set((s) => ({ history: redo(s.history) })),
  load: (project) =>
    set({
      history: reset(project),
      ui: {
        selectedAssetId: (Object.keys(project.assets)[0] as AssetId | undefined) ?? null,
        selectedSliceIds: [],
        snapToZero: true,
        padBank: 0,
      },
    }),
  setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
}))

export const useProject = <T>(select: (p: Project) => T): T => useApp((s) => select(s.history.present))

export function getProject(): Project {
  return useApp.getState().history.present
}
