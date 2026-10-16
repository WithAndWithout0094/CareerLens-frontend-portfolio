from types import SimpleNamespace

import pytest

from app.core.analysis_failure import analysis_failure_code


@pytest.mark.parametrize(('code', 'expected'), [
    ('insufficient_quota', 'provider_quota_exhausted'),
    ('billing_hard_limit_reached', 'provider_quota_exhausted'),
    ('rate_limit_exceeded', 'provider_rate_limited'),
    ('private-upstream-string', 'SimpleNamespace'),
])
def test_provider_failure_uses_only_fixed_codes(code, expected):
    error = SimpleNamespace(code=code, body={'message': 'private document/key'})
    assert analysis_failure_code(error) == expected
    nested = SimpleNamespace(body={'error': {'code': code, 'message': 'private document/key'}})
    assert analysis_failure_code(nested) == expected


def test_old_rate_limit_type_does_not_claim_the_account_has_no_credit():
    error = type('RateLimitError', (Exception,), {})('private response')
    assert analysis_failure_code(error) == 'provider_rate_limited'
    assert analysis_failure_code(TimeoutError('private response')) == 'TimeoutError'
