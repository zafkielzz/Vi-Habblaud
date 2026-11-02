#!/usr/bin/env python3
"""bin/office_rules.py against the cases Habblaud's TypeScript runs too.

The cases are shared/rules.vectors.json, the same file the TypeScript tests read. The parse and text cases mirror shared/rules.test.ts. Run: python3 tests/test_office_rules.py"""
import json, os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))
import office_rules as R  # noqa: E402

with open(os.path.join(HERE, "..", "..", "..", "shared", "rules.vectors.json")) as f:
    V = json.load(f)
RULES = R.parse_rules({"scope": V["scope"]})


class Vectors(unittest.TestCase):
    def test_paths(self):
        for c in V["paths"]:
            with self.subTest(path=c["path"], mode=c["mode"]):
                r = R.check_path(RULES, V["folder"], V["home"], c["path"], c["mode"], c.get("cwd"))
                self.assertEqual(r["ok"], c["ok"])
                if not c["ok"]:
                    self.assertEqual(r["kind"], c["kind"])

    def test_commands(self):
        for c in V["commands"]:
            with self.subTest(cmd=c["cmd"]):
                self.assertEqual(R.check_command(RULES, c["cmd"]), c["hit"])


class Parse(unittest.TestCase):
    def test_absent_defaults_junk_caps_ids(self):
        self.assertEqual(R.parse_rules(None), R.default_rules())
        r = R.parse_rules({
            "scope": {"write": ["relative/x", "/abs", "/abs"], "deny": [], "commands": [" git   push "]},
            "items": [{"id": "a", "text": "  Be  short ", "for": "boss"}, {"id": "a", "text": "Two"}, {"text": ""},
                      {"text": "x" * 500, "for": "nobody", "on": False}],
            "limits": {"maxJobs": 0, "quotaStop": 80},
            "rev": 3,
        })
        self.assertEqual(r["scope"], {"write": ["/abs"], "deny": [], "commands": ["git push"]})
        self.assertEqual([[i["id"], len(i["text"]), i["for"], i["on"]] for i in r["items"]],
                         [["a", 8, "boss", True], ["r2", 3, "all", True], ["r4", R.RULES_MAX["text"], "all", False]])
        self.assertEqual(r["limits"], {"quotaStop": 80})
        self.assertEqual(r["rev"], 3)

    def test_folderless_office_only_deny(self):
        self.assertTrue(R.check_path(RULES, "", "/home/u", "/etc/x", "write")["ok"])
        self.assertEqual(R.check_path(RULES, "", "/home/u", "/home/u/.ssh/x", "write")["kind"], "deny")

    def test_text_for_each_side(self):
        r = R.parse_rules({**R.default_rules(), "items": [{"text": "W only", "for": "workers"}, {"text": "B only", "for": "boss"},
                                                          {"text": "Off", "on": False}], "limits": {"maxJobs": 2}})
        w = R.rules_text({"name": "A", "folder": "/p"}, r, "workers")
        self.assertIn("Edit files only inside: /p.", w)
        self.assertIn("W only", w)
        self.assertNotRegex(w, r"B only|- Off|propose|At most")
        self.assertRegex(R.rules_text({"name": "A", "folder": "/p"}, r, "boss"), r"(?s)B only.*At most 2 jobs.*agy-ask rules propose")


if __name__ == "__main__":
    unittest.main(verbosity=1)
