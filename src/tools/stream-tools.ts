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
import { readFile, writeFile, stat as fsStat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { getODataBaseUrl } from '../config.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized } from './_guards.js';
import { isSafeIdentifier } from '../utils/odata.js';

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
          file_path: z.string().describe('Путь к файлу для загрузки на сервер'),
          name: z.string().optional().describe('Имя файла в системе (по умолчанию — из пути)'),
          target_collection: z.string().optional(),
          target_id: z.string().optional(),
          target_field: z.string().optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const baseUrl = getODataBaseUrl(services.config);

          let fileBuffer: Buffer;
          try {
            fileBuffer = await readFile(params.file_path);
          } catch {
            return {
              content: [{ type: 'text', text: `Файл не найден: ${params.file_path}` }],
              isError: true,
            };
          }

          if (fileBuffer.length > services.config.max_file_size) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Размер файла (${(fileBuffer.length / 1024 / 1024).toFixed(2)} МБ) превышает лимит (${(services.config.max_file_size / 1024 / 1024).toFixed(0)} МБ)`,
                },
              ],
              isError: true,
            };
          }

          const fileName = params.name || basename(params.file_path);

          const created = await services.odataClient.createRecord<Record<string, unknown>>('SysImage', {
            Name: fileName,
          });
          const imageId = String(created.Id || created.id || '');
          if (!imageId) {
            return {
              content: [{ type: 'text', text: 'Не удалось создать запись в SysImage: отсутствует Id в ответе' }],
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
            await services.odataClient.updateRecord(params.target_collection, params.target_id, linkData);
            lines.push(`  Привязан к: ${params.target_collection}(${params.target_id}).${params.target_field}`);
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
          save_path: z.string().optional().describe('Путь для сохранения файла'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const baseUrl = getODataBaseUrl(services.config);

          let metadata: Record<string, unknown>;
          try {
            metadata = await services.odataClient.getRecord<Record<string, unknown>>('SysImage', params.image_id, {
              $select: 'Id,Name,MimeType',
            });
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
            `  Размер: ${(data?.byteLength ?? 0)} байт`,
          ];

          if (params.save_path) {
            try {
              await writeFile(params.save_path, data);
              lines.push(`  Сохранён: ${params.save_path}`);
            } catch (writeError) {
              lines.push(
                `  Ошибка сохранения: ${writeError instanceof Error ? writeError.message : String(writeError)}`
              );
            }
          } else {
            lines.push('', 'Укажите save_path для сохранения файла на диск.');
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              image_id: params.image_id,
              name: fileName,
              mime_type: mimeType,
              size_bytes: data?.byteLength ?? 0,
              saved_to: params.save_path,
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
          collection: z.string(),
          id: z.string().describe('UUID записи'),
          field: z.string().describe('Имя бинарного поля сущности'),
          file_path: z.string().describe('Локальный путь к файлу'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          if (!isSafeIdentifier(params.field)) {
            return {
              content: [{ type: 'text', text: `Недопустимое имя поля: "${params.field}"` }],
              isError: true,
            };
          }

          let buffer: Buffer;
          try {
            buffer = await readFile(params.file_path);
          } catch {
            return { content: [{ type: 'text', text: `Файл не найден: ${params.file_path}` }], isError: true };
          }
          if (buffer.length > services.config.max_file_size) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Размер файла (${(buffer.length / 1024 / 1024).toFixed(2)} МБ) превышает лимит`,
                },
              ],
              isError: true,
            };
          }

          await services.odataClient.putFieldBinary(params.collection, params.id, params.field, buffer);

          return {
            content: [
              {
                type: 'text',
                text: `Бинарь записан в ${params.collection}(${params.id}).${params.field} (${(buffer.length / 1024).toFixed(1)} КБ).`,
              },
            ],
            structuredContent: {
              collection: params.collection,
              id: params.id,
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
          collection: z.string(),
          id: z.string(),
          field: z.string(),
          save_path: z.string().optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          if (!isSafeIdentifier(params.field)) {
            return {
              content: [{ type: 'text', text: `Недопустимое имя поля: "${params.field}"` }],
              isError: true,
            };
          }

          const buffer = await services.odataClient.getFieldBinary(params.collection, params.id, params.field);

          const lines = [
            `Бинарь ${params.collection}(${params.id}).${params.field}:`,
            `  Размер: ${buffer.byteLength} байт`,
          ];
          if (params.save_path) {
            await writeFile(params.save_path, buffer);
            const st = await fsStat(params.save_path);
            lines.push(`  Сохранён: ${params.save_path} (${st.size} байт)`);
          } else {
            lines.push('', 'Укажите save_path для сохранения файла на диск.');
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              collection: params.collection,
              id: params.id,
              field: params.field,
              size_bytes: buffer.byteLength,
              saved_to: params.save_path,
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
          collection: z.string(),
          id: z.string(),
          field: z.string(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          if (!isSafeIdentifier(params.field)) {
            return {
              content: [{ type: 'text', text: `Недопустимое имя поля: "${params.field}"` }],
              isError: true,
            };
          }
          await services.odataClient.deleteFieldBinary(params.collection, params.id, params.field);
          return {
            content: [
              { type: 'text', text: `Поле ${params.collection}(${params.id}).${params.field} очищено.` },
            ],
            structuredContent: {
              collection: params.collection,
              id: params.id,
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
