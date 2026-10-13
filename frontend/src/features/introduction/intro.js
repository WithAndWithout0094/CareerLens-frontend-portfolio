export const INTRODUCTION_DURATION_MS = 2500;

export function bindIntroduction({ onComplete } = {}) {
  const root = document.querySelector('[data-introduction]');
  if (!root) return () => {};

  const skip = root.querySelector('[data-intro-skip]');
  let disposed = false;
  let timer;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    skip?.removeEventListener('click', complete);
    document.removeEventListener?.('careerlens:guide-open', pause);
    document.removeEventListener?.('careerlens:guide-dismiss', resume);
  };
  const complete = () => {
    if (disposed) return;
    dispose();
    onComplete?.();
  };

  const pause = () => clearTimeout(timer);
  const resume = () => { if (!disposed) { clearTimeout(timer); timer = setTimeout(complete, INTRODUCTION_DURATION_MS); } };

  skip?.addEventListener('click', complete);
  document.addEventListener?.('careerlens:guide-open', pause);
  document.addEventListener?.('careerlens:guide-dismiss', resume);
  timer = setTimeout(complete, INTRODUCTION_DURATION_MS);
  return dispose;
}
