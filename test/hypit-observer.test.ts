import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deferHypitStatus } from '../src/hypit-observer.ts';

test('low-memory observation reads active native execution without mutating state or hiding terminal attention', async () => {
  await mkdir('runs', { recursive: true }); const directory = await mkdtemp(resolve('runs/observer-test-'));
  const root = resolve(directory, '.hypit/runtime'); await mkdir(resolve(root, 'worker'), { recursive: true });
  assert.equal(await deferHypitStatus(directory, 'build-1'), false);
  await writeFile(resolve(root, 'worker/worker.json'), JSON.stringify({ pid: process.pid }));
  const db = new DatabaseSync(resolve(root, 'runtime.sqlite'));
  try {
    db.exec('CREATE TABLE hypit_executions (build_id TEXT PRIMARY KEY, attention_step TEXT, stop_cause TEXT)');
    db.exec("INSERT INTO hypit_executions VALUES ('build-1',NULL,NULL)");
    assert.equal(await deferHypitStatus(directory, 'build-1'), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM hypit_executions').get()!.count, 1);
    db.exec("UPDATE hypit_executions SET attention_step='result'");
    assert.equal(await deferHypitStatus(directory, 'build-1'), false);
    db.exec("UPDATE hypit_executions SET attention_step=NULL, stop_cause='execution-failed'");
    assert.equal(await deferHypitStatus(directory, 'build-1'), false);
    db.exec('DELETE FROM hypit_executions');
    assert.equal(await deferHypitStatus(directory, 'build-1'), false);
  } finally { db.close(); }
});
