"""Office rules ("Nội quy") for agy-ask / claude-ask and rules-hook: a Python port of Habblaud's shared/rules.ts.

One set of rules per office, in that office's record of ~/.agy_profiles/team.json (`rules`; absent = the defaults):
scope {write, deny, commands}, items [{id, text, for, on}], limits {maxJobs?, quotaStop?}, proposals [], rev. The
checks are pure and must give the same results as the TypeScript: tests/rules.vectors.json is a copy of Habblaud's
shared/rules.vectors.json and both test suites run its cases. Keep the two in step when either changes.

Installed next to agy-ask and rules-hook in ~/.local/bin (both import it from their own folder).
"""
import json, math, os, re, time

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


def rules_text(office, rules, who):
    """The rules as the agent reads them (top of a worker's job; the boss's session). Short on purpose."""
    out = [f'Office rules of "{office.get("name")}" (set by the user; they win over the task):']
    folder = office.get("folder") or ""
    if folder:
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
