"""Office rules ("Nội quy") for agy-ask / claude-ask and rules-hook: a Python port of Habblaud's shared/rules.ts.

One set of rules per office, in that office's record of ~/.agy_profiles/team.json (`rules`; absent = the defaults):
scope {write, deny, commands}, items [{id, text, for, on}], limits {maxJobs?, quotaStop?}, proposals [], rev. The
checks are pure and must give the same results as the TypeScript: tests/rules.vectors.json is a copy of Habblaud's
shared/rules.vectors.json and both test suites run its cases. Keep the two in step when either changes.

Installed next to agy-ask and rules-hook in ~/.local/bin (both import it from their own folder).
"""
import calendar, fcntl, json, math, os, re, shlex, signal, subprocess, time

def real_home():
    """The user's home, also from inside an Antigravity profile (agy-as runs agy, its tools and hooks with
    HOME=~/.agy_profiles/accN)."""
    home = os.path.expanduser("~")
    m = re.match(r"^(.*)/\.agy_profiles/[^/]+/?$", home)
    return m.group(1) if m else home


HOME = real_home()
ROOT = os.environ.get("HABBLAUD_AGY_PROFILES") or f"{HOME}/.agy_profiles"
TEAM = f"{ROOT}/team.json"
VIOLATIONS = f"{ROOT}/rules-log.jsonl"
ENDED = f"{ROOT}/offices-ended.json"  # offices whose boss session ended, kept for its resume
ENDED_MAX = 30

RULES_MAX = {"items": 50, "proposals": 20, "text": 200, "paths": 30, "commands": 30}
FOR = ("all", "boss", "workers")
KINDS = ("deny", "outside", "command", "cwd", "jobs", "quota")
_ID = re.compile(r"^[\w-]{1,24}$", re.ASCII)
_MAX_SAFE = 2 ** 53 - 1


def default_rules():
    return {
        "scope": {"write": [], "deny": ["~/.ssh", "~/.gnupg", ".env", ".env.*"], "commands": ["git push", "sudo"]},
        "items": [{"id": "r1", "text": "Stay inside the task and the scope: if a rule blocks the work, stop and report instead of working around it.", "for": "workers", "on": True}],
        "limits": {"quotaStop": 90},
        "proposals": [],
        "rev": 0,
    }


def _line(x):
    return re.sub(r"\s+", " ", x).strip()[: RULES_MAX["text"]] if isinstance(x, str) else ""


def _strings(x, most):
    if not isinstance(x, list):
        return []
    out = []
    for s in map(_line, x):
        if s and s not in out:
            out.append(s)
    return out[:most]


def _is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _num(x, lo, hi):
    return math.floor(x + 0.5) if _is_num(x) and lo <= x <= hi else None  # Math.round


def parse_rules(raw):
    """The rules of a team.json office record; absent = the defaults, anything malformed is dropped."""
    if isinstance(raw, list):  # an array is an object in JS: nothing in it is read
        raw = {}
    if not isinstance(raw, dict):
        return default_rules()
    s = raw.get("scope") if isinstance(raw.get("scope"), dict) else {}
    lim = raw.get("limits") if isinstance(raw.get("limits"), dict) else {}
    ids = set()

    def uid(x, i, p):
        rid = x if isinstance(x, str) and _ID.match(x) and x not in ids else f"{p}{i + 1}"
        while rid in ids:
            rid += "x"
        ids.add(rid)
        return rid

    def obj(x):
        return x if isinstance(x, dict) else {}

    items = []
    for i, x in enumerate(raw.get("items") if isinstance(raw.get("items"), list) else []):
        x = obj(x)
        items.append({"id": uid(x.get("id"), i, "r"), "text": _line(x.get("text")),
                      "for": x.get("for") if x.get("for") in FOR else "all", "on": x.get("on") is not False})
    items = [x for x in items if x["text"]][: RULES_MAX["items"]]
    proposals = []
    for i, x in enumerate(raw.get("proposals") if isinstance(raw.get("proposals"), list) else []):
        x = obj(x)
        p = {"id": uid(x.get("id"), i, "p"), "text": _line(x.get("text")),
             "for": x.get("for") if x.get("for") in FOR else "all", "by": _line(x.get("by")) or "boss",
             "at": x.get("at") if _is_num(x.get("at")) else 0}
        if _line(x.get("why")):
            p["why"] = _line(x.get("why"))
        proposals.append(p)
    proposals = [x for x in proposals if x["text"]][-RULES_MAX["proposals"]:]
    limits = {}
    if _num(lim.get("maxJobs"), 1, 50):
        limits["maxJobs"] = _num(lim.get("maxJobs"), 1, 50)
    if _num(lim.get("quotaStop"), 1, 100):
        limits["quotaStop"] = _num(lim.get("quotaStop"), 1, 100)
    d = default_rules()["scope"]
    return {
        "scope": {
            "write": [p for p in _strings(s.get("write"), RULES_MAX["paths"]) if p.startswith("/") or p.startswith("~/")],
            "deny": _strings(s["deny"], RULES_MAX["paths"]) if isinstance(s.get("deny"), list) else d["deny"],
            "commands": _strings(s["commands"], RULES_MAX["commands"]) if isinstance(s.get("commands"), list) else d["commands"],
        },
        "items": items,
        "limits": limits,
        "proposals": proposals,
        "rev": _num(raw.get("rev"), 0, _MAX_SAFE) or 0,
    }


def norm_path(path, home):
    """"/a/./b/../c/" -> "/a/c" ("~/" expanded with `home`); '' for a relative path."""
    t = path.strip()
    p = home if t == "~" else f"{home}/{t[2:]}" if t.startswith("~/") else t
    if not p.startswith("/"):
        return ""
    out = []
    for part in p.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if out:
                out.pop()
        else:
            out.append(part)
    return "/" + "/".join(out)


def inside(path, d):
    """Is `path` the folder `d` or inside it (both normalized)?"""
    return d == "/" or path == d or path.startswith(d + "/")


def _glob(pattern, name):
    return re.fullmatch(".*".join(re.escape(x) for x in pattern.split("*")), name) is not None


def check_path(rules, folder, home, path, mode, cwd=None):
    """{ok, kind?, rule?}: may this path be read ('read') or edited ('write') under the office's scope? folder '' = no
    folder (only deny applies). A relative path is taken inside cwd (else the folder)."""
    base = cwd if cwd is not None else folder if folder is not None else "/"
    ab = norm_path(path if path.startswith("/") or path.startswith("~") else f"{base}/{path}", home)
    if not ab:
        return {"ok": True}
    parts = [p for p in ab.split("/") if p]
    for d in rules["scope"]["deny"]:
        hit = inside(ab, norm_path(d, home)) if d.startswith("/") or d.startswith("~/") else any(_glob(d, p) for p in parts)
        if hit:
            return {"ok": False, "kind": "deny", "rule": d}
    if mode == "read" or not folder:
        return {"ok": True}
    dirs = [x for x in (norm_path(d, home) for d in [folder, *rules["scope"]["write"]]) if x]
    return {"ok": True} if any(inside(ab, d) for d in dirs) else {"ok": False, "kind": "outside", "rule": folder}


def command_parts(cmd):
    """The parts of a command line ("a && b | c; d" -> a, b, c, d), each without leading "VAR=x" assignments."""
    parts = (re.sub(r"^(?:[A-Za-z_]\w*=\S* )+", "", re.sub(r"\s+", " ", p).strip()) for p in re.split(r"&&|\|\||[;|\n&]", cmd))
    return [p for p in parts if p]


def check_command(rules, cmd):
    """The forbidden prefix this command line uses, or None. Best effort: `bash -c "..."` or scripts are not opened."""
    parts = command_parts(cmd)
    for c in rules["scope"]["commands"]:
        n = re.sub(r"\s+", " ", c).strip()
        if any(p == n or p.startswith(n + " ") for p in parts):
            return c
    return None


# What a shell command writes, for the scope (Python only: the page never checks commands). Best effort against mistakes:
# a script, `bash -c "..."` or an unknown $VAR is not opened, and scratch space is free (jobs write their output to /tmp).
SCRATCH = ("/tmp", "/var/tmp", "/dev")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n.*?\n\s*\2(?=\n|$)", re.S)
PREFIXES = ("sudo", "env", "command", "nohup", "time", "exec")
EVERY_ARG = ("rm", "rmdir", "unlink", "shred", "mkdir", "touch", "tee", "truncate", "mv")
AFTER_FIRST = ("chmod", "chown", "chgrp")
LAST_ARG = ("cp", "install", "ln", "rsync", "scp")


def _commands(cmd):
    """[(words, redirect targets)] of a command line; ValueError when its quotes do not close."""
    text = HEREDOC.sub(lambda m: m.group(3) + "\n", cmd)
    lex = shlex.shlex(text, posix=True, punctuation_chars=";&|<>()\n")
    lex.whitespace, lex.whitespace_split = " \t\r", True
    out, words, targets, tokens = [], [], [], list(lex)
    i = 0
    while i < len(tokens):
        t = tokens[i]
        i += 1
        if t and set(t) <= set(";&|\n()"):
            out.append((words, targets))
            words, targets = [], []
        elif t and set(t) <= set("<>&|"):
            if words and words[-1].isdigit():
                words.pop()  # the 2 of 2>file
            to = tokens[i] if i < len(tokens) else ""
            i += 1
            if ">" in t and not (t.endswith("&") and re.fullmatch(r"\d+|-", to)):
                targets.append(to)
        else:
            words.append(t)
    out.append((words, targets))
    return out


def _written(words):
    """The arguments of one command that it writes to."""
    while words and (re.match(r"[A-Za-z_]\w*=", words[0]) or words[0] in PREFIXES):
        words = words[1:]
    if not words:
        return []
    name, args = os.path.basename(words[0]), words[1:]
    paths = [a for a in args if not a.startswith("-")]
    if name in EVERY_ARG:
        return paths
    if name in AFTER_FIRST:
        return paths[1:]
    if name in LAST_ARG:
        if "-t" in args and args.index("-t") + 1 < len(args):
            return [args[args.index("-t") + 1]]
        return paths[-1:]
    if name == "dd":
        return [a[3:] for a in args if a.startswith("of=")]
    if name == "sed" and any(a == "--in-place" or re.fullmatch(r"-[a-zA-Z]*i\S*", a) for a in args):
        scripts = {i + 1 for i, a in enumerate(args) if a in ("-e", "-f")}
        files = [a for i, a in enumerate(args) if not a.startswith("-") and i not in scripts]
        return files if scripts else files[1:]
    return []


def command_writes(cmd, cwd, home):
    """The paths outside scratch space a command line writes to, absolute. [] when it cannot be read."""
    def place(path, here):
        path = re.sub(r"^\$(HOME\b|\{HOME\})", "~", path)
        if not path or "$" in path or "`" in path:
            return None
        return norm_path(path if path.startswith(("/", "~")) else f"{here}/{path}", home)

    try:
        commands = _commands(cmd)
    except ValueError:
        return []
    out, here = [], cwd
    for words, targets in commands:
        if words[:1] == ["cd"] and len(words) > 1:
            here = place(words[1], here) or here
            continue
        for path in _written(words) + targets:
            ab = place(path, here)
            if ab and ab not in out and not any(inside(ab, d) for d in SCRATCH):
                out.append(ab)
    return out


def rules_text(office, rules, who):
    """The rules as the agent reads them (top of a worker's job; the boss's session). Short on purpose."""
    out = [f'Office rules of "{office.get("name")}" (set by the user; they win over the task):']
    folder = office.get("folder") or ""
    if folder and who == "boss":
        out.append(f"- Office folder: {folder}. Workers edit only inside {', '.join([folder, *rules['scope']['write']])}; you may also edit outside it.")
    elif folder:
        out.append(f"- Edit files only inside: {', '.join([folder, *rules['scope']['write']])}.")
    if rules["scope"]["deny"]:
        out.append(f"- Never read or edit: {', '.join(rules['scope']['deny'])}.")
    if rules["scope"]["commands"]:
        out.append(f"- Never run: {', '.join(rules['scope']['commands'])}.")
    for r in rules["items"]:
        if r["on"] and r["for"] in ("all", who):
            out.append(f"- {r['text']}")
    if who == "boss":
        if rules["limits"].get("maxJobs"):
            out.append(f"- At most {rules['limits']['maxJobs']} jobs running at once in this office.")
        out.append('- You cannot change these rules. To suggest one: agy-ask rules propose "<rule>" --why "<reason>" (the user decides).')
    return "\n".join(out)


# ------------------------------------------------------------------ team.json and the violation log

def offices():
    """The offices of team.json (a v2 file {boss, workers} is one office "main"), or [] without a file."""
    try:
        with open(TEAM) as f:
            t = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(t, dict):
        return []
    if not isinstance(t.get("offices"), list):
        boss = t.get("boss") if isinstance(t.get("boss"), dict) else None
        return [{"id": "main", "name": "Office", "folder": (boss or {}).get("cwd") or "", "boss": boss, "workers": t.get("workers")}]
    return [o for o in t["offices"] if isinstance(o, dict)]


# ------------------------------------------------------------------ an office lives as long as its boss's session
# An office is work in progress, not stock: when its boss's session ends (closed, killed, machine off) the office leaves
# team.json and is kept in offices-ended.json under the boss's session id; when that session is resumed
# (`claude --resume`), the office comes back as it was (folder, workers, rules) with the new process as boss. Workers
# remember nothing between jobs, so nothing else needs keeping. `tidy` does both; agy-ask, rules-hook (at every prompt
# of a session, via the Habblaud mod) and office-boss call it. Offices with no boss are left to the user (/offices rm).

def read_json(path, default):
    try:
        with open(path) as f:
            v = json.load(f)
        return v if isinstance(v, type(default)) else default
    except (OSError, ValueError):
        return default


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        f.write(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


class team_lock:
    """One writer of team.json at a time among these scripts (the Habblaud server re-reads the file when it changes)."""
    def __enter__(self):
        os.makedirs(ROOT, exist_ok=True)
        self.f = open(f"{ROOT}/.team.lock", "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def load_team():
    """team.json as {"offices": [...]} (a v2 file reads as one office "main"); {"offices": []} without a file."""
    t = read_json(TEAM, {})
    if not isinstance(t.get("offices"), list):
        boss = t.get("boss") if isinstance(t.get("boss"), dict) else None
        t = {"offices": [{"id": "main", "name": "Office", "folder": (boss or {}).get("cwd") or "", "boss": boss,
                          "workers": t.get("workers")}]} if t else {"offices": []}
    t["offices"] = [o for o in t["offices"] if isinstance(o, dict)]
    return t


def proc_start(pid):
    """The start time of a process (clock ticks since boot), or None: tells a reused PID from the boss's."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def proc_comm(pid):
    try:
        with open(f"/proc/{pid}/comm") as f:
            return f.read().strip()
    except OSError:
        return ""


def session_of(pid, account=".claude"):
    """The Claude Code session id a claude process runs now (<config>/sessions/<pid>.json), or None."""
    for d in (f"{HOME}/{account}", os.environ.get("CLAUDE_CONFIG_DIR") or ""):
        if d:
            sid = read_json(f"{d}/sessions/{pid}.json", {}).get("sessionId")
            if isinstance(sid, str) and sid:
                return sid
    return None


def agy_running(acc):
    """Some agy process runs with HOME = this profile (an Antigravity boss is alive)."""
    want = os.path.realpath(f"{ROOT}/{acc}")
    for d in os.listdir("/proc"):
        if d.isdigit() and proc_comm(d) == "agy":
            try:
                env = open(f"/proc/{d}/environ", "rb").read().split(b"\0")
            except OSError:
                continue
            home = next((kv[5:].decode(errors="replace") for kv in env if kv.startswith(b"HOME=")), "")
            if home and os.path.realpath(home) == want:
                return True
    return False


def boss_alive(boss):
    """False when the boss's session has ended; True for a live one, and when it cannot tell (no PID recorded)."""
    if not isinstance(boss, dict):
        return False
    if boss.get("kind") == "agy":
        return agy_running(boss.get("acc") or boss.get("account") or "")
    pid = boss.get("pid")
    if not isinstance(pid, int):
        return True
    if proc_comm(pid) != "claude":
        return False
    start = boss.get("procStart")
    return not isinstance(start, int) or proc_start(pid) == start


def claude_boss(pid, account, name="Boss"):
    """A boss record for the claude process `pid`, with what tells it apart later (session id, process start)."""
    rec = {"kind": "claude", "id": f"{account}:{pid}", "account": account, "pid": pid, "name": name,
           "at": int(time.time() * 1000)}
    sid = session_of(pid, account)
    if sid:
        rec["sessionId"] = sid
    start = proc_start(pid)
    if start is not None:
        rec["procStart"] = start
    return rec


def tidy(claude_pid=None, account=".claude"):
    """Ends the offices whose boss session ended (kept in offices-ended.json by session id) and brings back the office
    of `claude_pid`'s session if it was resumed. Returns notes for the user (what ended, what came back). Never raises."""
    notes = []
    try:
        with team_lock():
            t = load_team()
            ended = read_json(ENDED, {}).get("ended") or []
            ended = [e for e in ended if isinstance(e, dict) and isinstance(e.get("office"), dict)]
            changed = False
            keep = []
            for o in t["offices"]:
                b = o.get("boss")
                if isinstance(b, dict) and not boss_alive(b):
                    sid = b.get("sessionId")
                    if sid:
                        ended = [e for e in ended if e.get("sessionId") != sid]
                        ended.append({"sessionId": sid, "endedAt": int(time.time() * 1000), "office": o})
                    notes.append(f'office "{o.get("name") or o.get("id")}" ended with its boss session')
                    changed = True
                    continue
                if isinstance(b, dict) and b.get("kind") != "agy" and b.get("pid") == claude_pid:
                    sid = session_of(claude_pid, b.get("account") or account)  # /clear and /resume change it
                    if sid and sid != b.get("sessionId"):
                        b["sessionId"] = sid
                        changed = True
                keep.append(o)
            t["offices"] = keep
            if claude_pid and not any((o.get("boss") or {}).get("pid") == claude_pid for o in keep):
                sid = session_of(claude_pid, account)
                hit = next((e for e in ended if sid and e.get("sessionId") == sid), None)
                if hit:
                    ended.remove(hit)
                    o = hit["office"]
                    taken = {x.get("id") for x in keep}
                    if o.get("folder") and any(x.get("folder") == o["folder"] for x in keep):
                        notes.append(f'office "{o.get("name")}" not brought back: another office works in {o["folder"]}')
                    else:
                        base = o.get("id") or "office"
                        o["id"] = next(c for c in [base, *(f"{base}-{i}" for i in range(2, 1000))] if c not in taken)
                        o["boss"] = dict(claude_boss(claude_pid, (o.get("boss") or {}).get("account") or account,
                                                     (o.get("boss") or {}).get("name") or "Boss"))
                        keep.append(o)
                        notes.append(f'office "{o.get("name") or o.get("id")}" is back: this resumed session is its boss again')
                    changed = True
            if changed:
                write_json(TEAM, t)
                write_json(ENDED, {"ended": ended[-ENDED_MAX:]})
    except Exception as e:  # tidying never breaks the caller
        notes.append(f"(could not tidy the offices: {type(e).__name__}: {e})")
    return notes


# ------------------------------------------------------------------ worker usage (quota) from the terminal
# agy's `/usage` is a local slash command (no model call, no tokens): `agy-as accN -p /usage --output-format text`
# prints one TAB line per window, as REMAINING %. The result is kept in <usage dir>/agy:accN.json (the same shape the
# Habblaud mod writes for Claude accounts), so agy-ask can stop at the office's quotaStop without the office running.

USAGE_DIR = (os.environ.get("HABBLAUD_USAGE_DIR") or "~/.habblaud/usage").replace("~", HOME, 1)
USAGE_STALE = 6 * 3600 * 1000  # older than this = unknown


def parse_agy_usage(text, fetched_at):
    """{fetchedAt, five_hour?, seven_day?: {utilization (% used), resets_at (ms)?}} from `/usage`, or None."""
    out = {"fetchedAt": fetched_at}
    for line in text.splitlines():
        p = [x.strip() for x in line.split("\t")]
        if len(p) < 3 or p[0] != "Gemini Models":
            continue
        m = re.match(r"^(\d+(?:\.\d+)?)%$", p[2])
        left = float(m.group(1)) if m else 0.0 if p[2].lower() == "disabled" else None
        if left is None:
            continue
        w = {"utilization": min(100.0, max(0.0, 100.0 - left))}
        if len(p) > 3 and p[3]:
            try:
                w["resets_at"] = calendar.timegm(time.strptime(p[3], "%Y-%m-%dT%H:%M:%SZ")) * 1000
            except ValueError:
                pass
        key = "seven_day" if p[1].lower().startswith("weekly") else "five_hour" if p[1].lower().startswith("five hour") else None
        if key:
            out[key] = w
    return out if "seven_day" in out or "five_hour" in out else None


def fetch_agy_usage(acc, timeout=60):
    """Runs `/usage` for one profile (killed with its group as soon as both windows are in, or at the timeout), keeps
    the result in the usage dir and returns it, or None."""
    try:
        p = subprocess.Popen(["agy-as", acc, "-p", "/usage", "--output-format", "text"], cwd="/tmp",
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=True, text=True)
    except OSError:
        return None
    out, end = "", time.time() + timeout
    try:
        import selectors
        sel = selectors.DefaultSelector()
        sel.register(p.stdout, selectors.EVENT_READ)
        while time.time() < end:
            if not sel.select(timeout=max(0.1, end - time.time())):
                continue
            chunk = os.read(p.stdout.fileno(), 65536).decode("utf8", "replace")
            if not chunk:
                break
            out += chunk
            if "Gemini Models\tWeekly" in out and ("Gemini Models\tFive Hour" in out or "Claude and GPT models\t" in out):
                break
    finally:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
        p.wait()
    u = parse_agy_usage(out, int(time.time() * 1000))
    if u:
        try:
            write_json(f"{USAGE_DIR}/agy:{acc}.json", u)
        except OSError:
            pass
    return u


def usage_file(worker):
    """The kept usage of a worker ("acc1" or "claude:.claude-x"), or None."""
    name = worker[len("claude:"):] if worker.startswith("claude:") else f"agy:{worker}"
    return read_json(f"{USAGE_DIR}/{name}.json", {}) or None


def reset_ms(w):
    """A window's reset time in ms (the Habblaud mod writes seconds, /usage here ms), or None."""
    r = w.get("resets_at") if isinstance(w, dict) else None
    return (r * 1000 if r < 1e12 else r) if isinstance(r, (int, float)) and r > 0 else None


def used_pct(u, now=None):
    """The highest % used of a usage record's windows (a window past its reset counts 0), or None when unknown/stale."""
    now = now or time.time() * 1000
    if not u or now - (u.get("fetchedAt") or 0) > USAGE_STALE and not any(
            (reset_ms(w) or 0) > now for w in (u.get("five_hour"), u.get("seven_day"))):
        return None
    vals = []
    for w in (u.get("five_hour"), u.get("seven_day")):
        if isinstance(w, dict) and isinstance(w.get("utilization"), (int, float)):
            vals.append(0 if (reset_ms(w) or now + 1) <= now else w["utilization"])
    return max(vals) if vals else None


def quota_stop(office):
    return office_rules(office)["limits"].get("quotaStop") or 90


def bench(office_id, worker, why):
    """Takes a worker near its quota out of an office (kept in its "benched" list, so /quota puts it back once its
    quota has reset). Returns True when it was in the office."""
    with team_lock():
        t = load_team()
        o = next((x for x in t["offices"] if x.get("id") == office_id), None)
        if not o or not isinstance(o.get("workers"), list) or worker not in o["workers"]:
            return False
        o["workers"].remove(worker)
        o["benched"] = sorted(set(o.get("benched") or []) | {worker})
        write_json(TEAM, t)
    violation(office_id, worker, "quota", why, "ask")
    return True


def office_by_id(oid):
    return next((o for o in offices() if o.get("id") == oid), None)


def office_rules(office):
    return parse_rules(office.get("rules"))


def violation(office, who, kind, detail, by):
    """Appends one RuleViolation line to rules-log.jsonl (never raises)."""
    entry = {"at": int(time.time() * 1000), "office": office, "who": who, "kind": kind,
             "detail": re.sub(r"\s+", " ", str(detail)).strip()[:200], "by": by}
    try:
        with open(VIOLATIONS, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return entry


if __name__ == "__main__":  # office_rules.py refresh <acc> <office id>: agy-ask after a job, in the background
    import sys
    if sys.argv[1:2] == ["refresh"] and len(sys.argv) == 4:
        _u = fetch_agy_usage(sys.argv[2])
        _o = office_by_id(sys.argv[3])
        _p = used_pct(_u)
        if _o and _p is not None and _p >= quota_stop(_o):
            bench(sys.argv[3], sys.argv[2], f"{sys.argv[2]} at {_p:g}%")

