const TARGET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function normalizeBindingFields(source) {
  const apiUrl = typeof source?.api_url === 'string' && source.api_url.trim() !== ''
    ? source.api_url
    : null;
  const projectId = typeof source?.project_id === 'string' && source.project_id.trim() !== ''
    ? source.project_id
    : null;
  const credentialEnvVar = typeof source?.credential_env_var === 'string' && source.credential_env_var.trim() !== ''
    ? source.credential_env_var
    : null;

  if (!apiUrl || !projectId || !credentialEnvVar) {
    return null;
  }

  return { apiUrl, projectId, credentialEnvVar };
}

export function assertValidSyncTargetName(name) {
  if (typeof name !== 'string' || !TARGET_NAME_PATTERN.test(name)) {
    throw new Error(
      `Sync target name "${name}" is invalid. Use lowercase letters, digits, hyphens, or underscores (e.g. dev, prod).`,
    );
  }
  return name;
}

export function readSyncTargets(projectConfig) {
  const sync = projectConfig?.sync;
  if (!sync || typeof sync !== 'object') {
    return null;
  }

  const targets = sync.targets && typeof sync.targets === 'object' ? sync.targets : null;
  if (!targets || Object.keys(targets).length === 0) {
    return null;
  }

  const defaultTarget = typeof sync.default_target === 'string' && targets[sync.default_target]
    ? sync.default_target
    : null;

  return { defaultTarget, targets };
}

/**
 * Resolves the effective hosted sync binding for a command (D-236).
 *
 * Resolution order: explicit target name -> sync.default_target -> legacy
 * flat sync fields. Returns null when no complete binding exists. Throws on
 * an explicitly requested target that is unknown or incomplete, because a
 * typo must never silently fall back to a different environment.
 */
export function resolveSyncBinding(projectConfig, targetName) {
  const sync = projectConfig?.sync;
  if (!sync || typeof sync !== 'object') {
    if (targetName) {
      throw new Error(
        `--sync-target ${targetName} requires a sync section in project.yaml. Run "vibecompass connect-hosted --target ${targetName}" first.`,
      );
    }
    return null;
  }

  const named = readSyncTargets(projectConfig);

  if (targetName) {
    const target = named?.targets?.[targetName];
    if (!target || typeof target !== 'object') {
      const available = named ? Object.keys(named.targets) : [];
      throw new Error(
        `Unknown sync target "${targetName}". ${
          available.length > 0
            ? `Available targets: ${available.join(', ')}.`
            : 'No named sync targets are defined in project.yaml; run "vibecompass connect-hosted --target <name>" to add one.'
        }`,
      );
    }

    const fields = normalizeBindingFields(target);
    if (!fields) {
      throw new Error(
        `Sync target "${targetName}" is incomplete. It must define api_url, project_id, and credential_env_var.`,
      );
    }

    return { target: targetName, isDefault: targetName === named.defaultTarget, ...fields };
  }

  if (named?.defaultTarget) {
    const fields = normalizeBindingFields(named.targets[named.defaultTarget]);
    if (fields) {
      return { target: named.defaultTarget, isDefault: true, ...fields };
    }
  }

  const flat = normalizeBindingFields(sync);
  return flat ? { target: null, isDefault: true, ...flat } : null;
}

const CURSOR_FIELDS = [
  'last_successful_remote_revision',
  'last_successful_local_root_revision',
  'last_successful_manifest_hash',
  'last_sync_direction',
  'last_sync_at',
  'pending_previews',
];

function pickCursorFields(source) {
  const cursor = {};
  for (const field of CURSOR_FIELDS) {
    if (source?.[field] !== undefined) {
      cursor[field] = source[field];
    }
  }
  return cursor;
}

/**
 * Reads the sync cursor for the resolved binding (D-237). Legacy flat
 * bindings keep using the flat manifest.sync fields. Named targets read only
 * their own cursor, and only when its recorded api_url/project_id identity
 * matches the current binding — otherwise the cursor is treated as absent so
 * a stale or cross-environment cursor can never become another environment's
 * baseline.
 */
export function readSyncCursor(manifestSync, binding) {
  if (!manifestSync || typeof manifestSync !== 'object') {
    return {};
  }

  if (!binding?.target) {
    return pickCursorFields(manifestSync);
  }

  const cursor = manifestSync.targets?.[binding.target];
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    cursor.api_url !== binding.apiUrl ||
    cursor.project_id !== binding.projectId
  ) {
    return {};
  }

  return pickCursorFields(cursor);
}

/**
 * Builds the next manifest.sync value after a sync operation for the resolved
 * binding (D-237). Named targets write into manifest.sync.targets.<name>
 * (stamped with their api_url/project_id identity); when the binding is the
 * default target, the flat fields mirror the same cursor so ≤0.7.0 CLIs stay
 * correct on the default environment. Legacy flat bindings keep writing the
 * flat fields only.
 */
export function buildSyncStateWithCursor(manifestSync, binding, cursor) {
  const existing = manifestSync && typeof manifestSync === 'object' ? manifestSync : {};
  const cursorFields = pickCursorFields(cursor);

  if (!binding?.target) {
    return { ...existing, ...cursorFields };
  }

  const targets = {
    ...(existing.targets && typeof existing.targets === 'object' ? existing.targets : {}),
    [binding.target]: {
      api_url: binding.apiUrl,
      project_id: binding.projectId,
      ...cursorFields,
    },
  };

  return {
    ...existing,
    ...(binding.isDefault ? cursorFields : {}),
    targets,
  };
}

/**
 * Migrates a legacy flat manifest cursor into a named target's cursor slot
 * (D-237). Only applies when the new target's binding values match the flat
 * binding the cursor was written against, the target has no cursor yet, and
 * a flat cursor actually exists. Returns the next manifest.sync value, or
 * null when nothing should change.
 */
export function migrateFlatCursorToTarget(manifestSync, targetName, bindingFields) {
  const existing = manifestSync && typeof manifestSync === 'object' ? manifestSync : {};
  const targets = existing.targets && typeof existing.targets === 'object' ? existing.targets : {};
  const flatCursor = pickCursorFields(existing);

  if (targets[targetName] || Object.keys(flatCursor).length === 0) {
    return null;
  }

  return {
    ...existing,
    targets: {
      ...targets,
      [targetName]: {
        api_url: bindingFields.apiUrl,
        project_id: bindingFields.projectId,
        ...flatCursor,
      },
    },
  };
}

/**
 * Reconciles manifest cursor state after connect-hosted (re)binds a named
 * target (D-237). Handles, in order:
 * 1. first flat→named conversion with matching values: migrate the flat
 *    cursor into the target's slot;
 * 2. rebinding an existing target to a different api_url/project_id: drop its
 *    now-wrong cursor;
 * 3. when the (re)bound target is the default: re-mirror the flat cursor from
 *    the target's identity-matching cursor, or clear it — so an older CLI can
 *    never combine the new flat binding with a previous environment's cursor.
 * Returns the next manifest.sync value, or null when nothing changes.
 */
export function reconcileCursorsAfterConnect(manifestSync, targetName, bindingFields, options = {}) {
  const existing = manifestSync && typeof manifestSync === 'object' ? manifestSync : {};
  let next = existing;
  let changed = false;

  if (options.isFirstConversion && options.flatBindingMatches) {
    const migrated = migrateFlatCursorToTarget(next, targetName, bindingFields);
    if (migrated) {
      next = migrated;
      changed = true;
    }
  }

  const targetCursor = next.targets?.[targetName];
  if (
    targetCursor &&
    typeof targetCursor === 'object' &&
    (targetCursor.api_url !== bindingFields.apiUrl ||
      targetCursor.project_id !== bindingFields.projectId)
  ) {
    const targets = { ...next.targets };
    delete targets[targetName];
    next = { ...next, targets };
    changed = true;
  }

  if (options.isDefault) {
    const mirrored = mirrorTargetCursorToFlat(next, targetName, bindingFields);
    if (JSON.stringify(mirrored) !== JSON.stringify(next)) {
      next = mirrored;
      changed = true;
    }
  }

  return changed ? next : null;
}

/**
 * Re-mirrors the flat manifest cursor from a (new default) target's cursor
 * (D-237). When the target has no identity-matching cursor, the flat cursor
 * fields are cleared so an older CLI cannot reuse the previous default's
 * cursor against the new default environment.
 */
export function mirrorTargetCursorToFlat(manifestSync, targetName, bindingFields) {
  const existing = manifestSync && typeof manifestSync === 'object' ? manifestSync : {};
  const base = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!CURSOR_FIELDS.includes(key)) {
      base[key] = value;
    }
  }

  const target = existing.targets?.[targetName];
  const identityMatches =
    target &&
    typeof target === 'object' &&
    target.api_url === bindingFields.apiUrl &&
    target.project_id === bindingFields.projectId;

  return identityMatches ? { ...base, ...pickCursorFields(target) } : base;
}

/**
 * Builds the project.yaml sync section for a set of named targets. The flat
 * fields always mirror the default target so older CLIs that only read the
 * flat binding keep working against the default environment.
 */
export function buildSyncSectionWithTargets(targets, defaultTarget) {
  const defaultFields = normalizeBindingFields(targets[defaultTarget]);
  if (!defaultFields) {
    throw new Error(`Default sync target "${defaultTarget}" is incomplete.`);
  }

  return {
    provider: 'vibecompass',
    api_url: defaultFields.apiUrl,
    project_id: defaultFields.projectId,
    credential_source: 'env',
    credential_env_var: defaultFields.credentialEnvVar,
    default_target: defaultTarget,
    targets,
  };
}
