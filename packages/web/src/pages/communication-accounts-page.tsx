import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { getJson, postJson } from '../api';
import { Badge, Button, StatusPill, EmptyText } from '../ui.js';
import { useI18n } from '../i18n';

// ── Types ──────────────────────────────────────────────────────────

type WeixinChannelStatus =
  | 'unbound'
  | 'daemon_down'
  | 'credentials_only'
  | 'bot_unreachable'
  | 'send_degraded'
  | 'delivery_ready'
  | 'planned'
  | 'live'
  | string;

interface ChannelInfo {
  id: string;
  label: string;
  status: WeixinChannelStatus;
  description: string;
  accountCount: number;
  live: boolean;
}

interface WeixinAccount {
  accountId: string;
  userId?: string;
  hasToken: boolean;
  hasSyncState: boolean;
  savedAt?: string;
  source: string;
  aliases?: string[];
}

interface DeliveryInfo {
  status: WeixinChannelStatus;
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
  assessedAt?: string;
  layers: {
    credentials: string;
    daemon: string;
    bot: string;
    send: string;
  };
}

interface QRSession {
  sessionId: string;
  status: string;
  qrUrl?: string;
  qrData?: string;
  pid?: number;
  lastReason?: string;
  runtimeActive: boolean;
}

interface CommunicationAccountsResponse {
  channels: ChannelInfo[];
  weixin: {
    accounts: WeixinAccount[];
    weclawInstalled: boolean;
    weclawBinary: string | null;
    delivery?: DeliveryInfo;
  };
}

function statusTone(status: string): 'ok' | 'warn' | 'err' | 'muted' {
  switch (status) {
    case 'delivery_ready':
    case 'live':
    case 'ok':
      return 'ok';
    case 'credentials_only':
    case 'bot_unreachable':
    case 'partial':
      return 'warn';
    case 'send_degraded':
    case 'daemon_down':
    case 'failed':
      return 'err';
    default:
      return 'muted';
  }
}

function layerTone(layer: string): 'ok' | 'warn' | 'err' | 'muted' {
  if (layer === 'ok') return 'ok';
  if (layer === 'failed') return 'err';
  if (layer === 'missing') return 'muted';
  return 'warn';
}

// ── Component ──────────────────────────────────────────────────────

export function CommunicationAccountsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selectedChannel, setSelectedChannel] = useState('weixin');
  const [qrSession, setQrSession] = useState<QRSession | null>(null);
  const [qrPolling, setQrPolling] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ['communication-accounts'],
    queryFn: () => getJson<CommunicationAccountsResponse>('/communication/accounts'),
    refetchInterval: 10_000,
  });

  const startQr = useMutation({
    mutationFn: () => postJson<{ ok: boolean; session: QRSession }>('/communication/accounts/weclaw/qr/start', {}),
    onSuccess: (data) => {
      setQrSession(data.session);
      if (data.session.status === 'waiting_scan') setQrPolling(true);
    },
  });

  const probeSend = useMutation({
    mutationFn: () => postJson<{ ok: boolean; error?: string; messageId?: string; hint?: string }>(
      '/communication/accounts/weclaw/send',
      { probe: true },
    ),
    onSuccess: (data) => {
      setProbeResult(data.ok
        ? t('ops.commAccounts.probeOk', { id: data.messageId ?? 'ok' })
        : t('ops.commAccounts.probeFail', { error: data.error ?? 'unknown' }));
      queryClient.invalidateQueries({ queryKey: ['communication-accounts'] });
    },
    onError: (err) => {
      setProbeResult(t('ops.commAccounts.probeFail', { error: String(err) }));
    },
  });

  useEffect(() => {
    if (!qrPolling || !qrSession?.sessionId) return;
    const timer = setInterval(async () => {
      try {
        const r = await getJson<{ ok: boolean; session: QRSession }>(
          `/communication/accounts/weclaw/qr/${qrSession.sessionId}`
        );
        setQrSession(r.session);
        if (!r.session.runtimeActive) {
          setQrPolling(false);
          queryClient.invalidateQueries({ queryKey: ['communication-accounts'] });
        }
      } catch { setQrPolling(false); }
    }, 2000);
    return () => clearInterval(timer);
  }, [qrPolling, qrSession?.sessionId, queryClient]);

  const data = accounts.data;
  const channels = data?.channels ?? [];
  const weixinInstalled = data?.weixin?.weclawInstalled ?? false;
  const weixinAccounts = data?.weixin?.accounts ?? [];
  const delivery = data?.weixin?.delivery;
  const weixinChannel = channels.find(c => c.id === 'weixin');
  const headlineStatus = delivery?.status ?? weixinChannel?.status ?? (weixinInstalled ? 'credentials_only' : 'unbound');

  return (
    <section className="panel-grid communication-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('ops.commAccounts.title')}</h2>
            <p>{t('ops.commAccounts.subtitle')}</p>
          </div>
          <StatusPill status={statusTone(headlineStatus) === 'ok' ? 'live' : 'partial'} />
        </div>

        {/* Delivery truth — never merge credentials with send path */}
        <div className="comm-delivery-card" style={{
          marginBottom: 16,
          padding: 14,
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-elevated)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
                {t('ops.commAccounts.deliveryTitle')}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Badge tone={statusTone(headlineStatus)}>
                  {t(`ops.commAccounts.status.${headlineStatus}` as 'ops.commAccounts.status.unbound')}
                </Badge>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {weixinChannel?.description
                    ?? t('ops.commAccounts.deliveryHint')}
                </span>
              </div>
            </div>
            <Button
              onClick={() => { setProbeResult(null); probeSend.mutate(); }}
              disabled={probeSend.isPending || !weixinInstalled}
            >
              {probeSend.isPending ? t('ops.commAccounts.probing') : t('ops.commAccounts.probeButton')}
            </Button>
          </div>

          {delivery ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 8,
              marginTop: 12,
            }}>
              {([
                ['credentials', delivery.layers.credentials],
                ['daemon', delivery.layers.daemon],
                ['bot', delivery.layers.bot],
                ['send', delivery.layers.send],
              ] as const).map(([key, state]) => (
                <div key={key} style={{ fontSize: 11 }}>
                  <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>
                    {t(`ops.commAccounts.layer.${key}`)}
                  </div>
                  <Badge tone={layerTone(state)}>
                    {t(`ops.commAccounts.layerState.${state}` as 'ops.commAccounts.layerState.ok')}
                  </Badge>
                </div>
              ))}
            </div>
          ) : null}

          {delivery?.weclawLastSendError ? (
            <p style={{
              marginTop: 12,
              fontSize: 11,
              color: 'var(--danger, #c44)',
              wordBreak: 'break-word',
            }}>
              {t('ops.commAccounts.lastSendError')}: {delivery.weclawLastSendError}
            </p>
          ) : null}

          {probeResult ? (
            <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)' }}>{probeResult}</p>
          ) : (
            <p style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>
              {t('ops.commAccounts.probeHelp')}
            </p>
          )}
        </div>

        {/* Channel selector */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 10, marginBottom: 16 }}>
          {channels.map(ch => (
            <button
              key={ch.id} type="button"
              className={`channel-card ${selectedChannel === ch.id ? 'active' : ''}`}
              onClick={() => setSelectedChannel(ch.id)}
              style={{
                padding: '14px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                background: selectedChannel === ch.id ? 'var(--panel-elevated)' : 'var(--panel-bg)',
                border: selectedChannel === ch.id ? '1px solid var(--accent)' : '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 13 }}>{ch.label}</strong>
                <Badge tone={ch.id === 'weixin' ? statusTone(ch.status) : (ch.live ? 'ok' : 'muted')}>
                  {ch.id === 'weixin'
                    ? t(`ops.commAccounts.status.${ch.status}` as 'ops.commAccounts.status.unbound')
                    : ch.status}
                </Badge>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>{ch.description}</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>{t('ops.commAccounts.accountsLabel', { count: ch.accountCount })}</div>
            </button>
          ))}
        </div>

        {/* QR Login section */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>{t('ops.commAccounts.qrLoginTitle')}</h3>
            <Badge tone={qrSession?.runtimeActive ? 'ok' : qrSession?.status === 'logged_in' ? 'ok' : 'muted'}>
              {qrSession?.status ?? t('ops.commAccounts.idle')}
            </Badge>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
            {t('ops.commAccounts.qrHelp')}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 20, alignItems: 'start' }}>
            <div style={{ textAlign: 'center' }}>
              {qrSession?.qrUrl ? (
                <div style={{ background: '#fff', padding: 12, borderRadius: 10, display: 'inline-block' }}>
                  <QRCodeSVG value={qrSession.qrUrl} size={180} level="M" />
                  <p style={{ fontSize: 10, color: '#64748b', marginTop: 6 }}>{t('ops.commAccounts.scanWithWeChat')}</p>
                </div>
              ) : (
                <div style={{
                  width: 180, height: 180, background: 'var(--panel-bg)', borderRadius: 10,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '1px dashed var(--border)',
                }}>
                  <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('ops.commAccounts.qrLabel')}</span>
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <Button onClick={() => startQr.mutate()} disabled={startQr.isPending || qrSession?.runtimeActive}>
                  {startQr.isPending ? t('ops.commAccounts.generating') : t('ops.commAccounts.generateQrButton')}
                </Button>
              </div>
            </div>

            <div style={{ fontSize: 12 }}>
              {qrSession?.pid && <div style={{ marginBottom: 4 }}>{t('ops.commAccounts.pidPrefix')}<code>{qrSession.pid}</code></div>}
              {qrSession?.lastReason && <div style={{ marginBottom: 4, color: 'var(--text-dim)' }}>{qrSession.lastReason}</div>}
              {qrSession?.qrUrl && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ marginBottom: 4 }}>{t('ops.commAccounts.directUrlLabel')}</div>
                  <code style={{
                    display: 'block', padding: '6px 8px', background: 'var(--panel-bg)',
                    borderRadius: 6, fontSize: 10, wordBreak: 'break-all', maxWidth: 400,
                  }}>
                    {qrSession.qrUrl}
                  </code>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bound accounts — credential layer only */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>{t('ops.commAccounts.boundAccountsTitle', { count: weixinAccounts.length })}</h3>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
            {t('ops.commAccounts.credentialsNote')}
          </p>

          {weixinAccounts.length === 0 ? (
            <EmptyText text={t('ops.commAccounts.noAccounts')} />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('ops.commAccounts.thAccountId')}</th>
                  <th>{t('ops.commAccounts.thUser')}</th>
                  <th>{t('ops.commAccounts.thToken')}</th>
                  <th>{t('ops.commAccounts.thSync')}</th>
                </tr>
              </thead>
              <tbody>
                {weixinAccounts.map(a => (
                  <tr key={a.accountId}>
                    <td><code style={{ fontSize: 11 }}>{a.accountId.slice(0, 20)}…</code></td>
                    <td style={{ fontSize: 11, color: 'var(--text-dim)' }}>{a.userId ?? '—'}</td>
                    <td><Badge tone={a.hasToken ? 'ok' : 'err'}>{a.hasToken ? t('ops.commAccounts.ok') : t('ops.commAccounts.no')}</Badge></td>
                    <td><Badge tone={a.hasSyncState ? 'ok' : 'warn'}>{a.hasSyncState ? t('ops.commAccounts.ok') : t('ops.commAccounts.no')}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Runtime sidebar */}
      <aside className="panel inspector">
        <div className="panel-head compact"><h2>{t('ops.commAccounts.runtimeTitle')}</h2></div>
        <div className="fact-list">
          <div className="fact">
            <span>WeClaw</span>
            <span>{weixinInstalled ? t('ops.commAccounts.installed') : t('ops.commAccounts.notInstalled')}</span>
          </div>
          <div className="fact">
            <span>{t('ops.commAccounts.runtimeDaemon')}</span>
            <span>{delivery?.daemonRunning ? t('ops.commAccounts.ok') : t('ops.commAccounts.no')}</span>
          </div>
          <div className="fact">
            <span>{t('ops.commAccounts.runtimeBot')}</span>
            <span>{delivery?.botReachable ? t('ops.commAccounts.ok') : t('ops.commAccounts.no')}</span>
          </div>
          <div className="fact">
            <span>{t('ops.commAccounts.runtimeSend')}</span>
            <span>
              {delivery?.weclawSendHealthy === true
                ? t('ops.commAccounts.ok')
                : delivery?.weclawSendHealthy === false
                  ? t('ops.commAccounts.no')
                  : '—'}
            </span>
          </div>
          <div className="fact">
            <span>{t('ops.commAccounts.runtimeAccounts')}</span>
            <span>{weixinAccounts.length}</span>
          </div>
          <div className="fact">
            <span>{t('ops.commAccounts.qrSessionLabel')}</span>
            <span>{qrSession?.status ?? t('ops.commAccounts.idle')}</span>
          </div>
          {delivery?.assessedAt ? (
            <div className="fact">
              <span>{t('ops.commAccounts.assessedAt')}</span>
              <span style={{ fontSize: 10 }}>{new Date(delivery.assessedAt).toLocaleTimeString()}</span>
            </div>
          ) : null}
        </div>
      </aside>
    </section>
  );
}
