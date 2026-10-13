"""Explicit public projection: timings and counts, never candidate information."""
from collections import defaultdict
from datetime import datetime, timezone
from uuid import UUID

from app.application.execution_reports import imported_performance, normalize_summary, number, date, report_detail

STATUSES = {'queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'recorded'}


def project(row):
    result = {'id': str(UUID(str(row['id']))), 'status': row.get('status') if row.get('status') in STATUSES else 'recorded',
              'created_at': date(row['created_at']), 'source': 'imported' if row.get('source') == 'imported' else 'deployed',
              'total_ms': number(row.get('total_ms', row.get('duration_ms'))),
              'stages': normalize_summary({'stages': row.get('stages', [])})['stages']}
    result['llm_call_count'] = number(row.get('llm_call_count'), integer=True)
    return result


async def performance(db, *, days=30, limit=100):
    live = await db.rpc('get_evaluation_performance', {'p_days': days, 'p_run_limit': limit})
    imported = await imported_performance(db, days=days, limit=limit)
    merged = {str(row['id']): project(row) for row in [*imported, *live.get('runs', [])]}
    runs = sorted(merged.values(), key=lambda row: row['created_at'], reverse=True)[:limit]
    times = sorted(row['total_ms'] for row in runs if row['total_ms'] is not None)
    groups = defaultdict(list)
    for row in runs:
        for stage in row['stages']:
            if stage['duration_ms'] is not None:
                groups[stage['stage']].append(stage['duration_ms'])
    def percentile(values, fraction):
        return sorted(values)[min(len(values) - 1, int((len(values) - 1) * fraction))] if values else None
    return {'generated_at': datetime.now(timezone.utc).isoformat(), 'runs': runs,
            'summary': {'run_count': len(runs), 'avg_total_ms': sum(times) / len(times) if times else None,
                        'p95_total_ms': percentile(times, .95)},
            'stages': [{'stage': key, 'sample_count': len(values), 'avg_ms': sum(values) / len(values),
                        'p50_ms': percentile(values, .5), 'p95_ms': percentile(values, .95), 'max_ms': max(values)}
                       for key, values in groups.items()],
            'scope': {'mode': 'public_portfolio', 'days': days, 'run_limit': limit, 'limited': len(runs) >= limit,
                      'reason': '포트폴리오 공개 체험: 실제 실행 시간과 상태만 제공합니다. 개인 이력서·점수·보고서 원문은 비공개입니다.'}}


async def detail(db, run_id):
    ident = str(run_id)
    rows = await db.select('evaluation_runs', id=f'eq.{ident}', select='id,status,created_at', limit=1)
    report = await report_detail(db, ident)
    if not rows and not report:
        return None
    summary = report['report']['summary'] if report else {'stages': []}
    if rows:
        stages = await db.select('evaluation_stage_timings', run_id=f'eq.{ident}',
                                select='stage,criterion_code,attempt_number,status,duration_ms', order='started_at.asc', limit=2000)
        row = {**rows[0], 'stages': stages}
    else:
        row = {'id': ident, 'status': 'recorded', 'created_at': report['report']['modified_at'],
               'source': 'imported', 'stages': summary['stages']}
    row['total_ms'] = next((stage['duration_ms'] for stage in row['stages'] if stage['stage'] == 'evaluation_total'), None)
    row['llm_call_count'] = summary.get('llm_call_count')
    clean = project(row)
    clean['usage'] = {key: number(summary.get(key), integer=True) for key in ('input_tokens', 'output_tokens')}
    clean['availability'] = {key: {'status': 'unavailable', 'reason': '개인 자료와 내부 원문은 공개 체험에 포함하지 않습니다.'}
                             for key in ('input', 'scores', 'memory', 'validation', 'test_evidence')}
    return {'run': clean, 'scope': {'mode': 'public_portfolio'}}
