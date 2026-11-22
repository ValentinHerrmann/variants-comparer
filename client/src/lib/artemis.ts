import { strFromU8, unzipSync } from 'fflate';
import type { ExerciseConfig } from '@/types';
import { getArtemisToken, getProxyBase } from './config';
import { importZipBytes } from './importer';
import type { RepoType } from './repoStore';

/*  Artemis "export-instructor-exercise" ZIP: Problem-Statement-*.md, Exercise-Details-*.json and a nested
    <course>-<title>-<id>-<timestamp>.zip holding <course>-<title>-{exercise,solution,tests}.zip repositories
    (see Artemis ProgrammingExerciseExportService); nested ZIPs are searched recursively like Artemis does on import  */
const ARTEMIS_REPO_SUFFIXES: Array<[ string, RepoType ]> = [ [ '-exercise', 'template' ], [ '-solution', 'solution' ], [ '-tests', 'test' ] ];
const MAX_ZIP_DEPTH = 3;

export type ArtemisExport = {
  title?: string;
  problemStatement?: string;
  repos: Partial<Record<RepoType, Uint8Array>>;
};

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function collectArtemisEntries(bytes: Uint8Array, result: ArtemisExport, depth: number) {
  const entries = Object.entries(unzipSync(bytes)).filter(([ p ]) => !p.endsWith('/') && !p.includes('__MACOSX'));
  for (const [ path, data ] of entries) {
    const name = baseName(path);
    if (name.toLowerCase().endsWith('.zip')) {
      const match = ARTEMIS_REPO_SUFFIXES.find(([ suffix ]) => name.slice(0, -4).endsWith(suffix));
      if (match)
        result.repos[match[1]] ??= data;
      else if (depth < MAX_ZIP_DEPTH)
        collectArtemisEntries(data, result, depth + 1);
    }
    else if (name.startsWith('Problem-Statement') && name.endsWith('.md'))
      result.problemStatement = strFromU8(data);
    else if (name.startsWith('Exercise-Details') && name.endsWith('.json')) {
      try {
        const details = JSON.parse(strFromU8(data)) as { title?: string; problemStatement?: string };
        result.title = details.title;
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

export async function fetchArtemisExport(input: string): Promise<Uint8Array> {
  const exportUrl = toArtemisExportUrl(input);
  const token = getArtemisToken();
  if (!token)
    throw new Error('Please enter your Artemis token first.');
  const proxyBase = getProxyBase();
  const target = proxyBase ? `${proxyBase}/artemis-proxy/${exportUrl.host}${exportUrl.pathname}` : exportUrl.toString();
  const response = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401 || response.status === 403)
    throw new Error(`Artemis rejected the request (${response.status}): token expired or no instructor access.`);
  if (!response.ok)
    throw new Error(`Artemis export failed (${response.status} ${response.statusText}).`);
  return new Uint8Array(await response.arrayBuffer());
}

/*  Replace a variant's repositories with those of a parsed Artemis export  */
export async function importArtemisExport(exercise: ExerciseConfig, variantIndex: number, parsed: ArtemisExport) {
  const imported: RepoType[] = [];
  for (const [ repoType, repoBytes ] of Object.entries(parsed.repos) as Array<[ RepoType, Uint8Array ]>) {
    await importZipBytes(exercise, variantIndex, repoType, repoBytes);
    imported.push(repoType);
  }
  return imported;
}
