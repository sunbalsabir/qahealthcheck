import {
  formatBytes,
  formatMs,
  pluralize,
  type ScannerResult,
  type Severity,
} from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { PerformanceMetrics, ScanContext, Scanner } from '../types';

/**
 * Performance scanner.
 *
 * Metrics come from the browser's own Navigation Timing and PerformanceObserver
 * data, collected during the same crawl pass rather than a separate Lighthouse
 * run. That keeps one page load per page instead of two and avoids a heavy
 * extra dependency, at the cost of Lighthouse's simulated-throttling model.
 *
 * Thresholds follow the published Core Web Vitals "good / needs improvement /
 * poor" boundaries so the numbers line up with what the client will see in
 * Search Console. Every finding restates that lab measurements vary with
 * network and environment.
 */

const ENVIRONMENT_CAVEAT =
  'Automated performance results vary with network conditions, server location and device. Treat this as an indicator, not a benchmark.';

/** Core Web Vitals thresholds (ms unless noted). */
const THRESHOLDS = {
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  tbt: { good: 200, poor: 600 },
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
  totalBytes: { good: 1_600_000, poor: 4_000_000 },
  imageBytes: { good: 1_000_000, poor: 2_500_000 },
  requestCount: { good: 60, poor: 120 },
  domNodes: { good: 1500, poor: 3000 },
  renderBlocking: { good: 4, poor: 10 },
} as const;

export const performanceScanner: Scanner = {
  id: 'performance',
  name: 'Performance',
  category: 'PERFORMANCE',
  description:
    'Collects load timing, Core Web Vitals and asset weight from the browser during the crawl.',

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('performance', 'PERFORMANCE');
    const { pages } = context.crawl;

    const measured = pages.filter((page) => hasMetrics(page.performance));
    if (measured.length === 0) {
      collector.warn('No performance metrics were captured.');
      return collector.result();
    }

    // Report against the worst page for each metric — that is the page a
    // client should look at first — while noting the site-wide average.
    const worstLcp = worstBy(measured, (p) => p.performance.lcpMs);
    const worstCls = worstBy(measured, (p) => p.performance.cls);
    const worstTbt = worstBy(measured, (p) => p.performance.totalBlockingTimeMs);
    const worstTtfb = worstBy(measured, (p) => p.performance.ttfbMs);
    const heaviest = worstBy(measured, (p) => p.performance.totalTransferBytes);

    // --- Largest Contentful Paint ---
    if (worstLcp && worstLcp.performance.lcpMs !== undefined) {
      const lcp = worstLcp.performance.lcpMs;
      if (lcp > THRESHOLDS.lcp.good) {
        collector.add({
          ruleId: 'performance.slow-lcp',
          title: `Largest Contentful Paint is ${formatMs(lcp)}`,
          description: `The largest above-the-fold element finished rendering after ${formatMs(lcp)}. The Core Web Vitals target is under 2.5 seconds. ${ENVIRONMENT_CAVEAT}`,
          severity: band(lcp, THRESHOLDS.lcp, 'HIGH', 'MEDIUM'),
          confidence: 'MEDIUM',
          url: worstLcp.url,
          evidence: {
            summary: `LCP measured at ${formatMs(lcp)} on ${worstLcp.url}.`,
            observed: `LCP ${formatMs(lcp)}`,
            expected: 'LCP under 2.5 seconds (Core Web Vitals "good" threshold).',
            details: {
              lcpMs: Math.round(lcp),
              ttfbMs: round(worstLcp.performance.ttfbMs),
              firstContentfulPaintMs: round(worstLcp.performance.firstContentfulPaintMs),
              imageBytes: worstLcp.performance.imageBytes,
              renderBlockingResources: worstLcp.performance.renderBlockingCount,
              siteAverageLcpMs: round(average(measured.map((p) => p.performance.lcpMs))),
            },
          },
          recommendation:
            'Identify the LCP element and prioritise it: preload the hero image or font, serve appropriately sized and modern-format images, and remove render-blocking resources ahead of it. Improving TTFB shifts every downstream metric.',
          impact:
            'Visitors perceive the page as slow to appear, which correlates strongly with bounce rate and lower conversion.',
        });
      } else {
        collector.pass(
          'performance.lcp-good',
          'Largest Contentful Paint within target',
          `Worst measured LCP was ${formatMs(lcp)}, inside the 2.5s "good" threshold.`,
        );
      }
    }

    // --- Cumulative Layout Shift ---
    if (worstCls && worstCls.performance.cls !== undefined) {
      const cls = worstCls.performance.cls;
      if (cls > THRESHOLDS.cls.good) {
        collector.add({
          ruleId: 'performance.layout-shift',
          title: `Cumulative Layout Shift is ${cls.toFixed(3)}`,
          description: `Content moved during page load, producing a CLS score of ${cls.toFixed(3)} against a target of 0.1 or below. This is usually caused by images without dimensions, late-loading fonts, or content injected above existing content. ${ENVIRONMENT_CAVEAT}`,
          severity: band(cls, THRESHOLDS.cls, 'MEDIUM', 'LOW'),
          confidence: 'MEDIUM',
          url: worstCls.url,
          evidence: {
            summary: `CLS measured at ${cls.toFixed(3)} on ${worstCls.url}.`,
            observed: `CLS ${cls.toFixed(3)}`,
            expected: 'CLS of 0.1 or below.',
            details: {
              cls: Number(cls.toFixed(4)),
              imagesWithoutDimensions: worstCls.images.filter(
                (img) => !img.width || !img.height,
              ).length,
              siteAverageCls: Number((average(measured.map((p) => p.performance.cls)) ?? 0).toFixed(4)),
            },
          },
          recommendation:
            'Set explicit width and height (or aspect-ratio) on images and embeds, reserve space for ads and banners, and preload web fonts with font-display: optional or swap plus a metric-compatible fallback.',
          impact:
            'Content jumping under the cursor causes mis-clicks and is a common source of user frustration.',
        });
      } else {
        collector.pass(
          'performance.cls-good',
          'Layout is visually stable during load',
          `Worst measured CLS was ${cls.toFixed(3)}, inside the 0.1 target.`,
        );
      }
    }

    // --- Total Blocking Time ---
    if (worstTbt && worstTbt.performance.totalBlockingTimeMs !== undefined) {
      const tbt = worstTbt.performance.totalBlockingTimeMs;
      if (tbt > THRESHOLDS.tbt.good) {
        collector.add({
          ruleId: 'performance.blocking-time',
          title: `Main thread blocked for ${formatMs(tbt)} during load`,
          description: `Long JavaScript tasks blocked the main thread for a total of ${formatMs(tbt)} (${worstTbt.performance.longTaskCount ?? 0} ${pluralize(worstTbt.performance.longTaskCount ?? 0, 'task')} over 50ms). While the main thread is blocked the page cannot respond to taps, clicks or scrolling. ${ENVIRONMENT_CAVEAT}`,
          severity: band(tbt, THRESHOLDS.tbt, 'MEDIUM', 'LOW'),
          confidence: 'MEDIUM',
          url: worstTbt.url,
          evidence: {
            summary: `Total Blocking Time of ${formatMs(tbt)} across ${worstTbt.performance.longTaskCount ?? 0} long tasks.`,
            observed: `TBT ${formatMs(tbt)}, ${worstTbt.performance.longTaskCount ?? 0} long tasks`,
            expected: 'Total Blocking Time under 200ms.',
            details: {
              totalBlockingTimeMs: Math.round(tbt),
              longTaskCount: worstTbt.performance.longTaskCount,
              scriptBytes: worstTbt.performance.scriptBytes,
              scriptCount: worstTbt.scripts.length,
            },
          },
          recommendation:
            'Split large bundles, defer non-critical third-party scripts, and move heavy work off the main thread. Audit analytics and tag-manager payloads first — they are usually the largest avoidable cost.',
          impact:
            'The page looks ready but does not respond to input, which users experience as the site being broken.',
        });
      }
    }

    // --- Time to First Byte ---
    if (worstTtfb && worstTtfb.performance.ttfbMs !== undefined) {
      const ttfb = worstTtfb.performance.ttfbMs;
      if (ttfb > THRESHOLDS.ttfb.good) {
        collector.add({
          ruleId: 'performance.slow-ttfb',
          title: `Server response time is ${formatMs(ttfb)}`,
          description: `The server took ${formatMs(ttfb)} to return the first byte. Everything else on the page waits behind this. ${ENVIRONMENT_CAVEAT}`,
          severity: band(ttfb, THRESHOLDS.ttfb, 'MEDIUM', 'LOW'),
          confidence: 'MEDIUM',
          url: worstTtfb.url,
          evidence: {
            summary: `TTFB of ${formatMs(ttfb)} measured on ${worstTtfb.url}.`,
            observed: `TTFB ${formatMs(ttfb)}`,
            expected: 'Time to First Byte under 800ms.',
            details: {
              ttfbMs: Math.round(ttfb),
              siteAverageTtfbMs: round(average(measured.map((p) => p.performance.ttfbMs))),
            },
          },
          recommendation:
            'Profile the server-side request path. Caching, database query tuning and a CDN in front of the origin are the usual wins.',
          impact: 'Every page on the site starts slow, regardless of front-end optimisation.',
        });
      }
    }

    // --- Page weight ---
    if (heaviest && heaviest.performance.totalTransferBytes !== undefined) {
      const bytes = heaviest.performance.totalTransferBytes;
      if (bytes > THRESHOLDS.totalBytes.good) {
        const perf = heaviest.performance;
        collector.add({
          ruleId: 'performance.page-weight',
          title: `Page transfers ${formatBytes(bytes)}`,
          description: `This page downloads ${formatBytes(bytes)} across ${perf.requestCount ?? 0} ${pluralize(perf.requestCount ?? 0, 'request')}. Heavy pages are slow on mobile networks and expensive on metered connections. ${ENVIRONMENT_CAVEAT}`,
          severity: band(bytes, THRESHOLDS.totalBytes, 'MEDIUM', 'LOW'),
          confidence: 'HIGH',
          url: heaviest.url,
          evidence: {
            summary: `${formatBytes(bytes)} transferred over ${perf.requestCount ?? 0} requests on ${heaviest.url}.`,
            observed: [
              `total: ${formatBytes(bytes)}`,
              perf.imageBytes ? `images: ${formatBytes(perf.imageBytes)}` : null,
              perf.scriptBytes ? `scripts: ${formatBytes(perf.scriptBytes)}` : null,
              perf.stylesheetBytes ? `styles: ${formatBytes(perf.stylesheetBytes)}` : null,
              perf.fontBytes ? `fonts: ${formatBytes(perf.fontBytes)}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
            expected: 'Total page weight under 1.6 MB.',
            details: {
              totalBytes: bytes,
              imageBytes: perf.imageBytes,
              scriptBytes: perf.scriptBytes,
              stylesheetBytes: perf.stylesheetBytes,
              fontBytes: perf.fontBytes,
              requestCount: perf.requestCount,
            },
          },
          recommendation:
            'Compress and resize images, serve WebP or AVIF, enable Brotli, and remove unused JavaScript and CSS. Images are usually the largest single reduction available.',
          impact: 'Slow loads on mobile and metered connections, and higher bandwidth cost.',
        });
      }
    }

    // --- Unoptimised images (measured, not guessed) ---
    for (const page of measured) {
      const oversized = page.images.filter((img) => {
        if (!img.naturalWidth || !img.width) return false;
        // Served at more than twice the rendered width — a real waste,
        // allowing for 2x displays.
        return img.naturalWidth > img.width * 2.5 && img.width > 0;
      });
      if (oversized.length > 0) {
        collector.add({
          ruleId: 'performance.oversized-images',
          title: `${oversized.length} ${pluralize(oversized.length, 'image')} served larger than displayed`,
          description: `${oversized.length} ${pluralize(oversized.length, 'image is', 'images are')} downloaded at a much higher resolution than they are rendered at, wasting bandwidth and decode time on every visit.`,
          severity: oversized.length > 5 ? 'MEDIUM' : 'LOW',
          confidence: 'HIGH',
          url: page.url,
          evidence: {
            summary: `${oversized.length} images have intrinsic dimensions far larger than their rendered size.`,
            observed: oversized
              .slice(0, 5)
              .map(
                (img) =>
                  `${img.src} — natural ${img.naturalWidth}x${img.naturalHeight}, rendered ${Math.round(img.width ?? 0)}x${Math.round(img.height ?? 0)}${img.transferBytes ? ` (${formatBytes(img.transferBytes)})` : ''}`,
              )
              .join('\n'),
            expected: 'Images served close to their rendered size, at most 2x for high-density displays.',
            details: { count: oversized.length },
          },
          recommendation:
            'Generate responsive image variants and serve them with srcset/sizes, or resize the source assets to their maximum rendered dimensions.',
          impact: 'Wasted bandwidth and slower rendering, most noticeably on mobile.',
          occurrences: oversized.length,
        });
        break; // one representative finding is enough
      }
    }

    // --- Render-blocking resources ---
    const blockingWorst = worstBy(measured, (p) => p.performance.renderBlockingCount);
    if (
      blockingWorst &&
      (blockingWorst.performance.renderBlockingCount ?? 0) > THRESHOLDS.renderBlocking.good
    ) {
      const count = blockingWorst.performance.renderBlockingCount!;
      collector.add({
        ruleId: 'performance.render-blocking',
        title: `${count} render-blocking ${pluralize(count, 'resource')} in the document head`,
        description: `${count} stylesheets and synchronous scripts must download and execute before the browser can paint anything. Each one delays first render.`,
        severity: count > THRESHOLDS.renderBlocking.poor ? 'MEDIUM' : 'LOW',
        confidence: 'HIGH',
        url: blockingWorst.url,
        evidence: {
          summary: `${count} render-blocking resources found in <head> on ${blockingWorst.url}.`,
          observed: [
            ...blockingWorst.stylesheets.filter((s) => s.blocking).slice(0, 4).map((s) => `stylesheet: ${s.href ?? '(inline)'}`),
            ...blockingWorst.scripts.filter((s) => s.blocking).slice(0, 4).map((s) => `script: ${s.src ?? '(inline)'}`),
          ].join('\n'),
          expected: 'Critical CSS inlined; non-critical CSS and all scripts loaded without blocking render.',
          details: { renderBlockingCount: count },
        },
        recommendation:
          'Add defer or async to scripts, inline critical CSS and load the remainder asynchronously, and move third-party tags out of the critical path.',
        impact: 'Visitors stare at a blank screen for longer than necessary.',
      });
    }

    // --- Excessive requests ---
    const mostRequests = worstBy(measured, (p) => p.performance.requestCount);
    if (mostRequests && (mostRequests.performance.requestCount ?? 0) > THRESHOLDS.requestCount.poor) {
      const count = mostRequests.performance.requestCount!;
      collector.add({
        ruleId: 'performance.excessive-requests',
        title: `${count} network requests on a single page`,
        description: `Loading this page issues ${count} network requests. High request counts add connection and queuing overhead, particularly on high-latency mobile networks.`,
        severity: 'LOW',
        confidence: 'HIGH',
        url: mostRequests.url,
        evidence: {
          summary: `${count} requests recorded while loading ${mostRequests.url}.`,
          observed: `${count} requests, ${formatBytes(mostRequests.performance.totalTransferBytes ?? 0)} transferred`,
          expected: 'Fewer than 60 requests for a typical marketing page.',
          details: {
            requestCount: count,
            thirdPartyRequests: mostRequests.network.filter((r) => r.thirdParty).length,
          },
        },
        recommendation:
          'Bundle or combine assets where practical, lazy-load below-the-fold images, and audit third-party tags — they are frequently the bulk of the count.',
        impact: 'Additional latency on mobile connections.',
      });
    }

    return collector.result();
  },
};

function hasMetrics(metrics: PerformanceMetrics): boolean {
  return (
    metrics.lcpMs !== undefined ||
    metrics.ttfbMs !== undefined ||
    metrics.totalTransferBytes !== undefined
  );
}

function worstBy<T>(items: T[], selector: (item: T) => number | undefined): T | undefined {
  let worst: T | undefined;
  let worstValue = -Infinity;
  for (const item of items) {
    const value = selector(item);
    if (value !== undefined && value > worstValue) {
      worstValue = value;
      worst = item;
    }
  }
  return worst;
}

function average(values: Array<number | undefined>): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
}

/** Map a measurement onto a severity using the good/poor thresholds. */
function band(
  value: number,
  thresholds: { good: number; poor: number },
  poorSeverity: Severity,
  fairSeverity: Severity,
): Severity {
  return value >= thresholds.poor ? poorSeverity : fairSeverity;
}
