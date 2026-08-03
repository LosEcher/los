import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pause, Play, Plus, RefreshCcw, RotateCcw } from 'lucide-react';

import {
  getCurrentProjectId,
  getJson,
  patchJson,
  postJson,
  type CreateScheduledWorkResponse,
  type ScheduledApprovalPolicy,
  type ScheduledCatchUpPolicy,
  type ScheduledConcurrencyPolicy,
  type ScheduledWorkDetailResponse,
  type ScheduledWorkItem,
  type ScheduledWorkListResponse,
  type ScheduledWorkPreviewResponse,
  type ScheduledWorkTemplateId,
  type ScheduledWorkTrigger,
} from '../api/index.js';
import { formatDate } from '../ui.js';
import { useI18n } from '../i18n';

type TriggerPreset = 'daily' | 'weekly' | 'interval' | 'once';
type FormState = {
  title: string;
  projectId: string;
  templateId: ScheduledWorkTemplateId;
  preset: TriggerPreset;
  time: string;
  weekday: string;
  interval: string;
  onceAt: string;
  timezone: string;
  approvalPolicy: ScheduledApprovalPolicy;
  concurrencyPolicy: ScheduledConcurrencyPolicy;
  catchUpPolicy: ScheduledCatchUpPolicy;
  feedAnalysisRequest: string;
  editableSurfaces: string;
  requiredChecks: string;
};

type FeedAnalysisRequestValidation =
  | { value: Record<string, unknown>; error?: never }
  | { value?: never; error: string };

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function SchedulesPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(() => initialForm(t));
  const trigger = useMemo(() => buildTrigger(form), [form]);
  const feedAnalysisRequest = useMemo(
    () => validateFeedAnalysisRequest(form.feedAnalysisRequest, t),
    [form.feedAnalysisRequest, t],
  );
  const list = useQuery({
    queryKey: ['scheduled-work-items'],
    queryFn: () => getJson<ScheduledWorkListResponse>('/scheduled-work-items?limit=100'),
    refetchInterval: 15_000,
  });
  const activeId = selectedId ?? list.data?.results[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ['scheduled-work-item', activeId],
    queryFn: () => getJson<ScheduledWorkDetailResponse>(`/scheduled-work-items/${activeId}`),
    enabled: Boolean(activeId),
    refetchInterval: 10_000,
  });
  const preview = useQuery({
    queryKey: ['scheduled-work-preview', trigger],
    queryFn: () => getJson<ScheduledWorkPreviewResponse>(previewPath(trigger)),
    enabled: showCreate && trigger.expression.length > 0 && trigger.timezone.length > 0,
    retry: false,
  });
  const create = useMutation({
    mutationFn: () => {
      if (form.templateId === 'scheduled_feed_analysis' && !feedAnalysisRequest.value) {
        throw new Error(feedAnalysisRequest.error);
      }
      return postJson<CreateScheduledWorkResponse>('/scheduled-work-items', {
        projectId: form.projectId.trim(), title: form.title.trim(), templateId: form.templateId,
        trigger, approvalPolicy: form.approvalPolicy, concurrencyPolicy: form.concurrencyPolicy,
        catchUpPolicy: form.catchUpPolicy,
        editableSurfaces: form.templateId === 'scheduled_execution'
          ? form.editableSurfaces.split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        requiredChecks: form.templateId === 'scheduled_execution'
          ? form.requiredChecks.split(',').map(s => s.trim()).filter(Boolean)
          : undefined,
        feedAnalysisRequest: form.templateId === 'scheduled_feed_analysis'
          ? feedAnalysisRequest.value
          : undefined,
      });
    },
    onSuccess: async result => {
      setSelectedId(result.schedule.id);
      setShowCreate(false);
      setForm(initialForm(t));
      await queryClient.invalidateQueries({ queryKey: ['scheduled-work-items'] });
    },
  });
  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'enabled' | 'paused' }) =>
      patchJson<ScheduledWorkItem>(`/scheduled-work-items/${id}`, { status }),
    onSuccess: async schedule => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['scheduled-work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['scheduled-work-item', schedule.id] }),
      ]);
    },
  });
  const triggerNow = useMutation({
    mutationFn: (id: string) => postJson(`/scheduled-work-items/${id}/trigger`, {}),
    onSuccess: async (_result, id) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['scheduled-work-items'] }),
        queryClient.invalidateQueries({ queryKey: ['scheduled-work-item', id] }),
      ]);
    },
  });
  const retryRun = useMutation({
    mutationFn: (runId: string) => postJson(`/scheduled-work-item-runs/${runId}/retry`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scheduled-work-item', activeId] }),
  });
  const active = detail.data?.schedule ?? list.data?.results.find(item => item.id === activeId) ?? null;
  const actionError = create.error ?? updateStatus.error ?? triggerNow.error ?? retryRun.error;

  return (
    <div className="schedules-page">
      <div className="daily-toolbar">
        <div className="daily-summary">
          <span>{t('ops.schedules.countLabel', { count: list.data?.count ?? 0 })}</span>
          <span>{t('ops.schedules.enabledCountLabel', { count: list.data?.results.filter(item => item.status === 'enabled').length ?? 0 })}</span>
          <span>{t('ops.schedules.openCircuitsLabel', { count: list.data?.results.filter(item => item.circuitState === 'open').length ?? 0 })}</span>
        </div>
        <div className="work-action-strip">
          <button className="icon-btn" type="button" title={t('ops.schedules.refreshTitle')} aria-label={t('ops.schedules.refreshTitle')} onClick={() => list.refetch()}>
            <RefreshCcw size={15} />
          </button>
          <button className="btn" type="button" onClick={() => setShowCreate(value => !value)}>
            {showCreate ? <Pause size={15} /> : <Plus size={15} />} {showCreate ? t('common.close') : t('ops.schedules.newScheduleButton')}
          </button>
        </div>
      </div>

      {showCreate ? <ScheduleCreateForm form={form} setForm={setForm} preview={preview} create={create} feedAnalysisRequest={feedAnalysisRequest} /> : null}
      {actionError ? <div className="daily-error">{String(actionError)}</div> : null}

      <section className="schedule-split">
        <div className="schedule-list" aria-label={t('nav.schedules')}>
          {list.isLoading ? <div className="daily-empty">{t('ops.schedules.loadingList')}</div> : null}
          {list.isError ? <div className="daily-error">{String(list.error)}</div> : null}
          {list.data?.results.map(item => (
            <button key={item.id} type="button" className="schedule-list-row" data-active={activeId === item.id} onClick={() => setSelectedId(item.id)}>
              <span className={`schedule-state ${item.status}`} />
              <span className="work-list-copy">
                <strong>{item.title}</strong>
                <small>{item.trigger.kind} · {item.trigger.expression} · {item.trigger.timezone}</small>
              </span>
              <span className="schedule-next">{formatDate(item.nextRunAt)}</span>
            </button>
          ))}
          {!list.isLoading && list.data?.results.length === 0 ? <div className="daily-empty">{t('ops.schedules.emptyList')}</div> : null}
        </div>

        <div className="schedule-detail">
          {active ? (
            <>
              <header className="schedule-detail-head">
                <div>
                  <div className="eyebrow">{active.runTemplate.templateId.replaceAll('_', ' ')}</div>
                  <h2>{active.title}</h2>
                  <p>{active.runTemplate.goalTemplate}</p>
                </div>
                <div className="work-action-strip">
                  {active.status !== 'retired' ? (
                    <button className="ghost-btn" type="button" disabled={updateStatus.isPending} onClick={() => updateStatus.mutate({ id: active.id, status: active.status === 'enabled' ? 'paused' : 'enabled' })}>
                      {active.status === 'enabled' ? <Pause size={14} /> : <Play size={14} />} {active.status === 'enabled' ? t('ops.schedules.pauseButton') : t('ops.schedules.resumeButton')}
                    </button>
                  ) : null}
                  <button className="btn" type="button" disabled={triggerNow.isPending || active.status === 'retired'} onClick={() => triggerNow.mutate(active.id)}>
                    <Play size={14} /> {t('ops.schedules.runNowButton')}
                  </button>
                </div>
              </header>
              <div className="schedule-facts">
                <ScheduleFact label={t('ops.schedules.factStatus')} value={active.status} />
                <ScheduleFact label={t('ops.schedules.factNextRun')} value={formatDate(active.nextRunAt)} />
                <ScheduleFact label={t('ops.schedules.factApproval')} value={active.approvalPolicy.replaceAll('_', ' ')} />
                <ScheduleFact label={t('ops.schedules.factConcurrency')} value={active.concurrencyPolicy.replaceAll('_', ' ')} />
                <ScheduleFact label={t('ops.schedules.factCatchUp')} value={active.catchUpPolicy.replaceAll('_', ' ')} />
                <ScheduleFact label={t('ops.schedules.factCircuit')} value={t('ops.schedules.circuitValue', { circuitState: active.circuitState, failures: active.consecutiveFailures })} tone={active.circuitState === 'open' ? 'danger' : 'ok'} />
              </div>
              <div className="schedule-history-head">
                <div><h3>{t('ops.schedules.runHistoryTitle')}</h3><span>{t('ops.schedules.recordedLabel', { count: detail.data?.runs.length ?? 0 })}</span></div>
                <CalendarClock size={17} />
              </div>
              <div className="schedule-history">
                {detail.data?.runs.map(run => (
                  <div className="schedule-run-row" key={run.id}>
                    <span className={`run-state ${run.status}`}>{run.status.replaceAll('_', ' ')}</span>
                    <div><strong>{formatDate(run.scheduledFor)}</strong><small>{t('ops.schedules.attemptLabel', { triggerKind: run.triggerKind, attempt: run.attemptCount, maxAttempts: run.maxAttempts })}</small></div>
                    <code>{run.workItemId ?? run.id}</code>
                    {run.status === 'failed' && run.attemptCount < run.maxAttempts ? (
                      <button className="icon-btn" type="button" title={t('ops.schedules.retryRunTitle')} aria-label={t('ops.schedules.retryRunAria', { id: run.id })} disabled={retryRun.isPending} onClick={() => retryRun.mutate(run.id)}><RotateCcw size={14} /></button>
                    ) : <span />}
                  </div>
                ))}
                {detail.data?.runs.length === 0 ? <div className="daily-empty">{t('ops.schedules.noRunsRecorded')}</div> : null}
              </div>
            </>
          ) : <div className="daily-empty">{t('ops.schedules.selectPrompt')}</div>}
        </div>
      </section>
    </div>
  );
}

function ScheduleCreateForm({ form, setForm, preview, create, feedAnalysisRequest }: {
  form: FormState;
  setForm: (value: FormState) => void;
  preview: ReturnType<typeof useQuery<ScheduledWorkPreviewResponse>>;
  create: ReturnType<typeof useMutation<CreateScheduledWorkResponse, Error, void>>;
  feedAnalysisRequest: FeedAnalysisRequestValidation;
}) {
  const { t } = useI18n();
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm({ ...form, [key]: value });
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate(); };
  return (
    <form className="schedule-create" onSubmit={submit}>
      <div className="schedule-form-fields">
        <label><span>{t('ops.schedules.formTitle')}</span><input value={form.title} onChange={event => set('title', event.target.value)} required /></label>
        <label><span>{t('ops.schedules.formProject')}</span><input value={form.projectId} onChange={event => set('projectId', event.target.value)} required /></label>
        <label><span>{t('ops.schedules.formTemplate')}</span><select value={form.templateId} onChange={event => {
          const templateId = event.target.value as ScheduledWorkTemplateId;
          setForm({ ...form, templateId, approvalPolicy: templateId === 'scheduled_feed_analysis' || templateId === 'scheduled_execution' ? 'preapproved_scope' : form.approvalPolicy });
        }}><option value="morning_inbox_digest">{t('ops.schedules.templateMorningDigest')}</option><option value="runtime_readiness">{t('ops.schedules.templateRuntimeReadiness')}</option><option value="scheduled_feed_analysis">{t('ops.schedules.templateFeedAnalysis')}</option><option value="scheduled_execution">{t('ops.schedules.templateScheduledExecution')}</option></select></label>
        <label><span>{t('ops.schedules.formPreset')}</span><select value={form.preset} onChange={event => set('preset', event.target.value as TriggerPreset)}><option value="daily">{t('ops.schedules.presetDaily')}</option><option value="weekly">{t('ops.schedules.presetWeekly')}</option><option value="interval">{t('ops.schedules.presetInterval')}</option><option value="once">{t('ops.schedules.presetOnce')}</option></select></label>
        {form.preset === 'daily' || form.preset === 'weekly' ? <label><span>{t('ops.schedules.formTime')}</span><input type="time" value={form.time} onChange={event => set('time', event.target.value)} required /></label> : null}
        {form.preset === 'weekly' ? <label><span>{t('ops.schedules.formWeekday')}</span><select value={form.weekday} onChange={event => set('weekday', event.target.value)}>{['ops.schedules.daySunday','ops.schedules.dayMonday','ops.schedules.dayTuesday','ops.schedules.dayWednesday','ops.schedules.dayThursday','ops.schedules.dayFriday','ops.schedules.daySaturday'].map((key, index) => <option key={key} value={index}>{t(key)}</option>)}</select></label> : null}
        {form.preset === 'interval' ? <label><span>{t('ops.schedules.presetInterval')}</span><input aria-label={t('ops.schedules.presetInterval')} value={form.interval} onChange={event => set('interval', event.target.value)} placeholder="6h" required /></label> : null}
        {form.preset === 'once' ? <label><span>{t('ops.schedules.formRunAt')}</span><input type="datetime-local" value={form.onceAt} onChange={event => set('onceAt', event.target.value)} required /></label> : null}
        <label><span>{t('ops.schedules.formTimezone')}</span><input value={form.timezone} onChange={event => set('timezone', event.target.value)} required /></label>
        <label><span>{t('ops.schedules.formApproval')}</span><select value={form.approvalPolicy} onChange={event => set('approvalPolicy', event.target.value as ScheduledApprovalPolicy)}><option value="read_only_auto">{t('ops.schedules.approvalReadOnlyAuto')}</option><option value="preapproved_scope">{t('ops.schedules.approvalPreapprovedScope')}</option><option value="each_run">{t('ops.schedules.approvalEachRun')}</option></select></label>
        <label><span>{t('ops.schedules.formConcurrency')}</span><select value={form.concurrencyPolicy} onChange={event => set('concurrencyPolicy', event.target.value as ScheduledConcurrencyPolicy)}><option value="skip">{t('ops.schedules.concurrencySkip')}</option><option value="queue_one">{t('ops.schedules.concurrencyQueueOne')}</option><option value="parallel">{t('ops.schedules.concurrencyParallel')}</option></select></label>
        <label><span>{t('ops.schedules.formCatchUp')}</span><select value={form.catchUpPolicy} onChange={event => set('catchUpPolicy', event.target.value as ScheduledCatchUpPolicy)}><option value="skip">{t('ops.schedules.catchUpSkipLate')}</option><option value="run_once">{t('ops.schedules.catchUpRunOnce')}</option></select></label>
        {form.templateId === 'scheduled_feed_analysis' ? (
          <label className="schedule-request-field"><span>{t('ops.schedules.formFeedAnalysisRequest')}</span><textarea rows={10} value={form.feedAnalysisRequest} onChange={event => set('feedAnalysisRequest', event.target.value)} spellCheck={false} />{feedAnalysisRequest.error ? <small className="schedule-preview-error" role="alert">{feedAnalysisRequest.error}</small> : null}</label>
        ) : null}
        {form.templateId === 'scheduled_execution' ? (<>
          <label><span>{t('ops.schedules.formEditableSurfaces')}</span><input value={form.editableSurfaces} onChange={event => set('editableSurfaces', event.target.value)} placeholder={t('ops.schedules.editableSurfacesPlaceholder')} /></label>
          <label><span>{t('ops.schedules.formRequiredChecks')}</span><input value={form.requiredChecks} onChange={event => set('requiredChecks', event.target.value)} placeholder={t('ops.schedules.requiredChecksPlaceholder')} /></label>
        </>) : null}
      </div>
      <div className="schedule-preview">
        <span className="mini-label">{t('ops.schedules.nextOccurrencesLabel')}</span>
        {preview.isFetching ? <span>{t('ops.schedules.calculating')}</span> : null}
        {preview.isError ? <span className="schedule-preview-error">{String(preview.error)}</span> : null}
        {preview.data?.occurrences.map(value => <strong key={value}>{formatDate(value)}</strong>)}
      </div>
      <button className="btn" type="submit" disabled={create.isPending || !form.title.trim() || !form.projectId.trim() || (form.templateId === 'scheduled_feed_analysis' && !feedAnalysisRequest.value) || (form.templateId === 'scheduled_execution' && !form.editableSurfaces.trim())}><Plus size={14} /> {t('ops.schedules.createButton')}</button>
    </form>
  );
}

function ScheduleFact({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'ok' }) {
  return <div className={`work-fact ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function initialForm(t: (key: string) => string): FormState {
  return {
    title: t('ops.schedules.templateMorningDigest'), projectId: getCurrentProjectId() ?? 'los',
    templateId: 'morning_inbox_digest', preset: 'daily', time: '08:30', weekday: '1',
    interval: '6h', onceAt: '', timezone: DEFAULT_TIMEZONE,
    approvalPolicy: 'read_only_auto', concurrencyPolicy: 'skip', catchUpPolicy: 'skip',
    editableSurfaces: '', requiredChecks: '',
    feedAnalysisRequest: JSON.stringify({
      sourceSystem: 'lot2extension',
      deliveryMode: 'result_returning',
      scenario: 'evidence_batch',
      requestedOutputs: ['daily_digest'],
      materialBundle: {
        schemaVersion: 'material-bundle-v1',
        bundleId: 'replace-with-current-bundle',
        sourceSystem: 'lot2extension',
        items: [],
      },
    }, null, 2),
  };
}

function buildTrigger(form: FormState): ScheduledWorkTrigger {
  if (form.preset === 'interval') return { kind: 'interval', expression: form.interval.trim(), timezone: form.timezone.trim() };
  if (form.preset === 'once') return { kind: 'once', expression: form.onceAt ? new Date(form.onceAt).toISOString() : '', timezone: form.timezone.trim() };
  const [hour = '0', minute = '0'] = form.time.split(':');
  return { kind: 'cron', expression: `${Number(minute)} ${Number(hour)} * * ${form.preset === 'weekly' ? form.weekday : '*'}`, timezone: form.timezone.trim() };
}

function previewPath(trigger: ScheduledWorkTrigger): string {
  const params = new URLSearchParams({ kind: trigger.kind, expression: trigger.expression, timezone: trigger.timezone });
  return `/scheduled-work-items/preview?${params}`;
}

function validateFeedAnalysisRequest(source: string, t: (key: string) => string): FeedAnalysisRequestValidation {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { error: t('ops.schedules.feedAnalysisInvalidJson') };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: t('ops.schedules.feedAnalysisNotObject') };
  }
  const request = value as Record<string, unknown>;
  const materialBundle = request.materialBundle;
  const bundleItems = materialBundle && typeof materialBundle === 'object' && !Array.isArray(materialBundle)
    ? (materialBundle as Record<string, unknown>).items
    : undefined;
  const hasEvidence = Boolean(request.materialBundleRef)
    || (Array.isArray(bundleItems) && bundleItems.length > 0)
    || (Array.isArray(request.feedObservations) && request.feedObservations.length > 0);
  if (!hasEvidence) return { error: t('ops.schedules.feedAnalysisNoEvidence') };
  return { value: request };
}
