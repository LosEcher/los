export async function postTaskCompletion(input: {
  gatewayUrl: string;
  taskToken: string;
  taskRunId: string;
  status: 'succeeded' | 'failed' | 'blocked';
  error?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  try {
    const res = await (input.fetchImpl ?? fetch)(
      `${input.gatewayUrl.replace(/\/+$/, '')}/tasks/${encodeURIComponent(input.taskRunId)}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-los-task-token': input.taskToken },
        body: JSON.stringify({ status: input.status, ...(input.error ? { error: input.error } : {}) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
