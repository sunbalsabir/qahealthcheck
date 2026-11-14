import { pluralize, type ScannerResult } from '@qualovix/shared';
import { FindingCollector } from '../lib/emit';
import type { FormRecord, ScanContext, Scanner } from '../types';

/**
 * Form QA scanner.
 *
 * CRITICAL BEHAVIOURAL CONSTRAINT: this scanner never submits a form, never
 * types into a field, and never activates a control. It inspects structure
 * only. Submitting a stranger's contact, signup, payment or password-reset
 * form would be destructive testing against a third party, which the product
 * forbids outright.
 *
 * Everything below is derived from the DOM the crawler already captured. The
 * scanner's job is to surface structural defects and then hand the functional
 * question to a human: "Form detected - manual functional testing recommended."
 */

/** Field names that indicate a form must never be exercised automatically. */
const DESTRUCTIVE_PURPOSES = new Set([
  'payment',
  'signup',
  'login',
  'password-reset',
  'account-deletion',
  'file-upload',
  'contact',
  'newsletter',
  'checkout',
  'transaction',
]);

export const formsScanner: Scanner = {
  id: 'forms',
  name: 'Form QA',
  category: 'FUNCTIONAL',
  description:
    'Inspects form structure — labels, input types, required fields, submit controls and action targets. Never submits a form.',

  scan(context: ScanContext): ScannerResult {
    const collector = new FindingCollector('forms', 'FUNCTIONAL');
    const { pages } = context.crawl;

    const allForms = pages.flatMap((page) =>
      page.forms.map((form) => ({ form, pageUrl: page.url, pageIsHttps: page.url.startsWith('https:') })),
    );

    if (allForms.length === 0) {
      collector.pass(
        'forms.none-found',
        'No forms required structural review',
        'No HTML forms were discovered on the audited pages.',
      );
      return collector.result();
    }

    for (const { form, pageUrl, pageIsHttps } of allForms) {
      const label = describeForm(form);

      // --- Unlabelled fields: the single most common form defect ---
      const unlabelled = form.fields.filter(
        (field) => field.tag !== 'button' && field.type !== 'hidden' && field.type !== 'submit' && !field.hasLabel,
      );
      if (unlabelled.length > 0) {
        collector.add({
          ruleId: 'forms.missing-labels',
          title: `${unlabelled.length} ${pluralize(unlabelled.length, 'field')} in ${label} ${pluralize(unlabelled.length, 'has', 'have')} no label`,
          description: `${unlabelled.length} input ${pluralize(unlabelled.length, 'field')} in this form have no associated <label>, aria-label or aria-labelledby. Screen reader users hear only the field type, and a placeholder alone disappears as soon as the user starts typing.`,
          severity: unlabelled.length >= form.fields.length / 2 ? 'HIGH' : 'MEDIUM',
          confidence: 'HIGH',
          url: pageUrl,
          selector: form.id ? `#${form.id}` : `form:nth-of-type(${form.index + 1})`,
          evidence: {
            summary: `${unlabelled.length} of ${form.fields.length} fields in ${label} have no accessible label.`,
            observed: unlabelled
              .slice(0, 8)
              .map(
                (f) =>
                  `<${f.tag}${f.type ? ` type="${f.type}"` : ''}${f.name ? ` name="${f.name}"` : ''}>${f.placeholder ? ` placeholder="${f.placeholder}"` : ''} — labelSource: ${f.labelSource ?? 'none'}`,
              )
              .join('\n'),
            expected: 'Every input has a <label for="…">, aria-label or aria-labelledby.',
            details: { formPurpose: form.inferredPurpose, unlabelledCount: unlabelled.length },
          },
          recommendation:
            'Associate a visible <label for="fieldId"> with each input. Placeholders are not a substitute — they vanish on focus and are not reliably announced.',
          impact:
            'Screen reader users cannot tell what to enter, and sighted users lose the field description once they start typing.',
          occurrences: unlabelled.length,
        });
      }

      // --- Email fields using the wrong input type ---
      const wrongEmailType = form.fields.filter(
        (field) =>
          field.tag === 'input' &&
          field.type === 'text' &&
          /e-?mail/i.test(`${field.name ?? ''} ${field.id ?? ''} ${field.placeholder ?? ''}`),
      );
      if (wrongEmailType.length > 0) {
        collector.add({
          ruleId: 'forms.email-input-type',
          title: `Email ${pluralize(wrongEmailType.length, 'field')} in ${label} ${pluralize(wrongEmailType.length, 'uses', 'use')} type="text"`,
          description:
            'A field that collects an email address is declared as type="text". Using type="email" gives free browser-level format validation and, on mobile, an email-optimised keyboard.',
          severity: 'LOW',
          confidence: 'MEDIUM',
          url: pageUrl,
          evidence: {
            summary: `${wrongEmailType.length} email-looking ${pluralize(wrongEmailType.length, 'field')} declared as type="text".`,
            observed: wrongEmailType
              .map((f) => `name="${f.name ?? ''}" id="${f.id ?? ''}" type="text"`)
              .join('\n'),
            expected: 'type="email" with autocomplete="email".',
          },
          recommendation: 'Change these fields to type="email" and add autocomplete="email".',
          impact: 'Users can submit malformed addresses, and mobile users get the wrong keyboard.',
          occurrences: wrongEmailType.length,
        });
      }

      // --- No submit control ---
      if (!form.hasSubmitControl) {
        collector.add({
          ruleId: 'forms.no-submit-control',
          title: `${label} has no visible submit control`,
          description:
            'No submit button or input[type=submit] was found inside this form. It may be submitted by JavaScript, which works for mouse users but can leave keyboard users unable to submit at all.',
          severity: 'MEDIUM',
          confidence: 'MEDIUM',
          url: pageUrl,
          evidence: {
            summary: `${label} contains ${form.fields.length} ${pluralize(form.fields.length, 'field')} but no submit control.`,
            observed: `fields: ${form.fields.map((f) => f.tag).join(', ') || '(none)'}`,
            expected: 'A <button type="submit"> or <input type="submit"> inside the form.',
            details: { formPurpose: form.inferredPurpose },
          },
          recommendation:
            'Add a real submit button. If submission is handled in JavaScript, still use type="submit" so Enter-to-submit and keyboard access work.',
          impact: 'Keyboard-only users may be unable to submit the form.',
        });
      }

      // --- Form posting over plain HTTP from an HTTPS page ---
      if (form.insecureAction && pageIsHttps) {
        collector.add({
          ruleId: 'forms.insecure-action',
          title: `${label} submits over an insecure connection`,
          description:
            'This form is served over HTTPS but its action targets a plain http:// URL, so submitted data would travel unencrypted. Browsers block or warn on this.',
          severity: 'HIGH',
          confidence: 'HIGH',
          url: pageUrl,
          evidence: {
            summary: `Form action points at an http:// URL from an https:// page.`,
            observed: `action="${form.action ?? ''}" method="${form.method ?? 'get'}"`,
            expected: 'The form action uses https:// or a relative path.',
          },
          recommendation: 'Change the form action to an https:// URL or a relative path.',
          impact: 'Data entered by users could be intercepted in transit, and browsers may refuse the submission.',
        });
      }

      // --- Sensitive data over GET ---
      const method = (form.method ?? 'get').toLowerCase();
      const hasSensitive = form.fields.some(
        (f) => f.type === 'password' || /pass|card|cvv|ssn|token/i.test(f.name ?? ''),
      );
      if (method === 'get' && hasSensitive) {
        collector.add({
          ruleId: 'forms.sensitive-data-via-get',
          title: `${label} sends sensitive fields via GET`,
          description:
            'This form uses method="get" while containing a password or similarly sensitive field. GET puts values in the URL, where they are stored in browser history, server logs and Referer headers.',
          severity: 'HIGH',
          confidence: 'HIGH',
          url: pageUrl,
          evidence: {
            summary: 'Form with a sensitive field declares method="get".',
            observed: `method="get", sensitive fields: ${form.fields
              .filter((f) => f.type === 'password' || /pass|card|cvv|ssn|token/i.test(f.name ?? ''))
              .map((f) => f.name ?? f.type ?? f.tag)
              .join(', ')}`,
            expected: 'method="post" for any form carrying sensitive data.',
          },
          recommendation: 'Change the form method to POST.',
          impact: 'Credentials may be written to browser history and server access logs.',
        });
      }

      // --- Nothing marked required ---
      const inputFields = form.fields.filter(
        (f) => f.tag !== 'button' && f.type !== 'hidden' && f.type !== 'submit',
      );
      if (inputFields.length >= 3 && inputFields.every((f) => !f.required) && !form.hasNoValidate) {
        collector.add({
          ruleId: 'forms.no-required-fields',
          title: `No fields in ${label} are marked required`,
          description: `This form has ${inputFields.length} input fields and none carry the required attribute. If validation is applied only in JavaScript, users get no native browser feedback and the form may accept empty submissions.`,
          severity: 'LOW',
          confidence: 'LOW',
          url: pageUrl,
          evidence: {
            summary: `${inputFields.length} fields, none with a required attribute.`,
            observed: inputFields
              .slice(0, 6)
              .map((f) => `${f.tag}${f.type ? `[type=${f.type}]` : ''} name="${f.name ?? ''}"`)
              .join('\n'),
            expected: 'Mandatory fields carry the required attribute.',
          },
          recommendation:
            'Mark genuinely mandatory fields as required so the browser validates them, and keep matching server-side validation.',
          impact: 'Users may submit incomplete forms and see errors only after a round trip.',
        });
      }

      // --- The mandatory hand-off to human QA ---
      collector.add({
        ruleId: 'forms.manual-testing-recommended',
        title: `Form detected — manual functional testing recommended`,
        description: `${label} was found on this page. Automated auditing deliberately does not submit forms, so its actual behaviour — validation messages, error handling, success states, email delivery and data storage — has not been tested. A QA engineer should exercise it manually.`,
        severity: 'INFO',
        confidence: 'HIGH',
        url: pageUrl,
        selector: form.id ? `#${form.id}` : `form:nth-of-type(${form.index + 1})`,
        evidence: {
          summary: `${label} with ${form.fields.length} ${pluralize(form.fields.length, 'field')} detected. Not submitted, by design.`,
          observed: `purpose: ${form.inferredPurpose}; method: ${form.method ?? 'get'}; fields: ${form.fields
            .filter((f) => f.tag !== 'button')
            .map((f) => f.name || f.type || f.tag)
            .slice(0, 10)
            .join(', ')}`,
          expected: 'Form behaviour confirmed by manual functional testing.',
          details: {
            inferredPurpose: form.inferredPurpose,
            fieldCount: form.fields.length,
            notSubmittedReason: DESTRUCTIVE_PURPOSES.has(form.inferredPurpose)
              ? `Automated submission is never performed for ${form.inferredPurpose} forms.`
              : 'Automated submission is never performed against customer forms.',
          },
        },
        recommendation:
          'Include this form in a manual functional test pass: valid and invalid input, required-field behaviour, error message clarity, success confirmation, and confirmation that the submission actually reaches its destination.',
        impact:
          'Form functionality is the most common source of lost leads and cannot be confirmed by automated scanning alone.',
      });
    }

    // --- Passed checks ---
    const formsWithLabels = allForms.filter(({ form }) =>
      form.fields
        .filter((f) => f.tag !== 'button' && f.type !== 'hidden' && f.type !== 'submit')
        .every((f) => f.hasLabel),
    );
    if (formsWithLabels.length === allForms.length) {
      collector.pass(
        'forms.all-labelled',
        'All form fields have associated labels',
        `${allForms.length} ${pluralize(allForms.length, 'form')} inspected, every field labelled.`,
      );
    }
    if (allForms.every(({ form }) => form.hasSubmitControl)) {
      collector.pass(
        'forms.submit-controls-present',
        'All forms have a submit control',
        `${allForms.length} ${pluralize(allForms.length, 'form')} include a submit button.`,
      );
    }
    if (allForms.every(({ form, pageIsHttps }) => !(form.insecureAction && pageIsHttps))) {
      collector.pass(
        'forms.secure-actions',
        'All form submissions target secure endpoints',
        'No form on an HTTPS page posts to a plain http:// action.',
      );
    }

    return collector.result();
  },
};

function describeForm(form: FormRecord): string {
  if (form.inferredPurpose && form.inferredPurpose !== 'unknown') {
    return `the ${form.inferredPurpose} form`;
  }
  if (form.id) return `the form #${form.id}`;
  if (form.name) return `the "${form.name}" form`;
  return `form ${form.index + 1}`;
}
