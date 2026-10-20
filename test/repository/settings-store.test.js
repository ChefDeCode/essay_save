'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { durableWriteJson } = require('../../src/main/data/durable-fs');
const {
  CREDENTIAL_STATUS,
  ERROR_CODES,
  EXPORTABLE_SETTINGS_FIELDS,
  SecretStore,
  SettingsStore,
  createBackupSettingsPayload,
  redactSecrets,
  sanitizeExportableSettings,
  splitLegacySettings,
  validateBackupSettingsPayload,
  validateExportableSettings,
  validateSecretEnvelope
} = require('../../src/main/data/settings-store');

function temporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeSafeStorage(options = {}) {
  const prefix = Buffer.from('essayflow-test-cipher\0', 'utf8');
  return {
    isEncryptionAvailable() {
      return options.available !== false;
    },
    encryptString(plainText) {
      if (options.encryptError) throw options.encryptError;
      return Buffer.concat([prefix, Buffer.from(plainText, 'utf8').subarray().reverse()]);
    },
    decryptString(buffer) {
      if (options.decryptError) throw options.decryptError;
      assert.equal(buffer.subarray(0, prefix.length).equals(prefix), true);
      return buffer.subarray(prefix.length).reverse().toString('utf8');
    }
  };
}

function errorCode(code) {
  return error => {
    assert.equal(error.code, code);
    return true;
  };
}

test('exportable settings use the contract whitelist and deterministic normalization', () => {
  assert.deepEqual(EXPORTABLE_SETTINGS_FIELDS, [
    'theme',
    'layout',
    'shortcuts',
    'defaultReferenceStyle',
    'enabledSearchSourceIds',
    'customSearchSources',
    'providerId',
    'providerOrigin',
    'model',
    'featureToggles'
  ]);
  const settings = validateExportableSettings({
    theme: 'DARK',
    layout: { rightPanelWidth: 360, collapsed: false },
    shortcuts: [{ id: 'bold', key: 'Ctrl+B', enabled: true }],
    defaultReferenceStyle: 'GB/T 7714',
    enabledSearchSourceIds: ['openalex', 'arxiv', 'arxiv'],
    providerId: 'deepseek',
    providerOrigin: 'https://api.deepseek.com/',
    model: 'deepseek-chat',
    featureToggles: { aiSearch: true, aiVerify: false }
  });
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.enabledSearchSourceIds, ['arxiv', 'openalex']);
  assert.equal(settings.providerOrigin, 'https://api.deepseek.com');
  assert.equal(Object.isFrozen(settings), true);
  assert.equal(Object.isFrozen(settings.layout), true);
  assert.throws(() => validateExportableSettings({ telemetry: true }), errorCode(ERROR_CODES.FIELD_UNKNOWN));
  assert.throws(() => validateExportableSettings({ providerOrigin: 'https://user:pass@example.test/v1' }),
    errorCode(ERROR_CODES.FIELD_INVALID));
});

test('custom search sources persist only public HTTPS endpoint metadata', () => {
  const settings = validateExportableSettings({
    customSearchSources: [{
      id: 'fixture-source',
      name: 'Fixture Source',
      url: 'https://papers.example.test/search?q={query}',
      enabled: true
    }]
  });
  assert.deepEqual(settings.customSearchSources, [{
    id: 'fixture-source',
    name: 'Fixture Source',
    url: 'https://papers.example.test/search?q={query}',
    enabled: true
  }]);
  assert.throws(() => validateExportableSettings({
    customSearchSources: [{
      id: 'insecure-source',
      name: 'Insecure Source',
      url: 'http://papers.example.test/search?q={query}',
      enabled: true
    }]
  }), errorCode(ERROR_CODES.FIELD_INVALID));
  assert.throws(() => validateExportableSettings({
    customSearchSources: [{
      id: 'credential-source',
      name: 'Credential Source',
      url: 'https://papers.example.test/search?q={query}',
      enabled: true,
      apiKey: 'must-not-enter-exportable-settings'
    }]
  }), errorCode(ERROR_CODES.SECRET_FIELD));
  assert.throws(() => validateExportableSettings({
    customSearchSources: [
      { id: 'duplicate-source', name: 'First', url: 'https://one.example.test/?q={query}', enabled: true },
      { id: 'duplicate-source', name: 'Second', url: 'https://two.example.test/?q={query}', enabled: false }
    ]
  }), errorCode(ERROR_CODES.FIELD_INVALID));
});

test('filtering drops unknown and secret material at every exportable boundary', () => {
  const sentinels = ['plain-api-key-value', 'authorization-value', 'ciphertext-value', 'unknown-private-value'];
  const filtered = sanitizeExportableSettings({
    theme: 'light',
    apiKey: sentinels[0],
    layout: {
      leftWidth: 240,
      Authorization: sentinels[1],
      safeStorageCiphertext: sentinels[2]
    },
    diagnostics: sentinels[3]
  });
  assert.deepEqual(filtered, { theme: 'light', layout: { leftWidth: 240 } });
  const serialized = JSON.stringify(filtered);
  sentinels.forEach(secret => assert.equal(serialized.includes(secret), false));
  assert.throws(() => validateExportableSettings({ theme: 'dark', api_key: sentinels[0] }),
    errorCode(ERROR_CODES.SECRET_FIELD));
  assert.throws(() => validateExportableSettings({ layout: { headers: { Authorization: sentinels[1] } } }),
    errorCode(ERROR_CODES.SECRET_FIELD));
});

test('SettingsStore exposes a synchronous immutable cache and changes it only after durable ack', async t => {
  const root = temporaryRoot(t, 'essayflow-settings-');
  let releaseWrite;
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  const store = new SettingsStore(root, {
    durableWriteJson: async (...args) => {
      await blocked;
      return durableWriteJson(...args);
    }
  });
  assert.deepEqual(store.readSync(), {});
  const pending = store.update({ theme: 'dark', layout: { leftWidth: 280 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(store.readSync(), {});
  assert.equal(fs.existsSync(store.filePath), false);
  releaseWrite();
  const result = await pending;
  assert.equal(result.acknowledgment.durable, true);
  assert.deepEqual(store.readSync(), { layout: { leftWidth: 280 }, theme: 'dark' });
  const disk = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.deepEqual(disk.exportableSettings, store.readSync());
  assert.throws(() => { store.readSync().layout.leftWidth = 1; }, TypeError);
});

test('SettingsStore serializes concurrent updaters and preserves the last durable state', async t => {
  const root = temporaryRoot(t, 'essayflow-settings-queue-');
  const store = new SettingsStore(root);
  const first = store.update(current => ({ ...current, layout: { ...(current.layout || {}), left: 1 } }));
  const second = store.update(current => ({ ...current, layout: { ...(current.layout || {}), right: 2 } }));
  const third = store.update(current => ({ ...current, featureToggles: { queued: true } }));
  await Promise.all([first, second, third]);
  assert.deepEqual(store.readSync(), {
    featureToggles: { queued: true },
    layout: { left: 1, right: 2 }
  });
  const restarted = new SettingsStore(root);
  assert.deepEqual(restarted.readSync(), store.readSync());
});

test('failed settings writes do not acknowledge or mutate the synchronous cache', async t => {
  const root = temporaryRoot(t, 'essayflow-settings-failure-');
  const store = new SettingsStore(root);
  await store.replace({ theme: 'light' });
  const failing = new SettingsStore(root, {
    durableWriteJson: async () => {
      const error = new Error('synthetic disk failure');
      error.code = 'ENOSPC';
      throw error;
    }
  });
  await assert.rejects(failing.update({ theme: 'dark' }), /synthetic disk failure/);
  assert.deepEqual(failing.readSync(), { theme: 'light' });
  assert.deepEqual(new SettingsStore(root).readSync(), { theme: 'light' });
});

test('future settings schema loads as read-only without guessing a downgrade', async t => {
  const root = temporaryRoot(t, 'essayflow-settings-future-');
  const filePath = path.join(root, 'settings', 'exportable-settings.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 99,
    exportableSettings: { theme: 'future-theme' },
    futureCapability: { mode: 'unknown' }
  }));
  const store = new SettingsStore(root);
  assert.equal(store.readOnly, true);
  assert.equal(store.readEnvelopeSync().schemaVersion, 99);
  assert.throws(() => store.readSync(), errorCode(ERROR_CODES.SCHEMA_FUTURE));
  await assert.rejects(store.update({ theme: 'dark' }), errorCode(ERROR_CODES.READ_ONLY));
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).schemaVersion, 99);
});

test('backup settings contain only public values and always require provider credential re-entry', async t => {
  const root = temporaryRoot(t, 'essayflow-settings-backup-');
  const store = new SettingsStore(root);
  await store.replace({
    theme: 'dark',
    providerId: 'custom',
    providerOrigin: 'https://ai.example.test',
    model: 'fixture-model'
  });
  const payload = store.exportForBackup();
  assert.equal(payload.credentialStatus, CREDENTIAL_STATUS.NEEDS_REENTRY);
  assert.deepEqual(Object.keys(payload.exportableSettings).sort(),
    ['model', 'providerId', 'providerOrigin', 'theme']);
  assert.equal(JSON.stringify(payload).includes('encryptedBase64'), false);
  assert.throws(() => validateBackupSettingsPayload({
    ...payload,
    apiKey: 'backup-secret-sentinel'
  }), errorCode(ERROR_CODES.SECRET_FIELD));
  assert.throws(() => validateBackupSettingsPayload({
    ...payload,
    credentialStatus: CREDENTIAL_STATUS.CONFIGURED
  }), errorCode(ERROR_CODES.BACKUP_INVALID));

  const restoredRoot = temporaryRoot(t, 'essayflow-settings-restore-');
  const restored = new SettingsStore(restoredRoot);
  const result = await restored.importFromBackup(payload);
  assert.equal(result.credentialStatus, CREDENTIAL_STATUS.NEEDS_REENTRY);
  assert.deepEqual(restored.readSync(), store.readSync());
});

test('SecretStore refuses persistence when safeStorage is unavailable and has no plaintext fallback', async t => {
  const root = temporaryRoot(t, 'essayflow-secrets-unavailable-');
  const store = new SecretStore(root, fakeSafeStorage({ available: false }));
  await assert.rejects(store.setCredential('deepseek', 'unavailable-secret-sentinel'),
    errorCode(ERROR_CODES.SECRET_STORAGE_UNAVAILABLE));
  assert.equal(fs.existsSync(store.filePath), false);
  assert.equal(store.credentialStatus('deepseek'), CREDENTIAL_STATUS.NEEDS_REENTRY);
  assert.equal(store.credentialStatus('other-provider'), CREDENTIAL_STATUS.MISSING);
});

test('SecretStore persists only safeStorage base64 envelopes and decrypts on demand', async t => {
  const root = temporaryRoot(t, 'essayflow-secrets-encrypted-');
  const secret = 'sk-live-secret-sentinel-that-must-not-hit-disk';
  const store = new SecretStore(root, fakeSafeStorage());
  assert.equal(store.credentialStatus('deepseek'), CREDENTIAL_STATUS.MISSING);
  const result = await store.setCredential('deepseek', secret);
  assert.equal(result.credentialStatus, CREDENTIAL_STATUS.CONFIGURED);
  assert.equal(store.credentialStatus('deepseek'), CREDENTIAL_STATUS.CONFIGURED);
  assert.equal(store.getCredential('deepseek'), secret);

  const diskText = fs.readFileSync(store.filePath, 'utf8');
  const disk = JSON.parse(diskText);
  assert.equal(diskText.includes(secret), false);
  assert.deepEqual(Object.keys(disk.credentials.deepseek).sort(), [
    'encoding', 'encryptedBase64', 'providerId', 'schemaVersion', 'storage'
  ]);
  assert.equal(disk.credentials.deepseek.storage, 'electron.safeStorage');
  assert.equal(disk.credentials.deepseek.encoding, 'base64');
  assert.doesNotThrow(() => validateSecretEnvelope(disk));

  const restarted = new SecretStore(root, fakeSafeStorage());
  assert.equal(restarted.getCredential('deepseek'), secret);
  await restarted.removeCredential('deepseek', { needsReentry: true });
  assert.equal(restarted.credentialStatus('deepseek'), CREDENTIAL_STATUS.NEEDS_REENTRY);
  assert.equal(JSON.stringify(restarted.readEnvelopeSync()).includes(secret), false);
});

test('SecretStore never caches a failed write and reports undecryptable records as needs-reentry', async t => {
  const root = temporaryRoot(t, 'essayflow-secrets-failure-');
  const initial = new SecretStore(root, fakeSafeStorage());
  await initial.setCredential('custom', 'first-secret');
  const failing = new SecretStore(root, fakeSafeStorage(), {
    durableWriteJson: async () => { throw new Error('synthetic credential write failure'); }
  });
  await assert.rejects(failing.setCredential('custom', 'second-secret'), /synthetic credential write failure/);
  assert.equal(failing.getCredential('custom'), 'first-secret');

  const undecryptable = new SecretStore(root, fakeSafeStorage({ decryptError: new Error('wrong OS user') }));
  assert.equal(undecryptable.credentialStatus('custom'), CREDENTIAL_STATUS.NEEDS_REENTRY);
  assert.throws(() => undecryptable.getCredential('custom'), errorCode(ERROR_CODES.SECRET_DECRYPT_FAILED));
  assert.equal(undecryptable.credentialStatus('custom'), CREDENTIAL_STATUS.NEEDS_REENTRY);
});

test('future secret schema is preserved read-only and plaintext-shaped envelopes fail closed', async t => {
  const root = temporaryRoot(t, 'essayflow-secrets-future-');
  const filePath = path.join(root, 'credentials', 'provider-credentials.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, credentials: {}, futureCipherSuite: 'v2' }));
  const future = new SecretStore(root, fakeSafeStorage());
  assert.equal(future.readOnly, true);
  assert.equal(future.readEnvelopeSync().futureCipherSuite, 'v2');
  assert.equal(future.credentialStatus('deepseek', { required: true }), CREDENTIAL_STATUS.NEEDS_REENTRY);
  await assert.rejects(future.setCredential('deepseek', 'secret'), errorCode(ERROR_CODES.READ_ONLY));

  const invalidRoot = temporaryRoot(t, 'essayflow-secrets-invalid-');
  const invalidPath = path.join(invalidRoot, 'credentials', 'provider-credentials.json');
  fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
  fs.writeFileSync(invalidPath, JSON.stringify({
    schemaVersion: 1,
    credentials: {
      custom: {
        schemaVersion: 1,
        providerId: 'custom',
        storage: 'plain',
        encoding: 'utf8',
        plainText: 'must-never-be-accepted'
      }
    }
  }));
  assert.throws(() => new SecretStore(invalidRoot, fakeSafeStorage()),
    errorCode(ERROR_CODES.SECRET_SCHEMA_INVALID));
});

test('legacy splitter extracts public settings, streams plaintext credentials and redacts returned data', () => {
  const aiSecret = 'legacy-ai-secret-sentinel';
  const searchSecret = 'legacy-search-secret-sentinel';
  const delivered = [];
  const legacy = {
    essay_theme: 'dark',
    essay_horizontal_flex: JSON.stringify({ leftWidth: 260, Authorization: 'legacy-auth-sentinel' }),
    essay_shortcuts: JSON.stringify([{ id: 'save', key: 'Ctrl+S', enabled: true }]),
    essay_default_reference_style: 'APA',
    essay_search_sources: JSON.stringify([
      { id: 'arxiv', enabled: true },
      { id: 'core', enabled: false },
      { id: 'custom_fixture', enabled: true, apiKey: searchSecret }
    ]),
    essay_ai_config: JSON.stringify({
      provider: 'custom',
      base_url: 'https://ai.example.test/v1/chat',
      model: 'fixture-model',
      api_key: aiSecret,
      encryption: 'plain'
    }),
    essay_ai_search_enabled: 'true',
    essay_ai_verify_enabled: 'false'
  };
  const result = splitLegacySettings(legacy, { secretSink: item => delivered.push(item) });
  assert.equal(result.exportableSettings.providerOrigin, 'https://ai.example.test');
  assert.deepEqual(result.exportableSettings.enabledSearchSourceIds, ['arxiv', 'custom_fixture']);
  assert.deepEqual(result.exportableSettings.featureToggles, { aiSearch: true, aiVerify: false });
  assert.equal(result.credentialStatus, CREDENTIAL_STATUS.NEEDS_REENTRY);
  assert.equal(result.deliveredSecretCount, 2);
  assert.deepEqual(delivered.map(item => item.value).sort(), [aiSecret, searchSecret].sort());
  assert.equal(delivered.find(item => item.value === searchSecret).providerId, 'search-source:custom_fixture');

  const serializedResult = JSON.stringify(result);
  const backup = JSON.stringify(createBackupSettingsPayload(result.exportableSettings));
  for (const secret of [aiSecret, searchSecret, 'legacy-auth-sentinel']) {
    assert.equal(serializedResult.includes(secret), false);
    assert.equal(backup.includes(secret), false);
  }
});

test('legacy safeStorage ciphertext is discarded, never exported or treated as plaintext', () => {
  const ciphertext = 'legacy-safe-storage-ciphertext-sentinel';
  let sinkCalls = 0;
  const result = splitLegacySettings({
    essay_ai_config: JSON.stringify({
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      api_key: ciphertext,
      encryption: 'encrypted'
    })
  }, { secretSink: () => { sinkCalls += 1; } });
  assert.equal(sinkCalls, 0);
  assert.equal(result.discardedCiphertextCount, 1);
  assert.equal(JSON.stringify(result).includes(ciphertext), false);
  assert.equal(result.credentialStatus, CREDENTIAL_STATUS.NEEDS_REENTRY);
});

test('generic redaction removes credential keys and credential-bearing header strings', () => {
  const values = ['api-value', 'auth-value', 'header-value', 'safe-storage-value'];
  const result = redactSecrets({
    public: 'kept',
    api_key: values[0],
    nested: {
      Authorization: values[1],
      lines: [`Authorization: Bearer ${values[2]}`, 'ordinary line'],
      safeStorageCiphertext: values[3]
    }
  });
  assert.equal(result.value.public, 'kept');
  assert.equal(result.value.nested.lines.length, 1);
  assert.equal(result.redactedPaths.length, 4);
  const serialized = JSON.stringify(result);
  values.forEach(value => assert.equal(serialized.includes(value), false));
});
