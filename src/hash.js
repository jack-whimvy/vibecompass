import { createHash } from 'node:crypto';

export function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

export function stableHash(value) {
  return sha256Text(stableStringify(value));
}

export function localRevisionFromManifestHash(manifestHash) {
  return `loc_${manifestHash.slice('sha256:'.length, 'sha256:'.length + 24)}`;
}
