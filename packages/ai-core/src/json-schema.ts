import { z } from 'zod';

export type JsonSchema = { [key: string]: unknown };

/** JSON Schema (draft 2020-12) for a Zod output schema, without the `$schema` marker. */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'output',
    unrepresentable: 'any',
  }) as JsonSchema;
  return rest;
}

/**
 * Builds a deterministic value that satisfies common JSON Schema keywords
 * (type, enum/const, required, min/max, minItems, formats). Used by the mock
 * provider so development flows receive schema-valid structured output.
 */
export function sampleFromJsonSchema(
  schema: JsonSchema,
  root: JsonSchema = schema,
  path = 'value',
): unknown {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace(/^#\/(\$defs|definitions)\//, '');
    const defs = (root.$defs ?? root.definitions ?? {}) as Record<string, JsonSchema>;
    return defs[name] ? sampleFromJsonSchema(defs[name], root, path) : null;
  }
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) {
      // A nullable patterned string gets null: the sampler cannot satisfy arbitrary regexes.
      const all = options as JsonSchema[];
      const preferred =
        all.find((o) => o.type !== 'null' && !o.pattern) ??
        all.find((o) => o.type === 'null') ??
        all[0]!;
      return sampleFromJsonSchema(preferred, root, path);
    }
  }
  const type = Array.isArray(schema.type)
    ? ((schema.type as string[]).find((t) => t !== 'null') ?? 'null')
    : schema.type;
  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const out: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(properties)) {
        out[name] = sampleFromJsonSchema(prop, root, name);
      }
      return out;
    }
    case 'array': {
      const count = Math.max(Number(schema.minItems ?? 1), 1);
      const items = (schema.items ?? {}) as JsonSchema;
      return Array.from({ length: Math.min(count, Number(schema.maxItems ?? count)) }, (_, i) =>
        sampleFromJsonSchema(items, root, `${path}${i + 1}`),
      );
    }
    case 'integer':
    case 'number': {
      const min = Number(schema.minimum ?? schema.exclusiveMinimum ?? 0);
      const max = Number(schema.maximum ?? schema.exclusiveMaximum ?? Math.max(min, 1));
      const mid = (min + max) / 2;
      return type === 'integer' ? Math.round(mid) : mid;
    }
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'string': {
      if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (schema.format === 'email') return 'mock@example.com';
      if (schema.format === 'uri') return 'https://example.com/mock';
      const text = `[mock] ${path}`;
      const min = Number(schema.minLength ?? 0);
      const max = Number(schema.maxLength ?? Math.max(text.length, min));
      return text.padEnd(min, '.').slice(0, max);
    }
    default:
      return null;
  }
}
