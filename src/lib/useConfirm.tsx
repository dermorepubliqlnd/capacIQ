import { useCallback, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface AlertOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
}

type PendingConfirm = ConfirmOptions & { resolve: (value: boolean) => void; alertOnly?: boolean };

// Promise-based replacement for window.confirm/window.alert: `await confirm("Delete this?")`
// resolves true/false once the person clicks a button on the centered,
// styled dialog instead of the browser's native (unstyled, off-brand) one.
// `alert(...)` is the same dialog with only an OK button, for error/notice
// messages that used to be window.alert() -- keeps every popup in this app
// visually consistent instead of some being native browser dialogs.
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions | string) => {
    const opts = typeof options === "string" ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  const alert = useCallback((options: AlertOptions | string) => {
    const opts = typeof options === "string" ? { message: options } : options;
    return new Promise<void>((resolve) => {
      setPending({ ...opts, alertOnly: true, resolve: () => resolve() });
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
      confirmLabel={pending.confirmLabel ?? (pending.alertOnly ? "OK" : undefined)}
      cancelLabel={pending.cancelLabel}
      danger={pending.danger}
      hideCancel={pending.alertOnly}
      onConfirm={() => respond(true)}
      onCancel={() => respond(false)}
    />
  ) : null;

  return { confirm, alert, dialog };
}
