"""office-boss (/boss, /offices): which office a session becomes the boss of, and an office living as long as its
boss's session (closed when it ends, back when it is resumed)."""
import json, os, shlex, shutil, subprocess, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BOSS = os.path.join(HERE, "..", "bin", "office-boss")


class OfficeBoss(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="office-boss-test-")
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = os.path.join(self.tmp, "profiles")
        for acc, mail in (("acc1", "a@x.io"), ("acc2", "b@x.io")):
            state = os.path.join(self.root, acc, ".gemini", "antigravity-cli")
            os.makedirs(state)
            with open(os.path.join(state, "cli.log"), "w") as f:
                f.write(f"server_oauth OAuth: signed in as {mail}\n")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        with open(os.path.join(self.bin, "claude"), "w") as f:  # a session ($SID): runs the command below itself
            f.write('#!/bin/sh\nmkdir -p "$HOME/.claude/sessions"\n'
                    'echo "{\\"sessionId\\": \\"$SID\\"}" > "$HOME/.claude/sessions/$$.json"\n"$@"\n')
        os.chmod(os.path.join(self.bin, "claude"), 0o755)
        self.home = os.path.join(self.tmp, "home")
        self.app = os.path.join(self.home, "w", "app")
        os.makedirs(os.path.join(self.app, "src"))

    def boss(self, *args, cwd=None, sid="s0"):
        return self.session([args], cwd=cwd, sid=sid)

    def session(self, calls, cwd=None, sid="s0"):
        """Runs office-boss once per argument list, all from one session (one `claude` above them) with session id
        `sid`; the session ends when it returns."""
        line = "; ".join(" ".join([shlex.quote(BOSS), *map(shlex.quote, a)]) for a in calls)
        r = subprocess.run([os.path.join(self.bin, "claude"), "sh", "-c", line], cwd=cwd or self.app, capture_output=True, text=True,
                           env=dict(os.environ, HABBLAUD_AGY_PROFILES=self.root, HOME=self.home, SID=sid), timeout=10)
        return r.returncode, r.stdout + r.stderr

    def ended(self):
        with open(os.path.join(self.root, "offices-ended.json")) as f:
            return json.load(f)["ended"]

    def team(self):
        with open(os.path.join(self.root, "team.json")) as f:
            return json.load(f)["offices"]

    def write(self, offices):
        with open(os.path.join(self.root, "team.json"), "w") as f:
            json.dump({"offices": offices}, f)

    def test_a_new_office_for_the_folder_with_every_signed_in_worker(self):
        code, out = self.session([[], ["list"]], sid="s1")
        self.assertEqual(code, 0, out)
        self.assertIn('boss of the office "app"', out)
        self.assertIn("agy-ask <acc>", out)
        self.assertIn("<- this session", out)
        [o] = self.team()
        self.assertEqual((o["id"], o["folder"], o["workers"]), ("app", os.path.realpath(self.app), ["acc1", "acc2"]))
        self.assertEqual((o["boss"]["kind"], o["boss"]["sessionId"]), ("claude", "s1"))
        self.assertIsInstance(o["boss"]["procStart"], int)
        # again from a subfolder, same session: the same office, still one
        self.assertEqual(self.session([[], []], cwd=os.path.join(self.app, "src"))[0], 0)

    def test_the_office_closes_with_its_session_and_a_resume_brings_it_back(self):
        self.assertEqual(self.session([["--workers", "acc2"]], sid="s1")[0], 0)
        # another session looks: the boss's session has ended, so its office closed and waits for a resume
        code, out = self.boss("offices", sid="s2")
        self.assertIn('office "app" ended with its boss session', out)
        self.assertIn("No offices open.", out)
        self.assertIn("session s1", out)
        self.assertEqual(self.team(), [])
        self.assertEqual([e["sessionId"] for e in self.ended()], ["s1"])
        # `claude --resume s1`: a new process with the same session id gets the office back as it was
        code, out = self.boss("list", sid="s1")
        self.assertIn('office "app" is back', out)
        [o] = self.team()
        self.assertEqual((o["id"], o["workers"], o["boss"]["sessionId"]), ("app", ["acc2"], "s1"))
        self.assertEqual(self.ended(), [])

    def test_the_deepest_office_holding_the_folder_and_one_office_per_session(self):
        w = os.path.realpath(os.path.join(self.home, "w"))
        self.write([{"id": "ws", "name": "Workspace", "folder": w, "workers": ["acc1"], "boss": None},
                    {"id": "game", "name": "Game", "folder": os.path.realpath(self.app), "workers": ["acc2"], "boss": None}])
        code, out = self.session([[], ["workspace"]], cwd=os.path.join(self.app, "src"))
        self.assertEqual(code, 0, out)
        self.assertIn('boss of the office "Game"', out)
        self.assertIn('previous office "Game" (game) closed', out)
        [ws] = self.team()
        self.assertEqual((ws["id"], ws["workers"]), ("ws", ["acc1", "acc2"]))  # every signed-in worker, each time
        self.assertEqual(self.boss("nope")[0], 1)

    def test_home_is_the_cli_office_and_off_closes_it(self):
        code, out = self.session([[], ["off"]], cwd=self.home)
        self.assertEqual(code, 0, out)
        self.assertIn('boss of the office "Terminal"', out)
        self.assertIn('closed: "Terminal"', out)
        self.assertEqual(self.team(), [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "offices-ended.json")))  # off is not kept for a resume

    def test_rm_closes_an_office_or_forgets_an_ended_one(self):
        self.write([{"id": "ws", "name": "Workspace", "folder": "", "workers": [], "boss": None}])
        code, out = self.boss("offices", "rm", "Workspace")
        self.assertEqual((code, self.team()), (0, []), out)
        self.session([[]], sid="s1-long-id")
        self.boss("list", sid="s2")
        code, out = self.boss("rm", "s1-long-")
        self.assertEqual((code, self.ended()), (0, []), out)
        self.assertEqual(self.boss("rm", "nothing")[0], 1)


    def test_workers_of_this_sessions_office_listed_added_and_removed(self):
        os.makedirs(os.path.join(self.root, "acc3", ".gemini"))  # an account not signed in yet
        code, out = self.session([["--workers", "acc1"], ["workers"], ["workers", "add", "2", "acc3"], ["workers", "rm", "acc1"]])
        self.assertEqual(code, 0, out)
        self.assertIn("acc1 (a@x.io): free", out)
        self.assertIn("Can be added: acc2 (b@x.io)", out)
        self.assertIn("acc3 (?): not signed in", out)
        [o] = self.team()
        self.assertEqual(o["workers"], ["acc2", "acc3"])
        self.assertNotEqual(self.session([[], ["workers", "add", "acc9"]])[0], 0)
        self.assertNotEqual(self.session([[], ["workers", "rm", "acc9"]])[0], 0)
        code, out = self.boss("workers", sid="other")  # a new session, not a boss
        self.assertIn("type /boss first", out)


    def usage(self, acc, used, resets_in_ms=3600_000):
        d = os.path.join(self.home, ".habblaud", "usage")
        os.makedirs(d, exist_ok=True)
        now = int(time.time() * 1000)
        with open(os.path.join(d, f"agy:{acc}.json"), "w") as f:
            json.dump({"fetchedAt": now, "five_hour": {"utilization": used, "resets_at": now + resets_in_ms},
                       "seven_day": {"utilization": 10, "resets_at": now + 86400_000}}, f)

    def test_a_worker_near_its_quota_is_left_out_and_comes_back_after_its_reset(self):
        self.usage("acc2", 95)
        code, out = self.session([[], ["workers"]], sid="q1")
        self.assertIn("Left out, near their quota (/quota checks again): acc2", out)
        [o] = self.team()
        self.assertEqual((o["workers"], o["benched"]), (["acc1"], ["acc2"]))
        self.usage("acc2", 95, resets_in_ms=-1)  # its 5-hour window has reset since
        code, out = self.boss("list", sid="q1")  # resumed: as it was
        self.assertEqual(self.team()[0]["workers"], ["acc1"])
        code, out = self.session([[]], sid="q2")
        [o] = self.team()
        self.assertEqual((o["workers"], "benched" in o), (["acc1", "acc2"], False))


if __name__ == "__main__":
    unittest.main()
