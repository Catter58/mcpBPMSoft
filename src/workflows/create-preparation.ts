import type { ServiceContainer } from '../tools/init-tool.js';
import type { ResolutionContext } from '../lookup/resolution-context.js';
import type { ResolvedLookupNote, ResolutionFieldError } from '../lookup/lookup-resolver.js';
import type { CoercedValueNote } from '../utils/coerce.js';
import { formatToolError, LookupResolutionError } from '../utils/errors.js';
import { BpmApiError } from '../utils/errors.js';
import { enrichLineItem, type LineItemResult } from './line-items.js';
import {
  classifyRequiredCreateField,
  MissingRequiredFieldsError,
  type MissingCreateField,
} from '../utils/write-safety.js';
import {
  prepareActivityData,
  selectedActivityPreparationFields,
  type ActivityPreparationInput,
  type PreparedActivityData,
} from './activity-preparation.js';
import { needsTimeZone } from '../utils/coerce.js';
import { createResolutionContext as makeResolutionContext } from '../lookup/resolution-context.js';

export interface CreateBlocker {
  code: string;
  message: string;
  field?: string;
  caption?: string;
  missing_fields?: MissingCreateField[];
  candidates?: unknown[];
  valid_values?: unknown[];
}

export interface PreparedCreateIntent {
  data: Record<string, unknown>;
  notes: ResolvedLookupNote[];
  coerced: CoercedValueNote[];
  origins: Array<{ field: string; source: 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed' }>;
  line: LineItemResult;
  blockers: CreateBlocker[];
  activity?: PreparedActivityData;
  source_timezone?: { time_zone: string; source: 'profile' | 'environment' };
}

export function createCreateResolutionContext(services: ServiceContainer): ResolutionContext {
  return services.lookupResolver.createResolutionContext?.() ?? makeResolutionContext(services.currentUser);
}

export class CreateIntentBlockedError extends BpmApiError {
  constructor(
    collection: string,
    public readonly blockers: CreateBlocker[]
  ) {
    const missing = blockers.flatMap((blocker) => blocker.missing_fields ?? []);
    super(
      blockers.map((blocker) => blocker.message).join(' '),
      400,
      collection,
      missing.length ? JSON.stringify({ missing_fields: missing }) : undefined,
      undefined,
      ['Исправьте перечисленные поля и повторите создание.'],
      'validation'
    );
  }

  override toToolError() {
    const base = super.toToolError();
    const missing = this.blockers.flatMap((blocker) => blocker.missing_fields ?? []);
    return { ...base, blockers: this.blockers, ...(missing.length ? { missing_fields: missing } : {}) };
  }
}

export function assertPreparedCreate(prepared: PreparedCreateIntent, collection: string): void {
  if (!prepared.blockers.length) return;
  if (prepared.blockers.every((blocker) => blocker.code === 'missing_required_fields'))
    throw new MissingRequiredFieldsError(
      collection,
      prepared.blockers.flatMap((blocker) => blocker.missing_fields ?? [])
    );
  throw new CreateIntentBlockedError(collection, prepared.blockers);
}

export async function detectSourceTimezone(
  services: ServiceContainer,
  collection: string,
  input: Record<string, unknown>,
  context: ResolutionContext
): Promise<PreparedCreateIntent['source_timezone']> {
  if (collection === 'Activity') return undefined;
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  for (const [key, value] of Object.entries(input)) {
    const reference = await services.metadataManager.resolveFieldReference(collection, key);
    const property = metadata.properties.find((item) => item.name === reference.name);
    if (property && needsTimeZone(value, property.type)) {
      try {
        const zone = await context.getTimeZone();
        return { time_zone: zone.timeZone, source: zone.source };
      } catch {
        // The resolver reports timezone failure with the affected field while collecting other blockers.
        return undefined;
      }
    }
  }
  return undefined;
}

export function resolutionErrorBlocker(error: ResolutionFieldError): CreateBlocker {
  const formatted = formatToolError(error.error);
  const lookup = error.error instanceof LookupResolutionError ? error.error : undefined;
  return {
    code: formatted.code,
    message: formatted.error,
    field: lookup?.field ?? error.canonicalField ?? error.rawKey,
    ...(lookup
      ? {
          candidates: lookup.candidates,
          lookup_collection: lookup.context.lookupCollection,
          ...(lookup.context.validValues ? { valid_values: lookup.context.validValues } : {}),
        }
      : {}),
  };
}

/** Resolve and validate a create intent without performing any write or confirmation planning. */
export async function prepareCreateIntent(
  services: ServiceContainer,
  collection: string,
  input: Record<string, unknown>,
  context: ResolutionContext,
  options: { enrichLineItems?: boolean } = {}
): Promise<PreparedCreateIntent> {
  const resolver = services.lookupResolver as typeof services.lookupResolver & {
    resolveDataLookups(
      collection: string,
      data: Record<string, unknown>,
      context: ResolutionContext,
      options: { collectErrors: true }
    ): Promise<{
      data: Record<string, unknown>;
      notes: ResolvedLookupNote[];
      coerced: CoercedValueNote[];
      origins: Array<{
        field: string;
        source: 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed';
      }>;
      errors: ResolutionFieldError[];
    }>;
  };
  let source = input;
  let activity: PreparedActivityData | undefined;
  let sourceTimezone: PreparedCreateIntent['source_timezone'];
  const priorBlockers: CreateBlocker[] = [];
  if (collection === 'Activity') {
    try {
      const activityMetadata = await services.metadataManager.getEntityMetadata(collection);
      const selectedFields = selectedActivityPreparationFields(activityMetadata);
      const activityInput: ActivityPreparationInput = {};
      const remainder: Record<string, unknown> = {};
      const seenCanonical = new Set<string>();
      const seenTargets = new Set<keyof ActivityPreparationInput>();
      let invalidActivityValue = false;
      for (const [key, value] of Object.entries(input)) {
        const reference = await services.metadataManager.resolveFieldReference(collection, key);
        const canonical = reference.name ?? key;
        if (reference.name && seenCanonical.has(reference.name)) {
          priorBlockers.push({
            code: 'validation',
            message: `Поле "${reference.name}" передано несколько раз под разными именами.`,
            field: reference.name,
          });
          continue;
        }
        if (reference.name) seenCanonical.add(reference.name);
        let target: keyof ActivityPreparationInput | undefined;
        if (['Title', 'Subject', 'Caption'].includes(canonical)) target = 'title';
        else if (['StartDate', 'StartedOn'].includes(canonical)) target = 'start_date';
        else if (['DueDate', 'DueOn'].includes(canonical)) target = 'due_date';
        else if (canonical === 'EndDate') target = 'end_date';
        else if (['ActivityCategoryId', 'ActivityCategory'].includes(canonical)) target = 'category';
        else if (['TypeId', 'ActivityTypeId', 'ActivityType'].includes(canonical)) target = 'activity_type';
        else if (['OwnerId', 'Owner', 'ResponsibleId', 'Responsible'].includes(canonical))
          target = 'owner_name';
        else if (['StatusId', 'Status'].includes(canonical)) target = 'status';
        else if (['Notes', 'Description'].includes(canonical)) target = 'notes';
        if (target && selectedFields[target] !== canonical) target = undefined;
        if (!target) {
          remainder[reference.name ?? key] = value;
          continue;
        }
        if (seenTargets.has(target)) {
          priorBlockers.push({
            code: 'validation',
            message: `Поля Activity переданы несколько раз для одного параметра (${target}).`,
            field: canonical,
          });
          continue;
        }
        seenTargets.add(target);
        if (typeof value !== 'string') {
          priorBlockers.push({
            code: 'validation',
            message: `${canonical} должен быть строкой; переданное значение не преобразовано.`,
            field: canonical,
          });
          invalidActivityValue = true;
          remainder[canonical] = value;
          continue;
        }
        (activityInput as Record<string, unknown>)[target] = value;
      }
      if (invalidActivityValue) source = { ...input };
      else {
        activity = await prepareActivityData(services, activityInput, context);
        source = { ...remainder, ...activity.data };
        if (activity.timeZone)
          sourceTimezone = { time_zone: activity.timeZone.timeZone, source: activity.timeZone.source };
      }
    } catch (error) {
      const formatted = formatToolError(error, collection);
      priorBlockers.push({ code: formatted.code, message: formatted.error });
    }
  } else sourceTimezone = await detectSourceTimezone(services, collection, input, context);
  const resolved = await resolver.resolveDataLookups(collection, source, context, { collectErrors: true });
  for (const fieldError of resolved.errors ?? []) {
    if (fieldError.canonicalField && Object.hasOwn(source, fieldError.rawKey))
      resolved.data[fieldError.canonicalField] = source[fieldError.rawKey];
  }
  const prepared = await validateResolvedCreateData(
    services,
    collection,
    resolved.data,
    resolved.notes,
    resolved.coerced ?? [],
    resolved.errors ?? [],
    options,
    [...(resolved.origins ?? []), ...(activity?.origins ?? [])]
  );
  prepared.blockers.unshift(...priorBlockers);
  if (activity) prepared.activity = activity;
  if (sourceTimezone) prepared.source_timezone = sourceTimezone;
  return prepared;
}

export async function validateResolvedCreateData(
  services: ServiceContainer,
  collection: string,
  data: Record<string, unknown>,
  notes: ResolvedLookupNote[],
  coerced: CoercedValueNote[],
  resolutionErrors: ResolutionFieldError[] = [],
  options: { enrichLineItems?: boolean } = {},
  origins: PreparedCreateIntent['origins'] = []
): Promise<PreparedCreateIntent> {
  let line: LineItemResult = { data, notes: [], parents: [] };
  const blockers = resolutionErrors.map(resolutionErrorBlocker);
  if (options.enrichLineItems !== false) {
    try {
      line = await enrichLineItem(services, collection, data);
    } catch (error) {
      const formatted = formatToolError(error, collection);
      blockers.push({ code: formatted.code, message: formatted.error });
    }
  }
  const metadata = await services.metadataManager.getEntityMetadata(collection);
  for (const blocker of blockers) {
    const property = metadata.properties.find((candidate) => candidate.name === blocker.field);
    if (property) blocker.caption = property.caption ?? property.name;
  }
  const missing = metadata.properties
    .filter((property) => classifyRequiredCreateField(property, line.data) === 'missing')
    .map((property) => ({
      name: property.name,
      caption: property.caption ?? property.name,
      type: property.type,
    }));
  if (missing.length) {
    blockers.push({
      code: 'missing_required_fields',
      message: `Заполните обязательные поля: ${missing.map((field) => `${field.caption} (${field.name})`).join(', ')}.`,
      missing_fields: missing,
    });
  }
  const originFields = new Set(origins.map((origin) => origin.field));
  return {
    data: line.data,
    notes,
    coerced,
    origins: [
      ...origins,
      ...Object.keys(line.data)
        .filter(
          (field) =>
            !originFields.has(field) ||
            !Object.hasOwn(data, field) ||
            JSON.stringify(line.data[field]) !== JSON.stringify(data[field])
        )
        .map((field) => ({ field, source: 'computed' as const })),
    ],
    line,
    blockers,
  };
}
