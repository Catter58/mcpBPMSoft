/** Shared Activity field mapping and date-only slot selection for every write path. */
import type { ServiceContainer } from '../tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../types/index.js';
import type { ResolutionContext } from '../lookup/resolution-context.js';
import { BpmApiError } from '../utils/errors.js';
import { zonedMidnightUtc, zonedParts } from '../utils/datetime.js';
import { coerceValue, isCalendarDateOnly, needsTimeZone } from '../utils/coerce.js';
import { guidLiteral, isGuid } from '../utils/odata.js';
import { isMeMacro } from '../utils/me-macro.js';

const TITLE = ['Title', 'Subject', 'Caption'];
const START = ['StartDate', 'StartedOn'];
const FINISH = ['DueDate', 'EndDate', 'DueOn'];
const CATEGORY = ['ActivityCategoryId', 'ActivityCategory'];
const ACTIVITY_TYPE = ['TypeId', 'Type', 'ActivityTypeId', 'ActivityType'];
const OWNER = ['OwnerId', 'Owner', 'ResponsibleId', 'Responsible'];
const STATUS = ['StatusId', 'Status'];
const FETCH_CAP = 500;
const reservationsByContext = new WeakMap<
  ResolutionContext,
  Array<{ start: number; end: number; ownerId: string }>
>();

export interface ActivityPreparationInput {
  title?: string;
  start_date?: string;
  end_date?: string;
  due_date?: string;
  duration_minutes?: number;
  activity_type?: string;
  category?: string;
  /** Legacy alias for category. */
  type?: string;
  status?: string;
  owner_name?: string;
  notes?: string;
}

export interface PreparedActivityData {
  data: Record<string, unknown>;
  origins: Array<{ field: string; source: 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed' }>;
  usedFields: Record<string, string>;
  warnings: string[];
  timeZone?: { timeZone: string; source: 'profile' | 'environment' };
  availabilityChecked?: boolean;
  ownerId?: string;
  reservation?: { start: number; end: number; ownerId: string };
}

/** Reserve a validated interval for later rows in the same create/batch operation. */
export function reservePreparedActivity(context: ResolutionContext, prepared: PreparedActivityData): void {
  if (!prepared.reservation) return;
  const list = reservationsByContext.get(context) ?? [];
  const { start, end } = prepared.reservation;
  if (
    list.some(
      (interval) =>
        interval.ownerId === prepared.reservation!.ownerId && start < interval.end && end > interval.start
    )
  )
    fail('Интервал активности пересекается с другой записью этой операции.', ['start_date', 'end_date']);
  list.push({ start, end, ownerId: prepared.reservation.ownerId });
  reservationsByContext.set(context, list);
}

export function releasePreparedActivity(context: ResolutionContext, prepared: PreparedActivityData): void {
  if (!prepared.reservation) return;
  const list = reservationsByContext.get(context);
  if (!list) return;
  const { start, end } = prepared.reservation;
  const index = list.findIndex(
    (interval) =>
      interval.start === start && interval.end === end && interval.ownerId === prepared.reservation!.ownerId
  );
  if (index >= 0) list.splice(index, 1);
}

function field(meta: EntityMetadata, names: string[]): EntityProperty | undefined {
  return names.map((name) => meta.properties.find((property) => property.name === name)).find(Boolean);
}

/** Return the exact metadata properties the adapter will write for each generic Activity input. */
export function selectedActivityPreparationFields(
  meta: EntityMetadata
): Partial<Record<keyof ActivityPreparationInput, string>> {
  return {
    title: field(meta, TITLE)?.name,
    notes: field(meta, ['Notes', 'Description'])?.name,
    start_date: field(meta, START)?.name,
    end_date: field(meta, FINISH)?.name,
    due_date: field(meta, FINISH)?.name,
    activity_type: field(meta, ACTIVITY_TYPE)?.name,
    category: field(meta, CATEGORY)?.name,
    type: field(meta, CATEGORY)?.name,
    status: field(meta, STATUS)?.name,
    owner_name: field(meta, OWNER)?.name,
  };
}

function fail(message: string, fields: string[] = []): never {
  throw new BpmApiError(message, 400, 'Activity', undefined, fields, [
    'Уточните параметры активности; запись не создана.',
  ]);
}

function isDateOnly(value: string | undefined): boolean {
  return isCalendarDateOnly(value);
}

function localDateKey(value: string, timeZone: string, now: Date): string {
  const converted = coerceValue('StartDate', value, 'Edm.DateTimeOffset', timeZone, {
    now,
    defaultHour: 12,
  }).value;
  const date = new Date(String(converted));
  if (!Number.isFinite(date.getTime())) return fail('Не удалось определить дату активности.');
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function dateBounds(
  key: string,
  timeZone: string
): { from: Date; to: Date; parts: ReturnType<typeof zonedParts> } {
  const [year, month, day] = key.split('-').map(Number);
  const from = zonedMidnightUtc(year, month, day, timeZone);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const to = zonedMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  return { from, to, parts: zonedParts(from, timeZone) };
}

function localClock(key: string, hour: number, timeZone: string, now: Date): Date {
  const value = coerceValue(
    'StartDate',
    `${key}T${String(hour).padStart(2, '0')}:00`,
    'Edm.DateTimeOffset',
    timeZone,
    { now, defaultHour: 12 }
  ).value;
  const instant = new Date(String(value));
  if (!Number.isFinite(instant.getTime())) return fail('Не удалось построить локальное время активности.');
  return instant;
}

async function findOwnerId(
  services: ServiceContainer,
  context: ResolutionContext,
  ownerField: EntityProperty,
  ownerName?: string
): Promise<string> {
  if (ownerName) {
    const resolved = await services.lookupResolver.resolveDataLookups(
      'Activity',
      { [ownerField.name]: ownerName },
      context
    );
    const id = resolved.data[ownerField.name];
    if (typeof id === 'string' && isGuid(id)) return id.toLowerCase();
    return fail('Не удалось однозначно определить владельца активности.', [ownerField.name]);
  }
  const user = await context.getCurrentUser();
  const lookup = ownerField.lookupCollection?.replace(/Collection$/, '');
  const id = lookup === 'SysAdminUnit' ? user.userId : lookup === 'Contact' ? user.contactId : undefined;
  if (!id || !isGuid(id))
    return fail('Не удалось определить владельца активности для проверки свободного времени.', [
      ownerField.name,
    ]);
  return id.toLowerCase();
}

async function chooseFreeSlot(
  services: ServiceContainer,
  context: ResolutionContext,
  meta: EntityMetadata,
  ownerName: string | undefined,
  dateKey: string,
  duration: number
): Promise<{ start: Date; end: Date }> {
  const startField = field(meta, START);
  const endField = field(meta, FINISH);
  const ownerField = field(meta, OWNER);
  if (!startField || !endField || !ownerField?.isLookup)
    return fail('Метаданные не позволяют безопасно проверить свободное время активности.');
  const zone = (await context.getTimeZone()).timeZone;
  const { from, to, parts } = dateBounds(dateKey, zone);
  const now = context.now;
  const today = zonedParts(now, zone);
  const todayKey = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
  if (dateKey < todayKey) return fail('Нельзя автоматически назначить активность в прошедшее время.');
  let earliest = localClock(dateKey, 9, zone, now).getTime();
  const dateIsToday = parts.year === today.year && parts.month === today.month && parts.day === today.day;
  if (dateIsToday) earliest = Math.max(earliest, Math.ceil(now.getTime() / 60_000) * 60_000);
  const latest = localClock(dateKey, 18, zone, now).getTime();
  if (earliest + duration * 60_000 > latest)
    return fail('В выбранный день не осталось рабочего времени для активности.');

  const ownerId = await findOwnerId(services, context, ownerField, ownerName);
  const nav = ownerField.navigationProperty || ownerField.name.replace(/Id$/, '');
  const version = services.config.odata_version;
  const literal = (d: Date) =>
    version === 3
      ? `datetime'${d
          .toISOString()
          .replace(/\.\d{3}Z$/, '')
          .replace(/Z$/, '')}'`
      : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const filter = `${nav}/Id eq ${guidLiteral(ownerId, version)} and (${startField.name} lt ${literal(to)} and ${endField.name} gt ${literal(from)} or ${startField.name} eq null or ${endField.name} eq null)`;
  let response;
  try {
    response = await services.odataClient.getRecords<Record<string, unknown>>(
      'Activity',
      {
        $filter: filter,
        $select: `Id,${startField.name},${endField.name}`,
        $top: FETCH_CAP + 1,
      },
      false,
      FETCH_CAP + 1
    );
  } catch (error) {
    return fail(
      `Не удалось проверить занятость владельца: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (response['@odata.nextLink'] || response.value.length > FETCH_CAP)
    return fail('Список активностей владельца неполон; нельзя подтвердить свободное время.');

  const busy: Array<[number, number]> = [];
  for (const row of response.value) {
    const start = Date.parse(String(row[startField.name] ?? ''));
    const end = Date.parse(String(row[endField.name] ?? ''));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return fail('У существующей активности некорректный интервал; свободное время не подтверждено.');
    if (start < to.getTime() && end > from.getTime())
      busy.push([Math.max(start, from.getTime()), Math.min(end, to.getTime())]);
  }
  busy.push(
    ...(reservationsByContext.get(context) ?? [])
      .filter((interval) => interval.ownerId === ownerId)
      .map(({ start, end }): [number, number] => [start, end])
  );
  busy.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of busy) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const slot = duration * 60_000;
  let candidate = earliest;
  for (const [busyStart, busyEnd] of merged) {
    if (candidate + slot <= busyStart) break;
    if (candidate < busyEnd) candidate = Math.ceil(busyEnd / 60_000) * 60_000;
  }
  if (candidate + slot > latest) return fail('В выбранный день нет свободного интервала в рабочее время.');
  const start = new Date(candidate);
  const end = new Date(candidate + slot);
  // Ensure UTC instant maps back to the requested local date across DST boundaries.
  const actual = zonedParts(start, (await context.getTimeZone()).timeZone);
  if (
    `${actual.year}-${String(actual.month).padStart(2, '0')}-${String(actual.day).padStart(2, '0')}` !==
      dateKey ||
    !parts
  )
    return fail('Не удалось безопасно построить локальный интервал активности.');
  return { start, end };
}

/** Normalize Activity fields once, shared by log_activity and generic create/batch. */
export async function prepareActivityData(
  services: ServiceContainer,
  input: ActivityPreparationInput,
  context: ResolutionContext
): Promise<PreparedActivityData> {
  if (input.category !== undefined && input.type !== undefined)
    fail('Передайте только одно из category и legacy-поля type.', ['category', 'type']);
  if (input.end_date !== undefined && input.due_date !== undefined)
    fail('Передайте только одно из end_date и due_date.', ['end_date', 'due_date']);
  const categoryInput = input.category ?? input.type;
  if (
    input.duration_minutes !== undefined &&
    (!Number.isInteger(input.duration_minutes) ||
      input.duration_minutes <= 0 ||
      input.duration_minutes > 1440)
  )
    fail('duration_minutes должен быть целым числом от 1 до 1440.', ['duration_minutes']);
  const meta = await services.metadataManager.getEntityMetadata('Activity');
  const data: Record<string, unknown> = {};
  const usedFields: Record<string, string> = {};
  const originSources = new Map<string, 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed'>();
  const put = (
    inputName: string,
    value: unknown,
    names: string[],
    lookup = false,
    source?: 'caller' | 'normalized' | 'lookup' | 'current_user' | 'computed'
  ) => {
    const target = field(meta, names);
    if (!target || (lookup && !target.isLookup))
      return fail(`В Activity нет совместимого поля для ${inputName}.`, [inputName]);
    data[target.name] = value;
    usedFields[inputName] = target.name;
    originSources.set(
      target.name,
      source ??
        (lookup && typeof value === 'string' && !isGuid(value)
          ? isMeMacro(value)
            ? 'current_user'
            : 'lookup'
          : 'caller')
    );
    return target;
  };

  if (input.title !== undefined) put('title', input.title, TITLE);
  if (input.notes !== undefined) put('notes', input.notes, ['Notes', 'Description']);
  const startInput = input.start_date;
  const finishInput = input.end_date ?? input.due_date;
  const hasDateOnlyIntent = isDateOnly(startInput) || isDateOnly(finishInput);
  const hasExplicitTime = Boolean(
    (startInput && !isDateOnly(startInput)) || (finishInput && !isDateOnly(finishInput))
  );
  const startType = field(meta, START)?.type ?? 'Edm.DateTimeOffset';
  const finishType = field(meta, FINISH)?.type ?? 'Edm.DateTimeOffset';
  const zoneRequired =
    hasDateOnlyIntent || needsTimeZone(startInput, startType) || needsTimeZone(finishInput, finishType);
  const timezone = zoneRequired ? await context.getTimeZone() : undefined;
  const duration = input.duration_minutes ?? 30;
  let startValue: unknown = startInput;
  let finishValue: unknown = finishInput;
  let reservation: { start: number; end: number; ownerId: string } | undefined;
  let availabilityChecked = false;
  if (hasDateOnlyIntent && !hasExplicitTime) {
    const zone = timezone!.timeZone;
    const dateSource = isDateOnly(startInput) ? startInput! : finishInput!;
    const dateKey = localDateKey(dateSource, zone, context.now);
    if (
      startInput &&
      finishInput &&
      localDateKey(startInput, zone, context.now) !== localDateKey(finishInput, zone, context.now)
    )
      fail('Дата начала и дата завершения должны совпадать, если переданы только даты.', [
        'start_date',
        'end_date',
      ]);
    const slot = await chooseFreeSlot(services, context, meta, input.owner_name, dateKey, duration);
    startValue = slot.start.toISOString();
    finishValue = slot.end.toISOString();
    availabilityChecked = true;
  } else if (startInput || finishInput) {
    const zone = timezone?.timeZone;
    const startField = field(meta, START);
    const finishField = field(meta, FINISH);
    const start =
      startInput === undefined
        ? undefined
        : new Date(
            String(
              coerceValue(
                startField?.name ?? 'StartDate',
                startInput,
                startField?.type ?? 'Edm.DateTimeOffset',
                zone,
                { now: context.now, defaultHour: 12 }
              ).value
            )
          );
    const finish =
      finishInput === undefined
        ? undefined
        : new Date(
            String(
              coerceValue(
                finishField?.name ?? 'DueDate',
                finishInput,
                finishField?.type ?? 'Edm.DateTimeOffset',
                zone,
                { now: context.now, defaultHour: 12 }
              ).value
            )
          );
    if ((start && !Number.isFinite(start.getTime())) || (finish && !Number.isFinite(finish.getTime())))
      return fail('Не удалось определить время активности.');
    if (start && !finishInput) finishValue = new Date(start.getTime() + duration * 60_000).toISOString();
    if (finish && !startInput) startValue = new Date(finish.getTime() - duration * 60_000).toISOString();
  }
  if (startValue !== undefined)
    put(
      'start_date',
      startValue,
      START,
      false,
      (hasDateOnlyIntent && !hasExplicitTime) || !startInput
        ? 'computed'
        : startValue !== startInput || needsTimeZone(startInput, startType)
          ? 'normalized'
          : 'caller'
    );
  if (finishValue !== undefined)
    put(
      input.end_date !== undefined ? 'end_date' : 'due_date',
      finishValue,
      FINISH,
      false,
      (hasDateOnlyIntent && !hasExplicitTime) || !finishInput
        ? 'computed'
        : finishValue !== finishInput || needsTimeZone(finishInput, finishType)
          ? 'normalized'
          : 'caller'
    );

  if (input.activity_type !== undefined) put('activity_type', input.activity_type, ACTIVITY_TYPE, true);
  if (categoryInput !== undefined)
    put(input.category !== undefined ? 'category' : 'type', categoryInput, CATEGORY, true);
  if (input.status !== undefined) put('status', input.status, STATUS, true);
  if (input.owner_name !== undefined) put('owner', input.owner_name, OWNER, true);

  // Resolve the selected activity type before disambiguating same-named categories.
  const typeProp = field(meta, ACTIVITY_TYPE);
  const preliminaryNotes: string[] = [];
  if (typeProp && data[typeProp.name] !== undefined) {
    const typeResolved = await services.lookupResolver.resolveDataLookups(
      'Activity',
      { [typeProp.name]: data[typeProp.name] },
      context
    );
    data[typeProp.name] = typeResolved.data[typeProp.name];
    preliminaryNotes.push(
      ...(typeResolved.notes ?? []).map((note) => `Поле ${note.field} разрешено как ${note.matchedValue}.`)
    );
    preliminaryNotes.push(
      ...(typeResolved.coerced ?? []).map(
        (note) => `Поле ${note.field} приведено к ${JSON.stringify(note.output)}.`
      )
    );
  } else if (
    typeProp?.defaultHint?.source === 'constant' &&
    typeProp.defaultHint.providedByServer &&
    typeof typeProp.defaultHint.value === 'string' &&
    isGuid(typeProp.defaultHint.value) &&
    !/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(typeProp.defaultHint.value)
  ) {
    // Metadata default is used only to select a related category; it remains omitted from the create body.
  }
  const effectiveTypeId =
    typeProp &&
    typeof data[typeProp.name] === 'string' &&
    isGuid(String(data[typeProp.name])) &&
    !/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(String(data[typeProp.name]))
      ? String(data[typeProp.name])
      : typeProp?.defaultHint?.source === 'constant' &&
          typeProp.defaultHint.providedByServer &&
          typeof typeProp.defaultHint.value === 'string' &&
          isGuid(typeProp.defaultHint.value) &&
          !/^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(typeProp.defaultHint.value)
        ? typeProp.defaultHint.value
        : undefined;
  const categoryProp = field(meta, CATEGORY);
  const categoryWarnings: string[] = [];
  if (categoryInput && categoryProp?.lookupCollection && !isGuid(categoryInput) && effectiveTypeId) {
    const matches = await services.lookupResolver.resolve(
      categoryProp.lookupCollection,
      categoryInput,
      categoryProp.lookupDisplayColumn ?? 'Name'
    );
    if (
      !matches.resolved &&
      matches.matchCount > 1 &&
      new Set(matches.candidates.map((candidate) => candidate.displayValue)).size === 1
    ) {
      if (matches.has_more || matches.candidates.length < matches.matchCount)
        fail('Список совпадающих категорий неполон; нельзя выбрать категорию по типу.', [categoryProp.name]);
      const categoryMeta = await services.metadataManager.getEntityMetadata(categoryProp.lookupCollection);
      const discriminator = categoryMeta.properties.find(
        (property) =>
          property.name === 'ActivityTypeId' ||
          property.lookupCollection?.replace(/Collection$/, '') === 'ActivityType'
      );
      if (discriminator) {
        const version = services.config.odata_version;
        const filter = matches.candidates
          .map((candidate) => `Id eq ${guidLiteral(candidate.id, version)}`)
          .join(' or ');
        const rows = await services.odataClient.getRecords<Record<string, unknown>>(
          categoryProp.lookupCollection,
          { $filter: filter, $select: `Id,${discriminator.name}`, $top: matches.candidates.length + 1 },
          false,
          matches.candidates.length + 1
        );
        if (rows['@odata.nextLink'] || rows.value.length > matches.candidates.length)
          fail('Не удалось полностью проверить категорию активности.', [categoryProp.name]);
        const chosen = rows.value.filter(
          (row) => String(row[discriminator.name] ?? '').toLowerCase() === effectiveTypeId!.toLowerCase()
        );
        if (chosen.length === 1) data[categoryProp.name] = String(chosen[0].Id);
      }
    }
  }
  // Convert all aliases and date fields through the standard metadata resolver once.
  const resolved = await services.lookupResolver.resolveDataLookups('Activity', data, context);
  Object.assign(data, resolved.data);
  if (
    categoryProp &&
    typeof data[categoryProp.name] === 'string' &&
    isGuid(String(data[categoryProp.name])) &&
    effectiveTypeId
  ) {
    const categoryMeta = await services.metadataManager.getEntityMetadata(categoryProp.lookupCollection!);
    const discriminator = categoryMeta.properties.find(
      (property) =>
        property.name === 'ActivityTypeId' ||
        property.lookupCollection?.replace(/Collection$/, '') === 'ActivityType'
    );
    if (discriminator) {
      const version = services.config.odata_version;
      const rows = await services.odataClient.getRecords<Record<string, unknown>>(
        categoryProp.lookupCollection!,
        {
          $filter: `Id eq ${guidLiteral(String(data[categoryProp.name]), version)}`,
          $select: `Id,${discriminator.name}`,
          $top: 2,
        },
        false,
        2
      );
      if (rows.value.length !== 1 || rows['@odata.nextLink'])
        fail('Не удалось проверить тип выбранной категории активности.', [categoryProp.name]);
      const categoryType = rows.value[0][discriminator.name];
      if (categoryType && String(categoryType).toLowerCase() !== effectiveTypeId.toLowerCase())
        fail('Выбранная категория не относится к указанному типу активности.', [
          categoryProp.name,
          typeProp!.name,
        ]);
      if (!categoryType)
        categoryWarnings.push(
          'Связь выбранной категории с типом не опубликована в данных; автоматическая проверка совместимости недоступна.'
        );
    } else
      categoryWarnings.push(
        'Связь категории с типом не опубликована в метаданных; автоматическая проверка совместимости недоступна.'
      );
  } else if (categoryProp && categoryInput !== undefined && typeProp && !effectiveTypeId) {
    categoryWarnings.push(
      'Тип активности не задан и его постоянное значение неизвестно; совместимость категории автоматически не проверена.'
    );
  }
  const warnings = [
    ...preliminaryNotes,
    ...categoryWarnings,
    ...(resolved.notes ?? []).map((note) => `Поле ${note.field} разрешено как ${note.matchedValue}.`),
    ...(resolved.coerced ?? []).map(
      (note) => `Поле ${note.field} приведено к ${JSON.stringify(note.output)}.`
    ),
  ];
  const startField = field(meta, START);
  const endField = field(meta, FINISH);
  const ownerProp = field(meta, OWNER);
  const effectiveOwnerId = ownerProp
    ? typeof data[ownerProp.name] === 'string'
      ? String(data[ownerProp.name]).toLowerCase()
      : input.start_date !== undefined || input.end_date !== undefined || input.due_date !== undefined
        ? await findOwnerId(services, context, ownerProp, input.owner_name)
        : undefined
    : undefined;
  if (startField && endField && data[startField.name] !== undefined && data[endField.name] !== undefined) {
    const start = Date.parse(String(data[startField.name]));
    const end = Date.parse(String(data[endField.name]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      fail('end_date/due_date должен быть позже start_date.', [startField.name, endField.name]);
    if (
      input.duration_minutes !== undefined &&
      startInput &&
      finishInput &&
      end - start !== input.duration_minutes * 60_000
    )
      fail('duration_minutes противоречит start_date и end_date/due_date.', [
        'duration_minutes',
        startField.name,
        endField.name,
      ]);
    const ownerId = effectiveOwnerId ?? '';
    reservation = { start, end, ownerId };
    if (
      (reservationsByContext.get(context) ?? []).some(
        (interval) => interval.ownerId === ownerId && start < interval.end && end > interval.start
      )
    )
      fail('Интервал активности пересекается с другой записью этой операции.', [
        startField.name,
        endField.name,
      ]);
  }
  return {
    data,
    origins: [...originSources].map(([field, source]) => ({ field, source })),
    usedFields,
    warnings,
    ...(timezone ? { timeZone: timezone } : {}),
    ...(availabilityChecked ? { availabilityChecked: true } : {}),
    ...(effectiveOwnerId ? { ownerId: effectiveOwnerId } : {}),
    ...(reservation ? { reservation } : {}),
  };
}
