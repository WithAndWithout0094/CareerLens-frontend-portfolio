"""Synthetic files and owned API stubs only; no production DB/model access."""

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from flask import Flask
from werkzeug.exceptions import NotFound, Unauthorized

import execution_report_service as module


OWNER = "bf686eb8-77bd-4d90-a5a3-39ad15b7a276"
OTHER = "71372fdf-67c6-439f-88c7-c6a7c2c1467c"
RUN = "71c4b663-a0ae-45a7-9613-a85662391af7"
AUTH = {"Authorization": "Bearer synthetic-owner"}


def report(run=RUN, owner=None, extra=""):
    return (f"# 평가 실행 기록\n\n- 평가 run ID: `{run}`\n"
            + (f"- user_id: `{owner}`\n" if owner else "")
            + "- LLM 호출 수: 2\n- 계측 단계 수: 3\n\n## 단계별 소요 시간\n"
            + "| 단계 | 상태 |\n|---|---|\n| parsing | completed |\n"
            + "\n## LLM 호출 기록\n" + extra)


class ExecutionReportTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "reports"
        self.root.mkdir()
        self.path = self.root / f"{RUN}.md"
        self.path.write_text(report(), encoding="utf-8")
        self.calls = []
        self.rows = [{"id": RUN, "status": "completed", "created_at": "2026-10-13T01:00:00Z"}]
        self.detail = {"id": RUN, "status": "completed"}
        app = Flask(__name__)
        self.service = module.install_execution_reports(app, self.root, self.verify, self.read)
        self.client = app.test_client()

    def verify(self, authorization):
        self.assertEqual(authorization, AUTH["Authorization"])
        return OWNER

    def read(self, path, authorization):
        self.calls.append((path, authorization))
        self.assertEqual(authorization, AUTH["Authorization"])
        if path.startswith("evaluations?"):
            return self.rows
        if isinstance(self.detail, Exception):
            raise self.detail
        return self.detail

    def get(self, suffix=""):
        return self.client.get(module.PREFIX + suffix, headers=AUTH)

    def test_list_only_includes_account_api_candidates_and_safe_metadata(self):
        unrelated = self.root / f"{uuid4()}.md"
        unrelated.write_text("not owned, not read", encoding="utf-8")
        response = self.get()
        self.assertEqual(response.status_code, 200)
        item = response.json["reports"][0]
        self.assertEqual(item["run_id"], RUN)
        self.assertEqual(item["llm_call_count"], 2)
        self.assertEqual(item["stage_count"], 3)
        self.assertEqual(item["status"], "completed")
        self.assertEqual(item["created_at"], "2026-10-13T01:00:00+00:00")
        self.assertNotIn("markdown", item)
        self.assertNotIn(str(self.root), response.text)
        self.assertFalse(response.json["has_more"])
        self.assertIsNone(response.json["next_offset"])

    def test_list_pagination_tracks_owned_runs_even_when_no_files_match(self):
        self.path.unlink()
        response = self.get("?limit=1&offset=8")
        self.assertEqual(response.json["reports"], [])
        self.assertEqual(response.json["next_offset"], 9)
        self.assertTrue(response.json["has_more"])
        self.assertEqual(self.calls[0][0], "evaluations?limit=1&offset=8")

    def test_owned_detail_reads_report_and_never_writes_file(self):
        before = self.path.read_bytes()
        modified = self.path.stat().st_mtime_ns
        response = self.get("/" + RUN)
        self.assertEqual(response.status_code, 200)
        self.assertIn("# 평가 실행 기록", response.json["report"]["markdown"])
        self.assertEqual(self.calls[0][0], "evaluations/" + RUN)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, modified)
        self.assertIn("no-store", response.headers["Cache-Control"])

    def test_login_required_before_backend_or_file_access(self):
        with patch.object(self.service, "_read_file", side_effect=AssertionError("private file read")):
            for suffix in ("", "/" + RUN):
                response = self.client.get(module.PREFIX + suffix)
                self.assertEqual(response.status_code, 401)
        self.assertEqual(self.calls, [])

    def test_backend_ownership_failure_hides_file_and_diagnostic(self):
        self.detail = NotFound("private database diagnostic")
        with patch.object(self.service, "_read_file", side_effect=AssertionError("private file read")):
            response = self.get("/" + RUN)
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("private database", response.text)

    def test_different_run_or_owner_from_api_is_rejected(self):
        for detail in ({"id": str(uuid4())}, {"id": RUN, "user_id": OTHER}):
            with self.subTest(detail=detail):
                self.detail = detail
                self.assertEqual(self.get("/" + RUN).status_code, 404)

    def test_embedded_run_id_and_optional_owner_must_match(self):
        for text in (report(run=str(uuid4())), report(owner=OTHER), report(owner="invalid"), "no run metadata"):
            self.path.write_text(text, encoding="utf-8")
            self.assertEqual(self.get("/" + RUN).status_code, 404)
            self.assertEqual(self.get().json["reports"], [])
        self.path.write_text(report(owner=OWNER), encoding="utf-8")
        self.assertEqual(self.get("/" + RUN).status_code, 200)

    def test_credentials_are_masked_but_report_metrics_are_preserved(self):
        secret = "sk-proj-synthetic_secret_key_123456"
        body = {"api_key": "synthetic-key", "access_token": "private-token", "user_id": OWNER,
                "usage": {"input_tokens": 123, "output_tokens": 45},
                "evidence": [{"quote": f"email person@example.invalid key {secret}"}]}
        self.path.write_text(report(extra="```json\n" + json.dumps(body) + "\n```\nAuthorization: Bearer sensitive-token\n"), encoding="utf-8")
        response = self.get("/" + RUN)
        self.assertEqual(response.status_code, 200)
        output = response.json["report"]["markdown"]
        for value in ("synthetic-key", "private-token", OWNER, secret, "person@example.invalid", "sensitive-token"):
            self.assertNotIn(value, output)
        self.assertIn('"input_tokens": 123', output)
        self.assertTrue(response.json["report"]["redacted"])

    def test_broken_json_is_omitted_without_returning_its_secret(self):
        self.path.write_text(report(extra='```json\n{"api_key": "private", broken}\n```'), encoding="utf-8")
        output = self.get("/" + RUN).json["report"]["markdown"]
        self.assertNotIn("private", output)

    def test_large_or_invalid_utf8_files_fail_without_disclosing_contents(self):
        with patch.object(module, "MAX_REPORT_BYTES", 10):
            self.assertEqual(self.get("/" + RUN).status_code, 503)
        self.path.write_bytes(b"\xff")
        self.assertEqual(self.get("/" + RUN).status_code, 503)

    def test_symlink_and_hardlink_reports_are_rejected(self):
        target = self.root.parent / "outside.md"
        target.write_text(report(), encoding="utf-8")
        self.path.unlink()
        try:
            self.path.symlink_to(target)
        except OSError:
            pass
        else:
            self.assertEqual(self.get("/" + RUN).status_code, 404)
            self.path.unlink()
        os.link(target, self.path)
        self.assertEqual(self.get("/" + RUN).status_code, 404)

    def test_report_directory_symlink_is_rejected(self):
        alias = self.root.parent / "alias"
        try:
            alias.symlink_to(self.root, target_is_directory=True)
        except OSError:
            original = Path.lstat

            def reparse_point(path, *args, **kwargs):
                info = original(path, *args, **kwargs)
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400) if path == self.root else info

            with patch.object(Path, "lstat", autospec=True, side_effect=reparse_point):
                self.assertEqual(self.get("/" + RUN).status_code, 404)
        else:
            self.service.directory = alias
            self.assertEqual(self.get("/" + RUN).status_code, 404)

    def test_invalid_ranges_or_path_names_cannot_select_other_files(self):
        for suffix in ("?limit=101", "?limit=0", "?offset=-1", "?offset=invalid"):
            self.assertEqual(self.get(suffix).status_code, 422)
        for suffix in ("/../../.env", "/not-a-uuid", "/" + RUN + ".md"):
            self.assertEqual(self.get(suffix).status_code, 404)


if __name__ == "__main__":
    unittest.main()
