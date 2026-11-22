import git from 'isomorphic-git';
import type { ExerciseConfig } from '@/types';
import { fs, listFilePaths, mkdirp, pathExists, persist, readArtemisMeta, removeRecursive, repoDir, REPO_TYPES, writeFileDeep, type RepoType } from './repoStore';

/*  Local change tracking: every stored repo is a Git repo whose HEAD is the baseline last pulled or written back  */

export type ChangeKind = 'added' | 'modified' | 'deleted';
export type FileChange = { path: string; kind: ChangeKind };
export type CommitAuthor = { name: string; email: string };

export type VariantChanges = {
  repos: Record<RepoType, FileChange[]>;
  problemStatement: boolean;
  count: number;
};

const BASELINE_AUTHOR: CommitAuthor = { name: 'Variants Comparer', email: 'variants-comparer@localhost' };

async function hasHead(dir: string) {
  try {
    await git.resolveRef({ fs, dir, ref: 'HEAD' });
    return true;
  }
  catch {
    return false;
  }
}

async function createBaseline(dir: string) {
  if (await hasHead(dir))
    return;
  await mkdirp(dir);
  await git.init({ fs, dir, defaultBranch: 'main' });
  const paths = await listFilePaths(dir);
  if (paths.length > 0)
    await git.add({ fs, dir, filepath: paths, force: true });
  await git.commit({ fs, dir, message: 'Baseline', author: BASELINE_AUTHOR });
}

/*  Baselines in progress, so a concurrent edit waits instead of being folded into the baseline commit  */
const baselines = new Map<string, Promise<void>>();

/*  Commit the current files of an imported repo (no commit yet) as its baseline; cloned repos already have one  */
export function ensureBaseline(dir: string) {
  let pending = baselines.get(dir);
  if (!pending) {
    pending = createBaseline(dir).finally(() => baselines.delete(dir));
    baselines.set(dir, pending);
  }
  return pending;
}

/*  With ignored files included, statusMatrix would also list the .git directory itself  */
const isGitPath = (path: string) => path === '.git' || path.startsWith('.git/');

/*  Working tree changes against HEAD (ignored files included, as imports may contain them)  */
export async function repoChanges(dir: string): Promise<FileChange[]> {
  if (!(await pathExists(dir)))
    return [];
  await ensureBaseline(dir);
  const matrix = await git.statusMatrix({ fs, dir, ignored: true, filter: (path) => !isGitPath(path) });
  return matrix.flatMap(([ path, head, workdir ]): FileChange[] => {
    if (head === 0 && workdir !== 0)
      return [ { path, kind: 'added' } ];
    if (head === 1 && workdir === 0)
      return [ { path, kind: 'deleted' } ];
    if (head === 1 && workdir === 2)
      return [ { path, kind: 'modified' } ];
    return [];
  });
}

/*  Stage all working tree changes and commit them; returns the new commit or undefined if nothing changed  */
export async function commitAll(dir: string, message: string, author: CommitAuthor = BASELINE_AUTHOR) {
  const changes = await repoChanges(dir);
  if (changes.length === 0)
    return undefined;
  const added = changes.filter((change) => change.kind !== 'deleted').map((change) => change.path);
  if (added.length > 0)
    await git.add({ fs, dir, filepath: added, force: true });
  for (const change of changes.filter((c) => c.kind === 'deleted'))
    await git.remove({ fs, dir, filepath: change.path }); /*  NOSONAR: index updates of one repo must not overlap  */
  const commit = await git.commit({ fs, dir, message, author });
  await persist();
  return commit;
}

export async function readRepoFile(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType, relPath: string) {
  const path = `${repoDir(exercise, variantIndex, repoType)}/${relPath}`;
  return (await pathExists(path)) ? await fs.promises.readFile(path, 'utf8') as string : undefined;
}

/*  Baseline is taken before the first edit, so it reflects the pulled state  */
export async function writeRepoFile(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType, relPath: string, content: string) {
  const dir = repoDir(exercise, variantIndex, repoType);
  await ensureBaseline(dir);
  await writeFileDeep(`${dir}/${relPath}`, content);
  await persist();
}

export async function deleteRepoFile(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType, relPath: string) {
  const dir = repoDir(exercise, variantIndex, repoType);
  await ensureBaseline(dir);
  await removeRecursive(`${dir}/${relPath}`);
  await persist();
}

/*  Restore a file to its baseline (or remove it if it was added)  */
export async function discardFile(exercise: ExerciseConfig, variantIndex: number, repoType: RepoType, relPath: string) {
  const dir = repoDir(exercise, variantIndex, repoType);
  const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: head, filepath: relPath });
    await writeFileDeep(`${dir}/${relPath}`, blob);
  }
  catch (error) {
    if ((error as { code?: string }).code !== 'NotFoundError')
      throw error;
    await removeRecursive(`${dir}/${relPath}`);
  }
  await persist();
}

export async function variantChanges(exercise: ExerciseConfig, variantIndex: number): Promise<VariantChanges> {
  const changeLists = await Promise.all(REPO_TYPES.map((repoType) => repoChanges(repoDir(exercise, variantIndex, repoType))));
  const repos = Object.fromEntries(REPO_TYPES.map((repoType, idx) => [ repoType, changeLists[idx]! ])) as Record<RepoType, FileChange[]>;
  const meta = await readArtemisMeta(exercise, variantIndex);
  const problemStatement = meta !== undefined && (exercise.variants[variantIndex]?.markdown ?? '') !== meta.problemStatement;
  const count = REPO_TYPES.reduce((sum, repoType) => sum + repos[repoType].length, problemStatement ? 1 : 0);
  return { repos, problemStatement, count };
}

/*  Number of pending (not yet written back) changes of all variants of an exercise  */
export async function exerciseChangeCount(exercise: ExerciseConfig) {
  const changes = await Promise.all(exercise.variants.map((_, index) => variantChanges(exercise, index)));
  return changes.reduce((sum, variant) => sum + variant.count, 0);
}

/*  Remote a cloned repo pushes to; undefined for imported repos  */
export async function repoRemoteUrl(dir: string) {
  if (!(await pathExists(`${dir}/.git`)))
    return undefined;
  return await git.getConfig({ fs, dir, path: 'remote.origin.url' }) as string | undefined;
}
