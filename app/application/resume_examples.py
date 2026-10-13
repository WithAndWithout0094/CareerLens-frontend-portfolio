"""Catalog of the project's explicitly fictional resume fixtures."""
from functools import lru_cache
from pathlib import Path
import re

DIRECTORY = Path(__file__).resolve().parents[1] / 'modules' / 'resumes' / '이력서_50개' / '가상_이력서_50개'


@lru_cache(maxsize=1)
def _examples():
    result = {}
    for path in sorted(DIRECTORY.glob('CV-*.md')):
        content = path.read_text(encoding='utf-8-sig')
        fields = dict(re.findall(r'^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$', content, re.MULTILINE))
        ident = path.name.split('_', 1)[0]
        skills = re.search(r'사용 기술:\s*(.+)', content)
        result[ident] = {
            'id': ident, 'title': f"{ident} · {fields.get('지원 직무', '프로젝트 가상 이력서')}",
            'role': fields.get('지원 직무', ''), 'experience_level': fields.get('지원 구분', ''),
            'summary': '프로젝트에 포함된 가상 인물·경력 자료입니다. 실제 지원자의 이력서가 아닙니다.',
            'skills': [item.strip() for item in skills.group(1).split(',')][:8] if skills else [],
            'content': content, 'source': 'project_synthetic_resume',
        }
    return result


def catalog():
    return [{key: value for key, value in item.items() if key != 'content'} for item in _examples().values()]


def example(ident):
    return _examples().get(ident)
