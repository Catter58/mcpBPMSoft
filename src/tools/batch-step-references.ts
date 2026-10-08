import { BpmApiError } from '../utils/errors.js';

export interface BatchCreateStep {
  alias: string;
  collection: string;
  record: Record<string, unknown>;
}

export interface BatchStepReference {
  field: string;
  alias: string;
  targetCollection: string;
}

export interface BatchStepPlan {
  steps: BatchCreateStep[];
  references: Map<number, BatchStepReference[]>;
  order: number[];
}

/** Only the exact object form is reserved for an alias reference. */
export function isBatchStepReference(value: unknown): value is { $ref: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.includes('$ref');
}

/** Validate alias uniqueness, reference edges, cycles, and stable input-order topology. */
export function planBatchCreateSteps(
  input: BatchCreateStep[],
  collectionByInputIndex: string[]
): BatchStepPlan {
  if (!Array.isArray(input) || input.length < 1 || input.length > 1000)
    throw new BpmApiError('steps должен содержать от 1 до 1000 шагов.', 400);
  const aliases = new Map<string, number>();
  for (let index = 0; index < input.length; index++) {
    const step = input[index];
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.alias))
      throw new BpmApiError(`Некорректный alias в шаге #${index + 1}.`, 400);
    if (aliases.has(step.alias)) throw new BpmApiError(`Alias "${step.alias}" указан несколько раз.`, 400);
    if (!step.record || typeof step.record !== 'object' || Array.isArray(step.record))
      throw new BpmApiError(`record в шаге #${index + 1} должен быть объектом.`, 400);
    aliases.set(step.alias, index);
  }

  const references = new Map<number, BatchStepReference[]>();
  const incoming = input.map(() => 0);
  const outgoing = input.map(() => [] as number[]);
  for (let index = 0; index < input.length; index++) {
    const refs: BatchStepReference[] = [];
    for (const [field, value] of Object.entries(input[index].record)) {
      if (!isBatchStepReference(value)) continue;
      if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string' || !value.$ref.trim())
        throw new BpmApiError(`Ссылка в ${field} шага #${index + 1} должна иметь вид {"$ref":"alias"}.`, 400);
      const targetIndex = aliases.get(value.$ref);
      if (targetIndex === undefined)
        throw new BpmApiError(`Неизвестный alias "${value.$ref}" в шаге #${index + 1}.`, 400);
      refs.push({ field, alias: value.$ref, targetCollection: collectionByInputIndex[targetIndex] });
      incoming[index]++;
      outgoing[targetIndex].push(index);
    }
    references.set(index, refs);
  }

  const ready = incoming.map((count, index) => (count === 0 ? index : -1)).filter((index) => index >= 0);
  const order: number[] = [];
  while (ready.length) {
    const index = ready.shift()!;
    order.push(index);
    for (const dependent of outgoing[index]) {
      incoming[dependent]--;
      if (incoming[dependent] === 0) {
        const insertAt = ready.findIndex((value) => value > dependent);
        if (insertAt < 0) ready.push(dependent);
        else ready.splice(insertAt, 0, dependent);
      }
    }
  }
  if (order.length !== input.length) throw new BpmApiError('В steps обнаружен цикл ссылок alias.', 400);
  return { steps: input, references, order };
}
