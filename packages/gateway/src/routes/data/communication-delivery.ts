/**
 * Pure delivery-status derivation for communication accounts.
 * Separates credential presence from live WeClaw/iLink send health.
 */

export type DeliveryLayerState = 'ok' | 'failed' | 'unknown' | 'missing';

export type WeixinChannelStatus =
  | 'unbound'
  | 'daemon_down'
  | 'credentials_only'
  | 'bot_unreachable'
  | 'send_degraded'
  | 'delivery_ready';

export type WechatBotHealthSnapshot = {
  ready?: boolean;
  sseConnected?: boolean;
  externalReady?: boolean;
  weclawAvailable?: boolean;
  weclawSendHealthy?: boolean;
  weclawSendFailures?: number;
  weclawLastSendError?: string | null;
  wxpusherConfigured?: boolean;
};

export type DeliveryAssessmentInput = {
  accountCount: number;
  hasTokenAccount: boolean;
  daemonRunning: boolean;
  defaultToConfigured: boolean;
  bot: WechatBotHealthSnapshot | null;
};

export type DeliveryAssessment = {
  status: WeixinChannelStatus;
  statusTone: 'ok' | 'warn' | 'err' | 'muted';
  credentialBound: boolean;
  daemonRunning: boolean;
  botReachable: boolean;
  botReady: boolean;
  sseConnected: boolean;
  weclawAvailable: boolean;
  weclawSendHealthy: boolean | null;
  weclawSendFailures: number | null;
  weclawLastSendError: string | null;
  wxpusherConfigured: boolean;
  externalReady: boolean;
  defaultToConfigured: boolean;
  layers: {
    credentials: DeliveryLayerState;
    daemon: DeliveryLayerState;
    bot: DeliveryLayerState;
    send: DeliveryLayerState;
  };
};

/**
 * Derive operator-facing channel status from layered evidence.
 * Never promote "account file exists" alone to delivery_ready.
 */
export function assessWeixinDelivery(input: DeliveryAssessmentInput): DeliveryAssessment {
  const credentialBound = input.accountCount > 0 && input.hasTokenAccount;
  const bot = input.bot;
  const botReachable = bot !== null;
  const weclawSendHealthy = botReachable
    ? bot.weclawSendHealthy !== false
    : null;
  const layers = {
    credentials: credentialBound
      ? ('ok' as const)
      : input.accountCount > 0
        ? ('failed' as const)
        : ('missing' as const),
    daemon: input.daemonRunning ? ('ok' as const) : ('failed' as const),
    bot: botReachable ? ('ok' as const) : ('unknown' as const),
    send: !botReachable
      ? ('unknown' as const)
      : bot.weclawSendHealthy === false
        ? ('failed' as const)
        : bot.weclawSendHealthy === true
          ? ('ok' as const)
          : ('unknown' as const),
  };

  let status: WeixinChannelStatus;
  if (!credentialBound) {
    status = 'unbound';
  } else if (!input.daemonRunning) {
    status = 'daemon_down';
  } else if (!botReachable) {
    status = 'bot_unreachable';
  } else if (bot?.weclawSendHealthy === false) {
    status = 'send_degraded';
  } else if (bot?.ready === true) {
    // sendHealthy is not false (previous branch); ready bot ⇒ delivery path OK
    status = 'delivery_ready';
  } else {
    // Daemon up + credentials + bot reachable but not fully ready
    // (e.g. SSE down) — do not claim connected delivery.
    status = 'credentials_only';
  }

  return {
    status,
    statusTone: channelStatusTone(status),
    credentialBound,
    daemonRunning: input.daemonRunning,
    botReachable,
    botReady: bot?.ready === true,
    sseConnected: bot?.sseConnected === true,
    weclawAvailable: bot?.weclawAvailable === true || input.daemonRunning,
    weclawSendHealthy,
    weclawSendFailures: botReachable ? Number(bot.weclawSendFailures ?? 0) : null,
    weclawLastSendError: botReachable
      ? (typeof bot.weclawLastSendError === 'string' ? bot.weclawLastSendError : null)
      : null,
    wxpusherConfigured: bot?.wxpusherConfigured === true,
    externalReady: bot?.externalReady === true,
    defaultToConfigured: input.defaultToConfigured,
    layers,
  };
}

function channelStatusTone(status: WeixinChannelStatus): 'ok' | 'warn' | 'err' | 'muted' {
  switch (status) {
    case 'delivery_ready':
      return 'ok';
    case 'credentials_only':
    case 'bot_unreachable':
      return 'warn';
    case 'send_degraded':
    case 'daemon_down':
      return 'err';
    case 'unbound':
    default:
      return 'muted';
  }
}
