import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { EntityMetadata } from '../../src/types/index.js';
import { registerSchemaTools } from '../../src/tools/schema-tools.js';

function schemaHandler(metadata: EntityMetadata) {
  let handler: (args: { collection: string }) => Promise<CallToolResult>;
  let output: z.ZodRawShape;
  registerSchemaTools(
    {
      registerTool(name: string, definition: { outputSchema: z.ZodRawShape }, callback: typeof handler) {
        if (name === 'bpm_get_schema') {
          handler = callback;
          output = definition.outputSchema;
        }
      },
    } as never,
    {
      initialized: true,
      authManager: { async ensureAuthenticated() {} },
      metadataManager: {
        async getEntityMetadata() {
          return metadata;
        },
      },
    } as never
  );
  return async () => {
    const result = await handler({ collection: 'Contact' });
    z.object(output).parse(result.structuredContent);
    return result;
  };
}

describe('required columns available through the real schema handler', () => {
  it('shows caller requirements, server defaults and coverage without confusing nullability', async () => {
    const metadata: EntityMetadata = {
      name: 'Contact',
      collectionName: 'Contact',
      keyFields: ['Id'],
      lookupFields: [],
      cachedAt: Date.now(),
      properties: [
        {
          name: 'Id',
          type: 'Edm.Guid',
          nullable: false,
          isLookup: false,
          required: true,
          requirementSource: 'entity_schema_designer',
          defaultHint: { source: 'runtime', providedByServer: true },
        },
        {
          name: 'Name',
          caption: 'ФИО',
          type: 'Edm.String',
          nullable: true,
          isLookup: false,
          required: true,
          requirementSource: 'entity_schema_designer',
          defaultHint: { source: 'none', providedByServer: false },
        },
        {
          name: 'Phone',
          caption: 'Рабочий телефон',
          type: 'Edm.String',
          nullable: false,
          isLookup: false,
          required: false,
          requirementSource: 'entity_schema_designer',
          defaultHint: { source: 'constant', providedByServer: true, value: '' },
        },
        { name: 'Additional', type: 'Edm.String', nullable: false, isLookup: false },
      ],
    };
    const result = await schemaHandler(metadata)();
    expect(result.structuredContent).toMatchObject({
      requirement_source: 'entity_schema_designer',
      requirements_complete: false,
      unknown_requirement_fields: ['Additional'],
      required_fields: [
        { name: 'Id', provided_by_server: true },
        { name: 'Name', caption: 'ФИО', provided_by_server: false },
      ],
      caller_required_fields: [{ name: 'Name' }],
    });
    const properties = result.structuredContent!.properties as Array<Record<string, unknown>>;
    expect(properties.find((p) => p.name === 'Name')).toMatchObject({ required: true, nullable: true });
    expect(properties.find((p) => p.name === 'Phone')).toMatchObject({ required: false, nullable: false });
    expect(properties.find((p) => p.name === 'Additional')!.required).toBeNull();
    expect(JSON.stringify(result.content)).toContain('ФИО (Name)');
  });
  it('explicitly marks requirements unknown when only EDMX is available', async () => {
    const result = await schemaHandler({
      name: 'Contact',
      collectionName: 'Contact',
      lookupFields: [],
      cachedAt: Date.now(),
      properties: [{ name: 'Name', type: 'Edm.String', nullable: false, isLookup: false }],
    })();
    expect(result.structuredContent).toMatchObject({
      required_fields: [],
      caller_required_fields: [],
      requirements_complete: false,
      requirement_source: 'unavailable',
      unknown_requirement_fields: ['Name'],
    });
    expect((result.structuredContent!.properties as Array<{ required: unknown }>)[0].required).toBeNull();
  });
});
