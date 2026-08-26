/**
 * @los/agent token-limit error classification — 跨 provider 错误消息指纹分类。
 *
 * 借鉴 grok-bot-0.18-reconstructed 的 token-limit-error-classification：
 * 各家 provider（OpenAI/Anthropic/DeepSeek/Moonshot 等）对 token 超限的
 * 措辞不同（"context_length_exceeded" / "prompt is too long" /
 * "input tokens exceed the configured limit" / "request size cannot exceed
 * X bytes" / "exceeded max output tokens" …），统一归一化为两类：
 *  - input_token_limit：输入超模型上下文窗口 —— 换 provider 大概率同样超限，
 *    默认不应触发 fallback（除非目标模型上下文更大）；
 *  - output_token_limit：输出超 max_tokens —— 应降 max_tokens 重试而非换 provider。
 */

const OUTPUT_TOKEN_LIMIT_SUBSTRING = 'exceeded max output tokens';
const CANONICAL_INPUT_TOKEN_LIMIT_MESSAGE = 'input token limit exceeded';

const includesAll = (haystack: string, needles: readonly string[]): boolean =>
  needles.every((needle) => haystack.includes(needle));

/** 已知的输入 token 超限措辞指纹（grok 表 + 常见变体）。 */
function isObservedInputTokenLimitMessage(message: string): boolean {
  return (
    message.includes('input tokens exceed the configured limit') ||
    includesAll(message, ['your messages resulted in', 'tokens', 'configured limit']) ||
    (message.includes('input token count') && message.includes('exceeds the maximum number of tokens allowed')) ||
    includesAll(message, ['input token count', 'exceeds', 'maximum context length']) ||
    includesAll(message, ['maximum prompt length', 'request contains', 'tokens']) ||
    message.includes('prompt is too long') ||
    includesAll(message, ['input', 'token', 'longer than', 'context length']) ||
    includesAll(message, ['input token count', 'plus', 'requested output count', 'exceeds', 'maximum context length']) ||
    includesAll(message, ['input exceeds', 'context window']) ||
    message.includes('input is too long for requested model') ||
    includesAll(message, ['input length', 'exceeds the maximum allowed input length']) ||
    includesAll(message, ['request size cannot exceed', 'bytes', 'please shorten the request']) ||
    includesAll(message, ['input length', 'max_tokens', 'exceed context limit']) ||
    message.includes('input is too long') ||
    message.includes('request size exceeds model context window') ||
    includesAll(message, ['message size', 'bytes', 'exceeds', 'mb limit']) ||
    message.includes('context_length_exceeded') ||
    message.includes('payload too large') ||
    // OpenAI: "This model's maximum context length is X tokens. However, you requested Y tokens …"
    (message.includes('maximum context length') && message.includes('however, you requested') && message.includes('tokens')) ||
    /max tokens of \d+ exceeded/.test(message)
  );
}

export type TokenLimitClass = 'input_token_limit' | 'output_token_limit';

function isOutputTokenLimitErrorMessage(errorMessage: string): boolean {
  return errorMessage.toLowerCase().includes(OUTPUT_TOKEN_LIMIT_SUBSTRING);
}

function isInputTokenLimitErrorMessage(errorMessage: string): boolean {
  return isObservedInputTokenLimitMessage(errorMessage.toLowerCase());
}

/** 分类一条错误消息；无法判定返回 undefined。 */
export function classifyTokenLimitErrorFromMessage(errorMessage: string): TokenLimitClass | undefined {
  const message = errorMessage ?? '';
  if (isOutputTokenLimitErrorMessage(message)) return 'output_token_limit';
  if (isInputTokenLimitErrorMessage(message) || message.toLowerCase().includes(CANONICAL_INPUT_TOKEN_LIMIT_MESSAGE)) {
    return 'input_token_limit';
  }
  return undefined;
}
