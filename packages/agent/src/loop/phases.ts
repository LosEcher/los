import type { Message, ToolDef } from '../providers/index.js';
import type { AgentResult } from './types.js';
import type { ModelSettings } from '../model-settings.js';
import { readRunContractMetadata } from '../run-contract.js';

interface PreExecutionDeps {
  provider: { chat: Function; name: string };
  emitEvent: Function;
  messages: Message[];
  toolDefs: ToolDef[];
  signal: AbortSignal | undefined;
  toolMode: string;
  modelSettings: ModelSettings | undefined;
}

/**
 * Runs optional B1 pre-execution discovery and planning phases.
 * Returns an early AgentResult if the phase produces a terminal result,
 * or null if execution should proceed to the main loop.
 */
export async function runPreExecutionPhases(
  runContractMetadata: Record<string, unknown>,
  deps: PreExecutionDeps,
): Promise<AgentResult | null> {
  const runContract = readRunContractMetadata(runContractMetadata);

  if (runContract?.phase === 'discovering' && deps.toolMode === 'read-only') {
    await deps.emitEvent({ type: 'run.discovery_started', payload: { phase: 'discovering' } });
    const discoveryMessages = [
      ...deps.messages,
      {
        role: 'user' as const,
        content: [
          'You are in DISCOVERY phase. Your task is to inspect the workspace and produce a structured discovery report.',
          'Use read-only tools to:',
          '1. List the top-level directory structure',
          '2. Identify key entry points (package.json, main source files, config files)',
          '3. Identify the tech stack (language, framework, dependencies)',
          '4. Identify existing architecture patterns (modules, packages, contracts)',
          'Do NOT make any changes. Do NOT produce a plan. Just report what you find.',
          'When done, output a structured summary with sections: workspace structure, tech stack, architecture patterns, notable findings.',
        ].join('\n'),
      },
    ];
    const discoveryRes = await deps.provider.chat(discoveryMessages, deps.toolDefs.length > 0 ? deps.toolDefs : undefined, { signal: deps.signal, modelSettings: deps.modelSettings });
    await deps.emitEvent({
      type: 'run.discovery_report',
      payload: { text: discoveryRes.text, textLength: discoveryRes.text.length },
    });
    deps.messages.push({ role: 'assistant', content: discoveryRes.text });
    await deps.emitEvent({ type: 'run.discovery_completed', payload: { phase: 'discovery_ready' } });

    // Discovery phase is not terminal — fall through to main loop
  }

  if (runContract?.phase === 'planning') {
    await deps.emitEvent({ type: 'run.planning_started', payload: { phase: 'planning' } });
    const planMessages = [
      ...deps.messages,
      {
        role: 'user' as const,
        content: [
          'You are in PLANNING phase. Based on what you know about the workspace, produce a structured execution plan.',
          'The plan should have clear steps, each with:',
          '1. A title and description',
          '2. Which files will be touched',
          '3. What the completion criterion is',
          'Do NOT execute any steps. Just produce the plan.',
          'Expected plan steps should map to the required checks and stop conditions defined in the run contract.',
        ].join('\n'),
      },
    ];
    const planRes = await deps.provider.chat(planMessages, deps.toolDefs.length > 0 ? deps.toolDefs : undefined, { signal: deps.signal, modelSettings: deps.modelSettings });
    await deps.emitEvent({
      type: 'run.plan_produced',
      payload: { text: planRes.text, textLength: planRes.text.length },
    });
    deps.messages.push({ role: 'assistant', content: planRes.text });
    await deps.emitEvent({ type: 'run.planning_completed', payload: { phase: 'plan_ready' } });
    // After plan is produced, execution requires operator to approve via plan_approved transition (B0 enforcement)
    return {
      text: planRes.text,
      turns: [],
      loopCount: 0,
      totalTokens: { prompt: planRes.usage.promptTokens, completion: planRes.usage.completionTokens },
      messages: deps.messages,
    };
  }

  return null;
}
