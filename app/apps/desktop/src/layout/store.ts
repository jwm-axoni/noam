import { create } from "zustand";
import { applyLayoutOperation, type LayoutOperation } from "./operations";
import { createDefaultLayout, type LayoutV1 } from "./types";

interface LayoutStore {
  layout: LayoutV1;
  vaultKey: string | null;
  interactionGeneration: number;
  hydrate: (vaultKey: string, layout: LayoutV1) => void;
  dispatch: (operation: LayoutOperation) => void;
  replace: (layout: LayoutV1) => void;
  cancelInteraction: () => void;
}

export const useLayoutStore = create<LayoutStore>((set) => ({
  layout: createDefaultLayout(),
  vaultKey: null,
  interactionGeneration: 0,
  hydrate: (vaultKey, layout) =>
    set((state) => ({
      vaultKey,
      layout,
      interactionGeneration: state.interactionGeneration + 1,
    })),
  dispatch: (operation) =>
    set((state) => ({ layout: applyLayoutOperation(state.layout, operation) })),
  replace: (layout) => set({ layout }),
  cancelInteraction: () =>
    set((state) => ({ interactionGeneration: state.interactionGeneration + 1 })),
}));
