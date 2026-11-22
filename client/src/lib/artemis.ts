import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import git from 'isomorphic-git';
import { merge } from 'node-diff3';
import type { ExerciseConfig } from '@/types';
import { variantChanges } from './changes';
import { getArtemisToken, getProxyBase } from './config';
import { commonRoot, importZipBytes, replaceRepo, repoZipEntries, zipRepo } from './importer';
import { fs, readArtemisExportBytes, readArtemisMeta, repoDir, REPO_TYPES, writeArtemisMeta, type ArtemisMeta, type RepoType } from './repoStore';

/*  Artemis "export-instructor-exercise" ZIP: Problem-Statement-*.md, Exercise-Details-*.json and a nested
    <course>-<title>-<id>-<timestamp>.zip holding <course>-<title>-{exercise,solution,tests}.zip repositories
    (see Artemis ProgrammingExerciseExportService); nested ZIPs are searched recursively like Artemis does on import  */
const ARTEMIS_REPO_SUFFIXES: Array<[ string, RepoType ]> = [ [ '-exercise', 'template' ], [ '-solution', 'solution' ], [ '-tests', 'test' ] ];
const MAX_ZIP_DEPTH = 3;

export type ArtemisExport = {
  title?: string;
  exerciseId?: number;
  problemStatement?: string;
  repos: Partial<Record<RepoType, Uint8Array>>;
};

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const repoTypeOfZip = (name: string) => ARTEMIS_REPO_SUFFIXES.find(([ suffix ]) => name.slice(0, -4).endsWith(suffix))?.[1];
const isProblemStatement = (name: string) => name.startsWith('Problem-Statement') && name.endsWith('.md');
const isExerciseDetails = (name: string) => name.startsWith('Exercise-Details') && name.endsWith('.json');
const isZip = (name: string) => name.toLowerCase().endsWith('.zip');

function collectArtemisEntries(bytes: Uint8Array, result: ArtemisExport, depth: number) {
  const entries = Object.entries(unzipSync(bytes)).filter(([ p ]) => !p.endsWith('/') && !p.includes('__MACOSX'));
  for (const [ path, data ] of entries) {
    const name = baseName(path);
    if (isZip(name)) {
      const repoType = repoTypeOfZip(name);
      if (repoType)
        result.repos[repoType] ??= data;
      else if (depth < MAX_ZIP_DEPTH)
        collectArtemisEntries(data, result, depth + 1);
    }
    else if (isProblemStatement(name))
      result.problemStatement = strFromU8(data);
    else if (isExerciseDetails(name)) {
      try {
        const details = JSON.parse(strFromU8(data)) as { id?: number; title?: string; problemStatement?: string };
        result.title = details.title;
        result.exerciseId = details.id;
        result.problemStatement ??= details.problemStatement;
      }
      catch {
        /*  details are optional  */
      }
    }
  }
}

export function parseArtemisExport(bytes: Uint8Array): ArtemisExport {
  const result: ArtemisExport = { repos: {} };
  collectArtemisEntries(bytes, result, 0);
  if (Object.keys(result.repos).length === 0)
    throw new Error('Not an Artemis exercise export: no *-exercise.zip, *-solution.zip or *-tests.zip found.');
  return result;
}

/*  Accept an export URL or any Artemis URL containing /programming-exercises/<id>  */
export function toArtemisExportUrl(input: string): URL {
  const url = new URL(input.trim());
  const id = url.pathname.match(/\/programming-exercises\/(\d+)/)?.[1];
  if (!id)
    throw new Error('Artemis URL must contain /programming-exercises/<id>.');
  return new URL(`/api/programming/programming-exercises/${id}/export-instructor-exercise`, url.origin);
}

/*  Call the Artemis REST API with the session token, through /artemis-proxy if configured  */
async function artemisFetch(host: string, pathAndQuery: string, init: RequestInit = {}) {
  const token = getArtemisToken();
  if (!token)
    throw new Error('Please enter your Artemis token first.');
  const proxyBase = getProxyBase();
  const target = proxyBase ? `${proxyBase}/artemis-proxy/${host}${pathAndQuery}` : `https://${host}${pathAndQuery}`;
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(target, { ...init, headers });
  if (response.status === 401 || response.status === 403)
    throw new Error(`Artemis rejected the request (${response.status}): token expired or missing editor/instructor rights.`);
  if (!response.ok)
    throw new Error(`Artemis request ${init.method ?? 'GET'} ${pathAndQuery} failed (${response.status} ${response.statusText}): ${(await response.text()).slice(0, 300)}`);
  return response;
}

export async function fetchArtemisExport(input: string): Promise<Uint8Array> {
  const exportUrl = toArtemisExportUrl(input);
  const response = await artemisFetch(exportUrl.host, exportUrl.pathname);
  return new Uint8Array(await response.arrayBuffer());
}

/*  Replace a variant's repositories with those of a parsed Artemis export and remember its origin for write-back  */
export async function importArtemisExport(exercise: ExerciseConfig, variantIndex: number, bytes: Uint8Array, parsed: ArtemisExport, sourceUrl?: string) {
  const imported: RepoType[] = [];
  for (const [ repoType, repoBytes ] of Object.entries(parsed.repos) as Array<[ RepoType, Uint8Array ]>) {
    await importZipBytes(exercise, variantIndex, repoType, repoBytes);
    imported.push(repoType);
  }
  const exportUrl = sourceUrl ? toArtemisExportUrl(sourceUrl) : undefined;
  const meta: ArtemisMeta = {
    via: exportUrl ? 'api' : 'zip',
    host: exportUrl?.host,
    exerciseId: Number(exportUrl?.pathname.match(/\/programming-exercises\/(\d+)/)?.[1] ?? parsed.exerciseId) || undefined,
    problemStatement: parsed.problemStatement ?? '',
  };
  await writeArtemisMeta(exercise, variantIndex, meta, bytes);
  return imported;
}

/*  Rebuild a ZIP level of the stored export: repo ZIPs get the current working trees (below their original root
    folder, without .git, which Artemis skips on import anyway), the problem statement gets the current text  */
async function rebuildExportLevel(exercise: ExerciseConfig, variantIndex: number, bytes: Uint8Array, problemStatement: string, depth: number): Promise<ReturnType<typeof zipSync>> {
  const rebuilt: Record<string, Uint8Array> = {};
  for (const [ path, data ] of Object.entries(unzipSync(bytes))) {
    const name = baseName(path);
    const repoType = isZip(name) ? repoTypeOfZip(name) : undefined;
    if (repoType)
      rebuilt[path] = await zipRepo(exercise, variantIndex, repoType, commonRoot(Object.keys(unzipSync(data))));
    else if (isZip(name) && depth < MAX_ZIP_DEPTH)
      rebuilt[path] = await rebuildExportLevel(exercise, variantIndex, data, problemStatement, depth + 1);
    else if (isProblemStatement(name))
      rebuilt[path] = strToU8(problemStatement);
    else if (isExerciseDetails(name)) {
      try {
        rebuilt[path] = strToU8(JSON.stringify({ ...JSON.parse(strFromU8(data)), problemStatement }, null, 2));
      }
      catch {
        rebuilt[path] = data;
      }
    }
    else
      rebuilt[path] = data;
  }
  return zipSync(rebuilt);
}

/*  Artemis export ZIP of a variant with all local edits, for "Import from file" in Artemis (creates a new exercise)  */
export async function buildArtemisZip(exercise: ExerciseConfig, variantIndex: number) {
  const bytes = await readArtemisExportBytes(exercise, variantIndex);
  if (!bytes)
    throw new Error('The original Artemis export is not stored; re-import the variant from Artemis first.');
  return rebuildExportLevel(exercise, variantIndex, bytes, exercise.variants[variantIndex]?.markdown ?? '', 0);
}

/*  Three-way line merge of a local and a server change against their common baseline; undefined on conflict  */
export function mergeText(local: string, base: string, server: string) {
  const { conflict, result } = merge(local.split('\n'), base.split('\n'), server.split('\n'), { excludeFalseConflicts: true });
  return conflict ? undefined : result.join('\n');
}

/*  What to write for a locally changed file, given its baseline and current server version (undefined = absent)  */
export type WriteDecision = { action: 'skip' } | { action: 'conflict' } | { action: 'delete' } | { action: 'create' | 'update'; content: string };

export function decideWrite(base: string | undefined, local: string | undefined, server: string | undefined): WriteDecision {
  let target = local;
  if (server === local)
    return { action: 'skip' };
  if (server !== base) {
    const merged = base !== undefined && local !== undefined && server !== undefined ? mergeText(local, base, server) : undefined;
    if (merged === undefined)
      return { action: 'conflict' };
    target = merged;
  }
  if (target === undefined)
    return server === undefined ? { action: 'skip' } : { action: 'delete' };
  return { action: server === undefined ? 'create' : 'update', content: target };
}

type RepoPlan = { creates: Array<[ string, string ]>; updates: Array<[ string, string ]>; deletes: string[] };

async function baselineFile(dir: string, filepath: string) {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid: await git.resolveRef({ fs, dir, ref: 'HEAD' }), filepath });
    return strFromU8(blob);
  }
  catch {
    return undefined;
  }
}

type Participations = { templateParticipation?: { id: number }; solutionParticipation?: { id: number } };

/*  Write all pending edits of an Artemis variant back via the Artemis online-editor REST API. The current server
    state is fetched first; server changes since the import are merged, any conflict aborts before writing.
    Returns the problem statement now stored in Artemis  */
export async function writeToArtemis(exercise: ExerciseConfig, variantIndex: number) {
  const meta = await readArtemisMeta(exercise, variantIndex);
  if (meta?.via !== 'api' || !meta.host || !meta.exerciseId)
    throw new Error('Only variants loaded from Artemis by URL can be written back to Artemis.');
  const { host, exerciseId } = meta;
  const changes = await variantChanges(exercise, variantIndex);
  const serverBytes = await fetchArtemisExport(`https://${host}/api/programming/programming-exercises/${exerciseId}`);
  const server = parseArtemisExport(serverBytes);

  const conflicts: string[] = [];
  const plans = {} as Record<RepoType, RepoPlan>;
  const serverFiles = {} as Record<RepoType, Map<string, Uint8Array>>;
  for (const repoType of REPO_TYPES) {
    const plan: RepoPlan = { creates: [], updates: [], deletes: [] };
    plans[repoType] = plan;
    const serverRepo = server.repos[repoType];
    serverFiles[repoType] = new Map(serverRepo ? repoZipEntries(serverRepo) : []);
    const dir = repoDir(exercise, variantIndex, repoType);
    for (const change of changes.repos[repoType]) {
      const serverFile = serverFiles[repoType].get(change.path);
      const local = change.kind === 'deleted' ? undefined : await fs.promises.readFile(`${dir}/${change.path}`, 'utf8') as string;
      const decision = decideWrite(await baselineFile(dir, change.path), local, serverFile && strFromU8(serverFile));
      if (decision.action === 'conflict')
        conflicts.push(`${repoType}/${change.path}`);
      else if (decision.action === 'delete')
        plan.deletes.push(change.path);
      else if (decision.action !== 'skip')
        (decision.action === 'create' ? plan.creates : plan.updates).push([ change.path, decision.content ]);
    }
  }
  const psDecision = changes.problemStatement
    ? decideWrite(meta.problemStatement, exercise.variants[variantIndex]?.markdown ?? '', server.problemStatement ?? '')
    : { action: 'skip' as const };
  if (psDecision.action === 'conflict')
    conflicts.push('problem statement');
  if (conflicts.length > 0)
    throw new Error(`Changes made in Artemis since the import conflict with your edits in: ${conflicts.join(', ')}. Nothing was written; your edits stay pending.`);

  const participations = await (await artemisFetch(host,
    `/api/programming/programming-exercises/${exerciseId}/with-template-and-solution-participation?withSubmissionResults=false&withGradingCriteria=false`)).json() as Participations;
  const repoBase: Record<RepoType, string | undefined> = {
    template: participations.templateParticipation && `/api/programming/participations/${participations.templateParticipation.id}/repository`,
    solution: participations.solutionParticipation && `/api/programming/participations/${participations.solutionParticipation.id}/repository`,
    test: `/api/programming/programming-exercises/${exerciseId}/test-repository`,
  };
  const text = { 'content-type': 'text/plain' };
  for (const repoType of REPO_TYPES) {
    const { creates, updates, deletes } = plans[repoType];
    if (creates.length + updates.length + deletes.length === 0)
      continue;
    const base = repoBase[repoType];
    if (!base)
      throw new Error(`Artemis returned no ${repoType} participation for exercise ${exerciseId}.`);
    for (const [ path, content ] of creates)
      await artemisFetch(host, `${base}/file?file=${encodeURIComponent(path)}`, { method: 'POST', headers: text, body: content });
    if (updates.length > 0)
      await artemisFetch(host, `${base}/files?commit=false`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updates.map(([ fileName, fileContent ]) => ({ fileName, fileContent }))),
      });
    for (const path of deletes)
      await artemisFetch(host, `${base}/file?file=${encodeURIComponent(path)}`, { method: 'DELETE' });
    await artemisFetch(host, `${base}/commit`, { method: 'POST' });
  }
  let problemStatement = server.problemStatement ?? '';
  if (psDecision.action === 'update' || psDecision.action === 'create') {
    problemStatement = psDecision.content;
    await artemisFetch(host, `/api/programming/programming-exercises/${exerciseId}/problem-statement`, {
      method: 'PATCH',
      headers: text,
      body: problemStatement || ' ',
    });
  }

  /*  Local repos now mirror the server: its state plus what was just written, committed as the new baseline  */
  for (const repoType of REPO_TYPES) {
    if (!server.repos[repoType])
      continue;
    const files = serverFiles[repoType];
    for (const [ path, content ] of [ ...plans[repoType].creates, ...plans[repoType].updates ])
      files.set(path, strToU8(content));
    for (const path of plans[repoType].deletes)
      files.delete(path);
    await replaceRepo(repoDir(exercise, variantIndex, repoType), [ ...files ]);
  }
  await writeArtemisMeta(exercise, variantIndex, { ...meta, problemStatement }, serverBytes);
  return problemStatement;
}
