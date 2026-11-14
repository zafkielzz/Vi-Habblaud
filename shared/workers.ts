// Worker ids (team.json `workers`, agy-ask / claude-ask): an account ("acc2", "claude:<config folder>") or a clone of
// one, "<account>#N" with N >= 2 ("acc2#2", "claude:.claude#3"): one more session of the same account. What belongs to
// the ACCOUNT (its profile or config folder, sign-in, e-mail, usage and quota) goes by the account part; what belongs
// to the SESSION (terminal, queue, BUSY, the job log's `worker`, the character in the office) goes by the whole id.
// The same split as tools/agy/bin/office_rules.py (split_worker): keep the two in step.

/** "#2", "#3"…: session 1 is the plain id, and the number is written without leading zeros. */
const CLONE = /^(.+)#([2-9]|[1-9]\d+)$/;

export interface WorkerParts {
  /** The plain worker id: the account ("acc2", "claude:.claude"). */
  account: string;
  /** The session number: 1 for the plain id, N for the clone "#N". */
  n: number;
}

/** "acc2" -> {account: "acc2", n: 1}; "claude:.claude#3" -> {account: "claude:.claude", n: 3}. */
export function splitWorker(worker: string): WorkerParts {
  const m = CLONE.exec(worker);
  return m ? { account: m[1], n: Number(m[2]) } : { account: worker, n: 1 };
}

/** The account of a worker id ("acc2#2" -> "acc2"). */
export function workerBase(worker: string): string {
  return splitWorker(worker).account;
}

/** The id of a session of an account: the plain id for the first, "<account>#N" after. */
export function cloneId(account: string, n: number): string {
  return n > 1 ? `${account}#${n}` : account;
}

/** " #2" for a clone, "" for the plain id: what tells the sessions of one account apart in a name. */
export function cloneSuffix(worker: string): string {
  const { n } = splitWorker(worker);
  return n > 1 ? ` #${n}` : '';
}

/**
 * The id that adding `account` to these workers gives: the account itself when it is not there yet, else its first
 * free clone. `own`: the boss runs on this account (it is the account's first session), so its workers start at "#2".
 */
export function nextWorkerId(workers: readonly string[], account: string, own = false): string {
  if (!own && !workers.includes(account)) return account;
  for (let n = 2; ; n++) if (!workers.includes(cloneId(account, n))) return cloneId(account, n);
}
