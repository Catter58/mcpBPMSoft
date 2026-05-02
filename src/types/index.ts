/**
 * Shared types and interfaces for BPMSoft MCP Server
 */

export type ODataVersion = 3 | 4;
export type PlatformType = 'net8' | 'netframework';

export interface BpmConfig {
  /** Base URL of BPMSoft application (e.g. https://example.bpmsoft.com) */
  bpmsoft_url: string;
  /** Login username */
  username: string;
  /** Login password */
  password: string;
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
  isLookup: boolean;
  /** For lookup fields: the target collection name */
  lookupCollection?: string;
  /** For lookup fields: display column in target collection */
  lookupDisplayColumn?: string;
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
  /** Candidates when multiple matches (or 0) */
  candidates: LookupCandidate[];
  /** Error message if resolution failed */
  error?: string;
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

export interface ToolError {
  success: false;
  error: string;
  httpStatus?: number;
  collection?: string;
  details?: string;
  /** Кандидаты на исправление (например, ближайшие имена полей) */
  suggestions?: string[];
  /** Подсказки агенту, что попробовать дальше */
  next_steps?: string[];
}

export type ToolResult = ToolSuccess | ToolError;
