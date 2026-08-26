/**
 * @los/redaction — 类型级隐私守卫（RedactedString）与脱敏分类学。
 *
 * 入口导出：classification（分类/模式/用途矩阵）+ types（RedactedString）。
 * 用法：
 *   import { RedactedString, DATA_CLASSIFICATIONS } from '@los/redaction';
 *   const key = new RedactedString(rawKey, 'credentials', 'provider.apiKey', mode);
 *   // 出站边界显式取用：
 *   request.headers['authorization'] = `Bearer ${key.unwrap('external-request')}`;
 *   // 禁止隐式序列化（toString/JSON.stringify 会抛错/脱敏）。
 */

export {
  DATA_CLASSIFICATIONS,
  PRIVACY_MODES,
  PRIVACY_CAPABILITIES,
  isDataClassification,
  isPrivacyMode,
  isPrivacyCapability,
  isHardRedacted,
  shouldRedact,
  allowedPurpose,
  formatRedacted,
  type DataClassification,
  type PrivacyMode,
  type PrivacyCapability,
} from './classification.js';

export { RedactedString, type RedactedUnwrapOptions } from './types.js';
