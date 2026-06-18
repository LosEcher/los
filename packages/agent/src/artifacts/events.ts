import { appendSessionEvent } from '../session-events.js';
import type { ArtifactRecord } from './types.js';

export async function appendArtifactEvent(type: string, record: ArtifactRecord): Promise<void> {
  if (!record.sessionId) return;
  await appendSessionEvent({
    sessionId: record.sessionId,
    nodeId: record.nodeId,
    requestId: record.requestId,
    traceId: record.traceId,
    type,
    source: 'los',
    payload: {
      artifactId: record.artifactId,
      taskRunId: record.taskRunId ?? null,
      pathPolicy: record.pathPolicy,
      originalPath: record.originalPath ?? null,
      sizeBytes: record.sizeBytes,
      checksum: record.checksum,
      checksumAlgorithm: record.checksumAlgorithm,
      contentType: record.contentType,
      deletedAt: record.deletedAt ?? null,
    },
  });
}
