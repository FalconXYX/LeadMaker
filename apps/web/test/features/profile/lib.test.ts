import { describe, expect, it } from 'vitest';
import { contact, entry, field, makeProfile, task } from './fixtures';
import {
  FEED_FILTERS, activityView, applyTagEvent, askFor, decodeEntities, describeLiveEvent, fieldSource, formatValue, priorityDrivers,
  profileChanges, slugifyKey, targetRule, validateCompanyField, validateContactField, whyNow,
} from '@/features/profile/lib';

const ctx = {
  contactName: (id: string) => (id === 'c1' ? 'Eileen Cawley' : null),
  userName: (id: string) => ({ r1: 'Jordan Lee', r2: 'Sam Rivera' })[id] ?? null,
};

describe('activityView', () => {
  it('describes pipeline field diffs, delistings and legacy {field: [old, new]} rows', () => {
    const v = activityView(entry({
      id: '1', type: 'scraped_change', actorType: 'pipeline', user: null, actorLabel: 'pipeline',
      fieldDiff: { fields: ['phone'], from: { phone: '212 555 0100' }, to: { phone: '718 555 0199' }, run_id: 3 },
    }), ctx);
    expect(v).toMatchObject({ kind: 'pipeline', actor: 'Data pipeline', action: 'updated phone from the source' });
    expect(v.diffs).toEqual([{ field: 'phone', label: 'Phone', from: '212 555 0100', to: '718 555 0199' }]);

    const delisted = activityView(entry({
      id: '2', type: 'scraped_change', actorType: 'pipeline', user: null, actorLabel: 'pipeline',
      fieldDiff: { fields: ['delisted'], from: { delisted: false }, to: { delisted: true }, area: '10013@25mi', run_id: 4 },
    }), ctx);
    expect(delisted.action).toBe('found this contractor delisted');
    expect(delisted.body).toBe('No longer in the source listing for 10013 within 25mi.');

    const legacy = activityView(entry({ id: '3', type: 'scraped_change', actorType: 'pipeline', user: null, actorLabel: 'pipeline', fieldDiff: { rating: [4.5, 4.6] } }), ctx);
    expect(legacy.diffs).toEqual([{ field: 'rating', label: 'Rating', from: '4.5', to: '4.6' }]);
  });

  it('lists contacts the pipeline added and removed', () => {
    const v = activityView(entry({
      id: '4', type: 'scraped_change', actorType: 'pipeline', user: null, actorLabel: 'pipeline',
      fieldDiff: { fields: ['contacts'], from: { contacts: [{ name: 'A', title: 'Owner' }] }, to: { contacts: [{ name: 'B', title: 'Buyer' }] } },
    }), ctx);
    expect(v.diffs.map((d) => [d.label, d.from, d.to])).toEqual([['New contact', '—', 'B · Buyer'], ['Removed contact', 'A · Owner', '—']]);
  });

  it('names contacts, reps and tags in user rows', () => {
    expect(activityView(entry({ id: '5', type: 'override', fieldDiff: { email: [null, 'e@x.com'], contact_id: 'c1' } }), ctx).action)
      .toBe('edited Eileen Cawley’s email');
    expect(activityView(entry({ id: '6', type: 'override', fieldDiff: { phone: ['1', '2'], cleared: true } }), ctx).action)
      .toBe('reverted Phone to the source value');
    expect(activityView(entry({ id: '7', type: 'allocation', fieldDiff: { assigned_rep_id: ['r2', 'r1'] } }), ctx).action)
      .toBe('reassigned this lead from Sam Rivera to Jordan Lee');
    expect(activityView(entry({ id: '8', type: 'allocation', fieldDiff: { assigned_rep_id: ['r1', null] } }), ctx).action)
      .toBe('moved this lead to the unallocated pool (was Jordan Lee)');
    expect(activityView(entry({ id: '9', type: 'custom_tag', fieldDiff: { custom_tag: [null, { id: 't', name: 'Hot' }] } }), ctx).action)
      .toBe('added tag “Hot”');
    expect(activityView(entry({ id: '10', type: 'custom_field', fieldDiff: { 'custom_fields.crew_size': [null, 12] } }), ctx))
      .toMatchObject({ action: 'added Crew size', diffs: [{ label: 'Crew size', from: '—', to: '12' }] });
    expect(activityView(entry({ id: '11', type: 'call', outcome: 'Connected', text: 'Wants a quote' }), ctx))
      .toMatchObject({ kind: 'call', action: 'logged a call', outcome: 'Connected', body: 'Wants a quote' });
    expect(activityView(entry({ id: '12', type: 'checked', fieldDiff: { checked_at: ['2026-01-01', null] } }), ctx).action).toBe('cleared checked');
    expect(activityView(entry({ id: '13', type: 'something_new' }), ctx).action).toBe('something new');
  });

  it('describes stage changes, including the automatic one a logged call makes', () => {
    expect(activityView(entry({ id: 's1', type: 'stage_changed', fieldDiff: { sales_stage: ['contacted', 'quoting'] } }), ctx))
      .toMatchObject({ kind: 'stage', action: 'moved this lead from Contacted to Quoting', outcome: null });
    expect(activityView(entry({ id: 's2', type: 'stage_changed', fieldDiff: { sales_stage: ['quoting', 'lost'] } }), ctx).action)
      .toBe('moved this lead from Quoting to Not a fit');
    expect(activityView(entry({ id: 's3', type: 'stage_changed', fieldDiff: { sales_stage: ['new', 'contacted'], auto: true } }), ctx))
      .toMatchObject({ action: 'moved this lead from New to Contacted', outcome: 'Automatically, when contact was logged' });
  });

  it('describes follow-up task events from TaskActivityDiff', () => {
    const base = { task_id: 't1', title: 'Call Mike about underlayment', type: 'call', assignee_id: 'r1' };
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setHours(9, 0, 0, 0);
    expect(activityView(entry({ id: 'k1', type: 'task_created', fieldDiff: { ...base, due_at: tomorrow.toISOString() } }), ctx))
      .toMatchObject({ kind: 'task', action: 'added a call follow-up for Tomorrow', body: 'Call Mike about underlayment' });
    expect(activityView(entry({ id: 'k2', type: 'task_completed', fieldDiff: { ...base, due_at: tomorrow.toISOString(), changes: { done_at: [null, 'x'] } } }), ctx).action)
      .toBe('completed a call follow-up');
    expect(activityView(entry({
      id: 'k3', type: 'task_updated',
      fieldDiff: { ...base, due_at: tomorrow.toISOString(), changes: { due_at: ['2026-01-01T09:00:00Z', tomorrow.toISOString()] } },
    }), ctx).action).toBe('moved a call follow-up to Tomorrow');
    expect(activityView(entry({ id: 'k4', type: 'task_updated', fieldDiff: { ...base, due_at: tomorrow.toISOString(), changes: { title: ['a', 'b'] } } }), ctx).action)
      .toBe('updated a call follow-up');
    expect(activityView(entry({ id: 'k5', type: 'task_deleted', fieldDiff: null }), ctx)).toMatchObject({ action: 'removed a follow-up', body: null });
  });

  it('offers the five timeline filters, each a server-side type list', () => {
    expect(FEED_FILTERS.map((f) => f.label)).toEqual(['All', 'Calls & visits', 'Notes', 'Follow-ups', 'Changes']);
    expect(FEED_FILTERS.find((f) => f.key === 'followups')!.types).toEqual(['task_created', 'task_completed', 'task_updated', 'task_deleted']);
    expect(FEED_FILTERS.find((f) => f.key === 'changes')!.types).toContain('stage_changed');
  });
});

describe('helpers', () => {
  it('parses the priority drivers tag', () => {
    expect(priorityDrivers(makeProfile().systemTags)).toEqual([{ label: 'GAF tier', points: 25 }, { label: 'Review volume', points: 17 }]);
  });

  it('applies the size rule for the target contact', () => {
    expect(targetRule('small')).toBe('small');
    expect(targetRule('medium')).toBe('larger');
    expect(targetRule(null)).toBeNull();
  });

  it('reads what the strongest weather signal means for the contractor’s work type', () => {
    const w = whyNow(makeProfile())!;
    expect(w.badge.key).toBe('recent_storm');
    expect(w.implication).toBe('They do storm and emergency repair, so expect demand for repair materials.');
    expect(whyNow(makeProfile({ timing: [] }))).toBeNull();
  });

  it('picks who to ask for, with their own phone or the main line', () => {
    expect(askFor(makeProfile())).toMatchObject({
      contactId: 'c1', name: 'Eileen Cawley', role: 'Purchasing manager', title: 'Buyer', phone: '(201) 444-2233', mainLine: true, email: null,
    });
    const direct = makeProfile({ contacts: [contact({ id: 'c1', isTarget: true, phone: field<string | null>('(201) 555-0101'), email: field<string | null>('e@h.com') })] });
    expect(askFor(direct)).toMatchObject({ phone: '(201) 555-0101', mainLine: false, email: 'e@h.com' });
    expect(askFor(makeProfile({ contacts: [], targetContact: null })).name).toBeNull();
  });

  it('validates overridable fields like crm-write does', () => {
    expect(validateCompanyField('business_name', '  ')).toMatch(/required/);
    expect(validateCompanyField('website_url', 'example.com')).toBeNull();
    expect(validateCompanyField('website_url', 'not a url')).toMatch(/web address/);
    expect(validateCompanyField('phone', '12')).toMatch(/phone/);
    expect(validateCompanyField('state', 'New Jersey')).toMatch(/under 8/);
    expect(validateContactField('email', 'nope')).toMatch(/valid email/);
    expect(validateContactField('email', '')).toBeNull();
  });

  it('formats values, keys and entities', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(true)).toBe('Yes');
    expect(formatValue(['a', 'b'])).toBe('a, b');
    expect(slugifyKey('Crew size (est.)')).toBe('crew_size_est');
    expect(slugifyKey('2nd supplier')).toBe('nd_supplier');
    expect(decodeEntities('Since &quot;1930&quot; &amp; &#39;on&#x27;')).toBe('Since "1930" & \'on\'');
    expect(fieldSource(makeProfile(), 'website_url')).toBe('Web search');
    expect(fieldSource(makeProfile(), 'phone')).toBe('GAF');
  });

  it('diffs two profile versions into highlight keys', () => {
    const a = makeProfile();
    const b = makeProfile({ customFields: { crew_size: 8 }, contacts: [contact({ id: 'c1', isTarget: true, version: 2 })] });
    b.fields.city = field<string | null>('Glen Rock');
    expect([...profileChanges(a, b)].sort()).toEqual(['cf:crew_size', 'contact:c1', 'field:city']);
    expect(profileChanges(a, makeProfile()).size).toBe(0);
    expect([...profileChanges(a, makeProfile({ salesStage: 'quoting' }))]).toEqual(['stage']);
    const t = task({ id: 't1' });
    expect([...profileChanges(makeProfile({ tasks: [t] }), makeProfile({ tasks: [{ ...t, doneAt: '2026-10-18T10:00:00Z', version: 2 }] }))])
      .toEqual(['tasks']);
  });

  it('describes live events for the toast', () => {
    expect(describeLiveEvent('override.set', { field: 'phone' })).toBe('Edited Phone');
    expect(describeLiveEvent('override.set', { field: 'email', contact_id: 'c1', cleared: true })).toBe('Reverted a contact’s email');
    expect(describeLiveEvent('state.changed', { activity_type: 'visit' })).toBe('Logged a visit');
    expect(describeLiveEvent('tags.changed', { tag_name: 'Hot', added: false })).toBe('Removed tag “Hot”');
    expect(describeLiveEvent('lead.updated', { fields: ['custom_fields.crew_size'] })).toBe('Updated Crew size');
    expect(describeLiveEvent('tags.changed', { tag_name: 'Hot lead', previous_name: 'Hot', renamed: true })).toBe('Renamed tag “Hot” to “Hot lead”');
    expect(describeLiveEvent('tags.changed', { tag_name: 'Hot', added: false, deleted: true })).toBe('Deleted tag “Hot” for everyone');
    expect(describeLiveEvent('lead.updated', { fields: ['tasks'], task_action: 'completed', task_title: 'Call Mike' })).toBe('Completed a follow-up “Call Mike”');
    expect(describeLiveEvent('lead.updated', { fields: ['tasks'], task_action: 'created' })).toBe('Added a follow-up');
    expect(describeLiveEvent('lead.updated', { fields: ['sales_stage'], sales_stage: 'won' })).toBe('Moved this lead to Won');
    expect(describeLiveEvent('lead.updated', { fields: ['sales_stage'] })).toBe('Changed the stage');
  });

  it('applies tag renames and deletes to the chips, and leaves other tags alone', () => {
    const tag = { id: 't1', name: 'Hot', addedBy: { id: 'r1', name: 'Jordan Lee' }, addedAt: '2026-10-18T00:00:00Z' };
    const p = makeProfile({ customTags: [tag] });
    expect(applyTagEvent(p, { tag_id: 't1', tag_name: 'Hot lead', renamed: true }).customTags).toEqual([{ ...tag, name: 'Hot lead' }]);
    expect(applyTagEvent(p, { tag_id: 't1', tag_name: 'Hot', deleted: true }).customTags).toEqual([]);
    expect(applyTagEvent(p, { tag_id: 'other', deleted: true })).toBe(p);
    expect(applyTagEvent(p, { tag_id: 't1', tag_name: 'Hot', added: true })).toBe(p);
    // A rename alone is a change worth highlighting.
    expect(profileChanges(p, applyTagEvent(p, { tag_id: 't1', tag_name: 'Hot lead', renamed: true })).has('tags')).toBe(true);
  });
});
