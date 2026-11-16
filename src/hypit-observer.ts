import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Read-only scheduling hint for the pinned Hypit revision. The native CLI remains authoritative.
 * Avoid loading a second full CLI while the native daemon and executor already occupy memory.
 */
export async function deferHypitStatus(directory: string, id: string): Promise<boolean> {
  const root = resolve(directory, '.hypit/runtime');
  let worker: { pid: number };
  try { worker = JSON.parse(await readFile(resolve(root, 'worker/worker.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!Number.isSafeInteger(worker.pid) || worker.pid < 1) return false;
  try { process.kill(worker.pid, 0); } catch { return false; }
  const { DatabaseSync } = await import('node:sqlite');
  let database: InstanceType<typeof DatabaseSync>;
  try { database = new DatabaseSync(resolve(root, 'runtime.sqlite'), { readOnly: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  try {
    database.exec('PRAGMA busy_timeout = 1000');
    const row = database.prepare('SELECT attention_step, stop_cause FROM hypit_executions WHERE build_id = ?').get(id);
    return !!row && row.attention_step === null && row.stop_cause === null;
  } finally { database.close(); }
}
