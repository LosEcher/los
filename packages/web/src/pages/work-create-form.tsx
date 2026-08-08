import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';

import {
  getCurrentProjectId,
  postJson,
  type CreateWorkItemPayload,
  type WorkItemMode,
  type WorkItemProjection,
} from '../api/index.js';
import { useI18n } from '../i18n';

export type WorkFormState = {
  projectId: string;
  title: string;
  goal: string;
  description: string;
  mode: WorkItemMode;
  toolMode: 'read-only' | 'project-write';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  editableSurfaces: string;
  nonGoals: string;
  requiredChecks: string;
  stopConditions: string;
  evidenceRequired: string;
};

export function StructuredCreateForm({ onCreated }: { onCreated: (item: WorkItemProjection) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<WorkFormState>(() => initialForm());
  const create = useMutation({
    mutationFn: () => postJson<WorkItemProjection>('/work-items', buildCreateWorkItemPayload(form)),
    onSuccess: onCreated,
  });
  const set = <K extends keyof WorkFormState>(key: K, value: WorkFormState[K]) => setForm(current => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); if (form.goal.trim()) create.mutate(); };
  const advancedCount = countAdvancedOverrides(form);
  return (
    <form className="work-create" onSubmit={submit}>
      <div className="work-create-defaults">
        <label>
          <span>{t('work.form.goal')}</span>
          <textarea rows={3} required value={form.goal} onChange={event => set('goal', event.target.value)} placeholder={t('work.form.goalPlaceholder')} />
        </label>
        <div className="work-create-controls work-create-controls-default">
          <label>
            <span>{t('work.form.permission')}</span>
            <select value={form.toolMode} onChange={event => set('toolMode', event.target.value as WorkFormState['toolMode'])}>
              <option value="read-only">{t('work.toolMode.readOnly')}</option>
              <option value="project-write">{t('work.toolMode.projectWrite')}</option>
            </select>
          </label>
          <label>
            <span>{t('work.form.priority')}</span>
            <select value={form.priority} onChange={event => set('priority', event.target.value as WorkFormState['priority'])}>
              <option>P0</option>
              <option>P1</option>
              <option>P2</option>
              <option>P3</option>
            </select>
          </label>
        </div>
      </div>
      <details className="work-create-advanced">
        <summary>
          <span>{t('work.form.advanced')}</span>
          {advancedCount > 0 ? <span className="filter-badge">{advancedCount}</span> : null}
          <span className="work-create-advanced-hint">{t('work.form.advancedHint')}</span>
        </summary>
        <div className="work-create-advanced-panel">
          <div className="work-create-controls">
            <label>
              <span>{t('work.form.title')}</span>
              <input value={form.title} onChange={event => set('title', event.target.value)} placeholder={t('work.form.titlePlaceholder')} />
            </label>
            <label>
              <span>{t('work.form.project')}</span>
              <input required value={form.projectId} onChange={event => set('projectId', event.target.value)} />
            </label>
            <label>
              <span>{t('work.form.mode')}</span>
              <select value={form.mode} onChange={event => set('mode', event.target.value as WorkItemMode)}>
                <option value="execution">{t('work.mode.execution')}</option>
                <option value="audit">{t('work.mode.audit')}</option>
                <option value="governance">{t('work.mode.governance')}</option>
                <option value="closeout">{t('work.mode.closeout')}</option>
                <option value="feed-analysis-ingress">{t('work.mode.feedAnalysis')}</option>
              </select>
            </label>
          </div>
          <label>
            <span>{t('work.form.description')}</span>
            <textarea rows={2} value={form.description} onChange={event => set('description', event.target.value)} placeholder={t('work.form.descriptionPlaceholder')} />
          </label>
          <div className="work-create-lists">
            <LineField label={t('work.contract.editableSurfaces')} value={form.editableSurfaces} onChange={value => set('editableSurfaces', value)} placeholder={t('work.form.editableSurfacesPlaceholder')} />
            <LineField label={t('work.contract.requiredChecks')} value={form.requiredChecks} onChange={value => set('requiredChecks', value)} placeholder={t('work.form.requiredChecksPlaceholder')} />
            <LineField label={t('work.contract.stopConditions')} value={form.stopConditions} onChange={value => set('stopConditions', value)} placeholder={t('work.form.stopConditionsPlaceholder')} />
            <LineField label={t('work.form.evidenceRequired')} value={form.evidenceRequired} onChange={value => set('evidenceRequired', value)} placeholder={t('work.form.evidenceRequiredPlaceholder')} />
            <LineField label={t('work.form.nonGoals')} value={form.nonGoals} onChange={value => set('nonGoals', value)} placeholder={t('work.form.nonGoalsPlaceholder')} />
          </div>
        </div>
      </details>
      <div className="work-create-submit">
        <span>{t('work.form.draftNote')}</span>
        <button className="btn" type="submit" disabled={create.isPending || !form.goal.trim()}>
          <Plus size={14} /> {create.isPending ? t('work.creating') : t('work.createWork')}
        </button>
      </div>
      {create.error ? <div className="daily-error">{t('work.createFailed', { error: String(create.error) })}</div> : null}
    </form>
  );
}

function LineField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label><span>{label}</span><textarea rows={3} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

export function buildCreateWorkItemPayload(form: WorkFormState): CreateWorkItemPayload {
  return {
    projectId: form.projectId.trim(),
    title: form.title.trim() || undefined,
    goal: form.goal.trim(),
    description: form.description.trim() || undefined,
    mode: form.mode,
    toolMode: form.toolMode,
    priority: form.priority,
    editableSurfaces: lines(form.editableSurfaces),
    nonGoals: lines(form.nonGoals),
    requiredChecks: lines(form.requiredChecks),
    stopConditions: lines(form.stopConditions),
    evidenceRequired: lines(form.evidenceRequired),
  };
}

function initialForm(): WorkFormState {
  return {
    projectId: getCurrentProjectId() ?? 'los',
    title: '',
    goal: '',
    description: '',
    mode: 'execution',
    toolMode: 'project-write',
    priority: 'P2',
    editableSurfaces: '',
    nonGoals: '',
    requiredChecks: '',
    stopConditions: '',
    evidenceRequired: '',
  };
}

/** Count non-default advanced fields so the summary can show a badge. */
export function countAdvancedOverrides(form: WorkFormState): number {
  const defaults = initialForm();
  let count = 0;
  if (form.title.trim()) count += 1;
  if (form.description.trim()) count += 1;
  if (form.projectId.trim() !== defaults.projectId) count += 1;
  if (form.mode !== defaults.mode) count += 1;
  if (form.editableSurfaces.trim()) count += 1;
  if (form.requiredChecks.trim()) count += 1;
  if (form.stopConditions.trim()) count += 1;
  if (form.evidenceRequired.trim()) count += 1;
  if (form.nonGoals.trim()) count += 1;
  return count;
}

function lines(value: string): string[] {
  return [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];
}
