/** HTTP callers exchange files only in their verified BPMSoft user/tenant namespace. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ServiceContainer } from '../tools/init-tool.js';
import { getRequestAuth, hasRequestAuth } from '../auth/request-context.js';
import { BpmApiError } from './errors.js';
import { tenantStorageScope, userStorageScope } from './tenant-scope.js';

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
}
/** Only server-derived hash directories are created; never arbitrary caller paths. */
async function privateDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isDirectory() || (await realpath(path)) !== path)
      throw new Error('Unsafe namespace directory');
    await handle.chmod(0o700);
  } catch {
    throw new BpmApiError('Каталог пользователя недоступен или заменён символической ссылкой.', 403);
  } finally {
    await handle?.close();
  }
  return path;
}

async function userDirectory(services: ServiceContainer): Promise<string> {
  if (!hasRequestAuth(getRequestAuth()))
    throw new BpmApiError('Для обмена файлами нужна актуальная сессия BPMSoft.', 401);
  const configured = resolve(services.config.file_root ?? './files');
  if (dirname(configured) === configured)
    throw new BpmApiError('BPMSOFT_FILE_ROOT не может быть корнем файловой системы.', 400);
  let root: string;
  try {
    root = await realpath(configured);
  } catch {
    throw new BpmApiError(
      'Каталог обмена BPMSOFT_FILE_ROOT не существует или недоступен. Администратор должен подготовить его на MCP-сервере.',
      400
    );
  }
  if (dirname(root) === root)
    throw new BpmApiError('BPMSOFT_FILE_ROOT не может ссылаться на корень файловой системы.', 400);
  // Identity comes from BPMSoft's current-user macro, never an incoming ID or cookie hash.
  const user = await services.currentUser.get();
  const userScope = userStorageScope(user.userId);
  const tenant = await privateDirectory(root, tenantStorageScope(services.config));
  return privateDirectory(tenant, userScope);
}

async function remotePath(services: ServiceContainer, path: string, reading: boolean): Promise<string> {
  const root = await userDirectory(services);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!contained(root, target) || target === root)
    throw new BpmApiError('Путь вне личного каталога пользователя BPMSoft запрещён.', 403);
  try {
    // Reject intermediate symlinks too, even when they happen to resolve inside this namespace.
    if ((await realpath(dirname(target))) !== dirname(target))
      throw new BpmApiError('Символические ссылки в личном каталоге запрещены.', 403);
    try {
      const entry = await lstat(target);
      if (entry.isSymbolicLink())
        throw new BpmApiError('Символические ссылки в личном каталоге запрещены.', 403);
      if (reading && (!entry.isFile() || (await realpath(target)) !== target))
        throw new BpmApiError('file_path должен указывать на обычный файл личного каталога.', 403);
    } catch (error) {
      if (reading || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if (error instanceof BpmApiError) throw error;
    throw new BpmApiError('Файл или каталог сохранения недоступен в личном каталоге.', 404);
  }
  return target;
}

export async function uploadPath(services: ServiceContainer, path: string): Promise<string> {
  if (typeof path !== 'string' || !path.trim())
    throw new BpmApiError('file_path должен быть непустым путём.', 400);
  return getRequestAuth() === undefined ? path : remotePath(services, path, true);
}

export async function saveDownload(services: ServiceContainer, path: string, data: Buffer): Promise<void> {
  if (typeof path !== 'string' || !path.trim())
    throw new BpmApiError('save_path должен быть непустым путём.', 400);
  if (getRequestAuth() === undefined) {
    await writeFile(path, data);
    return;
  }
  const target = await remotePath(services, path, false);
  try {
    await writeFile(target, data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new BpmApiError(
        'Файл уже существует. HTTP-скачивание не перезаписывает файлы; выберите новое имя.',
        409
      );
    throw error;
  }
}
