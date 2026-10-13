"""Build a private metadata-only JSON upload from a local execution report directory."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import UUID

from app.application.execution_reports import summarize_markdown


def prepare(directory):
    result = []
    for path in sorted(Path(directory).glob('*.md')):
        if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('Unsafe or oversized execution report')
        run_id = str(UUID(path.stem))
        result.append({'run_id': run_id, 'modified_at': datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
                       'summary': summarize_markdown(path.read_text(encoding='utf-8-sig'), run_id)})
    return {'reports': result}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    payload = prepare(args.directory)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Prepared {len(payload['reports'])} private operational summaries (no document/model-response text).")
