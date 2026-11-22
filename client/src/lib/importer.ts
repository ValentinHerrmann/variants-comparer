import { unzipSync } from 'fflate';
import type { ExerciseConfig } from '@/types';
import { exerciseDir, removeRecursive, repoDir, writeFileDeep, type RepoType } from './repoStore';

const ignoredPath = /(^|\/)(\.git|node_modules|__MACOSX)(\/|$)/;

/*  Single top-level folder shared by all entries (as in GitHub/GitLab archives), else empty  */
function commonRoot(paths: string[]) {
  const first = paths[0]?.split('/')[0];
  return first && paths.every((p) => p.startsWith(`${first}/`)) ? `${first}/` : '';
}

async function replaceRepo(dir: string, entries: Array<[ string, Uint8Array ]>) {
  await removeRecursive(dir);
  for (const [ relPath, data ] of entries)
    await writeFileDeep(`${dir}/${relPath}`, data);
  return entries.length;
}

/*  Import files picked via <input webkitdirectory> (paths start with the picked folder) as a repository  */
export async function importFolder(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType, files: FileList) {
  const entries = await Promise.all(Array.from(files)
    .map((file) => ({ file, relPath: file.webkitRelativePath.split('/').slice(1).join('/') || file.name }))
    .filter(({ relPath }) => !ignoredPath.test(relPath))
    .map(async ({ file, relPath }): Promise<[ string, Uint8Array ]> => [ relPath, new Uint8Array(await file.arrayBuffer()) ]));
  return replaceRepo(repoDir(exercise, variantIndex, repoType), entries);
}

/*  Import ZIP archive bytes as a repository (root is detected before dropping .git, so a repo with one top folder stays intact)  */
export async function importZipBytes(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType, bytes: Uint8Array) {
  const unzipped = unzipSync(bytes);
  const root = commonRoot(Object.keys(unzipped));
  const entries = Object.entries(unzipped)
    .map(([ p, data ]): [ string, Uint8Array ] => [ p.slice(root.length), data ])
    .filter(([ p ]) => p && !p.endsWith('/') && !ignoredPath.test(p));
  return replaceRepo(repoDir(exercise, variantIndex, repoType), entries);
}

export async function importZip(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType, file: File) {
  return importZipBytes(exercise, variantIndex, repoType, new Uint8Array(await file.arrayBuffer()));
}

/*  Delete all downloaded/imported repositories of an exercise  */
export async function clearExerciseRepos(exercise: ExerciseConfig) {
  await removeRecursive(exerciseDir(exercise));
}
