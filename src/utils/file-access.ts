/** Remote CRM authorization grants access only to the dedicated exchange directory. */
import { realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ServiceContainer } from '../tools/init-tool.js';
import { getRequestAuth } from '../auth/request-context.js';
import { BpmApiError } from './errors.js';

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path);
}
async function remotePath(services: ServiceContainer, path: string, reading: boolean): Promise<string> {
  const configured = resolve(services.config.file_root ?? './files');
  if (dirname(configured) === configured)
    throw new BpmApiError('BPMSOFT_FILE_ROOT не может быть корнем файловой системы.', 400);
  const lexicalTarget = isAbsolute(path) ? resolve(path) : resolve(configured, path);
  if (!contained(configured, lexicalTarget) || lexicalTarget === configured)
    throw new BpmApiError(
      'Путь вне каталога обмена файлами BPMSOFT_FILE_ROOT запрещён для HTTP-клиента.',
      403
    );
  let root: string;
  try {
    root = await realpath(configured);
  } catch {
    throw new BpmApiError(
      'Каталог обмена BPMSOFT_FILE_ROOT не существует или недоступен. Администратор должен подготовить его на MCP-сервере.',
      400
    );
  }
  let target: string;
  try {
    target = reading
      ? await realpath(lexicalTarget)
      : resolve(await realpath(dirname(lexicalTarget)), basename(lexicalTarget));
  } catch {
    throw new BpmApiError('Файл или каталог сохранения недоступен внутри BPMSOFT_FILE_ROOT.', 404);
  }
  if (!contained(root, target) || target === root)
    throw new BpmApiError('Ссылка за пределы каталога обмена запрещена для HTTP-клиента.', 403);
  return target;
}

export async function uploadPath(services: ServiceContainer, path: string): Promise<string> {
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
