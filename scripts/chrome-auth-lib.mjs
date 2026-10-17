import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export function tokenExpiry(auth, now = Date.now()) {
  if (typeof auth !== 'string') return null;
  const parts = auth.replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const { exp } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const ms = exp * 1000;
    return typeof exp === 'number' && Number.isFinite(ms) && ms > now + 60_000 && ms <= 8.64e15 ? ms : null;
  } catch { return null; }
}

export function validateCredentials(message, now = Date.now()) {
  if (!message || message.type !== 'credentials') throw new Error('Invalid credential message.');
  const { auth, userToken, deviceId } = message;
  if (Object.keys(message).some(k => !['type', 'auth', 'userToken', 'deviceId'].includes(k))) {
    throw new Error('Unexpected credential fields.');
  }
  if (typeof auth !== 'string' || auth.length > 8192 || !/^Bearer [A-Za-z0-9_.-]+$/i.test(auth)) {
    throw new Error('Invalid bearer token.');
  }
  const expiresAt = tokenExpiry(auth, now);
  if (!expiresAt) throw new Error('Token is invalid, expired, or expires within a minute. Reload Plaud.');
  // No whitespace, quotes, comments, newlines or dotenv syntax from headers.
  for (const value of [userToken, deviceId]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 8192 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(value)) {
      throw new Error('Invalid session headers.');
    }
  }
  if (userToken.length < 10) throw new Error('Invalid session headers.');
  return { values: { PLAUD_AUTH: auth, PLAUD_USER_TOKEN: userToken, PLAUD_DEVICE_ID: deviceId }, expiresAt };
}

export function mergeCredentials(before, values) {
  let after = before;
  for (const [key, value] of Object.entries(values)) {
    let found = false;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    after = after.split('\n').map(line => {
      if (!pattern.test(line)) return line;
      found = true;
      // Replace duplicates too: dotenv's last assignment wins.
      return `${key}=${value}`;
    }).join('\n');
    if (!found) after = after.replace(/\n*$/, '') + (after ? '\n' : '') + `${key}=${value}\n`;
  }
  return after;
}

// Fixed destination from the installed launcher, never a path from Chrome.
// The lock also serializes helpers from multiple Chrome profiles/processes.
export function saveCredentials(envPath, message, now = Date.now()) {
  const { values, expiresAt } = validateCredentials(message, now);
  const lockPath = `${envPath}.chrome-lock`;
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch { throw new Error('Credential file is busy. Reload Plaud to retry.'); }
  const temporary = join(dirname(envPath), `.env.chrome-${randomUUID()}.tmp`);
  let fd;
  try {
    let before = '';
    let existing;
    try { existing = lstatSync(envPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      // O_NOFOLLOW rejects a symlink swapped in between existence and open.
      fd = openSync(envPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1) throw new Error('Unsafe credential file.');
      before = readFileSync(fd, 'utf8');
      closeSync(fd); fd = undefined;
    }
    const after = mergeCredentials(before, values);
    if (before !== after) {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, after);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, envPath);
    } else {
      fd = openSync(envPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      fchmodSync(fd, 0o600);
      closeSync(fd); fd = undefined;
    }
    return { ok: true, expiresAt: new Date(expiresAt).toISOString() };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  // Chrome uses native-endian uint32; supported macOS machines are little-endian.
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export async function readMessage(input) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) continue;
    const length = buffer.readUInt32LE(0);
    if (length < 2 || length > 32_768) throw new Error('Invalid native message length.');
    if (buffer.length >= length + 4) {
      if (buffer.length !== length + 4) throw new Error('Unexpected trailing message data.');
      return JSON.parse(buffer.subarray(4).toString('utf8'));
    }
  }
  throw new Error('Incomplete native message.');
}
