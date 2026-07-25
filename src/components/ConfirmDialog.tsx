import * as Dialog from '@radix-ui/react-dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action (red). */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A styled, accessible replacement for the native `window.confirm`.
 * Built on Radix Dialog (focus-trapped, ESC-to-close, ARIA-correct) so it
 * matches the rest of the product's visual language.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm data-[state=open]:animate-[fade-in_120ms_ease-out]" />
        <Dialog.Content
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) onConfirm();
          }}
          className="fixed left-1/2 top-1/2 z-[201] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2
                     rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-2xl
                     data-[state=open]:animate-[pop-in_140ms_cubic-bezier(0.16,1,0.3,1)]"
        >
          <Dialog.Title className="text-[15px] font-semibold text-[var(--text-primary)]">
            {title}
          </Dialog.Title>
          {message && (
            <Dialog.Description className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
              {message}
            </Dialog.Description>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-md border border-[var(--border)] px-3.5 py-1.5 text-[13px] font-medium
                         text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]
                         hover:text-[var(--text-primary)] disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              autoFocus
              className={`rounded-md px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors disabled:opacity-60 ${
                danger
                  ? 'bg-[var(--red)] hover:brightness-110'
                  : 'bg-[var(--accent)] hover:bg-[var(--accent-dim)]'
              }`}
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
