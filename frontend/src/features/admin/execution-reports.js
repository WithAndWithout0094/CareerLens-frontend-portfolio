import { escapeHtml as e } from '../../shared/components/ui.js';
import { renderMarkdown } from '../../shared/components/markdown.js';
import { formatTime } from './performance-data.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function executionReportsPanel() {
  return `<section class="admin-dashboard__execution-reports" data-execution-reports aria-label="저장된 실행 보고서">
    <h2>저장된 실행 보고서</h2><p>프로젝트에서 가져온 운영 기록과 배포 후 생성된 보고서를 확인합니다. 기록은 데이터베이스에 보관하며 문서 원문·모델 응답은 표시하지 않습니다.</p>
    <button type="button" class="button secondary" data-execution-load>보고서 목록 불러오기</button>
    <p role="status" aria-live="polite" data-execution-status></p>
    <div data-execution-list></div><div data-execution-content></div>
  </section>`;
}

export function renderExecutionReport(report) {
  if (!report || !UUID.test(report.run_id) || typeof report.markdown !== 'string')
    throw new Error('Invalid execution report');
  return `<article class="admin-dashboard__execution-body" aria-label="선택한 실행 보고서"><h3>${e(report.filename || `${report.run_id}.md`)}</h3>${renderMarkdown(report.markdown)}</article>`;
}

export function mountExecutionReports(root, api, { window: windowObject = globalThis.window, refreshIntervalMs = 5000 } = {}) {
  const host = root.querySelector('[data-execution-reports]');
  if (!host) return () => {};
  const list = host.querySelector('[data-execution-list]');
  const content = host.querySelector('[data-execution-content]');
  const status = host.querySelector('[data-execution-status]');
  const load = host.querySelector('[data-execution-load]');
  let rows = [], next = null, selected = null, listRequest, reportRequest;
  let listGeneration = 0, reportGeneration = 0, disposed = false;

  function renderList() {
    list.innerHTML = rows.length ? `<div class="admin-dashboard__execution-list">${rows.map((row) =>
      `<button type="button" class="button secondary compact" data-execution-open="${e(row.run_id)}" aria-pressed="${selected === row.run_id}">${e(row.filename)}<small>${row.source === 'imported' ? '프로젝트에서 가져온 기록' : '배포 환경 분석 기록'}${row.modified_at ? ` · ${e(formatTime(row.modified_at))}` : ''}</small></button>`
    ).join('')}</div>` : '<p>저장된 실행 보고서가 없습니다. 배포 환경에서 분석이 완료되면 이 목록에 추가됩니다.</p>';
    if (next !== null) list.innerHTML += '<button type="button" class="button secondary compact" data-execution-more>다음 기록 확인</button>';
  }

  async function loadList(offset = 0) {
    listRequest?.abort();
    const current = ++listGeneration;
    listRequest = new AbortController();
    load.disabled = true;
    status.textContent = '저장된 실행 보고서 목록을 확인하고 있습니다.';
    try {
      const result = await api(`/admin/execution-reports?limit=50&offset=${offset}`, { signal: listRequest.signal });
      if (disposed || current !== listGeneration) return;
      if (!Array.isArray(result?.reports)) throw new Error('Invalid report list');
      const incoming = result.reports.filter((row) => UUID.test(row?.run_id) && typeof row.filename === 'string');
      rows = [...new Map([...(offset ? rows : []), ...incoming].map((row) => [row.run_id, row])).values()];
      next = result.has_more && Number.isSafeInteger(result.next_offset) && result.next_offset > offset ? result.next_offset : null;
      load.textContent = '보고서 목록 새로고침';
      renderList();
      status.textContent = `${rows.length}개의 실행 보고서를 찾았습니다.${next !== null ? ' 다음 기록도 확인할 수 있습니다.' : ''}`;
    } catch (error) {
      if (disposed || current !== listGeneration || error?.name === 'AbortError') return;
      status.textContent = error?.status === 401 || error?.status === 403
        ? '로그인 상태를 확인한 뒤 다시 불러와 주세요.'
        : '실행 보고서 목록을 불러오지 못했습니다. 목록 불러오기를 다시 눌러 주세요.';
    } finally {
      if (!disposed && current === listGeneration) load.disabled = false;
    }
  }

  async function openReport(id) {
    if (!UUID.test(id) || !rows.some((row) => row.run_id === id)) return;
    reportRequest?.abort();
    const current = ++reportGeneration;
    reportRequest = new AbortController();
    selected = id;
    renderList();
    content.innerHTML = '<p role="status">선택한 실행 보고서를 불러오는 중입니다.</p>';
    try {
      const result = await api(`/admin/execution-reports/${id}`, { signal: reportRequest.signal });
      if (disposed || current !== reportGeneration) return;
      if (result?.report?.run_id !== id) throw new Error('Mismatched execution report');
      content.innerHTML = renderExecutionReport(result.report);
      status.textContent = '선택한 실행 보고서를 불러왔습니다.';
    } catch (error) {
      if (disposed || current !== reportGeneration || error?.name === 'AbortError') return;
      content.innerHTML = `<p role="alert">${error?.status === 404 ? '선택한 실행 보고서가 현재 서버에 없습니다.' : '보고서를 불러오지 못했습니다. 해당 보고서 버튼을 다시 눌러 주세요.'}</p>`;
    }
  }

  function click(event) {
    if (event.target.closest('[data-execution-load]')) void loadList();
    else if (event.target.closest('[data-execution-more]') && next !== null) void loadList(next);
    else {
      const button = event.target.closest('[data-execution-open]');
      if (button) void openReport(button.dataset.executionOpen);
    }
  }
  host.addEventListener('click', click);
  void loadList();
  function refreshWhenVisible() {
    if (!disposed && !load.disabled && windowObject?.document?.visibilityState !== 'hidden') void loadList();
  }
  const timer = windowObject?.setInterval?.(refreshWhenVisible, refreshIntervalMs);
  windowObject?.addEventListener?.('focus', refreshWhenVisible);
  windowObject?.document?.addEventListener?.('visibilitychange', refreshWhenVisible);
  return () => {
    disposed = true;
    listRequest?.abort();
    reportRequest?.abort();
    if (timer !== undefined) windowObject?.clearInterval?.(timer);
    windowObject?.removeEventListener?.('focus', refreshWhenVisible);
    windowObject?.document?.removeEventListener?.('visibilitychange', refreshWhenVisible);
    host.removeEventListener('click', click);
    rows = [];
    list.innerHTML = '';
    content.innerHTML = '';
  };
}
