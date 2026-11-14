/**
 * In-page extraction script.
 *
 * This module holds the functions that are serialised into the browser by
 * `page.evaluate`. They run in the page's own context, so they cannot close
 * over anything from Node — everything they need is passed in as an argument
 * and everything they return must be structured-cloneable.
 *
 * Keeping them here (rather than inline in the crawler) makes the DOM logic
 * reviewable on its own and keeps the crawler readable.
 */

export interface ExtractedPage {
  title: string | null;
  lang: string | null;
  meta: Record<string, string | undefined>;
  headings: Array<{ level: number; text: string }>;
  links: Array<{
    href: string;
    resolved: string;
    text: string;
    rel: string;
    target: string;
    ariaLabel: string;
    hasVisibleText: boolean;
    hasImageChild: boolean;
  }>;
  images: Array<{
    src: string;
    resolved: string;
    alt: string | null;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
    loading: string;
    failedToLoad: boolean;
  }>;
  forms: Array<{
    index: number;
    id: string;
    name: string;
    action: string;
    method: string;
    hasSubmitControl: boolean;
    hasNoValidate: boolean;
    fields: Array<{
      tag: string;
      type: string;
      name: string;
      id: string;
      required: boolean;
      placeholder: string;
      autocomplete: string;
      hasLabel: boolean;
      labelSource: string;
      accessibleName: string;
    }>;
  }>;
  buttons: Array<{
    tag: string;
    type: string;
    text: string;
    ariaLabel: string;
    hasAccessibleName: boolean;
    disabled: boolean;
  }>;
  scripts: Array<{ src: string; inline: boolean; async: boolean; defer: boolean; blocking: boolean }>;
  stylesheets: Array<{ href: string; media: string; blocking: boolean }>;
  duplicateIds: Array<{ id: string; count: number }>;
  elementCount: number;
  textLength: number;
  domNodeCount: number;
}

/**
 * Serialised as a string and evaluated in the page. Returns everything the
 * scanners need from the DOM in a single round trip.
 */
export const extractPageFn = (): ExtractedPage => {
  const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const attr = (el: Element, name: string): string => el.getAttribute(name) ?? '';

  const absolute = (value: string): string => {
    try {
      return new URL(value, document.baseURI).toString();
    } catch {
      return '';
    }
  };

  // --- meta ---
  const metaContent = (selector: string): string | undefined => {
    const el = document.querySelector(selector);
    const content = el?.getAttribute('content') ?? undefined;
    return content?.trim() || undefined;
  };

  const meta: Record<string, string | undefined> = {
    description: metaContent('meta[name="description" i]'),
    viewport: metaContent('meta[name="viewport" i]'),
    robots: metaContent('meta[name="robots" i]'),
    themeColor: metaContent('meta[name="theme-color" i]'),
    generator: metaContent('meta[name="generator" i]'),
    ogTitle: metaContent('meta[property="og:title" i]'),
    ogDescription: metaContent('meta[property="og:description" i]'),
    ogImage: metaContent('meta[property="og:image" i]'),
    canonical: document.querySelector('link[rel="canonical" i]')?.getAttribute('href') ?? undefined,
    charset:
      document.querySelector('meta[charset]')?.getAttribute('charset') ??
      metaContent('meta[http-equiv="content-type" i]'),
    lang: document.documentElement.getAttribute('lang') ?? undefined,
    dir: document.documentElement.getAttribute('dir') ?? undefined,
  };

  // --- headings ---
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el) => ({
    level: Number(el.tagName.slice(1)),
    text: text(el).slice(0, 200),
  }));

  // --- links ---
  const links = Array.from(document.querySelectorAll('a[href]')).map((el) => {
    const href = attr(el, 'href');
    const linkText = text(el);
    return {
      href,
      resolved: absolute(href),
      text: linkText.slice(0, 200),
      rel: attr(el, 'rel'),
      target: attr(el, 'target'),
      ariaLabel: attr(el, 'aria-label') || attr(el, 'title'),
      hasVisibleText: linkText.length > 0,
      hasImageChild: el.querySelector('img,svg,picture') !== null,
    };
  });

  // --- images ---
  const images = Array.from(document.querySelectorAll('img')).map((el) => {
    const img = el as HTMLImageElement;
    const rect = img.getBoundingClientRect();
    const src = img.getAttribute('src') ?? img.getAttribute('data-src') ?? '';
    return {
      src,
      resolved: absolute(src),
      // `alt` present-but-empty (decorative) must be distinguished from absent.
      alt: img.hasAttribute('alt') ? img.getAttribute('alt') : null,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      loading: img.getAttribute('loading') ?? '',
      // A complete image with zero natural size failed to decode.
      failedToLoad: Boolean(src) && img.complete && img.naturalWidth === 0,
    };
  });

  // --- form fields, including how each one is (or is not) labelled ---
  const labelInfo = (
    field: Element,
  ): { hasLabel: boolean; labelSource: string; accessibleName: string } => {
    const id = field.getAttribute('id');
    if (id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (explicit && text(explicit)) {
        return { hasLabel: true, labelSource: 'for', accessibleName: text(explicit).slice(0, 120) };
      }
    }
    const wrapping = field.closest('label');
    if (wrapping && text(wrapping)) {
      return { hasLabel: true, labelSource: 'wrapping', accessibleName: text(wrapping).slice(0, 120) };
    }
    const ariaLabel = field.getAttribute('aria-label');
    if (ariaLabel?.trim()) {
      return { hasLabel: true, labelSource: 'aria-label', accessibleName: ariaLabel.slice(0, 120) };
    }
    const labelledBy = field.getAttribute('aria-labelledby');
    if (labelledBy) {
      const referenced = labelledBy
        .split(/\s+/)
        .map((refId) => document.getElementById(refId))
        .filter(Boolean)
        .map((el) => text(el))
        .join(' ')
        .trim();
      if (referenced) {
        return { hasLabel: true, labelSource: 'aria-labelledby', accessibleName: referenced.slice(0, 120) };
      }
    }
    const title = field.getAttribute('title');
    if (title?.trim()) {
      return { hasLabel: true, labelSource: 'title', accessibleName: title.slice(0, 120) };
    }
    return { hasLabel: false, labelSource: 'none', accessibleName: '' };
  };

  const forms = Array.from(document.querySelectorAll('form')).map((formEl, index) => {
    const fieldEls = Array.from(
      formEl.querySelectorAll('input, select, textarea, button'),
    );
    const fields = fieldEls.map((field) => {
      const tag = field.tagName.toLowerCase();
      const info = labelInfo(field);
      return {
        tag,
        type: field.getAttribute('type') ?? (tag === 'button' ? 'submit' : ''),
        name: attr(field, 'name'),
        id: attr(field, 'id'),
        required: field.hasAttribute('required') || field.getAttribute('aria-required') === 'true',
        placeholder: attr(field, 'placeholder'),
        autocomplete: attr(field, 'autocomplete'),
        hasLabel: info.hasLabel,
        labelSource: info.labelSource,
        accessibleName: info.accessibleName,
      };
    });

    const hasSubmitControl = fieldEls.some((field) => {
      const type = (field.getAttribute('type') ?? '').toLowerCase();
      if (type === 'submit' || type === 'image') return true;
      // <button> defaults to type="submit" inside a form.
      return field.tagName === 'BUTTON' && (type === '' || type === 'submit');
    });

    return {
      index,
      id: attr(formEl, 'id'),
      name: attr(formEl, 'name'),
      action: attr(formEl, 'action'),
      method: attr(formEl, 'method') || 'get',
      hasSubmitControl,
      hasNoValidate: formEl.hasAttribute('novalidate'),
      fields,
    };
  });

  // --- buttons (including role=button and button-like inputs) ---
  const buttons = Array.from(
    document.querySelectorAll(
      'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]',
    ),
  ).map((el) => {
    const buttonText = text(el) || el.getAttribute('value') || '';
    const ariaLabel = attr(el, 'aria-label') || attr(el, 'title');
    // An icon-only button can still be named by its child image's alt text.
    const imgAlt = el.querySelector('img[alt]')?.getAttribute('alt') ?? '';
    return {
      tag: el.tagName.toLowerCase(),
      type: attr(el, 'type'),
      text: buttonText.slice(0, 120),
      ariaLabel: ariaLabel.slice(0, 120),
      hasAccessibleName: Boolean(buttonText.trim() || ariaLabel.trim() || imgAlt.trim()),
      disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
    };
  });

  // --- scripts & stylesheets, flagging render-blocking ones ---
  const scripts = Array.from(document.querySelectorAll('script')).map((el) => {
    const src = attr(el, 'src');
    const isAsync = el.hasAttribute('async');
    const isDefer = el.hasAttribute('defer');
    const isModule = el.getAttribute('type') === 'module';
    return {
      src,
      inline: !src,
      async: isAsync,
      defer: isDefer,
      // A src'd script in <head> with no async/defer/module blocks parsing.
      blocking: Boolean(src) && !isAsync && !isDefer && !isModule && el.closest('head') !== null,
    };
  });

  const stylesheets = Array.from(
    document.querySelectorAll('link[rel="stylesheet" i]'),
  ).map((el) => {
    const media = attr(el, 'media');
    return {
      href: attr(el, 'href'),
      media,
      // Stylesheets block render unless scoped to a non-matching media query.
      blocking: !media || media === 'all' || media === 'screen',
    };
  });

  // --- duplicate ids ---
  const idCounts = new Map<string, number>();
  const withIds = document.querySelectorAll('[id]');
  withIds.forEach((el) => {
    const id = el.getAttribute('id');
    if (!id) return;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  });
  const duplicateIds = Array.from(idCounts)
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }))
    .slice(0, 50);

  return {
    title: document.title?.trim() || null,
    lang: document.documentElement.getAttribute('lang'),
    meta,
    headings,
    links,
    images,
    forms,
    buttons,
    scripts,
    stylesheets,
    duplicateIds,
    elementCount: withIds.length,
    textLength: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().length,
    domNodeCount: document.getElementsByTagName('*').length,
  };
};

export interface ViewportMeasurement {
  documentWidth: number;
  documentHeight: number;
  hasHorizontalOverflow: boolean;
  overflowAmountPx: number;
  overflowingElements: Array<{
    selector: string;
    tag: string;
    overflowPx: number;
    width: number;
    text: string;
  }>;
  tinyTextCount: number;
  tinyTapTargets: Array<{ selector: string; tag: string; width: number; height: number; text: string }>;
  overlappingElements: Array<{ a: string; b: string; overlapArea: number }>;
  offscreenInteractiveCount: number;
}

/**
 * Measures layout problems at the current viewport. Runs in the page.
 *
 * Only visible, laid-out elements are considered — a hidden off-canvas menu
 * legitimately sits outside the viewport and must not be reported as a fault.
 */
export const measureViewportFn = (): ViewportMeasurement => {
  const viewportWidth = document.documentElement.clientWidth;

  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('id');
    if (id) return `${tag}#${id}`;
    const className = (el.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join('.');
    return className ? `${tag}.${className}` : tag;
  };

  const isVisible = (el: Element, rect: DOMRect): boolean => {
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    // Off-canvas drawers are commonly parked far outside the viewport.
    if (rect.right < -50 || rect.bottom < -50) return false;
    return true;
  };

  // --- horizontal overflow ---
  const documentWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body?.scrollWidth ?? 0,
  );
  const overflowAmountPx = Math.max(0, documentWidth - viewportWidth);

  const overflowingElements: ViewportMeasurement['overflowingElements'] = [];
  if (overflowAmountPx > 0) {
    const candidates = document.querySelectorAll('body *');
    for (let i = 0; i < candidates.length && overflowingElements.length < 15; i += 1) {
      const el = candidates[i]!;
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) continue;
      const overflow = rect.right - viewportWidth;
      if (overflow <= 2) continue;
      // Skip an element whose parent already overflows by the same amount —
      // report the outermost cause rather than every descendant.
      const parentRect = el.parentElement?.getBoundingClientRect();
      if (parentRect && parentRect.right - viewportWidth >= overflow - 1) continue;
      overflowingElements.push({
        selector: describe(el),
        tag: el.tagName.toLowerCase(),
        overflowPx: Math.round(overflow),
        width: Math.round(rect.width),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    }
  }

  // --- tiny text ---
  let tinyTextCount = 0;
  const textElements = document.querySelectorAll('p, span, li, td, a, label, small, div');
  for (let i = 0; i < textElements.length && i < 800; i += 1) {
    const el = textElements[i]!;
    // Only count elements holding their own text, not containers.
    const own = Array.from(el.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 3,
    );
    if (!own) continue;
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;
    const fontSize = parseFloat(window.getComputedStyle(el).fontSize);
    if (Number.isFinite(fontSize) && fontSize > 0 && fontSize < 12) tinyTextCount += 1;
  }

  // --- interactive elements: tap targets, overlaps, off-screen ---
  const interactiveEls = Array.from(
    document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]'),
  );

  const tinyTapTargets: ViewportMeasurement['tinyTapTargets'] = [];
  const boxes: Array<{ selector: string; rect: DOMRect }> = [];
  let offscreenInteractiveCount = 0;

  for (const el of interactiveEls) {
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;

    boxes.push({ selector: describe(el), rect });

    if ((rect.width < 24 || rect.height < 24) && tinyTapTargets.length < 20) {
      tinyTapTargets.push({
        selector: describe(el),
        tag: el.tagName.toLowerCase(),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      });
    }

    // Entirely outside the horizontal bounds of the viewport.
    if (rect.left >= viewportWidth || rect.right <= 0) offscreenInteractiveCount += 1;
  }

  // --- overlapping interactive elements ---
  const overlappingElements: ViewportMeasurement['overlappingElements'] = [];
  const limit = Math.min(boxes.length, 120);
  for (let i = 0; i < limit && overlappingElements.length < 10; i += 1) {
    for (let j = i + 1; j < limit && overlappingElements.length < 10; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlapX = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const overlapY = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (overlapX <= 2 || overlapY <= 2) continue;

      const overlapArea = overlapX * overlapY;
      const areaA = a.rect.width * a.rect.height;
      const areaB = b.rect.width * b.rect.height;
      const smaller = Math.min(areaA, areaB);
      // Nesting (a button inside a link) produces total containment; only
      // report partial overlaps, which indicate a genuine collision.
      if (smaller === 0 || overlapArea / smaller > 0.95) continue;
      if (overlapArea / smaller < 0.25) continue;

      overlappingElements.push({
        a: a.selector,
        b: b.selector,
        overlapArea: Math.round(overlapArea),
      });
    }
  }

  return {
    documentWidth,
    documentHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0,
    ),
    hasHorizontalOverflow: overflowAmountPx > 2,
    overflowAmountPx,
    overflowingElements,
    tinyTextCount,
    tinyTapTargets,
    overlappingElements,
    offscreenInteractiveCount,
  };
};

export interface CollectedPerformance {
  ttfbMs?: number;
  domContentLoadedMs?: number;
  loadEventMs?: number;
  lcpMs?: number;
  firstContentfulPaintMs?: number;
  cls?: number;
  totalBlockingTimeMs?: number;
  longTaskCount?: number;
}

/**
 * Reads timing data the browser has already recorded. Paired with an init
 * script (see crawler.ts) that starts observing LCP, CLS and long tasks
 * before any page script runs.
 */
export const collectPerformanceFn = (): CollectedPerformance => {
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;

  const paints = performance.getEntriesByType('paint');
  const fcp = paints.find((entry) => entry.name === 'first-contentful-paint');

  const vitals = (window as unknown as { __qualovixVitals?: {
    lcp: number;
    cls: number;
    tbt: number;
    longTasks: number;
  } }).__qualovixVitals;

  return {
    ttfbMs: nav ? Math.max(0, nav.responseStart - nav.requestStart) : undefined,
    domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : undefined,
    loadEventMs: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : undefined,
    firstContentfulPaintMs: fcp?.startTime,
    lcpMs: vitals?.lcp && vitals.lcp > 0 ? vitals.lcp : undefined,
    cls: vitals?.cls,
    totalBlockingTimeMs: vitals?.tbt,
    longTaskCount: vitals?.longTasks,
  };
};

/**
 * Installed via `addInitScript` so the observers are running before the page's
 * own JavaScript executes — otherwise LCP and early layout shifts are missed.
 *
 * It also shims `__name`. TypeScript build tools that enable esbuild's
 * `keepNames` rewrite `const f = () => {}` into `const f = __name(() => {}, "f")`,
 * and Playwright serialises our extraction functions with `Function.toString()`
 * — so that helper reference travels into the page, where it does not exist.
 * The symptom is silent: `page.evaluate` throws "__name is not defined", the
 * crawler records a warning, and every DOM-derived scanner sees an empty page.
 * Defining it as identity in the page costs nothing and makes the extraction
 * functions safe to serialise regardless of which toolchain compiled them.
 */
export const vitalsInitScript = `
(() => {
  if (typeof globalThis.__name !== 'function') {
    globalThis.__name = (fn) => fn;
  }
  const vitals = { lcp: 0, cls: 0, tbt: 0, longTasks: 0 };
  window.__qualovixVitals = vitals;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        vitals.lcp = Math.max(vitals.lcp, entry.startTime);
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Shifts caused by user input within 500ms do not count towards CLS.
        if (!entry.hadRecentInput) vitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        vitals.longTasks += 1;
        // Total Blocking Time counts only the portion of a task beyond 50ms.
        vitals.tbt += Math.max(0, entry.duration - 50);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
})();
`;
