// Deterministic estimation metrics. The LLM interprets these numbers; it never invents them.
//
// Supported conventions (labels or a line in the issue body):
//   estimate: 4h   est: 2d   estimate/1w      -> planned effort
//   actual: 5h     spent: 1.5d                -> recorded effort
// Units: h = hours, d = 8h day, w = 40h week.

const UNIT_HOURS = { h: 1, d: 8, w: 40 };

function textSources(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l?.name || ''));
  const bodyLines = typeof issue.body === 'string' ? issue.body.split(/\r?\n/).slice(0, 60) : [];
  return [...labels, ...bodyLines];
}

function parseHours(issue, keywords) {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?(?:${keywords})\\s*[:=/]\\s*(\\d+(?:[.,]\\d+)?)\\s*([hdw])\\b`, 'i');
  for (const s of textSources(issue)) {
    const m = re.exec(s);
    if (m) return Number(m[1].replace(',', '.')) * UNIT_HOURS[m[2].toLowerCase()];
  }
  return null;
}

export const parseEstimateHours = (issue) => parseHours(issue, 'estimate|est');
export const parseActualHours = (issue) => parseHours(issue, 'actual|spent');

const round1 = (n) => Math.round(n * 10) / 10;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function estimationStats(issues) {
  const real = (issues || []).filter((i) => !i.pull_request);
  const withEstimate = real.filter((i) => parseEstimateHours(i) != null);

  const closedRows = withEstimate
    .filter((i) => i.state === 'closed' && i.closed_at)
    .map((i) => {
      const estimate = parseEstimateHours(i);
      const actual = parseActualHours(i);
      const cycleDays = (new Date(i.closed_at) - new Date(i.created_at)) / 86_400_000;
      return {
        number: i.number,
        title: i.title,
        estimate_hours: estimate,
        actual_hours: actual,
        accuracy_ratio: actual != null && estimate > 0 ? round1(actual / estimate) : null,
        cycle_time_days: round1(cycleDays),
      };
    });

  const ratios = closedRows.map((r) => r.accuracy_ratio).filter((r) => r != null);
  const openEstimated = withEstimate.filter((i) => i.state === 'open');

  const coverage = real.length ? Math.round((withEstimate.length / real.length) * 100) : 0;
  let note = null;
  if (!real.length) note = 'No issues in the period: planning data lives elsewhere (docs, commits).';
  else if (!withEstimate.length) note = 'No issues carry estimates. Add "estimate: Nh" labels or body lines to enable plan-vs-actual tracking.';
  else if (!ratios.length) note = 'Estimates exist but no recorded actuals. Add "actual: Nh" when closing issues to measure estimation accuracy.';

  return {
    issues_in_period: real.length,
    with_estimate: withEstimate.length,
    estimate_coverage_pct: coverage,
    closed_with_estimate: closedRows.length,
    median_cycle_time_days: closedRows.length ? round1(median(closedRows.map((r) => r.cycle_time_days))) : null,
    median_accuracy_ratio: ratios.length ? round1(median(ratios)) : null,
    open_estimated_hours: round1(openEstimated.reduce((sum, i) => sum + parseEstimateHours(i), 0)),
    closed: closedRows.slice(0, 30),
    note,
  };
}
