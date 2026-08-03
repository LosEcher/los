import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  getAuthToken,
  getJson,
  getOperatorToken,
  setAuthToken,
  setOperatorToken,
} from './api/index.js';
import { useI18n } from './i18n';

export function AuthBanner() {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [operatorInput, setOperatorInput] = useState('');
  const [saved, setSaved] = useState(false);
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => getJson<{ auth?: { enabled?: boolean } }>('/settings'),
    staleTime: 60_000,
  });
  const authEnabled = settings.data?.auth?.enabled === true;
  const hasToken = Boolean(getAuthToken());
  const hasOperator = Boolean(getOperatorToken());

  if (!authEnabled || (hasToken && hasOperator) || dismissed) return null;

  function saveTokens() {
    if (tokenInput.trim()) setAuthToken(tokenInput.trim());
    if (operatorInput.trim()) setOperatorToken(operatorInput.trim());
    setSaved(true);
    setTimeout(() => setDismissed(true), 800);
  }

  return (
    <div className="auth-banner">
      <span>{t('pages.authBanner.message')}</span>
      {!hasToken ? <input type="password" value={tokenInput} onChange={event => setTokenInput(event.target.value)} placeholder={t('pages.authBanner.tokenPlaceholder')} onKeyDown={event => { if (event.key === 'Enter') saveTokens(); }} /> : null}
      {!hasOperator ? <input type="password" value={operatorInput} onChange={event => setOperatorInput(event.target.value)} placeholder={t('pages.authBanner.operatorPlaceholder')} onKeyDown={event => { if (event.key === 'Enter') saveTokens(); }} /> : null}
      <button type="button" onClick={saveTokens}>{saved ? t('pages.authBanner.saved') : t('common.save')}</button>
      <button type="button" className="auth-dismiss" aria-label={t('pages.authBanner.dismissAria')} onClick={() => setDismissed(true)}>x</button>
    </div>
  );
}
