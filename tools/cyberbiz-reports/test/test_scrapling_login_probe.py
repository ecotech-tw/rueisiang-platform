import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import scrapling_login_probe as probe


class Locator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    @property
    def first(self):
        return self

    def is_visible(self):
        return self.selector in self.page.visible

    def evaluate_all(self, _expression):
        return self.page.has_response

    def inner_text(self):
        if self.selector == "body":
            return self.page.body
        return ""

    def all_text_contents(self):
        return self.page.store_labels


class Page:
    def __init__(self, *, visible=(), title="", body="", has_response=False, store_labels=()):
        self.visible = set(visible)
        self.title_text = title
        self.body = body
        self.has_response = has_response
        self.store_labels = list(store_labels)

    def locator(self, selector):
        return Locator(self, selector)

    def title(self):
        return self.title_text


class ScraplingLoginProbeTests(unittest.TestCase):
    def test_text_only_cloudflare_interstitial_is_detected(self):
        page = Page(title="Just a moment", body="Verifying your browser")
        self.assertEqual(probe.classify_page(page, probe.TEST_STORE_NAME), "cloudflare_challenge")

    def test_completed_turnstile_response_is_not_misclassified_as_challenge(self):
        page = Page(
            visible=(*probe.CHALLENGE_SELECTORS, *probe.LOGIN_FIELDS),
            title="CYBERBIZ",
            body="登入",
            has_response=True,
        )
        self.assertEqual(probe.classify_page(page, probe.TEST_STORE_NAME), "login_form")

    def test_two_factor_is_a_safe_terminal_probe_outcome(self):
        page = Page(visible=[probe.TWO_FACTOR_SELECTOR])
        self.assertEqual(probe.classify_page(page, probe.TEST_STORE_NAME), "two_factor_required")

    def test_store_link_is_only_reported_when_the_requested_test_store_is_visible(self):
        page = Page(visible=[probe.POS_LINK_SELECTOR], store_labels=[probe.TEST_STORE_NAME])
        self.assertEqual(probe.classify_page(page, probe.TEST_STORE_NAME), "target_store_visible")

    def test_reaching_two_factor_without_turnstile_evidence_is_not_solver_success(self):
        self.assertFalse(probe.solver_test_succeeded("two_factor_required", False))

    def test_reaching_two_factor_with_turnstile_evidence_confirms_solver_test(self):
        self.assertTrue(probe.solver_test_succeeded("two_factor_required", True))


if __name__ == "__main__":
    unittest.main()
