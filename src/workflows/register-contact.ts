/**
 * MCP Tool: bpm_register_contact
 *
 * Composite workflow: optional Account find-or-create + Contact creation
 * with auto-detected Contact->Account lookup field.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized } from '../tools/_guards.js';
import { findOrCreate } from './find-or-create.js';

export function registerRegisterContactTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_register_contact');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        name: z.string().describe('ФИО контакта (обязательное поле Name)'),
        email: z.string().optional().describe('Email контакта'),
        phone: z.string().optional().describe('Телефон контакта'),
        account_name: z
          .string()
          .optional()
          .describe(
            'Название контрагента. Если указано — будет найден или создан Account и привязан к контакту.'
          ),
        position: z.string().optional().describe('Должность контакта (Job)'),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Дополнительные поля контакта. Имена полей могут быть на русском (caption) или латинице.'
          ),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const warnings: string[] = [];

        let accountId: string | null = null;
        let accountCreated = false;
        if (params.account_name) {
          const accountResult = await findOrCreate(
            services,
            'Account',
            { field: 'Name', value: params.account_name },
            { Name: params.account_name }
          );
          accountId = accountResult.id;
          accountCreated = accountResult.created;
        }

        let accountField: string | null = null;
        if (accountId) {
          const contactMeta = await services.metadataManager.getEntityMetadata('Contact');
          const accountLookup = contactMeta.properties.find(
            (p) => p.isLookup && p.lookupCollection === 'Account'
          );
          if (accountLookup) {
            accountField = accountLookup.name;
          } else {
            warnings.push(
              'Не найдено связи Contact -> Account в метаданных; контакт создан без привязки к контрагенту.'
            );
          }
        }

        const contactData: Record<string, unknown> = { Name: params.name };
        if (params.email !== undefined) contactData.Email = params.email;
        if (params.phone !== undefined) contactData.Phone = params.phone;
        if (params.position !== undefined) contactData.Job = params.position;
        if (accountField && accountId) contactData[accountField] = accountId;
        if (params.extra) {
          for (const [k, v] of Object.entries(params.extra)) {
            // explicit fields take precedence over `extra`
            if (k in contactData) continue;
            contactData[k] = v;
          }
        }

        const resolvedData = await services.lookupResolver.resolveDataLookups('Contact', contactData);
        const created = await services.odataClient.createRecord<Record<string, unknown>>('Contact', resolvedData);
        const contactId = String((created as { Id?: unknown; id?: unknown }).Id ?? (created as { id?: unknown }).id ?? '');

        return {
          content: [
            {
              type: 'text',
              text: [
                `Контакт зарегистрирован: ${params.name} (${contactId})`,
                accountId ? `Контрагент: ${params.account_name} (${accountId})${accountCreated ? ' — создан' : ' — найден'}` : '',
                warnings.length ? `Предупреждения: ${warnings.join('; ')}` : '',
              ].filter(Boolean).join('\n'),
            },
          ],
          structuredContent: {
            contact_id: contactId,
            account_id: accountId,
            account_created: accountCreated,
            contact_created: true,
            warnings,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, 'Contact');
        return {
          content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
          isError: true,
        };
      }
    }
  );
}
