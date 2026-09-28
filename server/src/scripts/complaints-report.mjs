// Read-only report of what the complaints section has done — for checking it
// is working and for spotting what to improve. Changes nothing, and prints no
// passwords, keys or secrets (only whether each one is set).
//
//   node /var/www/accounts-crm/server/src/scripts/complaints-report.mjs
//
// Loads server/.env itself, like create-user.mjs.
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '../../.env') });

// Imported after the env is loaded: config.js reads it once, on import.
const { query, pool } = await import('../db/pool.js');
const { config, complaintInboxAddress } = await import('../config.js');
const { decorate } = await import('../services/complaintContext.js');
const { listAttachments } = await import('../services/attachments.js');

const set = (v) => (v ? 'set' : 'NOT SET');
const clip = (s, n = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const day = (v) => (v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : v ?? '—');
const out = [];
const p = (...a) => out.push(a.join(' '));

p('=== ACCOUNTS CRM — COMPLAINTS REPORT ===');
p('Generated:', new Date().toISOString());
p('');
p('--- Set-up ---');
p('Mailbox connection (Microsoft Graph):', config.ms.enabled ? `ON, reading ${config.ms.mailbox}` : 'OFF',
  `(tenant ${set(config.ms.tenantId)}, client ${set(config.ms.clientId)}, secret ${set(config.ms.clientSecret)}, mailbox ${set(config.ms.mailbox)})`);
p('Lookback days:', config.ms.lookbackDays);
p('AI (ANTHROPIC_API_KEY):', config.anthropic.enabled ? `ON, model ${config.anthropic.model}` : 'OFF');
p('Sending email (SMTP):', set(process.env.SMTP_USER && process.env.SMTP_PASS));
p('Complaint addresses:', `${config.complaintEmail.prefix}<code>@${config.complaintEmail.domain}`, '· general inbox:', complaintInboxAddress());
const { watchedMailboxes, getSetting } = await import('../services/settings.js');
p('Watched mailboxes:', (await watchedMailboxes()).join(', ') || '(none)');
const lastCheck = await getSetting('email_last_check');
p('Last automatic check:', lastCheck ? `${lastCheck.at} · ${lastCheck.ok ? 'OK' : 'PROBLEM: ' + (lastCheck.errors || []).join(' | ')} · fetched ${lastCheck.fetched}, stored ${lastCheck.stored}, filed ${lastCheck.filed}` : 'never');
const scan = await getSetting('past_scan');
p('Past-complaints search:', scan ? `${scan.status} · read ${scan.read ?? 0}/${scan.threads ?? 0} threads · found ${scan.found ?? 0}${scan.error ? ' · ' + scan.error : ''}` : 'never run');
const cands = (await query(`SELECT status, count(*)::int AS n FROM complaint_import_candidates GROUP BY status`)).rows;
p('Past complaints found:', cands.map((r) => `${r.status} ${r.n}`).join(', ') || 'none');
p('Cron key (REMINDER_CRON_KEY):', set(process.env.REMINDER_CRON_KEY));
const cronFile = '/etc/cron.d/accounts-crm';
if (existsSync(cronFile)) {
  const lines = readFileSync(cronFile, 'utf8').split('\n').filter((l) => /^\S/.test(l) && !l.startsWith('#') && /curl|auto-pull/.test(l));
  p('Scheduled jobs:', lines.length ? '' : 'none found');
  for (const l of lines) p('  ', l.replace(/X-Cron-Key: \S+/, 'X-Cron-Key: <hidden>').replace(/key=[^&"\s]+/, 'key=<hidden>'));
} else {
  p('Scheduled jobs: /etc/cron.d/accounts-crm NOT FOUND — nothing runs automatically');
}
const mig = (await query('SELECT name, applied_at FROM schema_migrations ORDER BY name DESC LIMIT 3')).rows;
p('Latest migrations:', mig.map((m) => m.name).join(', '));
const last = (await query('SELECT max(created_at) AS at, count(*)::int AS n FROM complaint_emails')).rows[0];
p('Emails on file:', last.n, '· last one stored:', day(last.at));

p('');
p('--- Organisations ---');
const orgs = (await query('SELECT * FROM organisations ORDER BY name')).rows;
if (!orgs.length) p('(none)');
for (const o of orgs) {
  p(`* ${o.name} [${o.type}] procedure: ${o.procedure_ref || '—'} · source: ${o.research_status}` +
    ` · checked: ${o.verified_at ? `${o.verified_by} ${day(o.verified_at)}` : 'NO'}`);
  p(`  ack ${o.ack_days ?? 'default'} · stage1 ${o.stage1_response_days ?? 'default'} (from ${o.stage1_clock || 'default'})` +
    ` · stage2 ${o.stage2_response_days ?? 'default'} · ombudsman ${o.ombudsman_name || 'default'}` +
    ` (${o.ombudsman_url || '—'}) · refer after ${o.ombudsman_after_weeks ?? 'default'} wks,` +
    ` within ${o.ombudsman_referral_months ?? 'default'} months of ${o.referral_from || 'default'}`);
  p(`  complaints email: ${o.complaints_email || '—'} · unconfirmed: ${(o.unconfirmed || []).join(', ') || 'none'}`);
}

p('');
p('--- Complaints ---');
const rows = (await query('SELECT * FROM complaints ORDER BY raised_on DESC')).rows;
if (!rows.length) p('(none)');
for (const row of rows) {
  const c = await decorate(row);
  p('');
  p(`### ${c.ref_code} — ${c.subject}`);
  p(`Against: ${c.org_name} [${c.org_type}] · linked org: ${c.organisation_id ? 'yes' : 'NO'} · property: ${c.property || '—'}`);
  p(`State: ${c.state} · stage: ${c.stage} · status: ${c.status} — ${c.label}${c.needs_chasing ? ' · NEEDS CHASING' : ''}`);
  p(`Raised ${c.raised_on} · stage started ${c.stage_started_on || '—'} · acknowledged ${c.acknowledged_on || '—'}` +
    ` · responded ${c.responded_on || '—'} · final response ${c.final_response_on || '—'}`);
  p(`Response due ${c.response_due || '—'}${c.response_due_manual ? ' (typed in)' : ''} · ack due ${c.ack_due || '—'}` +
    ` · can refer from ${c.ombudsman_from || '—'} · refer by ${c.ombudsman_deadline || '—'}`);
  p(`Their ref: ${c.reference || '—'} · address: ${c.email_address}`);
  p(`Timescales that are general defaults: ${(c.rule.defaulted || []).join(', ') || 'none'}`);
  if (c.nextAction) p(`Next step (rules): ${c.nextAction}`);
  p('Checklist:');
  for (const s of c.steps) p(`  - ${s.label}: ${s.date || '—'} [${s.state}] ${s.note || ''}`);
  if (c.ai_review) {
    p(`AI review (${day(c.ai_reviewed_at)}): ${clip(c.ai_review.summary, 600)}`);
    p(`  Recommended: ${clip(c.ai_review.recommended_action, 300)}`);
    if (c.ai_review.next_action) p(`  One-click action: ${JSON.stringify(c.ai_review.next_action)}`);
    if (c.ai_review.email?.subject) p(`  Draft: ${clip(c.ai_review.email.subject, 120)}`);
  } else {
    p(`AI review: none${c.ai_review_error ? ` — last error: ${c.ai_review_error}` : ''}`);
  }
  const emails = (await query('SELECT * FROM complaint_emails WHERE complaint_id = $1 ORDER BY received_at', [c.id])).rows;
  p(`Emails (${emails.length}):`);
  for (const e of emails) {
    const a = e.analysis;
    p(`  - ${day(e.received_at)} ${e.direction} via ${e.match_method} · "${clip(e.subject, 100)}" from ${e.sender_email || '—'}`);
    p(`    status: ${e.reviewed_at ? `${e.reviewed_as} (by ${e.reviewed_by})` : 'NEW — waiting for a person'}` +
      ` · full text: ${e.body_text ? `${e.body_text.length} chars` : 'no'}`);
    if (a) p(`    AI: ${a.kind} · sent ${a.sent_on || '?'} · by ${a.author || '?'} · ${a.confidence} confidence · ${clip(a.summary, 200)}`);
    if (e.analysis_error) p(`    AI error: ${e.analysis_error}`);
    if (e.applied) p(`    Recorded automatically: ${JSON.stringify(e.applied.after)} (was ${JSON.stringify(e.applied.before)})`);
  }
  const docs = await listAttachments(c.id);
  p(`Documents (${docs.length}): ${docs.map((d) => `${d.filename}${d.source_email_id ? ' [from email]' : ''}`).join(' · ') || '—'}`);
  const events = (await query('SELECT * FROM complaint_events WHERE complaint_id = $1 ORDER BY event_date, created_at', [c.id])).rows;
  p(`Timeline (${events.length}):`);
  for (const e of events) p(`  - ${e.event_date} [${e.type}] ${clip(e.note, 250)} — ${e.created_by || '?'}`);
}

p('');
p('--- Emails waiting to be filed ---');
const unfiled = (await query(`SELECT * FROM complaint_emails WHERE complaint_id IS NULL ORDER BY received_at DESC LIMIT 50`)).rows;
if (!unfiled.length) p('(none)');
for (const e of unfiled) {
  p(`- ${day(e.received_at)} via ${e.match_method} "${clip(e.subject, 100)}" from ${e.sender_email || '—'}` +
    (e.analysis ? ` · AI: ${e.analysis.kind}, ${e.analysis.confidence}, ${clip(e.analysis.summary, 150)}` : '') +
    (e.analysis_error ? ` · AI error: ${e.analysis_error}` : ''));
}

console.log(out.join('\n'));
await pool.end();
