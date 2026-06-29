/**
 * CBM shadow-mode measurement helper for chat-service.
 * Extracted to keep chat-service.ts under the 600-line CI gate.
 *
 * When codeGraph.shadowMode is enabled, this measures CBM query
 * performance and symbol resolution accuracy without injecting
 * any results into prompts or observations.
 */

import { CBMClient, appendShadowLog } from '@los/memory';

/**
 * Measure CBM symbol resolution for the current chat prompt.
 * Called asynchronously (fire-and-forget) from runChat().
 * Never throws — failures are recorded in the shadow log.
 */
export async function measureCBMShadow(
  sid: string, runSpecId: string, prompt: string, workspaceRoot?: string,
): Promise<void> {
  const start = Date.now();
  let success = false;
  let symbolCount = 0;
  let error: string | undefined;

  try {
    const cbm = CBMClient.createDefault();
    if (workspaceRoot) cbm.setWorkspaceRoot(workspaceRoot);
    await cbm.connect();

    const targetFiles = extractFilePathsFromPrompt(prompt);

    if (targetFiles.length > 0) {
      const symbols = await cbm.resolveSymbols(targetFiles.map(f => ({ path: f })));
      if (symbols) {
        symbolCount = symbols.length;
        success = true;
      }
    } else {
      success = true; // no target files is a valid baseline
    }

    await cbm.close();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    appendShadowLog({
      timestamp: new Date().toISOString(),
      sessionId: sid,
      runSpecId,
      targetFiles: extractFilePathsFromPrompt(prompt),
      symbolCount,
      latencyMs: Date.now() - start,
      success,
      error,
    });
  }
}

/** Crude file-path extraction from a user prompt. */
function extractFilePathsFromPrompt(prompt: string): string[] {
  const paths: string[] = [];
  const tickRe = /`([a-zA-Z0-9_/.\-]+\.[a-z]{2,4}(:\d+)?)`/g;
  let m: RegExpExecArray | null;
  while ((m = tickRe.exec(prompt)) !== null) {
    paths.push(m[1].replace(/:.*/, ''));
  }
  const bareRe = /\b(packages\/[a-zA-Z0-9_/\-.]+\.[a-z]{2,4})\b/g;
  while ((m = bareRe.exec(prompt)) !== null) {
    if (!paths.includes(m[1])) paths.push(m[1]);
  }
  return paths;
}
