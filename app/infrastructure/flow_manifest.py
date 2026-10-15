"""Build public flow metadata from executable declarations, never application data.

Only the evaluation graph is imported: compiling it constructs a graph without
invoking a node. Routes, schemas, calls and timed pipeline stages are read as AST.
The browser receives identifiers and source locations, not source text/defaults.
"""
from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = Path('frontend/src/features/activity-flow/generated-manifest.js')
MANIFEST_VERSION = 1
HTTP_METHODS = {'get', 'post', 'put', 'patch', 'delete', 'head', 'options'}

# Presentation metadata only. No edge is declared in this table.
GROUPS = [
    ('auth', '접속·계정', '화면 진입과 로그인·회원가입·계정 확인'),
    ('resume', '이력서 준비', '파일과 가상 이력서 준비·입력 확인'),
    ('posting', '직무·공고', '희망 직무와 지원할 공고 선택'),
    ('evaluate', '분석 요청', '분석 접수·대기·진행 확인·취소'),
    ('analysis', 'AI 분석', '문서 해석·영역 평가·검증·점수 계산'),
    ('report', '보고서', '결과 저장·인증 후 표시·저장 결과 조회'),
    ('dashboard', '운영·보관', '여러 사용자의 처리 상태와 운영 기록'),
]
RAW_GROUPS = {
    'visit': 'auth', 'auth': 'auth', 'signup': 'auth', 'logout': 'auth', 'session': 'auth',
    'api_auth': 'auth', 'api_signup': 'auth', 'api_session': 'auth',
    'resume': 'resume', 'input_check': 'resume', 'api_resume': 'resume', 'api_convert': 'resume',
    'role': 'posting', 'posting': 'posting', 'api_jobs': 'posting',
    'evaluate': 'evaluate', 'api_evaluation': 'evaluate', 'queue': 'evaluate',
    'api_guest_service': 'evaluate', 'api_guest_analysis': 'evaluate', 'cancel': 'evaluate', 'api_cancel': 'evaluate',
    'analysis': 'analysis', 'parse_resume': 'analysis', 'parse_job': 'analysis', 'indexing': 'analysis',
    'validation': 'analysis', 'scoring': 'analysis',
    'report': 'report', 'api_report': 'report', 'database': 'report', 'guest_store': 'report',
    'report_lock': 'report', 'guest_claim': 'report', 'result_delivery': 'report', 'history': 'report',
    'api_guest_claim': 'report', 'api_guest_reports': 'report', 'notice': 'report', 'storage_ack': 'report',
    'dashboard': 'dashboard', 'api_dashboard': 'dashboard', 'local_data': 'dashboard', 'guest_cleanup': 'dashboard',
    'database_read': 'dashboard', 'archive': 'dashboard',
}
GRAPH_LABELS = {
    '__start__': ('analysis:start', '영역 평가 시작'),
    '__end__': ('analysis:end', '영역 평가 완료'),
    'global_critic': ('validation', '전체 결과 교차 검토'),
    'targeted_recheck': ('graph:targeted_recheck', '지적 항목 재평가'),
    'calculate': ('scoring', '최종 점수 계산'),
}
STAGE_LABELS = {
    'parse_resume': '이력서 해석', 'parse_job': '공고 해석',
    'resume_embedding': '이력서 근거 임베딩', 'index_save': '검색 인덱스 저장',
    'evaluation_graph': 'AI 분석', 'match_result_save': '분석 점수 저장',
    'report_render': '보고서 생성', 'report_sql_save': '회원 보고서 저장',
    'report_file_write': '보고서 파일 보관',
}


class ManifestError(ValueError):
    """An executable structure cannot be represented without inventing an edge."""


def _literal(node, fallback=None):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError):
        return fallback


def _name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _name(node.value)
        return f'{base}.{node.attr}' if base else ''
    return ''


def _functions(tree):
    """Qualified function names, including route closures, with lexical scope."""
    found = {}
    def visit(node, prefix=''):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                key = f'{prefix}.{child.name}' if prefix else child.name
                found[key] = child
                visit(child, key)
            elif isinstance(child, ast.ClassDef):
                visit(child, f'{prefix}.{child.name}' if prefix else child.name)
            else:
                visit(child, prefix)
    visit(tree)
    return found


def _body_calls(function):
    # A nested callback is a separate source node, not an eagerly executed step.
    def visit(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            return
        if isinstance(node, ast.Call):
            yield node
        for child in ast.iter_child_nodes(node):
            yield from visit(child)
    for statement in function.body:
        yield from visit(statement)


def _js_tokens(text):
    """Lex direct literal observation calls; never inspect text in comments.

    This is deliberately not a JS control-flow parser. Template interpolation
    and computed call arguments are outside this extractor's supported scope.
    """
    pattern = re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|`(?:\\.|[^`])*`|\'(?:\\.|[^\'\\])*\'|"(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*|[^\s]')
    for match in pattern.finditer(text):
        value = match.group()
        if value.startswith(('//', '/*')):
            continue
        yield value, match.start()


def _js_string(token):
    if len(token) < 2 or token[0] not in "'\"" or token[-1] != token[0]:
        return None
    try:
        return ast.literal_eval(token)
    except (ValueError, SyntaxError):
        return None


def source_paths(root):
    files = set()
    for folder in ('app/api/v1', 'app/application', 'app/agent', 'app/modules/analysis', 'workers'):
        files.update(path for path in (root / folder).rglob('*.py') if '__pycache__' not in path.parts)
    files.update(root / path for path in (
        'frontend/server.py', 'frontend/guest_analysis_service.py', 'frontend/guest_analysis_engine.py',
        'app/infrastructure/flow_manifest.py',
    ))
    files.update(path for path in (root / 'frontend/src').rglob('*.js')
                 if 'activity-flow' not in path.parts and 'node_modules' not in path.parts
                 and 'vendor' not in path.parts and 'generated' not in path.parts
                 and path.name != 'matching-eye.js')  # committed Three.js build, not flow declarations
    files.update(root / f'frontend/src/features/activity-flow/{name}'
                 for name in ('events.js', 'catalog.js', 'backend-progress.js'))
    return sorted(path for path in files if path.is_file())


def _group_for_path(path):
    if any(word in path for word in ('admin', 'performance', 'flow/events', 'execution-report')):
        return 'dashboard'
    if any(word in path for word in ('auth', '/me')):
        return 'auth'
    if 'resume' in path:
        return 'resume'
    if any(word in path for word in ('jobs', 'companies', 'career', 'posting')):
        return 'posting'
    if any(word in path for word in ('report', '/result', '/claim')):
        return 'report'
    if any(word in path for word in ('evaluation', 'analys', 'capabilities')):
        return 'evaluate'
    return 'dashboard'


class Builder:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.nodes = {}
        self.edges = {}
        self.groups = {}
        self.trees = {}
        self.sources = {}
        for path in source_paths(self.root):
            relative = path.relative_to(self.root).as_posix()
            content = path.read_text(encoding='utf-8-sig')
            self.sources[relative] = content
            if path.suffix == '.py':
                self.trees[relative] = ast.parse(content, filename=relative)

    def ref(self, path, symbol, line=1):
        if path not in self.sources or not isinstance(line, int) or line < 1:
            raise ManifestError(f'Invalid source reference: {path}:{symbol}')
        return {'path': path, 'symbol': symbol, 'line': line}

    def node(self, ident, label=None, *, kind='source', parent=None, group='dashboard', description='', ref=None):
        if not isinstance(ident, str) or not ident or len(ident) > 220:
            raise ManifestError('Invalid flow identifier')
        if ident not in self.nodes:
            self.nodes[ident] = {'id': ident, 'label': label or ident, 'description': description,
                                 'kind': kind, 'sourceRefs': []}
            self.groups[ident] = group
        item = self.nodes[ident]
        if ref and ref not in item['sourceRefs']:
            item['sourceRefs'].append(ref)
        if parent and parent != ident:
            item.setdefault('parentId', parent)
            self.edge(parent, ident, 'contains')
        return ident

    def edge(self, source, target, kind='calls'):
        if source != target:
            self.edges[(source, target, kind)] = {'from': source, 'to': target, 'kind': kind}

    def observations(self):
        path = 'frontend/src/features/activity-flow/events.js'
        tokens = list(_js_tokens(self.sources[path]))
        # Read the exact allowlist the live event store consumes.
        begin = next((i for i, (token, _) in enumerate(tokens) if token == 'FLOW_NODES'), None)
        if begin is None:
            raise ManifestError('Live observation allowlist is missing')
        end = next(i for i in range(begin, len(tokens)) if tokens[i][0] == ']')
        ids = [_js_string(token) for token, _ in tokens[begin:end] if _js_string(token)]
        if not ids:
            raise ManifestError('Live observation allowlist must be literal')
        labels = {}
        label_positions = {}
        # Limit label metadata to declarations, excluding later state arrays and
        # fixture sequences that also contain three strings.
        catalog_source = self.sources['frontend/src/features/activity-flow/catalog.js'].split('export const FLOW_STATES', 1)[0]
        catalog = list(_js_tokens(catalog_source))
        for index in range(len(catalog) - 6):
            values = [_js_string(catalog[index + offset][0]) for offset in (1, 3, 5)]
            if catalog[index][0] == '[' and all(values) and re.fullmatch(r'[a-z][a-z_]{1,60}', values[0]):
                labels.setdefault(values[0], values[1:])
                label_positions.setdefault(values[0], catalog[index][1])
        for ident in ids:
            label, description = labels.get(ident, [ident, '실제 브라우저 관측 지점'])
            self.node(ident, label, kind='observation', group=RAW_GROUPS.get(ident, 'analysis' if ident.startswith('domain_') else 'dashboard'),
                      description=description, ref=self.ref(path, 'FLOW_NODES', self.sources[path].count('\n', 0, tokens[begin][1]) + 1))
        catalog_path = 'frontend/src/features/activity-flow/catalog.js'
        for ident in labels.keys() - set(ids):
            label, description = labels[ident]
            self.node(ident, label, kind='demo', group=RAW_GROUPS.get(ident, 'dashboard'),
                      description=f'시연 전용 · 실제 실행 관측 없음 · {description}',
                      ref=self.ref(catalog_path, 'FLOW_NODES', self.sources[catalog_path].count('\n', 0, label_positions[ident]) + 1))
        for relative, source in self.sources.items():
            if not relative.endswith('.js') or 'activity-flow/' in relative:
                continue
            if not any(call in source for call in ('recordFlowEvent(', 'beginFlowEvent(', 'observeFlowAction(')):
                continue
            tokens = list(_js_tokens(source))
            for index in range(len(tokens) - 3):
                call, offset = tokens[index]
                if call not in ('recordFlowEvent', 'beginFlowEvent', 'observeFlowAction') or tokens[index + 1][0] != '(':
                    continue
                ident = _js_string(tokens[index + 2][0])
                if ident is None:
                    continue
                if ident not in self.nodes:
                    raise ManifestError(f'Observation references unknown node: {ident}')
                self.node(ident, ref=self.ref(relative, call, source.count('\n', 0, offset) + 1))

    def schemas(self):
        self.schema_index = {}
        for path in ('app/api/v1/schemas.py', 'app/api/v1/routes/api.py', 'app/modules/analysis/models.py'):
            tree = self.trees[path]
            for cls in tree.body:
                if not isinstance(cls, ast.ClassDef):
                    continue
                if not any(_name(base) == 'BaseModel' or _name(base) in self.schema_index for base in cls.bases):
                    continue
                ident = f'schema:{cls.name}'
                self.schema_index[cls.name] = ident
                self.node(ident, cls.name, kind='schema', group='analysis' if '/analysis/' in path else 'report',
                          description='실제 요청·응답 모델의 필드 구조', ref=self.ref(path, cls.name, cls.lineno))
                for statement in cls.body:
                    if not isinstance(statement, ast.AnnAssign) or not isinstance(statement.target, ast.Name):
                        continue
                    name = statement.target.id
                    self.node(f'field:{cls.name}.{name}', name, kind='field', parent=ident, group=self.groups[ident],
                              description='스키마 필드 · 실제 값은 표시하지 않습니다.',
                              ref=self.ref(path, f'{cls.name}.{name}', statement.lineno))
        for path in ('app/api/v1/schemas.py', 'app/modules/analysis/models.py'):
            for cls in self.trees[path].body:
                if isinstance(cls, ast.ClassDef) and cls.name in self.schema_index:
                    for statement in cls.body:
                        if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
                            for subtype in ast.walk(statement.annotation):
                                if isinstance(subtype, ast.Name) and subtype.id in self.schema_index:
                                    self.edge(f'field:{cls.name}.{statement.target.id}', self.schema_index[subtype.id], 'contains')

    def backend(self):
        functions = {}
        imports = {}
        by_module = {}
        for path, tree in self.trees.items():
            if path == 'app/infrastructure/flow_manifest.py':
                continue
            module = path[:-3].replace('/', '.')
            by_module[module] = path
            imports[path] = {}
            for item in tree.body:
                if isinstance(item, ast.ImportFrom) and item.module and not item.level:
                    for alias in item.names:
                        imports[path][alias.asname or alias.name] = f'{item.module}.{alias.name}'
            for name, function in _functions(tree).items():
                functions[(path, name)] = function
        pending = []
        for (path, name), function in functions.items():
            for decorator in function.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                method = decorator.func.attr
                if method not in HTTP_METHODS | {'route'} or not decorator.args:
                    continue
                route = _literal(decorator.args[0])
                if not isinstance(route, str) or not route.startswith('/'):
                    raise ManifestError('Route paths must be literal for the public flow manifest')
                if path.startswith('app/api/v1/routes/'):
                    prefix = ''
                    for item in self.trees[path].body:
                        if isinstance(item, ast.Assign) and isinstance(item.value, ast.Call) and _name(item.value.func) == 'APIRouter':
                            prefix = next((_literal(kw.value, '') for kw in item.value.keywords if kw.arg == 'prefix'), '')
                    route = prefix + route
                elif path == 'frontend/guest_analysis_service.py':
                    prefix = next((_literal(kw.value, '') for item in ast.walk(self.trees[path]) if isinstance(item, ast.Call) and _name(item.func) == 'Blueprint'
                                   for kw in item.keywords if kw.arg == 'url_prefix'), '')
                    route = prefix + route
                elif path.startswith('frontend/') and not route.startswith('/api/v1/local-'):
                    # Integrated ASGI only dispatches these frontend-owned APIs.
                    continue
                methods = [method.upper()] if method != 'route' else next((_literal(kw.value, []) for kw in decorator.keywords if kw.arg == 'methods'), ['GET'])
                for verb in methods:
                    if verb.lower() not in HTTP_METHODS:
                        raise ManifestError('Unsupported route method')
                    ident = f'api:{verb}:{route}'
                    group = _group_for_path(route)
                    self.node(ident, f'{verb} {route}', kind='api', group=group,
                              description='실제 등록 경로 · 시연에서는 서버 요청을 보내지 않습니다.', ref=self.ref(path, name, decorator.lineno))
                    handler = f'source:{path}:{name}'
                    self.node(handler, function.name, kind='source', parent=ident, group=group, description='실제 경로 처리 함수', ref=self.ref(path, name, function.lineno))
                    self.edge(ident, handler, 'calls')
                    pending.append((path, name, group))
                    for keyword in decorator.keywords:
                        if keyword.arg == 'response_model':
                            model = _name(keyword.value)
                            if model not in self.schema_index:
                                raise ManifestError(f'Unknown response schema: {model}')
                            self.edge(ident, self.schema_index[model], 'produces')
        # Trace direct statically resolved local/imported functions, without
        # pretending dynamic dependency injection or provider calls are known.
        visited = set()
        while pending:
            path, name, group = pending.pop(0)
            if (path, name) in visited:
                continue
            visited.add((path, name))
            function = functions[(path, name)]
            source = f'source:{path}:{name}'
            for call in _body_calls(function):
                called = _name(call.func)
                target = None
                if isinstance(call.func, ast.Name):
                    parts = name.split('.')[:-1]
                    for size in range(len(parts), -1, -1):
                        candidate = '.'.join(parts[:size] + [called])
                        if (path, candidate) in functions:
                            target = (path, candidate)
                            break
                    if target is None and called in imports[path]:
                        full = imports[path][called]
                        module, symbol = full.rsplit('.', 1)
                        if module in by_module and (by_module[module], symbol) in functions:
                            target = (by_module[module], symbol)
                if target:
                    target_path, target_name = target
                    child = f'source:{target_path}:{target_name}'
                    self.node(child, functions[target].name, parent=source, group=group,
                              description='정적 호출로 확인된 함수', ref=self.ref(target_path, target_name, functions[target].lineno))
                    self.edge(source, child, 'calls')
                    pending.append((*target, group))
                # Database method labels/table names are structural literals;
                # values, filters and payloads are never included.
                elif called.startswith('db.') and call.args and called.split('.')[-1] in ('select', 'insert', 'upsert', 'update', 'delete', 'rpc'):
                    table = _literal(call.args[0])
                    if isinstance(table, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,80}', table):
                        child = f'storage:{called}:{table}'
                        self.node(child, f'{called.split(".")[-1]} · {table}', kind='storage', parent=source, group=group,
                                  description='실제 저장소 호출 · 내용과 개인 식별자는 공개하지 않습니다.', ref=self.ref(path, name, call.lineno))
                        self.edge(source, child, 'calls')

    def pipeline(self):
        path = 'app/application/evaluation.py'
        function = _functions(self.trees[path]).get('execute')
        if function is None:
            raise ManifestError('Evaluation entrypoint is missing')
        stages = []
        # Only direct awaited statements: no guessed order through branches,
        # callbacks, loops, comprehensions or concurrent gather calls.
        for statement in function.body:
            value = getattr(statement, 'value', None)
            if not isinstance(value, ast.Await) or not isinstance(value.value, ast.Call):
                continue
            call = value.value
            if _name(call.func) != 'measure' or not call.args:
                continue
            stage = _literal(call.args[0])
            if not isinstance(stage, str):
                raise ManifestError('Timed pipeline stages must have literal identifiers')
            ident = 'analysis' if stage == 'evaluation_graph' else stage if stage in ('parse_resume', 'parse_job') else f'stage:{stage}'
            group = 'report' if stage.startswith(('match_result', 'report_')) else 'analysis'
            self.node(ident, STAGE_LABELS.get(stage, stage), kind='stage', group=group,
                      description='실행 함수의 직접 await 단계', ref=self.ref(path, f'execute/measure:{stage}', call.lineno))
            self.nodes[ident]['kind'] = 'stage'
            stages.append(ident)
        if 'analysis' not in stages:
            raise ManifestError('Evaluation graph invocation is missing')
        self.node('pipeline:start', '분석 작업 시작', kind='boundary', group='evaluate', ref=self.ref(path, 'execute', function.lineno))
        self.node('pipeline:end', '분석 작업 완료', kind='boundary', group='report', ref=self.ref(path, 'execute', function.end_lineno))
        sequence = ['pipeline:start', *stages, 'pipeline:end']
        for source, target in zip(sequence, sequence[1:]):
            self.edge(source, target, 'flow')

    def evaluation_graph(self):
        # No API client, settings, DB or graph node is invoked here.
        from app.agent.graphs.matching import EvaluationEngine
        from app.modules.analysis.scoring.rubric import CRITERIA, DOMAIN_NAMES, DOMAIN_WEIGHTS
        graph = EvaluationEngine(None, None).build().get_graph()
        rubric_path = 'app/modules/analysis/scoring/rubric.py'
        graph_path = 'app/agent/graphs/matching.py'
        build_line = _functions(self.trees[graph_path])['EvaluationEngine.build'].lineno
        criterion_lines = {}
        for assignment in self.trees[rubric_path].body:
            if isinstance(assignment, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'CRITERIA' for target in assignment.targets):
                if isinstance(assignment.value, (ast.List, ast.Tuple)):
                    criterion_lines = {_literal(row.elts[0]): row.lineno for row in assignment.value.elts if isinstance(row, (ast.List, ast.Tuple)) and row.elts}
        domains = {}
        for domain in DOMAIN_WEIGHTS:
            codes = [row[0] for row in CRITERIA if row[1] == domain]
            if not codes or domain not in graph.nodes or f'field:MatchResult.{domain}' not in self.nodes:
                raise ManifestError(f'Rubric/graph/result schema disagree: {domain}')
            initial = codes[0][0].lower()
            if any(code[0].lower() != initial for code in codes):
                raise ManifestError(f'Domain has inconsistent criterion identifiers: {domain}')
            domains[domain] = f'domain_{initial}'
        identifiers = {}
        for raw in graph.nodes:
            ident, label = GRAPH_LABELS.get(raw, (domains.get(raw, f'graph:{raw}'), DOMAIN_NAMES.get(raw, raw)))
            identifiers[raw] = ident
            self.node(ident, label, kind='domain' if raw in domains else 'boundary' if raw in ('__start__', '__end__') else 'stage',
                      parent='analysis', group='analysis', description='실제 LangGraph 정의에서 생성한 분석 단계',
                      ref=self.ref(graph_path, 'EvaluationEngine.build', build_line))
            self.nodes[ident]['kind'] = 'domain' if raw in domains else 'boundary' if raw in ('__start__', '__end__') else 'stage'
            if raw in domains:
                self.edge(ident, f'field:MatchResult.{raw}', 'produces')
        for edge in graph.edges:
            if edge.source not in identifiers or edge.target not in identifiers:
                raise ManifestError('Evaluation graph has a dangling edge')
            self.edge(identifiers[edge.source], identifiers[edge.target], 'conditional' if edge.conditional else 'flow')
        seen = set()
        for row in CRITERIA:
            code, domain, label = row[:3]
            if code in seen or domain not in domains:
                raise ManifestError('Duplicate criterion or missing rubric domain')
            seen.add(code)
            ident = f'criterion:{code}'
            self.node(ident, f'{code} · {label}', kind='criterion', parent=domains[domain], group='analysis',
                      description='실제 평가 기준 · 시연 값은 가상의 예시입니다.', ref=self.ref(rubric_path, f'CRITERIA/{code}', criterion_lines.get(code, 1)))
            # Public rubric semantics let a hand-authored example detect drift.
            # These are executable rubric constants, never model/user results.
            self.nodes[ident]['contract'] = {
                'code': code, 'name': label, 'domain': domain,
                'weight': row[3], 'anchors': row[4],
            }
            self.edge(ident, 'schema:CriterionResult', 'produces')
            self.edge(ident, 'schema:CriterionView', 'produces')

    def finish(self):
        for edge in self.edges.values():
            if edge['from'] not in self.nodes or edge['to'] not in self.nodes:
                raise ManifestError(f'Dangling flow reference: {edge["from"]} -> {edge["to"]}')
        digest = hashlib.sha256()
        for path, text in sorted(self.sources.items()):
            digest.update(path.encode())
            digest.update(b'\0')
            digest.update(text.encode())
            digest.update(b'\0')
        overview = [{'id': ident, 'label': label, 'description': description,
                     'members': sorted(node for node, group in self.groups.items() if group == ident)}
                    for ident, label, description in GROUPS]
        return {
            'version': MANIFEST_VERSION, 'sourceDigest': digest.hexdigest(),
            'nodes': sorted(self.nodes.values(), key=lambda item: item['id']),
            'edges': sorted(self.edges.values(), key=lambda item: (item['from'], item['to'], item['kind'])),
            'overview': overview,
            'limitations': [
                '빌드·서버 시작 때 실제 경로·정적 호출·평가 그래프·평가 기준·응답 구조를 다시 읽습니다.',
                '흐름은 선언된 연결입니다. 세부 시연은 가상 예시이며 실제 분석이나 과금 요청을 실행하지 않습니다.',
                '구성 관계와 정적 호출은 실행 순서가 아닙니다. 조건 분기의 실제 선택은 입력에 따라 달라집니다.',
                '임의의 동적 라우팅·외부 서비스 내부·계산된 JS 호출 인수는 자동 추론하지 않습니다.',
                '이벤트 목록의 관측 지점은 실제 허용 목록과 직접 문자열 호출 위치를 표시합니다. 임의 JS 제어 흐름은 추론하지 않습니다.',
            ],
        }


def build_manifest(root=ROOT):
    if Path(root).resolve() != ROOT:
        raise ManifestError('Run the generator from the target checkout so its executable graph and source tree match')
    builder = Builder(root)
    builder.observations()
    builder.schemas()
    builder.backend()
    builder.pipeline()
    builder.evaluation_graph()
    return builder.finish()


def write_manifest(root=ROOT):
    root = Path(root).resolve()
    manifest = build_manifest(root)
    serialized = '// Generated from executable source. Do not edit by hand.\nexport const FLOW_MANIFEST = ' + json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + ';\n'
    target = root / OUTPUT
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or target.read_text(encoding='utf-8') != serialized:
        temporary = target.with_suffix('.js.tmp')
        temporary.write_text(serialized, encoding='utf-8', newline='\n')
        temporary.replace(target)
    return manifest
