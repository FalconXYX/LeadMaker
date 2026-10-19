import { Building2, FileText, MapPin, Navigation } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { CompanyOverrideField } from '@/api/types';
import { Badge, ExternalLink, Skeleton } from '@/components/ui';
import { formatDate, humanize } from '@/lib/format';
import { countyFullName } from '@/lib/counties';
import { CERTIFICATION_LABELS, COMPANY_OVERRIDE_FIELDS } from '@/lib/labels';
import { useProfile } from './context';
import { EditableValue } from './EditableValue';
import {
  decodeEntities, displayUrl, fieldLabel, fieldSource, mapsUrl, normalizeUrl, sourceLabel, telHref,
  validateCompanyField,
} from './lib';
import { CopyButton, Fact, Muted, SectionCard } from './ui';

const LocationMap = lazy(() => import('./LocationMap'));

export function CompanyInfoCard() {
  const { profile, m } = useProfile();
  const overridden = COMPANY_OVERRIDE_FIELDS.filter((f) => profile.fields[f].overridden).length;
  return (
    <SectionCard
      id="company-info"
      title="Company info"
      icon={<Building2 />}
      description="Rep edits override scraped data and are kept when sources refresh."
      actions={overridden > 0 ? <Badge variant="edited">{overridden} edited</Badge> : undefined}
      bodyClassName="px-4 py-2 sm:px-5 sm:py-2.5"
    >
      <dl className="divide-y divide-border">
        {COMPANY_OVERRIDE_FIELDS.map((f) => (
          <EditableValue
            key={f}
            label={fieldLabel(f)}
            field={profile.fields[f]}
            version={profile.version}
            highlightKey={`field:${f}`}
            inputType={f === 'phone' ? 'tel' : f === 'website_url' ? 'url' : 'text'}
            validate={(raw) => validateCompanyField(f, raw)}
            normalize={f === 'website_url' ? (raw) => (raw.trim() ? normalizeUrl(raw.trim()) : null) : undefined}
            renderValue={renderer(f)}
            sourceName={fieldSource(profile, f)}
            onSave={(value, version) => m.setOverride.mutateAsync({ field: f, value, version })}
            onRevert={(version) => m.clearOverride.mutateAsync({ field: f, version })}
          />
        ))}
      </dl>
    </SectionCard>
  );
}

function renderer(field: CompanyOverrideField): ((v: string) => ReactNode) | undefined {
  switch (field) {
    case 'phone':
      return (v) => (
        <span className="inline-flex items-center gap-1">
          <a href={telHref(v)} className="text-accent tabular hover:underline">{v}</a>
          <CopyButton value={v} label="Copy phone number" />
        </span>
      );
    case 'website_url':
      return (v) => (
        <ExternalLink href={normalizeUrl(v)} icon className="break-all text-accent hover:underline">
          {displayUrl(v)}
        </ExternalLink>
      );
    case 'address':
      return (v) => (
        <span className="inline-flex items-center gap-1">
          <span>{v}</span>
          <CopyButton value={v} label="Copy address" />
        </span>
      );
    default:
      return undefined;
  }
}

export function BusinessProfileCard() {
  const { profile } = useProfile();
  const d = profile.details;
  const [expanded, setExpanded] = useState(false);
  const description = d.description ? decodeEntities(d.description).trim() : null;
  const long = (description?.length ?? 0) > 280;
  const distinctions = [...new Set([...d.certifications, ...d.distinctions].filter((x): x is string => typeof x === 'string'))];
  const specialties = d.specialties.filter((x): x is string => typeof x === 'string');
  const tier = d.tier ? CERTIFICATION_LABELS[`gaf:${d.tier}` as keyof typeof CERTIFICATION_LABELS] ?? humanize(d.tier) : null;

  return (
    <SectionCard title="Business profile" icon={<FileText />} description="From GAF and public records. Read only.">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4.5">
        <Fact label="Legal name">{d.legalName ?? <Muted>Not found</Muted>}</Fact>
        <Fact label="DBA">{d.dba ?? <Muted>None listed</Muted>}</Fact>
        <Fact label="Contractor type">{d.contractorType ?? <Muted>Unknown</Muted>}</Fact>
        <Fact label="In business">
          {d.yearsInBusiness != null ? `${d.yearsInBusiness} years${d.inBusinessSince ? ` (since ${d.inBusinessSince})` : ''}` : <Muted>Unknown</Muted>}
        </Fact>
        <Fact label="Employees">{d.employeesRange ?? <Muted>Not listed</Muted>}</Fact>
        <Fact label="GAF tier">{tier ?? <Muted>Not certified</Muted>}</Fact>
        <Fact label="GAF Leads programme">{d.gafLeadsEnrolled ? 'Enrolled (gets homeowner leads)' : 'Not enrolled'}</Fact>
        <Fact label="County">{countyFullName(d.countyFips)}</Fact>
        <Fact label="Source records" className="col-span-2">
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {d.sourceIds.map((s) =>
              s.source === 'gaf' && d.profileUrl ? (
                <ExternalLink key={s.source + s.externalId} href={d.profileUrl} icon className="text-accent hover:underline">
                  GAF #{s.externalId}
                </ExternalLink>
              ) : (
                <span key={s.source + s.externalId}>{sourceLabel(s.source)} #{s.externalId}</span>
              ),
            )}
            <span className="text-muted">First seen {formatDate(d.firstSeenAt)}</span>
          </span>
        </Fact>
        {distinctions.length > 0 && (
          <Fact label="Awards & certifications" className="col-span-2">
            <span className="flex flex-wrap gap-1.5">
              {distinctions.map((c) => <Badge key={c} variant="neutral">{c}</Badge>)}
            </span>
          </Fact>
        )}
        {specialties.length > 0 && (
          <Fact label="Specialties" className="col-span-2">
            <span className="flex flex-wrap gap-1.5">
              {specialties.map((c) => <Badge key={c} variant="neutral">{humanize(c)}</Badge>)}
            </span>
          </Fact>
        )}
        {description && (
          <Fact label="About" className="col-span-2">
            <span className={long && !expanded ? 'line-clamp-3' : undefined}>{description}</span>
            {long && (
              <button type="button" onClick={() => setExpanded((e) => !e)} className="mt-1 block text-xs font-medium text-accent hover:underline">
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </Fact>
        )}
      </dl>
    </SectionCard>
  );
}

export function LocationCard() {
  const { profile } = useProfile();
  const d = profile.details;
  const name = profile.fields.business_name.value ?? 'this contractor';
  const address = profile.fields.address.value;
  const href = mapsUrl({ address, lat: d.latitude, lng: d.longitude, placeId: d.googlePlaceId });
  return (
    <SectionCard title="Location" icon={<MapPin />} bodyClassName="p-0">
      <div className="h-52 overflow-hidden border-b border-border bg-surface-2">
        <Suspense fallback={<Skeleton className="h-full w-full rounded-none" />}>
          <LocationMap lat={d.latitude} lng={d.longitude} name={name} />
        </Suspense>
      </div>
      <div className="space-y-2.5 p-4 text-sm sm:p-5">
        <p className="text-fg">{address ?? <Muted>No street address listed</Muted>}</p>
        <p className="text-xs text-muted">{countyFullName(d.countyFips)}</p>
        <ExternalLink href={href} className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline">
          <Navigation className="size-3.5" aria-hidden />
          Open in Google Maps
        </ExternalLink>
      </div>
    </SectionCard>
  );
}
