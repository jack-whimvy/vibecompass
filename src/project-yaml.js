export function serializeProjectConfig(config) {
  const lines = serializeMapping(config, 0);
  return `${lines.join('\n')}\n`;
}

function serializeMapping(mapping, indent) {
  const lines = [];

  for (const [key, value] of Object.entries(mapping)) {
    lines.push(...serializeEntry(key, value, indent));
  }

  return lines;
}

function serializeEntry(key, value, indent) {
  const prefix = `${' '.repeat(indent)}${key}:`;

  if (isScalar(value)) {
    return [`${prefix} ${formatScalar(value)}`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${prefix} []`];
    }

    return [
      prefix,
      ...value.flatMap((item) => serializeArrayItem(item, indent + 2)),
    ];
  }

  const objectEntries = Object.entries(value);
  if (objectEntries.length === 0) {
    return [`${prefix} {}`];
  }

  return [
    prefix,
    ...serializeMapping(value, indent + 2),
  ];
}

function serializeArrayItem(item, indent) {
  const prefix = `${' '.repeat(indent)}-`;

  if (isScalar(item)) {
    return [`${prefix} ${formatScalar(item)}`];
  }

  if (Array.isArray(item)) {
    throw new Error('Nested arrays are not supported when serializing project.yaml.');
  }

  const entries = Object.entries(item);
  if (entries.length === 0) {
    return [`${prefix} {}`];
  }

  const [firstKey, firstValue] = entries[0];
  const firstEntryLines = serializeEntry(firstKey, firstValue, indent + 2);
  const firstEntryFirstLine = firstEntryLines[0].slice(indent + 2);
  const lines = [`${prefix} ${firstEntryFirstLine}`];

  lines.push(...firstEntryLines.slice(1));

  for (const [key, value] of entries.slice(1)) {
    lines.push(...serializeEntry(key, value, indent + 2));
  }

  return lines;
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function formatScalar(value) {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value === '') {
    return '""';
  }

  if (requiresQuotes(value)) {
    return JSON.stringify(value);
  }

  return value;
}

function requiresQuotes(value) {
  return (
    /^\s|\s$/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    value.includes(': ') ||
    value.includes(' #') ||
    value.includes('\n')
  );
}
