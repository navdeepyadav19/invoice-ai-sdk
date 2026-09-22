"""Webhook verification. Uses the SAME vectors as packages/sdk-ts/test/webhooks.test.ts."""

from __future__ import annotations

import base64
import json
from typing import Any, ClassVar, Dict, Optional

import httpx
import pytest

from invoice_ai import (
    InvoiceAI,
    Webhook,
    WebhookEvent,
    Webhooks,
    WebhookVerificationError,
    construct_event,
    sign_payload,
    verify_signature,
)

# The reference vector published with the Standard Webhooks libraries.
# https://github.com/standard-webhooks/standard-webhooks (test vectors)
VECTOR = {
    "secret": "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    "id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
    "timestamp": 1614265330,
    "payload": '{"test": 2432232314}',
    "signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
}
SECRET = str(VECTOR["secret"])
PAYLOAD = str(VECTOR["payload"])
TS = int(VECTOR["timestamp"])  # type: ignore[call-overload]


def headers(overrides: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    return {
        "webhook-id": str(VECTOR["id"]),
        "webhook-timestamp": str(TS),
        "webhook-signature": str(VECTOR["signature"]),
        **(overrides or {}),
    }


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


class TestReferenceVector:
    def test_accepts_the_valid_vector(self) -> None:
        assert verify_signature(PAYLOAD, headers(), SECRET, now=TS) is None

    def test_accepts_httpx_headers_mixed_case_dicts_pair_lists_and_bytes(self) -> None:
        verify_signature(PAYLOAD, httpx.Headers(headers()), SECRET, now=TS)
        verify_signature(
            PAYLOAD.encode(),
            {"Webhook-Id": VECTOR["id"], "Webhook-Timestamp": str(TS), "Webhook-Signature": VECTOR["signature"]},
            SECRET,
            now=TS,
        )
        verify_signature(bytearray(PAYLOAD.encode()), list(headers().items()), SECRET, now=TS)

    def test_rejects_a_tampered_body(self) -> None:
        with pytest.raises(WebhookVerificationError):
            verify_signature('{"test": 2432232315}', headers(), SECRET, now=TS)

    def test_rejects_a_tampered_id_or_signature(self) -> None:
        with pytest.raises(WebhookVerificationError):
            verify_signature(PAYLOAD, headers({"webhook-id": "msg_other"}), SECRET, now=TS)
        with pytest.raises(WebhookVerificationError):
            verify_signature(
                PAYLOAD,
                headers({"webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE"}),
                SECRET,
                now=TS,
            )

    def test_rejects_the_wrong_secret(self) -> None:
        with pytest.raises(WebhookVerificationError):
            verify_signature(PAYLOAD, headers(), "whsec_" + b64("another secret"), now=TS)

    def test_rejects_an_expired_timestamp_and_one_too_far_in_the_future(self) -> None:
        verify_signature(PAYLOAD, headers(), SECRET, now=TS + 300)
        with pytest.raises(WebhookVerificationError, match="too old"):
            verify_signature(PAYLOAD, headers(), SECRET, now=TS + 301)
        with pytest.raises(WebhookVerificationError, match="future"):
            verify_signature(PAYLOAD, headers(), SECRET, now=TS - 301)
        verify_signature(PAYLOAD, headers(), SECRET, now=TS + 1000, tolerance=1000)

    def test_accepts_any_one_valid_signature_among_several(self) -> None:
        rotated = f"v1,bm90IHRoZSByaWdodCBzaWduYXR1cmUgYXQgYWxsIQ== v2,ignored {VECTOR['signature']}"
        verify_signature(PAYLOAD, headers({"webhook-signature": rotated}), SECRET, now=TS)
        with pytest.raises(WebhookVerificationError):
            verify_signature(PAYLOAD, headers({"webhook-signature": "v1,bm90IHJpZ2h0 v2,xyz"}), SECRET, now=TS)

    def test_rejects_missing_headers_and_non_numeric_timestamps(self) -> None:
        no_sig = headers()
        del no_sig["webhook-signature"]
        with pytest.raises(WebhookVerificationError):
            verify_signature(PAYLOAD, no_sig, SECRET, now=TS)
        with pytest.raises(WebhookVerificationError):
            verify_signature(PAYLOAD, headers({"webhook-timestamp": "16142e5"}), SECRET, now=TS)

    def test_rejects_a_parsed_object_instead_of_the_raw_body(self) -> None:
        with pytest.raises(WebhookVerificationError, match="raw body"):
            verify_signature(json.loads(PAYLOAD), headers(), SECRET, now=TS)


class TestSecretEncodings:
    # These key bytes encode with '+' and '/' in standard base64, '-' and '_' in base64url.
    KEY = bytes([251, 255, 191, 62, 63, 250, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252])
    B64 = base64.b64encode(KEY).decode()
    B64URL = B64.replace("+", "-").replace("/", "_").rstrip("=")

    def test_the_fixture_really_differs_between_the_alphabets(self) -> None:
        assert any(ch in self.B64 for ch in "+/")
        assert any(ch in self.B64URL for ch in "-_")

    def test_base64_and_base64url_forms_of_one_secret_are_interchangeable(self) -> None:
        payload = '{"id":"evt_1","type":"invoice.paid"}'
        signed = sign_payload(payload, f"whsec_{self.B64}", msg_id="msg_1", timestamp=1_789_371_234)
        verify_signature(payload, signed, f"whsec_{self.B64URL}", now=1_789_371_234)
        verify_signature(payload, signed, f"whsec_{self.B64}", now=1_789_371_234)
        verify_signature(payload, signed, self.B64, now=1_789_371_234)  # prefix optional

    def test_rejects_a_secret_that_is_not_base64(self) -> None:
        with pytest.raises(WebhookVerificationError, match="not valid base64"):
            verify_signature(PAYLOAD, headers(), "whsec_***not base64***", now=TS)


class TestConstructEvent:
    SECRET = "whsec_" + b64("0123456789abcdef0123456789abcdef")
    EVENT: ClassVar[Dict[str, Any]] = {
        "id": "evt_0d6c3e9a",
        "type": "invoice.paid",
        "created_at": "2026-09-22T09:12:44.123Z",
        "data": {"object": {"id": "in_1", "object": "invoice", "status": "paid", "total": 29500, "currency": "USD"}},
    }

    def test_returns_the_typed_event_after_verifying(self) -> None:
        body = json.dumps(self.EVENT)
        event = construct_event(body, sign_payload(body, self.SECRET), self.SECRET)
        assert isinstance(event, WebhookEvent)
        assert event.type == "invoice.paid"
        assert event.data.object.id == "in_1"

    def test_is_available_on_the_client_and_standalone(self) -> None:
        body = json.dumps(self.EVENT)
        h = sign_payload(body, self.SECRET)
        c = InvoiceAI(api_key="inv_live_ab12cd34_x")
        assert c.webhooks.construct_event(body, h, self.SECRET).id == "evt_0d6c3e9a"
        assert Webhooks(self.SECRET).construct_event(body, h).type == "invoice.paid"
        assert Webhook(self.SECRET).verify(body.encode(), h).id == "evt_0d6c3e9a"
        with pytest.raises(WebhookVerificationError):
            Webhooks().construct_event(body, h)

    def test_webhook_signs_what_it_verifies(self) -> None:
        wh = Webhook(self.SECRET)
        body = json.dumps(self.EVENT)
        signed = wh.sign(body, msg_id="msg_x", timestamp=1_789_371_234)
        assert signed["webhook-id"] == "msg_x"
        assert wh.verify(body, signed, now=1_789_371_234).id == "evt_0d6c3e9a"

    def test_webhook_rejects_a_malformed_secret_up_front(self) -> None:
        with pytest.raises(WebhookVerificationError):
            Webhook("whsec_***")

    def test_rejects_a_validly_signed_body_that_is_not_json(self) -> None:
        h = sign_payload("not json", self.SECRET)
        with pytest.raises(WebhookVerificationError, match="not valid JSON"):
            construct_event("not json", h, self.SECRET)
