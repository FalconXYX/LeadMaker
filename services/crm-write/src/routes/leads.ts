import { Router } from 'express';
import { Prisma } from '@leadmaker/db';
import { z } from 'zod';
import {
  SALES_STAGES, type ActivityLogged, type NoteCreated, type SalesStage, type StageChanged, type StateChanged,
} from '@leadmaker/shared';
import { actorOf, type Actor } from '../auth.ts';
import { badRequest, parse } from '../http.ts';
import { conflict, emit, lockLead, logActivity, type LeadRow, type Tx } from '../tx.ts';
import type { Deps } from '../app.ts';

const noteText = z.string().trim().min(1).max(10_000);
const noteBody = z.object({ text: noteText });
const activityBody = z.object({
  type: z.enum(['call', 'email', 'visit']),
  outcome: z.string().trim().min(1).max(50).optional(),
  note: noteText.optional(),
});
const stateBody = z.object({ checked: z.boolean().optional(), serviced: z.boolean().optional() });
const stageBody = z.object({ stage: z.enum(SALES_STAGES), version: z.int().positive() }).strict();

type StateRow = { checked_at: Date | null; serviced_at: Date | null };
type TeamRow = { team_last_checked_at: Date | null; team_last_serviced_at: Date | null };

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Upserts the actor's lead_rep_state (true = now, false = clear, undefined = keep) and recomputes
 * companies.team_last_* from every user's state in the same transaction, so clearing one user's
 * mark falls back to the next most recent. The caller holds the company row lock.
 */
async function setState(tx: Tx, actor: Actor, lead: LeadRow, change: { checked?: boolean; serviced?: boolean }) {
  const [before] = await tx.$queryRaw<StateRow[]>(Prisma.sql`
    SELECT checked_at, serviced_at FROM lead_rep_state WHERE company_id = ${lead.id}::uuid AND user_id = ${actor.id}::uuid`);
  const insert = (v?: boolean) => (v ? Prisma.sql`now()` : Prisma.sql`NULL`);
  const update = (v: boolean | undefined, col: Prisma.Sql) => (v === undefined ? col : insert(v));
  const [after] = await tx.$queryRaw<StateRow[]>(Prisma.sql`
    INSERT INTO lead_rep_state (company_id, user_id, checked_at, serviced_at, updated_at)
    VALUES (${lead.id}::uuid, ${actor.id}::uuid, ${insert(change.checked)}, ${insert(change.serviced)}, now())
    ON CONFLICT (company_id, user_id) DO UPDATE SET
      checked_at = ${update(change.checked, Prisma.sql`lead_rep_state.checked_at`)},
      serviced_at = ${update(change.serviced, Prisma.sql`lead_rep_state.serviced_at`)},
      updated_at = now()
    RETURNING checked_at, serviced_at`);
  const [team] = await tx.$queryRaw<TeamRow[]>(Prisma.sql`
    UPDATE companies c SET team_last_checked_at = s.checked, team_last_serviced_at = s.serviced
    FROM (SELECT max(checked_at) AS checked, max(serviced_at) AS serviced
          FROM lead_rep_state WHERE company_id = ${lead.id}::uuid) s
    WHERE c.id = ${lead.id}::uuid
    RETURNING c.team_last_checked_at, c.team_last_serviced_at`);
  const lmc = lead.last_material_change_at;
  const state = {
    checked: after.checked_at !== null && (lmc === null || after.checked_at >= lmc),
    serviced: after.serviced_at !== null,
    checkedAt: iso(after.checked_at),
    servicedAt: iso(after.serviced_at),
  };
  return {
    before: before ?? { checked_at: null, serviced_at: null },
    state,
    team: { lastCheckedAt: iso(team.team_last_checked_at), lastServicedAt: iso(team.team_last_serviced_at) },
  };
}

type StageRow = { sales_stage: SalesStage; stage_changed_at: Date | null; version: number };

/** The stage_changed activity row and lead.updated event of a stage change the caller just wrote (version + 1). */
async function recordStage(tx: Tx, actor: Actor, lead: LeadRow, row: StageRow, auto?: { activityId: string }): Promise<void> {
  await logActivity(tx, actor, lead.id, 'stage_changed', {
    fieldDiff: { sales_stage: [lead.sales_stage, row.sales_stage], ...(auto ? { auto: true, activity_id: auto.activityId } : {}) },
  });
  await emit(tx, actor, 'lead.updated', lead.id, {
    fields: ['sales_stage'], sales_stage: row.sales_stage, previous_stage: lead.sales_stage,
    assigned_rep_id: lead.assigned_rep_id, version: row.version,
  });
}

function stateEvent(actor: Actor, lead: LeadRow, s: Awaited<ReturnType<typeof setState>>) {
  return {
    user_id: actor.id,
    checked: s.state.checked,
    serviced: s.state.serviced,
    checked_at: s.state.checkedAt,
    serviced_at: s.state.servicedAt,
    team_last_checked_at: s.team.lastCheckedAt,
    team_last_serviced_at: s.team.lastServicedAt,
    assigned_rep_id: lead.assigned_rep_id,
    version: lead.version,
  };
}

export function leadRoutes({ write }: Deps): Router {
  const r = Router();

  // Notes are append-only activity rows (action_type 'note'): they cannot conflict and stay with
  // the lead on reassignment. They do not bump the lead version.
  r.post('/leads/:id/notes', async (req, res) => {
    const actor = actorOf(res);
    const { text } = parse(noteBody, req.body);
    const note = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'share');
      const row = await logActivity(tx, actor, lead.id, 'note', { noteText: text });
      await emit(tx, actor, 'note.added', lead.id, {
        note_id: row.id, assigned_rep_id: lead.assigned_rep_id, version: lead.version,
      });
      return {
        id: row.id, companyId: lead.id, text, userId: actor.id, userName: actor.name, createdAt: row.created_at.toISOString(),
      };
    });
    res.status(201).json({ note } satisfies NoteCreated);
  });

  // A logged call, email or visit marks the lead serviced for the actor (and the team), sets last_contacted_at (no
  // version bump) and moves a new lead to contacted (a stage change: version bump, its own activity row and event).
  r.post('/leads/:id/activities', async (req, res) => {
    const actor = actorOf(res);
    const body = parse(activityBody, req.body);
    const out = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'update');
      const row = await logActivity(tx, actor, lead.id, body.type, { outcome: body.outcome, noteText: body.note });
      const s = await setState(tx, actor, lead, { serviced: true });
      const advance = lead.sales_stage === 'new';
      const [after] = await tx.$queryRaw<(StageRow & { last_contacted_at: Date })[]>(Prisma.sql`
        UPDATE companies SET last_contacted_at = GREATEST(last_contacted_at, ${row.created_at}::timestamptz)
          ${advance ? Prisma.sql`, sales_stage = 'contacted', stage_changed_at = clock_timestamp(), version = version + 1` : Prisma.empty}
        WHERE id = ${lead.id}::uuid RETURNING sales_stage, stage_changed_at, version, last_contacted_at`);
      await emit(tx, actor, 'state.changed', lead.id, {
        ...stateEvent(actor, lead, s), activity_id: row.id, activity_type: body.type, version: after.version,
      });
      if (advance) await recordStage(tx, actor, lead, after, { activityId: row.id });
      return {
        activity: {
          id: row.id, companyId: lead.id, type: body.type, outcome: body.outcome ?? null, note: body.note ?? null,
          userId: actor.id, userName: actor.name, createdAt: row.created_at.toISOString(),
        },
        state: s.state,
        team: s.team,
        salesStage: after.sales_stage,
        stageChangedAt: iso(after.stage_changed_at),
        lastContactedAt: after.last_contacted_at.toISOString(),
        version: after.version,
      } satisfies ActivityLogged;
    });
    res.status(201).json(out);
  });

  // Moves the lead through the sales pipeline, optimistic-locked on the lead version; the same stage is a no-op.
  r.put('/leads/:id/stage', async (req, res) => {
    const actor = actorOf(res);
    const body = parse(stageBody, req.body);
    const out = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'update');
      if (lead.version !== body.version) throw await conflict(tx, { companyId: lead.id }, { stage: lead.sales_stage });
      if (lead.sales_stage === body.stage) {
        const [cur] = await tx.$queryRaw<{ stage_changed_at: Date | null }[]>(Prisma.sql`
          SELECT stage_changed_at FROM companies WHERE id = ${lead.id}::uuid`);
        return { stage: lead.sales_stage, version: lead.version, stageChangedAt: iso(cur.stage_changed_at) };
      }
      const [row] = await tx.$queryRaw<StageRow[]>(Prisma.sql`
        UPDATE companies SET sales_stage = ${body.stage}, stage_changed_at = clock_timestamp(), version = version + 1
        WHERE id = ${lead.id}::uuid RETURNING sales_stage, stage_changed_at, version`);
      await recordStage(tx, actor, lead, row);
      return { stage: row.sales_stage, version: row.version, stageChangedAt: iso(row.stage_changed_at) } satisfies StageChanged;
    });
    res.json(out);
  });

  r.post('/leads/:id/state', async (req, res) => {
    const actor = actorOf(res);
    const change = parse(stateBody, req.body);
    if (change.checked === undefined && change.serviced === undefined) throw badRequest('nothing_to_change');
    const out = await write(actor, async (tx) => {
      const lead = await lockLead(tx, req.params.id, actor, 'update');
      const s = await setState(tx, actor, lead, change);
      if (change.checked !== undefined) {
        await logActivity(tx, actor, lead.id, 'checked', {
          fieldDiff: { checked_at: [iso(s.before.checked_at), s.state.checkedAt] },
        });
      }
      if (change.serviced !== undefined) {
        await logActivity(tx, actor, lead.id, 'serviced', {
          fieldDiff: { serviced_at: [iso(s.before.serviced_at), s.state.servicedAt] },
        });
      }
      await emit(tx, actor, 'state.changed', lead.id, stateEvent(actor, lead, s));
      return { state: s.state, team: s.team } satisfies StateChanged;
    });
    res.json(out);
  });

  return r;
}
