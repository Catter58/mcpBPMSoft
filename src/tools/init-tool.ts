/**
 * MCP Tool: bpm_init — Interactive initialization
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BpmConfig } from '../types/index.js';
import { buildConfig, getODataBaseUrl } from '../config.js';
import { HttpClient } from '../client/http-client.js';
import { AuthManager } from '../auth/auth-manager.js';
import { ODataClient } from '../client/odata-client.js';
import { MetadataManager } from '../metadata/metadata-manager.js';
import { LookupResolver } from '../lookup/lookup-resolver.js';
import { ProcessEngineClient } from '../process/process-engine-client.js';
import { getTool, listToolBlurbs } from './registry.js';

export interface ServiceContainer {
  config: BpmConfig;
  httpClient: HttpClient;
  authManager: AuthManager;
  odataClient: ODataClient;
  metadataManager: MetadataManager;
  lookupResolver: LookupResolver;
  processEngine: ProcessEngineClient;
  initialized: boolean;
}

export function createEmptyContainer(): ServiceContainer {
  return {
    config: null!,
    httpClient: null!,
    authManager: null!,
    odataClient: null!,
    metadataManager: null!,
    lookupResolver: null!,
    processEngine: null!,
    initialized: false,
  };
}

export function initializeServices(config: BpmConfig): ServiceContainer {
  const httpClient = new HttpClient(config);
  const authManager = new AuthManager(config, httpClient);
  const odataClient = new ODataClient(config, httpClient);
  const metadataManager = new MetadataManager(config, odataClient, httpClient);
  const lookupResolver = new LookupResolver(config, odataClient, metadataManager);
  const processEngine = new ProcessEngineClient(config, httpClient);

  return {
    config,
    httpClient,
    authManager,
    odataClient,
    metadataManager,
    lookupResolver,
    processEngine,
    initialized: true,
  };
}

export function registerInitTool(
  server: McpServer,
  _container: ServiceContainer,
  onInitialized: (newContainer: ServiceContainer) => void
): void {
  const meta = getTool('bpm_init');

  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        url: z.string().describe('URL приложения BPMSoft (например: https://mycompany.bpmsoft.com)'),
        username: z.string().describe('Имя пользователя для входа'),
        password: z.string().describe('Пароль пользователя'),
        odata_version: z
          .number()
          .optional()
          .describe('Версия OData протокола: 4 (по умолчанию) или 3'),
        platform: z
          .string()
          .optional()
          .describe('Платформа: "net8" (по умолчанию) или "netframework"'),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      try {
        const config = buildConfig(params.url, params.username, params.password, {
          odata_version: params.odata_version,
          platform: params.platform,
        });

        const newContainer = initializeServices(config);

        try {
          await newContainer.authManager.login();
        } catch (authError) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  '❌ Ошибка подключения к BPMSoft',
                  '',
                  `URL: ${config.bpmsoft_url}`,
                  `Пользователь: ${config.username}`,
                  `OData: v${config.odata_version}`,
                  `Платформа: ${config.platform}`,
                  '',
                  `Ошибка: ${authError instanceof Error ? authError.message : String(authError)}`,
                  '',
                  'Проверьте URL, логин и пароль и попробуйте снова.',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }

        onInitialized(newContainer);

        const odataBaseUrl = getODataBaseUrl(config);
        return {
          content: [
            {
              type: 'text',
              text: [
                '✅ Подключение к BPMSoft установлено',
                '',
                `URL: ${config.bpmsoft_url}`,
                `OData endpoint: ${odataBaseUrl}`,
                `Пользователь: ${config.username}`,
                `OData: v${config.odata_version}`,
                `Платформа: ${config.platform}`,
                '',
                'Доступные инструменты:',
                listToolBlurbs(),
              ].join('\n'),
            },
          ],
          structuredContent: {
            url: config.bpmsoft_url,
            odata_endpoint: odataBaseUrl,
            odata_version: config.odata_version,
            platform: config.platform,
            username: config.username,
            initialized: true,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Ошибка инициализации: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
