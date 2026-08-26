import { useEffect, useRef } from 'react';

export default function Modal({ title, onClose, children, footer }) {
  const dialogRef = useRef(null);
  // Whether the press that started this click landed on the backdrop. Selecting
  // text in a field and releasing the button outside the dialog otherwise
  // counts as a click on the backdrop — the click event fires on the common
  // ancestor of press and release — and threw away a half-filled form.
  const pressedBackdrop = useRef(false);
  const titleId = useRef(`modal-${Math.random().toString(36).slice(2, 9)}`).current;

  useEffect(() => {
    // Remember what had focus so we can restore it when the dialog closes.
    const previouslyFocused = document.activeElement;

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        // Simple focus trap: keep Tab/Shift+Tab within the dialog.
        const focusable = dialogRef.current?.querySelectorAll(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    // Move focus into the dialog (first field, else the dialog itself).
    const firstField = dialogRef.current?.querySelector(
      'input, select, textarea, button',
    );
    (firstField || dialogRef.current)?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const backdrop = e.target === e.currentTarget && pressedBackdrop.current;
        pressedBackdrop.current = false;
        if (backdrop) onClose();
      }}
    >
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
