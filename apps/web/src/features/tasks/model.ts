import { CheckSquare, Mail, MapPin, Phone, type LucideIcon } from 'lucide-react';
import type { ActivityKind, TaskType } from './api';
import type { DuePreset } from './dates';

export { TASK_TYPES } from '@/lib/labels';
export const ACTIVITY_KINDS = ['call', 'email', 'visit'] as const satisfies readonly ActivityKind[];

export const TASK_TYPE_META: Record<TaskType, { label: string; icon: LucideIcon; tone: string }> = {
  call: { label: 'Call', icon: Phone, tone: 'bg-accent-soft text-accent' },
  email: { label: 'Email', icon: Mail, tone: 'bg-info-soft text-info' },
  visit: { label: 'Visit', icon: MapPin, tone: 'bg-stage-interested-soft text-stage-interested' },
  todo: { label: 'To-do', icon: CheckSquare, tone: 'bg-surface-3 text-muted' },
};

/** The activity a follow-up of this type is logged as (a to-do is usually a call). */
export const activityKindOf = (type: TaskType): ActivityKind => (type === 'todo' ? 'call' : type);

export const OUTCOMES: Record<ActivityKind, readonly string[]> = {
  call: ['Connected', 'Left voicemail', 'No answer', 'Wrong number'],
  email: ['Sent', 'Replied', 'No reply', 'Bounced'],
  visit: ['Met decision-maker', 'Dropped off samples', 'Left materials', 'No one available'],
};

export interface FollowUpSuggestion {
  title: string;
  type: TaskType;
  when: DuePreset;
}

const SUGGESTIONS: Record<string, FollowUpSuggestion> = {
  Connected: { title: 'Follow up on our call', type: 'call', when: 'nextWeek' },
  'Left voicemail': { title: 'Call back (left a voicemail)', type: 'call', when: 'in3' },
  'No answer': { title: 'Try calling again', type: 'call', when: 'tomorrow' },
  'Wrong number': { title: 'Find the right phone number', type: 'todo', when: 'tomorrow' },
  Sent: { title: 'Call about the email I sent', type: 'call', when: 'in3' },
  Replied: { title: 'Answer their reply', type: 'email', when: 'tomorrow' },
  'No reply': { title: 'Chase the email with a call', type: 'call', when: 'in3' },
  Bounced: { title: 'Find a working email address', type: 'todo', when: 'tomorrow' },
  'Met decision-maker': { title: 'Follow up on the visit', type: 'call', when: 'in3' },
  'Dropped off samples': { title: 'Check in about the samples', type: 'call', when: 'in3' },
  'Left materials': { title: 'Follow up on the materials I left', type: 'call', when: 'in3' },
  'No one available': { title: 'Visit again', type: 'visit', when: 'nextWeek' },
};

const BY_KIND: Record<ActivityKind, FollowUpSuggestion> = {
  call: { title: 'Follow-up call', type: 'call', when: 'in3' },
  email: { title: 'Follow up on my email', type: 'call', when: 'in3' },
  visit: { title: 'Follow up on the visit', type: 'call', when: 'in3' },
};

/** The next step a logged outcome suggests: its title, how to reach out, and when. */
export function suggestFollowUp(kind: ActivityKind, outcome: string | null): FollowUpSuggestion {
  return (outcome && SUGGESTIONS[outcome]) || BY_KIND[kind];
}

export const NOTE_PLACEHOLDERS: Record<ActivityKind, string> = {
  call: 'Who you spoke to, what they need, prices or products discussed…',
  email: 'What you sent or what they replied…',
  visit: 'Who you met, what you saw on site, samples left…',
};

/** "a call", "an email", "a visit". */
export const withArticle = (kind: ActivityKind) => (kind === 'email' ? 'an email' : `a ${kind}`);

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 && !/[a-z]/i.test(phone) ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : phone;
}
