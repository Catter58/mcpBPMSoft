/**
 * ProcessEngineService client for BPMSoft.
 *
 * Wraps the legacy WCF service `ServiceModel/ProcessEngineService.svc`:
 *   GET /ProcessEngineService.svc/{ProcessName}/Execute?param1=...&param2=...
 *   GET /ProcessEngineService.svc/ExecProcElByUId?ProcessElementUID={uid}
 *
 * Used by tools `bpm_run_process` and `bpm_exec_process_element`.
 *
 * BPMSoft 1.8 returns process result wrapped in:
 *   <string xmlns="http://schemas.microsoft.com/2003/10/Serialization/">JSON-payload</string>
 * The payload may be a number, string, or JSON-encoded structure depending on
 * the configured ResultParameter type. The unwrap+parse logic lives here.
 */

import type { BpmConfig } from '../types/index.js';
import { HttpClient } from '../client/http-client.js';
import { BpmApiError } from '../utils/errors.js';
import { isSafeIdentifier } from '../utils/odata.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProcessExecuteResult {
  status: number;
  /** Parsed result of `ResultParameterName` (JSON-decoded if applicable). */
  result?: unknown;
  /** Raw response body (XML envelope or empty string). */
  raw: string;
}

export interface ProcessElementResult {
  status: number;
  raw: string;
}

export class ProcessEngineClient {
  constructor(
    private config: BpmConfig,
    private httpClient: HttpClient
  ) {}

  /**
   * Run a business process by its schema name.
   *
   * @param processName  Process schema name (e.g. `UsrCalculateLeadScore`).
   * @param parameters   Input parameters (mapped to query string).
   * @param options      Optional output extraction (`resultParameterName`).
   */
  async execute(
    processName: string,
    parameters: Record<string, string | number | boolean> = {},
    options?: { resultParameterName?: string }
  ): Promise<ProcessExecuteResult> {
    if (!isSafeIdentifier(processName)) {
      throw new BpmApiError(
        `Недопустимое имя процесса: "${processName}". Разрешены только латинские буквы, цифры и подчёркивания.`,
        0
      );
    }

    for (const key of Object.keys(parameters)) {
      if (!isSafeIdentifier(key)) {
        throw new BpmApiError(
          `Недопустимое имя параметра процесса: "${key}". Разрешены только латинские буквы, цифры и подчёркивания.`,
          0
        );
      }
    }

    if (
      options?.resultParameterName !== undefined &&
      !isSafeIdentifier(options.resultParameterName)
    ) {
      throw new BpmApiError(
        `Недопустимое имя выходного параметра: "${options.resultParameterName}". Разрешены только латинские буквы, цифры и подчёркивания.`,
        0
      );
    }

    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      search.set(key, String(value));
    }
    if (options?.resultParameterName) {
      search.set('ResultParameterName', options.resultParameterName);
    }

    const baseUrl = `${this.config.bpmsoft_url}/ServiceModel/ProcessEngineService.svc/${processName}/Execute`;
    const url = search.toString() ? `${baseUrl}?${search.toString()}` : baseUrl;

    const response = await this.httpClient.request<string>({
      method: 'GET',
      url,
      contentKind: 'metadata',
      responseType: 'text',
    });

    const raw = typeof response.data === 'string' ? response.data : '';
    if (!raw.trim()) {
      return { status: response.status, raw: '' };
    }

    const result = parseProcessResultEnvelope(raw);
    return { status: response.status, result, raw };
  }

  /**
   * Resume a paused process element by its UID. Used to advance human tasks
   * or other intermediate steps inside an already-running process instance.
   */
  async execProcElByUId(processElementUId: string): Promise<ProcessElementResult> {
    if (!GUID_RE.test(processElementUId)) {
      throw new BpmApiError(
        `Недопустимый UID элемента процесса: "${processElementUId}". Ожидается GUID в формате 00000000-0000-0000-0000-000000000000.`,
        0
      );
    }

    const url = `${this.config.bpmsoft_url}/ServiceModel/ProcessEngineService.svc/ExecProcElByUId?ProcessElementUID=${processElementUId}`;

    const response = await this.httpClient.request<string>({
      method: 'GET',
      url,
      contentKind: 'metadata',
      responseType: 'text',
    });

    const raw = typeof response.data === 'string' ? response.data : '';
    return { status: response.status, raw };
  }
}

/**
 * Parse the BPMSoft `<string xmlns="...">payload</string>` envelope.
 *
 * Strategy:
 *   1. If body matches the envelope, extract payload between tags.
 *   2. Try JSON.parse on the payload (covers numbers, booleans, strings, arrays, objects).
 *   3. Fall back to the raw string content.
 *
 * Returns the payload itself (number/string/object/array) or the original body
 * if it does not match the envelope.
 */
function parseProcessResultEnvelope(body: string): unknown {
  const trimmed = body.trim();

  const envelopeMatch = trimmed.match(/^<string\b[^>]*>([\s\S]*)<\/string>\s*$/i);
  const payload = envelopeMatch ? decodeXmlEntities(envelopeMatch[1].trim()) : trimmed;

  if (payload === '') {
    return undefined;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
