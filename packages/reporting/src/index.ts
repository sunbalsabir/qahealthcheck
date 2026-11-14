import React from 'react';
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer';
import type { AuditDetail, Finding, PassedCheck } from '@qualovix/shared';
import { QaReportDocument } from './report-document';

/**
 * Report generation.
 *
 * The `reviewedOnly` flag is the enforcement point for the product's core
 * promise. When a QA engineer has reviewed an audit, only findings they kept
 * or edited reach the client — anything marked IGNORED is excluded from the
 * PDF entirely. That is what makes this "Automated + Human QA Reviewed"
 * rather than a raw scanner dump.
 */

export interface GenerateReportOptions {
  audit: AuditDetail;
  /**
   * When true (the default), include only findings a reviewer kept or edited.
   * When the audit has not been reviewed yet, all findings are included and
   * the report is labelled as pending review.
   */
  reviewedOnly?: boolean;
  generatedAt?: Date;
}

export interface GeneratedReport {
  buffer: Buffer;
  byteSize: number;
  findingCount: number;
  reviewed: boolean;
  includesAi: boolean;
}

export async function generateReport(options: GenerateReportOptions): Promise<GeneratedReport> {
  const { audit } = options;
  const reviewedOnly = options.reviewedOnly ?? true;
  const reviewed = Boolean(audit.review?.approved);

  const findings = selectFindings(audit.findings, reviewedOnly, reviewed);

  // The component renders a <Document>, but React.createElement types the
  // element by the component's own props rather than the Document's, so the
  // renderer's signature needs the assertion.
  const element = React.createElement(QaReportDocument, {
    audit,
    findings,
    passedChecks: audit.passedChecks,
    reviewed,
    generatedAt: options.generatedAt ?? new Date(),
  }) as unknown as React.ReactElement<DocumentProps>;

  const buffer = await renderToBuffer(element);

  return {
    buffer,
    byteSize: buffer.byteLength,
    findingCount: findings.length,
    reviewed,
    includesAi: audit.aiAnalysisUsed,
  };
}

/**
 * Which findings make it into the report.
 *
 * - Reviewed audit, reviewedOnly: KEPT and EDITED only. IGNORED is dropped.
 * - Unreviewed audit: everything, because nothing has been triaged yet and
 *   withholding findings would misrepresent the scan.
 */
export function selectFindings(
  findings: Finding[],
  reviewedOnly: boolean,
  reviewed: boolean,
): Finding[] {
  if (!reviewedOnly || !reviewed) {
    return findings.filter((finding) => finding.status !== 'IGNORED');
  }
  return findings.filter(
    (finding) => finding.status === 'KEPT' || finding.status === 'EDITED',
  );
}

/** Filename for the downloaded report. */
export function reportFileName(audit: AuditDetail, generatedAt = new Date()): string {
  const host = safeHost(audit.url).replace(/[^a-z0-9.-]/gi, '-');
  const date = generatedAt.toISOString().slice(0, 10);
  return `Qualovix-QA-Health-Check-${host}-${date}.pdf`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'website';
  }
}

export { QaReportDocument } from './report-document';
export type { ReportProps } from './report-document';
export { colors, severityColors, scoreColor } from './theme';
export type { PassedCheck };
