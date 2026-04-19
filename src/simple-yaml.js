const KEY_VALUE_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*)|\s*)$/;

export function parseSimpleYaml(source, options = {}) {
  // This intentionally supports only the YAML subset used by project.yaml and
  // markdown frontmatter today. Multi-line block scalars and continued
  // multi-line string values are not supported.
  const sourceName = options.sourceName ?? 'YAML';
  const lines = preprocessLines(source, sourceName);

  if (lines.length === 0) {
    return {};
  }

  const parsed = parseBlock(lines, 0, lines[0].indent, sourceName);
  if (parsed.nextIndex !== lines.length) {
    const line = lines[parsed.nextIndex];
    throw new Error(`${sourceName}:${line.lineNumber} has unsupported trailing content.`);
  }

  return parsed.value;
}

function preprocessLines(source, sourceName) {
  return source.split(/\r?\n/).flatMap((rawLine, index) => {
    if (/^\s*$/.test(rawLine) || /^\s*#/.test(rawLine)) {
      return [];
    }

    if (/\t/.test(rawLine)) {
      throw new Error(`${sourceName}:${index + 1} uses tabs for indentation.`);
    }

    const indentMatch = rawLine.match(/^ */);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const text = rawLine.slice(indent);

    return [{ indent, text, lineNumber: index + 1 }];
  });
}

function parseBlock(lines, startIndex, indent, sourceName) {
  const line = lines[startIndex];

  if (!line) {
    return { value: {}, nextIndex: startIndex };
  }

  if (line.indent !== indent) {
    throw new Error(
      `${sourceName}:${line.lineNumber} has inconsistent indentation. Expected ${indent} spaces, got ${line.indent}.`,
    );
  }

  if (line.text.startsWith('- ')) {
    return parseList(lines, startIndex, indent, sourceName);
  }

  return parseMap(lines, startIndex, indent, sourceName);
}

function parseMap(lines, startIndex, indent, sourceName) {
  const value = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];

    if (line.indent < indent) {
      break;
    }

    if (line.indent > indent) {
      throw new Error(`${sourceName}:${line.lineNumber} has unexpected indentation.`);
    }

    if (line.text.startsWith('- ')) {
      throw new Error(`${sourceName}:${line.lineNumber} mixes list items into a mapping.`);
    }

    const keyValue = splitKeyValue(line.text);
    if (!keyValue) {
      throw new Error(`${sourceName}:${line.lineNumber} is not a supported key/value entry.`);
    }

    if (Object.hasOwn(value, keyValue.key)) {
      throw new Error(`${sourceName}:${line.lineNumber} redefines key "${keyValue.key}".`);
    }

    index += 1;

    if (keyValue.value === null) {
      const nested = lines[index];
      if (nested && nested.indent > indent) {
        const parsed = parseBlock(lines, index, nested.indent, sourceName);
        value[keyValue.key] = parsed.value;
        index = parsed.nextIndex;
      } else {
        value[keyValue.key] = null;
      }
      continue;
    }

    value[keyValue.key] = parseScalar(keyValue.value);
  }

  return { value, nextIndex: index };
}

function parseList(lines, startIndex, indent, sourceName) {
  const value = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];

    if (line.indent < indent) {
      break;
    }

    if (line.indent > indent) {
      throw new Error(`${sourceName}:${line.lineNumber} has unexpected indentation inside a list.`);
    }

    if (!line.text.startsWith('- ')) {
      break;
    }

    const itemText = line.text.slice(2).trim();
    index += 1;

    if (itemText === '') {
      const nested = lines[index];
      if (nested && nested.indent > indent) {
        const parsed = parseBlock(lines, index, nested.indent, sourceName);
        value.push(parsed.value);
        index = parsed.nextIndex;
      } else {
        value.push(null);
      }
      continue;
    }

    const inlineMapping = splitKeyValue(itemText);
    if (inlineMapping) {
      const objectValue = {};

      if (inlineMapping.value === null) {
        const nested = lines[index];
        if (nested && nested.indent > indent) {
          const parsed = parseBlock(lines, index, nested.indent, sourceName);
          objectValue[inlineMapping.key] = parsed.value;
          index = parsed.nextIndex;
        } else {
          objectValue[inlineMapping.key] = null;
        }
      } else {
        objectValue[inlineMapping.key] = parseScalar(inlineMapping.value);
      }

      const nested = lines[index];
      if (nested && nested.indent > indent) {
        const parsed = parseMap(lines, index, nested.indent, sourceName);
        Object.assign(objectValue, parsed.value);
        index = parsed.nextIndex;
      }

      value.push(objectValue);
      continue;
    }

    const nested = lines[index];
    if (nested && nested.indent > indent) {
      throw new Error(`${sourceName}:${line.lineNumber} has unsupported nested scalar list content.`);
    }

    value.push(parseScalar(itemText));
  }

  return { value, nextIndex: index };
}

function splitKeyValue(text) {
  const match = text.match(KEY_VALUE_PATTERN);
  if (!match) {
    return null;
  }

  return {
    key: match[1],
    value: match[2] === undefined || match[2] === '' ? null : match[2].trim(),
  };
}

function parseScalar(rawValue) {
  if (rawValue === 'null' || rawValue === '~') {
    return null;
  }

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  if (/^-?\d+$/.test(rawValue)) {
    return Number(rawValue);
  }

  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }

  if (rawValue === '[]') {
    return [];
  }

  if (rawValue === '{}') {
    return {};
  }

  return rawValue;
}
