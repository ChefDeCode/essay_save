const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_AI_FILES = ['src/app.js', 'src/ai-assistant.js', 'src/search.js', 'src/settings.js'];

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function functionBody(text, functionName) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const match = signature.exec(text);
  assert.ok(match, `missing function ${functionName}`);
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = match.index + match[0].length; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return text.slice(match.index, index + 1);
  }
  assert.fail(`unterminated function ${functionName}`);
}

test('renderer AI and scholarly surfaces cannot use the removed generic network broker', () => {
  const preload = source('preload.js');
  assert.doesNotMatch(preload, /\bnetRequest\s*:/);
  assert.doesNotMatch(preload, /\bnetStream\s*:/);

  for (const relativePath of RENDERER_AI_FILES) {
    const text = source(relativePath);
    assert.doesNotMatch(text, /electronAPI\.(?:netRequest|netStream)\b/, relativePath);
    assert.doesNotMatch(text, /\bXMLHttpRequest\b|\bWebSocket\s*\(/, relativePath);
    assert.doesNotMatch(text, /function\s+executeAIAction\b/, relativePath);
  }
});

test('every renderer requestAI call declares an auditable operation', () => {
  for (const relativePath of RENDERER_AI_FILES) {
    const text = source(relativePath);
    const matcher = /\brequestAI\s*\(/g;
    for (const match of text.matchAll(matcher)) {
      const prefix = text.slice(Math.max(0, match.index - 20), match.index);
      if (/function\s*$/.test(prefix)) continue;
      const callWindow = text.slice(match.index, match.index + 1800);
      assert.match(callWindow, /operation\s*:\s*['"](?:chat|search-keywords|literature-metadata)['"]/, `${relativePath}:${match.index}`);
    }
  }
});

test('slash and inline entry points only stage ReviewIssue flows before acceptance', () => {
  const assistant = source('src/ai-assistant.js');
  for (const functionName of ['handleSlashCommand', 'handleInlineAI']) {
    const body = functionBody(assistant, functionName);
    assert.match(body, /requestEssayflowReviewForSelection/);
    assert.doesNotMatch(body, /\brequestAI\s*\(/);
    assert.doesNotMatch(body, /quill\.(?:deleteText|insertText|updateContents)\s*\(/);
  }
});

test('citation verification uses fixed identity states and contains no authority claim', () => {
  const assistant = source('src/ai-assistant.js');
  const verify = functionBody(assistant, 'handleVerifyCitation');
  for (const status of ['exact-doi', 'strong-metadata-match', 'ambiguous', 'not-found', 'unchecked-retraction']) {
    assert.match(verify, new RegExp(status));
  }
  assert.doesNotMatch(verify, /真实存在|权威验证|验证通过|论点已验证/);
  assert.match(verify, /候选/);
  assert.match(verify, /不能证明|不等于/);
});

test('specified literature requires an explicit summary, evidence or full-text scope without silent truncation', () => {
  const assistant = source('src/ai-assistant.js');
  const paper = functionBody(assistant, 'sendPaperToAI');
  assert.match(paper, /摘要/);
  assert.match(paper, /证据/);
  assert.match(paper, /全文/);
  assert.match(paper, /window\.prompt/);
  assert.match(paper, /listEvidence/);
  assert.doesNotMatch(paper, /fullText\.slice|pdfText\.slice/);
  assert.match(paper, /CHAT_PENDING_TEXT_LIMIT/);
});
