// Image generator via OpenRouter for Habblaud assets.
//
// Usage (from project root, with OPENROUTER_KEY exported):
//   node scripts/assets/generate.mjs models                 list models with image output
//   node scripts/assets/generate.mjs list                   list assets from specs.json and cache state
//   node scripts/assets/generate.mjs gen [ids...]           generate assets not yet cached in raw/
//        [--force]            regenerate even if cached (previous take moved to .cache/takes/)
//        [--model <id>]       override model defined in specs.json
//        [--as <suffix>]      save as "<id>@<suffix>" (comparisons/extra takes without changing picked)
//        [--concurrency <n>]  concurrent requests (default 3)
//        [--budget <n>]       total requests limit recorded in log (default 45)
//   node scripts/assets/generate.mjs pick <id> <suffix>     select take "<id>@<suffix>" as official raw image
//
// Raw images are saved to scripts/assets/.cache/raw/<id>.png; postprocessing
// (scripts/assets/postprocess.py) generates final files in client/public/assets/.
// Each request is recorded in scripts/assets/generation-log.json (model, prompt, file, cost).
// The key is never printed or saved: it is only passed in the Authorization header.
import { mkdir, readFile, writeFile, copyFile, access, open, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CACHE = join(HERE, '.cache');
const RAW = join(CACHE, 'raw');
const TAKES = join(CACHE, 'takes');
const SPECS = join(HERE, 'specs.json');
const LOG = join(HERE, 'generation-log.json');
// Lock against concurrent runs (each would overwrite the other's log).
const LOCK = join(CACHE, 'generate.lock');
const API = 'https://openrouter.ai/api/v1';
const MAX_RETRIES = 2;
const TIMEOUT_MS = 240_000;

// Arguments: command first, then positional ids and flags (--force, --model <id>...).
const VALUE_FLAGS = new Set(['model', 'as', 'concurrency', 'budget']);
const BOOL_FLAGS = new Set(['force']);

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOL_FLAGS.has(name)) flags[name] = true;
    else if (VALUE_FLAGS.has(name) && rest[i + 1] !== undefined) flags[name] = rest[++i];
    else throw new Error(`unknown option or missing value: ${arg}`);
  }
  return { command, flags, positional };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(2);
}
const { command, flags, positional } = args;
const flagValue = (name, fallback) => flags[name] ?? fallback;
const hasFlag = (name) => flags[name] === true;

const exists = (p) => access(p).then(() => true, () => false);
const rel = (p) => relative(ROOT, p);

async function loadSpecs() {
  return JSON.parse(await readFile(SPECS, 'utf8'));
}

async function loadLog() {
  let text;
  try {
    text = await readFile(LOG, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { budget: 45, entries: [] };
    throw err;
  }
  // Invalid JSON aborts (never restarts the log by mistake)
  return JSON.parse(text);
}

/** Builds final prompt: asset request followed by shared styles it references (specs.styles). */
function buildPrompt(specs, asset) {
  const styles = (asset.styles ?? []).map((key) => {
    const text = specs.styles[key];
    if (!text) throw new Error(`unknown style "${key}" in ${asset.id}`);
    return text;
  });
  return [asset.prompt, ...styles].join('\n\n');
}

function apiKey() {
  const key = process.env.OPENROUTER_KEY;
  if (!key) throw new Error('OPENROUTER_KEY not defined in environment.');
  return key;
}

async function listModels() {
  const res = await fetch(`${API}/models`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET /models -> HTTP ${res.status}`);
  const { data } = await res.json();
  const image = data.filter((m) => (m.architecture?.output_modalities ?? []).includes('image'));
  for (const m of image) {
    const created = new Date(m.created * 1000).toISOString().slice(0, 10);
    const inputs = (m.architecture.input_modalities ?? []).join(',').padEnd(28);
    console.log(`${m.id.padEnd(48)} input: ${inputs} created: ${created}`);
  }
  console.log(`\n${image.length} models with image output (of ${data.length}).`);
}

/** One generation request. Throws error with short message (no sensitive data) on failure. */
async function requestImage(model, prompt, aspect) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    modalities: ['image', 'text'],
    usage: { include: true },
  };
  if (aspect) body.image_config = { aspect_ratio: aspect };
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      'X-Title': 'Habblaud assets',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: non-JSON response`);
  }
  if (!res.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(String(msg).slice(0, 300));
  }
  const message = json.choices?.[0]?.message;
  const url = message?.images?.[0]?.image_url?.url;
  if (!url?.startsWith('data:image/')) {
    throw new Error(`no image in response (text: ${String(message?.content ?? '').slice(0, 120)})`);
  }
  const b64 = url.slice(url.indexOf(',') + 1);
  return {
    bytes: Buffer.from(b64, 'base64'),
    mime: url.slice(5, url.indexOf(';')),
    cost: json.usage?.cost,
    provider: json.provider,
  };
}

/** Runs tasks with concurrency limit. */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

async function generate() {
  const specs = await loadSpecs();
  const log = await loadLog();
  const budget = Number(flagValue('budget', log.budget ?? 45));
  const force = hasFlag('force');
  const modelOverride = flagValue('model', null);
  const suffix = flagValue('as', null);
  const concurrency = Number(flagValue('concurrency', 3));
  const wanted = positional;

  const assets = specs.assets.filter((a) => a.prompt && (wanted.length === 0 || wanted.includes(a.id)));
  const unknown = wanted.filter((id) => !specs.assets.some((a) => a.id === id));
  if (unknown.length) throw new Error(`unknown ids: ${unknown.join(', ')}`);

  const todo = [];
  for (const asset of assets) {
    const key = suffix ? `${asset.id}@${suffix}` : asset.id;
    const out = join(RAW, `${key}.png`);
    if (!force && (await exists(out))) continue;
    todo.push({ asset, key, out });
  }
  if (!todo.length) {
    console.log('Nothing to generate (everything cached). Use --force to regenerate.');
    return;
  }

  await mkdir(RAW, { recursive: true });
  await mkdir(TAKES, { recursive: true });
  const lock = await open(LOCK, 'wx').catch(() => {
    throw new Error(`another generation in progress (${rel(LOCK)}); use --concurrency instead of parallel processes.`);
  });
  try {
    await runJobs(specs, log, todo, { budget, modelOverride, concurrency });
  } finally {
    await lock.close();
    await rm(LOCK, { force: true });
  }
}

async function runJobs(specs, log, todo, { budget, modelOverride, concurrency }) {
  let used = log.entries.length;
  let saving = Promise.resolve();
  const persist = () => {
    saving = saving.then(() => writeFile(LOG, `${JSON.stringify({ ...log, budget }, null, 2)}\n`));
    return saving;
  };

  await pool(todo, concurrency, async ({ asset, key, out }) => {
    const model = modelOverride ?? asset.model ?? specs.defaultModel;
    const prompt = buildPrompt(specs, asset);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (used >= budget) {
        console.error(`[${key}] budget exhausted (${used}/${budget} requests).`);
        return;
      }
      used++;
      const started = Date.now();
      const entry = {
        n: log.entries.length + 1,
        at: new Date().toISOString(),
        id: key,
        model,
        aspect: asset.aspect ?? null,
        prompt,
      };
      log.entries.push(entry);
      try {
        const img = await requestImage(model, prompt, asset.aspect);
        const stamp = entry.at.replace(/[:.]/g, '-');
        const take = join(TAKES, `${key}--${stamp}.png`);
        await writeFile(take, img.bytes);
        await copyFile(take, out);
        Object.assign(entry, {
          status: 'ok',
          file: rel(out),
          take: rel(take),
          mime: img.mime,
          provider: img.provider ?? null,
          cost: img.cost ?? null,
          ms: Date.now() - started,
        });
        console.log(`[${key}] ok in ${((Date.now() - started) / 1000).toFixed(1)}s (${model}) -> ${rel(out)}`);
        await persist();
        return;
      } catch (err) {
        Object.assign(entry, { status: 'error', error: String(err.message ?? err), ms: Date.now() - started });
        console.error(`[${key}] attempt ${attempt + 1} failed: ${entry.error}`);
        await persist();
      }
    }
  });
  await saving;
  const spent = log.entries.reduce((s, e) => s + (typeof e.cost === 'number' ? e.cost : 0), 0);
  console.log(
    `\nRecorded requests: ${log.entries.length}/${budget}. Reported cumulative cost: US$ ${spent.toFixed(4)}.`
  );
}

/** Copies raw/<id>@<suffix>.png to raw/<id>.png and records choice in log.picks. */
async function pick() {
  const [id, suffix] = positional;
  if (!id || !suffix) throw new Error('usage: pick <id> <suffix>');
  const specs = await loadSpecs();
  if (!specs.assets.some((a) => a.id === id)) throw new Error(`unknown id: ${id}`);
  const from = join(RAW, `${id}@${suffix}.png`);
  if (!(await exists(from))) throw new Error(`take does not exist: ${rel(from)}`);
  await copyFile(from, join(RAW, `${id}.png`));
  const log = await loadLog();
  const take = log.entries.findLast((e) => e.id === `${id}@${suffix}` && e.status === 'ok');
  log.picks = { ...log.picks, [id]: { take: `${id}@${suffix}`, model: take?.model ?? null, entry: take?.n ?? null } };
  await writeFile(LOG, `${JSON.stringify(log, null, 2)}\n`);
  console.log(`[${id}] chosen take: ${id}@${suffix} (${take?.model ?? 'unknown model'})`);
}

async function list() {
  const specs = await loadSpecs();
  for (const a of specs.assets) {
    const cached = a.prompt ? ((await exists(join(RAW, `${a.id}.png`))) ? 'cached' : 'pending') : 'no AI';
    console.log(`${a.id.padEnd(26)} ${cached.padEnd(9)} ${a.model ?? specs.defaultModel}`);
  }
}

const commands = { models: listModels, gen: generate, list, pick };
const run = commands[command];
if (!run) {
  console.log(
    'Commands: models | list | gen [ids...] [--force] [--model id] [--as suffix]' +
    ' [--concurrency n] [--budget n] | pick <id> <suffix>'
  );
  process.exit(command === 'help' ? 0 : 2);
}
run().catch((err) => {
  console.error(`error: ${err.message ?? err}`);
  process.exit(1);
});
