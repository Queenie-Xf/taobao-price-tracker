"""Pure-Python regression checks for report price selection (no network needed)."""
import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'build_report.py'
spec = importlib.util.spec_from_file_location('build_report', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class PriceParsingTests(unittest.TestCase):
    def test_discount_and_original(self):
        r = {'page': {'raw': ['平台加补后￥358', '优惠前￥539']}}
        self.assertEqual(mod.pick_after(r), 358.0)
        self.assertEqual(mod.pick_before(r), 539.0)

    def test_invalid_low_candidate_falls_back(self):
        r = {'page': {'raw': ['优惠后￥6'], 'daoshou': ['369']}}
        self.assertEqual(mod.pick_after(r), 369.0)

    def test_no_price_is_missing(self):
        self.assertIsNone(mod.pick_after({'page': {'origin': ['539']}}))

    def test_prepay_price_as_before(self):
        self.assertEqual(mod.pick_before({'page': {'raw': ['预售价￥420']}}), 420.0)


if __name__ == '__main__':
    unittest.main()
