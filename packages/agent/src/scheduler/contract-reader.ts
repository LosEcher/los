import { canMarkSucceeded, readRunContractMetadata, type RunContractMetadata } from '../run-contract.js';
import { loadRunSpec } from '../run-specs.js';
import { listVerificationRecordsForRunSpec } from '../verification-records.js';

export async function readCurrentRunContract(
  runSpecId: string | undefined,
  taskMetadata: Record<string, unknown>,
): Promise<RunContractMetadata | undefined> {
  if (runSpecId) {
    const runSpec = await loadRunSpec(runSpecId).catch(() => null);
    if (runSpec?.runContract) return runSpec.runContract;
  }
  return readRunContractMetadata(taskMetadata);
}

export async function checkVerificationGate(
  runSpecId: string | undefined,
  contract: RunContractMetadata | undefined,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!runSpecId) return { allowed: true };
  let statuses: Array<{ requirementId: string; status: string }> = [];
  try {
    const records = await listVerificationRecordsForRunSpec(runSpecId);
    statuses = records.map((r: { checkName: string; status: string }) => ({ requirementId: r.checkName, status: r.status }));
  } catch {
    // No records yet — allow if no contract verifications defined
  }
  return canMarkSucceeded(contract, statuses);
}
