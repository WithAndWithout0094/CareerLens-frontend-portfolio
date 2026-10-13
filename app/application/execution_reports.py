"""Administrator-only operational summaries, independent of ephemeral Render files.

The route layer supplies authorization. Never retain or return raw LLM responses.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone, timedelta
from uuid import UUID

STAGES = frozenset('parse_resume parse_job resume_embedding index_save criterion_evaluation evaluation_graph match_result_save report_render report_sql_save report_file_write evaluation_total execution_report_render execution_report_sql_save execution_report_file_write document_parse draft evidence_review independent_evaluation disagreement_recheck validation_repair global_critic lexical_search query_embedding vector_search resume_completeness job_fit qualifications practical_competitiveness targeted_recheck calculate'.split())
STATUSES = frozenset({'completed', 'failed', 'partial', 'running', 'cancelled', 'skipped'})


def number(value, *, integer=False):
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result) or result < 0 or result > 10**12 or integer and result != int(result):
        return None
    return int(result) if integer else result


def date(value):
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timezone is required')
    return parsed.astimezone(timezone.utc).isoformat()


def normalize_summary(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid summary')
    stages = []
    supplied_stages = value.get('stages')
    for row in (supplied_stages if isinstance(supplied_stages, list) else [])[:2000]:
        if not isinstance(row, dict):
            continue
        code = row.get('criterion_code')
        stages.append({'stage': row.get('stage') if row.get('stage') in STAGES or re.fullmatch(r'evaluate_[A-D][1-3]', str(row.get('stage', ''))) else 'other',
                       'criterion_code': code if re.fullmatch(r'[A-D][1-3]', str(code)) else None,
                       'attempt_number': number(row.get('attempt_number'), integer=True),
                       'status': row.get('status') if row.get('status') in STATUSES else 'unknown',
                       'duration_ms': number(row.get('duration_ms'))})
    return {'llm_call_count': number(value.get('llm_call_count'), integer=True),
            'stage_count': number(value.get('stage_count'), integer=True),
            'input_tokens': number(value.get('input_tokens'), integer=True),
            'output_tokens': number(value.get('output_tokens'), integer=True),
            'stages': stages}


def summarize_markdown(markdown, run_id):
    """Read only counts and the first timing table; discard response JSON entirely."""
    canonical = str(UUID(str(run_id)))
    if not isinstance(markdown, str) or len(markdown.encode('utf-8')) > 2 * 1024 * 1024:
        raise ValueError('Invalid report size')
    headers = re.findall(r'^\s*-\s*평가 run ID:\s*`?([0-9a-fA-F-]{36})`?\s*$', markdown, re.MULTILINE)
    if headers != [canonical]:
        raise ValueError('Mismatched report identifier')
    result = {}
    for field, label in [('llm_call_count', 'LLM 호출 수'), ('stage_count', '계측 단계 수')]:
        match = re.search(r'^- ' + label + r': (\d+)\s*$', markdown, re.MULTILINE)
        result[field] = number(match.group(1), integer=True) if match else None
    stages = []
    timing = re.search(r'^## 단계별 소요 시간\s*\n(.*?)(?=^## |\Z)', markdown, re.MULTILINE | re.DOTALL)
    for line in timing.group(1).splitlines() if timing else []:
        cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
        if len(cells) != 6 or number(cells[4]) is None:
            continue
        stages.append(dict(stage=cells[0], criterion_code=cells[1], attempt_number=cells[2], status=cells[3], duration_ms=cells[4]))
    result['stages'] = stages
    inputs, outputs = [], []
    # Call rows are interleaved with response JSON, so explicitly skip fenced data.
    calls = re.search(r'^## LLM 호출 기록\s*\n(.*)', markdown, re.MULTILINE | re.DOTALL)
    fenced = False
    for line in calls.group(1).splitlines() if calls else []:
        if line.lstrip().startswith('```'):
            fenced = not fenced
            continue
        if fenced:
            continue
        cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
        if len(cells) == 7 and cells[0].isdigit():
            token_pair = cells[-1].split('/')
            if len(token_pair) == 2:
                inputs.append(number(token_pair[0], integer=True)); outputs.append(number(token_pair[1], integer=True))
    result['input_tokens'] = sum(inputs) if inputs and all(item is not None for item in inputs) else None
    result['output_tokens'] = sum(outputs) if outputs and all(item is not None for item in outputs) else None
    return normalize_summary(result)


def render_summary(run_id, summary, source):
    data = normalize_summary(summary)
    label = '프로젝트에서 가져온 실행 기록' if source == 'imported' else '배포 환경에서 생성된 실행 기록'
    lines = ['# 평가 실행 운영 요약', '', f'- 평가 run ID: `{run_id}`', f'- 출처: {label}',
             f"- LLM 호출 수: {data['llm_call_count'] if data['llm_call_count'] is not None else '미수집'}",
             f"- 계측 단계 수: {data['stage_count'] if data['stage_count'] is not None else '미수집'}", '',
             '문서·프롬프트·모델 응답 원문은 이 화면에 포함하지 않습니다. 소요 시간은 실제 기록 값입니다.', '',
             '## 단계별 소요 시간', '', '| 단계 | 기준 | 시도 | 상태 | 소요 시간(ms) |', '|---|---|---:|---|---:|']
    for row in data['stages']:
        lines.append('| ' + ' | '.join(str(row[key]) if row[key] is not None else '미수집' for key in ['stage', 'criterion_code', 'attempt_number', 'status', 'duration_ms']) + ' |')
    return '\n'.join(lines) + '\n'


async def import_summaries(db, reports):
    if not isinstance(reports, list) or not 1 <= len(reports) <= 100:
        raise ValueError('Supply 1 to 100 summaries')
    # Validate the complete batch before making any database change.
    rows = [{'run_id': str(UUID(str(row['run_id']))), 'modified_at': date(row['modified_at']),
             'summary': normalize_summary(row['summary'])} for row in reports]
    if len({row['run_id'] for row in rows}) != len(rows):
        raise ValueError('Duplicate run identifier')
    await db.upsert('admin_execution_imports', rows, conflict='run_id')
    return {'imported_count': len(rows)}


async def list_reports(db, *, limit=50, offset=0):
    size = min(10000, offset + limit + 1)
    imported = await db.select('admin_execution_imports', select='run_id,modified_at', order='modified_at.desc', limit=size)
    deployed = await db.select('intermediate_artifacts', artifact_type='eq.execution_report', select='run_id,created_at', order='created_at.desc', limit=size)
    merged = {}
    for source, records in [('imported', imported), ('deployed', deployed)]:
        for row in records:
            run_id = str(row['run_id'])
            merged[run_id] = {'run_id': run_id, 'filename': f'{run_id}.md', 'modified_at': date(row.get('modified_at') or row['created_at']), 'source': source}
    rows = sorted(merged.values(), key=lambda row: row['modified_at'], reverse=True)
    page = rows[offset:offset + limit]
    return {'reports': page, 'has_more': len(rows) > offset + limit,
            'next_offset': offset + limit if len(rows) > offset + limit else None, 'scope': {'mode': 'admin'}}


async def report_detail(db, run_id):
    run_id = str(UUID(str(run_id)))
    rows = await db.select('intermediate_artifacts', run_id=f'eq.{run_id}', artifact_type='eq.execution_report', order='created_at.desc', limit=1)
    if rows:
        summary = summarize_markdown(rows[0].get('content', {}).get('markdown'), run_id)
        source, modified_at = 'deployed', rows[0]['created_at']
    else:
        rows = await db.select('admin_execution_imports', run_id=f'eq.{run_id}', limit=1)
        if not rows:
            return None
        summary, source, modified_at = normalize_summary(rows[0]['summary']), 'imported', rows[0]['modified_at']
    return {'report': {'run_id': run_id, 'filename': f'{run_id}.md', 'modified_at': date(modified_at),
                       'source': source, 'summary': summary, 'markdown': render_summary(run_id, summary, source)}}


async def imported_performance(db, *, days=30, limit=100):
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    records = await db.select('admin_execution_imports', modified_at=f'gte.{cutoff.isoformat()}', order='modified_at.desc', limit=limit)
    runs = []
    for row in records:
        summary = normalize_summary(row['summary'])
        duration = next((item['duration_ms'] for item in summary['stages'] if item['stage'] == 'evaluation_total'), None)
        runs.append({'id': str(row['run_id']), 'status': 'recorded', 'created_at': date(row['modified_at']),
                     'source': 'imported', 'duration_ms': duration, 'stages': summary['stages'],
                     'llm_call_count': summary['llm_call_count'], 'usage': {'input_tokens': summary['input_tokens'], 'output_tokens': summary['output_tokens']}})
    return runs
