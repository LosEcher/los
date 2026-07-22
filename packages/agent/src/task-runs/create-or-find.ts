import {
  createTaskRun,
  findActiveTaskRunByDedupeKey,
  type CreateTaskRunInput,
  type TaskRunRecord,
} from '../task-runs.js';

export async function createTaskRunOrFindActive(
  input: CreateTaskRunInput,
): Promise<{ taskRun: TaskRunRecord; created: boolean }> {
  try {
    return { taskRun: await createTaskRun(input), created: true };
  } catch (error) {
    if (!input.dedupeKey || !isUniqueViolation(error)) throw error;
    const existing = await findActiveTaskRunByDedupeKey(input.dedupeKey);
    if (!existing) throw error;
    return { taskRun: existing, created: false };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: string }).code === '23505',
  );
}
