import { diffChars, diffLines } from 'diff';
import type { LineDiff } from '@/types';

export function computeLineDiff(baseContent: string, variantContent: string): LineDiff[] {
  const changes = diffLines(baseContent, variantContent);
  
  const result: LineDiff[] = [];

  for (const change of changes) {
    const lines = change.value.split('\n').filter((line, idx, arr) => idx < arr.length - 1 || line !== '');
    
    if (!change.added && !change.removed) {
      // Equal lines
      for (const line of lines) {
        result.push({ base: line, variant: line, type: 'equal' });
      }
    } else if (change.removed) {
      // Lines removed from base (present in base, not in variant)
      for (const line of lines) {
        result.push({ base: line, type: 'remove' });
      }
    } else if (change.added) {
      // Lines added in variant (not in base, present in variant)
      for (const line of lines) {
        result.push({ variant: line, type: 'add' });
      }
    }
  }

  // Post-process: pair up remove/add lines that are similar into modify
  // Use a smarter matching algorithm that finds best matches across chunks
  const processed: typeof result = [];
  let i = 0;
  
  while (i < result.length) {
    const current = result[i];
    if (!current) {
      i++;
      continue;
    }
    
    // If it's not a remove line, just add it and continue
    if (current.type !== 'remove') {
      processed.push(current);
      i++;
      continue;
    }
    
    // Found a remove line - collect all consecutive remove lines
    const removeLines: Array<{ index: number; line: typeof current }> = [];
    let j = i;
    while (j < result.length && result[j]?.type === 'remove') {
      removeLines.push({ index: j, line: result[j]! });
      j++;
    }
    
    // Collect all consecutive add lines that follow
    const addLines: Array<{ index: number; line: typeof current }> = [];
    while (j < result.length && result[j]?.type === 'add') {
      addLines.push({ index: j, line: result[j]! });
      j++;
    }
    
    // If we have both removes and adds, find best matches
    if (removeLines.length > 0 && addLines.length > 0) {
      const usedAddIndices = new Set<number>();
      
      // For each remove line, find the best matching add line
      for (const removePair of removeLines) {
        let bestMatch: { addIdx: number; similarity: number } | null = null;
        
        for (let addIdx = 0; addIdx < addLines.length; addIdx++) {
          if (usedAddIndices.has(addIdx)) continue;
          
          const addPair = addLines[addIdx];
          if (removePair.line.base && addPair?.line.variant) {
            const similarity = calculateStringSimilarity(removePair.line.base, addPair.line.variant);
            
            if (similarity > 0.2 && (!bestMatch || similarity > bestMatch.similarity)) {
              bestMatch = { addIdx, similarity };
            }
          }
        }
        
        // If found a good match, create modify entry
        if (bestMatch && addLines[bestMatch.addIdx]) {
          const baseStr = removePair.line.base;
          const variantStr = addLines[bestMatch.addIdx]!.line.variant;
          if (baseStr && variantStr) {
            processed.push({
              base: baseStr,
              variant: variantStr,
              type: 'modify'
            });
            usedAddIndices.add(bestMatch.addIdx);
          } else {
            processed.push(removePair.line);
          }
        } else {
          // No match found, keep as remove
          processed.push(removePair.line);
        }
      }
      
      // Add any unmatched add lines
      for (let addIdx = 0; addIdx < addLines.length; addIdx++) {
        if (!usedAddIndices.has(addIdx) && addLines[addIdx]) {
          processed.push(addLines[addIdx]!.line);
        }
      }
      
      i = j; // Skip to after the processed chunk
    } else {
      // No matching adds, just keep the removes
      for (const removePair of removeLines) {
        processed.push(removePair.line);
      }
      i = j;
    }
  }

  return processed;
}

function calculateStringSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (!str1 || !str2) return 0;
  
  const longer = str1.length > str2.length ? str1 : str2;
  
  if (longer.length === 0) return 1;
  
  const editDistance = levenshteinDistance(str1, str2);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = Array(str2.length + 1).fill(0).map(() => Array(str1.length + 1).fill(0));
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i]![0] = i;
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0]![j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1
        );
      }
    }
  }
  
  return matrix[str2.length]![str1.length]!;
}

export function calculateSimilarity(content1: string, content2: string): number {
  if (content1 === content2) return 100;
  if (!content1 || !content2) return 0;
  
  const changes = diffChars(content1, content2);
  let matchingChars = 0;
  
  for (const change of changes) {
    if (!change.added && !change.removed) {
      matchingChars += change.value.length;
    }
  }
  
  // Bug fix: Use the larger of the two strings as the denominator
  // instead of totalChars which double-counts differences
  const maxLength = Math.max(content1.length, content2.length);
  return maxLength > 0 ? Math.round((matchingChars / maxLength) * 100) : 0;
}
