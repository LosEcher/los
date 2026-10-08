/**
 * isolation/docker.ts — `docker` 隔离后端。
 *
 * **委托** `sandbox-run`（容器编排属 L3 工具领域，不在 los 重写）。
 * 契约：`contracts/isolation-backend.yaml`。
 *
 * 因此本后端探两件事：VCS 可用性（worktree 是 sandbox-run 的默认后端，也是
 * docker 路径的入口）与 **sandbox-run 是否在 PATH 上**。后者缺失时必须给出
 * **可操作**的原因（装它 / 设 PATH），而不是让调用方看到一个裸 ENOENT。
 */
import type {
  IsolationBackend, IsolationCreateInput, IsolationReleaseInput,
  IsolationRunInput, RawExecutionResult,
} from './types.js';
import { hasVcsDir, which } from './types.js';
import { executeViaSandboxRun } from './sandbox-run.js';

export const dockerBackend: IsolationBackend = {
  id: 'docker',

  async probe({ repository }) {
    const hasGit = hasVcsDir(repository, 'git');
    const hasJj = hasVcsDir(repository, 'jj');
    if (!hasGit && !hasJj) {
      return {
        available: false,
        reason: `no git or jj repository at ${repository} — sandbox-run needs a VCS checkout to isolate from`,
        detail: { repository },
      };
    }
    const bin = await which('sandbox-run');
    if (!bin) {
      return {
        available: false,
        reason: 'sandbox-run not found on PATH — the docker backend is delegated to it; install sandbox-run or set PATH',
        detail: { repository, delegatedTo: 'sandbox-run --backend docker' },
      };
    }
    return {
      available: true,
      detail: { repository, binary: bin, delegatedTo: 'sandbox-run --backend docker' },
    };
  },

  async create(input: IsolationCreateInput) {
    // 委托面**由 sandbox-run 自己管隔离资源**（它建 worktree/jj workspace 并在其中跑）。
    // 所以 los 这一侧不预建目录，只记录"这份隔离资源的机制归谁"。
    // 这与内建后端不同：内建是 los 直接编排 VCS，委托是 los 只记账。
    return {
      path: input.path,
      backendState: {
        delegated: 'sandbox-run',
        backend: 'docker',
        baseRevision: input.baseRevision,
        note: 'isolation resource is created by sandbox-run at execute time; los records identity only',
      },
    };
  },

  async execute(input: IsolationRunInput): Promise<RawExecutionResult> {
    return await executeViaSandboxRun({
      repository: input.repository || input.path,
      command: input.command,
      timeoutMs: input.timeoutMs,
    });
  },

  async capturePatch() {
    // 委托面：隔离资源与其中的改动都由 sandbox-run 管理并在报告里给出
    // （`sandbox.overlaidFiles`）。los 这侧没有可捕获的本地补丁 ⇒ 返回空补丁，
    // 而不是伪造一个。调用方据 backendState.delegated 判断该走哪条证据路径。
    return '';
  },

  async detectPollution() {
    // sandbox-run 自带污染检测（G1 policy）并在报告里给出 sandbox.detail；
    // 那是**它的**结果，已随 execute 的 observed 透传。这里不重复实现，
    // 返回 null 表示"本层未检测"（**不是**"没污染"）。
    return null;
  },

  async release(input: IsolationReleaseInput) {
    // 委托面：sandbox-run 每次执行后自己清理（报告里的 sandbox.cleaned）。
    // los 侧释放只意味着"账本标记释放"，没有需要撤除的外部登记。
    void input;
  },
};
