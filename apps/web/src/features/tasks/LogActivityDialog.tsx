import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { VersionConflictError, errorMessage, isRecord } from '@/api/errors';
import { invalidateLead, useLead } from '@/api/queries';
import type { ActivityLogged } from '@/api/types';
import { Button, Checkbox, Dialog, Field, Input, Segmented, Textarea, Toggle, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { SALES_STAGES, STAGE_LABELS, isSalesStage } from '@/lib/labels';
import { createTask, logActivity, setLeadStage, updateTask } from '@/api/endpoints';
import type { ActivityKind, SalesStage, Task, TaskType } from './api';
import { dayOfChoice, dueError, formatDay, type DueChoice } from './dates';
import { ACTIVITY_KINDS, NOTE_PLACEHOLDERS, OUTCOMES, TASK_TYPES, TASK_TYPE_META, suggestFollowUp, withArticle } from './model';
import { ChipGroup, DuePicker, type ChipOption } from './parts';
import { taskKeys } from './queries';

export interface LogActivityDialogProps {
  leadId: string;
  leadName: string;
  defaultType?: ActivityKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
  /** Logged from a follow-up: offers to mark it done in the same save. */
  task?: Pick<Task, 'id' | 'title' | 'version' | 'doneAt'>;
}

const STAGE_TONES: Record<SalesStage, string> = {
  new: 'border-stage-new bg-stage-new-soft text-stage-new',
  contacted: 'border-stage-contacted bg-stage-contacted-soft text-stage-contacted',
  interested: 'border-stage-interested bg-stage-interested-soft text-stage-interested',
  quoting: 'border-stage-quoting bg-stage-quoting-soft text-stage-quoting',
  won: 'border-stage-won bg-stage-won-soft text-stage-won',
  lost: 'border-stage-lost bg-stage-lost-soft text-stage-lost',
};

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const KIND_LABELS: Record<ActivityKind, string> = { call: 'Call', email: 'Email', visit: 'Visit' };

/** What a save has already done, so a retry after a partial failure only does the rest. */
interface Progress {
  activity?: ActivityLogged;
  stage?: boolean;
  completed?: boolean;
  task?: boolean;
}

export function LogActivityDialog(props: LogActivityDialogProps) {
  // Mounted only while open, so every open starts from a clean form.
  if (!props.open) return null;
  return <LogActivityForm {...props} />;
}

function LogActivityForm({ leadId, leadName, defaultType, onOpenChange, onDone, task }: LogActivityDialogProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const formId = useId();
  const ids = { outcome: useId(), stage: useId(), when: useId() };
  const lead = useLead(leadId);
  const currentStage = isSalesStage(lead.data?.salesStage) ? lead.data.salesStage : null;

  const [kind, setKind] = useState<ActivityKind>(defaultType ?? 'call');
  const [outcome, setOutcome] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [stage, setStageChoice] = useState<SalesStage | null>(null);
  const [scheduling, setScheduling] = useState(true);
  const [schedulingTouched, setSchedulingTouched] = useState(false);
  const suggestion = suggestFollowUp(kind, outcome);
  const [title, setTitle] = useState(suggestion.title);
  const [titleTouched, setTitleTouched] = useState(false);
  const [taskType, setTaskType] = useState<TaskType>(suggestion.type);
  const [due, setDue] = useState<DueChoice>({ preset: suggestion.when });
  const [dueTouched, setDueTouched] = useState(false);
  const [completeTask, setCompleteTask] = useState(!!task && !task.doneAt);
  const [progress, setProgress] = useState<Progress>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  // The follow-up tracks the outcome until the rep edits it.
  useEffect(() => {
    const s = suggestFollowUp(kind, outcome);
    if (!titleTouched) setTitle(s.title);
    if (!titleTouched) setTaskType(s.type);
    if (!dueTouched) setDue({ preset: s.when });
  }, [kind, outcome, titleTouched, dueTouched]);

  // Closing a deal (or ruling it out) rarely needs a next step: off unless the rep turned it on.
  useEffect(() => {
    if (!schedulingTouched) setScheduling(stage !== 'lost' && stage !== 'won');
  }, [stage, schedulingTouched]);

  const logged = !!progress.activity;
  const dueProblem = scheduling ? dueError(due) : null;
  const titleProblem = scheduling && !title.trim() ? 'Give the follow-up a title.' : null;

  const close = () => onOpenChange(false);

  const save = async () => {
    setSubmitted(true);
    if (saving || dueProblem || titleProblem) return;
    setSaving(true);
    setError(null);
    const p: Progress = { ...progress };
    let step = `The ${KIND_LABELS[kind].toLowerCase()} wasn’t logged`;
    try {
      if (!p.activity) {
        p.activity = await logActivity(leadId, {
          type: kind,
          ...(outcome ? { outcome } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        setProgress({ ...p });
      }
      if (stage && stage !== p.activity.salesStage && !p.stage) {
        step = `${KIND_LABELS[kind]} logged, but the stage didn’t change`;
        await moveStage(leadId, stage, p.activity.version);
        p.stage = true;
        setProgress({ ...p });
      }
      if (task && completeTask && !p.completed) {
        step = `${KIND_LABELS[kind]} logged, but “${task.title}” wasn’t marked done`;
        await completeFollowUp(task);
        p.completed = true;
        setProgress({ ...p });
      }
      const day = dayOfChoice(due);
      if (scheduling && day && !p.task) {
        step = `${KIND_LABELS[kind]} logged, but the follow-up wasn’t scheduled`;
        await createTask(leadId, { title: title.trim(), type: taskType, dueAt: day });
        p.task = true;
        setProgress({ ...p });
      }
    } catch (err) {
      setError(`${step}: ${errorMessage(err)}`);
      setSaving(false);
      void refresh();
      return;
    }
    void refresh();
    const lines = [
      p.stage && stage ? `Moved to ${STAGE_LABELS[stage]}.` : p.activity?.salesStage === 'contacted' && currentStage === 'new' ? 'Moved to Contacted.' : null,
      p.completed && task ? `“${task.title}” is done.` : null,
      p.task ? `Next: ${title.trim()}, ${formatDay(dayOfChoice(due)!)}.` : null,
    ].filter(Boolean);
    toast.success(`${KIND_LABELS[kind]} logged with ${leadName}`, lines.length ? lines.join(' ') : undefined);
    onDone?.();
    close();
  };

  const refresh = () => Promise.all([invalidateLead(qc, leadId), qc.invalidateQueries({ queryKey: taskKeys.all })]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };

  const outcomeOptions: ChipOption<string>[] = OUTCOMES[kind].map((o) => ({ value: o, label: o }));
  const stageOptions: ChipOption<SalesStage>[] = SALES_STAGES.map((s) => ({
    value: s,
    label: STAGE_LABELS[s],
    selectedClassName: cn('shadow-sm', STAGE_TONES[s]),
    current: s === currentStage,
  }));
  const remaining = [
    !logged && withArticle(kind),
    stage && stage !== currentStage && !progress.stage && 'the stage',
    task && completeTask && !progress.completed && 'the done tick',
    scheduling && !progress.task && 'the follow-up',
  ].filter(Boolean);

  return (
    <Dialog
      open
      onClose={close}
      size="lg"
      title={`Log ${withArticle(kind)}`}
      description={leadName}
      footer={(
        <>
          <span className="mr-auto hidden text-xs text-muted sm:inline">
            <kbd className="rounded border border-border bg-surface px-1 font-sans">{MOD_KEY}</kbd> + <kbd className="rounded border border-border bg-surface px-1 font-sans">Enter</kbd> saves
          </span>
          <Button onClick={close}>{logged ? 'Close' : 'Cancel'}</Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {error ? 'Try again' : logged ? 'Save the rest' : `Save ${KIND_LABELS[kind].toLowerCase()}`}
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        noValidate
        onKeyDown={onKeyDown}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4 pt-1"
      >
        {logged && (
          <p className="flex items-start gap-2 rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{KIND_LABELS[kind]} logged. {remaining.length ? 'Save again to finish the rest.' : ''}</span>
          </p>
        )}

        <fieldset disabled={logged} className="flex flex-col gap-4">
          <legend className="sr-only">Activity</legend>
          <Segmented
            label="Activity type"
            fullWidth
            value={kind}
            onChange={(k) => {
              setKind(k);
              setOutcome(null);
            }}
            options={ACTIVITY_KINDS.map((k) => {
              const Icon = TASK_TYPE_META[k].icon;
              return { value: k, label: <><Icon aria-hidden />{KIND_LABELS[k]}</> };
            })}
          />

          <div className="flex flex-col gap-2">
            <span id={ids.outcome} className="text-sm font-medium text-fg">
              {kind === 'call' ? 'How did it go?' : 'Outcome'} <span className="font-normal text-muted">(optional)</span>
            </span>
            <ChipGroup labelledBy={ids.outcome} value={outcome} onChange={setOutcome} options={outcomeOptions} allowEmpty disabled={logged} autoFocus />
          </div>

          <Field label={<>Note <span className="font-normal text-muted">(optional)</span></>}>
            {(f) => (
              <Textarea {...f} rows={2} maxLength={10_000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={NOTE_PLACEHOLDERS[kind]} />
            )}
          </Field>
        </fieldset>

        <div className="flex flex-col gap-2">
          <span id={ids.stage} className="text-sm font-medium text-fg">
            Move the stage <span className="font-normal text-muted">(optional)</span>
          </span>
          <ChipGroup
            labelledBy={ids.stage}
            value={stage}
            onChange={(s) => setStageChoice(s === currentStage ? null : s)}
            options={stageOptions}
            allowEmpty
            disabled={progress.stage}
          />
          {currentStage === 'new' && !stage && (
            <p className="text-xs text-muted">New leads move to Contacted when you log {withArticle(kind)}.</p>
          )}
        </div>

        {task && !task.doneAt && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm">
            <Checkbox checked={completeTask} onChange={setCompleteTask} label={`Mark “${task.title}” done`} disabled={progress.completed} />
            <span className="min-w-0 flex-1">Mark <span className="font-medium">“{task.title}”</span> done</span>
          </label>
        )}

        <div className="flex flex-col gap-3 rounded-xl border border-border p-3.5">
          <Toggle
            checked={scheduling}
            disabled={progress.task}
            onCheckedChange={(v) => {
              setScheduling(v);
              setSchedulingTouched(true);
            }}
            label={<span className="font-medium">Schedule next follow-up</span>}
            description={scheduling ? undefined : 'No next step will be planned for this lead.'}
          />
          {scheduling && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <span id={ids.when} className="text-sm font-medium text-fg">When</span>
                <DuePicker
                  labelledBy={ids.when}
                  value={due}
                  onChange={(d) => {
                    setDue(d);
                    setDueTouched(true);
                  }}
                  disabled={progress.task}
                  error={submitted ? dueProblem : null}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-fg">Next step</span>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Segmented
                    label="Follow-up type"
                    size="md"
                    value={taskType}
                    onChange={(t) => {
                      setTaskType(t);
                      setTitleTouched(true);
                    }}
                    options={TASK_TYPES.map((t) => {
                      const Icon = TASK_TYPE_META[t].icon;
                      return { value: t, label: <Icon aria-hidden />, ariaLabel: TASK_TYPE_META[t].label };
                    })}
                  />
                  <Input
                    aria-label="Follow-up title"
                    value={title}
                    maxLength={200}
                    invalid={submitted && !!titleProblem}
                    disabled={progress.task}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setTitleTouched(true);
                    }}
                    className="min-w-0 flex-1"
                  />
                </div>
                {submitted && titleProblem && <p className="text-xs text-danger" role="alert">{titleProblem}</p>}
              </div>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
        )}
      </form>
    </Dialog>
  );
}

/** PUT the stage; a stale version is retried once on the server's, unless the lead already has the stage. */
async function moveStage(leadId: string, stage: SalesStage, version: number) {
  try {
    await setLeadStage(leadId, stage, version);
  } catch (err) {
    const current = err instanceof VersionConflictError && isRecord(err.current) ? err.current : null;
    if (!current || typeof current.version !== 'number') throw err;
    if (current.stage === stage) return;
    await setLeadStage(leadId, stage, current.version);
  }
}

async function completeFollowUp(task: Pick<Task, 'id' | 'version'>) {
  try {
    await updateTask(task.id, { done: true, version: task.version });
  } catch (err) {
    const current = err instanceof VersionConflictError && isRecord(err.current) ? err.current : null;
    if (!current || typeof current.version !== 'number') throw err;
    if (current.doneAt) return;
    await updateTask(task.id, { done: true, version: current.version });
  }
}
