const element = id => document.getElementById(id);
const storageKey = 'ip-intelligence-history-v1';
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let history = [];
let current;
let loading = false;
let storageAvailable = true;

try {
  const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
  if (Array.isArray(stored)) history = stored.filter(validResult).slice(0, 50);
} catch {
  storageAvailable = false;
}

function validResult(item) {
  return item && typeof item.ip === 'string' && Number.isInteger(item.score) &&
    item.score >= 0 && item.score <= 100 && Number.isSafeInteger(item.reports) &&
    item.reports >= 0 && [7, 30, 90].includes(item.days) &&
    ['AbuseIPDB', 'Synthetic sample'].includes(item.source) &&
    Number.isFinite(Date.parse(item.checkedAt));
}

const risk = score => score >= 75 ? 'High' : score >= 25 ? 'Moderate' : 'Low';
const date = value => Number.isFinite(Date.parse(value)) ? dateFormatter.format(new Date(value)) : 'Unavailable';

function badge(node, score) {
  const level = risk(score);
  node.className = 'badge ' + level.toLowerCase();
  node.textContent = level;
}

function showResult(item) {
  current = item;
  element('result').hidden = false;
  element('result-title').textContent = item.ip;
  element('result-meta').textContent = item.source + ' / ' + item.days + '-day window / ' + date(item.checkedAt);
  badge(element('risk'), item.score);
  element('score').textContent = item.score;
  element('confidence').value = item.score;
  const facts = [
    ['Abuse reports', item.reports], ['Country code', item.countryCode],
    ['Network provider', item.isp], ['Usage type', item.usageType],
    ['Domain', item.domain], ['Last reported', date(item.lastReportedAt)],
  ];
  element('facts').replaceChildren(...facts.map(([label, value]) => {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value ?? 'Unavailable';
    group.append(term, description);
    return group;
  }));
}

function renderHistory() {
  const query = element('search').value.trim().toLowerCase();
  const filter = element('risk-filter').value;
  const sort = element('sort').value;
  const visible = history.filter(item => {
    const searchable = [item.ip, item.isp, item.domain, item.countryCode, item.source].join(' ').toLowerCase();
    return searchable.includes(query) && (!filter || risk(item.score) === filter);
  });
  if (sort === 'score') visible.sort((a, b) => b.score - a.score);
  if (sort === 'reports') visible.sort((a, b) => b.reports - a.reports);
  element('history-summary').textContent = visible.length + ' of ' + history.length + ' investigations' +
    (storageAvailable ? '' : ' / History is available for this session only.');
  element('table').hidden = !visible.length;
  element('empty').hidden = Boolean(visible.length);
  element('empty').textContent = history.length ? 'No investigations match these filters.' : 'Run an IP lookup or load a sample to start.';
  element('rows').replaceChildren(...visible.map(item => {
    const row = document.createElement('tr');
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'text-button';
    link.textContent = item.ip;
    link.addEventListener('click', () => {
      showResult(item);
      element('result-title').tabIndex = -1;
      element('result-title').focus();
    });
    const flag = document.createElement('span');
    badge(flag, item.score);
    const values = [link, flag, String(item.reports), item.source, date(item.checkedAt)];
    for (const value of values) row.insertCell().append(value);
    return row;
  }));
}

function save(item) {
  history = [item, ...history.filter(entry =>
    entry.ip !== item.ip || entry.days !== item.days || entry.source !== item.source,
  )].slice(0, 50);
  try {
    localStorage.setItem(storageKey, JSON.stringify(history));
    storageAvailable = true;
  } catch {
    storageAvailable = false;
  }
  showResult(item);
  renderHistory();
}

function status(message, error = false) {
  element('status').textContent = message;
  element('status').classList.toggle('error', error);
}

element('lookup').addEventListener('submit', async event => {
  event.preventDefault();
  if (loading) return;
  loading = true;
  element('submit').disabled = true;
  element('sample').disabled = true;
  element('result').hidden = true;
  status('Checking AbuseIPDB reputation...');
  try {
    const query = new URLSearchParams({ ip: element('ip').value.trim(), days: element('days').value });
    const response = await fetch('/api/lookup?' + query, { signal: AbortSignal.timeout(10_000) });
    const item = await response.json().catch(() => null);
    if (response.status === 429 && typeof item?.error !== 'string') {
      status('Too many lookups. Wait a minute and try again.', true);
      return;
    }
    if (!response.ok && typeof item?.error === 'string') {
      status(item.error, true);
      return;
    }
    if (!response.ok || !validResult(item)) {
      status('The dashboard returned an invalid result. Try again.', true);
      return;
    }
    save(item);
    status('Lookup complete.');
  } catch (error) {
    status(error.name === 'TimeoutError' ? 'The lookup timed out. Try again.' : 'The lookup could not be completed. Try again.', true);
  } finally {
    loading = false;
    element('submit').disabled = false;
    element('sample').disabled = false;
  }
});

element('sample').addEventListener('click', () => {
  const samples = [
    { ip: '203.0.113.42', score: 86, reports: 24 },
    { ip: '198.51.100.12', score: 48, reports: 7 },
    { ip: '192.0.2.8', score: 0, reports: 0 },
  ];
  const lastSample = history.find(item => item.source === 'Synthetic sample');
  const lastIndex = samples.findIndex(sample => sample.ip === lastSample?.ip);
  const sample = samples[(lastIndex + 1) % samples.length];
  save({
    ...sample, days: 30, isp: 'Example network', usageType: 'Documentation',
    checkedAt: new Date().toISOString(), source: 'Synthetic sample',
  });
  status('Sample loaded with fictional reputation data.');
});

element('download').addEventListener('click', () => {
  const report = {
    ...current, risk: risk(current.score),
    classification: 'Low 0-24, Moderate 25-74, High 75-100',
    interpretation: 'Use reputation alongside evidence from your own logs.',
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ip-report-' + current.ip.replace(/[^a-f0-9.]/gi, '-') + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

for (const id of ['search', 'risk-filter', 'sort']) element(id).addEventListener('input', renderHistory);
renderHistory();
