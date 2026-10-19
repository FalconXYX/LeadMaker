// Lead profile (route /leads/:id): a CRM record page. A sales header (stage, last contact, next follow-up, call / log
// call / email / follow-up), tabbed detail on the left (overview with next steps and AI insights, contacts, tags &
// fields, weather), the shared activity timeline on the right.
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, MapPinOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { NotFoundError } from '@/api/client';
import { invalidateLead, useLead } from '@/api/queries';
import type { LeadProfile } from '@/api/types';
import { useAuth } from '@/auth/AuthContext';
import { readOnlyReason } from '@/auth/permissions';
import { Card, EmptyState, ErrorState, Skeleton, SkeletonText, Tab, TabList, TabPanel, Tabs, buttonClasses } from '@/components/ui';
import { LogActivityDialog } from '@/features/tasks';
import { Page } from '@/layout/PageHeader';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { BusinessProfileCard, CompanyInfoCard, LocationCard } from './CompanyInfo';
import { ContactsCard, TargetContactCard } from './Contacts';
import { ProfileContext, type ProfileContextValue } from './context';
import { CustomFieldsCard } from './CustomFields';
import { InsightsCard } from './Insights';
import { NextStepsCard } from './NextSteps';
import { DoNotContactBanner, ProfileHeader, ReadOnlyBanner } from './ProfileHeader';
import { useLeadMutations } from './queries';
import { openTasks, salesOf } from './sales';
import { CustomTagsCard, SystemTagsCard } from './Tags';
import { ActivityPanel } from './Timeline';
import { useLiveLead } from './useLiveLead';
import { CountySignals, TimingCard } from './Weather';

const TABS = ['overview', 'contacts', 'tags', 'weather'] as const;
type TabKey = (typeof TABS)[number];

export function LeadProfilePage() {
  const { id } = useParams<{ id: string }>();
  const q = useLead(id);

  if (!id || q.error instanceof NotFoundError) return <LeadNotFound />;
  if (q.isPending) return <ProfileSkeleton />;
  if (!q.data) {
    return (
      <Page>
        <Card><ErrorState message={q.error instanceof Error ? q.error.message : 'Something went wrong.'} onRetry={() => void q.refetch()} /></Card>
      </Page>
    );
  }
  return <ProfileView key={q.data.id} profile={q.data} />;
}

function ProfileView({ profile }: { profile: LeadProfile }) {
  const { user, canWrite } = useAuth();
  const m = useLeadMutations(profile.id);
  const highlights = useLiveLead(profile.id, profile, user?.id);
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const tabsRef = useRef<HTMLDivElement>(null);
  const [logging, setLogging] = useState(false);
  const [adding, setAdding] = useState(false);
  const nothingScheduled = !adding && openTasks(salesOf(profile).tasks).length === 0;
  const raw = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(raw ?? '') ? (raw as TabKey) : 'overview';
  const name = profile.fields.business_name.value ?? 'Lead';

  useDocumentTitle(name);

  const setTab = (next: string) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (next === 'overview') n.delete('tab');
      else n.set('tab', next);
      return n;
    }, { replace: true });
  };

  const ctx: ProfileContextValue = {
    profile,
    canEdit: canWrite(profile),
    readOnlyReason: readOnlyReason(user, profile),
    m,
    meId: user?.id,
    isHighlighted: (k) => highlights.has(k),
    openTab: (t) => {
      setTab(t);
      tabsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    },
  };

  const addFollowUp = () => {
    setTab('overview');
    setAdding(true);
    requestAnimationFrame(() => document.getElementById('next-steps')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }));
  };

  return (
    <ProfileContext value={ctx}>
      <Page wide>
        <nav aria-label="Breadcrumb" className="mb-4">
          <ol className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
            <li><Link to="/leads" className="hover:text-fg hover:underline">Leads</Link></li>
            <li aria-hidden="true"><ChevronRight className="size-3.5" /></li>
            <li aria-current="page" className="truncate text-fg">{name}</li>
          </ol>
        </nav>
        <ReadOnlyBanner />
        <DoNotContactBanner />
        <ProfileHeader onLogCall={() => setLogging(true)} onAddFollowUp={addFollowUp} />
        <LogActivityDialog
          leadId={profile.id}
          leadName={name}
          defaultType="call"
          open={logging}
          onOpenChange={setLogging}
          onDone={() => void invalidateLead(qc, profile.id)}
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-7 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div ref={tabsRef} className="min-w-0 scroll-mt-20">
            <Tabs value={tab} onValueChange={setTab}>
              <TabList aria-label="Lead sections" className="mb-5">
                <Tab value="overview">Overview</Tab>
                <Tab value="contacts" count={profile.contacts.length}>Contacts</Tab>
                <Tab value="tags">
                  <span className="sm:hidden">Tags</span>
                  <span className="hidden sm:inline">Tags &amp; fields</span>
                </Tab>
                <Tab value="weather">Weather</Tab>
              </TabList>
              <TabPanel value="overview" className="space-y-6">
                {/* With nothing scheduled, the pitch comes first: on a phone the empty card pushed it below the fold. */}
                {nothingScheduled && <InsightsCard />}
                <NextStepsCard adding={adding} onAddingChange={setAdding} />
                {!nothingScheduled && <InsightsCard />}
                <CompanyInfoCard />
                <div className="grid items-start gap-6 xl:grid-cols-2">
                  <BusinessProfileCard />
                  <LocationCard />
                </div>
              </TabPanel>
              <TabPanel value="contacts" className="space-y-6">
                <TargetContactCard />
                <ContactsCard />
              </TabPanel>
              <TabPanel value="tags" className="space-y-6">
                <CustomTagsCard />
                <CustomFieldsCard />
                <SystemTagsCard />
              </TabPanel>
              <TabPanel value="weather" className="space-y-6">
                <TimingCard />
                <CountySignals />
              </TabPanel>
            </Tabs>
          </div>
          <aside aria-label="Activity and notes" className="min-w-0 lg:sticky lg:top-6 lg:self-start">
            <ActivityPanel />
          </aside>
        </div>
      </Page>
    </ProfileContext>
  );
}

function LeadNotFound() {
  const { isManager } = useAuth();
  useDocumentTitle('Lead not found');
  return (
    <Page>
      <Card>
        <EmptyState
          icon={<MapPinOff />}
          title={isManager ? 'This lead doesn’t exist' : 'This lead isn’t in your territory'}
          description={isManager
            ? 'It may have been removed from the directory, or the link is out of date.'
            : 'It may be allocated to another rep, or it no longer exists. You can open your own leads and the unallocated pool.'}
          action={<Link to="/leads" className={buttonClasses('primary')}>Back to leads</Link>}
        />
      </Card>
    </Page>
  );
}

function ProfileSkeleton() {
  return (
    <Page wide>
      <div role="status" aria-label="Loading lead">
        <Skeleton className="mb-4 h-4 w-48" />
        <Card className="mb-6 p-5 sm:p-6">
          <div className="flex gap-4">
            <Skeleton className="size-14 rounded-xl" />
            <div className="flex-1 space-y-2.5">
              <Skeleton className="h-7 w-2/5" />
              <div className="flex gap-1.5"><Skeleton className="h-5 w-16 rounded-full" /><Skeleton className="h-5 w-20 rounded-full" /><Skeleton className="h-5 w-28 rounded-full" /></div>
              <Skeleton className="h-4 w-3/5" />
            </div>
            <Skeleton className="hidden h-20 w-64 rounded-xl md:block" />
          </div>
          <div className="mt-5 grid gap-4 border-t border-border pt-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="space-y-2"><Skeleton className="h-3 w-16" /><Skeleton className="h-4 w-32" /></div>)}
          </div>
        </Card>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-7 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-6">
            <Skeleton className="h-8 w-80" />
            <Card className="p-4 sm:p-5"><SkeletonText lines={3} /></Card>
            <Card className="p-4 sm:p-5"><SkeletonText lines={6} /></Card>
          </div>
          <Card className="p-4 sm:p-5"><Skeleton className="mb-3 h-20" /><SkeletonText lines={8} /></Card>
        </div>
        <span className="sr-only">Loading lead…</span>
      </div>
    </Page>
  );
}
