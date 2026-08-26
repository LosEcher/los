/**
 * @los/redaction 单元测试（node --test + tsx）：
 * 锁住 RedactedString 类型级守卫语义——unwrap 按用途/模式/分类放行、
 * CREDENTIALS 硬底线、字符串变换保持包装、隐式序列化 dev 抛错。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RedactedString,
  allowedPurpose,
  formatRedacted,
  isDataClassification,
  isHardRedacted,
  shouldRedact,
} from './index.js';

const modes = ['off', 'redact', 'enforce'] as const;

test('shouldRedact 矩阵：off 全不脱敏；redact/enforce 对明确分类脱敏、unspecified 不脱敏', () => {
  for (const mode of modes) {
    assert.equal(shouldRedact(mode, 'unspecified'), false, `${mode}/unspecified`);
  }
  for (const classification of ['credentials', 'pii', 'internal'] as const) {
    assert.equal(shouldRedact('off', classification), false, `off/${classification}`);
    assert.equal(shouldRedact('redact', classification), true, `redact/${classification}`);
    assert.equal(shouldRedact('enforce', classification), true, `enforce/${classification}`);
  }
});

test('allowedPurpose：CREDENTIALS 硬底线任何用途不放行（off 模式除外——off 即不设防）', () => {
  assert.equal(isHardRedacted('credentials'), true);
  assert.equal(isHardRedacted('pii'), false);
  // off 模式：全放行
  assert.equal(allowedPurpose('off', 'telemetry', 'credentials'), true);
  // redact/enforce：credentials 永不放行
  for (const mode of ['redact', 'enforce'] as const) {
    assert.equal(allowedPurpose(mode, 'internal', 'credentials'), false, `${mode}/internal/credentials`);
    assert.equal(allowedPurpose(mode, 'telemetry', 'credentials'), false, `${mode}/telemetry/credentials`);
  }
  // redact/enforce：pii 仅 internal 放行
  for (const mode of ['redact', 'enforce'] as const) {
    assert.equal(allowedPurpose(mode, 'internal', 'pii'), true, `${mode}/internal/pii`);
    assert.equal(allowedPurpose(mode, 'telemetry', 'pii'), false, `${mode}/telemetry/pii`);
    assert.equal(allowedPurpose(mode, 'agent-context', 'pii'), false, `${mode}/agent-context/pii`);
    assert.equal(allowedPurpose(mode, 'external-request', 'pii'), false, `${mode}/external-request/pii`);
  }
});

test('unwrap：enforce 越权抛错；redact 越权返回脱敏值；off 全放行', () => {
  const enforce = new RedactedString('secret-value', 'pii', 'user.email', 'enforce');
  const redact = new RedactedString('secret-value', 'pii', 'user.email', 'redact');
  const off = new RedactedString('secret-value', 'pii', 'user.email', 'off');

  // 允许用途返回原文
  assert.equal(enforce.unwrap('internal'), 'secret-value');
  assert.equal(redact.unwrap('internal'), 'secret-value');
  assert.equal(off.unwrap('telemetry'), 'secret-value');

  // enforce 越权抛错
  assert.throws(() => enforce.unwrap('telemetry'), /not allowed/);
  assert.throws(() => enforce.unwrap('agent-context'), /not allowed/);
  // redact 越权返回脱敏值
  assert.equal(redact.unwrap('telemetry'), '[redacted:user.email]');
  assert.equal(redact.unwrap('external-request'), '[redacted:user.email]');
});

test('CREDENTIALS unwrap 即使 internal 也拒绝（enforce/redact）', () => {
  for (const mode of ['redact', 'enforce'] as const) {
    const cred = new RedactedString('sk-abc', 'credentials', 'provider.apiKey', mode);
    assert.throws(() => cred.unwrap('internal'), /denied/, `${mode}/internal`);
    assert.throws(() => cred.unwrap('external-request'), /denied/, `${mode}/external-request`);
  }
});

test('字符串变换保持包装：脱敏不因 trim/slice/replace 丢失', () => {
  const secret = new RedactedString('  sk-abc123  ', 'credentials', 'api.key', 'enforce');
  const trimmed = secret.trim();
  assert.ok(trimmed instanceof RedactedString);
  assert.throws(() => trimmed.unwrap('internal')); // 分类保持 credentials
  const sliced = secret.slice(2, 9);
  assert.ok(sliced instanceof RedactedString);
  assert.equal(sliced.includes('sk-abc'), true); // 查询方法读原文
});

test('隐式序列化：dev 抛错（NODE_ENV !== production），防止脱敏值被悄悄当字符串用', () => {
  const previous = process.env.NODE_ENV;
  const silent = process.env.LOS_REDACTION_SILENT;
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.LOS_REDACTION_SILENT;
    const redacted = new RedactedString('pii-value', 'pii', 'user.name', 'enforce');
    assert.throws(() => String(redacted), /Implicit serialization/);
    assert.throws(() => JSON.stringify(redacted), /Implicit serialization/);
    assert.throws(() => redacted.valueOf(), /Implicit serialization/);
    // 未分类（unspecified）不触发
    const plain = new RedactedString('hello', 'unspecified', 'x', 'enforce');
    assert.equal(String(plain), 'hello');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    if (silent === undefined) delete process.env.LOS_REDACTION_SILENT;
    else process.env.LOS_REDACTION_SILENT = silent;
  }
});

test('隐式序列化：生产（NODE_ENV=production）静默返回脱敏值', () => {
  const previous = process.env.NODE_ENV;
  const silent = process.env.LOS_REDACTION_SILENT;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.LOS_REDACTION_SILENT;
    const redacted = new RedactedString('pii-value', 'pii', 'user.name', 'redact');
    assert.equal(String(redacted), '[redacted:user.name]');
    assert.equal(JSON.stringify(redacted), '"' + '[redacted:user.name]' + '"');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    if (silent === undefined) delete process.env.LOS_REDACTION_SILENT;
    else process.env.LOS_REDACTION_SILENT = silent;
  }
});

test('formatRedacted 与 isDataClassification 工具函数', () => {
  assert.equal(formatRedacted('a.b'), '[redacted:a.b]');
  assert.equal(isDataClassification('credentials'), true);
  assert.equal(isDataClassification('secret'), false);
});
