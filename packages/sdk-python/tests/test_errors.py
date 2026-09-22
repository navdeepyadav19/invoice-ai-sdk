"""Error mapping. Mirrors packages/sdk-ts/test/errors.test.ts."""

from __future__ import annotations

from typing import Type

import httpx
import pytest
import respx
from helpers import FakeServer, client, problem

import invoice_ai
from invoice_ai import (
    ERROR_CLASS_BY_CODE,
    APIError,
    AuthenticationError,
    ConflictError,
    IdempotencyError,
    IdempotencyKeyRequiredError,
    InternalServerError,
    InvalidStateError,
    InvoiceAIError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    UpstreamError,
    ValidationError,
)
from invoice_ai.errors import make_api_error

CASES = [
    (401, "unauthorized", AuthenticationError),
    (403, "forbidden", PermissionDeniedError),
    (404, "not_found", NotFoundError),
    (409, "invalid_state", InvalidStateError),
    (409, "conflict", ConflictError),
    (422, "validation", ValidationError),
    (422, "idempotency_mismatch", IdempotencyError),
    (428, "idempotency_key_required", IdempotencyKeyRequiredError),
    (429, "rate_limited", RateLimitError),
    (500, "internal_error", InternalServerError),
    (502, "upstream_failed", UpstreamError),
]


@pytest.mark.parametrize(("status", "code", "cls"), CASES, ids=[c[1] for c in CASES])
def test_error_mapping(router: respx.MockRouter, status: int, code: str, cls: Type[APIError]) -> None:
    FakeServer(router, problem(status, code, headers={"retry-after": "1"}))
    with pytest.raises(cls) as info:
        client(max_retries=0).customers.retrieve("cus_1")
    e = info.value
    assert isinstance(e, APIError)
    assert isinstance(e, InvoiceAIError)
    assert e.status == status
    assert e.code == code
    assert e.detail == f"detail for {code}"
    assert e.request_id == "req_err42"
    assert "/problems/" in (e.type or "")
    assert str(e) == f"{status} {code}: detail for {code} (request req_err42)"
    assert type(e).__name__ == cls.__name__


def test_covers_every_documented_code() -> None:
    assert sorted(ERROR_CLASS_BY_CODE) == sorted(code for _, code, _ in CASES)


def test_idempotency_mismatch_is_its_own_class() -> None:
    err = make_api_error(status=422, headers=httpx.Headers(), body={"code": "idempotency_mismatch"})
    assert isinstance(err, IdempotencyError)
    assert not isinstance(err, ValidationError)


def test_keeps_field_errors_on_validation_error_and_lists_them_in_the_message() -> None:
    err = make_api_error(
        status=422,
        headers=httpx.Headers({"x-request-id": "req_v"}),
        body={
            "code": "validation",
            "detail": "Some fields need attention.",
            "errors": [
                {"path": "customer", "message": "Required"},
                {"path": "items.0.unit_amount", "message": "Use whole minor units"},
            ],
        },
    )
    assert isinstance(err, ValidationError)
    assert len(err.fields) == 2
    assert str(err) == (
        "422 validation: Some fields need attention. "
        "[customer: Required; items.0.unit_amount: Use whole minor units] (request req_v)"
    )


def test_falls_back_to_the_problem_instance_when_x_request_id_is_missing() -> None:
    err = make_api_error(status=404, headers=httpx.Headers(), body={"code": "not_found", "instance": "req_inst"})
    assert err.request_id == "req_inst"
    assert "(request req_inst)" in str(err)


def test_maps_by_status_when_the_body_has_no_code() -> None:
    h = httpx.Headers()
    assert isinstance(make_api_error(status=503, headers=h, body="<html>"), UpstreamError)
    assert isinstance(make_api_error(status=500, headers=h, body=None), InternalServerError)
    assert isinstance(make_api_error(status=401, headers=h, body=None), AuthenticationError)
    assert type(make_api_error(status=418, headers=h, body=None)) is APIError


def test_permission_error_names_the_missing_scope(router: respx.MockRouter) -> None:
    from_detail = make_api_error(
        status=403,
        headers=httpx.Headers(),
        body={"code": "forbidden", "detail": "This credential is missing the invoices:write scope."},
    )
    assert isinstance(from_detail, PermissionDeniedError)
    assert from_detail.required_scope == "invoices:write"

    FakeServer(router, problem(403, "forbidden", {"detail": "Insufficient scope"}))
    with pytest.raises(PermissionDeniedError) as info:
        client().invoices.finalize("in_1")
    assert info.value.required_scope == "invoices:finalize"  # from the spec's x-required-scope


def test_permission_error_alias_matches_the_ts_name() -> None:
    assert invoice_ai.PermissionError is PermissionDeniedError
    assert invoice_ai.errors.PermissionError is PermissionDeniedError


def test_rate_limit_error_exposes_retry_after() -> None:
    err = make_api_error(status=429, headers=httpx.Headers({"retry-after": "42"}), body={"code": "rate_limited"})
    assert isinstance(err, RateLimitError)
    assert err.retry_after == 42
