import { useEffect, useState } from 'react';

// Files dropped anywhere on the window, rather than only on the box drawn for
// them. Aiming at a dashed rectangle is the fiddly part of dragging a document
// in, and the window is a target you cannot miss.
//
// The listeners are attached whether or not this caller is the one taking the
// drop, because a file dropped on a page that isn't expecting one makes the
// browser navigate to it — which would throw away a half-filled form. Only the
// `active` caller receives the files, so a dialog takes the drop over from the
// page underneath while it is open, and exactly one thing ever answers.
export function useWindowFileDrop(onFiles, active = true) {
  const [over, setOver] = useState(false);

  useEffect(() => {
    // dragenter/dragleave fire for every element the pointer crosses, so the
    // nesting is counted rather than toggled — otherwise the prompt flickers as
    // the file passes over a table or a form field.
    let depth = 0;
    const isFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

    const enter = (e) => {
      if (!isFiles(e)) return;
      depth += 1;
      if (active) setOver(true);
    };
    const dragOver = (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const drop = (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      if (!active) return;
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) onFiles(files);
    };

    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', dragOver);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', dragOver);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [onFiles, active]);

  return over && active;
}

// What is shown while a file is over the window: says what letting go will do,
// and never gets in the way of the drop it is inviting (pointer-events: none).
export function FileDropPrompt({ title, hint, overDialog = false }) {
  return (
    <div className={`page-drop ${overDialog ? 'over-dialog' : ''}`}>
      <div className="page-drop-card">
        <div className="page-drop-title">{title}</div>
        {hint && (
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{hint}</div>
        )}
      </div>
    </div>
  );
}
