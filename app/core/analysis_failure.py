"""Fixed failure categories only: never persist an upstream message/body."""


def analysis_failure_code(error):
    code = getattr(error, 'code', None)
    body = getattr(error, 'body', None)
    if not isinstance(code, str) and isinstance(body, dict):
        detail = body.get('error', body)
        code = detail.get('code') if isinstance(detail, dict) else None
    if code in ('insufficient_quota', 'billing_hard_limit_reached'):
        return 'provider_quota_exhausted'
    if code == 'rate_limit_exceeded' or type(error).__name__ == 'RateLimitError':
        return 'provider_rate_limited'
    if type(error).__name__ in ('AuthenticationError', 'PermissionDeniedError'):
        return 'provider_access_unavailable'
    return type(error).__name__
