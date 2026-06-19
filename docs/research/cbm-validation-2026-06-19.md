# CBM H1-H3 假设验证报告

日期：2026-06-19
CBM 版本：0.8.1
项目：los（6167 nodes / 14520 edges / 1280ms indexing）

## H1：符号识别率

**方法**：抽样 8 个核心 TypeScript 文件，对比 CBM 检测的导出符号 vs 源文件实际导出符号。

**数据**：

| 文件 | 实际导出 | CBM 检测 | 缺失 | 额外(内部函数) |
|------|:---:|:---:|:---:|:---:|
| store.ts | 15 | 15 | 0 | 5 |
| compaction.ts | 11 | 11 | 0 | 5 |
| loop.ts | 1 | 1 | 0 | 1 |
| chat-service.ts | 4 | 4 | 0 | 6 |
| registry.ts | 3 | 3 | 0 | 8 |
| config.ts | 6 | 6 | 0 | 11 |
| chat-memory-augment.ts | 1 | 1 | 0 | 0 |
| mcp-client.ts | 6 | 6 | 0 | 17 |

**总计**：47/47 导出符号被 CBM 正确识别（100%），额外的 CBM 符号是内部非导出函数（有价值的额外信息）。

**H1：✅ PASS（100% > 80% 门槛）**

## H2：信息密度

**方法**：3 个真实 los 开发场景，对比 CBM 查询 vs grep+read_file 的 token 估算。

| 场景 | CBM tokens | grep tokens | 节省比例 |
|------|:---:|:---:|:---:|
| 查询 addObservation 的调用者 | ~150 | ~15000 | 100x |
| los 项目架构全景 | ~500 | ~5000 | 10x |
| ensureMemoryStore 的变更影响 | ~200 | ~5000 | 25x |

**H2：✅ PASS（3/3 场景，远超 ≥2 通过门槛）**

## H3：符号映射准确率

**方法**：10 个 (file_path, line_number) → 预期符号 测试点。在 CBM 中查询该文件该行包含的符号，验证预期符号是否存在。

**结果**：10/10 全部通过（100%）：
- store.ts:116 → addObservation ✅
- store.ts:311 → getStats ✅
- compaction.ts:146 → compactSession ✅
- loop.ts:49 → runAgent ✅
- chat-service.ts:59 → runChat ✅
- registry.ts:141 → registerBuiltinTools ✅
- config.ts:342 → loadConfig ✅
- chat-memory-augment.ts:29 → augmentChatSystemPrompt ✅
- mcp-client.ts:172 → MCPClient ✅
- mcp-client.ts:328 → MCPToolBridge ✅

**H3：✅ PASS（100% > 70% 门槛）**

## 决策

进入阶段 1：cbm-client + 影子模式测量。
