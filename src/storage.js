import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(path, value) {
  return writeText(path, JSON.stringify(value, null, 2) + '\n');
}
export async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx');
    try { await file.writeFile(value); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function withLock(path, action) {
  await mkdir(dirname(path), { recursive: true });
  let lock;
  try { lock = await open(`${path}.lock`, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Уже идёт запуск; дождитесь его завершения'); throw error; }
  try { return await action(); }
  finally { await lock.close(); await unlink(`${path}.lock`); }
}
