#!/usr/bin/env python3
"""No-write CYBERBIZ login probe using Scrapling's opt-in Cloudflare handler."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

TEST_STORE_NAME = "中和環球"
CHALLENGE_SELECTORS = (
    'iframe[src*="challenges.cloudflare.com"]',
    "#challenge-running",
    "#challenge-stage",
    ".cf-turnstile",
    'input[name="cf-turnstile-response"]',
)
CHALLENGE_COPY = re.compile(r"verifying|checking your browser|verify you are human|just a moment", re.I)
SUCCESS_COPY = re.compile(r"success\s*!", re.I)
RESPONSE_SELECTOR = 'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
LOGIN_FIELDS = ("#login-input", "#password")
TWO_FACTOR_SELECTOR = "#otp_attempt, input[autocomplete='one-time-code'], input[name*='otp']"
POS_LINK_SELECTOR = 'a[href^="/admin/pos_shops/"]'


def is_visible(page, selector: str) -> bool:
    try:
        return bool(page.locator(selector).first.is_visible())
    except Exception:
        return False


def has_completed_challenge(page) -> bool:
    try:
        if page.locator(RESPONSE_SELECTOR).evaluate_all(
            "fields => fields.some(field => typeof field.value === 'string' && field.value.trim().length > 0)"
        ):
            return True
    except Exception:
        pass

    try:
        frames = page.frames
    except Exception:
        frames = []
    for frame in frames:
        try:
            if "challenges.cloudflare.com" not in frame.url:
                continue
            if SUCCESS_COPY.search(frame.locator("body").inner_text()):
                return True
        except Exception:
            continue
    return False


def is_challenge_visible(page) -> bool:
    if has_completed_challenge(page):
        return False
    if any(is_visible(page, selector) for selector in CHALLENGE_SELECTORS):
        return True
    try:
        copy = f"{page.title()}\n{page.locator('body').inner_text()}"
    except Exception:
        return False
    return bool(CHALLENGE_COPY.search(copy))


def classify_page(page, store_name: str) -> str:
    if is_visible(page, TWO_FACTOR_SELECTOR):
        return "two_factor_required"
    if is_visible(page, POS_LINK_SELECTOR):
        try:
            labels = page.locator(POS_LINK_SELECTOR).all_text_contents()
        except Exception:
            labels = []
        return "target_store_visible" if any(label.strip() == store_name for label in labels) else "signed_in"
    if is_challenge_visible(page):
        return "cloudflare_challenge"
    if all(is_visible(page, selector) for selector in LOGIN_FIELDS):
        return "login_form"
    return "unknown"


def wait_for_login_outcome(page, store_name: str, timeout_seconds: float = 20) -> str:
    deadline = time.monotonic() + timeout_seconds
    outcome = classify_page(page, store_name)
    while outcome == "login_form" and time.monotonic() < deadline:
        page.wait_for_timeout(250)
        outcome = classify_page(page, store_name)
    return outcome


def solver_test_succeeded(outcome: str, challenge_resolution_confirmed: bool) -> bool:
    return challenge_resolution_confirmed and outcome in ("two_factor_required", "target_store_visible", "signed_in")


def run_probe() -> tuple[int, dict[str, object]]:
    store_name = os.environ.get("CYBERBIZ_LOGIN_PROBE_STORE", "")
    username = os.environ.get("CYBERBIZ_USERNAME", "")
    password = os.environ.get("CYBERBIZ_PASSWORD", "")
    if store_name != TEST_STORE_NAME:
        return 2, {"store": TEST_STORE_NAME, "outcome": "unsupported_test_store"}
    if not username or not password:
        return 2, {"store": store_name, "outcome": "missing_credentials"}

    try:
        config_path = Path(__file__).with_name("config.json")
        origin = json.loads(config_path.read_text(encoding="utf-8"))["cyberbizOrigin"]
        login_url = urljoin(origin.rstrip("/") + "/", "admin/pos_shops")
    except Exception:
        return 2, {"store": store_name, "outcome": "invalid_runner_config"}

    result: dict[str, object] = {"store": store_name, "outcome": "not_started"}

    def page_action(page) -> None:
        try:
            result["challengeResolutionConfirmed"] = has_completed_challenge(page)
            initial = classify_page(page, store_name)
            if initial in ("two_factor_required", "target_store_visible", "signed_in"):
                result["outcome"] = initial
                return
            if initial != "login_form":
                result["outcome"] = "challenge_not_cleared" if initial == "cloudflare_challenge" else initial
                return

            if page.locator(LOGIN_FIELDS[0]).count() != 1 or page.locator(LOGIN_FIELDS[1]).count() != 1:
                result["outcome"] = "unexpected_login_form"
                return
            page.locator(LOGIN_FIELDS[0]).fill(username)
            page.locator(LOGIN_FIELDS[1]).fill(password)
            page.get_by_role("button", name="登入", exact=True).click()
            result["outcome"] = wait_for_login_outcome(page, store_name)
        except Exception as error:
            # Exception text can contain page details; only retain the class name.
            result["outcome"] = "automation_error"
            result["errorType"] = type(error).__name__

    try:
        from scrapling.fetchers import StealthyFetcher

        response = StealthyFetcher.fetch(
            login_url,
            headless=True,
            solve_cloudflare=True,
            hide_canvas=True,
            block_webrtc=True,
            timeout=60_000,
            page_action=page_action,
        )
        result["httpStatus"] = int(response.status) if response.status is not None else None
    except Exception as error:
        result["outcome"] = "fetcher_error"
        result["errorType"] = type(error).__name__

    outcome = str(result.get("outcome", "unknown"))
    succeeded = solver_test_succeeded(outcome, result.get("challengeResolutionConfirmed") is True)
    return (0 if succeeded else 1), result


def main() -> int:
    exit_code, result = run_probe()
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
