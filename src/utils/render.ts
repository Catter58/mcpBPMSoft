/**
 * Token-aware rendering helpers for tool results.
 *
 * `format` strategies:
 *   'compact'  — summary + первые `compact_preview` записей в виде JSON, без полного дампа.
 *                По умолчанию для bpm_get_records и bpm_search_records.
 *   'full'     — полный JSON.stringify(records, null, 2).
 *   'markdown' — markdown-таблица для ≤ `markdown_threshold` записей; иначе fallback в compact.
 *
 * `structuredContent` всегда содержит полный набор данных независимо от format,
 * поэтому MCP-клиент с поддержкой structuredContent ничего не теряет.
 */

const COMPACT_PREVIEW = 5;
const MARKDOWN_THRESHOLD = 20;
const MARKDOWN_MAX_COL_WIDTH = 60;

export type RenderFormat = 'compact' | 'full' | 'markdown';

export interface RenderRecordsOptions {
  format?: RenderFormat;
  collection: string;
  totalCount?: number;
  truncated?: boolean;
  nextLink?: string;
  cursor?: string;
  /** Сколько записей в превью для format=compact (default 5) */
  preview?: number;
}

export function renderRecordsText(records: Array<Record<string, unknown>>, options: RenderRecordsOptions): string {
  const format: RenderFormat = options.format ?? 'compact';
  const summary = buildSummary(records, options);

  if (records.length === 0) {
    return `${summary}\n\nДанные: (пусто)`;
  }

  if (format === 'markdown' && records.length <= MARKDOWN_THRESHOLD) {
    const md = renderMarkdownTable(records);
    return `${summary}\n\n${md}`;
  }

  if (format === 'full') {
    return `${summary}\n\nДанные:\n${JSON.stringify(records, null, 2)}`;
  }

  const preview = Math.max(1, options.preview ?? COMPACT_PREVIEW);
  const head = records.slice(0, preview);
  const remaining = records.length - head.length;
  const tail =
    remaining > 0
      ? `\n\n…и ещё ${remaining} ${pluralize(remaining)}. Запросите format='full' или используйте structuredContent для полного списка.`
      : '';
  return `${summary}\n\nПревью (${head.length} из ${records.length}):\n${JSON.stringify(head, null, 2)}${tail}`;
}

function buildSummary(records: Array<Record<string, unknown>>, options: RenderRecordsOptions): string {
  const lines: string[] = [`Коллекция: ${options.collection}`, `Получено записей: ${records.length}`];
  if (options.totalCount !== undefined) lines.push(`Всего записей: ${options.totalCount}`);
  if (options.truncated) {
    lines.push('Достигнут лимит max_records — есть ещё страницы (см. cursor/next_link).');
  } else if (options.nextLink || options.cursor) {
    lines.push('Доступна следующая страница (см. cursor/next_link).');
  }
  return lines.join('\n');
}

function renderMarkdownTable(records: Array<Record<string, unknown>>): string {
  if (records.length === 0) return '(пусто)';

  // Собираем общий набор колонок (объединение ключей всех записей)
  const colSet = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (k.startsWith('@odata.')) continue;
      colSet.add(k);
    }
  }
  // Помещаем Id первым если есть, затем Name, затем остальные
  const cols = Array.from(colSet).sort((a, b) => {
    if (a === 'Id') return -1;
    if (b === 'Id') return 1;
    if (a === 'Name') return -1;
    if (b === 'Name') return 1;
    return a.localeCompare(b);
  });

  const headerRow = `| ${cols.join(' | ')} |`;
  const separatorRow = `| ${cols.map(() => '---').join(' | ')} |`;
  const dataRows = records.map((r) => {
    return `| ${cols.map((c) => formatCell(r[c])).join(' | ')} |`;
  });

  return [headerRow, separatorRow, ...dataRows].join('\n');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'object') {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  } else {
    s = String(value);
  }
  // Экранируем pipe и переводы строк, чтобы таблица не сломалась
  s = s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  if (s.length > MARKDOWN_MAX_COL_WIDTH) s = s.slice(0, MARKDOWN_MAX_COL_WIDTH - 1) + '…';
  return s;
}

function pluralize(n: number): string {
  // RU pluralization for "запись"
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'запись';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'записи';
  return 'записей';
}
