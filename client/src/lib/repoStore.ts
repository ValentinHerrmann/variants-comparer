import LightningFS from '@isomorphic-git/lightning-fs';
import type { ExerciseConfig } from '@/types';

/*  IndexedDB-backed file system holding all cloned/imported repositories  */
export const fs = new LightningFS('variants-comparer');
const pfs = fs.promises;

export type RepoType = 'test' | 'solution' | 'template';
export const REPO_TYPES: RepoType[] = [ 'test', 'solution', 'template' ];

const ignoredDirs = new Set([ '.git', 'node_modules' ]);

export function slugify(input: string, fallback: string) {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function exerciseDir(exercise: ExerciseConfig) {
  return `/${slugify(exercise.exerciseName, 'exercise')}`;
}

export function variantDir(exercise: ExerciseConfig, variantIndex: number) {
  const variant = exercise.variants[variantIndex];
  return `${exerciseDir(exercise)}/${slugify(variant?.label ?? '', `variant-${variantIndex + 1}`)}`;
}

export function repoDir(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType) {
  return `${variantDir(exercise, variantIndex)}/${repoType}`;
}

export async function pathExists(filepath: string) {
  try {
    await pfs.stat(filepath);
    return true;
  }
  catch {
    return false;
  }
}

export async function mkdirp(dir: string) {
  let current = '';
  for (const part of dir.split('/').filter(Boolean)) {
    current += `/${part}`;
    if (!(await pathExists(current)))
      await pfs.mkdir(current);
  }
}

export async function removeRecursive(target: string) {
  let stat;
  try {
    stat = await pfs.lstat(target);
  }
  catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of await pfs.readdir(target))
      await removeRecursive(`${target}/${entry}`);
    await pfs.rmdir(target);
  }
  else
    await pfs.unlink(target);
}

export async function writeFileDeep(filepath: string, data: Uint8Array | string) {
  await mkdirp(filepath.slice(0, filepath.lastIndexOf('/')));
  await pfs.writeFile(filepath, data);
}

/*  Read all files below dir as UTF-8 text, keyed by path relative to dir  */
export async function readFilesRecursive(dir: string, baseDir = dir): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of await pfs.readdir(dir)) {
    if (ignoredDirs.has(name))
      continue;
    const fullPath = `${dir}/${name}`;
    const stat = await pfs.stat(fullPath);
    if (stat.isDirectory()) {
      const child = await readFilesRecursive(fullPath, baseDir);
      child.forEach((content, relPath) => files.set(relPath, content));
    }
    else if (stat.isFile())
      files.set(fullPath.slice(baseDir.length + 1), await pfs.readFile(fullPath, 'utf8'));
  }
  return files;
}

/*  Read a repo of an exercise variant, or undefined if it was never downloaded/imported  */
export async function readRepo(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType) {
  const dir = repoDir(exercise, variantIndex, repoType);
  return (await pathExists(dir)) ? readFilesRecursive(dir) : undefined;
}

/*  Count files below dir (ignoring .git / node_modules) without reading their content  */
async function countFiles(dir: string): Promise<number> {
  let count = 0;
  for (const name of await pfs.readdir(dir)) {
    if (ignoredDirs.has(name))
      continue;
    const stat = await pfs.stat(`${dir}/${name}`);
    count += stat.isDirectory() ? await countFiles(`${dir}/${name}`) : 1;
  }
  return count;
}

/*  File counts of all stored repositories of an exercise (undefined = not stored)  */
export type RepoStatus = Array<Record<RepoType, number | undefined>>;

export async function getRepoStatus(exercise: ExerciseConfig): Promise<RepoStatus> {
  return Promise.all(exercise.variants.map(async (_, index) => {
    const counts = {} as Record<RepoType, number | undefined>;
    for (const repoType of REPO_TYPES) {
      const dir = repoDir(exercise, index, repoType);
      counts[repoType] = (await pathExists(dir)) ? await countFiles(dir) : undefined;
    }
    return counts;
  }));
}

export async function removeRepo(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType) {
  await removeRecursive(repoDir(exercise, variantIndex, repoType));
}

/*  Move a stored directory (e.g. after renaming an exercise or variant); refuses to overwrite  */
export async function moveDir(from: string, to: string) {
  if (from === to || !(await pathExists(from)))
    return;
  if (await pathExists(to))
    throw new Error(`Repositories already exist at ${to}.`);
  await mkdirp(to.slice(0, to.lastIndexOf('/')));
  await pfs.rename(from, to);
}
