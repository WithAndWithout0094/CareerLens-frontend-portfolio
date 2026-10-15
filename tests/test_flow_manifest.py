"""Source mutations prove the flow is generated, not an independently drawn map."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from app.infrastructure.flow_manifest import ROOT, OUTPUT, build_manifest


@pytest.fixture
def checkout(tmp_path):
    # Copy source only. Never copy .env, runtime DBs, user reports or node_modules.
    for folder in ('app', 'workers', 'scripts'):
        for source in (ROOT / folder).rglob('*.py'):
            destination = tmp_path / source.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
    for name in ('server.py', 'guest_analysis_service.py', 'guest_analysis_engine.py'):
        destination = tmp_path / 'frontend' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'frontend' / name, destination)
    for source in (ROOT / 'frontend/src').rglob('*.js'):
        if source.name == OUTPUT.name or 'vendor' in source.parts or 'generated' in source.parts:
            continue
        destination = tmp_path / source.relative_to(ROOT)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    return tmp_path


def generate(checkout, *, success=True):
    env = {key: value for key, value in os.environ.items()
           if not any(word in key.upper() for word in ('OPENAI', 'DATABASE_URL', 'JWT_SECRET', 'REDIS_URL', 'API_KEY'))}
    env['PYTHONPATH'] = str(checkout)
    result = subprocess.run([sys.executable, '-m', 'scripts.generate_flow_manifest'],
                            cwd=checkout, env=env, capture_output=True, text=True, encoding='utf-8', timeout=90)
    if not success:
        assert result.returncode != 0
        return result
    assert result.returncode == 0, result.stderr
    content = (checkout / OUTPUT).read_text(encoding='utf-8')
    return json.loads(content.split('export const FLOW_MANIFEST = ', 1)[1].rstrip(';\n'))


def replace(checkout, path, before, after):
    target = checkout / path
    content = target.read_text(encoding='utf-8')
    assert before in content
    target.write_text(content.replace(before, after, 1), encoding='utf-8')


def test_manifest_compiles_without_invoking_analysis_or_loading_secrets(monkeypatch):
    from app.agent.graphs.matching import EvaluationEngine
    def forbidden(*args, **kwargs):
        raise AssertionError('Graph generation must not evaluate a node')
    monkeypatch.setattr(EvaluationEngine, 'evaluate', forbidden)
    monkeypatch.setattr(EvaluationEngine, 'parse', forbidden)
    manifest = build_manifest()
    nodes = {node['id']: node for node in manifest['nodes']}
    assert len(manifest['overview']) == 7
    assert {f'domain_{letter}' for letter in 'abcd'} <= nodes.keys()
    assert {f'criterion:{letter}{number}' for letter in 'ABCD' for number in range(1, 4)} <= nodes.keys()
    assert all(edge['from'] in nodes and edge['to'] in nodes for edge in manifest['edges'])
    assert all(ref['path'] and not Path(ref['path']).is_absolute()
               for node in nodes.values() for ref in node['sourceRefs'])
    assert all(set(node) <= {'id', 'label', 'description', 'kind', 'sourceRefs', 'parentId', 'contract'} for node in nodes.values())
    contracts = [node['contract'] for node in nodes.values() if 'contract' in node]
    assert len(contracts) == 12
    assert all(set(contract) == {'code', 'name', 'domain', 'weight', 'anchors'} for contract in contracts)


def test_real_route_and_schema_addition_removal_updates_cards(checkout):
    original = generate(checkout)
    route = checkout / 'app/api/v1/routes/api.py'
    route.write_text(route.read_text(encoding='utf-8') + "\n@router.get('/portfolio-probe', response_model=RunStatus)\nasync def portfolio_probe():\n    return {}\n", encoding='utf-8')
    replace(checkout, 'app/api/v1/schemas.py', 'class RunStatus(BaseModel):', 'class RunStatus(BaseModel):\n    source_probe: str')
    changed = generate(checkout)
    ids = {node['id'] for node in changed['nodes']}
    assert 'api:GET:/api/v1/portfolio-probe' in ids
    assert 'field:RunStatus.source_probe' in ids
    assert changed['sourceDigest'] != original['sourceDigest']
    assert {'from': 'api:GET:/api/v1/portfolio-probe', 'to': 'schema:RunStatus', 'kind': 'produces'} in changed['edges']
    replace(checkout, 'app/api/v1/routes/api.py', "\n@router.get('/portfolio-probe', response_model=RunStatus)\nasync def portfolio_probe():\n    return {}\n", '')
    replace(checkout, 'app/api/v1/schemas.py', '    source_probe: str\n', '')
    restored = generate(checkout)
    assert 'api:GET:/api/v1/portfolio-probe' not in {node['id'] for node in restored['nodes']}
    assert 'field:RunStatus.source_probe' not in {node['id'] for node in restored['nodes']}


def test_real_graph_node_and_edge_mutation_updates_relationships(checkout):
    replace(checkout, 'app/agent/graphs/matching.py', "        graph.add_edge('calculate', END)",
            "        graph.add_node('source_probe', lambda state: {})\n        graph.add_edge('calculate', 'source_probe')\n        graph.add_edge('source_probe', END)")
    manifest = generate(checkout)
    assert 'graph:source_probe' in {node['id'] for node in manifest['nodes']}
    assert {'from': 'scoring', 'to': 'graph:source_probe', 'kind': 'flow'} in manifest['edges']
    assert {'from': 'graph:source_probe', 'to': 'analysis:end', 'kind': 'flow'} in manifest['edges']
    assert {'from': 'scoring', 'to': 'analysis:end', 'kind': 'flow'} not in manifest['edges']
    replace(checkout, 'app/agent/graphs/matching.py',
            "        graph.add_node('source_probe', lambda state: {})\n        graph.add_edge('calculate', 'source_probe')\n        graph.add_edge('source_probe', END)",
            "        graph.add_edge('calculate', END)")
    restored = generate(checkout)
    assert 'graph:source_probe' not in {node['id'] for node in restored['nodes']}


def test_rubric_criterion_and_timed_pipeline_changes_appear(checkout):
    replace(checkout, 'app/modules/analysis/scoring/rubric.py', 'CRITERIA = [', "CRITERIA = [\n    ('A4', 'resume_completeness', '새 실행 기준', .1, 'source mutation'),")
    replace(checkout, 'app/application/evaluation.py', "    rendered = await measure('report_render', lambda: render(result))",
            "    await measure('new_source_stage', lambda: None)\n    rendered = await measure('report_render', lambda: render(result))")
    manifest = generate(checkout)
    nodes = {node['id']: node for node in manifest['nodes']}
    assert nodes['criterion:A4']['parentId'] == 'domain_a'
    assert nodes['criterion:A4']['label'] == 'A4 · 새 실행 기준'
    assert nodes['criterion:A4']['contract'] == {
        'code': 'A4', 'name': '새 실행 기준', 'domain': 'resume_completeness',
        'weight': .1, 'anchors': 'source mutation',
    }
    assert {'from': 'stage:match_result_save', 'to': 'stage:new_source_stage', 'kind': 'flow'} in manifest['edges']
    assert {'from': 'stage:new_source_stage', 'to': 'stage:report_render', 'kind': 'flow'} in manifest['edges']


def test_existing_criterion_semantics_change_without_changing_its_identity(checkout):
    replace(checkout, 'app/modules/analysis/scoring/rubric.py',
            "('C2', 'qualifications', '학력·전공 충족도', .25,",
            "('C2', 'qualifications', '학력 근거 재확인', .20,")
    replace(checkout, 'app/modules/analysis/scoring/rubric.py',
            '명시 학력 최소 조건 충족 100, 미충족 0;',
            '변경된 학력 기준: 명시된 학위 근거를 확인;')
    manifest = generate(checkout)
    nodes = {node['id']: node for node in manifest['nodes']}
    contract = nodes['criterion:C2']['contract']
    assert contract['code'] == 'C2'
    assert contract['domain'] == 'qualifications'
    assert contract['name'] == '학력 근거 재확인'
    assert contract['weight'] == .20
    assert contract['anchors'].startswith('변경된 학력 기준: 명시된 학위 근거를 확인;')
    assert nodes['criterion:C2']['parentId'] == 'domain_c'


@pytest.mark.parametrize('path,before,after', [
    ('app/agent/graphs/matching.py', "graph.add_edge('calculate', END)", "graph.add_edge('missing_source_node', END)"),
    ('app/api/v1/routes/api.py', 'response_model=RunStatus', 'response_model=MissingSchema'),
    ('frontend/src/app/main.js', "recordFlowEvent('report'", "recordFlowEvent('unknown_source_node'"),
])
def test_broken_source_references_fail_generation(checkout, path, before, after):
    replace(checkout, path, before, after)
    generate(checkout, success=False)
    assert not (checkout / OUTPUT).exists()


def test_source_comments_and_secret_defaults_are_not_public_cards(checkout):
    sentinel = 'PRIVATE_SENTINEL_DO_NOT_PUBLISH_9351'
    route = checkout / 'app/api/v1/routes/api.py'
    route.write_text(route.read_text(encoding='utf-8') + f"\nPRIVATE_TEST_VALUE = '{sentinel}'\n", encoding='utf-8')
    source = checkout / 'frontend/src/app/main.js'
    source.write_text(source.read_text(encoding='utf-8') + "\n// recordFlowEvent('not_a_real_call')\n", encoding='utf-8')
    manifest = generate(checkout)
    rendered = json.dumps(manifest)
    assert sentinel not in rendered
    assert 'not_a_real_call' not in rendered
