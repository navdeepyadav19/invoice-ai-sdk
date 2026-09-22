"""Helpers the generated resources use to build requests and parse responses."""

from __future__ import annotations

import datetime as _dt
import json
import types
import uuid
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional, Type, TypeVar, Union

import pydantic
from typing_extensions import get_args, get_origin

from ._retry import path_param
from ._types import NotGiven

__all__ = ["path_param", "resolve_idempotency_key", "strip_not_given", "to_jsonable", "validate_model"]

T = TypeVar("T")
_M = TypeVar("_M", bound=pydantic.BaseModel)

# `X | Y` annotations (Python 3.10+) have their own origin type.
UnionType: Any = getattr(types, "UnionType", None)

IDEMPOTENCY_HEADER = "Idempotency-Key"


def strip_not_given(values: Mapping[str, Any]) -> Dict[str, Any]:
    """Drops keyword arguments the caller didn't pass (``None`` is kept: it means null)."""
    return {k: v for k, v in values.items() if not isinstance(v, NotGiven)}


def to_jsonable(value: Any) -> Any:
    """Converts params (dicts, TypedDicts, Pydantic models, dates) to plain JSON values."""
    if isinstance(value, NotGiven):
        return None
    if isinstance(value, pydantic.BaseModel):
        return value.model_dump(mode="json", exclude_unset=True, by_alias=True)
    if isinstance(value, Mapping):
        return {str(k): to_jsonable(v) for k, v in value.items() if not isinstance(v, NotGiven)}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def dumps(value: Any) -> bytes:
    return json.dumps(to_jsonable(value), separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def uses_idempotency_key(method: str) -> bool:
    """True for methods the SDK attaches an idempotency key to."""
    return method.upper() == "POST"


def resolve_idempotency_key(method: str, user_key: Optional[str]) -> Optional[str]:
    """
    The key for one SDK call: the caller's, or a fresh UUIDv4 for POSTs.

    It is chosen ONCE per SDK call, before the first attempt, and the same key
    goes out on every automatic retry, so a retried "create invoice" replays
    the stored response instead of creating a second invoice. PATCH and DELETE
    don't take keys on this API, so they're only retried when the request
    provably never reached the server.
    """
    if user_key is not None and user_key != "":
        if len(user_key) > 255:
            raise ValueError("idempotency_key must be at most 255 characters")
        return user_key
    return str(uuid.uuid4()) if uses_idempotency_key(method) else None


def validate_model(cls: Type[T], data: Any) -> T:
    """
    Parses ``data`` into ``cls``. The SDK is lenient with what the API sends:
    if validation fails (a field the spec doesn't know yet, a new enum value,
    a partial object), the model is built field by field without validation
    instead of raising — like the TypeScript SDK, which never validates
    responses. Nested objects still become their models.
    """
    if isinstance(data, dict) and isinstance(cls, type) and issubclass(cls, pydantic.BaseModel):
        try:
            return cls.model_validate(data)
        except pydantic.ValidationError:
            return _construct_model(cls, data)
    return data  # type: ignore[no-any-return]


def _construct_model(cls: Type[_M], data: Mapping[str, Any]) -> _M:
    values: Dict[str, Any] = {}
    known = set()
    for name, field in cls.model_fields.items():
        key = field.alias or name
        known.add(key)
        if key in data:
            values[name] = _construct(field.annotation, data[key])
    extras = {k: v for k, v in data.items() if k not in known}
    return cls.model_construct(**values, **extras)


def _construct(annotation: Any, value: Any) -> Any:
    """Best-effort conversion of ``value`` to ``annotation`` without validation."""
    if value is None:
        return None
    if isinstance(annotation, type) and issubclass(annotation, pydantic.BaseModel):
        return validate_model(annotation, value) if isinstance(value, dict) else value
    origin: Any = get_origin(annotation)
    args = get_args(annotation)
    if origin is Union or (UnionType is not None and origin is UnionType):
        models = [a for a in args if isinstance(a, type) and issubclass(a, pydantic.BaseModel)]
        if isinstance(value, dict) and len(models) == 1:
            return validate_model(models[0], value)
        lists = [a for a in args if _origin_is(a, list, List)]
        if isinstance(value, list) and len(lists) == 1:
            return _construct(lists[0], value)
        return value
    if _origin_is(annotation, list, List) and isinstance(value, list) and args:
        return [_construct(args[0], v) for v in value]
    if _origin_is(annotation, dict, Dict) and isinstance(value, dict) and len(args) == 2:
        return {k: _construct(args[1], v) for k, v in value.items()}
    return value


def _origin_is(annotation: Any, *candidates: Any) -> bool:
    origin: Any = get_origin(annotation)
    return any(origin is c for c in candidates)
