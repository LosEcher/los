/**
 * isolation/sandbox-run.ts — `sandbox-run` 的调用契约与执行适配器（C3）。
 *
 * `docker` 后端**委托** sandbox-run（容器编排属 L3 工具领域，不在 los 重写）。
 * 这里也放"如何解析 sandbox-run 的报告"，因为那是**它的**契约。
 *
 * 三条接口纪律见 `./types.ts`；本文件只返回原始结果、不落账。
 */
import { spawn } from 'node:child_process';
import type { RawExecutionResult } from './types.js';
import { which } from './types.js';

/**
 * `sandbox-run` 的 JSON 报告里我们关心的部分。
 *
 * **实测契约（2026-10-08，sandbox-run 0.1.3）**：
 *   命令成功      → `verify.exitCode = 0`，进程退出码 0，verdict "pass"
 *   命令失败      → `verify.exitCode = 7`（**真实码**），进程退出码 **1**，verdict "fail"
 *   变更集为空    → `verify.exitCode = null`，进程退出码 1，verdict "rejected"
 *   工具自身错    → 进程退出码 2
 *
 * 关键：**进程退出码跨情形复用**（fail 与 rejected 都是 1），所以不能拿它当
 * 命令结果；真实结果只在 `verify.exitCode` 里。这正是"后端只返回原始结果"的
 * 意义 —— 适配器必须把真实码取出来交给上层，而不是把进程码当成命令码。
 */
export function parseSandboxRunReport(stdout: string): {
  exitCode: number | null;
  verdict: string | null;
  backend: string | null;
  detail: string | null;
} | null {
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>;
    const verify = (d.verify ?? {}) as Record<string, unknown>;
    const sandbox = (d.sandbox ?? {}) as Record<string, unknown>;
    const code = verify.exitCode;
    return {
      exitCode: typeof code === 'number' ? code : null,
      verdict: typeof d.verdict === 'string' ? d.verdict : null,
      backend: typeof sandbox.backend === 'string' ? sandbox.backend : null,
      detail: typeof sandbox.detail === 'string' ? sandbox.detail : null,
    };
  } catch {
    return null;
  }
}

/**
 * 用 `sandbox-run` 在隔离环境中执行验证（C3：docker 后端**委托**它）。
 *
 * 纪律 1 的体现：返回 `RawExecutionResult`，**不含 verdict**。报告里的 `verdict`
 * 与 `sandbox.backend` 只作为 `observed` 原始事实透传 —— 是否把它当结论，由门禁层
 * 决定（把"判不了"压成"失败"正是 2026-10-08 假红事故的机制）。
 */
/**
 * 本函数的入参形状：委托面只需要"在哪个仓跑什么命令"。
 * **刻意不复用 `IsolationRunInput`** —— 后者的 `path` 是抽象层概念（隔离资源位置），
 * 而 sandbox-run 自己决定隔离资源放哪。两者形状不同是**语义不同**，不是疏漏。
 */
export interface SandboxRunInput {
  repository: string;
  command: string;
  timeoutMs: number;
}

export async function executeViaSandboxRun(input: SandboxRunInput): Promise<RawExecutionResult> {
  const bin = await which('sandbox-run');
  if (!bin) {
    // 环境故障 ⇒ **明示**，不要伪装成"命令失败"。
    return {
      exitCode: null,
      stdout: '',
      stderr: 'sandbox-run not found on PATH — cannot execute the delegated isolation backend',
      durationMs: 0,
      observed: { spawnError: 'sandbox-run-missing' },
    };
  }

  const timeoutSecs = Math.max(1, Math.ceil(input.timeoutMs / 1000));
  const started = Date.now();
  return await new Promise<RawExecutionResult>((resolve) => {
    const child = spawn(
      bin,
      ['--scope-from-git', '--no-log', '--timeout', String(timeoutSecs), '--', '/bin/sh', '-c', input.command],
      { cwd: input.repository, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        exitCode: null, stdout,
        stderr: `${stderr}\nsandbox-run exceeded ${timeoutSecs}s and was killed`,
        durationMs: Date.now() - started, observed: { spawnError: 'timeout' },
      });
    }, input.timeoutMs + 15_000);

    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // spawn 失败（二进制不可执行等）⇒ 环境故障，exitCode 保持 null
      resolve({
        exitCode: null, stdout, stderr: `${stderr}\n${e.message}`,
        durationMs: Date.now() - started, observed: { spawnError: e.message },
      });
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const report = parseSandboxRunReport(stdout);
      resolve({
        // 关键：**不用进程码**当命令结果；命令是否跑过看 report.exitCode
        exitCode: report ? report.exitCode : null,
        stdout, stderr,
        durationMs: Date.now() - started,
        observed: {
          processExitCode: code,               // 原始事实，含 fail/rejected 复用
          sandboxVerdict: report?.verdict ?? null,
          sandboxBackend: report?.backend ?? null,
          sandboxDetail: report?.detail ?? null,
        },
      });
    });
  });
}
