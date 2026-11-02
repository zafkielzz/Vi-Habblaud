import { describe, expect, it } from 'vitest';
import {
  describeCommand,
  describePrompt,
  describeShellJob,
  describeTool,
  describeWaitingFor,
  looksVietnamese,
  maskSecrets,
  shellWords,
  SPECIAL,
  splitShell,
} from './activity';

describe('describeCommand', () => {
  it('only the first line decides (heredoc does not confuse)', () => {
    expect(describeCommand("cat > /tmp/x/notas.md <<'EOF'\nrun vitest later\nEOF").text).toBe('Writing notas.md');
    expect(describeCommand("cat <<'EOF' > server/README.md\n# x\nEOF").text).toBe('Writing README.md');
    expect(describeCommand("python3 - <<'EOF'\nimport os\nEOF").text).toBe('Running a Python script');
    expect(describeCommand("node -e 'console.log(1)'").text).toBe('Running a Node script');
  });

  it('common commands', () => {
    expect(describeCommand('npx vitest run server').text).toBe('Running tests');
    expect(describeCommand('cd /x && git commit -m "feat"').text).toBe('Committing');
    expect(describeCommand('node scripts/shot.mjs http://x out.png').text).toBe('Running shot.mjs');
    expect(describeCommand('tail -n 20 server.log').text).toBe('Reading server.log');
    expect(describeCommand('tee -a log.txt').text).toBe('Writing log.txt');
  });
});

describe('describeCommand (real cases)', () => {
  const t = (cmd: string, desc?: string) => describeCommand(cmd, desc).text;

  it('first line with actual command; prefixes and assignments do not count', () => {
    expect(t('S=/tmp/x\nnode scripts/shot.mjs x $S/a.png', 'Screenshot real-data UI on port 4763')).toBe('Running shot.mjs');
    expect(t('HABBLAUD_PORT=1 nohup npx tsx server/index.ts --dev > /tmp/s.log 2>&1 &', 'Start real-data server')).toBe('Running index.ts');
    expect(t('set -e\nexport A=1\n# comment\nnpm test')).toBe('Running tests');
    expect(t('sleep 5 && curl -s localhost:4771/')).toBe('Testing the local server (:4771/)');
    expect(t('(cd client && npm test)')).toBe('Running tests');
    expect(t('bash -c "npm run build"')).toBe('Building the project');
    // Command substitution is part of assignment, not a command.
    expect(t('S=/tmp/x; NOW=$(date +%s); echo "{\\"a\\":$((NOW+1))}" | HOME=$S node scripts/statusline-tap.mjs; ls $S')).toBe('Running statusline-tap.mjs');
  });

  it('readers cut off at first |, ; or &&', () => {
    expect(t('sed -n 1,80p rug.ts', 'Read art rug implementation')).toBe('Reading rug.ts');
    expect(t("sed -n '140,700p' server/sources/transcript.ts")).toBe('Reading transcript.ts');
    expect(t('cat a.ts b.ts | head -700')).toBe('Reading a.ts e b.ts');
    expect(t('cat a.ts b.ts c.ts')).toBe('Reading a.ts and 2 more');
    expect(t('head -30 x.ts; ls | head')).toBe('Reading x.ts');
    expect(t("awk '{print $1}' data.csv")).toBe('Reading data.csv');
    expect(t('tail -f /tmp/server.log')).toBe('Following server.log');
    expect(t('wc -l server/*.ts shared/*.ts scripts/*')).toBe('Counting lines in 3 files');
    expect(t('echo "---"; tail -n 20 server.log')).toBe('Reading server.log');
  });

  it('processes, network, search and editing', () => {
    expect(t('pkill -f "vite.*4771"', 'Stop preview')).toBe('Stopping a process');
    expect(t('ps aux | grep vite')).toBe('Checking processes');
    expect(t('lsof -i :4771')).toBe("Checking who's using port 4771");
    expect(t('curl -s localhost:4763/api/snapshot | jq .rev')).toBe('Testing the local API (:4763/api/snapshot)');
    expect(t('curl http://127.0.0.1:4747/api/health')).toBe('Testing the local API (:4747/api/health)');
    expect(t('curl -o out.png -sS https://www.example.com/x.png')).toBe('Calling example.com');
    expect(t('grep "a\\|b" file.ts')).toBe('Searching for “a | b”');
    expect(t('sed -i "" "s/a/b/" src/x.ts')).toBe('Editing x.ts');
    expect(t('echo "oi" > saida.txt')).toBe('Writing saida.txt');
    expect(t('npx tsc --noEmit -p server/tsconfig.json')).toBe('Checking types (TypeScript)');
    expect(t('VITE_PORT=4771 nohup npx vite --config vite.config.ts --strictPort > x.log 2>&1 &')).toBe('Starting the dev server');
    expect(t('git -C /x status --short')).toBe('Checking git status');
    expect(t('npm run docker:up -- --no-build')).toBe('Running script docker:up');
  });

  it('loops: body decides', () => {
    expect(t('for f in a.ts b.ts; do wc -l $f; done')).toBe('Counting lines');
    expect(t('for f in *.ts\ndo\n  cat $f\ndone')).toBe('Reading a file');
  });

  it('description only becomes text in English; otherwise, generic text and description in detail', () => {
    expect(t('ffmpeg -i a.mp4 b.gif', 'Convert video to gif')).toBe('Convert video to gif');
    const vi = describeCommand('ffmpeg -i a.mp4 b.gif', 'Chuyển video sang gif');
    expect(vi.text).toBe('Running ffmpeg');
    expect(vi.detail).toBe('Chuyển video sang gif — ffmpeg -i a.mp4 b.gif');
    expect(t('$(weird) | x')).toBe('Running a command in the terminal');
    expect(looksVietnamese('Count transcripts containing cost-state lines')).toBe(false);
    expect(looksVietnamese('Chạy test của server')).toBe(true);
  });
});

describe('masked secrets', () => {
  it('commands with tokens, passwords and keys', () => {
    const d = describeCommand('curl -sS -H "Authorization: Bearer FAKE_TOKEN_123" https://api.example.com/v1');
    expect(d.text).toBe('Calling api.example.com');
    expect(d.detail).toBe('curl -sS -H "Authorization: ***" https://api.example.com/v1');
    expect(describeCommand('curl -u admin:s3cr3t https://x.com/api').detail).toBe('curl -u admin:*** https://x.com/api');
    expect(describeCommand('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 gh pr list').detail).toBe('GITHUB_TOKEN=*** gh pr list');
    expect(describeCommand('psql "postgres://user:pa55word@db.host:5432/app"').detail).toBe('psql "postgres://user:***@db.host:5432/app"');
    expect(maskSecrets('x sk-ant-api03-abcdefghijklmnop y')).toBe('x sk-*** y');
    expect(maskSecrets('Bearer abcdef123456')).toBe('Bearer ***');
    expect(maskSecrets('curl "https://x.com/?token=abc&x=1" --password hunter2')).toBe('curl "https://x.com/?token=***&x=1" --password ***');
    expect(maskSecrets('{"password": "x", "max_tokens": 100}')).toBe('{"password": "***", "max_tokens": 100}');
    expect(maskSecrets('AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f')).toBe('AKIA*** eyJ***');
    // User prompt with a pasted token.
    expect(describePrompt('use key sk-proj-0123456789abcdef to test').detail).toBe('use key sk-*** to test');
  });

  it('webhooks and npm_/hf_ tokens (secret disappears, host remains)', () => {
    // Assembled in parts: full URL in source triggers GitHub push protection.
    const slack = ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'X'.repeat(24)].join('/');
    expect(maskSecrets(`curl -X POST ${slack}`)).toBe(
      'curl -X POST https://hooks.slack.com/services/***',
    );
    expect(maskSecrets('https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789')).toBe(
      'https://discord.com/api/webhooks/***',
    );
    expect(maskSecrets('https://discordapp.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789')).toBe(
      'https://discordapp.com/api/webhooks/***',
    );
    expect(maskSecrets('curl https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX/sendMessage')).toBe(
      'curl https://api.telegram.org/bot***/sendMessage',
    );
    expect(maskSecrets('use npm_1234567890abcdef1234567890abcdef1234 in ci')).toBe('use npm_*** in ci');
    expect(maskSecrets('loose key hf_abcdefghijklmnopqrstuvwxyz01234567')).toBe('loose key hf_***');
  });

  it('ordinary text with npm or hf is not a secret', () => {
    const s = 'run npm test and npm run build; huggingface hf model uses npm_config_cache';
    expect(maskSecrets(s)).toBe(s);
  });

  it('shell: words and segments', () => {
    expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g ''`)).toEqual(['a', 'b c', 'd "e"', 'f g', '']);
    expect(splitShell('a && b | c; d & e 2>&1 || f "x|y" $(g; h)')).toEqual(['a', 'b', 'c', 'd', 'e 2>&1', 'f "x|y" $(g; h)']);
    expect(shellWords('X=$(date +%s) y `a b` z')).toEqual(['X=$(date +%s)', 'y', '`a b`', 'z']);
  });
});

describe('activities', () => {
  it('TodoWrite ignores non-object items and tolerates tasks without status', () => {
    expect(describeTool('TodoWrite', { todos: [null] })).toEqual({ kind: 'plan', icon: '🗒️', text: 'Updating the task list' });
    expect(describeTool('TodoWrite', {
      todos: [null, undefined, 'invalid', 42, false, { content: 'No status' }, { content: 'Done', status: 'completed' }, { content: 'Pending', status: 'pending' }],
    }).detail).toBe('1/3 done');
  });

  it('tools and specials', () => {
    expect(describeTool('Agent', { description: 'Review code', subagent_type: 'Explore' })).toMatchObject({ kind: 'delegate', text: 'Delegating: Review code' });
    expect(SPECIAL.rejected('Write').text).toBe('You denied: Write');
    expect(SPECIAL.cleared().kind).toBe('compact');
    expect(describeWaitingFor('worker request')).toBe("approve a worker's request");
    expect(describeWaitingFor(undefined)).toBe('answer in the terminal');
  });
});

describe('shells', () => {
  it('job label: description (masked) or command summary; masked command in detail', () => {
    expect(describeShellJob('Bash', { command: 'vendor/bin/phpunit', description: 'Run full test suite in groups with phpunit' })).toEqual({
      label: 'Run full test suite in groups with phpunit',
      command: 'vendor/bin/phpunit',
      kind: 'shell',
    });
    expect(describeShellJob('Bash', { command: 'GITHUB_TOKEN=ghp_0123456789abcdefghij npm run build' })).toEqual({
      label: 'Building the project',
      command: 'GITHUB_TOKEN=*** npm run build',
      kind: 'shell',
    });
    expect(describeShellJob('Bash', { command: 'x', description: 'Deploy with --token abc123def456 in production of a very important service' }).label).toBe(
      'Deploy with --token *** in production of a ve…',
    );
    expect(describeShellJob('Monitor', { description: 'errors in deploy.log', command: 'tail -f deploy.log' })).toMatchObject({ label: 'errors in deploy.log', kind: 'monitor' });
    expect(describeShellJob('Monitor', { ws: { url: 'wss://events.example.com/stream' } })).toEqual({
      label: 'Listening to events.example.com',
      command: 'wss://events.example.com/stream',
      kind: 'monitor',
    });
  });

  it('wait bubble and shell end (markers for world), always up to 46 characters with full duration', () => {
    expect(SPECIAL.waitingShell('Run suite')).toMatchObject({ kind: 'wait', icon: '⏳', text: 'Waiting on shell: Run suite', tool: 'ShellWait' });
    expect(SPECIAL.waitingShell('Build', 3).text).toBe('Waiting on 3 shells: Build');
    expect(SPECIAL.waitingShell(undefined).text).toBe('Waiting on shell');
    const ok = SPECIAL.shellDone('Run full test suite in groups with phpunit', 'ok', 482_000, 'vendor/bin/phpunit');
    expect(ok).toEqual({ kind: 'run', icon: '✅', text: 'Shell finished: Run full test suite… (8min 2s)', detail: 'vendor/bin/phpunit', tool: 'ShellDone' });
    expect(ok.text.length).toBeLessThanOrEqual(46);
    expect(SPECIAL.shellDone('Migration', 'failed')).toEqual({ kind: 'run', icon: '❌', text: 'Shell failed: Migration', tool: 'ShellDone', error: true });
    expect(SPECIAL.shellDone('Migration', 'killed')).toMatchObject({ icon: '🛑', text: 'Shell interrupted: Migration', error: true });
  });
});

describe('AskUserQuestion in the office', () => {
  it('passes complete questions, with options, to the "Needs you" card', () => {
    const d = describeTool('AskUserQuestion', {
      questions: [
        {
          question: 'Which database to use?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Relational, already used in project' },
            { label: 'SQLite' },
          ],
        },
        { question: 'Which tests to run?', multiSelect: true, options: [{ label: 'Unit' }, { label: 'E2E' }] },
      ],
    });
    expect(d).toMatchObject({ kind: 'ask', text: 'Asking you a question', detail: 'Which database to use?' });
    expect(d.questions).toEqual([
      {
        index: 0,
        question: 'Which database to use?',
        header: 'Database',
        options: [
          { index: 0, label: 'Postgres', description: 'Relational, already used in project' },
          { index: 1, label: 'SQLite' },
        ],
      },
      { index: 1, question: 'Which tests to run?', multiSelect: true, options: [{ index: 0, label: 'Unit' }, { index: 1, label: 'E2E' }] },
    ]);
  });

  it('masks secrets and ignores invalid inputs', () => {
    const d = describeTool('AskUserQuestion', {
      questions: [null, { question: '' }, { question: 'Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789?', options: [{ label: '' }, { label: 'Yes' }] }],
    });
    expect(d.questions).toHaveLength(1);
    expect(d.questions![0]!.question).not.toContain('abcdefghijklmnop');
    // Positions match the original (office reply returns through them), with invalid ones counted.
    expect(d.questions![0]!.index).toBe(2);
    expect(d.questions![0]!.options).toEqual([{ index: 1, label: 'Yes' }]);
  });

  it('without valid questions, does not create the field', () => {
    expect(describeTool('AskUserQuestion', {}).questions).toBeUndefined();
  });
});
