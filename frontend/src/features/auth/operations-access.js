import { getSession } from '../../shared/api/client.js';
import { showPageGuide, dismissPageGuide } from '../portfolio/page-guide.js';

export const isOperationsMember = (session) => Boolean(
  session && typeof session === 'object',
);

/** Public portfolio monitor: only sanitized operational metadata is exposed. */
export async function mountMemberFlow(root, {
  readSession = getSession,
  loadViewer = () => import('../activity-flow/viewer.js'),
  browser = globalThis.window,
} = {}) {
  let dispose;
  let generation = 0;
  let stopped = false;
  let verifying = false;
  let timer;
  let retryTimer;
  let retryCount = 0;
  let locked = false;
  const retryDelays = [1000, 3000, 7000];
  const clearRetry = () => {
    if (retryTimer !== undefined) browser?.clearTimeout?.(retryTimer);
    retryTimer = undefined;
  };
  const stopWatching = () => {
    if (timer !== undefined) browser?.clearInterval?.(timer);
    timer = undefined;
    browser?.removeEventListener?.('focus', verify);
    browser?.removeEventListener?.('pageshow', verify);
  };
  const lock = () => {
    generation += 1;
    locked = true;
    clearRetry();
    stopWatching();
    dispose?.();
    dispose = undefined;
    dismissPageGuide();
    root.innerHTML = '<main id="main" class="loading-screen"><h1>공개 모니터링 연결을 확인하지 못했습니다.</h1><p>개인정보를 제외한 운영 상태를 읽기 전용으로 공개하는 포트폴리오 화면입니다. 새로고침하여 다시 연결해 주세요.</p><a class="button secondary" href="/?view=flow">다시 연결</a><a class="button secondary" href="/#/intro">홈으로 돌아가기</a></main>';
  };
  const startWatching = () => {
    if (timer !== undefined) return;
    browser?.addEventListener?.('focus', verify);
    browser?.addEventListener?.('pageshow', verify);
    timer = browser?.setInterval?.(verify, 60000);
  };
  const reconnect = () => {
    stopWatching();
    clearRetry();
    dismissPageGuide();
    // Membership is currently unknown. Hide the old view until a fresh /me
    // check succeeds, but do not misrepresent a server restart as a logout.
    dispose?.();
    dispose = undefined;
    const willRetry = retryCount < retryDelays.length && typeof browser?.setTimeout === 'function';
    root.innerHTML = `<main id="main" class="loading-screen"><h1>이용 흐름 연결을 확인하지 못했습니다.</h1><p>${willRetry ? '잠시 후 다시 연결합니다.' : '연결 상태를 확인한 뒤 다시 시도해 주세요.'} 서버 연결이 확인되면 공개 이용 흐름을 다시 표시합니다.</p><button type="button" class="button primary" data-operations-retry>다시 연결</button><a class="button secondary" href="/#/intro">홈으로 돌아가기</a></main>`;
    if (willRetry) retryTimer = browser.setTimeout(() => {
      retryTimer = undefined;
      // A background observer must finish its bounded recovery rather than
      // consume the only retry while regular visibility checks are suspended.
      return verify(true);
    }, retryDelays[retryCount++]);
  };
  async function verify(force = false) {
    if (stopped || locked || verifying || (force !== true && browser?.document?.hidden)) return;
    const current = generation;
    verifying = true;
    try {
      let session;
      try { session = await readSession(); }
      catch (error) {
        // Public metadata does not require a valid member session.
        if ([401, 403].includes(error?.status)) session = { user: null };
        else throw error;
      }
      if (stopped || current !== generation) return;
      if (!isOperationsMember(session)) session = { user: null };
      if (!dispose) {
        const { mountFlowViewer } = await loadViewer();
        if (stopped || current !== generation) return;
        dispose = mountFlowViewer(root, { central: true, paired: true, onUnauthorized: lock });
        showPageGuide('flow', { session });
      }
      clearRetry();
      retryCount = 0;
      startWatching();
    } catch (error) {
      if (!stopped && current === generation && error?.name !== 'AbortError') {
        if (error?.status === 401 || error?.status === 403) lock();
        else reconnect();
      }
    } finally { verifying = false; }
  }
  function manualRetry(event) {
    if (!event.target?.closest?.('[data-operations-retry]') || stopped || locked || verifying) return;
    clearRetry();
    retryCount = 0;
    void verify();
  }
  root.addEventListener?.('click', manualRetry);
  ++generation;
  root.innerHTML = '<main id="main" class="loading-screen" role="status">공개 이용 흐름을 연결하는 중…</main>';
  await verify(true);
  return () => {
    stopped = true; generation += 1; stopWatching(); clearRetry(); dispose?.(); dismissPageGuide();
    root.removeEventListener?.('click', manualRetry);
  };
}
