"""The base class of every generated model."""

from __future__ import annotations

from typing import Any, Dict

import pydantic


class BaseModel(pydantic.BaseModel):
    """
    A Pydantic v2 model of an API object. Unknown fields the API adds later are
    kept (``extra="allow"``), so an older SDK never drops data.
    """

    model_config = pydantic.ConfigDict(extra="allow", populate_by_name=True, protected_namespaces=())

    def to_dict(self) -> Dict[str, Any]:
        """The object as plain JSON-compatible data, exactly the fields the API sent."""
        return self.model_dump(mode="json", exclude_unset=True, by_alias=True)

    def to_json(self, *, indent: int = 2) -> str:
        """The object as a JSON string."""
        return self.model_dump_json(exclude_unset=True, by_alias=True, indent=indent)
