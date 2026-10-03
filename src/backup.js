const { validateData } = require('./model');

// One limit for both directions: every successful JSON export is importable.
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

function checkBackupSize(size) {
  if (size > MAX_BACKUP_BYTES) throw new Error('The backup exceeds the 100 MiB backup limit.');
}

/** @param {import('./types').ActivityData} data */
function encodeBackup(data) {
  const content = Buffer.from(JSON.stringify(validateData(data)), 'utf8');
  checkBackupSize(content.byteLength);
  return content;
}

/** @param {Uint8Array} bytes */
function decodeBackup(bytes) {
  checkBackupSize(bytes.byteLength);
  return validateData(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

module.exports = { MAX_BACKUP_BYTES, checkBackupSize, encodeBackup, decodeBackup };
