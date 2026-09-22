/**
 * MCP Tools: File / Stream operations
 *
 * SysImage workflow (legacy convenience tools):
 *   bpm_upload_file   — POST SysImage + PUT Data + (optional) PATCH link
 *   bpm_download_file — GET SysImage Data, save to disk
 *
 * Direct binary field I/O (per Postman "Поток данных"):
 *   bpm_field_upload   — PUT raw bytes to {Collection}({id})/{FieldName}
 *   bpm_field_download — GET raw bytes from same path
 *   bpm_field_delete   — DELETE binary content
 */

import * as z from 'zod';
import { readFile, writeFile, stat as fsStat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { getODataBaseUrl } from '../config.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized, resolveCollectionName, resolveRecordId } from './_guards.js';
import { isSafeIdentifier } from '../utils/odata.js';
import { confirmParam, confirmationRequired, confirmationResponse } from '../utils/confirm.js';
import { confirmShape } from './_schemas.js';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

type PathCheck = { ok: true; path: string } | { ok: false; error: string };

/**
 * Единственная точка допуска локальных путей. В HTTP-режиме любой держатель
 * cookies BPMSoft иначе читал бы/писал бы произвольные файлы на хосте MCP.
 * Разрешено: stdio-транспорт (локальный процесс пользователя) либо путь внутри
 * BPMSOFT_FILE_ROOT после realpath (симлинки наружу не проходят).
 * Для записи realpath берётся от самого файла, если он есть, иначе от родителя.
 */
export async function checkLocalPath(input: string, forWrite: boolean): Promise<PathCheck> {
  if (process.env.MCP_TRANSPORT === 'stdio') return { ok: true, path: input };
  const root = process.env.BPMSOFT_FILE_ROOT;
  if (!root) {
    return {
      ok: false,
      error:
        'Работа с локальными файлами сервера отключена в HTTP-режиме. ' +
        (forWrite
          ? 'Используйте return_base64=true, чтобы получить содержимое в ответе, '
          : 'Передайте содержимое файла в параметре content_base64, ') +
        'или попросите администратора задать BPMSOFT_FILE_ROOT (каталог, внутри которого разрешены файлы).',
    };
  }
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    const abs = resolve(realRoot, input);
    if (!forWrite) {
      real = await realpath(abs);
    } else {
      try {
        real = await realpath(abs);
      } catch {
        real = join(await realpath(dirname(abs)), basename(abs));
      }
    }
  } catch {
    return { ok: false, error: `Файл или каталог не найден: ${input}` };
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return { ok: false, error: `Путь ${input} вне разрешённого каталога BPMSOFT_FILE_ROOT (${realRoot}).` };
  }
  return { ok: true, path: real };
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(2);

/** Байты для загрузки: из content_base64 или из файла (размер проверяется ДО чтения). */
async function loadUploadBytes(
  filePath: string | undefined,
  contentBase64: string | undefined,
  maxSize: number
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  if (!filePath === !contentBase64) {
    return { ok: false, error: 'Укажите ровно один из параметров: file_path или content_base64.' };
  }
  const limit = `превышает лимит (${mb(maxSize)} МБ)`;
  if (contentBase64) {
    const buffer = Buffer.from(contentBase64, 'base64');
    if (buffer.length > maxSize)
      return { ok: false, error: `Размер данных (${mb(buffer.length)} МБ) ${limit}` };
    return { ok: true, buffer };
  }
  const checked = await checkLocalPath(filePath!, false);
  if (!checked.ok) return checked;
  try {
    const st = await fsStat(checked.path);
    if (!st.isFile()) return { ok: false, error: `Не файл: ${filePath}` };
    if (st.size > maxSize) return { ok: false, error: `Размер файла (${mb(st.size)} МБ) ${limit}` };
    return { ok: true, buffer: await readFile(checked.path) };
  } catch {
    return { ok: false, error: `Файл не найден: ${filePath}` };
  }
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Опциональное base64 в structuredContent (не в тексте — чтобы не раздувать контекст). */
function base64Part(
  data: Buffer,
  returnBase64: boolean | undefined,
  maxSize: number,
  lines: string[]
): { content_base64?: string } {
  if (!returnBase64) return {};
  if (data.byteLength > maxSize) {
    lines.push(
      `  base64 не возвращён: размер (${mb(data.byteLength)} МБ) превышает лимит (${mb(maxSize)} МБ).`
    );
    return {};
  }
  lines.push('  Содержимое в base64 — в structuredContent.content_base64.');
  return { content_base64: Buffer.from(data).toString('base64') };
}

const uploadShape = {
  file_path: z
    .string()
    .optional()
    .describe(
      'Путь к файлу на хосте MCP-сервера (только stdio-режим или внутри BPMSOFT_FILE_ROOT). Альтернатива — content_base64'
    ),
  content_base64: z.string().optional().describe('Содержимое файла в base64 (вместо file_path)'),
};

const downloadShape = {
  save_path: z
    .string()
    .optional()
    .describe('Путь для сохранения на хосте MCP-сервера (только stdio-режим или внутри BPMSOFT_FILE_ROOT)'),
  return_base64: z
    .boolean()
    .optional()
    .describe('true — вернуть содержимое в structuredContent.content_base64 (если не больше лимита размера)'),
};

export function registerStreamTools(server: McpServer, services: ServiceContainer): void {
  // bpm_upload_file (SysImage)
  {
    const meta = getTool('bpm_upload_file');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          ...uploadShape,
          name: z
            .string()
            .optional()
            .describe('Имя файла в системе (по умолчанию — из пути; обязательно при content_base64)'),
          target_collection: z
            .string()
            .optional()
            .describe('Коллекция записи, к которой привязывается файл (вместе с target_id и target_field)'),
          target_id: z.string().optional().describe('UUID или название записи, к которой привязывается файл'),
          target_field: z
            .string()
            .optional()
            .describe('Поле-ссылка в записи, куда записывается UUID загруженного файла'),
        },
        outputSchema: {
          image_id: z.string(),
          name: z.string(),
          size_bytes: z.number().int(),
          linked: z.boolean(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const baseUrl = getODataBaseUrl(services.config);

          const fileName = params.name || (params.file_path ? basename(params.file_path) : '');
          if (!fileName) return errorResult('При content_base64 укажите name — имя файла с расширением.');
          const loaded = await loadUploadBytes(
            params.file_path,
            params.content_base64,
            services.config.max_file_size
          );
          if (!loaded.ok) return errorResult(loaded.error);
          const fileBuffer = loaded.buffer;

          // Без MimeType BPMSoft потом не отдаёт Data: 500 FormatException на пустом заголовке.
          const created = await services.odataClient.createRecord<Record<string, unknown>>('SysImage', {
            Name: fileName,
            MimeType: MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? 'application/octet-stream',
          });
          const imageId = String(created.Id || created.id || '');
          if (!imageId) {
            return {
              content: [
                { type: 'text', text: 'Не удалось создать запись в SysImage: отсутствует Id в ответе' },
              ],
              isError: true,
            };
          }

          // contentKind:'binary' so HttpClient does NOT JSON-stringify the buffer
          const putUrl = `${baseUrl}/SysImage(${imageId})/Data`;
          await services.httpClient.request({
            method: 'PUT',
            url: putUrl,
            body: fileBuffer,
            contentKind: 'binary',
          });

          const lines = [
            'Файл загружен в SysImage:',
            `  ID: ${imageId}`,
            `  Имя: ${fileName}`,
            `  Размер: ${(fileBuffer.length / 1024).toFixed(1)} КБ`,
          ];

          if (params.target_collection && params.target_id && params.target_field) {
            const linkData: Record<string, unknown> = { [params.target_field]: imageId };
            const target = await resolveRecordId(services, params.target_collection, params.target_id);
            await services.odataClient.updateRecord(params.target_collection, target.id, linkData);
            lines.push(
              `  Привязан к: ${params.target_collection}(${params.target_id}).${params.target_field}`
            );
          } else if (params.target_collection || params.target_id || params.target_field) {
            lines.push(
              '',
              'Для привязки файла к записи укажите все три параметра: target_collection, target_id, target_field.'
            );
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              image_id: imageId,
              name: fileName,
              size_bytes: fileBuffer.length,
              linked: !!(params.target_collection && params.target_id && params.target_field),
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, 'SysImage');
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }

  // bpm_download_file (SysImage)
  {
    const meta = getTool('bpm_download_file');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          image_id: z.string().describe('UUID записи в SysImage'),
          ...downloadShape,
        },
        outputSchema: {
          image_id: z.string(),
          name: z.string(),
          mime_type: z.string(),
          size_bytes: z.number().int(),
          saved_to: z.string().optional(),
          content_base64: z.string().optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          let savePath: string | undefined;
          if (params.save_path) {
            const checked = await checkLocalPath(params.save_path, true);
            if (!checked.ok) return errorResult(checked.error);
            savePath = checked.path;
          }
          await services.authManager.ensureAuthenticated();
          const baseUrl = getODataBaseUrl(services.config);

          let metadata: Record<string, unknown>;
          try {
            metadata = await services.odataClient.getRecord<Record<string, unknown>>(
              'SysImage',
              params.image_id,
              {
                $select: 'Id,Name,MimeType',
              }
            );
          } catch {
            return {
              content: [{ type: 'text', text: `Запись SysImage(${params.image_id}) не найдена` }],
              isError: true,
            };
          }

          const fileName = String(metadata.Name || 'file');
          const mimeType = String(metadata.MimeType || 'application/octet-stream');

          const dataUrl = `${baseUrl}/SysImage(${params.image_id})/Data`;
          const response = await services.httpClient.request<Buffer>({
            method: 'GET',
            url: dataUrl,
            contentKind: 'binary',
            responseType: 'binary',
          });
          const data = response.data;

          const lines = [
            `Файл из SysImage(${params.image_id}):`,
            `  Имя: ${fileName}`,
            `  MIME-тип: ${mimeType}`,
            `  Размер: ${data?.byteLength ?? 0} байт`,
          ];

          if (savePath) {
            try {
              await writeFile(savePath, data);
              lines.push(`  Сохранён: ${params.save_path}`);
            } catch (writeError) {
              lines.push(
                `  Ошибка сохранения: ${writeError instanceof Error ? writeError.message : String(writeError)}`
              );
            }
          } else if (!params.return_base64) {
            lines.push('', 'Укажите save_path или return_base64=true, чтобы получить содержимое.');
          }
          const b64 = base64Part(data, params.return_base64, services.config.max_file_size, lines);

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              image_id: params.image_id,
              name: fileName,
              mime_type: mimeType,
              size_bytes: data?.byteLength ?? 0,
              saved_to: params.save_path,
              ...b64,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, 'SysImage');
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }

  // bpm_field_upload — PUT to {Coll}({id})/{Field}
  {
    const meta = getTool('bpm_field_upload');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          id: z.string().describe('UUID записи или её название (Name/Title)'),
          field: z.string().describe('Имя бинарного поля сущности'),
          ...uploadShape,
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          field: z.string(),
          size_bytes: z.number().int(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const { id } = await resolveRecordId(services, collection, params.id);

          if (!isSafeIdentifier(params.field)) {
            return {
              content: [{ type: 'text', text: `Недопустимое имя поля: "${params.field}"` }],
              isError: true,
            };
          }

          const loaded = await loadUploadBytes(
            params.file_path,
            params.content_base64,
            services.config.max_file_size
          );
          if (!loaded.ok) return errorResult(loaded.error);
          const buffer = loaded.buffer;

          await services.odataClient.putFieldBinary(collection, id, params.field, buffer);

          return {
            content: [
              {
                type: 'text',
                text: `Бинарь записан в ${collection}(${id}).${params.field} (${(buffer.length / 1024).toFixed(1)} КБ).`,
              },
            ],
            structuredContent: {
              collection: collection,
              id,
              field: params.field,
              size_bytes: buffer.length,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }

  // bpm_field_download — GET from {Coll}({id})/{Field}
  {
    const meta = getTool('bpm_field_download');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          id: z.string().describe('UUID записи или её название (Name/Title)'),
          field: z.string().describe('Имя бинарного поля сущности'),
          ...downloadShape,
        },
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          field: z.string(),
          size_bytes: z.number().int(),
          saved_to: z.string().optional(),
          content_base64: z.string().optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          let savePath: string | undefined;
          if (params.save_path) {
            const checked = await checkLocalPath(params.save_path, true);
            if (!checked.ok) return errorResult(checked.error);
            savePath = checked.path;
          }
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const { id } = await resolveRecordId(services, collection, params.id);
          if (!isSafeIdentifier(params.field)) {
            return {
              content: [{ type: 'text', text: `Недопустимое имя поля: "${params.field}"` }],
              isError: true,
            };
          }

          const buffer = await services.odataClient.getFieldBinary(collection, id, params.field);

          const lines = [
            `Бинарь ${collection}(${id}).${params.field}:`,
            `  Размер: ${buffer.byteLength} байт`,
          ];
          if (savePath) {
            await writeFile(savePath, buffer);
            const st = await fsStat(savePath);
            lines.push(`  Сохранён: ${params.save_path} (${st.size} байт)`);
          } else if (!params.return_base64) {
            lines.push('', 'Укажите save_path или return_base64=true, чтобы получить содержимое.');
          }
          const b64 = base64Part(buffer, params.return_base64, services.config.max_file_size, lines);

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              collection: collection,
              id,
              field: params.field,
              size_bytes: buffer.byteLength,
              saved_to: params.save_path,
              ...b64,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }

  // bpm_field_delete
  {
    const meta = getTool('bpm_field_delete');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
          id: z.string().describe('UUID записи или её название (Name/Title)'),
          field: z.string().describe('Имя бинарного поля сущности'),
          confirm: confirmParam,
        },
        outputSchema: {
          ...confirmShape,
          collection: z.string(),
          id: z.string(),
          field: z.string(),
          deleted: z.boolean().optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const { id } = await resolveRecordId(services, collection, params.id);
          if (!isSafeIdentifier(params.field)) {
            return {
              content: [{ type: 'text', text: `Недопустимое имя поля: "${params.field}"` }],
              isError: true,
            };
          }

          if (confirmationRequired(params)) {
            return confirmationResponse(
              meta.name,
              [`Будет очищено поле ${collection}(${id}).${params.field}.`],
              { collection: collection, id, field: params.field }
            );
          }

          await services.odataClient.deleteFieldBinary(collection, id, params.field);
          return {
            content: [{ type: 'text', text: `Поле ${collection}(${id}).${params.field} очищено.` }],
            structuredContent: {
              collection: collection,
              id,
              field: params.field,
              deleted: true,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return { content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }], isError: true };
        }
      }
    );
  }
}
