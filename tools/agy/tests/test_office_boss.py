"""office-boss (/boss, /offices, /workers, /quota, /office): which office a session becomes the boss of, an office living
as long as its boss's session (closed when it ends, back when it is resumed), and its workers: accounts added, sessions
cloned, both removed."""
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
        with open(os.path.join(self.bin, "agy-as"), "w") as f:  # /quota asks agy for its /usage: what the test left
            f.write('#!/bin/sh\ncat "$HOME/usage-$1.txt" 2>/dev/null\nexit 0\n')
        os.chmod(os.path.join(self.bin, "agy-as"), 0o755)
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
                           env=dict(os.environ, HABBLAUD_AGY_PROFILES=self.root, HOME=self.home, SID=sid,
                                    PATH=f"{self.bin}:{os.environ['PATH']}"), timeout=10)
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
        self.assertIn('agy-ask <id> "<job>"', out)
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

    def other_boss(self):
        """Another running session (a live `claude`) as a boss record."""
        p = subprocess.Popen([os.path.join(self.bin, "claude"), "sleep", "30"], env=dict(os.environ, HOME=self.home, SID="other"))
        self.addCleanup(p.kill)
        time.sleep(0.2)
        return {"kind": "claude", "id": "other", "pid": p.pid, "name": "Other"}

    def test_two_terminals_in_home_get_two_offices_and_never_take_each_other(self):
        self.write([{"id": "cli", "name": "Terminal", "folder": "", "workers": ["acc1"], "boss": self.other_boss()}])
        code, out = self.boss(cwd=self.home, sid="s2")
        self.assertEqual(code, 0, out)
        self.assertIn('boss of the office "Terminal 2"', out)
        self.assertNotIn("replaced", out)
        cli, cli2 = self.team()
        self.assertEqual((cli["id"], cli["boss"]["id"]), ("cli", "other"))
        self.assertEqual((cli2["id"], cli2["folder"], cli2["workers"]), ("cli-2", "", ["acc1", "acc2"]))

    def test_a_project_office_with_a_running_boss_is_refused_unless_named(self):
        self.write([{"id": "app", "name": "app", "folder": os.path.realpath(self.app), "workers": ["acc1"], "boss": self.other_boss()}])
        code, out = self.boss(sid="s2")
        self.assertEqual(code, 1, out)
        self.assertIn("already has a boss in another running session", out)
        self.assertEqual(self.team()[0]["boss"]["id"], "other")
        code, out = self.boss("app", sid="s2")  # on purpose: take it over
        self.assertEqual(code, 0, out)
        self.assertIn("replaced the previous boss Other", out)

    def test_rm_closes_an_office_or_forgets_an_ended_one(self):
        self.write([{"id": "ws", "name": "Workspace", "folder": "", "workers": [], "boss": None}])
        code, out = self.boss("offices", "rm", "Workspace")
        self.assertEqual((code, self.team()), (0, []), out)
        self.session([[]], sid="s1-long-id")
        self.boss("list", sid="s2")
        code, out = self.boss("rm", "s1-long-")
        self.assertEqual((code, self.ended()), (0, []), out)
        self.assertEqual(self.boss("rm", "nothing")[0], 1)


    def test_workers_lists_the_sessions_by_account_with_what_can_be_added_or_cloned(self):
        os.makedirs(os.path.join(self.root, "acc3", ".gemini"))  # an account not signed in yet
        os.makedirs(os.path.join(self.home, ".claude-work", "projects"))
        os.makedirs(os.path.join(self.home, ".claude-intro"))  # not a Claude Code account: no projects/ or sessions/
        code, out = self.session([["--workers", "acc1,claude:.claude#2,acc1#2"], ["workers", "add", "acc3"], ["workers"]])
        self.assertEqual(code, 0, out)
        listed = out[out.rindex("Workers of the office"):]
        self.assertEqual(listed.splitlines(), [
            'Workers of the office "app" (app):',
            "  acc1 (a@x.io)",
            "    acc1: free",
            "    acc1#2: free",
            "  claude:.claude (Claude Code, your own account)",
            "    claude:.claude#2",
            "  acc3 (?)",
            "    acc3: not signed in (agy-as acc3)",
            "Accounts you can add: acc2 (b@x.io), claude:.claude-work  ->  /workers add acc2",
            "Accounts you can clone (one more session): acc1, claude (your own), acc3  ->  /workers clone acc1 [N]",
        ])
        code, out = self.session([["--workers", ","], ["workers", "list"]], sid="s2")
        self.assertIn('The office "app" (app) has no workers.', out)
        self.assertIn("Accounts you can clone (one more session): claude (your own)  ->  /workers clone claude [N]", out)
        code, out = self.boss("workers", sid="other")  # a new session, not a boss
        self.assertIn("type /boss first", out)

    def test_workers_add_takes_accounts_that_are_not_in_the_office_yet(self):
        os.makedirs(os.path.join(self.root, "acc3", ".gemini"))
        os.makedirs(os.path.join(self.home, ".claude-work"))
        code, out = self.session([["--workers", "acc1"], ["workers", "add", "2", "acc3", ".claude-work"]])
        self.assertEqual(code, 0, out)
        self.assertIn("Added: acc2, acc3, claude:.claude-work", out)
        self.assertIn("    acc2: free", out)  # every verb ends with the list
        self.assertIn('claude-ask <id> "<job>"', out)
        self.assertEqual(self.team()[0]["workers"], ["acc1", "acc2", "acc3", "claude:.claude-work"])
        # refused, each with what to type instead; nothing of a refused command is kept
        for bad, hint in ((["acc1"], "acc1 is already in the office: for one more session of it, /workers clone acc1"),
                          (["claude"], "claude:.claude is your own account: for one more session of it, /workers clone claude"),
                          (["acc2", "claude:.claude"], "/workers clone claude"),
                          (["claude*3"], "/workers clone claude 3"),
                          (["acc2*2"], "/workers clone acc2 2"),
                          (["acc1#2"], "acc1#2 names one session, not an account: /workers clone acc1"),
                          (["acc9"], "no account acc9"),
                          ([], "/workers add needs an account")):
            code, out = self.session([["--workers", "acc1"], ["workers", "add", *bad]], sid="s2")
            self.assertNotEqual(code, 0, bad)
            self.assertIn(hint, out)
            self.assertEqual(self.team()[-1]["workers"], ["acc1"], bad)

    def test_workers_clone_adds_sessions_of_an_account_in_the_office_or_of_the_boss_own(self):
        calls = [["--workers", "acc1"], ["workers", "clone", "claude", "3"], ["workers", "clone", "acc1"],
                 ["workers", "clone", "1", "2"], ["workers", "add", "2", "acc2"], ["workers", "clone", "2", "2"]]
        code, out = self.session(calls)
        self.assertEqual(code, 0, out)
        # the boss runs on ~/.claude: it is that account's first session, so its workers there start at #2
        self.assertEqual(self.team()[0]["workers"], ["acc1", "claude:.claude#2", "claude:.claude#3", "claude:.claude#4",
                                                     "acc1#2", "acc1#3", "acc1#4", "acc2", "acc2#2", "acc2#3"])
        self.assertIn("Cloned: claude:.claude#2, claude:.claude#3, claude:.claude#4", out)
        self.assertIn("Cloned: acc1#3, acc1#4", out)
        self.assertIn("  claude:.claude (Claude Code, your own account)\n    claude:.claude#2\n", out)
        for bad, hint in ((["acc2"], "acc2 is not in the office yet: /workers add acc2 first"),
                          (["acc9"], "no account acc9"),
                          (["acc1#2"], "/workers clone acc1"),
                          (["acc1", "0"], "between 1 and 9 sessions at once"),
                          (["acc1", "99"], "between 1 and 9 sessions at once"),
                          (["acc1", "acc2"], "/workers clone takes one account"),
                          ([], "/workers clone takes one account")):
            code, out = self.session([["--workers", "acc1"], ["workers", "clone", *bad]], sid="s2")
            self.assertNotEqual(code, 0, bad)
            self.assertIn(hint, out)
            self.assertEqual(self.team()[-1]["workers"], ["acc1"], bad)

    def test_workers_rm_one_session_an_account_with_all_its_sessions_or_all(self):
        start = ["--workers", "acc1,acc1#2,acc1#3,acc2,claude:.claude#2,claude:.claude#3"]
        code, out = self.session([start, ["workers", "rm", "acc1#2"]])
        self.assertEqual(code, 0, out)
        self.assertIn("Removed: acc1#2", out)
        self.assertEqual(self.team()[0]["workers"], ["acc1", "acc1#3", "acc2", "claude:.claude#2", "claude:.claude#3"])
        # a plain account: the account with all its sessions (also the boss's own, which has only clones)
        code, out = self.session([start, ["workers", "rm", "1", "acc1", "claude"]], sid="s2")
        self.assertEqual(code, 0, out)
        self.assertIn("Removed: acc1, acc1#2, acc1#3, claude:.claude#2, claude:.claude#3", out)
        self.assertEqual(self.team()[-1]["workers"], ["acc2"])
        code, out = self.session([start, ["workers", "rm", "all"]], sid="s3")
        self.assertEqual(code, 0, out)
        self.assertIn('The office "app" (app) has no workers.', out)
        self.assertEqual(self.team()[-1]["workers"], [])
        # not there: refused with the current list, and nothing of the command is kept
        for bad in (["acc1#7"], ["acc2", "acc9"], ["claude:.claude-nope"], []):
            code, out = self.session([["--workers", "acc1,acc2"], ["workers", "rm", *bad]], sid="s4")
            self.assertNotEqual(code, 0, bad)
            self.assertEqual(self.team()[-1]["workers"], ["acc1", "acc2"], bad)
        self.assertIn("acc1#7 is not in this office (workers: acc1, acc2)", self.session([["--workers", "acc1,acc2"], ["workers", "rm", "acc1#7"]], sid="s5")[1])

    def test_rm_also_takes_a_benched_account_out_so_quota_does_not_bring_it_back(self):
        self.write([{"id": "app", "name": "app", "folder": os.path.realpath(self.app), "boss": None,
                     "workers": ["acc1", "acc2", "acc2#2"]}])
        self.usage("acc2", 95)
        code, out = self.session([[], ["workers"], ["workers", "add", "acc2"]], sid="q1")
        self.assertIn("Left out, near their quota (/quota checks again): acc2, acc2#2", out.split("Workers of the office")[1])
        self.assertIn("acc2 is already in the office", out)
        code, out = self.session([[], ["workers", "rm", "acc2"]], sid="q2")
        self.assertEqual(code, 0, out)
        [o] = self.team()
        self.assertEqual((o["workers"], "benched" in o), (["acc1"], False))

    def test_help_lists_every_command_and_an_unknown_verb_points_to_it(self):
        code, out = self.boss("help", sid="nobody")
        self.assertEqual(code, 0, out)
        at = [out.index(c) for c in ("/boss [office|off]", "/workers ", "/workers add <account>", "/workers clone <account> [N]",
                                     "/workers rm <id>", "/quota ", "/offices [rm X]", "/office ", 'agy-ask <acc> "<job>"',
                                     'claude-ask <id> "<job>"')]
        self.assertEqual(at, sorted(at))  # in this order
        self.assertIn("claude#2", out)
        self.assertIn("fresh conversation", out)
        self.assertFalse(os.path.exists(os.path.join(self.root, "team.json")))  # help changes nothing
        code, out = self.session([[], ["workers", "remove", "acc1"]])
        self.assertNotEqual(code, 0)
        self.assertIn('/workers has no "remove"', out)
        self.assertIn("/office lists every command", out)
        code, out = self.boss("nope")
        self.assertIn("/office lists every command", out)
        code, out = self.boss("--soft", "workers", "add", "acc9")  # the slash commands: a refusal is printed, exit 0
        self.assertEqual(code, 0, out)
        self.assertIn("no account acc9", out)

    def test_boss_again_keeps_the_clones_and_the_claude_workers(self):
        os.makedirs(os.path.join(self.home, ".claude-work"))
        calls = [[], ["workers", "clone", "claude", "2"], ["workers", "clone", "acc2"], ["workers", "add", ".claude-work"],
                 ["workers", "rm", "acc1"], []]
        code, out = self.session(calls)
        self.assertEqual(code, 0, out)
        [o] = self.team()
        # every signed-in account again (acc1 is back), then what was added by hand
        self.assertEqual(o["workers"], ["acc1", "acc2", "claude:.claude#2", "claude:.claude#3", "acc2#2", "claude:.claude-work"])
        self.assertIn("claude:.claude#2 (Claude Code, same account as the boss)", out.split("You are now the boss")[-1])
        # --workers names the whole list: nothing else is kept
        self.assertEqual(self.session([[], ["--workers", "acc2,acc2#2"]], sid="s2")[0], 0)
        self.assertEqual(self.team()[-1]["workers"], ["acc2", "acc2#2"])

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

    def test_the_sessions_of_an_account_near_its_quota_leave_and_come_back_together(self):
        self.write([{"id": "app", "name": "app", "folder": os.path.realpath(self.app), "boss": None,
                     "workers": ["acc1", "acc2", "acc2#2", "acc2#3"]}])
        self.usage("acc2", 95)
        code, out = self.session([[]], sid="q1")  # /boss: by the usage last seen
        self.assertIn("Left out, near their quota (/quota checks again): acc2, acc2#2, acc2#3", out)
        [o] = self.team()
        self.assertEqual((o["workers"], o["benched"]), (["acc1"], ["acc2", "acc2#2", "acc2#3"]))
        self.usage("acc2", 95, resets_in_ms=-1)  # its 5-hour window has reset since
        code, out = self.boss("quota", sid="q1")  # the resumed session
        self.assertIn("Back in the office: acc2, acc2#2, acc2#3", out)
        [o] = self.team()
        self.assertEqual((o["workers"], "benched" in o), (["acc1", "acc2", "acc2#2", "acc2#3"], False))
        soon = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
        with open(os.path.join(self.home, "usage-acc2.txt"), "w") as f:  # agy's /usage: % left per window
            f.write(f"Gemini Models\tFive Hour\t3%\t{soon}\nGemini Models\tWeekly\t80%\t{soon}\n")
        code, out = self.boss("quota", sid="q1")
        self.assertIn("until their quota resets (limit 90%): acc2, acc2#2, acc2#3", out)
        [o] = self.team()
        self.assertEqual((o["workers"], o["benched"]), (["acc1"], ["acc2", "acc2#2", "acc2#3"]))


if __name__ == "__main__":
    unittest.main()
