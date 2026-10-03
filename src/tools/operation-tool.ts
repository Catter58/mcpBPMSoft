import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { getTool } from './registry.js';
import { notInitialized } from './_guards.js';
import { formatToolError } from '../utils/errors.js';
import { getOperation, listOperations, type OperationRecord } from '../server/operation-journal.js';

function compact(value: unknown, bytes: number): unknown {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  const size = Buffer.byteLength(serialized, 'utf8');
  return size <= bytes ? value : { details_omitted: true, stored_bytes: size };
}

export function operationView(
  record: OperationRecord,
  offset = 0,
  limit = 20,
  includeReceipt = false
): Record<string, unknown> {
  const selected = record.stages.slice(offset, offset + limit);
  const stageBudget = Math.floor((8 * 1024) / Math.max(1, selected.length));
  const stages = selected.map((stage) => {
    const summary = {
      stage_id: stage.stage_id,
      status: stage.status,
      method: stage.method,
      target: stage.target.slice(0, 64),
      started_at: stage.started_at,
      finished_at: stage.finished_at,
      http_status: stage.http_status,
    };
    const full = { ...summary, intent: stage.intent, receipt: stage.receipt };
    return Buffer.byteLength(JSON.stringify(full), 'utf8') <= stageBudget
      ? full
      : { ...summary, details_omitted: true, receipt_available: stage.receipt !== undefined };
  });
  const view: Record<string, unknown> = {
    operation_id: record.operation_id,
    tool: record.tool,
    status: record.status,
    started_at: record.started_at,
    finished_at: record.finished_at,
    requires_state_verification: record.requires_state_verification,
    safe_to_retry: false,
    intent: compact(record.intent, 1024),
    total_stages: record.stages.length,
    stage_offset: offset,
    stages,
    has_more: offset + selected.length < record.stages.length,
    ...(offset + selected.length < record.stages.length
      ? { next_stage_offset: offset + selected.length }
      : {}),
    receipt_available: record.receipt !== undefined,
    ...(includeReceipt ? { receipt: compact(record.receipt, 8 * 1024) } : {}),
  };
  // Count the actual MCP representation: text and structuredContent both consume the read budget.
  const encodedSize = () =>
    Buffer.byteLength(
      JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(view) }],
        structuredContent: { operation: view },
      })
    );
  if (encodedSize() > 60 * 1024) {
    view.receipt = compact(record.receipt, 1024);
    view.intent = compact(record.intent, 256);
    view.stages = stages.map((stage) => ({
      ...stage,
      intent: undefined,
      receipt: undefined,
      details_omitted: true,
    }));
  }
  return view;
}

export function registerOperationTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_get_operation');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        operation_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'operation_id из ответа инструмента изменения. Без него — список своих операций, чтобы найти потерянный ответ. Журнал не повторяет изменения.'
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Начало страницы списка собственных операций; порядок каталога, без гарантии сортировки по времени.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Число собственных операций, по умолчанию 20, максимум 50.'),
        stage_offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Начало страницы этапов, по умолчанию 0.'),
        stage_limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Число этапов на странице, по умолчанию 20; максимум 50.'),
        include_receipt: z
          .boolean()
          .optional()
          .describe(
            'Включить сохранённый ответ, если он помещается в 8 KiB; большой ответ обозначается details_omitted.'
          ),
      },
      outputSchema: {
        operation: z
          .looseObject({
            operation_id: z.string().uuid(),
            status: z.enum(['started', 'not_executed', 'completed', 'failed', 'outcome_unknown']),
            requires_state_verification: z.boolean(),
            safe_to_retry: z.literal(false),
          })
          .optional(),
        operations: z
          .array(z.looseObject({ operation_id: z.string().uuid(), status: z.string() }))
          .optional(),
        offset: z.number().int().nonnegative().optional(),
        has_more: z.boolean().optional(),
        next_offset: z.number().int().nonnegative().optional(),
        order: z.literal('directory').optional(),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        if (!params.operation_id) {
          const page = await listOperations(services, params);
          return { content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: { ...page } };
        }
        const operation = operationView(
          await getOperation(services, params.operation_id),
          params.stage_offset,
          params.stage_limit,
          params.include_receipt
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(operation) }],
          structuredContent: { operation },
        };
      } catch (error) {
        const failure = formatToolError(error);
        return {
          content: [{ type: 'text', text: JSON.stringify(failure) }],
          structuredContent: failure as unknown as Record<string, unknown>,
          isError: true,
        };
      }
    }
  );
}
