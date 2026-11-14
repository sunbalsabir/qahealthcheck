import type { Scanner } from './types';
import { brokenLinksScanner } from './broken-links/index';
import { consoleScanner } from './console/index';
import { responsiveScanner } from './responsive/index';
import { accessibilityScanner } from './accessibility/index';
import { performanceScanner } from './performance/index';
import { technicalScanner } from './technical/index';
import { formsScanner } from './forms/index';
import { securityScanner } from './security/index';
import { uxScanner } from './ux/index';

/**
 * The scanner registry.
 *
 * Adding a QA check means writing a module that satisfies `Scanner` and
 * adding it to this array. Nothing else in the pipeline needs to change:
 * the runner, normalizer, severity engine and scorer all work from the
 * `ScannerResult` contract.
 *
 * Order here is the order findings appear before sorting, and it matches the
 * progress stages shown on the public wait screen.
 */
export const SCANNERS: readonly Scanner[] = [
  brokenLinksScanner,
  consoleScanner,
  responsiveScanner,
  accessibilityScanner,
  performanceScanner,
  technicalScanner,
  formsScanner,
  securityScanner,
  uxScanner,
] as const;

export function getScanner(id: string): Scanner | undefined {
  return SCANNERS.find((scanner) => scanner.id === id);
}

export function scannerIds(): string[] {
  return SCANNERS.map((scanner) => scanner.id);
}
