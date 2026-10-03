/** Binary operations share metadata validation, exact confirmation, and resumable uploads. */
import * as z from 'zod';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { getRequestAuth } from '../auth/request-context.js';
import { uploadPath, saveDownload } from '../utils/file-access.js';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { MIMEType } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { BpmApiError, UnknownCollectionError, UnknownFieldError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized, resolveRecordId } from './_guards.js';
import { assertGuid } from '../utils/odata.js';
import { coerceFieldValue } from '../utils/field-values.js';
import {
  confirmParam,
  confirmationTokenParam,
  confirmationResponse,
  createConfirmationPlan,
  consumeConfirmationPlan,
  operationFingerprint,
} from '../utils/confirm.js';
import {
  creationRecordId,
  recordId,
  recordEtag,
  writeToolError,
  writeFailureState,
  validateIdempotencyKey,
  validateRequiredCreateFields,
  type WriteState,
} from '../utils/write-safety.js';

interface Step {
  step: string;
  id: string;
  state: WriteState;
  error?: string;
}
const mimeTypes = createRequire(import.meta.url)('mime-types') as { lookup(path: string): string | false };
function uploadMimeType(name: string, override?: string): string {
  const candidate = override ?? (mimeTypes.lookup(name) || 'application/octet-stream');
  try {
    if (typeof candidate !== 'string' || candidate.includes('\r') || candidate.includes('\n'))
      throw new Error();
    return new MIMEType(candidate).toString();
  } catch {
    throw new BpmApiError(
      'mime_type должен содержать корректный MIME-тип, например image/png.',
      400,
      'SysImage'
    );
  }
}
const stepShape = z.object({
  step: z.string(),
  id: z.string(),
  state: z.enum(['succeeded', 'failed', 'not_executed', 'outcome_unknown']),
  error: z.string().optional(),
});
function failure(error: unknown, collection?: string, extra: Record<string, unknown> = {}): CallToolResult {
  const output = { ...writeToolError(error, collection), ...extra };
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
    isError: true,
  };
}
async function readUpload(services: ServiceContainer, path: string): Promise<Buffer> {
  if (typeof path !== 'string' || !path.trim())
    throw new BpmApiError('Передайте file_path на файловой системе MCP-сервера.', 400);
  const safePath = await uploadPath(services, path);
  let handle;
  try {
    handle = await open(
      safePath,
      getRequestAuth() === undefined ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW
    );
  } catch {
    throw new BpmApiError('Файл не найден или недоступен на файловой системе MCP-сервера.', 404);
  }
  let buffer: Buffer;
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new BpmApiError('file_path должен указывать на обычный файл.', 400);
    if (fileStat.size > services.config.max_file_size)
      throw new BpmApiError(`Размер файла превышает лимит ${services.config.max_file_size} байт.`, 400);
    buffer = await handle.readFile();
    if (buffer.length > services.config.max_file_size)
      throw new BpmApiError('Файл вырос во время чтения и превышает лимит.', 400);
  } finally {
    await handle.close();
  }

  return buffer;
}
async function fieldReference(
  services: ServiceContainer,
  collectionQuery: string,
  fieldQuery: string,
  binary: boolean
) {
  const collection = await services.metadataManager.resolveCollectionReference(collectionQuery);
  if (collection.name === null) throw new UnknownCollectionError(collectionQuery, collection.suggestions);
  const field = await services.metadataManager.resolveFieldReference(collection.name, fieldQuery);
  if (field.name === null) throw new UnknownFieldError(fieldQuery, collection.name, field.suggestions);
  const entity = await services.metadataManager.getEntityMetadata(collection.name);
  const property = entity.properties.find((p) => p.name === field.name);
  if (!property || (binary && !['Edm.Binary', 'Edm.Stream'].includes(property.type)))
    throw new BpmApiError(`Поле ${field.name} не является бинарным.`, 400, collection.name);
  return {
    collection: collection.name,
    field: field.name,
    property,
    metadata: entity,
    fieldType:
      property.type === 'Edm.Binary'
        ? ('Edm.Binary' as const)
        : property.type === 'Edm.Stream'
          ? ('Edm.Stream' as const)
          : undefined,
  };
}
function binarySummary(buffer: Buffer) {
  return { size_bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
}
async function existingBinary(
  services: ServiceContainer,
  collection: string,
  id: string,
  field: string,
  fieldType?: 'Edm.Binary' | 'Edm.Stream'
): Promise<Buffer | undefined> {
  try {
    return await services.odataClient.getFieldBinary(collection, id, field, { fieldType });
  } catch (error) {
    if (error instanceof BpmApiError && error.httpStatus === 404) return undefined;
    throw error;
  }
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(2);

/** Байты для загрузки: из content_base64 или из файла (размер проверяется ДО чтения). */
async function loadUploadBytes(
  services: ServiceContainer,
  filePath: string | undefined,
  contentBase64: string | undefined
): Promise<Buffer> {
  if ((filePath !== undefined) === (contentBase64 !== undefined))
    throw new BpmApiError('Укажите ровно один из параметров: file_path или content_base64.', 400);
  if (contentBase64 === undefined) return readUpload(services, filePath!);
  const maxSize = services.config.max_file_size;
  if (contentBase64.length > Math.ceil(maxSize / 3) * 4)
    throw new BpmApiError(`Размер данных превышает лимит ${maxSize} байт.`, 400);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 === 1)
    throw new BpmApiError('content_base64 должен содержать корректный base64.', 400);
  const buffer = Buffer.from(contentBase64, 'base64');
  const canonical = buffer.toString('base64');
  if ((contentBase64.includes('=') ? canonical : canonical.replace(/=+$/, '')) !== contentBase64)
    throw new BpmApiError('content_base64 должен содержать корректный base64.', 400);
  if (buffer.length > maxSize) throw new BpmApiError(`Размер данных превышает лимит ${maxSize} байт.`, 400);
  return buffer;
}

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
      'Путь к файлу на хосте MCP-сервера (в stdio или по относительному пути внутри личного каталога пользователя и стенда). Альтернатива — content_base64'
    ),
  content_base64: z.string().optional().describe('Содержимое файла в base64 (вместо file_path)'),
};

const downloadShape = {
  save_path: z
    .string()
    .optional()
    .describe(
      'Путь для сохранения на хосте MCP-сервера (в stdio или по относительному пути внутри личного каталога пользователя и стенда)'
    ),
  return_base64: z
    .boolean()
    .optional()
    .describe('true — вернуть содержимое в structuredContent.content_base64 (если не больше лимита размера)'),
};

export function registerStreamTools(server: McpServer, services: ServiceContainer): void {
  {
    const meta = getTool('bpm_upload_file');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          ...uploadShape,
          name: z.string().optional(),
          mime_type: z
            .string()
            .optional()
            .describe(
              'MIME-тип для файла без известного расширения. Обычно сервер определяет его по имени автоматически.'
            ),
          target_collection: z.string().optional(),
          target_id: z.string().optional().describe('UUID или точное название целевой записи.'),
          target_field: z.string().optional(),
          target_expected_etag: z.string().optional(),
          image_id: z
            .string()
            .uuid()
            .optional()
            .describe('UUID SysImage из частичного результата для продолжения загрузки.'),
          idempotency_key: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe(
              'Ключ одной загрузки. Повтор использует тот же SysImage; содержимое и имя должны совпадать.'
            ),
        },
        outputSchema: {
          image_id: z.string(),
          name: z.string(),
          mime_type: z.string(),
          size_bytes: z.number().int(),
          linked: z.boolean(),
          outcomes: z.array(stepShape),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let imageId: string | undefined;
        let targetId: string | undefined;
        let current: Step | undefined;
        let currentWriteStarted = false;
        const outcomes: Step[] = [];
        try {
          await services.authManager.ensureAuthenticated();
          validateIdempotencyKey(params.idempotency_key);
          const buffer = await loadUploadBytes(services, params.file_path, params.content_base64);
          const name = params.name ?? (params.file_path ? basename(params.file_path) : '');
          if (params.content_base64 !== undefined && params.name === undefined)
            throw new BpmApiError('При content_base64 укажите name — имя файла.', 400, 'SysImage');
          if (!name.trim()) throw new BpmApiError('Имя файла не может быть пустым.', 400, 'SysImage');
          const requestedMime = uploadMimeType(name, params.mime_type);
          const provided = [params.target_collection, params.target_id, params.target_field].filter(
            (v) => v !== undefined
          ).length;
          if (provided !== 0 && provided !== 3)
            throw new BpmApiError(
              'Для привязки передайте target_collection, target_id и target_field вместе.',
              400
            );
          if (params.target_expected_etag !== undefined && !provided)
            throw new BpmApiError('target_expected_etag требует целевую запись.', 400);
          imageId = creationRecordId(
            services,
            params.image_id ? { Id: params.image_id } : {},
            params.idempotency_key,
            'upload-file'
          );
          const binary = await fieldReference(services, 'SysImage', 'Data', true);
          const hasMimeType = binary.metadata.properties.some((property) => property.name === 'MimeType');
          if (params.mime_type !== undefined && !hasMimeType)
            throw new BpmApiError(
              'SysImage не содержит поле MimeType; явный mime_type не поддерживается этой схемой.',
              400,
              'SysImage'
            );
          let target: Awaited<ReturnType<typeof fieldReference>> | undefined;
          let linkData: Record<string, unknown> | undefined;
          let targetSnapshot: Record<string, unknown> | undefined;
          if (provided) {
            target = await fieldReference(services, params.target_collection!, params.target_field!, false);
            targetId = (
              await resolveRecordId(services, target.collection, params.target_id!, { fuzzy: false })
            ).id;
            assertGuid(targetId, 'target_id');
            if (
              target.property.type !== 'Edm.Guid' ||
              !target.property.isLookup ||
              target.property.lookupCollection !== 'SysImage'
            )
              throw new BpmApiError('Целевое поле должно ссылаться на SysImage.', 400, target.collection);
            targetSnapshot = await services.odataClient.getRecord<Record<string, unknown>>(
              target.collection,
              targetId!
            );
            if (params.target_expected_etag !== undefined)
              await services.odataClient.assertExpectedEtag(
                target.collection,
                targetId!,
                params.target_expected_etag
              );
            linkData = { [target.field]: coerceFieldValue(imageId, target.property, target.collection) };
          }
          const imageData = (
            await services.lookupResolver.resolveDataLookups('SysImage', {
              Name: name,
              ...(hasMimeType ? { MimeType: requestedMime } : {}),
            })
          ).data;
          if (!params.image_id) await validateRequiredCreateFields(services, 'SysImage', imageData);
          current = { step: 'create_image', id: imageId, state: 'not_executed' };
          let existingImage: Record<string, unknown> | undefined;
          if (params.image_id || params.idempotency_key) {
            try {
              existingImage = await services.odataClient.getRecord<Record<string, unknown>>(
                'SysImage',
                imageId
              );
            } catch (error) {
              if (
                !(
                  params.idempotency_key &&
                  !params.image_id &&
                  error instanceof BpmApiError &&
                  error.httpStatus === 404
                )
              )
                throw error;
            }
          }
          let effectiveMime = requestedMime;
          if (existingImage) {
            const image = existingImage;
            if (image.Name !== name)
              throw new BpmApiError(
                'Имя существующего SysImage отличается от имени загрузки.',
                409,
                'SysImage'
              );
            const storedMime = typeof image.MimeType === 'string' ? image.MimeType.trim() : '';
            if (
              hasMimeType &&
              storedMime &&
              storedMime.toLowerCase() !== requestedMime.toLowerCase() &&
              (params.mime_type !== undefined || params.idempotency_key)
            )
              throw new BpmApiError(
                'MIME-тип существующего SysImage отличается от MIME-типа загрузки. Проверьте image_id; для новой загрузки используйте новый ключ.',
                409,
                'SysImage'
              );
            effectiveMime = storedMime || requestedMime;
          } else {
            currentWriteStarted = true;
            const image = await services.odataClient.createRecord<Record<string, unknown>>(
              'SysImage',
              imageData,
              { id: imageId }
            );
            imageId = recordId(image);
          }
          outcomes.push({ ...current, id: imageId, state: 'succeeded' });
          current = undefined;
          currentWriteStarted = false;
          if (
            existingImage &&
            hasMimeType &&
            (typeof existingImage.MimeType !== 'string' || !existingImage.MimeType.trim())
          ) {
            current = { step: 'prepare_image', id: imageId, state: 'not_executed' };
            currentWriteStarted = true;
            await services.odataClient.updateRecord(
              'SysImage',
              imageId,
              { MimeType: requestedMime },
              { expectedEtag: recordEtag(existingImage) }
            );
            outcomes.push({ ...current, state: 'succeeded' });
            current = undefined;
            currentWriteStarted = false;
          }
          current = { step: 'upload_data', id: imageId, state: 'not_executed' };
          const oldData = await existingBinary(
            services,
            binary.collection,
            imageId,
            binary.field,
            binary.fieldType
          );
          const identical =
            oldData !== undefined && binarySummary(oldData).sha256 === binarySummary(buffer).sha256;
          if (params.idempotency_key && oldData && oldData.length && !identical)
            throw new BpmApiError(
              'idempotency_key уже связан с другим содержимым файла. Для новой загрузки используйте новый ключ.',
              409,
              'SysImage'
            );
          if (!identical) {
            currentWriteStarted = true;
            await services.odataClient.putFieldBinary(binary.collection, imageId, binary.field, buffer, {
              fieldType: binary.fieldType,
            });
          }
          outcomes.push({ ...current, state: 'succeeded' });
          current = undefined;
          currentWriteStarted = false;
          if (target && linkData) {
            current = { step: 'link_image', id: targetId!, state: 'not_executed' };
            const expectedEtag = params.target_expected_etag ?? recordEtag(targetSnapshot!);
            const actualTarget = await services.odataClient.getRecord<Record<string, unknown>>(
              target.collection,
              targetId!
            );
            if (actualTarget[target.field] !== imageId) {
              if (
                !expectedEtag &&
                operationFingerprint({ value: actualTarget[target.field] }) !==
                  operationFingerprint({ value: targetSnapshot![target.field] })
              ) {
                throw new BpmApiError(
                  'Ссылка на файл изменилась во время загрузки. Файл сохранён, но новая связь не записана; проверьте целевую запись.',
                  412,
                  target.collection
                );
              }
              currentWriteStarted = true;
              await services.odataClient.updateRecord(target.collection, targetId!, linkData, {
                expectedEtag,
              });
            }
            outcomes.push({ ...current, state: 'succeeded' });
            current = undefined;
          }
          const output = {
            image_id: imageId,
            name,
            mime_type: effectiveMime,
            size_bytes: buffer.length,
            linked: !!target,
            outcomes,
          };
          return {
            content: [
              {
                type: 'text',
                text: `Файл загружен: ${name} (${buffer.length} байт), UUID ${imageId}${target ? ' и привязан к записи' : ''}.`,
              },
            ],
            structuredContent: output,
          };
        } catch (error) {
          if (current)
            outcomes.push({
              ...current,
              state: currentWriteStarted ? writeFailureState(error) : 'not_executed',
              error: error instanceof Error ? error.message : String(error),
            });
          if (imageId && !outcomes.some((o) => o.step === 'upload_data'))
            outcomes.push({ step: 'upload_data', id: imageId, state: 'not_executed' });
          if (params.target_id && !outcomes.some((o) => o.step === 'link_image'))
            outcomes.push({ step: 'link_image', id: targetId ?? params.target_id, state: 'not_executed' });
          return failure(error, 'SysImage', {
            image_id: imageId ?? null,
            outcomes,
            ...(imageId
              ? {
                  next_steps: [
                    'Проверьте состояния шагов. Для продолжения используйте image_id из результата, тот же файл и те же параметры; повторное создание SysImage не требуется.',
                  ],
                }
              : {}),
          });
        }
      }
    );
  }
  {
    const meta = getTool('bpm_download_file');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          image_id: z.string().uuid(),
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
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          assertGuid(params.image_id, 'image_id');
          const binary = await fieldReference(services, 'SysImage', 'Data', true);
          const metadata = await services.odataClient.getRecord<Record<string, unknown>>(
            'SysImage',
            params.image_id,
            {
              $select: [
                'Id',
                'Name',
                ...(binary.metadata.properties.some((property) => property.name === 'MimeType')
                  ? ['MimeType']
                  : []),
              ].join(','),
            }
          );
          const buffer = await services.odataClient.getFieldBinary(
            binary.collection,
            params.image_id,
            binary.field,
            { fieldType: binary.fieldType }
          );
          if (params.save_path) await saveDownload(services, params.save_path, buffer);
          const lines: string[] = [];
          const base64 = base64Part(buffer, params.return_base64, services.config.max_file_size, lines);
          const output = {
            image_id: params.image_id,
            name: String(metadata.Name ?? 'file'),
            mime_type: String(metadata.MimeType ?? 'application/octet-stream'),
            size_bytes: buffer.length,
            ...(params.save_path ? { saved_to: params.save_path } : {}),
            ...base64,
          };
          return {
            content: [
              {
                type: 'text',
                text: [
                  `${output.name}: ${buffer.length} байт.`,
                  ...(params.save_path ? [`Сохранён: ${params.save_path}`] : []),
                  ...lines,
                ].join('\n'),
              },
            ],
            structuredContent: output,
            isError: false,
          };
        } catch (error) {
          return failure(error, 'SysImage');
        }
      }
    );
  }
  for (const name of ['bpm_field_upload', 'bpm_field_download', 'bpm_field_delete'] as const) {
    const meta = getTool(name);
    const upload = name === 'bpm_field_upload';
    const deleting = name === 'bpm_field_delete';
    const base = {
      collection: z.string(),
      id: z.string().describe('UUID или точное название записи.'),
      field: z.string(),
    };
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: upload
          ? z.object({ ...base, ...uploadShape })
          : deleting
            ? z.object({ ...base, confirm: confirmParam, confirmation_token: confirmationTokenParam })
            : z.object({
                ...base,
                ...downloadShape,
              }),
        outputSchema: {
          collection: z.string(),
          id: z.string(),
          field: z.string(),
          size_bytes: z.number().int().optional(),
          saved_to: z.string().optional(),
          content_base64: z.string().optional(),
          deleted: z.boolean().optional(),
          requires_confirmation: z.boolean().optional(),
          code: z.string().optional(),
          confirmation_token: z.string().optional(),
          sha256: z.string().optional(),
          concurrency_protection: z.literal('snapshot_only').optional(),
        },
      },
      async (params: {
        collection: string;
        id: string;
        field: string;
        file_path?: string;
        content_base64?: string;
        save_path?: string;
        return_base64?: boolean;
        confirm?: boolean;
        confirmation_token?: string;
      }): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let writeStarted = false;
        let id = params.id;
        try {
          await services.authManager.ensureAuthenticated();
          const ref = await fieldReference(services, params.collection, params.field, true);
          id = (await resolveRecordId(services, ref.collection, id, { fuzzy: false })).id;
          assertGuid(id, 'id');
          const record = await services.odataClient.getRecord<Record<string, unknown>>(ref.collection, id);
          if (upload) {
            const buffer = await loadUploadBytes(services, params.file_path, params.content_base64);
            writeStarted = true;
            await services.odataClient.putFieldBinary(ref.collection, id, ref.field, buffer, {
              fieldType: ref.fieldType,
            });
            const output = {
              collection: ref.collection,
              id: id,
              field: ref.field,
              size_bytes: buffer.length,
            };
            return {
              content: [
                {
                  type: 'text',
                  text: `Файл записан в ${ref.collection}(${id}).${ref.field}: ${buffer.length} байт.`,
                },
              ],
              structuredContent: output,
            };
          }
          const buffer = await existingBinary(services, ref.collection, id, ref.field, ref.fieldType);
          const summary = buffer ? binarySummary(buffer) : { size_bytes: 0, sha256: 'absent' };
          const output = { collection: ref.collection, id: id, field: ref.field, ...summary };
          if (deleting) {
            const operation = { tool: name, ...output, record };
            if (params.confirm !== true)
              return confirmationResponse(
                name,
                [`Будет очищено поле ${ref.collection}(${id}).${ref.field}, ${summary.size_bytes} байт.`],
                {
                  ...output,
                  concurrency_protection: 'snapshot_only',
                  confirmation_token: createConfirmationPlan(services, operation),
                }
              );
            consumeConfirmationPlan(services, params.confirmation_token, operation);
            writeStarted = true;
            await services.odataClient.deleteFieldBinary(ref.collection, id, ref.field, {
              fieldType: ref.fieldType,
            });
            return {
              content: [{ type: 'text', text: `Поле ${ref.collection}(${id}).${ref.field} очищено.` }],
              structuredContent: { ...output, deleted: true },
            };
          }
          if (!buffer) throw new BpmApiError('Бинарное содержимое отсутствует.', 404, ref.collection);
          if (params.save_path) await saveDownload(services, params.save_path, buffer);
          const lines: string[] = [];
          const base64 = base64Part(buffer, params.return_base64, services.config.max_file_size, lines);
          return {
            content: [
              {
                type: 'text',
                text: [
                  `Файл ${ref.collection}(${id}).${ref.field}: ${buffer.length} байт${params.save_path ? `, сохранён: ${params.save_path}` : ''}.`,
                  ...lines,
                ].join('\n'),
              },
            ],
            structuredContent: {
              ...output,
              ...(params.save_path ? { saved_to: params.save_path } : {}),
              ...base64,
            },
          };
        } catch (error) {
          return failure(error, params.collection, {
            id: id,
            field: params.field,
            ...(writeStarted ? { state: writeFailureState(error) } : {}),
          });
        }
      }
    );
  }
}
