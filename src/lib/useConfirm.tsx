import { useCallback, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void };

// Promise-based replacement for window.confirm: `await confirm("Delete this?")`
// resolves true/false once the person clicks a button on the centered,
// styled dialog instead of the browser's native (unstyled, off-brand) one.
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions | string) => {
    const opts = typeof options === "string" ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  function respond(value: boolean) {
    pending?.resolve(value);
    setPending(null);
  }

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.title}
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      danger={pending.danger}
      onConfirm={() => respond(true)}
      onCancel={() => respond(false)}
    />
  ) : null;

  return { confirm, dialog };
}
