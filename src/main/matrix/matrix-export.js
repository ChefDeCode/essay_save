'use strict';

const JSZip = require('jszip');

function safeText(value) {
  const normalized = String(value ?? '').normalize('NFC');
  return /^[=+\-@\t\r]/u.test(normalized) ? `'${normalized}` : normalized;
}

function csvCell(value) {
  const text = safeText(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows) {
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function xml(value) {
  return safeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnName(index) {
  let value = index + 1;
  let output = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function worksheet(rows) {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
}

function buildRows(matrix, citationItems) {
  const byId = new Map(citationItems.map(item => [String(item.citationItemId || item.id).toLowerCase(), item]));
  const columns = [...matrix.columns].sort((left, right) => left.order - right.order);
  const matrixRows = [['文献 ID', '题名', 'DOI', ...columns.map(column => column.label)]];
  const sourceRows = [[
    '矩阵 ID', '单元格 ID', '文献 ID', '题名', 'DOI', '字段', '值', '依据', '审阅状态',
    'Evidence ID', 'EvidenceRevision ID', '页码', '原文', '原文 SHA-256', 'AI 审计结果 ID'
  ]];
  for (const row of matrix.rows) {
    const citation = byId.get(row.citationItemId.toLowerCase()) || {};
    matrixRows.push([
      row.citationItemId, citation.title || '', citation.DOI || citation.doi || '',
      ...columns.map(column => row.cells[column.id]?.value || '')
    ]);
    for (const column of columns) {
      const cell = row.cells[column.id];
      if (!cell) continue;
      if (cell.sourceRefs.length) {
        for (const source of cell.sourceRefs) {
          sourceRows.push([
            matrix.id, cell.id, row.citationItemId, citation.title || '', citation.DOI || citation.doi || '', column.label, cell.value,
            cell.basis, cell.reviewStatus, source.evidenceId, source.evidenceRevisionId,
            source.pageLabel, source.quote, source.rawQuoteSha256, cell.auditResultEventId || ''
          ]);
        }
      } else {
        sourceRows.push([
          matrix.id, cell.id, row.citationItemId, citation.title || '', citation.DOI || citation.doi || '', column.label, cell.value,
          cell.basis, cell.reviewStatus, '', '', '', '', cell.abstractSnapshotSha256 || '', cell.auditResultEventId || ''
        ]);
      }
    }
  }
  return { matrixRows, sourceRows };
}

async function exportCsvZip(matrix, citationItems) {
  const rows = buildRows(matrix, citationItems);
  const zip = new JSZip();
  zip.file('matrix.csv', csv(rows.matrixRows));
  zip.file('sources.csv', csv(rows.sourceRows));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

async function exportXlsx(matrix, citationItems) {
  const rows = buildRows(matrix, citationItems);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Matrix" sheetId="1" r:id="rId1"/><sheet name="Sources" sheetId="2" r:id="rId2"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', worksheet(rows.matrixRows));
  zip.file('xl/worksheets/sheet2.xml', worksheet(rows.sourceRows));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

module.exports = { buildRows, csv, exportCsvZip, exportXlsx, safeText, worksheet };
