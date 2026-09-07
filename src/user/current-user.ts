/**
 * Кто выполняет текущий вызов.
 *
 * При per-request авторизации сервер не знает логина: в запросе приходят только
 * cookie и BPMCSRF. Личность должен вычислить сам BPMSoft в сессии вызывающего —
 * иначе любая догадка (например «последняя запись в SysUserSession») выдаст
 * чужого пользователя, как только к серверу подключится второй человек.
 *
 * Механизм — макросы DataService, проверенные на стенде:
 *   SysAdminUnit.Id = macros(1) → текущий пользователь
 *   Contact.Id      = macros(2) → его контакт
 * Одного запроса по SysAdminUnit хватает: контакт достаётся через путь `Contact.*`.
 *
 * Сервисы вида UserInfoService.svc/GetCurrentUserInfo на стенде отсутствуют
 * (404 и с префиксом /0/ServiceModel, и без него), поэтому DataService —
 * основной путь, а не запасной.
 *
 * Кэш ключуется `getAuthCacheScope()`, то есть никогда не пересекается между
 * пользователями.
 */

import type { BpmConfig } from '../types/index.js';
import { HttpClient } from '../client/http-client.js';
import { getAuthCacheScope } from '../auth/request-context.js';
import { BpmApiError } from '../utils/errors.js';

/** Макрос DataService, вычисляемый сервером в контексте вызывающего. */
const MACROS_CURRENT_USER = 1;

export interface CurrentUser {
  /** Id записи SysAdminUnit */
  userId: string;
  /** Логин (SysAdminUnit.Name) */
  userName: string;
  /** Связанный контакт — им заполняются Owner/Author в записях */
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  /** Культура пользователя, например ru-RU */
  culture?: string;
  /** Часовой пояс пользователя (SysAdminUnit.TimeZoneId), часто пустой */
  timeZoneId?: string;
  /** 4 — пользователь, 1 — оргроль, 6 — функциональная роль */
  unitType?: number;
}

interface DataServiceRow {
  Id?: string;
  Name?: string;
  ContactId?: string;
  ContactName?: string;
  ContactEmail?: string;
  CultureName?: string;
  TimeZoneId?: string;
  UnitType?: number;
}

interface SelectQueryResponse {
  rows?: DataServiceRow[];
  success?: boolean;
  errorInfo?: { message?: string };
  notFoundColumns?: string[];
}

interface CacheEntry {
  user: CurrentUser;
  timestamp: number;
}

export class CurrentUserService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private config: BpmConfig,
    private httpClient: HttpClient
  ) {}

  /** Текущий пользователь вызова. Кэш — на TTL справочников. */
  async get(): Promise<CurrentUser> {
    const scope = getAuthCacheScope();
    const cached = this.cache.get(scope);
    if (cached && Date.now() - cached.timestamp < this.config.lookup_cache_ttl * 1000) {
      return cached.user;
    }

    const user = await this.fetch();
    this.cache.set(scope, { user, timestamp: Date.now() });
    return user;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async fetch(): Promise<CurrentUser> {
    const column = (columnPath: string) => ({ expression: { expressionType: 0, columnPath } });
    const body = {
      rootSchemaName: 'SysAdminUnit',
      operationType: 0,
      columns: {
        items: {
          Id: column('Id'),
          Name: column('Name'),
          ContactId: column('Contact.Id'),
          ContactName: column('Contact.Name'),
          ContactEmail: column('Contact.Email'),
          CultureName: column('SysCulture.Name'),
          TimeZoneId: column('TimeZoneId'),
          UnitType: column('SysAdminUnitTypeValue'),
        },
      },
      filters: {
        filterType: 6,
        logicalOperation: 0,
        items: {
          current: {
            filterType: 1,
            comparisonType: 3,
            leftExpression: { expressionType: 0, columnPath: 'Id' },
            // expressionType 1 = Function, functionType 1 = Macros
            rightExpression: { expressionType: 1, functionType: 1, macrosType: MACROS_CURRENT_USER },
          },
        },
      },
    };

    const response = await this.httpClient.request<SelectQueryResponse>({
      method: 'POST',
      url: `${this.config.bpmsoft_url}/0/DataService/json/SyncReply/SelectQuery`,
      body,
      contentKind: 'crud',
    });

    const data = response.data;
    if (data?.errorInfo?.message) {
      throw new BpmApiError(
        `BPMSoft не смог определить текущего пользователя: ${data.errorInfo.message}`,
        response.status,
        'SysAdminUnit'
      );
    }

    const row = data?.rows?.[0];
    if (!row?.Id) {
      throw new BpmApiError(
        'Не удалось определить текущего пользователя: DataService вернул пустой результат. ' +
          'Проверьте, что запрос несёт актуальные cookie и BPMCSRF.',
        response.status,
        'SysAdminUnit',
        undefined,
        undefined,
        [
          'Обновите сессию BPMSoft и повторите вызов.',
          'В режиме env-creds убедитесь, что bpm_init отработал успешно.',
        ]
      );
    }

    return {
      userId: row.Id,
      userName: row.Name ?? '',
      contactId: emptyToUndefined(row.ContactId),
      contactName: emptyToUndefined(row.ContactName),
      contactEmail: emptyToUndefined(row.ContactEmail),
      culture: emptyToUndefined(row.CultureName),
      timeZoneId: emptyToUndefined(row.TimeZoneId),
      unitType: typeof row.UnitType === 'number' ? row.UnitType : undefined,
    };
  }
}

/** BPMSoft отдаёт незаполненные ссылки пустой строкой, а не null. */
function emptyToUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === '00000000-0000-0000-0000-000000000000') return undefined;
  return trimmed;
}
