import { describe, it, expect } from 'vitest';
import { MetadataManager } from '../../src/metadata/metadata-manager.js';
import type { BpmConfig } from '../../src/types/index.js';
import { SIMPLE_EDMX } from '../setup/fixtures/edmx.js';

function makeCfg(): BpmConfig {
  return {
    bpmsoft_url: 'https://bpm.test',
    username: 'u',
    password: 'p',
    odata_version: 4,
    platform: 'net8',
    page_size: 100,
    max_batch_size: 100,
    lookup_cache_ttl: 300,
    request_timeout: 30000,
    max_file_size: 10 * 1024 * 1024,
  };
}

describe('MetadataManager.parseMetadataXml', () => {
  it('parses entitySets and entityTypes from a small EDMX fixture', () => {
    // The parser is a pure function — we can pass `as any` for the heavy deps
    // since we never call methods that touch them in this test.
    const mgr = new MetadataManager(makeCfg(), {} as never, {} as never);
    const parsed = mgr.parseMetadataXml(SIMPLE_EDMX);

    expect(parsed.entitySets.size).toBe(2);
    expect(parsed.entitySets.get('Contact')).toBe('BPMSoft.Contact');
    expect(parsed.entitySets.get('City')).toBe('BPMSoft.City');

    expect(parsed.entityTypes.has('Contact')).toBe(true);
    expect(parsed.entityTypes.has('City')).toBe(true);

    const contact = parsed.entityTypes.get('Contact');
    expect(contact).toBeDefined();
    // NavigationProperty "City" must be present so v4 lookup detection picks up CityId
    const navs = contact?.NavigationProperty;
    const navArr = Array.isArray(navs) ? navs : navs ? [navs] : [];
    expect(navArr.find((n) => n['@_Name'] === 'City')).toBeDefined();
  });

  it('returns empty maps when EDMX has no DataServices', () => {
    const mgr = new MetadataManager(makeCfg(), {} as never, {} as never);
    const parsed = mgr.parseMetadataXml('<root/>');
    expect(parsed.entitySets.size).toBe(0);
    expect(parsed.entityTypes.size).toBe(0);
  });
});
