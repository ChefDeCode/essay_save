'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { semanticHash } = require('../src/main/data/canonical');
const { validateProjectAggregate, isStableUuid } = require('../src/main/data/schema');
const { validateDescriptor, sha256Buffer } = require('../src/main/data/asset-store');
const { createSourceTreeManifest } = require('./lib/source-tree');

const ERROR_METRICS = Object.freeze([
  'schemaErrors',
  'checksumMismatch',
  'missingRequiredAssets',
  'undeclaredDegradedAssets',
  'unexpectedDanglingCitations',
  'duplicateIds',
  'revisionRegression',
  'pathEscapes',
  'unreachableAssetsAfterGc',
  'mixedCommits',
  'crossProjectLeaks',
  'undeclaredBrokenEvidenceLinks',
  'invalidEvidenceReviewTransitions',
  'aiConfirmedEvidence',
  'unconfirmedQuoteInsertions',
  'autoConfirmedAICells',
  'unlinkedGroundedAnswers',
  'unlinkedAIMatrixCells',
  'acceptedUnknownGroundedSourceTokens',
  'undeclaredMissingAuditContentBlobs',
  'selectedManagedRedactionLeaks',
  'secretLeaks'
]);

const INFORMATION_METRICS = Object.freeze([
  'declaredOptionalMissingAssets',
  'sourceMissing',
  'sourceMismatch',
  'archivedEvidenceLinks',
  'declaredRedactedAuditBlobs',
  'rejectedUnknownSourceTokens'
]);

const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)/i;
const SECRET_VALUE_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,})/i;

function emptyMetrics(names) {
  return Object.fromEntries(names.map(name => [name, 0]));
}

function parseArguments(argv) {
  const result = { profile: null, deep: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--deep') {
      result.deep = true;
      continue;
    }
    for (const option of ['--profile', '--output']) {
      if (argument === option) {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${option} requires a path`);
        result[option.slice(2)] = path.resolve(value);
        index += 1;
        break;
      }
      if (argument.startsWith(`${option}=`)) {
        result[option.slice(2)] = path.resolve(argument.slice(option.length + 1));
        break;
      }
    }
  }
  if (!result.profile) throw new Error('--profile is required');
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function addFinding(state, metric, relativePath, message, details = {}) {
  if (!Object.prototype.hasOwnProperty.call(state.metrics, metric)) throw new Error(`Unknown integrity metric: ${metric}`);
  state.metrics[metric] += 1;
  state.findings.push({ metric, path: relativePath, message, ...details });
}

function walkFiles(rootPath, state) {
  const result = [];
  if (!fs.existsSync(rootPath)) return result;
  const root = fs.realpathSync(rootPath);
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join('/');
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        addFinding(state, 'pathEscapes', relativePath, 'Symbolic links and junctions are forbidden in managed data');
        continue;
      }
      const realPath = fs.realpathSync(absolutePath);
      const relativeReal = path.relative(root, realPath);
      if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
        addFinding(state, 'pathEscapes', relativePath, 'Managed path resolves outside the workspace');
        continue;
      }
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) result.push({ absolutePath, relativePath, stat });
    }
  }
  visit(rootPath);
  return result;
}

function collectAssetIds(value, output = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (isStableUuid(value.assetId)) output.add(value.assetId.toLowerCase());
  if (Array.isArray(value)) value.forEach(item => collectAssetIds(item, output, seen));
  else Object.values(value).forEach(item => collectAssetIds(item, output, seen));
  return output;
}

function itemId(item) {
  for (const key of ['id', 'eventId', 'blobId', 'citationItemId', 'threadId']) {
    if (isStableUuid(item?.[key])) return item[key].toLowerCase();
  }
  return null;
}

function derivedEvidenceStatus(events) {
  const ordered = [...events].sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (ordered.length < 1 || ordered.length > 2) return { valid: false, status: null };
  const first = ordered[0];
  if (first.sequence !== 1 || first.previousReviewEventId !== null) return { valid: false, status: null };
  const createdBy = first.actor === 'ai' ? 'ai' : 'user';
  if ((createdBy === 'ai' && first.status !== 'proposed') || (createdBy === 'user' && first.status !== 'confirmed')) {
    return { valid: false, status: null };
  }
  if (ordered.length === 1) return { valid: true, status: first.status, createdBy };
  const second = ordered[1];
  if (createdBy !== 'ai' || second.sequence !== 2 || second.actor !== 'user' ||
      !['confirmed', 'rejected'].includes(second.status) || second.previousReviewEventId !== first.id) {
    return { valid: false, status: null };
  }
  return { valid: true, status: second.status, createdBy };
}

function validateRelationships(aggregate, state, relativePath) {
  const projectId = aggregate.manifest.projectId.toLowerCase();
  const citationIds = new Set(aggregate.citationItems.map(itemId).filter(Boolean));
  const evidenceByRevision = new Map(aggregate.evidenceRevisions.map(item => [itemId(item), item]));
  const auditById = new Map(aggregate.auditEvents.map(item => [itemId(item), item]));
  const auditBlobs = new Set(aggregate.auditContentBlobs.map(itemId).filter(Boolean));
  const reviewGroups = new Map();
  for (const event of aggregate.evidenceReviewEvents) {
    const revisionId = String(event.evidenceRevisionId || '').toLowerCase();
    if (!reviewGroups.has(revisionId)) reviewGroups.set(revisionId, []);
    reviewGroups.get(revisionId).push(event);
  }
  const evidenceStatus = new Map();
  for (const [revisionId, revision] of evidenceByRevision) {
    const derived = derivedEvidenceStatus(reviewGroups.get(revisionId) || []);
    evidenceStatus.set(revisionId, derived);
    if (!derived.valid) addFinding(state, 'invalidEvidenceReviewTransitions', relativePath, 'Evidence review chain is invalid', { revisionId });
    if (revision?.createdBy === 'ai' && derived.status === 'confirmed' && derived.createdBy !== 'ai') {
      addFinding(state, 'aiConfirmedEvidence', relativePath, 'AI evidence bypassed explicit user review', { revisionId });
    }
  }

  for (const link of aggregate.citationLinks) {
    for (const entry of link.items || []) {
      const citationItemId = String(entry.citationItemId || '').toLowerCase();
      if (!citationIds.has(citationItemId)) {
        addFinding(state, 'unexpectedDanglingCitations', relativePath, 'CitationLink references a missing citation item', {
          citationLinkId: itemId(link), citationItemId
        });
      }
      for (const revisionIdValue of entry.evidenceRevisionIds || []) {
        const revisionId = String(revisionIdValue).toLowerCase();
        if (!evidenceByRevision.has(revisionId)) {
          const declared = ['evidence-missing', 'source-mismatch'].includes(entry.status);
          addFinding(state, declared ? 'sourceMissing' : 'undeclaredBrokenEvidenceLinks', relativePath,
            declared ? 'Citation evidence is declared missing' : 'Citation evidence is missing without a degraded state', { revisionId });
        } else if (link.insertionMode === 'quote' && evidenceStatus.get(revisionId)?.status !== 'confirmed') {
          addFinding(state, 'unconfirmedQuoteInsertions', relativePath, 'Direct quotation uses unconfirmed evidence', { revisionId });
        }
      }
      if (entry.status === 'source-mismatch') state.metrics.sourceMismatch += 1;
    }
  }

  for (const answer of aggregate.groundedAnswers) {
    const request = auditById.get(String(answer.auditRequestId || '').toLowerCase());
    const result = auditById.get(String(answer.auditResultId || '').toLowerCase());
    if (!request || !result || result.requestEventId !== answer.auditRequestId) {
      addFinding(state, 'unlinkedGroundedAnswers', relativePath, 'Grounded answer has no valid audit request/result chain', {
        answerId: itemId(answer)
      });
    }
  }

  for (const matrix of aggregate.reviewMatrices) {
    for (const row of matrix.rows || []) {
      for (const cell of Object.values(row.cells || {})) {
        if (!cell || typeof cell !== 'object') continue;
        if (cell.origin === 'ai' && cell.reviewStatus === 'confirmed' && cell.reviewedBy !== 'user') {
          addFinding(state, 'autoConfirmedAICells', relativePath, 'AI matrix cell was automatically confirmed');
        }
        for (const sourceRef of cell.sourceRefs || []) {
          if (!evidenceByRevision.has(String(sourceRef.evidenceRevisionId || '').toLowerCase())) {
            addFinding(state, 'unlinkedAIMatrixCells', relativePath, 'Matrix source reference is not linked to evidence');
          }
        }
      }
    }
  }

  for (const event of aggregate.auditEvents) {
    const blobId = event.contentBlobId || event.auditContentBlobId;
    if (!blobId) continue;
    if (auditBlobs.has(String(blobId).toLowerCase())) continue;
    if (event.contentStatus === 'redacted') state.metrics.declaredRedactedAuditBlobs += 1;
    else addFinding(state, 'undeclaredMissingAuditContentBlobs', relativePath, 'Audit event references a missing content blob', {
      eventId: itemId(event), blobId
    });
  }

  for (const field of Object.keys(aggregate)) {
    if (!Array.isArray(aggregate[field])) continue;
    for (const item of aggregate[field]) {
      if (item?.projectId && String(item.projectId).toLowerCase() !== projectId) {
        addFinding(state, 'crossProjectLeaks', relativePath, `${field} contains another project ID`, { itemId: itemId(item) });
      }
    }
  }
}

function isRelationshipInspectable(aggregate) {
  if (!aggregate || typeof aggregate !== 'object' || !aggregate.manifest || !isStableUuid(aggregate.manifest.projectId)) {
    return false;
  }
  return [
    'citationItems', 'citationLinks', 'evidenceRevisions', 'evidenceReviewEvents',
    'auditEvents', 'auditContentBlobs', 'groundedAnswers', 'reviewMatrices'
  ].every(field => Array.isArray(aggregate[field]));
}

function inspectProject(projectDirectory, state, globalIds, reachableAssetIds) {
  const projectId = path.basename(projectDirectory).toLowerCase();
  const headPath = path.join(projectDirectory, 'HEAD.json');
  const relativeHead = path.relative(state.workspaceRoot, headPath).split(path.sep).join('/');
  if (!isStableUuid(projectId) || !fs.existsSync(headPath)) {
    addFinding(state, 'schemaErrors', relativeHead, 'Project directory or HEAD identity is invalid');
    return;
  }
  let head;
  let envelope;
  try {
    head = readJson(headPath);
    const commitName = `${String(head.revision).padStart(12, '0')}-${head.commitId}.json`;
    const commitPath = path.join(projectDirectory, 'commits', commitName);
    envelope = readJson(commitPath);
    if (head.projectId !== projectId || envelope.projectId !== projectId || envelope.revision !== head.revision ||
        envelope.commitId !== head.commitId || semanticHash(envelope) !== head.envelopeHash) {
      addFinding(state, 'mixedCommits', relativeHead, 'HEAD does not bind one complete commit envelope');
      return;
    }
  } catch (error) {
    addFinding(state, 'schemaErrors', relativeHead, 'Project HEAD or commit cannot be validated', { error: error.message });
    return;
  }

  try {
    validateProjectAggregate(envelope.aggregate);
  } catch (error) {
    addFinding(state, 'schemaErrors', relativeHead, 'Project aggregate schema is invalid', { error: error.message });
  }
  if (semanticHash(envelope.aggregate) !== envelope.aggregateHash) {
    addFinding(state, 'checksumMismatch', relativeHead, 'Project aggregate checksum differs from its envelope');
  }
  if (!isRelationshipInspectable(envelope.aggregate)) return;

  state.counts.projects += 1;
  state.counts.commits += 1;
  collectAssetIds(envelope.aggregate, reachableAssetIds);
  for (const field of Object.keys(envelope.aggregate)) {
    if (!Array.isArray(envelope.aggregate[field])) continue;
    for (const item of envelope.aggregate[field]) {
      const id = itemId(item);
      if (!id) continue;
      if (globalIds.has(id)) addFinding(state, 'duplicateIds', relativeHead, 'Stable ID appears more than once', {
        id, firstPath: globalIds.get(id)
      });
      else globalIds.set(id, relativeHead);
    }
  }
  validateRelationships(envelope.aggregate, state, relativeHead);

  const commitsPath = path.join(projectDirectory, 'commits');
  if (fs.existsSync(commitsPath)) {
    const revisions = [];
    for (const name of fs.readdirSync(commitsPath).filter(name => name.endsWith('.json')).sort()) {
      try {
        const commit = readJson(path.join(commitsPath, name));
        revisions.push(commit.revision);
        if (commit.projectId !== projectId || semanticHash(commit.aggregate) !== commit.aggregateHash) {
          addFinding(state, 'checksumMismatch', `projects/${projectId}/commits/${name}`, 'Immutable commit checksum is invalid');
        }
        collectAssetIds(commit.aggregate, reachableAssetIds);
      } catch (error) {
        addFinding(state, 'schemaErrors', `projects/${projectId}/commits/${name}`, 'Commit is not valid JSON', { error: error.message });
      }
    }
    for (let index = 1; index < revisions.length; index += 1) {
      if (revisions[index] <= revisions[index - 1]) {
        addFinding(state, 'revisionRegression', relativeHead, 'Commit revisions are not strictly increasing');
        break;
      }
    }
    if (revisions.length && Math.max(...revisions) < head.revision) {
      addFinding(state, 'revisionRegression', relativeHead, 'HEAD revision exceeds all immutable commits');
    }
    state.counts.commits += Math.max(0, revisions.length - 1);
  }

  const versionsPath = path.join(projectDirectory, 'versions');
  if (fs.existsSync(versionsPath)) {
    for (const name of fs.readdirSync(versionsPath).filter(name => name.endsWith('.json')).sort()) {
      try {
        const snapshot = readJson(path.join(versionsPath, name));
        collectAssetIds(snapshot.aggregate, reachableAssetIds);
        state.counts.versions += 1;
      } catch (error) {
        addFinding(state, 'schemaErrors', `projects/${projectId}/versions/${name}`, 'Version snapshot is corrupt', {
          error: error.message
        });
      }
    }
  }
}

function inspectAssets(state, reachableAssetIds) {
  const assetsRoot = path.join(state.workspaceRoot, 'assets');
  const recordsRoot = path.join(assetsRoot, 'records');
  if (!fs.existsSync(recordsRoot)) return;
  for (const name of fs.readdirSync(recordsRoot).filter(name => name.endsWith('.json')).sort()) {
    const relativePath = `assets/records/${name}`;
    try {
      const descriptor = validateDescriptor(readJson(path.join(recordsRoot, name)));
      state.counts.assets += 1;
      const blobPath = path.join(assetsRoot, 'blobs', descriptor.sha256.slice(0, 2), descriptor.sha256);
      if (!fs.existsSync(blobPath)) {
        addFinding(state, 'missingRequiredAssets', relativePath, 'Asset descriptor has no blob', { assetId: descriptor.assetId });
      } else if (state.deep) {
        const bytes = fs.readFileSync(blobPath);
        if (bytes.length !== descriptor.size || sha256Buffer(bytes) !== descriptor.sha256) {
          addFinding(state, 'checksumMismatch', relativePath, 'Asset blob checksum or size differs', {
            assetId: descriptor.assetId
          });
        }
      }
      if (!reachableAssetIds.has(descriptor.assetId.toLowerCase())) {
        addFinding(state, 'unreachableAssetsAfterGc', relativePath, 'Asset is unreachable from current/history/trash/backup data', {
          assetId: descriptor.assetId
        });
      }
    } catch (error) {
      addFinding(state, 'schemaErrors', relativePath, 'Asset descriptor is invalid', { error: error.message });
    }
  }
}

function inspectBackupReachability(state, reachableAssetIds) {
  for (const rootName of ['backups', 'journal']) {
    const rootPath = path.join(state.workspaceRoot, rootName);
    if (!fs.existsSync(rootPath)) continue;
    for (const file of walkFiles(rootPath, state).filter(item => item.relativePath.endsWith('.json'))) {
      try { collectAssetIds(readJson(file.absolutePath), reachableAssetIds); } catch { /* Schema checks happen at owning service. */ }
    }
  }
}

function inspectSecretLeaks(state, files) {
  for (const file of files) {
    if (!/\.(?:json|html|txt)$/i.test(file.relativePath)) continue;
    if (file.relativePath.startsWith('credentials/')) continue;
    if (file.stat.size > 16 * 1024 * 1024) continue;
    const content = fs.readFileSync(file.absolutePath, 'utf8');
    if (SECRET_VALUE_PATTERN.test(content)) {
      addFinding(state, 'secretLeaks', file.relativePath, 'Reusable credential-shaped value appears in managed exportable data');
      continue;
    }
    if (file.relativePath.startsWith('settings/')) {
      try {
        const value = JSON.parse(content);
        const stack = [value];
        while (stack.length) {
          const current = stack.pop();
          if (!current || typeof current !== 'object') continue;
          for (const [key, child] of Object.entries(current)) {
            if (SECRET_KEY_PATTERN.test(key)) {
              addFinding(state, 'secretLeaks', file.relativePath, `Secret field appears in exportable settings: ${key}`);
              return;
            }
            if (child && typeof child === 'object') stack.push(child);
          }
        }
      } catch { /* Corrupt JSON is reported by the owning schema validator. */ }
    }
  }
}

function resolveWorkspaceRoot(profilePath) {
  const direct = path.resolve(profilePath);
  const nested = path.join(direct, 'workspace');
  if (fs.existsSync(path.join(nested, 'projects'))) return nested;
  return direct;
}

function verifyWorkspace(options) {
  const workspaceRoot = resolveWorkspaceRoot(options.profile);
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`Workspace does not exist: ${workspaceRoot}`);
  }
  const state = {
    workspaceRoot,
    deep: options.deep === true,
    metrics: { ...emptyMetrics(ERROR_METRICS), ...emptyMetrics(INFORMATION_METRICS) },
    findings: [],
    counts: { projects: 0, commits: 0, versions: 0, assets: 0 }
  };
  const files = walkFiles(workspaceRoot, state);
  const reachableAssetIds = new Set();
  const globalIds = new Map();
  const projectsRoot = path.join(workspaceRoot, 'projects');
  if (fs.existsSync(projectsRoot)) {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      inspectProject(path.join(projectsRoot, entry.name), state, globalIds, reachableAssetIds);
    }
  }
  inspectBackupReachability(state, reachableAssetIds);
  inspectAssets(state, reachableAssetIds);
  inspectSecretLeaks(state, files);
  state.findings.sort((left, right) => left.metric.localeCompare(right.metric, 'en') || left.path.localeCompare(right.path, 'en'));
  const errors = ERROR_METRICS.reduce((sum, name) => sum + state.metrics[name], 0);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile: path.resolve(options.profile),
    workspaceRoot,
    deep: state.deep,
    passed: errors === 0,
    errors,
    metrics: state.metrics,
    counts: state.counts,
    findings: state.findings
  };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  const report = verifyWorkspace(parsed);
  const repositoryRoot = path.resolve(__dirname, '..');
  const sourceTree = createSourceTreeManifest(repositoryRoot);
  report.sourceTreeSha256 = sourceTree.sourceTreeSha256;
  report.sourceTreeFileCount = sourceTree.fileCount;
  const outputPath = parsed.output || path.join(repositoryRoot, 'artifacts', 'integrity-report.json');
  atomicWriteJson(outputPath, report);
  console.log(`integrityReport=${outputPath}`);
  console.log(`errors=${report.errors}`);
  for (const metric of ERROR_METRICS) console.log(`${metric}=${report.metrics[metric]}`);
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  ERROR_METRICS,
  INFORMATION_METRICS,
  collectAssetIds,
  parseArguments,
  resolveWorkspaceRoot,
  run,
  verifyWorkspace
};
