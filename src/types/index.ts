/**
 * Shared types and interfaces for BPMSoft MCP Server
 */

export type ODataVersion = 3 | 4;
export type PlatformType = 'net8' | 'netframework';

export interface BpmConfig {
  /** Base URL of BPMSoft application (e.g. https://example.bpmsoft.com) */
  bpmsoft_url: string;
  /** Login username (only used with env-creds opt-in) */
  username?: string;
  /** Login password (only used with env-creds opt-in) */
  password?: string;
  /** OData protocol version (default: 4) */
  odata_version: ODataVersion;
  /** Platform type (default: net8) */
  platform: PlatformType;
  /** Page size for auto-pagination (default: 5000) */
  page_size: number;
  /** Max sub-requests per $batch call (API limit: 100) */
  max_batch_size: number;
  /** Lookup cache TTL in seconds (default: 300) */
  lookup_cache_ttl: number;
  /** HTTP request timeout in ms (default: 30000) */
  request_timeout: number;
  /** Max file upload size in bytes (default: 10MB) */
  max_file_size: number;
  /** Allowed server-side file directory for HTTP callers (default: ./files). */
  file_root?: string;
  /** Operator-configured tenant; never a caller-supplied URL. */
  tenant_id?: string;
  /** Durable operation receipts, outside source control. */
  journal_root?: string;
  read_budget_timeout?: number;
  read_budget_requests?: number;
  read_budget_bytes?: number;
}

export interface AuthState {
  /** Session cookie value (BPMSESSIONID) */
  sessionId: string | null;
  /** CSRF token (BPMCSRF) */
  csrfToken: string | null;
  /** All cookies to send with requests */
  cookies: Map<string, string>;
  /** Whether currently authenticated */
  isAuthenticated: boolean;
}

export interface LoginResponse {
  Code: number;
  Message: string;
  Exception: unknown;
  PasswordChangeUrl: string;
  RedirectUrl: string;
}

export interface ODataCollectionResponse<T = Record<string, unknown>> {
  '@odata.context'?: string;
  '@odata.count'?: number;
  '@odata.nextLink'?: string;
  value: T[];
  /** Compatibility notes from the transport, independent of data completeness. */
  warnings?: string[];
  matching?: 'platform_collation';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface ODataSingleResponse<T = Record<string, unknown>> {
  '@odata.context'?: string;
  [key: string]: unknown;
}

export interface ODataErrorDetail {
  code: string;
  message: string;
}

export interface ODataErrorResponse {
  error: ODataErrorDetail;
}

export interface EntityProperty {
  name: string;
  type: string;
  nullable: boolean;
  /** Platform schema requirement; unknown when its descriptor is unavailable. */
  required?: boolean;
  requirementSource?: 'entity_schema_designer';
  /** Descriptive only: runtime defaults must be evaluated by BPMSoft itself. */
  defaultHint?: {
    source: 'none' | 'constant' | 'system_setting' | 'runtime' | 'unknown';
    providedByServer?: boolean;
    value?: string | number | boolean | null;
  };
  isLookup: boolean;
  /** For lookup fields: the target collection name */
  lookupCollection?: string;
  /** For lookup fields: display column in target collection */
  lookupDisplayColumn?: string;
  /** Actual OData navigation name, as published by EDMX. */
  lookupNavProperty?: string;
  navigationProperty?: string;
  /** Localized display caption (e.g. Russian name from SysEntitySchemaColumn) */
  caption?: string;
}

/** Schema caption info from SysSchema */
export interface SchemaCaption {
  uid: string;
  name: string;
  caption: string;
}

/** Column caption info from SysEntitySchemaColumn */
export interface ColumnCaption {
  name: string;
  caption: string;
}

export interface EntityMetadata {
  name: string;
  /** Actual EDMX primary-key fields, when published by the platform. */
  keyFields?: string[];
  /** Collection endpoint name (e.g. "Contact" for OData 4, "ContactCollection" for OData 3) */
  collectionName: string;
  properties: EntityProperty[];
  /** Lookup field names for quick access */
  lookupFields: string[];
  /** When metadata was cached */
  cachedAt: number;
}

export interface LookupCandidate {
  id: string;
  displayValue: string;
  additionalInfo?: Record<string, unknown>;
  /** Score ранжирования при fuzzy-каскаде (100 exact … 40 substring) */
  score?: number;
}

export interface LookupResult {
  /** Whether resolution was successful (exactly 1 match) */
  resolved: boolean;
  /** Resolved UUID (if exactly 1 match) */
  id?: string;
  /** Display value that was searched */
  searchValue: string;
  /** Number of matches found */
  matchCount: number;
  /** More candidates exist beyond the bounded response. */
  has_more?: boolean;
  /** Whether matchCount is a total, rather than a lower bound. */
  match_count_is_exact?: boolean;
  /** Candidates when multiple matches (or 0) */
  candidates: LookupCandidate[];
  /** Error message if resolution failed */
  error?: string;
  /** Резолв прошёл не через точный eq (contains/core-каскад) */
  fuzzy?: boolean;
  /** Какой этап каскада дал результат */
  matchType?: 'exact' | 'contains' | 'core';
  /** Фактическое значение в базе (при fuzzy-резолве) */
  matchedValue?: string;
}

export interface BatchRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface BatchResponseItem {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface BatchResponse {
  responses: BatchResponseItem[];
}

export type ContentKind = 'auth' | 'crud' | 'batch' | 'binary' | 'metadata' | 'count';
export type ResponseType = 'auto' | 'json' | 'text' | 'binary';

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Skip authentication for this request (e.g. for login) */
  skipAuth?: boolean;
  /** Request timeout override in ms */
  timeout?: number;
  /** Selects Content-Type/Accept profile (default: 'crud') */
  contentKind?: ContentKind;
  /** Forces response decoding mode (default: 'auto') */
  responseType?: ResponseType;
  /** Read requests may be repeated; mutations (including side-effect GET) must never be replayed automatically. */
  operation?: 'read' | 'mutation';
  /** Caller cancellation; the timeout covers all attempts and retry delays. */
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
  ok: boolean;
}

export interface ToolSuccess {
  success: true;
  data: unknown;
  message?: string;
}

/** Машиночитаемый код ошибки — стабильный контракт для LLM-агента. */
export type ToolErrorCode =
  | 'auth_required'
  | 'not_found'
  | 'lookup_ambiguous'
  | 'unsafe_identifier'
  | 'batch_unsupported'
  | 'confirm_required'
  | 'expected_count_mismatch'
  | 'odata_error'
  | 'validation'
  | 'network'
  | 'outcome_unknown'
  | 'budget_exceeded'
  | 'concurrency_conflict'
  | 'concurrency_unsupported'
  | 'idempotency_conflict'
  | 'not_initialized'
  | 'unknown';

export interface ToolError {
  success: false;
  /** Машиночитаемый код для программной обработки */
  code: ToolErrorCode;
  error: string;
  httpStatus?: number;
  collection?: string;
  details?: string;
  /** Кандидаты на исправление (например, ближайшие имена полей) */
  suggestions?: string[];
  /** Подсказки агенту, что попробовать дальше */
  next_steps?: string[];
  /** False when replaying could duplicate a side effect. */
  safe_to_retry?: boolean;
}

export type ToolResult = ToolSuccess | ToolError;
