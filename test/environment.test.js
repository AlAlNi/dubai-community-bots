import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectEnvironment } from '../src/environment.js';

test('default is test; environments have separate storage and secret names', async () => {
  const a = await selectEnvironment();
  const b = await selectEnvironment('production');
  assert.equal(a.name, 'test');
  assert.equal(a.branch, 'develop');
  assert.equal(b.branch, 'main');
  assert.notEqual(a.defaultOutput, b.defaultOutput);
  assert.notEqual(a.telegram_chat_id_env, b.telegram_chat_id_env);
  assert.notEqual(a.secret_prefix, b.secret_prefix);
  assert.equal(a.delivery_enabled, false);
  assert.equal(b.delivery_enabled, false);
});
test('unknown environment and production demo are rejected', async () => {
  await assert.rejects(selectEnvironment('prod'), /test или production/);
  await assert.rejects(selectEnvironment('production', true), /Демо/);
});
test('CLI cannot reuse another environment report, even with explicit output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dubai-environment-'));
  const input = join(dir, 'empty.json');
  const output = join(dir, 'report.json');
  const cli = env => spawnSync(process.execPath, ['src/cli.js', '--input', input, '--output', output, '--env', env], { encoding: 'utf8' });
  try {
    await writeFile(input, '[]');
    assert.equal(cli('test').status, 0);
    const before = await readFile(output, 'utf8');
    assert.equal(JSON.parse(before).environment, 'test');
    const result = cli('production');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /другому окружению/);
    assert.equal(await readFile(output, 'utf8'), before);
    assert.equal(cli('test').status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
