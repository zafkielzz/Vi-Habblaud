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


class WorkerIds(unittest.TestCase):
    def test_a_clone_is_its_account_and_a_session_number(self):
        for worker, want in (("acc2", ("acc2", 1)), ("acc2#2", ("acc2", 2)), ("claude:.claude#13", ("claude:.claude", 13)),
                             ("claude:.claude-work", ("claude:.claude-work", 1)),
                             # not clones: session 1 is the plain id, and a number is written without zeros
                             ("acc2#1", ("acc2#1", 1)), ("acc2#0", ("acc2#0", 1)), ("acc2#02", ("acc2#02", 1)),
                             ("acc2#", ("acc2#", 1)), ("#2", ("#2", 1)), ("acc2#x", ("acc2#x", 1))):
            with self.subTest(worker=worker):
                self.assertEqual(R.split_worker(worker), want)
                self.assertEqual(R.account_of(worker), want[0])
        self.assertEqual(R.split_worker(None), (None, 1))


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
        self.assertRegex(R.rules_text({"name": "A", "folder": "/p"}, r, "boss"), r"(?s)you may also edit outside it.*B only.*At most 2 jobs.*agy-ask rules propose")


class CommandWrites(unittest.TestCase):
    """What a shell command writes (best effort: scripts and $VARS are not opened)."""

    def writes(self, cmd, cwd="/proj"):
        return R.command_writes(cmd, cwd, "/home/u")

    def test_redirects(self):
        self.assertEqual(self.writes("echo hi > /etc/x"), ["/etc/x"])
        self.assertEqual(self.writes("echo hi >> out.txt"), ["/proj/out.txt"])
        self.assertEqual(self.writes('echo "a > b"'), [])
        self.assertEqual(self.writes("ls 2>/dev/null 2>&1"), [])
        self.assertEqual(self.writes("ls 2>/etc/err"), ["/etc/err"])
        self.assertEqual(self.writes("sort < /etc/hosts"), [])

    def test_heredoc_body_is_not_the_command(self):
        self.assertEqual(self.writes("cat > /etc/f <<'E'\nrm /nope > /no\nE\necho done"), ["/etc/f"])

    def test_commands_that_write(self):
        self.assertEqual(self.writes("cp a b /opt/x"), ["/opt/x"])
        self.assertEqual(self.writes("cp -t /opt/d a b"), ["/opt/d"])
        self.assertEqual(self.writes("mv /a/f /b/g"), ["/a/f", "/b/g"])
        self.assertEqual(self.writes("rm -rf /a /b"), ["/a", "/b"])
        self.assertEqual(self.writes("sudo rm /x"), ["/x"])
        self.assertEqual(self.writes("FOO=1 rm /x"), ["/x"])
        self.assertEqual(self.writes("chmod 644 /etc/f"), ["/etc/f"])
        self.assertEqual(self.writes("ls | tee -a /etc/f"), ["/etc/f"])
        self.assertEqual(self.writes("dd if=/x of=/etc/y"), ["/etc/y"])
        self.assertEqual(self.writes("sed -i 's/a/b/' /etc/f"), ["/etc/f"])
        self.assertEqual(self.writes("sed -i -e 's/a/b/' /etc/f"), ["/etc/f"])
        self.assertEqual(self.writes("mkdir -p /opt/d && touch /opt/d/f"), ["/opt/d", "/opt/d/f"])

    def test_reading_commands_write_nothing(self):
        for cmd in ("cat /etc/hosts", "sed -n 1p /etc/f", "grep -r x /etc", "git status", "npm test"):
            self.assertEqual(self.writes(cmd), [], cmd)

    def test_where_it_runs(self):
        self.assertEqual(self.writes("cd /etc && rm hosts"), ["/etc/hosts"])
        self.assertEqual(self.writes("cd sub; rm f"), ["/proj/sub/f"])
        self.assertEqual(self.writes("rm ~/x $HOME/y"), ["/home/u/x", "/home/u/y"])

    def test_scratch_space_is_free(self):
        self.assertEqual(self.writes("echo x > /tmp/job.txt; rm -rf /var/tmp/a; echo y > /dev/stderr"), [])

    def test_gives_up_quietly(self):
        self.assertEqual(self.writes("rm $UNKNOWN/x `pwd`/y"), [])
        self.assertEqual(self.writes("echo 'unbalanced"), [])
        self.assertEqual(self.writes(""), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
