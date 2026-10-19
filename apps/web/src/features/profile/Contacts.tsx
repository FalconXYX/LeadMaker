import { BadgeCheck, Ban, CheckCircle2, Mail, Phone, Target, Trash2, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { LeadContact } from '@/api/types';
import {
  Avatar, Badge, Button, Dialog, EditedBadge, EmptyState, ExternalLink, Field, IconButton, Input, Toggle, Tooltip, useToast,
} from '@/components/ui';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useVersionedWrite } from './conflict';
import { useProfile } from './context';
import { EditableValue } from './EditableValue';
import {
  CONTACT_TEXT_FIELDS, askFor, companySize, isEmail, isPhone, sourceLabel, tagByKey, targetRule, telHref, validateContactField,
} from './lib';
import { CopyButton, Highlight, ReadOnlyHint, SectionCard } from './ui';

// ---- target contact ------------------------------------------------------------------------------------------

export function TargetContactCard() {
  const { profile } = useProfile();
  const target = profile.targetContact;
  const { contactId, name, role, title, phone, mainLine, email, doNotContact: dnc } = askFor(profile);
  const size = companySize(profile.systemTags);
  const rule = targetRule(size);
  const sizeReason = tagByKey(profile.systemTags, 'size')?.reason;

  return (
    <SectionCard
      title="Who to ask for"
      icon={<Target />}
      description="Picked by company size, so you reach the person who buys supplies."
      highlightKey={contactId ? `contact:${contactId}` : undefined}
    >
      <div className="flex items-start gap-3">
        <Avatar name={name ?? role} size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-fg">
            {name ?? `The ${role.toLowerCase()}`}
            <span className="font-normal text-muted"> · {role}</span>
          </p>
          <p className="text-sm text-muted">
            {name ? title ?? 'Title unknown' : 'Name unknown: ask for them by role on the main line'}
          </p>
          {dnc ? (
            <p className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-danger"><Ban className="size-4" aria-hidden />Marked do not contact</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
              {phone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="size-3.5 text-muted" aria-hidden />
                  <a href={telHref(phone)} className="text-accent tabular hover:underline">{phone}</a>
                  {mainLine && <span className="text-xs text-subtle">main line</span>}
                  <CopyButton value={phone} label="Copy phone number" />
                </span>
              )}
              {email && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Mail className="size-3.5 text-muted" aria-hidden />
                  <a href={`mailto:${email}`} className="truncate text-accent hover:underline">{email}</a>
                  <CopyButton value={email} label="Copy email address" />
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 grid gap-2.5 sm:grid-cols-2" role="list" aria-label="Who-to-ask-for rule">
        <RuleOption active={rule === 'small'} title="Small shop → Owner" detail="The owner usually orders materials." />
        <RuleOption
          active={rule === 'larger'}
          title="Larger company → Office / Purchasing manager"
          detail="Falls back to the owner when no buyer is known."
        />
      </div>
      <p className="mt-3 text-xs text-muted">
        {size ? <>This is a <span className="font-medium text-fg">{size}</span> company{sizeReason ? ` (${sizeReason})` : ''}. </> : 'Company size is unknown. '}
      </p>
      {target?.reason && (
        <details className="mt-1.5 text-xs text-subtle">
          <summary className="w-fit cursor-pointer rounded font-medium text-muted hover:text-fg">How the pipeline picked this contact</summary>
          <p className="mt-1 break-words">{target.reason}</p>
        </details>
      )}
    </SectionCard>
  );
}

function RuleOption({ active, title, detail }: { active: boolean; title: string; detail: string }) {
  return (
    <div
      role="listitem"
      aria-current={active || undefined}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3.5 py-2.5',
        active ? 'border-accent/40 bg-accent-soft' : 'border-border bg-surface-2/50 opacity-70',
      )}
    >
      {active
        ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        : <span className="mt-0.5 size-4 shrink-0 rounded-full border border-border-strong" aria-hidden />}
      <div className="min-w-0">
        <p className={cn('text-sm font-medium', active ? 'text-accent' : 'text-fg')}>{title}</p>
        <p className="text-xs text-muted">{detail}{active && <span className="sr-only"> (applies to this lead)</span>}</p>
      </div>
    </div>
  );
}

// ---- contact list ----------------------------------------------------------------------------------------------

export function ContactsCard() {
  const { profile, canEdit, readOnlyReason } = useProfile();
  const [adding, setAdding] = useState(false);
  const contacts = [...profile.contacts].sort(
    (a, b) => Number(b.isTarget) - Number(a.isTarget) || Number(b.source === 'rep') - Number(a.source === 'rep') || b.confidence - a.confidence,
  );
  const sources = [...new Set(profile.contacts.filter((c) => c.source !== 'rep').map((c) => sourceLabel(c.source)))];
  const repAdded = profile.contacts.filter((c) => c.source === 'rep').length;
  const description = [sources.length ? `From ${sources.join(', ')}` : null, repAdded ? `${repAdded} added by reps` : null]
    .filter(Boolean).join(' · ') || 'People at this company';
  const addButton = (
    <ReadOnlyHint reason={canEdit ? null : readOnlyReason}>
      <Button size="sm" leftIcon={<UserPlus className="size-3.5" />} onClick={() => setAdding(true)} disabled={!canEdit}>
        Add contact
      </Button>
    </ReadOnlyHint>
  );
  return (
    <SectionCard
      title={`Contacts (${profile.contacts.length})`}
      icon={<Users />}
      description={description}
      actions={addButton}
      bodyClassName="p-0"
    >
      {contacts.length === 0 ? (
        <EmptyState
          compact
          icon={<Users />}
          title="No named contacts yet"
          description="Ask for the owner on the main line, or add someone you have spoken with."
        />
      ) : (
        <ul className="divide-y divide-border">
          {contacts.map((c) => <ContactRow key={c.id} contact={c} />)}
        </ul>
      )}
      <AddContactDialog open={adding} onClose={() => setAdding(false)} />
    </SectionCard>
  );
}

function ContactRow({ contact: c }: { contact: LeadContact }) {
  const { canEdit, m, readOnlyReason } = useProfile();
  const toast = useToast();
  const dnc = c.doNotContact.value;
  const repAdded = c.source === 'rep';
  const [confirming, setConfirming] = useState(false);
  const dncWrite = useVersionedWrite();

  const saveField = (field: (typeof CONTACT_TEXT_FIELDS)[number]) => (value: string | null, version: number) =>
    m.setContactOverride.mutateAsync({ contactId: c.id, field, value, version });
  const revertField = (field: (typeof CONTACT_TEXT_FIELDS)[number]) => (version: number) =>
    m.clearContactOverride.mutateAsync({ contactId: c.id, field, version });

  const setDnc = (next: boolean) =>
    dncWrite.run({
      label: 'Do not contact',
      base: c.doNotContact.value,
      mine: next,
      version: c.version,
      // Back to what the source says: drop the override instead of pinning the same value.
      attempt: (v) => (c.doNotContact.overridden && next === c.doNotContact.scraped
        ? m.clearContactOverride.mutateAsync({ contactId: c.id, field: 'do_not_contact', version: v })
        : m.setContactOverride.mutateAsync({ contactId: c.id, field: 'do_not_contact', value: next, version: v })),
      onDone: () => {},
    });

  const name = c.name.value ?? 'Unnamed contact';
  const common = { version: c.version, sourceName: sourceLabel(c.source), layout: 'inline' as const };

  return (
    <Highlight as="li" k={`contact:${c.id}`} className={cn('px-4 py-4 sm:px-5', c.isTarget && 'bg-accent-soft/40')}>
      <div className="flex gap-3.5">
        <Avatar name={name} size={36} className={cn(dnc && 'opacity-50 grayscale')} />
        <div className="min-w-0 flex-1">
          <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
            <div className="min-w-0">
              <EditableValue
                {...common}
                label="Name"
                field={c.name}
                valueClassName={cn('font-semibold', dnc && 'line-through decoration-danger/60')}
                emptyText="Name unknown"
                validate={(raw) => validateContactField('name', raw)}
                onSave={saveField('name')}
                onRevert={revertField('name')}
              />
              <EditableValue
                {...common}
                label="Title"
                field={c.title}
                valueClassName="text-muted"
                emptyText="No title"
                validate={(raw) => validateContactField('title', raw)}
                onSave={saveField('title')}
                onRevert={revertField('title')}
              />
            </div>
            <div className="min-w-0">
              <EditableValue
                {...common}
                label="Email"
                field={c.email}
                inputType="email"
                emptyText="No email"
                validate={(raw) => validateContactField('email', raw)}
                renderValue={(v) => (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <Mail className="size-3.5 shrink-0 text-muted" aria-hidden />
                    {dnc ? <span className="break-all">{v}</span> : <a href={`mailto:${v}`} className="break-all text-accent hover:underline">{v}</a>}
                    {c.emailVerifiedAt && (
                      <Tooltip content={`Email verified ${formatDate(c.emailVerifiedAt)}`} describe={false}>
                        <span className="inline-flex"><BadgeCheck className="size-3.5 text-success" aria-label="Verified" /></span>
                      </Tooltip>
                    )}
                    <CopyButton value={v} label={`Copy ${name}'s email`} />
                  </span>
                )}
                onSave={saveField('email')}
                onRevert={revertField('email')}
              />
              <EditableValue
                {...common}
                label="Phone"
                field={c.phone}
                inputType="tel"
                emptyText="No direct phone"
                validate={(raw) => validateContactField('phone', raw)}
                renderValue={(v) => (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone className="size-3.5 shrink-0 text-muted" aria-hidden />
                    {dnc ? <span className="tabular">{v}</span> : <a href={telHref(v)} className="text-accent tabular hover:underline">{v}</a>}
                    <CopyButton value={v} label={`Copy ${name}'s phone`} />
                  </span>
                )}
                onSave={saveField('phone')}
                onRevert={revertField('phone')}
              />
            </div>
          </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1.5">
            {c.isTarget && <Badge variant="accent" icon={<Target aria-hidden />}>Ask for this person</Badge>}
            <SourceChip contact={c} />
            {!repAdded && <Confidence value={c.confidence} />}
            {dnc && <Badge variant="danger" icon={<Ban aria-hidden />}>Do not contact</Badge>}
            <div className="ml-auto flex items-center gap-2">
              <ReadOnlyHint reason={canEdit ? null : readOnlyReason}>
                <Toggle
                  size="sm"
                  checked={dnc}
                  disabled={!canEdit || dncWrite.busy}
                  onCheckedChange={(v) => void setDnc(v)}
                  label={<span className="text-xs text-muted">Do not contact</span>}
                />
              </ReadOnlyHint>
              {c.doNotContact.overridden && <EditedBadge by={c.doNotContact.editedBy?.name} at={c.doNotContact.editedAt} />}
              {repAdded && canEdit && (
                <IconButton size="sm" label={`Delete ${name}`} icon={<Trash2 />} onClick={() => setConfirming(true)} className="hover:text-danger" />
              )}
            </div>
          </div>
        </div>
      </div>
      {dncWrite.dialog}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        size="sm"
        title={`Delete ${name}?`}
        description="This removes the contact for everyone on the team. The timeline keeps a record of who deleted it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={m.deleteContact.isPending}
              onClick={() =>
                m.deleteContact.mutate({ contactId: c.id, version: c.version }, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success('Contact deleted', name);
                  },
                  onError: () => setConfirming(false),
                })
              }
            >
              Delete contact
            </Button>
          </>
        }
      />
    </Highlight>
  );
}

function SourceChip({ contact: c }: { contact: LeadContact }) {
  const label = sourceLabel(c.source);
  if (c.sourceUrl) {
    return (
      <Tooltip content={`Found on ${label}: open the source record`} describe={false}>
        <ExternalLink
          href={c.sourceUrl}
          icon
          className="inline-flex items-center text-xs text-muted hover:text-accent hover:underline"
          fallback={<span className="text-xs text-muted">{label}</span>}
        >
          {label}
        </ExternalLink>
      </Tooltip>
    );
  }
  return <span className="text-xs text-muted">{label}</span>;
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const level = value >= 0.8 ? 'High' : value >= 0.6 ? 'Medium' : 'Low';
  const bars = value >= 0.8 ? 3 : value >= 0.6 ? 2 : 1;
  return (
    <Tooltip content={`${level} confidence that this person works here (${pct}%)`} describe={false}>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        <span className="inline-flex items-end gap-0.5" aria-hidden="true">
          {[1, 2, 3].map((i) => (
            <span key={i} className={cn('w-1 rounded-sm', i === 1 ? 'h-1.5' : i === 2 ? 'h-2.5' : 'h-3.5', i <= bars ? 'bg-success' : 'bg-surface-3')} />
          ))}
        </span>
        {level} confidence · {pct}%
      </span>
    </Tooltip>
  );
}

// ---- add contact -------------------------------------------------------------------------------------------------

const TITLE_SUGGESTIONS = ['Owner', 'President', 'Office manager', 'Purchasing manager', 'Operations manager', 'Project manager', 'Estimator'];

interface ContactDraft {
  name: string;
  title: string;
  email: string;
  phone: string;
}
const EMPTY: ContactDraft = { name: '', title: '', email: '', phone: '' };

export function validateContactDraft(d: ContactDraft): Partial<Record<keyof ContactDraft, string>> {
  const errors: Partial<Record<keyof ContactDraft, string>> = {};
  if (!d.name.trim()) errors.name = 'Name is required.';
  else if (d.name.trim().length > 255) errors.name = 'Keep the name under 255 characters.';
  if (d.title.trim().length > 255) errors.title = 'Keep the title under 255 characters.';
  if (d.email.trim() && !isEmail(d.email)) errors.email = 'Enter a valid email address, like name@company.com.';
  if (d.phone.trim() && (!isPhone(d.phone) || d.phone.trim().length > 64)) errors.phone = 'Enter a phone number with at least 7 digits.';
  return errors;
}

function AddContactDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { m } = useProfile();
  const toast = useToast();
  const [draft, setDraft] = useState<ContactDraft>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof ContactDraft, string>>>({});
  const [submitted, setSubmitted] = useState(false);

  const close = () => {
    setDraft(EMPTY);
    setErrors({});
    setSubmitted(false);
    onClose();
  };
  const update = (k: keyof ContactDraft, v: string) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    if (submitted) setErrors(validateContactDraft(next));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const errs = validateContactDraft(draft);
    setErrors(errs);
    if (Object.keys(errs).length) {
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#add-contact-form [aria-invalid="true"]')?.focus());
      return;
    }
    m.addContact.mutate(
      { name: draft.name.trim(), title: draft.title.trim() || undefined, email: draft.email.trim() || undefined, phone: draft.phone.trim() || undefined },
      {
        onSuccess: () => {
          toast.success('Contact added', draft.name.trim());
          close();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add contact"
      description="Someone you have spoken with or found yourself. Visible to everyone who can see this lead."
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-contact-form" loading={m.addContact.isPending}>Add contact</Button>
        </>
      }
    >
      <form id="add-contact-form" noValidate onSubmit={submit} className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Name (required)" error={errors.name} className="sm:col-span-2">
          {(p) => (
            <Input {...p} value={draft.name} autoComplete="off"
              onChange={(e) => update('name', e.target.value)} placeholder="e.g. Maria Lopez" />
          )}
        </Field>
        <Field label="Title or role" error={errors.title} className="sm:col-span-2">
          {(p) => (
            <>
              <Input {...p} value={draft.title} list="add-contact-titles"
                onChange={(e) => update('title', e.target.value)} placeholder="e.g. Purchasing manager" />
              <datalist id="add-contact-titles">{TITLE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          )}
        </Field>
        <Field label="Email" error={errors.email}>
          {(p) => (
            <Input {...p} type="email" value={draft.email} autoComplete="off"
              onChange={(e) => update('email', e.target.value)} placeholder="name@company.com" />
          )}
        </Field>
        <Field label="Phone" error={errors.phone}>
          {(p) => (
            <Input {...p} type="tel" value={draft.phone} autoComplete="off"
              onChange={(e) => update('phone', e.target.value)} placeholder="(201) 555-0100" />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
