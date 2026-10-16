/** A value inside a decorated payload: short inline text, a multi-line block, or nested fields. */
export type PayloadValue =
  | { kind: 'scalar'; text: string }
  | { kind: 'block'; text: string }
  | { kind: 'fields'; fields: PayloadField[] };

export interface PayloadField {
  key: string;
  value: PayloadValue;
}

/**
 * A tool payload prepared for reading. Known shapes get their own layout;
 * other JSON objects become fields with real line breaks; anything else stays text.
 */
export type PayloadView =
  | { kind: 'text'; text: string }
  | { kind: 'command'; description?: string; command: string; fields: PayloadField[] }
  | { kind: 'edit'; path: string; before: string; after: string; fields: PayloadField[] }
  | { kind: 'file'; path: string; content: string; fields: PayloadField[] }
  | { kind: 'fields'; fields: PayloadField[] };

/** Strings longer than this, or with a line break, are shown as blocks. */
const INLINE_LIMIT = 80;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextPart(value: unknown): value is { text: string } {
  return isObject(value) && typeof value.text === 'string';
}

function valueOf(value: unknown): PayloadValue {
  if (typeof value === 'string') {
    return value.includes('\n') || value.length > INLINE_LIMIT ? { kind: 'block', text: value } : { kind: 'scalar', text: value };
  }
  if (isObject(value)) return { kind: 'fields', fields: fieldsOf(value, []) };
  if (Array.isArray(value)) {
    const scalars = value.every((item) => ['string', 'number', 'boolean'].includes(typeof item));
    const joined = value.map(String).join(', ');
    if (scalars && !joined.includes('\n') && joined.length <= INLINE_LIMIT) return { kind: 'scalar', text: joined };
    return { kind: 'block', text: JSON.stringify(value, null, 2) };
  }
  return { kind: 'scalar', text: String(value) };
}

function fieldsOf(object: JsonObject, skip: string[]): PayloadField[] {
  return Object.entries(object)
    .filter(([key]) => !skip.includes(key))
    .map(([key, value]) => ({ key, value: valueOf(value) }));
}

/** Parses a tool input or result for reading; never throws. */
export function formatPayload(text: string): PayloadView {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { kind: 'text', text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'text', text };
  }
  if (Array.isArray(parsed)) {
    return parsed.length && parsed.every(isTextPart)
      ? { kind: 'text', text: parsed.map((part) => part.text).join('\n') }
      : { kind: 'text', text };
  }
  if (!isObject(parsed)) return { kind: 'text', text };
  const { command, description, file_path: path, old_string: before, new_string: after, content } = parsed;
  if (typeof command === 'string') {
    return {
      kind: 'command',
      ...(typeof description === 'string' ? { description } : {}),
      command,
      fields: fieldsOf(parsed, ['command', 'description']),
    };
  }
  if (typeof path === 'string' && typeof before === 'string' && typeof after === 'string') {
    return { kind: 'edit', path, before, after, fields: fieldsOf(parsed, ['file_path', 'old_string', 'new_string']) };
  }
  if (typeof path === 'string' && typeof content === 'string') {
    return { kind: 'file', path, content, fields: fieldsOf(parsed, ['file_path', 'content']) };
  }
  return { kind: 'fields', fields: fieldsOf(parsed, []) };
}

function compact(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function valueText(value: PayloadValue): string {
  if (value.kind === 'fields') return value.fields.map((field) => `${field.key}: ${valueText(field.value)}`).join(', ');
  return value.text;
}

/** One line that tells the payloads of a tool apart in a collapsed row. */
export function payloadPreview(view: PayloadView): string {
  if (view.kind === 'text') return compact(view.text);
  if (view.kind === 'command') return compact(view.description || view.command);
  if (view.kind === 'edit' || view.kind === 'file') return view.path;
  const [first] = view.fields;
  return first ? compact(`${first.key}: ${valueText(first.value)}`) : '';
}

function fieldsText(fields: PayloadField[], indent = ''): string {
  return fields.map(({ key, value }) => {
    if (value.kind === 'scalar') return `${indent}${key}: ${value.text}`;
    if (value.kind === 'block') return `${indent}${key}:\n${value.text}`;
    return `${indent}${key}:\n${fieldsText(value.fields, `${indent}  `)}`;
  }).join('\n');
}

/** The decorated payload as plain text, for copying what is shown. */
export function payloadText(view: PayloadView): string {
  const parts = view.kind === 'text' ? [view.text]
    : view.kind === 'command' ? [view.description ?? '', view.command, fieldsText(view.fields)]
      : view.kind === 'edit' ? [view.path, `Before:\n${view.before}`, `After:\n${view.after}`, fieldsText(view.fields)]
        : view.kind === 'file' ? [view.path, view.content, fieldsText(view.fields)]
          : [fieldsText(view.fields)];
  return parts.filter(Boolean).join('\n\n');
}
