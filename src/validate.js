// Small hand-written validator for the submit_report payload.
// Errors are sent back to the model as a tool_result so it can correct itself.

import { CATEGORIES, SEVERITIES, STATUSES } from './raid.js';

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

export function validateReport(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return ['report must be an object'];

  if (!['green', 'amber', 'red'].includes(r.overall_status)) errors.push('overall_status must be green, amber or red');
  for (const k of ['status_rationale', 'summary', 'estimation_notes']) if (!isStr(r[k])) errors.push(`${k} must be a non-empty string`);
  for (const k of ['completed', 'in_progress', 'next', 'raid', 'decisions_needed', 'learnings']) if (!Array.isArray(r[k])) errors.push(`${k} must be an array`);

  for (const k of ['completed', 'in_progress']) {
    (Array.isArray(r[k]) ? r[k] : []).forEach((e, i) => {
      if (!isStr(e?.item)) errors.push(`${k}[${i}].item is required`);
      if (!isStr(e?.evidence)) errors.push(`${k}[${i}].evidence is required`);
    });
  }

  (Array.isArray(r.raid) ? r.raid : []).forEach((e, i) => {
    if (!isStr(e?.title)) errors.push(`raid[${i}].title is required`);
    if (!CATEGORIES.includes(e?.category)) errors.push(`raid[${i}].category must be one of ${CATEGORIES.join(', ')}`);
    if (!SEVERITIES.includes(e?.severity)) errors.push(`raid[${i}].severity must be one of ${SEVERITIES.join(', ')}`);
    if (!STATUSES.includes(e?.status)) errors.push(`raid[${i}].status must be one of ${STATUSES.join(', ')}`);
    if (!isStr(e?.evidence)) errors.push(`raid[${i}].evidence is required`);
  });

  return errors;
}
