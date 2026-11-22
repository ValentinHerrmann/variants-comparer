import { clone } from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import type { DownloadResult, ExerciseConfig } from '@/types';
import { getProxyBase } from './config';
import { fs, mkdirp, removeRecursive, repoDir, REPO_TYPES } from './repoStore';

/*  Split "https://user:token@host/repo.git" into a credential-free URL and its credentials  */
function splitCredentials(raw: string) {
  const url = new URL(raw);
  const auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  url.username = '';
  url.password = '';
  return { url: url.toString(), auth: auth.username || auth.password ? auth : undefined };
}

async function cloneRepository(rawUrl: string, dir: string) {
  const { url, auth } = splitCredentials(rawUrl);
  const proxyBase = getProxyBase();
  const corsProxy = proxyBase ? `${proxyBase}/git-proxy` : undefined;
  await removeRecursive(dir);
  await mkdirp(dir);
  await clone({
    fs,
    http,
    dir,
    url,
    corsProxy,
    depth: 1,
    singleBranch: true,
    noTags: true,
    onAuth: auth ? () => auth : undefined,
  });
}

/*  Repositories of URL-mode variants that have a URL configured  */
export function cloneJobs(exercise: ExerciseConfig) {
  return exercise.variants.flatMap((variant, index) => (variant.source === 'artemis' ? [] : REPO_TYPES)
    .map((repoType) => ({ variant, index, repoType, url: variant[`${repoType}Repo`].trim() }))
    .filter((job) => job.url));
}

/*  Clone all configured repositories of an exercise into the browser file system  */
export async function cloneExercise(exercise: ExerciseConfig, onProgress?: (done: number, total: number) => void) {
  const jobs = cloneJobs(exercise);
  const events: DownloadResult[] = [];
  let done = 0;
  for (const job of jobs) {
    const destination = repoDir(exercise, job.index, job.repoType);
    const event = { variant: job.variant.label, repoType: job.repoType, destination };
    try {
      await cloneRepository(job.url, destination);
      events.push({ ...event, success: true, message: 'Cloned successfully' });
    }
    catch (error) {
      events.push({ ...event, success: false, message: (error as Error).message });
    }
    onProgress?.(++done, jobs.length);
  }
  return events;
}
