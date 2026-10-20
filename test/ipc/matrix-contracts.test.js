'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const contracts = require('../../src/main/ipc/matrix-contracts');

const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ID = 'c5000000-0000-4000-8000-000000000001';
const MATRIX_ID = 'c5000000-0000-4000-8000-000000000002';
const ROW_ID = 'c5000000-0000-4000-8000-000000000003';
const COLUMN_ID = 'c5000000-0000-4000-8000-000000000004';
const CITATION_ID = 'c5000000-0000-4000-8000-000000000005';
const ASSET_ID = 'c5000000-0000-4000-8000-000000000006';

function base(extra = {}) {
  return { projectId: PROJECT_ID, baseRevision: 1, matrixId: MATRIX_ID, ...extra };
}

test('matrix IPC contracts accept bounded exact payloads for manual and batch operations', () => {
  assert.equal(contracts.projectId(PROJECT_ID), PROJECT_ID);
  assert.equal(contracts.create({ projectId: PROJECT_ID, baseRevision: 1, name: '矩阵', citationItemIds: [CITATION_ID] }).name, '矩阵');
  assert.equal(contracts.addColumn(base({ label: '自定义列' })).label, '自定义列');
  assert.equal(contracts.deleteColumn(base({ columnId: COLUMN_ID })).columnId, COLUMN_ID);
  assert.equal(contracts.reorder(base({ columnIds: [COLUMN_ID] })).columnIds.length, 1);
  assert.equal(contracts.setRows(base({ citationItemIds: [] })).citationItemIds.length, 0);
  assert.equal(contracts.updateCell(base({ rowId: ROW_ID, columnId: COLUMN_ID, value: '用户内容' })).value, '用户内容');
  assert.equal(contracts.reviewCell(base({ rowId: ROW_ID, columnId: COLUMN_ID, decision: 'confirmed' })).decision, 'confirmed');
  const preview = contracts.prefillPreview(base({
    rowIds: [ROW_ID],
    sourcesByCitationId: {
      [CITATION_ID]: {
        type: 'pdf', assetId: ASSET_ID, fileSha256: 'a'.repeat(64),
        pages: [{
          pageIndex: 0, pageLabel: '1', text: '全文', rects: [{ x: 0, y: 0, width: 1, height: 1 }],
          pageRotation: 0, cropBox: { x: 0, y: 0, width: 612, height: 792 }
        }]
      }
    },
    overwriteColumnIds: [], overwriteCellIds: [ROW_ID]
  }));
  assert.equal(preview.sourcesByCitationId[CITATION_ID].type, 'pdf');
  assert.equal(contracts.prefillExecute({ previewId: ROW_ID, confirmed: true }).confirmed, true);
  assert.equal(contracts.cancel({ batchId: ROW_ID }).batchId, ROW_ID);
  assert.equal(contracts.exportMatrix({ projectId: PROJECT_ID, matrixId: MATRIX_ID, format: 'xlsx' }).format, 'xlsx');
});

test('matrix IPC contracts reject unknown authority, path, oversized and malformed geometry fields', () => {
  assert.throws(() => contracts.create({ projectId: PROJECT_ID, baseRevision: 1, citationItemIds: [], actor: 'user' }));
  assert.throws(() => contracts.addColumn({ projectId: PROJECT_ID, baseRevision: 1, label: 'missing matrix' }));
  assert.throws(() => contracts.updateCell(base({ rowId: ROW_ID, columnId: COLUMN_ID, value: 'x', reviewStatus: 'confirmed' })));
  assert.throws(() => contracts.exportMatrix({ projectId: PROJECT_ID, matrixId: MATRIX_ID, format: 'xlsx', filePath: 'C:\\escape.xlsx' }));
  assert.throws(() => contracts.prefillPreview(base({
    rowIds: [ROW_ID], overwriteColumnIds: [], overwriteCellIds: [],
    sourcesByCitationId: { [CITATION_ID]: { type: 'abstract', abstract: 'x'.repeat(contracts.MAX_PAYLOAD_BYTES + 1) } }
  })));
  assert.throws(() => contracts.prefillPreview(base({
    rowIds: [ROW_ID], overwriteColumnIds: [], overwriteCellIds: [],
    sourcesByCitationId: {
      [CITATION_ID]: {
        type: 'pdf', assetId: ASSET_ID, fileSha256: 'a'.repeat(64),
        pages: [{ pageIndex: 0, pageLabel: '1', text: 'x', rects: [{ x: 0.9, y: 0, width: 0.2, height: 1 }] }]
      }
    }
  })));
});

test('all matrix capabilities are trusted IPC handlers and renderer receives no absolute-path export primitive', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const channels = [
    'matrix-list', 'matrix-create', 'matrix-column-add', 'matrix-column-delete', 'matrix-column-reorder',
    'matrix-rows-set', 'matrix-cell-update', 'matrix-cell-review', 'matrix-prefill-preview',
    'matrix-prefill-execute', 'matrix-prefill-cancel', 'matrix-export'
  ];
  channels.forEach(channel => {
    assert.match(main, new RegExp(`registerIpcHandler\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  });
  assert.doesNotMatch(preload, /reviewMatrix[^\n]*(?:filePath|absolutePath)/i);
  assert.doesNotMatch(preload, /appendMatrixReview|writeMatrixFile|setMatrixActor/i);
});
