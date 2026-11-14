import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import {
  BRAND,
  CATEGORY_LABELS,
  DISCLAIMER,
  SCORE_DISCLAIMER,
  SERVICES,
  SEVERITY_LABELS,
  SEVERITY_DEFINITIONS,
  formatMs,
  pluralize,
  type AuditDetail,
  type Finding,
  type PassedCheck,
  type Severity,
} from '@qualovix/shared';
import { colors, fontSize, scoreColor, severityColors, spacing } from './theme';

/**
 * The Qualovix QA Health Check report.
 *
 * Written to be sent directly to a prospective client, so it leads with what
 * was found and why it matters rather than with methodology. Every claim it
 * makes is bounded: the score is labelled a heuristic, accessibility findings
 * are labelled automated, and the security section states plainly that it is
 * not a penetration test.
 */

const styles = StyleSheet.create({
  page: {
    paddingTop: 46,
    paddingBottom: 58,
    paddingHorizontal: 46,
    fontSize: fontSize.body,
    color: colors.body,
    fontFamily: 'Helvetica',
    lineHeight: 1.5,
  },

  // --- cover ---
  cover: {
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 0,
    fontFamily: 'Helvetica',
  },
  coverBand: {
    backgroundColor: colors.brandDark,
    paddingTop: 72,
    paddingBottom: 52,
    paddingHorizontal: 46,
  },
  coverWordmark: {
    fontSize: fontSize.h3,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
    letterSpacing: 3.5,
  },
  coverRule: {
    width: 52,
    height: 3,
    backgroundColor: colors.brand,
    marginTop: spacing.md,
    marginBottom: spacing.xl,
  },
  coverTitle: {
    fontSize: fontSize.h1,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  coverSubtitle: {
    fontSize: fontSize.lead,
    color: '#bae6fd',
    marginTop: spacing.md,
    maxWidth: 380,
    lineHeight: 1.5,
  },
  coverBody: { paddingHorizontal: 46, paddingTop: spacing.xxl },

  coverMetaRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  coverMetaLabel: { width: 120, color: colors.muted, fontSize: fontSize.small },
  coverMetaValue: { flex: 1, color: colors.ink, fontSize: fontSize.body, fontFamily: 'Helvetica-Bold' },

  // --- score block ---
  scoreBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.brandTint,
    borderWidth: 1,
    borderColor: colors.brandLight,
    borderRadius: 6,
    padding: spacing.lg,
    marginTop: spacing.xl,
  },
  scoreNumber: { fontSize: fontSize.display, fontFamily: 'Helvetica-Bold', lineHeight: 1 },
  scoreOutOf: { fontSize: fontSize.h4, color: colors.muted, marginLeft: 3 },
  scoreBandLabel: { fontSize: fontSize.h3, fontFamily: 'Helvetica-Bold', color: colors.ink },
  scoreCaption: { fontSize: fontSize.caption, color: colors.muted, marginTop: spacing.xs, lineHeight: 1.4 },

  // --- sections ---
  sectionTitle: {
    fontSize: fontSize.h2,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  sectionRule: {
    width: 38,
    height: 2.5,
    backgroundColor: colors.brand,
    marginBottom: spacing.lg,
  },
  subheading: {
    fontSize: fontSize.h4,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  paragraph: { marginBottom: spacing.md, lineHeight: 1.65 },
  caption: { fontSize: fontSize.caption, color: colors.muted, lineHeight: 1.45 },

  // --- severity summary ---
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  summaryCard: {
    width: '20%',
    paddingHorizontal: 4,
    marginBottom: spacing.sm,
  },
  summaryCardInner: {
    borderWidth: 1,
    borderRadius: 5,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  summaryCount: { fontSize: fontSize.h2, fontFamily: 'Helvetica-Bold' },
  summaryLabel: { fontSize: fontSize.micro, marginTop: 2, textAlign: 'center' },

  // --- category bars ---
  categoryRow: { marginBottom: spacing.md },
  categoryHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  categoryName: { fontSize: fontSize.small, fontFamily: 'Helvetica-Bold', color: colors.ink },
  categoryScore: { fontSize: fontSize.small, fontFamily: 'Helvetica-Bold' },
  barTrack: { height: 6, backgroundColor: colors.border, borderRadius: 3 },
  barFill: { height: 6, borderRadius: 3 },
  categorySummary: { fontSize: fontSize.caption, color: colors.muted, marginTop: 3, lineHeight: 1.4 },

  // --- findings ---
  finding: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 5,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  findingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
  },
  badge: {
    fontSize: fontSize.micro,
    fontFamily: 'Helvetica-Bold',
    paddingVertical: 2.5,
    paddingHorizontal: 6,
    borderRadius: 3,
    borderWidth: 1,
    letterSpacing: 0.4,
  },
  findingTitle: {
    flex: 1,
    fontSize: fontSize.lead,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
    marginLeft: spacing.sm,
  },
  findingBody: { padding: spacing.md },
  findingMetaRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: spacing.sm },
  findingMeta: { fontSize: fontSize.caption, color: colors.muted, marginRight: spacing.md },

  evidenceBox: {
    backgroundColor: colors.surfaceAlt,
    borderLeftWidth: 2.5,
    borderLeftColor: colors.borderStrong,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  evidenceLabel: {
    fontSize: fontSize.micro,
    fontFamily: 'Helvetica-Bold',
    color: colors.muted,
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  evidenceText: { fontSize: fontSize.caption, color: colors.body, lineHeight: 1.45 },
  code: { fontFamily: 'Courier', fontSize: fontSize.caption, color: colors.ink, lineHeight: 1.45 },

  recommendation: {
    backgroundColor: colors.brandTint,
    borderLeftWidth: 2.5,
    borderLeftColor: colors.brand,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  qaNote: {
    backgroundColor: colors.successBg,
    borderLeftWidth: 2.5,
    borderLeftColor: colors.success,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },

  // --- top issues ---
  topIssue: {
    flexDirection: 'row',
    marginBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.md,
  },
  topIssueRank: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.brandDark,
    color: '#ffffff',
    fontSize: fontSize.small,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'center',
    paddingTop: 5,
    marginRight: spacing.md,
  },

  // --- passed checks ---
  passedRow: { flexDirection: 'row', marginBottom: spacing.sm, alignItems: 'flex-start' },
  passedTick: {
    fontSize: fontSize.small,
    color: colors.success,
    fontFamily: 'Helvetica-Bold',
    marginRight: spacing.sm,
    marginTop: 0.5,
  },

  // --- services / CTA ---
  ctaBlock: {
    backgroundColor: colors.brandDark,
    borderRadius: 6,
    padding: spacing.xl,
    marginTop: spacing.lg,
  },
  ctaTitle: { fontSize: fontSize.h2, fontFamily: 'Helvetica-Bold', color: '#ffffff' },
  ctaBody: { fontSize: fontSize.body, color: '#bae6fd', marginTop: spacing.sm, lineHeight: 1.6 },
  serviceGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.md },
  serviceChip: {
    fontSize: fontSize.caption,
    color: '#e0f2fe',
    borderWidth: 1,
    borderColor: colors.brandMid,
    borderRadius: 3,
    paddingVertical: 3,
    paddingHorizontal: 7,
    marginRight: 5,
    marginBottom: 5,
  },

  disclaimer: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 5,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.md,
    marginTop: spacing.lg,
  },

  // --- page furniture ---
  footer: {
    position: 'absolute',
    bottom: 26,
    left: 46,
    right: 46,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  footerText: { fontSize: fontSize.micro, color: colors.faint },
});

export interface ReportProps {
  audit: AuditDetail;
  /** Only findings with these ids are included. Set by the review workflow. */
  findings: Finding[];
  passedChecks: PassedCheck[];
  /** True when a QA engineer approved the report. */
  reviewed: boolean;
  generatedAt: Date;
}

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export function QaReportDocument({
  audit,
  findings,
  passedChecks,
  reviewed,
  generatedAt,
}: ReportProps): React.ReactElement {
  const counts = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: findings.filter((f) => f.severity === severity).length,
  }));

  // Precedence: a number the reviewer typed, then the score recalculated from
  // the findings they kept, then the automated score. This keeps the headline
  // number consistent with the findings actually listed below it.
  const score =
    audit.review?.scoreOverride ?? audit.review?.reviewedScore ?? audit.overallScore ?? 0;
  const bandLabel = audit.scoreBand ?? '';
  const company = audit.lead?.companyName ?? hostOf(audit.url);
  const topIssues = (audit.topIssues ?? []).filter((issue) =>
    findings.some((f) => f.id === issue.findingId),
  );

  return (
    <Document
      title={`Qualovix QA Health Check — ${company}`}
      author="Qualovix"
      subject="Automated QA Health Check"
      creator="Qualovix QA Auditor"
      producer="Qualovix QA Auditor"
    >
      {/* ---------------------------------------------------------------- */}
      {/* Cover                                                             */}
      {/* ---------------------------------------------------------------- */}
      <Page size="A4" style={[styles.page, styles.cover]}>
        <View style={styles.coverBand}>
          <Text style={styles.coverWordmark}>QUALOVIX</Text>
          <View style={styles.coverRule} />
          <Text style={styles.coverTitle}>{BRAND.reportTitle}</Text>
          <Text style={styles.coverSubtitle}>{BRAND.reportSubtitle}</Text>
        </View>

        <View style={styles.coverBody}>
          <MetaRow label="Company" value={company} />
          <MetaRow label="Website" value={audit.url} />
          <MetaRow label="Audit date" value={formatDate(generatedAt)} />
          <MetaRow label="Pages analysed" value={String(audit.pages.length)} />
          <MetaRow
            label="Review status"
            value={reviewed ? 'Reviewed by a Qualovix QA engineer' : 'Automated findings — pending QA review'}
          />
          {audit.mockMode ? <MetaRow label="Mode" value="DEMONSTRATION DATA — not a real scan" /> : null}

          <View style={styles.scoreBlock}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginRight: spacing.xl }}>
              <Text style={[styles.scoreNumber, { color: scoreColor(score) }]}>{score}</Text>
              <Text style={styles.scoreOutOf}>/ 100</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.scoreBandLabel}>{bandLabel}</Text>
              <Text style={styles.scoreCaption}>
                Overall QA Health Score across functional, accessibility, performance, responsive,
                technical, security-baseline and UX checks. {SCORE_DISCLAIMER}
              </Text>
            </View>
          </View>

          <View style={[styles.summaryGrid, { marginTop: spacing.lg }]}>
            {counts.map(({ severity, count }) => (
              <SummaryCard key={severity} severity={severity} count={count} />
            ))}
          </View>

          <Text style={[styles.caption, { marginTop: spacing.md }]}>
            {passedChecks.length} automated {pluralize(passedChecks.length, 'check')} passed.
            {audit.durationMs ? ` Scan completed in ${formatMs(audit.durationMs)}.` : ''}
          </Text>
        </View>

        <Footer company={company} />
      </Page>

      {/* ---------------------------------------------------------------- */}
      {/* Executive summary + category scores                               */}
      {/* ---------------------------------------------------------------- */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionTitle}>Executive Summary</Text>
        <View style={styles.sectionRule} />

        <Text style={styles.paragraph}>{audit.executiveSummary}</Text>

        {audit.review?.engineerNotes ? (
          <View style={styles.qaNote}>
            <Text style={styles.evidenceLabel}>QUALOVIX QA ENGINEER NOTES</Text>
            <Text style={styles.evidenceText}>{audit.review.engineerNotes}</Text>
          </View>
        ) : null}

        <Text style={styles.subheading}>Category Scores</Text>
        {audit.categoryScores.map((category) => (
          <View key={category.category} style={styles.categoryRow}>
            <View style={styles.categoryHeader}>
              <Text style={styles.categoryName}>
                {CATEGORY_LABELS[category.category]}
                <Text style={{ color: colors.faint, fontFamily: 'Helvetica' }}>
                  {`  ${Math.round(category.weight * 100)}% of score`}
                </Text>
              </Text>
              <Text style={[styles.categoryScore, { color: scoreColor(category.score) }]}>
                {category.score}/100
              </Text>
            </View>
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.barFill,
                  { width: `${Math.max(1, category.score)}%`, backgroundColor: scoreColor(category.score) },
                ]}
              />
            </View>
            {category.summary ? <Text style={styles.categorySummary}>{category.summary}</Text> : null}
          </View>
        ))}

        {topIssues.length > 0 ? (
          <>
            <Text style={[styles.subheading, { marginTop: spacing.xl }]}>Top Issues</Text>
            {topIssues.map((issue, index) => (
              <View key={issue.findingId} style={styles.topIssue} wrap={false}>
                <Text style={styles.topIssueRank}>{index + 1}</Text>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
                    <SeverityBadge severity={issue.severity} />
                    <Text
                      style={{
                        fontSize: fontSize.lead,
                        fontFamily: 'Helvetica-Bold',
                        color: colors.ink,
                        marginLeft: spacing.sm,
                        flex: 1,
                      }}
                    >
                      {issue.title}
                    </Text>
                  </View>
                  <Text style={{ fontSize: fontSize.small, lineHeight: 1.5 }}>{issue.whyItMatters}</Text>
                </View>
              </View>
            ))}
          </>
        ) : null}

        <Footer company={company} />
      </Page>

      {/* ---------------------------------------------------------------- */}
      {/* Findings, grouped by severity                                     */}
      {/* ---------------------------------------------------------------- */}
      {/*
        Only severities that actually have findings become pages. Mapping over
        every severity and returning null for the empty ones puts null among
        the Document's children, which corrupts page layout once the report
        runs past a few pages.
      */}
      {SEVERITY_ORDER.filter((severity) =>
        findings.some((f) => f.severity === severity),
      ).map((severity) => {
        const group = findings.filter((f) => f.severity === severity);

        return (
          <Page key={severity} size="A4" style={styles.page}>
            <Text style={styles.sectionTitle}>
              {SEVERITY_LABELS[severity]} {group.length === 1 ? 'Finding' : 'Findings'}
            </Text>
            <View style={styles.sectionRule} />
            <Text style={[styles.caption, { marginBottom: spacing.lg }]}>
              {SEVERITY_DEFINITIONS[severity]} {group.length} {pluralize(group.length, 'finding')} in this
              category.
            </Text>

            {group.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}

            <Footer company={company} />
          </Page>
        );
      })}

      {/* ---------------------------------------------------------------- */}
      {/* Passed checks + next steps + services                             */}
      {/* ---------------------------------------------------------------- */}
      <Page size="A4" style={styles.page}>
        {passedChecks.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Passed Checks</Text>
            <View style={styles.sectionRule} />
            <Text style={[styles.caption, { marginBottom: spacing.lg }]}>
              These automated checks ran and found no issues. A passed check confirms that specific check
              succeeded — it does not confirm the area is free of defects.
            </Text>
            {passedChecks.map((check) => (
              <View key={`${check.ruleId}-${check.title}`} style={styles.passedRow} wrap={false}>
                <Text style={styles.passedTick}>OK</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.small, fontFamily: 'Helvetica-Bold', color: colors.ink }}>
                    {check.title}
                  </Text>
                  <Text style={styles.caption}>{check.detail}</Text>
                </View>
              </View>
            ))}
          </>
        ) : null}

        <Text style={[styles.sectionTitle, { marginTop: passedChecks.length > 0 ? spacing.xxl : 0 }]}>
          Recommended Next Steps
        </Text>
        <View style={styles.sectionRule} />
        {(audit.recommendations ?? []).map((recommendation, index) => (
          <View key={index} style={{ flexDirection: 'row', marginBottom: spacing.sm }} wrap={false}>
            <Text style={{ width: 16, color: colors.brand, fontFamily: 'Helvetica-Bold', fontSize: fontSize.small }}>
              {index + 1}.
            </Text>
            <Text style={{ flex: 1, fontSize: fontSize.small, lineHeight: 1.55 }}>{recommendation}</Text>
          </View>
        ))}

        <View style={styles.ctaBlock}>
          <Text style={styles.ctaTitle}>Want a deeper assessment?</Text>
          <Text style={styles.ctaBody}>
            This health check is automated analysis reviewed by our QA engineers. It surfaces what a machine
            can see. A full engagement covers the things it cannot: whether your user journeys actually work,
            whether your forms deliver, and whether your releases stay stable over time.
          </Text>
          <View style={styles.serviceGrid}>
            {SERVICES.map((service) => (
              <Text key={service} style={styles.serviceChip}>
                {service}
              </Text>
            ))}
          </View>
          <Text style={[styles.ctaBody, { marginTop: spacing.md, fontFamily: 'Helvetica-Bold', color: '#ffffff' }]}>
            Talk to Qualovix — {BRAND.contactUrl}
          </Text>
        </View>

        <View style={styles.disclaimer}>
          <Text style={styles.evidenceLabel}>SCOPE AND LIMITATIONS</Text>
          <Text style={styles.caption}>{DISCLAIMER}</Text>
          <Text style={[styles.caption, { marginTop: spacing.sm }]}>{SCORE_DISCLAIMER}</Text>
          {audit.mockMode ? (
            <Text style={[styles.caption, { marginTop: spacing.sm, color: colors.critical }]}>
              This report was generated in demonstration mode from sample data. No website was scanned.
            </Text>
          ) : null}
        </View>

        <Footer company={company} />
      </Page>
    </Document>
  );
}

// --- components -------------------------------------------------------------

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.coverMetaRow}>
      <Text style={styles.coverMetaLabel}>{label}</Text>
      <Text style={styles.coverMetaValue}>{value}</Text>
    </View>
  );
}

function SummaryCard({ severity, count }: { severity: Severity; count: number }) {
  const palette = severityColors[severity];
  return (
    <View style={styles.summaryCard}>
      <View
        style={[
          styles.summaryCardInner,
          { backgroundColor: palette.bg, borderColor: palette.border },
        ]}
      >
        <Text style={[styles.summaryCount, { color: palette.fg }]}>{count}</Text>
        <Text style={[styles.summaryLabel, { color: palette.fg }]}>
          {SEVERITY_LABELS[severity].toUpperCase()}
        </Text>
      </View>
    </View>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const palette = severityColors[severity];
  return (
    <Text
      style={[
        styles.badge,
        { color: palette.fg, backgroundColor: palette.bg, borderColor: palette.border },
      ]}
    >
      {severity}
    </Text>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const palette = severityColors[finding.severity];
  // Edited text takes precedence: a QA engineer's wording is what the client
  // should read, with the automated original preserved in the database.
  const title = finding.editedTitle ?? finding.title;
  const description = finding.editedDescription ?? finding.aiSummary ?? finding.description;
  const impact = finding.aiImpact ?? finding.impact;
  const recommendation = finding.aiRemediation ?? finding.recommendation;

  return (
    <View style={styles.finding} wrap={false}>
      <View style={[styles.findingHeader, { backgroundColor: palette.bg, borderBottomColor: palette.border }]}>
        <SeverityBadge severity={finding.severity} />
        <Text style={styles.findingTitle}>{title}</Text>
      </View>

      <View style={styles.findingBody}>
        <View style={styles.findingMetaRow}>
          {finding.url ? <Text style={styles.findingMeta}>{finding.url}</Text> : null}
          {finding.occurrences > 1 ? (
            <Text style={styles.findingMeta}>
              {finding.occurrences} {pluralize(finding.occurrences, 'occurrence')}
            </Text>
          ) : null}
          <Text style={styles.findingMeta}>Confidence: {finding.confidence.toLowerCase()}</Text>
          <Text style={styles.findingMeta}>Detected by: {finding.detectedBy}</Text>
        </View>

        <Text style={{ fontSize: fontSize.small, lineHeight: 1.55 }}>{description}</Text>

        {impact ? (
          <Text style={{ fontSize: fontSize.small, lineHeight: 1.55, marginTop: spacing.sm }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', color: colors.ink }}>Impact: </Text>
            {impact}
          </Text>
        ) : null}

        <View style={styles.evidenceBox}>
          <Text style={styles.evidenceLabel}>EVIDENCE</Text>
          <Text style={styles.evidenceText}>{finding.evidence.summary}</Text>
          {finding.evidence.observed ? (
            <Text style={[styles.code, { marginTop: 5 }]}>{finding.evidence.observed}</Text>
          ) : null}
          {finding.evidence.expected ? (
            <Text style={[styles.evidenceText, { marginTop: 5, color: colors.muted }]}>
              Expected: {finding.evidence.expected}
            </Text>
          ) : null}
        </View>

        <View style={styles.recommendation}>
          <Text style={styles.evidenceLabel}>RECOMMENDATION</Text>
          <Text style={styles.evidenceText}>{recommendation}</Text>
        </View>

        {finding.qaNote ? (
          <View style={styles.qaNote}>
            <Text style={styles.evidenceLabel}>QA ENGINEER NOTE</Text>
            <Text style={styles.evidenceText}>{finding.qaNote}</Text>
          </View>
        ) : null}

        {finding.originalSeverity && finding.originalSeverity !== finding.severity ? (
          <Text style={[styles.caption, { marginTop: spacing.sm }]}>
            Severity adjusted from {finding.originalSeverity} to {finding.severity} after review.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Page footer.
 *
 * Deliberately static. A `render` callback here (for "Page 3 of 12") makes
 * @react-pdf/renderer run a second layout pass, and on a report long enough
 * to span several pages that pass leaves the `wrap={false}` finding cards
 * with uncomputed layout boxes — the renderer then throws
 * "unsupported number: -2.0116e+22" while clipping their borders.
 *
 * Keeping findings unsplit across page breaks matters more in a document a
 * client reads than a page counter does, so the counter is what goes. If
 * react-pdf fixes the re-layout interaction, restore it by adding
 * `render={({ pageNumber }) => ...}` here and re-running the report tests.
 */
function Footer({ company }: { company: string }) {
  return (
    <View style={styles.footer} fixed>
      <Text style={styles.footerText}>
        QUALOVIX — Free QA Health Check — {company}
      </Text>
      <Text style={styles.footerText}>{BRAND.websiteUrl.replace(/^https?:\/\//, '')}</Text>
    </View>
  );
}

// --- helpers ----------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
