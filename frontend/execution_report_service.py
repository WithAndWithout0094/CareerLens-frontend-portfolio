"""Read account-owned execution Markdown without changing backend or report files."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
from uuid import UUID

from flask import jsonify, request
from werkzeug.exceptions import HTTPException, NotFound, ServiceUnavailable, Unauthorized


MAX_REPORT_BYTES = 2 * 1024 * 1024
PREFIX = "/api/v1/local-data/execution-reports"
RUN_HEADER = re.compile(r"^\s*-\s*평가 run ID:\s*`?([0-9a-fA-F-]{36})`?\s*$", re.MULTILINE)
OWNER_HEADER = re.compile(
    r"^\s*(?:-\s*)?(?:user_id|owner_id|사용자 ID|계정 ID|소유자 ID):\s*`?([^`\s]+)`?\s*$",
    re.MULTILINE | re.IGNORECASE,
)
SECRET_KEYS = {
    "apikey", "openaiapikey", "supabasekey", "supabaseservicerolekey", "servicerolekey",
    "accesstoken", "refreshtoken", "idtoken", "token", "password", "passwordhash",
    "secret", "secretkey", "jwtsecretkey", "authorization", "cookie", "setcookie",
    "databaseurl", "supabasedburl", "connectionstring", "email", "userid", "ownerid",
}


def _uuid(value):
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        raise NotFound() from None


def _timestamp(value):
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.isoformat() if parsed.tzinfo else None
    except (TypeError, ValueError):
        return None


def _redact_text(value):
    value = re.sub(r"\b(?:sk-(?:proj-|svcacct-)?|sb_secret_)[A-Za-z0-9_-]{8,}", "[비밀키 가림]", value)
    value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [토큰 가림]", value)
    value = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[토큰 가림]", value)
    value = re.sub(r"(?i)(?:postgres(?:ql)?|https?)://[^\s/@:]+:[^\s/@]+@[^\s`\"']+", "[접속 정보 가림]", value)
    value = re.sub(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[이메일 가림]", value)
    value = re.sub(
        r"(?im)^([^\n]*(?:OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|JWT_SECRET_KEY|DATABASE_URL|PASSWORD|AUTHORIZATION|COOKIE|SECRET_KEY|SERVICE_ROLE_KEY)\s*[:=]\s*).+$",
        r"\1[비밀정보 가림]", value,
    )
    return value


def _redact_json(value):
    if isinstance(value, dict):
        return {key: "[비밀정보 가림]" if re.sub(r"[_\s-]", "", key).lower() in SECRET_KEYS
                else _redact_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    return _redact_text(value) if isinstance(value, str) else value


def safe_markdown(markdown):
    def json_block(match):
        try:
            value = json.loads(match.group(1))
            return "```json\n" + json.dumps(_redact_json(value), ensure_ascii=False, indent=2) + "\n```"
        except (ValueError, TypeError, RecursionError):
            return "[구조를 확인할 수 없는 JSON 응답은 표시하지 않습니다.]"

    rendered = re.sub(r"```json\s*\n(.*?)\n```", json_block, markdown, flags=re.DOTALL | re.IGNORECASE)
    return _redact_text(OWNER_HEADER.sub("- 계정 식별자: [가림]", rendered))


def _not_link(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise NotFound()
    return info


class ExecutionReportService:
    def __init__(self, directory, verify_user, read_backend):
        self.directory = Path(os.path.abspath(directory))
        self.verify_user = verify_user
        self.read_backend = read_backend

    def owner(self, authorization):
        if not isinstance(authorization, str) or not authorization.startswith("Bearer ") or not authorization[7:].strip():
            raise Unauthorized()
        return _uuid(self.verify_user(authorization))

    def _read_file(self, run_id, owner):
        # Only a canonical UUID filename is accepted; no client-supplied path.
        path = self.directory / f"{_uuid(run_id)}.md"
        try:
            for ancestor in (self.directory, *self.directory.parents):
                if not stat.S_ISDIR(_not_link(ancestor).st_mode):
                    raise NotFound()
            before = _not_link(path)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise NotFound()
            if before.st_size > MAX_REPORT_BYTES:
                raise ServiceUnavailable()
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
            with os.fdopen(descriptor, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                    raise NotFound()
                data = stream.read(MAX_REPORT_BYTES + 1)
                after = os.fstat(stream.fileno())
            if len(data) > MAX_REPORT_BYTES or (opened.st_size, opened.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ServiceUnavailable()
            for ancestor in (path, self.directory, *self.directory.parents):
                _not_link(ancestor)
            if path.resolve().parent != self.directory.resolve():
                raise NotFound()
            markdown = data.decode("utf-8-sig")
        except FileNotFoundError:
            raise NotFound() from None
        except (OSError, UnicodeError):
            raise ServiceUnavailable() from None
        if RUN_HEADER.findall(markdown) != [run_id]:
            raise NotFound()
        if any(_uuid(value) != owner for value in OWNER_HEADER.findall(markdown)):
            raise NotFound()
        counts = {}
        for field, label in (("llm_call_count", "LLM 호출 수"), ("stage_count", "계측 단계 수")):
            match = re.search(r"(?m)^- " + label + r": (\d{1,7})\s*$", markdown)
            counts[field] = int(match.group(1)) if match else None
        return {
            "run_id": run_id, "filename": path.name,
            "modified_at": datetime.fromtimestamp(after.st_mtime, timezone.utc).isoformat(),
            "size_bytes": len(data), **counts,
        }, markdown

    def list_reports(self, authorization, *, limit=100, offset=0):
        owner = self.owner(authorization)
        rows = self.read_backend(f"evaluations?limit={limit}&offset={offset}", authorization)
        if not isinstance(rows, list) or len(rows) > limit:
            raise ServiceUnavailable()
        reports = []
        for row in rows:
            if not isinstance(row, dict):
                raise ServiceUnavailable()
            run_id = _uuid(row.get("id"))
            if row.get("user_id") is not None and _uuid(row["user_id"]) != owner:
                raise NotFound()
            try:
                metadata, _ = self._read_file(run_id, owner)
            except NotFound:
                continue
            if row.get("status") in {"queued", "running", "completed", "partial", "failed", "cancelled"}:
                metadata["status"] = row["status"]
            created_at = _timestamp(row.get("created_at"))
            if created_at:
                metadata["created_at"] = created_at
            reports.append(metadata)
        has_more = len(rows) == limit
        return {"reports": reports, "has_more": has_more,
                "next_offset": offset + len(rows) if has_more else None,
                "scope": {"mode": "account"}}

    def report(self, authorization, run_id):
        owner = self.owner(authorization)
        run_id = _uuid(run_id)
        run = self.read_backend(f"evaluations/{run_id}", authorization)
        if not isinstance(run, dict) or _uuid(run.get("id")) != run_id:
            raise NotFound()
        if run.get("user_id") is not None and _uuid(run["user_id"]) != owner:
            raise NotFound()
        metadata, markdown = self._read_file(run_id, owner)
        rendered = safe_markdown(markdown)
        return {"report": {**metadata, "markdown": rendered, "redacted": rendered != markdown}}


def install_execution_reports(app, directory, verify_user, read_backend):
    """Callbacks must verify /me and forward GETs with the supplied bearer token."""
    service = ExecutionReportService(directory, verify_user, read_backend)
    app.extensions["execution_reports"] = service

    def respond(operation):
        try:
            response = jsonify(operation())
        except HTTPException as error:
            status = error.code if error.code in {401, 403, 404, 422, 429} else 503
            messages = {401: "로그인 후 실행 보고서를 확인하세요.", 403: "실행 보고서를 읽을 권한이 없습니다.",
                        404: "실행 보고서를 찾을 수 없습니다.", 422: "조회 범위를 확인하세요.",
                        429: "잠시 후 다시 시도하세요.", 503: "실행 보고서를 읽을 수 없습니다. 연결과 저장 상태를 확인하세요."}
            response = jsonify(error={"code": f"execution_report_{status}", "message": messages[status]})
            response.status_code = status
        except Exception:
            response = jsonify(error={"code": "execution_report_unavailable", "message": "실행 보고서를 읽을 수 없습니다. 연결과 저장 상태를 확인하세요."})
            response.status_code = 503
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get(PREFIX)
    def execution_report_list():
        def read():
            try:
                limit, offset = int(request.args.get("limit", "100")), int(request.args.get("offset", "0"))
                if not 1 <= limit <= 100 or not 0 <= offset <= 100000:
                    raise ValueError()
            except ValueError:
                from werkzeug.exceptions import UnprocessableEntity
                raise UnprocessableEntity() from None
            return service.list_reports(request.headers.get("Authorization", ""), limit=limit, offset=offset)
        return respond(read)

    @app.get(PREFIX + "/<uuid:run_id>")
    def execution_report_detail(run_id):
        return respond(lambda: service.report(request.headers.get("Authorization", ""), str(run_id)))

    return service
