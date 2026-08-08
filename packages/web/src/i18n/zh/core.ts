import type { enCore } from '../en/core';

type CoreKeys = { [K in keyof typeof enCore]: string };

export const zhCore: CoreKeys = {
  // ── Brand / shell ────────────────────────────────────
  'nav.brandSubtitle': '日常 Agent 工作台',
  'nav.primaryAria': '主导航',
  'nav.workspace': '工作区',
  'nav.section.daily': '日常',
  'nav.section.library': '资料库',
  'nav.section.advanced': '高级',
  'nav.section.communication': '通讯',
  'nav.section.configure': '配置',
  'nav.section.operations': '运维 · 排障',
  'nav.onboarding': '新手引导',
  'nav.inbox': '收件箱',
  'nav.work': '工作台',
  'nav.schedules': '定时任务',
  'nav.chat': '对话',
  'nav.sessions': '会话',
  'nav.todos': '待办（兼容）',
  'nav.memory': '记忆',
  'nav.artifacts': '产物',
  'nav.communicationAccounts': '通讯账号',
  'nav.setup': '设置向导',
  'nav.providers': '模型供应商',
  'nav.skills': '技能',
  'nav.rules': '规则',
  'nav.mcp': 'MCP',
  'nav.settings': '设置',
  'nav.tasks': '任务运行',
  'nav.evals': '评测',
  'nav.pairwise': '对比评测',
  'nav.runSpecs': '运行规格',
  'nav.nodes': '节点',
  'nav.services': '服务',
  'nav.logs': '日志',
  'nav.dlq': 'DLQ',
  'nav.diagnostics': '诊断',
  'nav.fileSync': '文件同步',

  // ── Sidebar footer / health ──────────────────────────
  'nav.gateway': '网关',
  'nav.signOut': '退出登录',
  'common.checking': '检测中',
  'common.unknown': '未知',
  'common.ok': '正常',
  'common.degraded': '降级',
  'common.down': '不可用',
  'common.localMesh': '本地网格',

  // ── Topbar metrics ───────────────────────────────────
  'nav.metric.health': '健康',
  'nav.metric.uptime': '运行时长',
  'nav.metric.mode': '模式',

  // ── Status pill ──────────────────────────────────────
  'status.live': '可用',
  'status.partial': '部分',
  'status.reserved': '预留',

  // ── Common actions / state ───────────────────────────
  'common.loading': '加载中...',
  'common.refresh': '刷新',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.add': '添加',
  'common.create': '创建',
  'common.delete': '删除',
  'common.edit': '编辑',
  'common.back': '返回',
  'common.enabled': '已启用',
  'common.disabled': '已禁用',
  'common.none': '无',
  'common.never': '从未',
  'nav.languageAria': '语言',
} satisfies CoreKeys;
