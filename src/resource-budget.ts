import { readFile } from 'node:fs/promises';

const mib = 1024 * 1024;
export function memoryBudgetProblem(hostFree: number, containerFree?: number): string | undefined {
  if (!Number.isFinite(hostFree) || hostFree < 256 * mib) return '服务器可用内存不足，暂缓开始视频任务以保护现有项目，请稍后重试';
  if (containerFree !== undefined && (!Number.isFinite(containerFree) || containerFree < 320 * mib)) return '本项目容器内存余量不足，暂缓开始视频任务，请稍后重试';
}

/** Check before analysis and any billable requests; never change another application's limits. */
export async function assertJobMemoryBudget(): Promise<void> {
  if (process.platform !== 'linux' || process.env.AIVIDEO_LOW_MEMORY !== '1') return;
  const info = await readFile('/proc/meminfo', 'utf8');
  const available = Number(/^MemAvailable:\s+(\d+)\s+kB$/m.exec(info)?.[1]) * 1024;
  let containerFree: number | undefined;
  for (const [limitPath, usagePath] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ]) {
    try {
      const [limit, usage] = await Promise.all([readFile(limitPath, 'utf8'), readFile(usagePath, 'utf8')]);
      const maximum = Number(limit.trim());
      if (Number.isFinite(maximum) && maximum < 1024 ** 4) containerFree = maximum - Number(usage.trim());
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const problem = memoryBudgetProblem(available, containerFree);
  if (problem) throw new Error(problem);
}
