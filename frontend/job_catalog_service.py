"""Frontend compatibility for the original summary-only jobs API.

Reads only existing authenticated API routes. No database credentials, backend
imports, fixture substitution, or account tokens are retained in the cache.
"""
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from copy import deepcopy
import json
from threading import Lock
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request
from uuid import UUID

from flask import jsonify, request
from werkzeug.exceptions import ServiceUnavailable, abort


class JobCatalogService:
    def __init__(self, origin, opener, verify_user, *, workers=16, ttl=300, max_entries=1000):
        self.origin = origin
        self.opener = opener
        self.verify_user = verify_user
        self.ttl = ttl
        self.max_entries = max_entries
        # Shared by every incoming catalog request in this frontend process.
        # More tabs/accounts cannot multiply upstream detail concurrency.
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="job-catalog")
        self.lock = Lock()
        self.cache = OrderedDict()
        self.pending = {}
        self.detail_pending = {}
        self.company_cache = OrderedDict()
        self.company_pending = {}

    def _read(self, path, authorization):
        try:
            with self.opener.open(Request(self.origin + "/api/v1/" + path, headers={
                "Authorization": authorization, "Accept": "application/json",
            }), timeout=15) as response:
                if response.code != 200:
                    raise ServiceUnavailable()
                return json.loads(response.read())
        except HTTPError as error:
            abort(error.code if error.code in {401, 403, 404, 429} else 503)
        except (URLError, TimeoutError, OSError, ValueError, TypeError):
            raise ServiceUnavailable() from None

    def _cached_locked(self, key, fingerprint):
        cached = self.cache.get(key)
        if not cached:
            return None
        if cached[0] <= monotonic() or cached[1] != fingerprint:
            self.cache.pop(key, None)
            return None
        self.cache.move_to_end(key)
        return deepcopy(cached[2])

    @staticmethod
    def _identifier(value):
        try:
            return str(UUID(str(value)))
        except (TypeError, ValueError):
            raise ServiceUnavailable() from None

    def _company_name(self, owner, identifier, authorization):
        if not identifier:
            return ""
        identifier = self._identifier(identifier)
        key = (owner, identifier)
        with self.lock:
            cached = self.company_cache.get(key)
            if cached and cached[0] > monotonic():
                self.company_cache.move_to_end(key)
                return cached[1]
            self.company_cache.pop(key, None)
            future = self.company_pending.get(key)
            leader = future is None
            if leader:
                future = self.company_pending[key] = Future()
        if leader:
            try:
                try:
                    company = self._read("companies/" + identifier, authorization)
                    if not isinstance(company, dict):
                        raise ServiceUnavailable()
                    name = company.get("name") if isinstance(company.get("name"), str) else ""
                except Exception as error:
                    if getattr(error, "code", None) != 404:
                        raise
                    name = ""
                with self.lock:
                    self.company_cache[key] = (monotonic() + self.ttl, name)
                    self.company_cache.move_to_end(key)
                    while len(self.company_cache) > self.max_entries:
                        self.company_cache.popitem(last=False)
                future.set_result(name)
            except Exception as error:
                future.set_exception(error)
            finally:
                with self.lock:
                    self.company_pending.pop(key, None)
        return future.result()

    def _hydrate(self, owner, record, authorization):
        raw = record
        if "description" not in raw:
            # A deletion between list and detail is an incomplete page, not a
            # shorter page that would silently truncate browser pagination.
            raw = self._read("jobs/" + self._identifier(record["id"]), authorization)
        if not isinstance(raw, dict) or raw.get("id") != record["id"]:
            raise ServiceUnavailable()
        raw = deepcopy(raw)
        if "companies" not in raw:
            raw["companies"] = {"name": self._company_name(owner, raw.get("company_id"), authorization)}
        return raw

    def _page(self, owner, query, authorization):
        records = self._read("jobs?" + query, authorization)
        if not isinstance(records, list):
            raise ServiceUnavailable()
        if not records:
            return []
        for record in records:
            if not isinstance(record, dict):
                raise ServiceUnavailable()
            self._identifier(record.get("id"))
        # An upgraded API may already include everything. Avoid redundant work.
        if all("description" in row and "companies" in row for row in records):
            return records

        # Only leaders occupy worker threads. Other pages wait in their request
        # threads, so overlapping pages cannot exhaust the pool with followers.
        acquired = []
        positions = {}
        updates = []
        mapped = [None] * len(records)
        try:
            for index, record in enumerate(records):
                key = (owner, self._identifier(record["id"]))
                fingerprint = json.dumps(record, sort_keys=True, ensure_ascii=False)
                flight_key = (*key, fingerprint)
                with self.lock:
                    cached = self._cached_locked(key, fingerprint)
                    if cached is not None:
                        mapped[index] = cached
                        continue
                    flight = self.detail_pending.get(flight_key)
                    if flight is None:
                        flight = {"future": self.pool.submit(self._hydrate, owner, record, authorization), "users": 0}
                        self.detail_pending[flight_key] = flight
                    flight["users"] += 1
                    acquired.append(flight_key)
                    positions.setdefault(flight["future"], []).append((index, key, fingerprint))
            for future in as_completed(positions):
                value = future.result()
                for index, key, fingerprint in positions[future]:
                    mapped[index] = deepcopy(value)
                    updates.append((key, fingerprint, value))
            # Commit only a complete page. A failing overlapping request must
            # neither publish partial results nor cancel another page's work.
            with self.lock:
                for key, fingerprint, value in updates:
                    self.cache[key] = (monotonic() + self.ttl, fingerprint, deepcopy(value))
                    self.cache.move_to_end(key)
                while len(self.cache) > self.max_entries:
                    self.cache.popitem(last=False)
            return mapped
        finally:
            with self.lock:
                for flight_key in acquired:
                    flight = self.detail_pending[flight_key]
                    flight["users"] -= 1
                    if not flight["users"]:
                        self.detail_pending.pop(flight_key)
                        flight["future"].cancel()

    def page(self, query, authorization):
        # Always verify the live bearer through the existing backend, even when
        # a completed page or another caller's in-flight work can be reused.
        owner = self.verify_user(authorization)
        key = (owner, query)
        with self.lock:
            future = self.pending.get(key)
            leader = future is None
            if leader:
                future = self.pending[key] = Future()
        if leader:
            try:
                future.set_result(self._page(owner, query, authorization))
            except Exception as error:
                future.set_exception(error)
            finally:
                with self.lock:
                    self.pending.pop(key, None)
        return deepcopy(future.result())


def install_job_catalog(app, origin, opener, verify_user):
    service = JobCatalogService(origin, opener, verify_user)
    app.extensions["job_catalog"] = service

    @app.get("/api/v1/local-data/jobs")
    @app.before_request
    def compatible_job_catalog():
        local_catalog = request.path == "/api/v1/local-data/jobs"
        if request.method not in {"GET", "HEAD"} or (not local_catalog and
                (request.path != "/api/v1/jobs" or request.args.get("include_details") != "true")):
            return None
        if not origin:
            raise ServiceUnavailable()
        try:
            limit = int(request.args.get("limit", "20"))
            offset = int(request.args.get("offset", "0"))
            if not 1 <= limit <= 100 or offset < 0:
                raise ValueError()
            query = {"limit": limit, "offset": offset, "include_details": "true"}
            if request.args.get("company_id"):
                query["company_id"] = str(UUID(request.args["company_id"]))
        except (ValueError, TypeError):
            abort(422)
        response = jsonify(service.page(urlencode(query), request.headers.get("Authorization", "")))
        response.headers["Cache-Control"] = "no-store"
        return response
