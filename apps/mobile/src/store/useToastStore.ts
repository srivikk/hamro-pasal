import { create } from 'zustand';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastState {
  /** The toast on screen; a newer one replaces it. Memory only. */
  toast: Toast | null;
  show: (message: string, tone: ToastTone) => void;
  /** Dismisses the toast with this id, if it is still the one showing. */
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set) => ({
  toast: null,
  show: (message, tone) => {
    set({ toast: { id: nextId++, message, tone } });
  },
  dismiss: (id) => {
    set((state) => (state.toast?.id === id ? { toast: null } : state));
  },
}));
