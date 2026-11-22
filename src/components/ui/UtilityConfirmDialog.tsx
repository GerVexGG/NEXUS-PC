import { useEffect, useId, useRef, type ReactNode } from "react";

export function UtilityConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    cancelButton.current?.focus();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="nexus-panel fixed inset-0 m-auto w-[min(31rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto bg-[#10151D] p-5 text-[#E5EDF5] shadow-2xl backdrop:bg-black/70"
    >
      <h3 id={titleId} className="text-base font-semibold">{title}</h3>
      <div id={descriptionId} className="mt-2 space-y-2 text-sm text-[#a0adbb]">{children}</div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button ref={cancelButton} type="button" className="nexus-button" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="nexus-button nexus-button--danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
