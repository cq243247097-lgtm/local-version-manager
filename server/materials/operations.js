import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { loadProjectsConfig } from '../config.js';
import { baselineWith, limitsWith, fail, inspectPath, inspectSource, sameSource, samePathSnapshot, hashSource } from './integrity.js';
import { archiveTarget, declarationFor, verifyArchiveBinding, archiveSource } from './archive.js';
import { createOperationStore, assertOperationId } from './operation-store.js';

const clone = value => structuredClone(value);
function scope(input) {
  if (!input || typeof input.projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.projectId) || !['installer', 'upgrade'].includes(input.kind)) fail('INVALID_SCOPE', 400);
}
const nested = (a, b) => { const rel = path.relative(a, b); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
export function createMaterialOperations({ configPath, operationsDir, commitOperationsDir, limits: overrides } = {}) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) fail('INVALID_CONFIG', 400);
  const limits = limitsWith(overrides);
  operationsDir ??= path.join(path.dirname(configPath), 'material-operations');
  if (typeof operationsDir !== 'string' || !path.isAbsolute(operationsDir)) fail('INVALID_STORE', 400);
  operationsDir = path.resolve(operationsDir);
  commitOperationsDir ??= path.join(path.dirname(configPath), 'commit-operations');
  if (typeof commitOperationsDir !== 'string' || !path.isAbsolute(commitOperationsDir)) fail('INVALID_STORE', 400);
  commitOperationsDir = path.resolve(commitOperationsDir);
  const toolRoots = [path.dirname(path.resolve(configPath)), operationsDir, commitOperationsDir];
  const store = createOperationStore(operationsDir, limits), tickets = new Map();
  let active = null;
  async function readScope(input) {
    scope(input);
    const config = await loadProjectsConfig(configPath);
    const project = config.projectMap.get(input.projectId);
    if (!project) fail('PROJECT_NOT_FOUND', 404);
    return { config, project, root: project.materials?.[input.kind]?.root || null };
  }
  async function association(input, protectArchive = false) {
    const { config, project, root } = await readScope(input);
    if (!root) fail('MATERIAL_NOT_ASSOCIATED', 409);
    const protectedPaths = [...toolRoots, configPath];
    if (protectArchive) {
      // Future stores remain protected even before creation. Validate the nearest
      // existing ancestor without making directories or following a remapped link.
      for (const root of toolRoots) {
        let ancestor = root;
        while (true) {
          try { await inspectPath(ancestor, true); break; }
          catch (e) {
            if (e.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw e;
            ancestor = path.dirname(ancestor);
          }
        }
      }
    }
    // Validate against every registered root before *any* store creation.
    for (const p of config.projectMap.values()) {
      for (const location of [p.repositoryPath, ...Object.values(p.materials || {}).map(m => m.root)]) {
        const resolved = await fs.realpath(location);
        protectedPaths.push(path.resolve(location), resolved);
        if ([path.resolve(location), resolved].some(candidate => nested(operationsDir, candidate) || nested(candidate, operationsDir))) fail('UNSAFE_STORE');
      }
    }
    if (nested(operationsDir, path.resolve(configPath))) fail('UNSAFE_STORE');
    return { project, root, protectedPaths };
  }
  async function preview(input) {
    const { root, protectedPaths } = await association(input, input.action === 'archive');
    if (!['integrity', 'archive'].includes(input.action)) fail('UNSUPPORTED_ACTION', 400);
    if (input.action === 'integrity' && input.targetRoot !== undefined) fail('INVALID_INPUT', 400);
    if (input.action === 'archive' && input.targetRoot === undefined) fail('INVALID_TARGET', 400);
    const baseline = baselineWith(input.baseline);
    const source = await inspectSource(root, input.relativePath);
    const target = input.action === 'archive' ? await archiveTarget(input.targetRoot, source, protectedPaths) : null;
    const metadata = target ? await declarationFor(source, input.kind, Date.now() + limits.timeoutMs) : null;
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(id);
    if (tickets.size >= limits.maxTickets) fail('PREVIEW_CAPACITY');
    const ticketId = crypto.randomUUID();
    const ticket = { ticketId, projectId: input.projectId, kind: input.kind, action: input.action, baseline, source, ...(target ? { target, metadata } : {}), createdAt: Date.now(), expiresAt: Date.now() + limits.ticketTtlMs };
    tickets.set(ticketId, ticket);
    return { ...(target ? { targetRoot: target.root.path, basename: target.basename, targetExists: Boolean(target.existing), declaration: clone(metadata.declaration), declarationState: metadata.state, conflictRule: 'same-content-duplicate-different-content-conflict' } : {}), ticketId, projectId: input.projectId, kind: input.kind, action: ticket.action, relativePath: source.relativePath, bytes: source.file.identity.size, baseline: clone(baseline), expiresAt: ticket.expiresAt, limits: { maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs } };
  }
  async function query(input) {
    scope(input); assertOperationId(input.operationId);
    const { root } = await readScope(input);
    const saved = await store.read(input.operationId);
    if (!saved) return { operationId: input.operationId, status: 'not_started', durable: false };
    const result = saved.record;
    if (result.projectId !== input.projectId || result.kind !== input.kind) fail('OPERATION_SCOPE_MISMATCH');
    let associationCurrent = false;
    try { associationCurrent = samePathSnapshot(result.binding.source.root, (await inspectSource(root, result.binding.source.relativePath)).root, false); } catch {}
    const local = active?.operationId === input.operationId;
    return { ...clone(result), status: result.status === 'running' && !local ? 'unknown' : result.status, reason: result.status === 'running' && !local ? 'INTERRUPTED_OR_OTHER_INSTANCE' : result.reason, durable: true, associationCurrent, historical: true, checkedAt: result.updatedAt };
  }
  async function execute(input) {
    const started = performance.now();
    scope(input); assertOperationId(input.operationId);
    const { root } = await association(input);
    if (await store.read(input.operationId)) return query(input);
    if (active) fail('OPERATION_BUSY');
    if (['targetRoot', 'relativePath', 'baseline', 'action'].some(k => input[k] !== undefined)) fail('INVALID_INPUT', 400);
    // Claim service slot before awaiting source validation or record writes.
    const controller = new AbortController();
    active = { operationId: input.operationId, projectId: input.projectId, kind: input.kind, controller };
    try {
      const ticket = tickets.get(input.ticketId);
      if (!ticket || ticket.expiresAt <= Date.now()) fail('PREVIEW_STALE');
      if (ticket.projectId !== input.projectId || ticket.kind !== input.kind) fail('PREVIEW_SCOPE_MISMATCH');
      if (!sameSource(ticket.source, await inspectSource(root, ticket.source.relativePath))) fail('SOURCE_CHANGED');
      if (ticket.action === 'archive') {
        const latest = await association(input, true);
        const currentTarget = await archiveTarget(ticket.target.root.path, ticket.source, latest.protectedPaths);
        if (!samePathSnapshot(ticket.target.root, currentTarget.root, false)) fail('TARGET_CHANGED');
        await verifyArchiveBinding(ticket);
        ticket.stagingPath = path.join(ticket.target.root.path, `.material-archive-${crypto.randomUUID()}`);
      }
      const record = { version: 1, operationId: input.operationId, projectId: input.projectId, kind: input.kind, action: ticket.action, relativePath: ticket.source.relativePath, baseline: clone(ticket.baseline), binding: { source: ticket.source, ...(ticket.target ? { target: ticket.target, metadata: ticket.metadata, stagingPath: ticket.stagingPath } : {}) }, status: 'running', integrity: null, bytes: 0, sha256: null, reason: null, createdAt: Date.now(), updatedAt: Date.now(), durable: true };
      active.binding = clone(record.binding);
      const initial = await store.create(record);
      if (!initial.created) return query(input);
      tickets.delete(input.ticketId);
      const remaining = limits.timeoutMs - (performance.now() - started);
      const outcome = ticket.action === 'archive'
        ? await archiveSource(ticket, { limits, started, signal: controller.signal, validate: async () => {
          const latest = await association(input, true);
          if (!sameSource(ticket.source, await inspectSource(latest.root, ticket.source.relativePath))) fail('SOURCE_OR_ASSOCIATION_CHANGED');
          const target = await archiveTarget(ticket.target.root.path, ticket.source, latest.protectedPaths);
          if (!samePathSnapshot(ticket.target.root, target.root, false)) fail('TARGET_CHANGED');
          await verifyArchiveBinding(ticket);
        } })
        : remaining <= 0
        ? { integrity: 'timeout', bytes: 0, sha256: null, reason: 'timeout' }
        : await hashSource(ticket.source, { limits: { ...limits, timeoutMs: remaining }, baseline: ticket.baseline, signal: controller.signal });
      let associationCurrent = true;
      // Re-read association after I/O. An old root must never yield a current pass.
      try { const latest = await association(input); if (!sameSource(ticket.source, await inspectSource(latest.root, ticket.source.relativePath))) { associationCurrent = false; Object.assign(outcome, { integrity: 'changed', sha256: null, reason: 'SOURCE_OR_ASSOCIATION_CHANGED' }); } }
      catch { associationCurrent = false; Object.assign(outcome, { integrity: 'changed', sha256: null, reason: 'SOURCE_OR_ASSOCIATION_CHANGED' }); }
      if (ticket.action !== 'archive' && ['matched', 'mismatched', 'no_baseline'].includes(outcome.integrity)) {
        if (controller.signal.aborted) Object.assign(outcome, { integrity: 'cancelled', sha256: null, reason: 'cancelled' });
        else if (performance.now() - started >= limits.timeoutMs) Object.assign(outcome, { integrity: 'timeout', sha256: null, reason: 'timeout' });
      }
      if (ticket.action === 'archive' && ['matched', 'mismatched', 'no_baseline'].includes(outcome.integrity)) {
        const reason = controller.signal.aborted ? 'cancelled' : performance.now() - started >= limits.timeoutMs ? 'timeout' : null;
        if (reason && outcome.archive.state === 'published') outcome.reason = `${reason.toUpperCase()}_AFTER_PUBLICATION`;
        else if (reason) Object.assign(outcome, { integrity: reason, sha256: null, reason });
      }
      Object.assign(record, outcome, { status: outcome.status || (outcome.archive?.state === 'published' && !associationCurrent ? 'partial' : 'completed'), updatedAt: Date.now() });
      try { await store.update(record, initial.snapshot); }
      catch { return { ...clone(record), status: 'partial', durable: false, reason: 'RESULT_NOT_PERSISTED', associationCurrent: false }; }
      return { ...clone(record), associationCurrent };
    } finally { active = null; }
  }
  async function cancel(input) {
    // Validate the saved scope and store before changing only an in-memory flag.
    // Missing material/unrelated roots must not hide historical evidence or
    // prevent cancellation of an already-started, correctly bound operation.
    const result = await query(input);
    if (active?.operationId === input.operationId) {
      if (active.projectId !== input.projectId || active.kind !== input.kind) fail('OPERATION_SCOPE_MISMATCH');
      if (result.status === 'running') {
        if (JSON.stringify(result.binding) !== JSON.stringify(active.binding)) fail('STORE_CHANGED');
        active.controller.abort();
      }
    }
    return result;
  }
  return { preview, execute, query, cancel };
}
