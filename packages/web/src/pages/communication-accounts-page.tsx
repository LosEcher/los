import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { getJson, postJson } from '../api';
import { Badge, Button, StatusPill, EmptyText } from '../ui.js';
import { useI18n } from '../i18n';

// ── Types ──────────────────────────────────────────────────────────

interface ChannelInfo {
  id: string;
  label: string;
  status: string;
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
  };
}

// ── Component ──────────────────────────────────────────────────────

export function CommunicationAccountsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selectedChannel, setSelectedChannel] = useState('weixin');
  const [qrSession, setQrSession] = useState<QRSession | null>(null);
  const [qrPolling, setQrPolling] = useState(false);

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

  useEffect(() => {
    if (!qrPolling || !qrSession?.sessionId) return;
    const t = setInterval(async () => {
      try {
        const r = await getJson<{ ok: boolean; session: QRSession }>(
          `/communication/accounts/weclaw/qr/${qrSession.sessionId}`
        );
        setQrSession(r.session);
        if (!r.session.runtimeActive) { setQrPolling(false); queryClient.invalidateQueries({ queryKey: ['communication-accounts'] }); }
      } catch { setQrPolling(false); }
    }, 2000);
    return () => clearInterval(t);
  }, [qrPolling, qrSession?.sessionId, queryClient]);

  const data = accounts.data;
  const channels = data?.channels ?? [];
  const weixinInstalled = data?.weixin?.weclawInstalled ?? false;
  const weixinAccounts = data?.weixin?.accounts ?? [];

  return (
    <section className="panel-grid communication-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('ops.commAccounts.title')}</h2>
            <p>{t('ops.commAccounts.subtitle')}</p>
          </div>
          <StatusPill status={weixinInstalled ? 'live' : 'partial'} />
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
                <Badge tone={ch.live ? 'ok' : 'muted'}>{ch.status}</Badge>
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
            {/* QR Code display */}
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

            {/* Status info */}
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

        {/* Bound accounts */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>{t('ops.commAccounts.boundAccountsTitle', { count: weixinAccounts.length })}</h3>
          </div>

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
            <span>{t('ops.commAccounts.runtimeAccounts')}</span>
            <span>{weixinAccounts.length}</span>
          </div>
          <div className="fact">
            <span>{t('ops.commAccounts.qrSessionLabel')}</span>
            <span>{qrSession?.status ?? t('ops.commAccounts.idle')}</span>
          </div>
        </div>
      </aside>
    </section>
  );
}
