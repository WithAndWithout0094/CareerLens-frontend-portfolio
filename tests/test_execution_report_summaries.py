import json
import pytest
from app.application.execution_reports import summarize_markdown, render_summary, import_summaries, list_reports

RUN = '11111111-1111-4111-8111-111111111111'
RAW = f'''# 평가 실행 기록
- 평가 run ID: `{RUN}`
- LLM 호출 수: 2
- 계측 단계 수: 1
## 단계별 소요 시간
| 단계 | 기준 | 시도 | 상태 | 소요 시간(ms) | 오류 유형 |
| parse_resume | — | 1 | completed | 12.5 | — |
## LLM 호출 기록
| 1 | document_parse | resume | ParsedResume | 성공 | 10 | 12/4 |
### 호출 1
```json
{{"email":"private@example.test", "resume":"PRIVATE_DOCUMENT", "token":"SECRET"}}
```
| 2 | draft | A1 | Result | 성공 | 10 | 8/2 |
### 호출 2
```json
{{"text":"PRIVATE_RESULT"}}
```
'''

def test_summaries_drop_all_document_credentials_and_keep_recorded_values():
    summary = summarize_markdown(RAW, RUN)
    assert summary['llm_call_count'] == 2
    assert summary['input_tokens'] == 20
    assert summary['output_tokens'] == 6
    assert summary['stages'][0]['duration_ms'] == 12.5
    output = json.dumps(summary) + render_summary(RUN, summary, 'imported')
    for private in ['PRIVATE', 'SECRET', 'private@example.test', 'ParsedResume']:
        assert private not in output


def test_identity_is_verified_and_unknown_stage_text_is_not_exported():
    with pytest.raises(ValueError):
        summarize_markdown(RAW, '22222222-2222-4222-8222-222222222222')
    summary = summarize_markdown(RAW.replace('parse_resume', 'PRIVATE_DOCUMENT'), RUN)
    assert summary['stages'][0]['stage'] == 'other'


@pytest.mark.asyncio
async def test_invalid_batch_never_partially_imports():
    class DB:
        called = False
        async def upsert(self, *args, **kwargs): self.called = True
    db = DB()
    valid = {'run_id': RUN, 'modified_at': '2026-10-13T00:00:00Z', 'summary': summarize_markdown(RAW, RUN)}
    with pytest.raises(ValueError):
        await import_summaries(db, [valid, {**valid, 'run_id': '../wrong'}])
    assert not db.called


@pytest.mark.asyncio
async def test_durable_deployed_report_wins_imported_duplicate_and_paginates():
    class DB:
        async def select(self, table, **kwargs):
            if table == 'admin_execution_imports':
                return [{'run_id': RUN, 'modified_at': '2026-10-12T00:00:00Z'},
                        {'run_id': '22222222-2222-4222-8222-222222222222', 'modified_at': '2026-10-11T00:00:00Z'}]
            return [{'run_id': RUN, 'created_at': '2026-10-13T00:00:00Z'}]
    page = await list_reports(DB(), limit=1)
    assert page['reports'][0]['source'] == 'deployed'
    assert page['has_more'] and page['next_offset'] == 1
