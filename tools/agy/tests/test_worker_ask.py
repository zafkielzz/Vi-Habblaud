#!/usr/bin/env python3
"""Tests of the team rule in bin/worker-ask (agy-ask / claude-ask) against a fake office.

Run: python3 tests/test_worker_ask.py. Nothing real runs: HABBLAUD_AGY_PROFILES is a temp folder, HABBLAUD_URL a
fake server that answers every job at once, and the boss callers are fake `claude` / `agy` scripts (the rule finds
the caller by the command name of its ancestors)."""
import http.server, json, os, shutil, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "bin", "worker-ask")
RULES = os.path.join(HERE, "..", "bin", "office_rules.py")
HOOK = os.path.join(HERE, "..", "bin", "rules-hook")


class Office(http.server.BaseHTTPRequestHandler):
    bodies = []
    snapshot = {"accounts": []}

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Office.bodies.append(body)
        self.reply({"ok": True} if self.path == "/api/team" else {"job": {"id": "j1", "status": "done", "answer": "pong"}})

    def do_GET(self):
        self.reply(Office.snapshot)

    def reply(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


# A fake agent: writes team.json from $TEAM_TEMPLATE with its own PID for __PID__, then runs the command as a child
# (not exec: it must stay an ancestor).
# Headless (`claude -p ...`): answers at once with its arguments as the result.
FAKE = """#!/bin/bash
if [ "$1" = "-p" ]; then
  exec python3 -c 'import json, os, sys; print(json.dumps({"subtype": "success", "result": json.dumps({"args": sys.argv[1:], "office": os.environ.get("AGY_OFFICE"), "worker": os.environ.get("AGY_WORKER")}), "usage": {}}))' "$@"
fi
if [ -n "${TEAM_TEMPLATE:-}" ]; then printf '%s' "${TEAM_TEMPLATE//__PID__/$$}" > "$HABBLAUD_AGY_PROFILES/team.json"; fi
"$@"
exit $?
"""

# A fake `agy-as <acc> -p ...`: one stream-json result line with its arguments and what the worker's hook would see.
FAKE_AGY_AS = """#!/bin/bash
exec python3 -c 'import json, os, sys; print(json.dumps({"event": "result", "result": {"status": "SUCCESS", "response": json.dumps({"args": sys.argv[1:], "worker": os.environ.get("AGY_WORKER")})}}, separators=(",", ":")))' "$@"
"""


class TeamRule(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="worker-ask-test-")
        cls.root = os.path.join(cls.tmp, "profiles")
        for acc in ("acc1", "acc2", "acc5"):
            os.makedirs(os.path.join(cls.root, acc))
        cls.bin = os.path.join(cls.tmp, "bin")
        os.makedirs(cls.bin)
        for name in ("agy-ask", "claude-ask"):
            shutil.copy(SRC, os.path.join(cls.bin, name))
        shutil.copy(RULES, cls.bin)
        shutil.copy(HOOK, cls.bin)
        for name in ("claude", "agy"):
            path = os.path.join(cls.bin, name)
            with open(path, "w") as f:
                f.write(FAKE)
            os.chmod(path, 0o755)
        with open(os.path.join(cls.bin, "agy-as"), "w") as f:  # headless agy: answers with its arguments
            f.write(FAKE_AGY_AS)
        os.chmod(os.path.join(cls.bin, "agy-as"), 0o755)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Office)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        shutil.rmtree(cls.tmp)

    def setUp(self):
        Office.bodies.clear()
        Office.snapshot = {"accounts": []}
        for name in ("rules-log.jsonl", "agy-ask.log.jsonl"):
            try:
                os.remove(os.path.join(self.root, name))
            except FileNotFoundError:
                pass
        try:
            os.remove(os.path.join(self.root, "team.json"))
        except FileNotFoundError:
            pass

    def run_ask(self, args, via=None, team=None, env=None, tool="agy-ask"):
        """(exit code, stdout, stderr) of `<tool> <args>`, started by the fake `via` agent when given."""
        e = {k: v for k, v in os.environ.items() if not k.startswith(("AGY_", "TEAM_TEMPLATE"))}
        e.update(HABBLAUD_AGY_PROFILES=self.root, HABBLAUD_URL=f"http://127.0.0.1:{self.server.server_port}")
        if team is not None:
            if via:
                e["TEAM_TEMPLATE"] = json.dumps(team)
            else:
                with open(os.path.join(self.root, "team.json"), "w") as f:
                    json.dump(team, f)
        e.update(env or {})
        cmd = [os.path.join(self.bin, tool)] + args
        if via:
            cmd = [os.path.join(self.bin, via)] + cmd
        p = subprocess.run(cmd, env=e, capture_output=True, text=True, timeout=30, cwd=self.tmp)
        return p.returncode, p.stdout, p.stderr

    @staticmethod
    def claude_boss(name="Raul"):
        return {"kind": "claude", "id": ".claude:1", "account": ".claude", "pid": "__PID__", "name": name}

    def v3(self, boss2=None, boss1=None):
        # Fake folders: the rules let these offices' workers edit anywhere, so the jobs (cwd: the temp folder) pass.
        anywhere = {"scope": {"write": ["/"]}}
        return {"offices": [
            {"id": "o1", "name": "Habblaud", "folder": "/x/habblaud", "boss": boss1, "workers": ["acc1"], "rules": anywhere},
            {"id": "o2", "name": "News", "folder": "/x/news", "boss": boss2, "workers": ["acc2", "claude:.claude-w"], "rules": anywhere},
        ]}

    def ask(self, worker, via=None, team=None, env=None, tool="agy-ask"):
        if team is not None and via:
            template = json.dumps(team).replace('"__PID__"', "__PID__")
            return self.run_ask_raw([worker, "ping"], via, template, env, tool)
        return self.run_ask([worker, "ping"], via, team, env, tool)

    def run_ask_raw(self, args, via, template, env, tool):
        return self.run_ask(args, via, None, dict(env or {}, TEAM_TEMPLATE=template), tool)

    # -------------------------------------------------------------- the boss of an office

    def test_boss_gives_jobs_to_its_office_with_the_office_id(self):
        code, out, err = self.ask("acc2", via="claude", team=self.v3(boss2=self.claude_boss()))
        self.assertEqual((code, out.strip()), (0, "pong"), err)
        self.assertEqual(Office.bodies[-1]["office"], "o2")
        self.assertEqual(Office.bodies[-1]["by"], "boss")

    def test_claude_worker_of_the_office(self):
        code, out, err = self.ask("w", via="claude", team=self.v3(boss2=self.claude_boss()), tool="claude-ask")
        self.assertEqual(code, 0, err)
        self.assertEqual(Office.bodies[-1]["worker"], "claude:.claude-w")
        self.assertEqual(Office.bodies[-1]["office"], "o2")

    def test_boss_refused_for_another_offices_worker(self):
        code, _, err = self.ask("acc1", via="claude", team=self.v3(boss2=self.claude_boss()))
        self.assertEqual(code, 2)
        self.assertIn("not a worker of your office News (o2)", err)
        self.assertEqual(Office.bodies, [])

    def test_boss_refused_for_its_own_account(self):
        team = self.v3(boss2={"kind": "agy", "acc": "acc2", "name": "Ana"})
        team["offices"][1]["workers"].append("acc2")
        code, _, err = self.run_ask(["acc2", "ping"], via="agy", team=team, env={"HOME": os.path.join(self.root, "acc2")})
        self.assertEqual(code, 2)
        self.assertIn("boss's own account", err)

    def test_agy_boss_found_by_its_profile_home(self):
        team = self.v3(boss1={"kind": "agy", "acc": "acc5", "name": "Ana"})
        env = {"HOME": os.path.join(self.root, "acc5"), "AGY_BOSS": "1", "AGY_OFFICE": "o1"}
        code, out, err = self.run_ask(["acc1", "ping"], via="agy", team=team, env=env)
        self.assertEqual((code, out.strip()), (0, "pong"), err)
        self.assertEqual(Office.bodies[-1]["office"], "o1")

    # -------------------------------------------------------------- clones: one more session of an account

    def test_a_clone_is_a_worker_only_when_it_is_listed(self):
        team = self.v3(boss2=self.claude_boss())
        code, _, err = self.ask("acc2#2", via="claude", team=team)
        self.assertEqual(code, 2)
        self.assertIn("acc2#2 is not a worker of your office News (o2)", err)
        self.assertEqual(Office.bodies, [])
        team["offices"][1]["workers"] += ["acc2#2", "claude:.claude-w#3"]
        code, out, err = self.ask("acc2#2", via="claude", team=team)
        self.assertEqual((code, out.strip()), (0, "pong"), err)
        self.assertEqual((Office.bodies[-1]["worker"], Office.bodies[-1]["office"]), ("acc2#2", "o2"))
        code, _, err = self.ask("w#3", via="claude", team=team, tool="claude-ask")
        self.assertEqual(code, 0, err)
        self.assertEqual(Office.bodies[-1]["worker"], "claude:.claude-w#3")
        code, _, err = self.ask("claude:.claude-w#2", via="claude", team=team, tool="claude-ask")  # not that one
        self.assertEqual(code, 2)
        self.assertIn("claude:.claude-w#2 is not a worker of your office", err)

    def test_a_claude_boss_gives_jobs_to_its_own_account(self):
        team = self.v3(boss2=self.claude_boss())
        team["offices"][1]["workers"] = ["claude:.claude", "claude:.claude#2"]
        home = {"HOME": self.tmp}  # no ~/.claude-claude there: "claude" names the default account
        for name, worker in (("claude#2", "claude:.claude#2"), ("claude", "claude:.claude"), (".claude#2", "claude:.claude#2")):
            code, out, err = self.ask(name, via="claude", team=team, env=home, tool="claude-ask")
            self.assertEqual((code, out.strip()), (0, "pong"), err)
            self.assertEqual((Office.bodies[-1]["worker"], Office.bodies[-1]["office"]), (worker, "o2"))
            self.assertIn("is the account you run on: this saves your context, not your quota", err)
        n = len(Office.bodies)
        code, _, err = self.ask("claude#3", via="claude", team=team, env=home, tool="claude-ask")
        self.assertEqual(code, 2)
        self.assertIn("claude:.claude#3 is not a worker of your office", err)
        self.assertEqual(len(Office.bodies), n)

    def test_an_agy_boss_is_refused_for_a_clone_of_its_own_account(self):
        team = self.v3(boss2={"kind": "agy", "acc": "acc2", "name": "Ana"})
        team["offices"][1]["workers"].append("acc2#2")
        code, _, err = self.run_ask(["acc2#2", "ping"], via="agy", team=team, env={"HOME": os.path.join(self.root, "acc2")})
        self.assertEqual(code, 2)
        self.assertIn("boss's own account", err)

    def test_a_worker_session_on_the_boss_account_cannot_give_jobs(self):
        # the worker is another `claude` below the boss: the nearest claude above the call is not the boss
        team = self.v3(boss2=self.claude_boss())
        team["offices"][1]["workers"] = ["acc2", "claude:.claude#2"]
        template = json.dumps(team).replace('"__PID__"', "__PID__")
        e = {k: v for k, v in os.environ.items() if not k.startswith(("AGY_", "TEAM_TEMPLATE"))}
        e.update(HABBLAUD_AGY_PROFILES=self.root, HABBLAUD_URL=f"http://127.0.0.1:{self.server.server_port}", TEAM_TEMPLATE=template)
        worker = os.path.join(self.bin, "worker", "claude")  # a second fake claude that leaves the team file alone
        os.makedirs(os.path.dirname(worker), exist_ok=True)
        with open(worker, "w") as f:
            f.write('#!/bin/bash\n"$@"\nexit $?\n')
        os.chmod(worker, 0o755)
        p = subprocess.run([os.path.join(self.bin, "claude"), worker, os.path.join(self.bin, "agy-ask"), "acc2", "ping"],
                           env=e, capture_output=True, text=True, timeout=30, cwd=self.tmp)
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("only a boss may give jobs", p.stderr)
        self.assertEqual(Office.bodies, [])

    def test_a_clone_over_quota_leaves_with_every_session_of_its_account(self):
        Office.snapshot = {"accounts": [{"id": "agy:acc1", "usage": {"fiveHour": {"utilization": 20}, "sevenDay": {"utilization": 93}}}]}
        team = self.ruled(None)
        team["offices"][0]["workers"] = ["acc1", "acc1#2", "acc2", "claude:.claude-w"]
        code, _, err = self.ask("acc1#2", team=team)  # its account's use, not a use of its own
        self.assertEqual(code, 2)
        self.assertIn("acc1 has used 93% of its quota (limit 90%)", err)
        with open(os.path.join(self.root, "team.json")) as f:
            o = json.load(f)["offices"][0]
        self.assertEqual((o["workers"], o["benched"]), (["acc2", "claude:.claude-w"], ["acc1", "acc1#2"]))
        self.assertEqual(self.violations()[-1]["who"], "acc1#2")

    def test_headless_a_clone_runs_like_its_account(self):
        os.makedirs(os.path.join(self.tmp, ".claude-w"), exist_ok=True)
        team = self.ruled(None)
        team["offices"][0]["workers"] = ["acc1", "acc1#2", "claude:.claude-w", "claude:.claude-w#2"]
        e = {"HOME": self.tmp, "HABBLAUD_URL": "http://127.0.0.1:9", "PATH": f"{self.bin}:{os.environ['PATH']}"}
        code, out, err = self.run_ask(["acc1#2", "ping", "--mode", "default"], team=team, env=e)
        self.assertEqual(code, 0, err)
        r = json.loads(out)
        self.assertEqual(r["args"][:2], ["acc1", "-p"])  # the profile, not "acc1#2"
        self.assertEqual(r["worker"], "acc1#2")  # the session, for the rules hook and the log
        code, out, err = self.run_ask(["w#2", "ping"], team=team, env=e, tool="claude-ask")
        self.assertEqual(code, 0, err)
        r = json.loads(out)
        self.assertEqual((r["args"][0], r["worker"]), ("-p", "claude:.claude-w#2"))
        with open(os.path.join(self.root, "agy-ask.log.jsonl")) as f:
            lines = [json.loads(l) for l in f]
        self.assertEqual([(l["acc"], l["worker"]) for l in lines if l["event"] == "start"],
                         [("acc1", "acc1#2"), ("claude:.claude-w", "claude:.claude-w#2")])

    def live_claude(self):
        """The PID of a running process named `claude` (another session that is boss)."""
        d = tempfile.mkdtemp(dir=self.tmp)
        path = os.path.join(d, "claude")
        with open(path, "w") as f:
            f.write("#!/bin/sh\nsleep 30\n")
        os.chmod(path, 0o755)
        p = subprocess.Popen([path])
        self.addCleanup(p.wait)
        self.addCleanup(p.kill)
        for _ in range(50):  # until the shell has read its script (comm = the script's name)
            try:
                if open(f"/proc/{p.pid}/comm").read().strip() == "claude":
                    break
            except OSError:
                pass
            time.sleep(0.02)
        return p.pid

    def test_not_a_boss_refused_while_an_office_has_one(self):
        code, _, err = self.ask("acc1", team=self.v3(boss2={"kind": "claude", "account": ".claude", "pid": self.live_claude(), "name": "Raul"}))
        self.assertEqual(code, 2)
        self.assertIn("only a boss may give jobs (bosses: Raul", err)
        self.assertIn("/boss", err)

    def test_a_boss_whose_session_ended_leaves_the_office_vacant(self):
        team = self.v3(boss2={"kind": "claude", "account": ".claude", "pid": 1, "name": "Raul"})  # pid 1 is not claude
        team["offices"][0]["workers"].append("acc2")
        code, _, err = self.ask("acc2", team=team)
        self.assertEqual(code, 0, err)

    # -------------------------------------------------------------- no boss anywhere

    def test_no_boss_any_offices_worker_with_its_first_office(self):
        team = self.v3()
        team["offices"][0]["workers"].append("acc2")
        code, _, err = self.ask("acc2", team=team)
        self.assertEqual(code, 0, err)
        self.assertEqual(Office.bodies[-1]["office"], "o1")

    def test_no_boss_unregistered_worker_refused(self):
        code, _, err = self.ask("acc5", team=self.v3())
        self.assertEqual(code, 2)
        self.assertIn("acc5 is not a registered worker (workers: acc1, acc2, claude:.claude-w", err)

    def test_no_team_file_no_rule_no_office(self):
        code, _, err = self.ask("acc5")
        self.assertEqual(code, 0, err)
        self.assertNotIn("office", Office.bodies[-1])

    # -------------------------------------------------------------- jobs from the office, v2 files

    def test_office_jobs_skip_the_rule_and_carry_the_office(self):
        env = {"AGY_ASK_FROM_OFFICE": "1", "AGY_OFFICE": "o2"}
        code, _, err = self.ask("acc5", team=self.v3(boss2=self.claude_boss()), env=env)
        self.assertEqual(code, 0, err)
        self.assertEqual((Office.bodies[-1]["office"], Office.bodies[-1]["by"]), ("o2", "you"))

    def test_v2_file_is_office_main(self):
        team = {"boss": self.claude_boss(), "workers": ["acc1"]}
        code, _, err = self.ask("acc1", via="claude", team=team)
        self.assertEqual(code, 0, err)
        self.assertEqual(Office.bodies[-1]["office"], "main")
        code, _, err = self.ask("acc2", via="claude", team=team)
        self.assertEqual(code, 2)

    # -------------------------------------------------------------- agy-ask team

    def test_team_prints_offices_and_marks_yours(self):
        template = json.dumps(self.v3(boss2=self.claude_boss())).replace('"__PID__"', "__PID__")
        code, out, err = self.run_ask(["team"], via="claude", env={"TEAM_TEMPLATE": template})
        self.assertEqual(code, 0, err)
        self.assertIn("office Habblaud (o1): /x/habblaud\n  boss: none\n  workers: acc1", out)
        self.assertIn("office News (o2): /x/news  <- you are its boss\n  boss: Raul (Claude Code, account claude:.claude)", out)
        self.assertNotIn("you: not a boss", out)

    # -------------------------------------------------------------- lean Claude workers

    def headless_args(self, extra=(), env=None):
        """The arguments a headless claude-ask gives `claude` (no office, no team file)."""
        os.makedirs(os.path.join(self.tmp, ".claude-w"), exist_ok=True)
        e = {"HOME": self.tmp, "HABBLAUD_URL": "http://127.0.0.1:9", "PATH": f"{self.bin}:{os.environ['PATH']}", **(env or {})}
        code, out, err = self.run_ask(["w", "ping", "--max", "500", *extra], env=e, tool="claude-ask")
        self.assertEqual(code, 0, err)
        return json.loads(out)["args"], err

    def test_claude_headless_starts_lean_with_the_worker_rule(self):
        args, _ = self.headless_args()
        self.assertIn("--strict-mcp-config", args)
        self.assertIn("--disable-slash-commands", args)
        self.assertEqual(args[args.index("--tools") + 1], "Bash,Read,Edit,Write,WebFetch,WebSearch")
        self.assertIn("under 500 characters", args[args.index("--append-system-prompt") + 1])

    def test_claude_full_and_own_tools(self):
        args, _ = self.headless_args(["--full"])
        self.assertNotIn("--strict-mcp-config", args)
        self.assertNotIn("--full", args)
        args, _ = self.headless_args(["--tools", "Read"])
        self.assertEqual(args.count("--tools"), 1)
        self.assertEqual(args[args.index("--tools") + 1], "Read")

    def test_claude_office_job_says_lean(self):
        code, _, err = self.ask("w", tool="claude-ask")
        self.assertEqual(code, 0, err)
        self.assertIs(Office.bodies[-1]["lean"], True)
        code, _, err = self.run_ask(["w", "ping", "--full"], tool="claude-ask")
        self.assertNotIn("lean", Office.bodies[-1])
        self.ask("acc1")
        self.assertNotIn("lean", Office.bodies[-1])

    def test_claude_same_account_note(self):
        code, _, err = self.run_ask(["w", "ping"], via="claude", env={"CLAUDE_CONFIG_DIR": os.path.expanduser("~/.claude-w")}, tool="claude-ask")
        self.assertEqual(code, 0, err)
        self.assertIn("is the account you run on", err)
        code, _, err = self.run_ask(["w", "ping"], via="claude", env={"CLAUDE_CONFIG_DIR": "/elsewhere"}, tool="claude-ask")
        self.assertNotIn("account you run on", err)

    # -------------------------------------------------------------- office rules on jobs

    def ruled(self, rules, folder=None):
        """A one-office team (no boss) whose office is the temp folder (or `folder`) with these rules."""
        return {"offices": [{"id": "o1", "name": "Shop", "folder": folder or self.tmp, "boss": None,
                             "workers": ["acc1", "claude:.claude-w"], "rules": rules}]}

    def violations(self):
        with open(os.path.join(self.root, "rules-log.jsonl")) as f:
            return [json.loads(l) for l in f]

    def test_job_starts_with_the_rules_for_workers(self):
        code, _, err = self.ask("acc1", team=self.ruled({"items": [{"text": "Write tests first", "for": "workers"}]}))
        self.assertEqual(code, 0, err)
        prompt = Office.bodies[-1]["prompt"]
        self.assertTrue(prompt.startswith('Office rules of "Shop"'), prompt)
        self.assertIn("- Write tests first", prompt)
        self.assertTrue(prompt.endswith("\n\nping"))

    def test_job_outside_the_write_scope_refused_and_logged(self):
        code, _, err = self.ask("acc1", team=self.ruled(None, folder="/x/elsewhere"))
        self.assertEqual(code, 2)
        self.assertIn("--cwd", err)
        self.assertIn("edits are allowed only inside /x/elsewhere", err)
        self.assertEqual(Office.bodies, [])
        v = self.violations()[-1]
        self.assertEqual((v["office"], v["who"], v["kind"], v["by"], v["detail"]), ("o1", "acc1", "cwd", "ask", self.tmp))

    def test_job_over_max_jobs_refused(self):
        import time
        with open(os.path.join(self.root, "agy-ask.log.jsonl"), "w") as f:
            for j in ("a", "b"):
                f.write(json.dumps({"event": "start", "ts": time.time(), "via": "terminal", "job": j, "office": "o1"}) + "\n")
            f.write(json.dumps({"event": "end", "ts": time.time(), "via": "terminal", "job": "b"}) + "\n")
        team = self.ruled({"limits": {"maxJobs": 2}})
        self.assertEqual(self.ask("acc1", team=team)[0], 0)  # one still running (b ended)
        with open(os.path.join(self.root, "agy-ask.log.jsonl"), "a") as f:
            f.write(json.dumps({"event": "start", "ts": time.time(), "via": "terminal", "job": "c", "office": "o1"}) + "\n")
        code, _, err = self.ask("acc1", team=team)
        self.assertEqual(code, 2)
        self.assertIn("already runs 2 job(s) (limit 2)", err)
        self.assertEqual(self.violations()[-1]["kind"], "jobs")

    def test_job_for_a_worker_over_quota_refused(self):
        Office.snapshot = {"accounts": [{"id": "agy:acc1", "usage": {"fiveHour": {"utilization": 20}, "sevenDay": {"utilization": 93}}}]}
        code, _, err = self.ask("acc1", team=self.ruled(None))  # defaults: quotaStop 90
        self.assertEqual(code, 2)
        self.assertIn("acc1 has used 93% of its quota (limit 90%)", err)
        self.assertEqual(self.violations()[-1]["kind"], "quota")
        Office.snapshot = {"accounts": [{"id": "agy:acc1", "usage": {"sevenDay": {"utilization": 50}}}]}
        self.assertEqual(self.ask("acc1", team=self.ruled(None))[0], 0)

    def test_claude_worker_gets_the_hook_and_its_office(self):
        os.makedirs(os.path.join(self.tmp, ".claude-w"), exist_ok=True)
        with open(os.path.join(self.root, "team.json"), "w") as f:
            json.dump(self.ruled(None), f)
        e = {"HOME": self.tmp, "HABBLAUD_URL": "http://127.0.0.1:9", "PATH": f"{self.bin}:{os.environ['PATH']}"}
        code, out, err = self.run_ask(["w", "ping"], env=e, tool="claude-ask")
        self.assertEqual(code, 0, err)
        r = json.loads(out)
        settings = json.loads(r["args"][r["args"].index("--settings") + 1])
        hook = settings["hooks"]["PreToolUse"][0]
        self.assertIn("Edit", hook["matcher"])
        self.assertTrue(hook["hooks"][0]["command"].endswith("/rules-hook"))
        self.assertEqual((r["office"], r["worker"]), ("o1", "claude:.claude-w"))

    # -------------------------------------------------------------- agy-ask rules

    def test_rules_print_and_check(self):
        team = self.ruled({"scope": {"deny": [".env"], "commands": ["git push"]}}, folder="/x/shop")
        code, out, _ = self.run_ask(["rules"], team=team)
        self.assertEqual(code, 0)
        self.assertIn('Office rules of "Shop"', out)
        self.assertIn("Edit files only inside: /x/shop.", out)
        self.assertIn("agy-ask rules propose", self.run_ask(["rules", "--who", "boss"], team=team)[1])
        self.assertEqual(self.run_ask(["rules", "check", "/x/shop/a.py", "--write"], team=team)[:2], (0, "allowed\n"))
        self.assertEqual(self.run_ask(["rules", "check", "/x/other/a.py", "--write"], team=team)[:2], (2, "refused: outside (rule: /x/shop)\n"))
        self.assertEqual(self.run_ask(["rules", "check", "/x/other/a.py"], team=team)[0], 0)
        self.assertEqual(self.run_ask(["rules", "check", "/x/shop/.env"], team=team)[:2], (2, "refused: deny (rule: .env)\n"))
        self.assertEqual(self.run_ask(["rules", "check", "--cmd", "npm test && git push"], team=team)[:2], (2, "refused: command (rule: git push)\n"))
        self.assertEqual(self.run_ask(["rules", "--office", "nope"], team=team)[0], 1)

    def test_rules_propose_goes_to_the_office(self):
        code, out, err = self.run_ask(["rules", "propose", "Run the tests before done", "--why", "two broken builds"], team=self.ruled(None),
                                      env={"AGY_ASK_FROM_OFFICE": "1", "AGY_OFFICE": "o1"})
        self.assertEqual(code, 0, err)
        self.assertEqual(Office.bodies[-1], {"office": "o1", "propose": {"text": "Run the tests before done", "for": "workers", "by": "you", "why": "two broken builds"}})
        # an agent that is not the office's boss: "script"; the boss: its name
        team = self.ruled(None)
        team["offices"][0]["boss"] = self.claude_boss("Renata")
        self.run_ask(["rules", "propose", "x"], via="claude", team=self.ruled(None))
        self.assertEqual(Office.bodies[-1]["propose"]["by"], "script")
        self.run_ask_raw(["rules", "propose", "y"], "claude", json.dumps(team).replace('"__PID__"', "__PID__"), None, "agy-ask")
        self.assertEqual(Office.bodies[-1]["propose"]["by"], "Renata")
        code, _, err = self.run_ask(["rules", "propose", "x"], team=self.ruled(None), env={"HABBLAUD_URL": "http://127.0.0.1:9"})
        self.assertEqual(code, 1)
        self.assertIn("the office is not running", err)

    def test_team_not_a_boss(self):
        code, out, _ = self.run_ask(["team"], team=self.v3(boss2={"kind": "claude", "account": ".claude", "pid": self.live_claude()}))
        self.assertIn("you: not a boss\n", out)


class BossRulesHook(unittest.TestCase):
    """agy-plugin/agy-boss/boss-rules: the SessionStart hook that makes an agy started by Habblaud a boss."""
    HOOK = os.path.join(HERE, "..", "agy-plugin", "agy-boss", "boss-rules")

    def hook(self, env):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "team.json"), "w") as f:
                json.dump({"offices": [{"id": "o7", "name": "Glass shop", "folder": "/x/glass", "workers": []}]}, f)
            e = {k: v for k, v in os.environ.items() if not k.startswith("AGY_")}
            e.update(env, HABBLAUD_AGY_PROFILES=root)
            p = subprocess.run([sys.executable, self.HOOK], input="{}", env=e, capture_output=True, text=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)

    def test_nothing_without_agy_boss(self):
        self.assertEqual(self.hook({}), {})

    def test_boss_rules_and_office(self):
        msg = self.hook({"AGY_BOSS": "1", "AGY_OFFICE": "o7"})["injectSteps"][0]["systemMessage"]["systemMessage"]
        self.assertTrue(msg.startswith("# You are the boss here"))
        self.assertIn("boss of the office Glass shop (id o7), project folder /x/glass.", msg)


class RulesHook(unittest.TestCase):
    """bin/rules-hook: the PreToolUse hook (a worker's office from AGY_OFFICE) and `rules-hook boss` for the mod."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rules-hook-test-")
        cls.root = os.path.join(cls.tmp, "profiles")
        os.makedirs(cls.root)
        cls.bin = os.path.join(cls.tmp, "bin")
        os.makedirs(cls.bin)
        shutil.copy(HOOK, cls.bin)
        shutil.copy(RULES, cls.bin)
        path = os.path.join(cls.bin, "claude")
        with open(path, "w") as f:
            f.write(FAKE)
        os.chmod(path, 0o755)
        cls.team = {"offices": [{"id": "o1", "name": "Shop", "folder": "/x/shop", "boss": None, "workers": ["acc1"],
                                 "rules": {"scope": {"deny": [".env", "~/.ssh"], "commands": ["git push"]}}}]}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def setUp(self):
        with open(os.path.join(self.root, "team.json"), "w") as f:
            json.dump(self.team, f)
        try:
            os.remove(os.path.join(self.root, "rules-log.jsonl"))
        except FileNotFoundError:
            pass

    def hook(self, tool, inp, env=None, args=(), via=None):
        e = {k: v for k, v in os.environ.items() if not k.startswith(("AGY_", "HABBLAUD_", "TEAM_TEMPLATE"))}
        e.update(HABBLAUD_AGY_PROFILES=self.root, HOME="/home/u", **(env if env is not None else {"AGY_OFFICE": "o1", "AGY_WORKER": "acc1"}))
        cmd = [os.path.join(self.bin, "rules-hook"), *args]
        if via:
            cmd = [os.path.join(self.bin, via)] + cmd
        stdin = inp if isinstance(inp, str) else json.dumps({"tool_name": tool, "tool_input": inp, "cwd": "/x/shop"})
        p = subprocess.run(cmd, input=stdin, env=e, capture_output=True, text=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        return (json.loads(p.stdout)["hookSpecificOutput"] if p.stdout.strip() else None), p.stderr

    def denied(self, tool, inp, **kw):
        out, _ = self.hook(tool, inp, **kw)
        self.assertIsNotNone(out, f"{tool} {inp} was allowed")
        self.assertEqual((out["hookEventName"], out["permissionDecision"]), ("PreToolUse", "deny"))
        return out["permissionDecisionReason"]

    def violations(self):
        with open(os.path.join(self.root, "rules-log.jsonl")) as f:
            return [json.loads(l) for l in f]

    def test_edits_outside_the_folder_and_denied_paths_are_blocked_and_logged(self):
        self.assertIn("edited only inside /x/shop", self.denied("Edit", {"file_path": "/x/other/a.py"}))
        v = self.violations()[-1]
        self.assertEqual((v["office"], v["who"], v["kind"], v["detail"], v["by"]), ("o1", "acc1", "outside", "/x/other/a.py", "hook"))
        self.assertIsNone(self.hook("Write", {"file_path": "src/a.py"})[0])  # relative: inside the cwd /x/shop
        self.assertIn('(".env")', self.denied("Read", {"file_path": "/x/shop/.env"}))
        self.assertIsNone(self.hook("Read", {"file_path": "/x/other/a.py"})[0])
        self.denied("Grep", {"pattern": "key", "path": "/home/u/.ssh"})
        self.denied("Glob", {"pattern": "/home/u/.ssh/*"})
        self.denied("NotebookEdit", {"notebook_path": "/tmp/n.ipynb"})
        self.assertEqual(self.violations()[-1]["kind"], "outside")

    def test_commands(self):
        self.assertIn('"git push"', self.denied("Bash", {"command": "npm test && git push origin main"}))
        self.assertEqual(self.violations()[-1]["kind"], "command")
        self.assertIsNone(self.hook("Bash", {"command": "git status"})[0])

    def test_rules_files_are_not_for_agents(self):
        team = os.path.join(self.root, "team.json")
        self.assertIn("Habblaud page only", self.denied("Write", {"file_path": team}, env={"AGY_OFFICE": "o1"}))
        self.assertEqual(self.violations()[-1]["who"], "boss")
        self.denied("Edit", {"file_path": os.path.join(self.root, "rules-log.jsonl")})
        self.denied("Bash", {"command": "echo '{}' > ~/.agy_profiles/team.json"})
        self.denied("Bash", {"command": f"sed -i s/a/b/ {team}"}, env={"AGY_OFFICE": "o1"})  # ROOT is a custom folder here
        self.assertIsNone(self.hook("Bash", {"command": "cat ~/.agy_profiles/team.json"})[0])
        self.assertIsNone(self.hook("Read", {"file_path": team})[0])

    def test_no_office_or_bad_input_allows(self):
        self.assertEqual(self.hook("Edit", {"file_path": "/x/other/a.py"}, env={}), (None, ""))
        out, err = self.hook("Edit", "not json")
        self.assertIsNone(out)
        self.assertIn("call allowed", err)
        self.assertIsNone(self.hook("WebFetch", {"url": "x"})[0])

    def test_antigravity_events(self):
        call = lambda name, args, **kw: json.dumps({"toolCall": {"name": name, "args": args}, "workspacePaths": ["/x/shop"], **kw})
        out = subprocess.run([os.path.join(self.bin, "rules-hook")], input=call("write_to_file", {"TargetFile": "/x/other/a.py"}),
                             env=dict(os.environ, HABBLAUD_AGY_PROFILES=self.root, HOME="/home/u", AGY_OFFICE="o1", AGY_WORKER="acc1"),
                             capture_output=True, text=True, timeout=10).stdout
        self.assertEqual(json.loads(out)["decision"], "deny")
        self.assertIn("edited only inside /x/shop", json.loads(out)["reason"])
        self.assertEqual(self.violations()[-1]["who"], "acc1")

        def answer(name, args, env=None):
            e = dict(os.environ, HABBLAUD_AGY_PROFILES=self.root, HOME="/home/u", **(env if env is not None else {"AGY_OFFICE": "o1"}))
            r = subprocess.run([os.path.join(self.bin, "rules-hook")], input=call(name, args), env=e, capture_output=True, text=True, timeout=10)
            self.assertEqual(r.returncode, 0)
            return json.loads(r.stdout)  # always exactly one JSON answer, with a decision (agy 1.5.5 refuses {})
        PASS = {"decision": "ask"}  # no opinion: agy's own permissions apply
        self.assertEqual(answer("run_command", {"CommandLine": "git push", "Cwd": "/x/shop"})["decision"], "deny")
        self.assertEqual(answer("view_file", {"AbsolutePath": "/x/shop/.env"})["decision"], "deny")
        self.assertEqual(answer("replace_file_content", {"TargetFile": "src/a.py"}), PASS)  # relative: in the workspace
        self.assertEqual(answer("run_command", {"CommandLine": "ls"}), PASS)
        self.assertEqual(answer("browser_subagent", {"Task": "x"}), PASS)
        self.assertEqual(answer("write_to_file", {"TargetFile": "/x/other/a.py"}, env={}), PASS)  # no office

    def test_real_home_from_an_agy_profile(self):
        code = "import office_rules as R; print(R.HOME, R.ROOT)"
        run = lambda home: subprocess.run([sys.executable, "-c", code], cwd=self.bin, env={"HOME": home, "PATH": os.environ["PATH"]},
                                          capture_output=True, text=True).stdout.split()
        self.assertEqual(run("/home/u/.agy_profiles/acc5"), ["/home/u", "/home/u/.agy_profiles"])
        self.assertEqual(run("/home/u"), ["/home/u", "/home/u/.agy_profiles"])

    def test_boss_of_an_office_found_by_its_claude_pid(self):
        template = json.dumps({"offices": [dict(self.team["offices"][0], boss={"kind": "claude", "pid": "__PID__", "name": "Raul", "account": ".claude"})]}).replace('"__PID__"', "__PID__")
        e = {"TEAM_TEMPLATE": template}
        out = subprocess.run([os.path.join(self.bin, "claude"), os.path.join(self.bin, "rules-hook"), "boss"],
                             env=dict({k: v for k, v in os.environ.items() if not k.startswith("AGY_")}, HABBLAUD_AGY_PROFILES=self.root, HOME="/home/u", **e),
                             capture_output=True, text=True, timeout=10).stdout
        b = json.loads(out)
        self.assertEqual((b["office"], b["name"], b["rev"]), ("o1", "Shop", 0))
        self.assertIn("agy-ask rules propose", b["text"])
        self.assertIn("Your workers: acc1.", b["text"])
        self.assertIn("skill agy-orchestrator", b["text"])
        self.assertIn("you may also edit outside it", b["text"])
        # the boss's own tool calls (no AGY_OFFICE): found by the same ancestry; the office folder limits workers only
        self.assertIsNone(self.hook("Edit", {"file_path": "/x/other/a.py"}, env=e, via="claude")[0])
        self.assertIsNone(self.hook("Write", {"file_path": "~/.claude/projects/-home-u/memory/note.md"}, env=e, via="claude")[0])
        self.assertIsNone(self.hook("Bash", {"command": "rm /x/other/f"}, env=e, via="claude")[0])
        self.assertEqual(self.hook("Edit", {"file_path": "~/.ssh/config"}, env=e, via="claude")[0]["permissionDecision"], "deny")
        self.assertEqual(self.hook("Edit", {"file_path": "/x/other/a.py"}, env={}, args=())[0], None)
        self.assertEqual(subprocess.run([os.path.join(self.bin, "rules-hook"), "boss"], env=dict(os.environ, HABBLAUD_AGY_PROFILES=self.root),
                                        capture_output=True, text=True).stdout.strip(), "{}")

    def test_a_worker_is_refused_where_a_boss_may_edit(self):
        self.denied("Write", {"file_path": "~/.claude/projects/-home-u/memory/note.md"})
        self.denied("Bash", {"command": "rm /x/other/f"})

    def test_a_shell_command_cannot_write_outside_the_office(self):
        for cmd in ("cp a /etc/x", "echo hi > /x/other/a", "cd /x/other && rm f", "sed -i s/a/b/ /etc/f"):
            self.assertIn("edited only inside", self.denied("Bash", {"command": cmd}), cmd)
        self.assertIn("may not be read or edited", self.denied("Bash", {"command": "echo k > ~/.ssh/config"}))
        for cmd in ("echo hi > /x/shop/out.txt", "cd /x/shop && rm old.txt", "echo hi > /tmp/job.txt", "cat /etc/hosts", "ls 2>/dev/null"):
            self.assertIsNone(self.hook("Bash", {"command": cmd})[0], cmd)

    def test_boss_is_told_about_clones_and_workers_on_its_own_account(self):
        office = dict(self.team["offices"][0], workers=["acc1", "acc1#2", "claude:.claude#2"],
                      boss={"kind": "claude", "pid": "__PID__", "name": "Raul", "account": ".claude"})
        template = json.dumps({"offices": [office]}).replace('"__PID__"', "__PID__")
        out = subprocess.run([os.path.join(self.bin, "claude"), os.path.join(self.bin, "rules-hook"), "boss"],
                             env=dict({k: v for k, v in os.environ.items() if not k.startswith("AGY_")}, HABBLAUD_AGY_PROFILES=self.root, HOME="/home/u", TEAM_TEMPLATE=template),
                             capture_output=True, text=True, timeout=10).stdout
        text = json.loads(out)["text"]
        self.assertIn("Your workers: acc1, acc1#2, claude:.claude#2.", text)
        self.assertIn("one more session of that account", text)
        self.assertIn("saves your context, not the account's quota", text)

    def test_a_boss_with_no_workers_is_not_told_about_them(self):
        template = json.dumps({"offices": [dict(self.team["offices"][0], workers=[], boss={"kind": "claude", "pid": "__PID__", "name": "Raul", "account": ".claude"})]}).replace('"__PID__"', "__PID__")
        out = subprocess.run([os.path.join(self.bin, "claude"), os.path.join(self.bin, "rules-hook"), "boss"],
                             env=dict({k: v for k, v in os.environ.items() if not k.startswith("AGY_")}, HABBLAUD_AGY_PROFILES=self.root, HOME="/home/u", TEAM_TEMPLATE=template),
                             capture_output=True, text=True, timeout=10).stdout
        self.assertNotIn("Your workers", json.loads(out)["text"])

    def test_boss_is_told_when_the_folder_has_no_handoff(self):
        folder = tempfile.mkdtemp(dir=self.tmp)
        office = dict(self.team["offices"][0], folder=folder, boss={"kind": "claude", "pid": "__PID__", "name": "Raul", "account": ".claude"})
        template = json.dumps({"offices": [office]}).replace('"__PID__"', "__PID__")

        def text():
            out = subprocess.run([os.path.join(self.bin, "claude"), os.path.join(self.bin, "rules-hook"), "boss"],
                                 env=dict({k: v for k, v in os.environ.items() if not k.startswith("AGY_")}, HABBLAUD_AGY_PROFILES=self.root, HOME="/home/u", TEAM_TEMPLATE=template),
                                 capture_output=True, text=True, timeout=10).stdout
            return json.loads(out)["text"]

        self.assertIn("no HANDOFF*.md yet", text())
        self.assertIn("Your workers: acc1.", text())
        self.assertIn("one item at a time", text())
        with open(os.path.join(folder, "handoff_v2.md"), "w") as f:
            f.write("# Next steps\n")
        self.assertNotIn("HANDOFF*.md", text())
        self.assertIn("one item at a time", text())


if __name__ == "__main__":
    unittest.main(verbosity=1)
