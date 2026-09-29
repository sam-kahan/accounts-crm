import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { api, formatDate, todayISO, londonDay, ORG_TYPE_LABEL, accountOrReference, signEmail, plural } from '../api';
import { useAuth } from '../auth.jsx';
import Modal from '../components/Modal.jsx';
import { BounceWarning } from '../components/BouncedEmails.jsx';

const STAGE_LABEL = {
  stage_1: 'Stage 1', stage_2: 'Stage 2', ombudsman: 'Ombudsman',
  resolved: 'Resolved', closed: 'Closed',
};
const EVENT_LABEL = {
  raised: 'Raised', acknowledged: 'Acknowledged', chased: 'Chased / sent',
  response_received: 'Response received', escalated: 'Escalated',
  resolved: 'Resolved', deadline_missed: 'Deadline missed', note: 'Note',
};
// How each checklist state reads, and its colour.
const STEP_STATE = {
  done: ['Done', 'ok'],
  overdue: ['Overdue', 'red'],
  missed: ['Missed', 'red'],
  due: ['Due', 'amber'],
  available: ['Available now', 'green'],
  upcoming: ['Later', 'grey'],
  pending: ['Not dated yet', 'grey'],
  past: ['—', 'grey'],
};
const EMAIL_KIND = {
  acknowledgement: 'Acknowledgement',
  stage1_response: 'Stage 1 response',
  final_response: 'Final response',
  holding_or_extension: 'Holding letter / extension',
  request_for_information: 'Request for information',
  our_email: 'Our email',
  other: 'Email',
};
const REVIEWED_AS = {
  acknowledgement: 'Their acknowledgement',
  response: 'Their response',
  correspondence: 'Correspondence',
  sent: 'Sent',
};

// The dated steps, shared by the buttons and the AI's one-click action. Each
// is taken on one organisation's track: `t` is the complaint itself (the main
// organisation) or one of its further organisations (c.parties). With more
// than one organisation the title names whose step it is.
const theOmbudsman = (name) => (/^the\s/i.test(name || '') ? name : `the ${name || 'ombudsman'}`);
// "just now" / "4 min ago" / "2 hours ago", for how long something has been running.
function sinceText(iso) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!(mins >= 1)) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
}
// A further organisation's row carries its complaint's id; the complaint doesn't.
const partyIdOf = (t) => (t?.complaint_id ? t.id : null);
const withOrg = (t, multi, title) => (multi ? `${title}: ${t.org_name}` : title);
const ACK = (t, multi) => ({
  kind: 'acknowledged', party: partyIdOf(t), title: withOrg(t, multi, 'Record their acknowledgement'),
  intro: 'The date they acknowledged the complaint (the date on their email or letter).',
  defaultNote: 'Acknowledged by the organisation',
});
const RESPONSE = (t, multi) => ({
  kind: 'response_received',
  party: partyIdOf(t),
  title: withOrg(t, multi, t.stage === 'stage_2' ? 'Record their final (Stage 2) response' : 'Record their Stage 1 response'),
  intro: 'The date on their response. Upload the letter or email itself under Documents so it’s on file.',
  defaultNote: t.stage === 'stage_2' ? 'Final (Stage 2) response received' : 'Stage 1 response received',
});
const ESCALATE = (t, multi) => ({
  kind: 'escalate',
  party: partyIdOf(t),
  title: withOrg(t, multi, t.stage === 'stage_1' ? 'Escalate to Stage 2' : `Refer to ${theOmbudsman(t.rule?.ombudsman)}`),
  intro: t.stage === 'stage_1'
    ? 'The date you asked them for Stage 2. Their Stage 2 deadline is counted from it.'
    : `The date you referred the complaint to ${theOmbudsman(t.rule?.ombudsman)}.`,
  noNote: true,
});
const RESOLVE = (t, multi) => ({
  kind: 'resolved', party: partyIdOf(t),
  title: multi ? `Mark ${t.org_name}’s part resolved` : 'Mark the complaint resolved',
  intro: multi
    ? 'The date their part was resolved, and the outcome. The complaint stays open while another organisation’s part of it is still running.'
    : 'The date it was resolved, and the outcome. This is the record of how it ended.',
  defaultNote: 'Complaint resolved', noteLabel: 'Outcome',
});
// The one-line instruction from the AI review. Reviews written before the
// headline existed fall back to the first sentence of the recommended action.
function headlineOf(r) {
  if (!r) return null;
  if (r.headline) return r.headline;
  const a = String(r.recommended_action || '').trim();
  const first = a.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() || a;
  return first.length > 180 ? `${first.slice(0, 177)}…` : first;
}

// Is the review's email to be sent NOW? Not when the step is to wait: then
// it is the follow-up kept ready for if they miss their date. Reviews written
// before "email_now" existed are read from their next action and headline.
function emailIsForNow(r) {
  if (!r?.email?.body) return false;
  if (r.email_now === false) return false;
  if (r.next_action?.type === 'wait') return false;
  // The same "don't send" wording as the server (reviewGuard.js#saysHold).
  if (/^\s*((do not|don['’]t|no need to) (send|chase|email|write|contact|reply|follow)|nothing\b|no action|no further action|not yet\b|wait\b|hold\b)/i.test(r.headline || '')) return false;
  return true;
}

// The email to reply to so a follow-up stays in the same thread: their most
// recent one (not ours, not sent from here).
// With more than one organisation, `t` is the one it is for: only an email
// from THAT organisation (by its complaints address's domain) is replied to,
// so a follow-up to CDER never lands in the Council's thread.
const domainOfAddr = (a) => String(a || '').toLowerCase().split('@')[1] || null;
function replyTarget(c, t = null) {
  const ours = String(c.email_address || '').split('@')[1]?.toLowerCase();
  let theirs = (c.emails || []).filter((e) => e.direction !== 'outbound' &&
    e.sender_email && !(ours && e.sender_email.toLowerCase().endsWith(`@${ours}`)));
  if (t && (c.parties || []).length) {
    const dom = domainOfAddr(t.org_email);
    const own = theirs.filter((e) => dom && domainOfAddr(e.sender_email) === dom);
    if (partyIdOf(t)) theirs = own;
    else {
      // The main organisation: its own address first, else anything that
      // isn't from one of the further organisations.
      const partyDoms = new Set((c.parties || []).map((p) => domainOfAddr(p.org_email)).filter(Boolean));
      theirs = own.length ? own : theirs.filter((e) => !partyDoms.has(domainOfAddr(e.sender_email)));
    }
  }
  return theirs.sort((a, b) => new Date(b.received_at) - new Date(a.received_at))[0] || null;
}

// Is this organisation's part still running? (complaintRules.js#trackOpen)
const trackOpen = (t) => t.state === 'open' && !['resolved', 'closed'].includes(t.stage);

export default function ComplaintDetail() {
  const { id } = useParams();
  // Drafts are signed by whoever is looking at them ("[Name]" → their name).
  const { user: me } = useAuth();
  const navigate = useNavigate();
  const [c, setC] = useState(null);
  const location = useLocation();
  const [msg, setMsg] = useState(location.state?.msg || null);
  // Shown once: cleared from the history entry so a reload or Back doesn't
  // show "Checked. N more to check" again with a stale count.
  useEffect(() => {
    if (location.state?.msg) navigate(location.pathname, { replace: true, state: null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const today = todayISO();
  const [ev, setEv] = useState({ event_date: today, type: 'note', note: '' });

  // AI assistant
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiContext, setAiContext] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState(null);
  // Send email, status check, referral pack, attachments
  const [send, setSend] = useState(null); // {to, cc, subject, body} when composing
  const [sending, setSending] = useState(false);
  const [statusResult, setStatusResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [referral, setReferral] = useState(null);
  const [referralBusy, setReferralBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Long lists show their latest few until asked for the rest, so the page
  // (a phone's especially) isn't thousands of pixels of old emails.
  const [showAll, setShowAll] = useState({});
  const LIMIT = { docs: 5, emails: 6, events: 10 };
  const firstOf = (key, list) => (showAll[key] ? list : list.slice(0, LIMIT[key]));
  const moreButton = (key, list, what) => (list.length > LIMIT[key] ? (
    <div style={{ padding: '10px 16px' }}>
      <button className="btn btn-sm" onClick={() => setShowAll((x) => ({ ...x, [key]: !x[key] }))}>
        {showAll[key] ? `Show the latest ${LIMIT[key]} only` : `Show all ${list.length} ${what}`}
      </button>
    </div>
  ) : null);
  // A dated action (acknowledged / response / escalate / resolved) being recorded.
  const [action, setAction] = useState(null);
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // The date to record for each new email, starting from what the AI read.
  const [emailDates, setEmailDates] = useState({});
  // With more than one organisation: which one each new email is from.
  const [emailParties, setEmailParties] = useState({});
  // Adding (true) or correcting (a party row) a further organisation.
  const [partyForm, setPartyForm] = useState(null);
  // Raising it with the supplier a debt collector acts for (null or {name}).
  const [supplierFor, setSupplierFor] = useState(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  // Moving an organisation to Stage 2 from the request we already sent.
  const [catchingUp, setCatchingUp] = useState(null);

  // Timers started by a button (watching a search or a re-check finish) are
  // stopped when the page is left or another complaint is opened, so one
  // complaint's result can never land on another's page.
  const pollers = useRef(new Set());
  const poll = (fn, ms) => {
    const t = setInterval(fn, ms);
    pollers.current.add(t);
    return t;
  };
  useEffect(() => () => {
    for (const t of pollers.current) clearInterval(t);
    pollers.current.clear();
    setRechecking(false);
    setSearchBusy(false);
  }, [id]);

  const load = () => {
    setLoadError(null);
    return api.complaints
      .get(id)
      .then(setC)
      .catch((e) => setLoadError(e.message));
  };
  // An email going out in the background: look again every few seconds
  // until it has gone (then it is on the complaint, and any escalation done)
  // or failed (then it says so, with Try again).
  const sendingNow = Boolean(c?.outbox?.some((o) => o.status === 'pending' || o.status === 'sending'));
  // Bumped when a look fails, so one blip (a deploy, a dropped connection)
  // can't leave the page saying "Sending…" until it is reloaded.
  const [pollMiss, setPollMiss] = useState(0);
  useEffect(() => {
    if (!sendingNow) return undefined;
    const t = setTimeout(() => {
      api.complaints.get(id).then((fresh) => {
        setC(fresh);
        const was = c.outbox.filter((o) => o.status !== 'failed').map((o) => o.id);
        const still = new Set((fresh.outbox || []).map((o) => o.id));
        const gone = was.filter((x) => !still.has(x));
        if (gone.length) {
          const done = c.outbox.filter((o) => gone.includes(o.id));
          const sup = done.find((o) => o.supplier_name);
          // Moved on by the button, or by the email's own words (a plain Send
          // of the Stage 2 request): said either way.
          const stageOf = (x) => [x.stage, ...(x.parties || []).map((p) => p.stage)].join('|');
          const esc = done.find((o) => o.then_escalate) || stageOf(fresh) !== stageOf(c);
          setMsg(sup
            ? `Sent to ${sup.supplier_name}, and they have been added to this complaint. Their deadlines run from today.`
            : esc ? 'Sent, and the complaint has moved to Stage 2. Their Stage 2 deadline is on the checklist.' : 'Sent, and logged on this complaint.');
        }
      }).catch(() => setPollMiss((n) => n + 1));
    }, 3000);
    return () => clearTimeout(t);
  }, [c, sendingNow, pollMiss]); // eslint-disable-line react-hooks/exhaustive-deps

  // A re-check running in the background (the button, or one started before
  // a reload): look again every few seconds until the server says how it
  // ended — done, failed, or cut off by a restart — and say so.
  const recheckRunning = c?.recheck_progress?.status === 'running';
  const [recheckMiss, setRecheckMiss] = useState(0);
  useEffect(() => {
    if (!recheckRunning) return undefined;
    const t = setTimeout(() => {
      api.complaints.get(id).then((fresh) => {
        setC(fresh);
        const p = fresh.recheck_progress;
        if (p?.status === 'running') return;
        const note = (fresh.events || []).find((e) => /^(Re-check|The re-check|The AI review couldn)/.test(e.note || ''))?.note || '';
        setMsg(p?.status === 'done'
          ? (/^The AI review couldn/.test(note) ? note : `${note || 'Re-checked.'} The AI review below has the next steps.`)
          : p?.status === 'failed' ? `The re-check failed: ${p.error || 'no reason given'}. Nothing was changed; you can press it again.`
          : /^The re-check was cut off/.test(note) ? note
          : 'The re-check was cut off by a server restart before it finished. Press Re-check & update next steps again.');
      }).catch(() => setRecheckMiss((n) => n + 1));
    }, 4000);
    return () => clearTimeout(t);
  }, [c, recheckRunning, recheckMiss]); // eslint-disable-line react-hooks/exhaustive-deps

  async function retryOutbox(o) {
    try { await api.complaints.retryOutbox(id, o.id); await load(); } catch (e) { setMsg(e.message); }
  }
  async function outboxWent(o) {
    if (!confirm(`Record "${o.subject}" as sent? Only if the copy is in utilities@: it won't be sent again.`)) return;
    try {
      await api.complaints.outboxWent(id, o.id);
      await load();
      setMsg('Recorded as sent, and any step it was taken.');
    } catch (e) { setMsg(e.message); }
  }
  async function discardOutbox(o) {
    if (!confirm(`Discard "${o.subject}"? It wasn't sent, and won't be.`)) return;
    try { await api.complaints.discardOutbox(id, o.id); await load(); } catch (e) { setMsg(e.message); }
  }

  // While the review is being brought up to date, look again every few
  // seconds (for up to a minute) so it appears without a reload.
  const stale = Boolean(c && aiEnabled && c.state === 'open' && !c.ai_review_current);
  useEffect(() => {
    if (!stale) return undefined;
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (n > 12) return clearInterval(t);
      api.complaints.get(id).then((fresh) => {
        if (fresh.ai_review_current) { setC(fresh); clearInterval(t); }
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [stale, id]);

  useEffect(() => {
    load();
    api.complaints.aiConfig().then((r) => setAiEnabled(r.enabled)).catch(() => {});
  }, [id]);

  async function runAssistant() {
    setAiBusy(true);
    setMsg(null);
    try {
      const r = await api.complaints.assist(id, { instruction: aiInstruction, context: aiContext });
      setAi(r);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setAiBusy(false);
    }
  }
  function copyText(t) {
    if (t) navigator.clipboard?.writeText(t).catch(() => {});
  }
  // "✓ Copied" on the button pressed, for a moment.
  const [copied, setCopied] = useState(null);
  function flashCopied(what) {
    setCopied(what);
    setTimeout(() => setCopied((w) => (w === what ? null : w)), 2000);
  }
  function copyEmail(em) {
    copyText(signEmail(em.body, me));
    flashCopied('email');
  }
  // Sent from Outlook (and perhaps without copying this complaint's address
  // in): record it on the timeline as sent today, then have the next step
  // worked out again, so it moves on instead of repeating itself.
  const [markingSent, setMarkingSent] = useState(false);
  async function markSent(em, escalate = false, t = null) {
    const on = prompt(escalate
      ? 'The date you sent the Stage 2 request (YYYY-MM-DD). Their Stage 2 deadline counts from it:'
      : 'The date you sent it (YYYY-MM-DD):', todayISO());
    if (!on) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on > todayISO()) { setMsg('Enter the date as YYYY-MM-DD, not in the future.'); return; }
    setMarkingSent(true);
    setMsg(null);
    try {
      await api.complaints.addEvent(id, {
        event_date: on, type: 'chased', party_id: partyIdOf(t),
        note: `Sent the email "${em.subject || 'the drafted email'}" from Outlook${t && multi ? ` to ${t.org_name}` : ''}.`,
      });
      if (escalate) {
        // The send is recorded now; pressing this again would record it
        // twice. So a failed escalation says so and points to the button
        // that does only that.
        try {
          await api.complaints.escalate(id, on, partyIdOf(t));
        } catch (e) {
          await load();
          setMsg(`Recorded as sent, but moving it to Stage 2 failed (${e.message}). Use “Already asked for it? Record it…” to move it on; don't record the email again.`);
          return;
        }
      }
      setC(await api.complaints.refreshReview(id).then(() => api.complaints.get(id)));
      setMsg('Recorded as sent. The next step has been worked out again.');
    } catch (e) {
      setMsg(e.message);
      await load();
    } finally {
      setMarkingSent(false);
    }
  }
  const [savingDraft, setSavingDraft] = useState(false);
  async function saveDraftToTimeline() {
    if (!ai?.email || savingDraft) return;
    setSavingDraft(true);
    try {
      await api.complaints.addEvent(id, {
        event_date: today,
        type: 'note',
        note: `AI draft (not sent): ${ai.email.subject}\n\n${ai.email.body}`,
      });
      await load();
      setMsg('Draft saved to the timeline.');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSavingDraft(false);
    }
  }

  // Open the compose modal, optionally pre-filled from an AI draft.
  // `then: 'escalate'`: the email is the Stage 2 request, so sending it also
  // moves the complaint to Stage 2 (one press, not two).
  function openSend(draft, then = null, t = null) {
    setSend({
      // Their complaints address, or failing that the address their latest
      // email came from.
      to: (t || c).org_email || replyTarget(c, t)?.sender_email || '',
      party_id: partyIdOf(t),
      org_name: t && multi ? t.org_name : null,
      cc: '',
      subject: signEmail(draft?.subject, me) || `Re: ${c.subject} [${c.ref_code}]`,
      body: signEmail(draft?.body || '', me),
      then,
    });
  }
  async function doSend() {
    setSending(true);
    setMsg(null);
    try {
      // Queued at once; it goes out in the background, so nobody waits on
      // the mail server. The banner below follows it until it has gone.
      const r = await api.complaints.sendEmail(id, send);
      setSend(null);
      await load();
      setMsg(r?.escalating
        ? 'Sending now. The complaint moves to Stage 2 as soon as it has gone; you can carry on.'
        : 'Sending now; you can carry on.');
    } catch (e) {
      // Said in the window, not behind it: the page's message is hidden while
      // the email is open.
      setSend((cur) => (cur ? { ...cur, error: e.message } : cur));
    } finally {
      setSending(false);
    }
  }

  async function checkStatus() {
    setChecking(true);
    setMsg(null);
    try {
      const r = await api.complaints.checkStatus(id);
      setStatusResult(r);
      if (r.ombudsman_ready) await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setChecking(false);
    }
  }

  async function buildReferral() {
    setReferralBusy(true);
    setMsg(null);
    try {
      setReferral(await api.complaints.referralPack(id));
    } catch (e) {
      setMsg(e.message);
    } finally {
      setReferralBusy(false);
    }
  }
  function downloadReferral() {
    if (!referral) return;
    const blob = new Blob([referral.text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `referral-${c.ref_code}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function uploadFiles(fileList) {
    if (!fileList?.length) return;
    setUploading(true);
    setMsg(null);
    try {
      await api.complaints.attachments(id, Array.from(fileList));
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setUploading(false);
    }
  }
  async function removeAttachment(attId) {
    if (!confirm('Remove this document from the complaint? It will be deleted.')) return;
    setMsg(null);
    try {
      await api.complaints.removeAttachment(attId);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function syncEmails() {
    setSyncing(true);
    setMsg(null);
    try {
      const r = await api.complaints.fetchEmails();
      await load();
      setMsg(
        `Inbox checked: ${plural(r.inserted, 'new email')} logged` +
          (r.configured ? '.' : ' (test inbox only, as the mailbox connection isn’t configured).'),
      );
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSyncing(false);
    }
  }

  async function reviewEmail(emailId, as, date, partyId = null) {
    setMsg(null);
    try {
      await api.complaints.reviewEmail(id, emailId, as, date, partyId);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function undoEmail(em) {
    if (!confirm('Undo what was recorded automatically from this email? It goes back to “New” for you to decide.')) return;
    setMsg(null);
    try {
      await api.complaints.undoEmail(id, em.id);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  }
  // Search the mailboxes for every reference and account number on it. It
  // runs in the background; the page looks again until it has finished.
  async function searchEmails(all) {
    setSearchBusy(true);
    setMsg(null);
    try {
      await api.complaints.searchEmails(id, all);
      setMsg('Searching the mailboxes. Anything found is added to Emails and noted on the timeline.');
      let n = 0;
      const t = poll(async () => {
        n += 1;
        try {
          const fresh = await api.complaints.get(id);
          if (!fresh.email_search?.running || n > 40) {
            clearInterval(t);
            setC(fresh);
            setSearchBusy(false);
          }
        } catch {
          if (n > 40) { clearInterval(t); setSearchBusy(false); }
        }
      }, 5000);
    } catch (e) {
      setMsg(e.message);
      setSearchBusy(false);
    }
  }
  async function removeParty(p) {
    if (!confirm(`Take ${p.org_name} off this complaint? Its timeline entries and emails stay on the complaint.`)) return;
    setMsg(null);
    try {
      setC(await api.complaints.removeParty(id, p.id).then(() => api.complaints.get(id)));
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function refreshAiReview() {
    setReviewing(true);
    setMsg(null);
    try {
      setC(await api.complaints.refreshReview(id).then(() => api.complaints.get(id)));
    } catch (e) {
      setMsg(e.message);
    } finally {
      setReviewing(false);
    }
  }

  // The button for the AI's recommended step. Each opens the same confirmation
  // as doing it by hand, with the date filled in — nothing happens unconfirmed.
  function actionButton(na) {
    if (!na) return null;
    // With more than one organisation the review can't say whose step it
    // means, so only the email is offered here; the steps are on each
    // organisation's own section below.
    if (c.parties?.length) {
      return na.type === 'send_email' && c.ai_review?.email?.body
        ? <button className="btn-primary btn-sm" onClick={() => openSend(c.ai_review.email)}>Review &amp; send the email…</button>
        : null;
    }
    const stage1 = c.stage === 'stage_1';
    const map = {
      send_email: c.ai_review?.email?.body && ['Review & send the email…', () => openSend(c.ai_review.email)],
      escalate_stage2: stage1 && ['Escalate to Stage 2…', () => setAction(ESCALATE(c))],
      refer_ombudsman: c.stage === 'stage_2' && ['Refer to the ombudsman…', () => setAction(ESCALATE(c))],
      record_acknowledgement: stage1 && !c.acknowledged_on && ['Record their acknowledgement…', () => setAction(ACK(c))],
      record_response: !c.responded_on && ['Record their response…', () => setAction(RESPONSE(c))],
      resolve: ['Mark resolved…', () => setAction(RESOLVE(c))],
    };
    const hit = map[na.type];
    if (!hit) return null;
    return <button className="btn-primary btn-sm" onClick={hit[1]}>{hit[0]}</button>;
  }

  async function addEvent(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.complaints.addEvent(id, ev);
      setEv({ event_date: today, type: 'note', note: '' });
      await load();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Record a dated step. The date matters — it can move their deadlines —
  // so it is always asked for, defaulting to today.
  async function recordAction({ date, note }) {
    const a = action;
    if (a.kind === 'escalate') await api.complaints.escalate(id, date, a.party || null);
    else {
      await api.complaints.addEvent(id, {
        event_date: date, type: a.kind, note: note || a.defaultNote, party_id: a.party || null,
      });
    }
    setAction(null);
    await load();
  }

  async function remove() {
    if (!confirm(
      'Delete this complaint with its timeline, emails and documents? This cannot be undone, and its ' +
      'emails won’t be brought back in.\n\nIf it has been resolved, press Cancel and use “Mark resolved” ' +
      'instead: that keeps the record of how it ended.',
    )) return;
    try {
      await api.complaints.remove(id);
      navigate('/complaints');
    } catch (e) {
      setMsg(e.message);
    }
  }

  if (!c) {
    if (loadError) {
      return (
        <div className="card">
          <div className="inline-note warn" style={{ marginBottom: 12 }}>
            Couldn’t load this complaint: {loadError}
          </div>
          <div className="btn-row">
            <button className="btn-primary btn-sm" onClick={load}>Retry</button>
            <Link to="/complaints" className="btn btn-sm">← Complaints</Link>
          </div>
        </div>
      );
    }
    return <div className="spinner">Loading…</div>;
  }

  const theOmb = theOmbudsman(c.rule?.ombudsman);
  const newEmails = (c.emails || []).filter((e) => e.direction !== 'outbound' && !e.reviewed_at);
  const badgeOf = (t) =>
    t.needs_chasing ? 'red' : t.status === 'responded' || t.status === 'resolved' ? 'ok' : 'amber';
  const statusBadge = badgeOf(c);
  // More than one organisation on it (migration 029): each has its own section.
  const parties = c.parties || [];
  const multi = parties.length > 0;
  const tracks = [c, ...parties];
  // The email a review step comes with: where to send it, the text, and
  // the buttons. `t`: the organisation it is for, with more than one.
  const emailBlock = (r, t = null) => {
    if (!r?.email?.body) return null;
    const em = r.email;
    const later = !emailIsForNow(r);
    const reply = replyTarget(c, t);
    const by = r.next_action?.by;
    const inner = (
      <div id={t ? undefined : 'ai-email'} style={{ marginTop: 14, border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          {later ? 'Nothing to send now. This is the follow-up for if they miss their date' : 'The email to send'}
        </div>
        <ol style={{ margin: '0 0 10px', paddingLeft: 20, fontSize: 14 }}>
          {reply ? (
            <li>
              In Outlook, open their email <strong>“{reply.subject || '(no subject)'}”</strong> from{' '}
              {reply.sender_name || reply.sender_email} ({formatDate(londonDay(reply.received_at))}) and press{' '}
              <strong>Reply all</strong>, so it stays in the same thread.
            </li>
          ) : (
            <li>
              Start a new email to <strong>{(t || c).org_email || 'their complaints address'}</strong>
              {(t || c).org_email && <> <button className="btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => copyText((t || c).org_email)}>Copy address</button></>}.
            </li>
          )}
          <li>
            Copy this in{!reply && <>, with the subject</>}.{' '}
            <span className="muted">
              Copy in <code>{c.email_address}</code> (so their reply files itself here)
              {c.external_cc?.length ? <> and <code>{c.external_cc.join(', ')}</code></> : null} too.
            </span>
          </li>
        </ol>
        {!reply && (
          <div style={{ fontSize: 14, marginBottom: 6 }}>
            <span className="muted">Subject:</span> <strong>{em.subject}</strong>{' '}
            <button className="btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => { copyText(em.subject); flashCopied('subject'); }}>
              {copied === 'subject' ? '✓ Copied' : 'Copy'}
            </button>
          </div>
        )}
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.5, margin: '0 0 10px', background: 'var(--surface-2, #f7f8f5)', padding: 12, borderRadius: 6 }}>
          {signEmail(em.body, me)}
        </pre>
        {(() => {
          const esc = !later && (t || c).stage === 'stage_1' && (!multi || t) &&
            (r.next_action?.type === 'escalate_stage2' || r.email_step === 'stage2_request');
          return (
            <div className="btn-row">
              <button className="btn-primary btn-sm" onClick={() => openSend(em, esc ? 'escalate' : null, t)}>
                {esc ? 'Send it and escalate to Stage 2…' : 'Send it from here…'}
              </button>
              <button className="btn btn-sm" onClick={() => copyEmail(em)}>
                {copied === 'email' ? '✓ Copied' : 'Copy the email'}
              </button>
              <button className="btn btn-sm" disabled={markingSent} onClick={() => markSent(em, esc, t)}
                title="You sent it from Outlook: it's recorded on the timeline and the next step is worked out again">
                {markingSent ? 'Updating the next step…' : esc ? 'Sent it from Outlook: escalate…' : '✓ I sent it from Outlook'}
              </button>
            </div>
          );
        })()}
      </div>
    );
    // Waiting: the follow-up is kept ready but folded away, so
    // nothing on the page suggests sending it today.
    return later ? (
      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          Kept ready: the follow-up to send only if they miss {by ? formatDate(by) : 'their date'}
        </summary>
        {inner}
      </details>
    ) : inner;
  };
  const partyName = (pid) => parties.find((p) => p.id === pid)?.org_name || null;
  // Which organisation an email is from, as the AI read it (author_org), when
  // that names exactly one of them. Otherwise nobody guesses: it is asked.
  const guessTrack = (a) => {
    const said = String(a?.author_org || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!said) return undefined;
    const hits = tracks.filter((t) => {
      const n = t.org_name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return n && (n.includes(said) || said.includes(n));
    });
    return hits.length === 1 ? (partyIdOf(hits[0]) || 'main') : undefined;
  };
  // The step buttons for one organisation's part.
  // `secondary`: under the next step, so these read as "or do it yourself"
  // rather than a second set of instructions.
  // The Stage 2 request for one organisation: the AI's draft when its review
  // has one for them, otherwise a plain one from the facts on file (no AI).
  const stage2Draft = (t) => {
    const i = tracks.findIndex((x) => x.id === t.id);
    const own = multi ? c.ai_review?.by_org?.[i] : c.ai_review;
    if (c.ai_review_current && own?.email?.body && own.email_step === 'stage2_request') return own.email;
    const accounts = (c.account_numbers || []).join(', ');
    const about = [c.property, accounts && `account ${accounts}`, t.reference && `your reference ${t.reference}`].filter(Boolean).join(', ');
    // Quoted as theirs only when their procedure states it: a standard figure
    // filled in for them is never passed off as their rule.
    const days = t.rule?.defaulted?.includes('stage2Days') ? null : t.rule?.stage2Days;
    return {
      subject: `Our complaint of ${formatDate(t.raised_on)}${about ? ` (${about})` : ''}: request for Stage 2 review [${c.ref_code}]`,
      body:
        `Dear ${t.org_name} Complaints Team,\n\n` +
        `Re: ${about || c.subject} (our reference ${c.ref_code})\n\n` +
        `Thank you for your attention to our complaint of ${formatDate(t.raised_on)}. ` +
        `We are not satisfied that it has been resolved. We therefore ask that it is now escalated to Stage 2 ` +
        `of your complaints procedure for an independent review.\n\n` +
        `Please confirm that this has been done and let us have your Stage 2 response` +
        `${days ? ` within ${days} working days, as your procedure sets out` : ' within the time your procedure sets out'}.\n\n` +
        `If you need anything further from us to take this forward, please let us know.\n\nKind regards,\n\n` +
        '[Name]\n[Job title]\nGreenco',
    };
  };

  const trackButtons = (t, secondary = false) => {
    const tAt = t.stage === 'stage_1' || t.stage === 'stage_2';
    if (!trackOpen(t)) return null;
    return (
      <div className="btn-row" style={{ marginTop: 4, alignItems: 'center' }}>
        {secondary && <span className="muted" style={{ fontSize: 12 }}>Or record a step yourself:</span>}
        {t.stage === 'stage_1' && !t.acknowledged_on && !t.responded_on && (
          <button className="btn btn-sm" onClick={() => setAction(ACK(t, multi))}>Record acknowledgement…</button>
        )}
        {tAt && !t.responded_on && (
          <button className="btn btn-sm" onClick={() => setAction(RESPONSE(t, multi))}>Record their response…</button>
        )}
        {t.stage === 'stage_1' && (
          // Asking for Stage 2 IS the email: one press opens it ready to send,
          // and sending it escalates this organisation's part. Recording it
          // without sending is for a request already made from Outlook.
          <>
            <button className={secondary ? 'btn btn-sm' : 'btn-navy btn-sm'} onClick={() => openSend(stage2Draft(t), 'escalate', t)}>
              Send the Stage 2 request…
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setAction(ESCALATE(t, multi))}>
              Already asked for it? Record it…
            </button>
          </>
        )}
        {t.stage === 'stage_2' && (
          <button className={secondary ? 'btn btn-sm' : 'btn-navy btn-sm'} onClick={() => setAction(ESCALATE(t, multi))}>
            Refer to ombudsman…
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setAction(RESOLVE(t, multi))}>Mark resolved…</button>
      </div>
    );
  };

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Link to="/complaints" className="btn-ghost btn-sm">← Complaints</Link>
      </div>
      {msg && <div className="inline-note warn" style={{ marginBottom: 16 }}>{msg}</div>}
      {/* We sent the Stage 2 request but the complaint is still at Stage 1
          (sent before its words were recognised, or from Outlook). */}
      {(c.stage2_missed || []).map((m) => (
        <div key={m.party_id || 'main'} className="inline-note warn" style={{ marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }} role="alert">
          <span>
            <strong>Still at Stage 1{(c.parties || []).length ? ` for ${m.org_name}` : ''}, but your email of {formatDate(m.sent_on)}</strong>{' '}
            “{m.subject || '(no subject)'}” {m.certain ? 'asks for Stage 2.' : 'mentions escalating to Stage 2. If it asked for it,'}{' '}
            Move it to Stage 2 from that date so the deadlines and next steps follow.
          </span>
          <button className="btn-primary btn-sm" disabled={catchingUp !== null}
            onClick={async () => {
              if (!confirm(`Move ${m.org_name} to Stage 2 from ${formatDate(m.sent_on)}? Their Stage 2 deadline runs from that day.`)) return;
              setCatchingUp(m.party_id || 'main');
              try {
                await api.complaints.escalate(id, m.sent_on, m.party_id);
                await load();
                setMsg(`Moved to Stage 2 from ${formatDate(m.sent_on)}. The next steps will update in a couple of minutes.`);
              } catch (e) { setMsg(e.message); } finally { setCatchingUp(null); }
            }}>
            {catchingUp === (m.party_id || 'main') ? 'Moving…' : `Move to Stage 2 from ${formatDate(m.sent_on)}`}
          </button>
        </div>
      ))}
      {/* The last re-check didn't finish (a restart) or failed: said on
          opening the page, not only on the timeline, for three days or until
          the next re-check. */}
      {!msg && !recheckRunning && ['interrupted', 'failed'].includes(c.recheck_progress?.status) &&
        Date.now() - new Date(c.recheck_progress.finished_at || c.recheck_progress.started_at).getTime() < 3 * 86400000 && (
        <div className="inline-note warn" style={{ marginBottom: 16 }}>
          {c.recheck_progress.status === 'failed'
            ? <>The last re-check failed: {c.recheck_progress.error || 'no reason given'}. Nothing was changed.</>
            : <>The last re-check was cut off by a server restart before it finished.</>}
          {' '}Press <strong>Re-check &amp; update next steps</strong> to run it again.
        </div>
      )}
      {recheckRunning && (
        <div className="inline-note" style={{ marginBottom: 16 }} role="status">
          <strong>Re-checking:</strong> {c.recheck_progress.step || 'starting'}…
          {c.recheck_progress.started_at && ` (started ${sinceText(c.recheck_progress.started_at)})`}.
          {' '}This usually takes a minute or two, longer if another email search is running; you can leave this page and come back.
        </div>
      )}
      {(c.outbox || []).map((o) => (
        o.status === 'failed' ? (
          <div key={o.id} className="inline-note warn" style={{ marginBottom: 12 }}>
            <strong>Not sent: “{o.subject}”</strong> to {o.to_addresses.join(', ')}.
            {o.supplier_name ? ` ${o.supplier_name} hasn't been added to the complaint.` : ''}
            <div style={{ fontSize: 13, marginTop: 2 }}>{o.error}</div>
            <div className="btn-row" style={{ marginTop: 6 }}>
              {o.uncertain && (
                <button className="btn-primary btn-sm" onClick={() => outboxWent(o)}>It went: record it</button>
              )}
              <button className={o.uncertain ? 'btn btn-sm' : 'btn-primary btn-sm'} onClick={() => retryOutbox(o)}>Try again</button>
              <button className="btn btn-sm" onClick={() => discardOutbox(o)}>Discard</button>
            </div>
          </div>
        ) : (
          <div key={o.id} className="inline-note" style={{ marginBottom: 12 }}>
            Sending “{o.subject}” to {o.to_addresses.join(', ')}…{o.then_escalate ? ' The complaint moves to Stage 2 once it has gone.' : ''}
            {o.supplier_name ? ` ${o.supplier_name} joins this complaint once it has gone.` : ''}
          </div>
        )
      ))}

      {/* Where it stands, and what to do next */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <div>
            <h2 style={{ fontSize: 19 }}>{c.subject}</h2>
            <div className="muted" style={{ marginTop: 4 }}>
              {multi
                ? <>Against {tracks.map((t) => t.org_name).join(' and ')}</>
                : <>{c.org_name} · {ORG_TYPE_LABEL[c.org_type] || c.org_type}</>}
              {c.property && ` · ${c.property}`}
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-sm" onClick={() => setPartyForm(true)}
              title="The same issue with a second organisation, e.g. the debt collector and the supplier it collects for">
              + Another organisation
            </button>
            {aiEnabled && (
              <button className="btn-primary btn-sm" disabled={rechecking || recheckRunning}
                title="Search your mailboxes by every account number and reference, read all its emails, set its stage and dates from them, and update the AI review's next steps"
                onClick={async () => {
                  if (!confirm('Re-check this complaint and update its next steps?\n\nIt searches your mailboxes for its account numbers and references, reads every email on it, moves its stage and dates to what the emails show (changes can be undone), then updates the AI review with the next steps. It takes a minute or two.')) return;
                  setRechecking(true);
                  setMsg(null);
                  try {
                    await api.complaints.recheck(id);
                    // The page follows it from here (recheck_progress).
                    await load();
                  } catch (e) { setMsg(e.message); }
                  setRechecking(false);
                }}>
                {rechecking || recheckRunning ? 'Re-checking…' : 'Re-check & update next steps'}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit details</button>
            <button className="btn-danger btn-sm" onClick={remove}>Delete</button>
          </div>
        </div>
        <div className="card-body">
          {multi ? (
            // Each organisation's stage is shown with its next step below.
            c.imported ? <div style={{ marginBottom: 12 }}><span className="badge grey">Imported</span></div> : null
          ) : (
            <div className="btn-row" style={{ marginBottom: 12 }}>
              <span className="badge navy">{STAGE_LABEL[c.stage]}</span>
              <span className={`badge ${statusBadge}`}>{c.label}</span>
              {c.imported && <span className="badge grey">Imported</span>}
            </div>
          )}

          {/* More than one organisation: one next step EACH, never mixed.
              The AI's step for that organisation when its review is up to
              date (checked against that organisation's own dates and emails),
              otherwise the one its dates give. */}
          {multi && (
            // Not coloured as a whole: each organisation's badge says whether
            // its part is overdue, so a "wait" line never reads as a warning.
            <div className="inline-note" style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 16, marginBottom: 6 }}><strong>Next steps</strong> (one for each organisation)</div>
              {tracks.map((t, i) => {
                if (!trackOpen(t)) {
                  return (
                    <div key={t.id} className="btn-row" style={{ padding: '8px 0', borderTop: i ? '1px solid var(--border, #e5e7eb)' : 'none' }}>
                      <strong>{t.org_name}</strong>
                      <span className={`badge ${badgeOf(t)}`}>{t.label}</span>
                      <span className="muted">Their part has ended.</span>
                    </div>
                  );
                }
                const own = c.ai_review_current ? c.ai_review?.by_org?.[i] : null;
                const text = own?.headline || t.nextAction;
                const draft = own && c.state === 'open' && emailIsForNow(own) ? own.email : null;
                const esc = Boolean(draft) && t.stage === 'stage_1' &&
                  (own.next_action?.type === 'escalate_stage2' || own.email_step === 'stage2_request');
                return (
                  <div key={t.id} style={{ padding: '8px 0', borderTop: i ? '1px solid var(--border, #e5e7eb)' : 'none' }}>
                    <div className="btn-row" style={{ marginBottom: 2 }}>
                      <strong>{t.org_name}</strong>
                      <span className="badge navy">{STAGE_LABEL[t.stage]}</span>
                      <span className={`badge ${badgeOf(t)}`}>{t.label}</span>
                    </div>
                    <div style={{ fontSize: 15 }}>{text || 'Nothing to do yet.'}</div>
                    {draft && (
                      <div className="btn-row" style={{ marginTop: 6 }}>
                        <button className="btn-primary btn-sm" onClick={() => openSend(draft, esc ? 'escalate' : null, t)}>
                          {esc ? `Send it and escalate ${t.org_name} to Stage 2…` : `Send it to ${t.org_name}…`}
                        </button>
                        <button className="btn btn-sm" onClick={() => copyEmail(draft)}>
                          {copied === 'email' ? '✓ Copied' : 'Copy the email'}
                        </button>
                        <button className="btn btn-sm" disabled={markingSent} onClick={() => markSent(draft, esc, t)}>
                          {markingSent ? 'Updating…' : esc ? 'Sent it from Outlook: escalate…' : '✓ I sent it from Outlook'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* One next step: the AI's when its review is up to date, otherwise
              the one worked out from the deadlines. */}
          {!multi && (() => {
            const aiStep = c.ai_review_current && headlineOf(c.ai_review);
            // Without the AI's view, each organisation's own next step, named.
            const text = aiStep || (multi
              ? tracks.filter((t) => t.nextAction).map((t) => `${t.org_name}: ${t.nextAction}`).join(' ')
              : c.nextAction);
            if (!text) return null;
            const live = aiStep && c.state === 'open';
            // The email is offered here only when it is to be sent now; while
            // the step is to wait, it stays folded in the review below.
            const draft = live && emailIsForNow(c.ai_review) ? c.ai_review.email : null;
            // The email is offered right here whenever there is one; a step
            // that isn't an email gets its own button too.
            const btn = live && c.ai_review.next_action?.type !== 'send_email' ? actionButton(c.ai_review.next_action) : null;
            // Asking for Stage 2 is done BY the email: one button for both.
            const withEscalate = Boolean(draft) && !multi && c.stage === 'stage_1' &&
              (c.ai_review.next_action?.type === 'escalate_stage2' || c.ai_review.email_step === 'stage2_request');
            return (
              <div className={`inline-note ${c.any_needs_chasing ? 'warn' : ''}`} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 16 }}><strong>Next step:</strong> {text}</div>
                {(draft || btn) && (
                  <div className="btn-row" style={{ marginTop: 8 }}>
                    {draft && withEscalate ? (
                      // The email IS the Stage 2 request: one press sends it
                      // and escalates.
                      <>
                        <button className="btn-primary btn-sm" onClick={() => openSend(draft, 'escalate')}>
                          Send it and escalate to Stage 2…
                        </button>
                        <button className="btn btn-sm" onClick={() => copyEmail(draft)}>
                          {copied === 'email' ? '✓ Copied' : 'Copy the email'}
                        </button>
                        <button className="btn btn-sm" disabled={markingSent} onClick={() => markSent(draft, true)}>
                          {markingSent ? 'Updating…' : 'Sent it from Outlook: escalate…'}
                        </button>
                      </>
                    ) : draft ? (
                      <>
                        <button className="btn-primary btn-sm" onClick={() => openSend(draft)}>Send it from here…</button>
                        <button className="btn btn-sm" onClick={() => copyEmail(draft)}>
                          {copied === 'email' ? '✓ Copied' : 'Copy the email'}
                        </button>
                        <button className="btn btn-sm" disabled={markingSent} onClick={() => markSent(draft)}>
                          {markingSent ? 'Updating…' : '✓ I sent it from Outlook'}
                        </button>
                      </>
                    ) : btn}
                  </div>
                )}
              </div>
            );
          })()}

          <div className="form-grid">
            <Info label="Raised" value={formatDate(c.raised_on)} />
            {(() => {
              const k = accountOrReference(c);
              return (
                <Info
                  label={k.isReference ? 'Account number (none: their reference)' : 'Account number'}
                  value={k.values.length ? (
                    <span>
                      <strong style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{k.values.join(', ')}</strong>{' '}
                      <button className="btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => copyText(k.values.join(', '))}>Copy</button>
                    </span>
                  ) : '—'}
                />
              );
            })()}
            <Info label="Our reference" value={c.ref_code} />
            {multi
              ? tracks.map((t) => (
                <Info key={t.id} label={`${t.org_name}’s reference`} value={t.reference || '—'} />
              ))
              : <Info label="Their reference" value={c.reference || '—'} />}
            <Info label="Sent by" value={c.channel || '—'} />
            <Info label="Email address for this complaint" value={
              <span style={{ wordBreak: 'break-all' }}>
                {c.email_address}{' '}
                <button className="btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => copyText(c.email_address)}>Copy</button>
              </span>
            } />
          </div>

          {/* One organisation: its steps are here. More than one: each
              organisation's steps are in its own section below. */}
          {!multi && trackButtons(c, true)}
        </div>
      </div>

      <BounceWarning list={c.bounces} onDone={load} />

      {/* Against a debt collector: the debt is the supplier's, so the
          complaint goes to them too and is joined to this one. Suggested by
          the AI review (it names the supplier) or by the collector's type. */}
      {(() => {
        const onIt = (n) => tracks.some((t) => {
          const a = String(t.org_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const b = String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return a && b && (a.includes(b) || b.includes(a));
        });
        const suggested = c.ai_review?.supplier?.name && !onIt(c.ai_review.supplier.name) ? c.ai_review.supplier : null;
        const collector = tracks.find((t) => t.org_type === 'debt_collector');
        const hasSupplier = tracks.some((t) => t.org_type !== 'debt_collector');
        if (c.state !== 'open' || (!suggested && !(collector && !hasSupplier))) return null;
        return (
          <div className="inline-note warn" style={{ marginBottom: 20 }}>
            <strong>Raise it with {suggested ? suggested.name : 'the supplier'} too.</strong>{' '}
            {suggested?.why || `${collector.org_name} is collecting a debt that belongs to the supplier: they issue the bill and can recall the account from collection.`}{' '}
            The AI drafts the complaint to them; once it’s sent they join this complaint with their own deadlines.
            <div style={{ marginTop: 8 }}>
              <button className="btn-primary btn-sm" onClick={() => setSupplierFor({ name: suggested?.name || '' })}>
                Raise it with {suggested ? suggested.name : 'the supplier'}…
              </button>
            </div>
          </div>
        );
      })()}

      {/* An email says it has been put right: confirm, or say it isn't yet.
          Never closed without a person. */}
      {c.resolution_suggested && (() => {
        const r = c.resolution_suggested;
        const onTrack = r.party_id ? parties.find((p) => p.id === r.party_id) : null;
        const choices = onTrack ? [onTrack] : multi ? tracks.filter(trackOpen) : [c];
        return (
          <div className="inline-note" style={{ marginBottom: 20, borderLeft: '4px solid var(--green, #a2c533)' }}>
            <div style={{ fontSize: 16 }}>
              <strong>✅ Looks resolved{onTrack ? ` with ${onTrack.org_name}` : ''}.</strong>{' '}
              {r.by_us ? 'Our' : 'Their'} email{r.subject ? <> “{r.subject}”</> : null}
              {r.on ? <> of {formatDate(r.on)}</> : null} says{' '}
              {r.outcome ? <strong>{r.outcome}</strong> : 'it has been put right'}.
            </div>
            <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
              Check it did what was asked, then confirm. Nothing is closed until you do.
            </div>
            <div className="btn-row">
              {choices.map((t) => (
                <button key={t.id} className="btn-primary btn-sm" onClick={() => setAction({
                  ...RESOLVE(t, multi), date: r.on && r.on <= todayISO() ? r.on : todayISO(), noteValue: r.outcome || '',
                })}>
                  {multi ? `Mark ${t.org_name}’s part resolved…` : 'Yes, mark it resolved…'}
                </button>
              ))}
              <button className="btn btn-sm" onClick={async () => {
                const why = prompt('Not resolved yet. What is still outstanding? (optional)', '');
                if (why === null) return;
                try { setC(await api.complaints.notResolved(id, why)); } catch (e) { setMsg(e.message); }
              }}>
                Not resolved yet
              </button>
            </div>
          </div>
        );
      })()}

      {/* What the last re-check against the emails changed, with Undo. */}
      {c.last_recheck?.after && (
        <div className="inline-note" style={{ marginBottom: 20 }}>
          <strong>Re-checked against its emails</strong> on{' '}
          {new Date(c.last_recheck.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}:{' '}
          {Object.entries(c.last_recheck.after).filter(([k]) => k !== 'response_due_manual')
            .map(([k, v]) => `${k.replace(/_/g, ' ')} ${c.last_recheck.before?.[k] ?? 'blank'} → ${v ?? 'blank'}`).join('; ')}.
          {' '}The details are on the timeline.{' '}
          <button className="btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={async () => {
            if (!confirm('Undo what the re-check changed? The values it replaced are put back.')) return;
            try { setC(await api.complaints.undoRecheck(id).then(() => api.complaints.get(id))); } catch (e) { setMsg(e.message); }
          }}>Undo</button>
        </div>
      )}

      {/* Their own procedure isn't known yet (typically an organisation an
          import set up with only a name): every date here is the standard
          one, so say so before anyone relies on it. */}
      {c.unresearched_orgs?.length > 0 && (
        <div className="inline-note warn" style={{ marginBottom: 20 }} role="alert">
          <strong>⚠ Complaints procedure not researched yet{c.imported ? ' (this complaint was imported before it was)' : ''}.</strong>{' '}
          {[c, ...(c.parties || [])].filter((t) => t.procedure_missing && c.unresearched_orgs.includes(t.org_name)).map((t, i) => (
            <span key={t.id}>
              {i > 0 && ' '}
              {t.organisation_id
                ? <>The dates for <Link to={`/organisations?open=${t.organisation_id}`}>{t.org_name}</Link> use the standard timescales for {t.rule?.kind || 'this kind of organisation'}, not their own rules, so they may be wrong.</>
                : <>{t.org_name} isn’t linked to a saved organisation (use Edit details to link it), so its dates use the standard timescales for {t.rule?.kind || 'this kind of organisation'}.</>}
            </span>
          ))}
          {' '}Research the organisation (or upload their procedure document) on the Organisations page and tick “checked”: this complaint’s dates then update by themselves.
        </div>
      )}
      {c.needs_check && (
        <div className="inline-note warn" style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span>
            <strong>To check:</strong> the system created this from emails by itself. Look over the
            organisation, dates and timeline (use Edit details for anything wrong), then confirm.
          </span>
          <button className="btn-primary btn-sm" onClick={async () => {
            try {
              const r = await api.complaints.markChecked(id);
              // Straight on to the next one waiting, so a batch is quick to go through.
              if (r?.next_to_check) {
                navigate(`/complaints/${r.next_to_check}`, { state: { msg: `Checked. ${r.left_to_check} more to check, starting with this one.` } });
              } else {
                await load();
                setMsg('Checked. That was the last one to check.');
              }
            } catch (e) { setMsg(e.message); }
          }}>
            Looks right, next ›
          </button>
        </div>
      )}

      {/* The assistant's standing review: what to do (one line), the email
          ready to copy, and the reasons folded away. */}
      {aiEnabled && (
        <div id="ai-review" className="card" style={{ marginBottom: 20, borderTop: '3px solid var(--navy, #1e2235)' }}>
          <div className="card-head">
            <h2>✨ What to do next</h2>
            <div className="btn-row">
              {c.ai_reviewed_at && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Updated {new Date(c.ai_reviewed_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              )}
              <button className="btn btn-sm" onClick={refreshAiReview} disabled={reviewing}>
                {reviewing ? 'Reviewing…' : 'Refresh'}
              </button>
            </div>
          </div>
          <div className="card-body">
            {!c.ai_review ? (
              <div className="muted" style={{ fontSize: 13 }}>
                {c.ai_review_error
                  ? <>The last review failed ({c.ai_review_error}). Press Refresh to try again.</>
                  : <>The assistant reviews each complaint automatically after every change. Press Refresh to review it now.</>}
              </div>
            ) : (
              <>
                {multi ? (
                  <div style={{ fontSize: 15 }} className="muted">
                    {tracks.length} organisations, each with its own complaint and its own next step:
                  </div>
                ) : (
                  <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.4 }}>{headlineOf(c.ai_review)}</div>
                )}
                {!c.ai_review_current && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Something has changed since this was written, so it’s being updated…
                  </div>
                )}

                {multi ? (
                  c.ai_review_current && Array.isArray(c.ai_review.by_org) && tracks.map((t, i) => {
                    const own = c.ai_review.by_org[i];
                    if (!own || !trackOpen(t)) return null;
                    return (
                      <div key={t.id} style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border, #e5e7eb)' }}>
                        <div style={{ fontWeight: 700 }}>{t.org_name}</div>
                        <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>{own.headline}</div>
                        {emailBlock(own, t)}
                      </div>
                    );
                  })
                ) : emailBlock(c.ai_review)}

                <details style={{ marginTop: 14 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Why, and the full picture</summary>
                  <p>{c.ai_review.summary}</p>
                  {c.ai_review.steps?.length > 0 && (
                    <ol style={{ margin: '0 0 10px', paddingLeft: 20 }}>
                      {c.ai_review.steps.map((st, i) => <li key={i} style={{ marginBottom: 4 }}>{st}</li>)}
                    </ol>
                  )}
                  {c.ai_review.caution && (
                    <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                      <strong>Check:</strong> {c.ai_review.caution}
                    </div>
                  )}
                </details>
                <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  Written by AI from this complaint’s procedure, emails and documents. Check any figure or
                  date before relying on it. Nothing is sent unless you send it.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Emails that arrived and haven't been looked at */}
      {newEmails.length > 0 && (
        <div className="card" style={{ marginBottom: 20, borderTop: '3px solid var(--warn)' }}>
          <div className="card-head">
            <h2>New email{newEmails.length === 1 ? '' : 's'} to review <span className="badge amber">{newEmails.length}</span></h2>
          </div>
          <div className="card-body">
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              These need a quick check. Confirm what each one is and the date on their email. The
              deadlines update from that date.
            </p>
            {newEmails.map((em) => {
              const a = em.analysis;
              const arrived = londonDay(em.received_at);
              const date = emailDates[em.id] ?? (a?.sent_on || arrived);
              // Whose step it would be: the only organisation, or the one chosen
              // (starting from the AI's reading when it names exactly one).
              const pick = multi ? (emailParties[em.id] ?? guessTrack(a)) : 'main';
              const tr = pick === 'main' ? c : parties.find((p) => p.id === pick) || null;
              return (
                <div key={em.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
                  <strong>{em.subject || '(no subject)'}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {em.sender_name || em.sender_email} · arrived {formatDate(arrived)}
                  </div>
                  {a ? (
                    <div className="inline-note" style={{ marginTop: 6 }}>
                      <strong>AI reads this as:</strong> {EMAIL_KIND[a.kind] || 'Email'}
                      {a.author && <> from {a.author}</>}
                      {a.sent_on && <>, sent {formatDate(a.sent_on)}</>}
                      {a.forwarded && ' (forwarded)'}. {a.summary}
                      {['low', 'medium'].includes(a.confidence) && <div style={{ fontSize: 12, marginTop: 2 }}>Not certain ({a.confidence} confidence), so please check.</div>}
                    </div>
                  ) : (
                    em.body_preview && <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{em.body_preview}</div>
                  )}
                  <div className="btn-row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
                    <label className="field" style={{ margin: 0, maxWidth: 180 }}>
                      <span className="lbl" style={{ fontSize: 12 }}>Date on their email</span>
                      <input type="date" value={date} max={today}
                        onChange={(e) => setEmailDates((d) => ({ ...d, [em.id]: e.target.value }))} />
                    </label>
                    {multi && (
                      <label className="field" style={{ margin: 0, maxWidth: 200 }}>
                        <span className="lbl" style={{ fontSize: 12 }}>Which organisation is it from?</span>
                        <select value={pick || ''}
                          onChange={(e) => setEmailParties((d) => ({ ...d, [em.id]: e.target.value || undefined }))}>
                          <option value="">— Choose —</option>
                          {tracks.map((t) => (
                            <option key={t.id} value={partyIdOf(t) || 'main'}>{t.org_name}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {tr && tr.stage === 'stage_1' && !tr.acknowledged_on && trackOpen(tr) && (
                      <button className={`btn btn-sm ${a?.kind === 'acknowledgement' ? 'btn-primary' : ''}`}
                        onClick={() => reviewEmail(em.id, 'acknowledgement', date, partyIdOf(tr))}>
                        Their acknowledgement
                      </button>
                    )}
                    {tr && (tr.stage === 'stage_1' || tr.stage === 'stage_2') && trackOpen(tr) && (
                      <button className={`btn btn-sm ${a?.kind === 'stage1_response' || a?.kind === 'final_response' ? 'btn-primary' : ''}`}
                        onClick={() => reviewEmail(em.id, 'response', date, partyIdOf(tr))}>
                        Their {tr.stage === 'stage_2' ? 'final' : 'Stage 1'} response
                      </button>
                    )}
                    <button className="btn-ghost btn-sm" onClick={() => reviewEmail(em.id, 'correspondence', date)}>
                      Just correspondence
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Their procedure, step by step: one section per organisation, each
          with its own reference, dates and steps. */}
      {multi ? tracks.map((t) => (
        <ProcedureCard key={t.id} c={t}
          title={`${t.org_name}${partyIdOf(t) ? '' : ' (main organisation)'}: complaints procedure`}
          head={
            <>
              <div className="form-grid">
                {t.relationship && <Info label="How they’re involved" value={t.relationship} />}
                <Info label="Their reference" value={t.reference || '—'} />
                <Info label="Complaint made to them" value={formatDate(t.raised_on)} />
                <Info label="Where it stands" value={
                  <><span className="badge navy">{STAGE_LABEL[t.stage]}</span>{' '}
                    <span className={`badge ${badgeOf(t)}`}>{t.label}</span></>
                } />
              </div>
              {(() => {
                // The same step as the top of the page: the AI's for this
                // organisation while its review is current, else the dates'.
                const own = c.ai_review_current ? c.ai_review?.by_org?.[tracks.findIndex((x) => x.id === t.id)]?.headline : null;
                const step = own || t.nextAction;
                return step ? (
                  <div className={`inline-note ${t.needs_chasing ? 'warn' : ''}`} style={{ marginBottom: 10 }}>
                    <strong>Next step with {t.org_name}:</strong> {step}
                  </div>
                ) : null;
              })()}
              <div className="btn-row" style={{ marginBottom: 12 }}>
                {trackButtons(t)}
                {partyIdOf(t) && (
                  <>
                    <button className="btn-ghost btn-sm" onClick={() => setPartyForm(t)}>Edit {t.org_name}’s details</button>
                    <button className="btn-ghost btn-sm" onClick={() => removeParty(t)}>Take off this complaint</button>
                  </>
                )}
              </div>
            </>
          }
        />
      )) : <ProcedureCard c={c} />}

      {/* Documents */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>
            Documents{' '}
            {c.attachments?.length > 0 && <span className="badge navy">{c.attachments.length}</span>}
          </h2>
          <label className="btn btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
            {uploading ? 'Uploading…' : '+ Upload'}
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              disabled={uploading}
              onChange={(e) => uploadFiles(e.target.files)}
            />
          </label>
        </div>
        {c.attachments?.length ? (
          <table>
            <tbody>
              {firstOf('docs', c.attachments).map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={api.complaints.attachmentUrl(a.id)} target="_blank" rel="noreferrer">
                      {a.filename}
                    </a>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {(a.size_bytes / 1024).toFixed(0)} KB
                      {a.source_email_id ? ` · attached to ${a.copies > 1 ? `${a.copies} emails (shown once)` : 'an email'}` : a.copies > 1 ? ` · on file ${a.copies} times (shown once)` : ''}
                      {a.ai_readable ? ' · read by the AI assistant' : ' · not readable by the AI'}
                    </div>
                  </td>
                  <td className="due" style={{ width: 120 }}>{formatDate((a.uploaded_at || '').slice(0, 10))}</td>
                  <td style={{ textAlign: 'right', width: 40 }}>
                    <button
                      className="btn-ghost btn-sm"
                      aria-label={`Remove document ${a.filename}`}
                      onClick={() => removeAttachment(a.id)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            No documents yet. Upload the letters, emails (saved as PDF), statements and photos. Every
            one is kept here as the record, and PDFs, photos, Word and text files are read by the AI
            assistant.
          </div>
        )}
        {moreButton('docs', c.attachments || [], 'documents')}
      </div>

      {/* Emails */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>
            Emails{' '}
            {c.emails?.length > 0 && <span className="badge navy">{c.emails.length}</span>}
          </h2>
          <div className="btn-row">
            <button className="btn-primary btn-sm" onClick={() => openSend(null)}>Compose</button>
            <button className="btn btn-sm" onClick={syncEmails} disabled={syncing}>
              {syncing ? 'Checking…' : 'Check inbox now'}
            </button>
          </div>
        </div>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <EmailSearch s={c.email_search} busy={searchBusy} onSearch={searchEmails} />
          <div className="inline-note" style={{ marginBottom: 12 }}>
            <strong>This complaint’s email address:</strong>{' '}
            <code style={{ fontWeight: 600, wordBreak: 'break-all' }}>{c.email_address}</code>{' '}
            <button className="btn-ghost btn-sm" onClick={() => copyText(c.email_address)}>Copy</button>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Forward anything about this complaint to it, and copy it in whenever you email
              them, so their replies arrive here by themselves. Each email is read in full, its
              attachments saved, and their acknowledgement or response recorded on the date they
              sent it.
            </div>
          </div>
        </div>
        {c.emails?.length ? (
          <table>
            <tbody>
              {firstOf('emails', c.emails).map((em) => (
                <tr key={em.id}>
                  <td className="due" style={{ width: 120 }}>
                    {formatDate(londonDay(em.received_at))}
                  </td>
                  <td>
                    <strong>{em.subject || '(no subject)'}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {em.sender_name || em.sender_email}
                      {em.analysis?.forwarded && em.analysis?.author && <> · forwarded, originally from {em.analysis.author}</>}
                      {em.analysis?.sent_on && <> · sent {formatDate(em.analysis.sent_on)}</>}
                    </div>
                    {em.analysis?.summary ? (
                      <div style={{ fontSize: 13, marginTop: 2 }}>{em.analysis.summary}</div>
                    ) : em.body_preview && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{em.body_preview}</div>
                    )}
                    {em.applied && (
                      <div className="inline-note" style={{ marginTop: 6, fontSize: 12, padding: '6px 10px' }}>
                        Recorded automatically
                        {em.applied.after?.acknowledged_on && <>: acknowledged {formatDate(em.applied.after.acknowledged_on)}</>}
                        {em.applied.after?.responded_on && <>: responded {formatDate(em.applied.after.responded_on)}</>}
                        {em.applied.after?.stage === 'stage_2' && <>: moved to Stage 2 from {formatDate(em.applied.after.stage_started_on)} (our Stage 2 request)</>}
                        {em.applied.after?.stage === 'ombudsman' && <>: referred to the ombudsman on {formatDate(em.applied.after.stage_started_on)}</>}
                        {em.applied.after?.reference && <> · their reference {em.applied.after.reference}</>}
                        {em.applied.party_id && partyName(em.applied.party_id) && <> · for {partyName(em.applied.party_id)}</>}
                        .{' '}
                        <button className="btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => undoEmail(em)}>Undo</button>
                      </div>
                    )}
                    {em.body_text && (
                      <details style={{ marginTop: 4 }}>
                        <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>Show the full email</summary>
                        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, margin: '6px 0' }}>{em.body_text}</pre>
                      </details>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {em.direction === 'outbound' ? (
                      <span className="badge navy">Sent</span>
                    ) : em.reviewed_at ? (
                      <span className="badge grey" title={em.reviewed_by ? `Marked by ${em.reviewed_by}` : ''}>
                        {em.analysis?.kind === 'our_email' ? 'Our email' : REVIEWED_AS[em.reviewed_as] || 'Reviewed'}
                      </span>
                    ) : (
                      <span className="badge amber">New</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No emails logged yet.</div>
        )}
        {moreButton('emails', c.emails || [], 'emails')}
      </div>

      {/* Timeline */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head"><h2>Timeline</h2></div>
        <div className="card-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            The full record: every step, email and correction, with who recorded it. Add phone calls
            and anything else that happened here.
          </p>
          <form onSubmit={addEvent} className="form-grid" style={{ alignItems: 'end' }}>
            <label className="field">
              <span className="lbl">Date</span>
              <input type="date" value={ev.event_date} onChange={(e) => setEv({ ...ev, event_date: e.target.value })} required />
            </label>
            <label className="field">
              <span className="lbl">What happened</span>
              <select value={ev.type} onChange={(e) => setEv({ ...ev, type: e.target.value })}>
                <option value="note">Note (e.g. a phone call)</option>
                <option value="chased">Chased them</option>
                <option value="deadline_missed">They missed a deadline</option>
              </select>
            </label>
            <label className="field full">
              <span className="lbl">Details</span>
              <input value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })}
                placeholder="Who you spoke to, what was said or agreed" />
            </label>
            <div className="full" style={{ textAlign: 'right' }}>
              <button className="btn-primary btn-sm" disabled={busy}>{busy ? 'Adding…' : 'Add to timeline'}</button>
            </div>
          </form>

          {c.events?.length ? (
            <table className="timeline-table" style={{ marginTop: 8 }}>
              <tbody>
                {firstOf('events', c.events).map((e) => (
                  <tr key={e.id}>
                    <td className="due" style={{ width: 120 }}>{formatDate(e.event_date)}</td>
                    <td style={{ width: 150 }}>
                      <span className="badge grey">{EVENT_LABEL[e.type] || e.type}</span>
                      {e.party_name && <div style={{ marginTop: 4 }}><span className="badge navy">{e.party_name}</span></div>}
                    </td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>
                      {e.note}
                      {e.created_by && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {e.created_by} · {new Date(e.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No events yet.</div>
          )}
          {moreButton('events', c.events || [], 'entries')}
        </div>
      </div>

      {/* Less-used tools, out of the way until wanted */}
      <details style={{ marginBottom: 20 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '8px 0' }}>
          More: ask the assistant something specific, or build an ombudsman referral pack
        </summary>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>Ask the assistant</h2>
          {aiEnabled && (
            <button className="btn-navy btn-sm" onClick={runAssistant} disabled={aiBusy}>
              {aiBusy ? 'Working…' : ai ? 'Regenerate' : 'Analyse & draft next email'}
            </button>
          )}
        </div>
        <div className="card-body">
          {!aiEnabled ? (
            <div className="inline-note warn">
              The AI assistant isn’t configured yet. Set <code>ANTHROPIC_API_KEY</code> in the
              server environment to enable it.
            </div>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                It reads this complaint’s procedure, deadlines, timeline, emails and documents, and
                drafts the next email. Nothing is sent until you press Send. Always check the
                facts and figures in a draft against the documents first.
              </p>
              <div className="form-grid">
                <label className="field full">
                  <span className="lbl">What do you want to do? (optional)</span>
                  <input
                    value={aiInstruction}
                    onChange={(e) => setAiInstruction(e.target.value)}
                    placeholder="e.g. Chase for the acknowledgement they haven’t sent"
                  />
                </label>
                <label className="field full">
                  <span className="lbl">Anything else it should know? (optional)</span>
                  <textarea
                    rows={3}
                    value={aiContext}
                    onChange={(e) => setAiContext(e.target.value)}
                    placeholder="Paste a reply from them, or notes from a phone call…"
                  />
                </label>
              </div>

              {ai && (
                <div style={{ marginTop: 12 }}>
                  <div className="inline-note" style={{ background: 'var(--surface-2,#f4f6f2)' }}>
                    <strong>Analysis.</strong> {ai.summary}
                  </div>
                  {ai.recommended_action && (
                    <div className="inline-note warn" style={{ marginTop: 8 }}>
                      <strong>Recommended:</strong> {ai.recommended_action}
                    </div>
                  )}
                  {ai.steps?.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div className="lbl">Next steps</div>
                      <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                        {ai.steps.map((s, i) => (
                          <li key={i} style={{ marginBottom: 4 }}>{s}</li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {ai.caution && (
                    <div className="inline-note warn" style={{ marginTop: 10 }}>
                      <strong>Check before sending:</strong> {ai.caution}
                    </div>
                  )}

                  {ai.email && (
                    <div className="card" style={{ marginTop: 14 }}>
                      <div className="card-head">
                        <h2 style={{ fontSize: 15 }}>Draft email</h2>
                        <div className="btn-row">
                          <button
                            className="btn btn-sm"
                            onClick={() => copyText(`Subject: ${ai.email.subject}\n\n${signEmail(ai.email.body, me)}`)}
                          >
                            Copy
                          </button>
                          <button className="btn btn-sm" disabled={savingDraft} onClick={saveDraftToTimeline}>
                            Save to timeline
                          </button>
                          <button className="btn-primary btn-sm" onClick={() => openSend(ai.email)}>
                            Review &amp; send…
                          </button>
                        </div>
                      </div>
                      <div className="card-body">
                        <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>SUBJECT</div>
                        <div style={{ marginBottom: 10, fontWeight: 600 }}>{ai.email.subject}</div>
                        <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>BODY</div>
                        <pre
                          style={{
                            whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14,
                            margin: '4px 0 0', lineHeight: 1.5,
                          }}
                        >
                          {signEmail(ai.email.body, me)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Escalation: deadlock detection + ombudsman referral pack */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>⚖️ Ombudsman</h2>
          {aiEnabled && (
            <div className="btn-row">
              <button className="btn btn-sm" onClick={checkStatus} disabled={checking}>
                {checking ? 'Checking…' : 'Check if ready for the ombudsman'}
              </button>
              <button className="btn-navy btn-sm" onClick={buildReferral} disabled={referralBusy}>
                {referralBusy ? 'Building…' : 'Build referral pack'}
              </button>
            </div>
          )}
        </div>
        <div className="card-body">
          {!aiEnabled && (
            <div className="muted" style={{ fontSize: 13 }}>
              Set <code>ANTHROPIC_API_KEY</code> to enable the readiness check and referral packs.
            </div>
          )}
          {c.ombudsman_ready && (
            <div className="inline-note warn" style={{ marginBottom: 8 }}>
              <strong>Flagged ready for {theOmb}.</strong> Their process looks exhausted or they’ve
              missed the deadline.
              {c.ombudsman_deadline && <> Refer by {formatDate(c.ombudsman_deadline)}.</>}
            </div>
          )}
          {statusResult && (
            <div className="inline-note" style={{ background: 'var(--surface-2,#f4f6f2)' }}>
              <div>
                {statusResult.ombudsman_ready ? '✅ Ready to escalate. ' : '⏳ Not yet ready. '}
                {statusResult.reason}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Final response: {statusResult.final_response ? 'yes' : 'no'} · Deadlock:{' '}
                {statusResult.deadlock ? 'yes' : 'no'} · Suggested next: {statusResult.suggested_next_stage}
              </div>
            </div>
          )}
          {aiEnabled && !statusResult && !c.ombudsman_ready && (
            <div className="muted" style={{ fontSize: 13 }}>
              The checklist above shows when a referral becomes possible. The check reads the
              emails and documents for a final response or deadlock letter as well.
            </div>
          )}
        </div>
      </div>
      </details>

      {action && (
        <DatedActionModal action={action} onClose={() => setAction(null)} onSubmit={recordAction} />
      )}

      {supplierFor && (
        <SupplierModal
          c={c}
          suggestedName={supplierFor.name}
          aiEnabled={aiEnabled}
          onClose={() => setSupplierFor(null)}
          onDone={async (msg2) => { setSupplierFor(null); await load(); setMsg(msg2); }}
        />
      )}

      {partyForm && (
        <PartyModal
          c={c}
          party={partyForm === true ? null : partyForm}
          onClose={() => setPartyForm(null)}
          onSaved={async () => { setPartyForm(null); await load(); }}
        />
      )}

      {editing && (
        <EditComplaintModal
          c={c}
          onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await load(); }}
        />
      )}

      {/* Compose / send modal */}
      {send && (
        <Modal
          title={`${send.then === 'escalate' ? 'Send the Stage 2 request' : 'Send email'}${send.org_name ? ` to ${send.org_name}` : ''}`}
          onClose={() => setSend(null)}
          footer={
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setSend(null)}>Cancel</button>
              <button
                className="btn-primary"
                onClick={doSend}
                disabled={sending || !send.to || !send.subject || !send.body}
              >
                {sending ? 'Sending…' : send.then === 'escalate' ? 'Send and escalate to Stage 2' : 'Send'}
              </button>
            </div>
          }
        >
          {send.error && <div className="login-error" style={{ marginBottom: 12 }}>Not sent: {send.error}</div>}
          <label className="field">
            <span className="lbl">To *</span>
            <input value={send.to} onChange={(e) => setSend({ ...send, to: e.target.value })}
              placeholder="complaints@example.co.uk" list="complaint-org-emails" />
            <datalist id="complaint-org-emails">
              {tracks.filter((t) => t.org_email).map((t) => (
                <option key={t.id} value={t.org_email}>{t.org_name}</option>
              ))}
            </datalist>
            {(c.bounces || []).some((b) => send.to.toLowerCase().includes(b.address)) && (
              <span className="login-error" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                An email to this address bounced and hasn’t been looked into. It may not arrive.
              </span>
            )}
            {multi && (
              <span className="muted" style={{ fontSize: 12 }}>
                This complaint is with {tracks.map((t) => t.org_name).join(' and ')}: send it to the
                one it is for, and quote their reference.
              </span>
            )}
          </label>
          <label className="field">
            <span className="lbl">CC</span>
            <input value={send.cc} onChange={(e) => setSend({ ...send, cc: e.target.value })}
              placeholder="optional, comma-separated" />
          </label>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Copied in automatically: this complaint’s address ({c.email_address}), so their reply
            logs here{c.external_cc?.length ? <>, and {c.external_cc.join(', ')}</> : null}.
          </div>
          <label className="field">
            <span className="lbl">Subject *</span>
            <input value={send.subject} onChange={(e) => setSend({ ...send, subject: e.target.value })} />
          </label>
          <label className="field">
            <span className="lbl">Message *</span>
            <textarea rows={12} value={send.body}
              onChange={(e) => setSend({ ...send, body: e.target.value })} />
          </label>
        </Modal>
      )}

      {/* Referral pack modal */}
      {referral && (
        <Modal
          title={`Referral pack: ${referral.ombudsman || 'ombudsman'}`}
          onClose={() => setReferral(null)}
          footer={
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => copyText(referral.text)}>Copy</button>
              <button className="btn-primary" onClick={downloadReferral}>Download .txt</button>
            </div>
          }
        >
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {referral.text}
          </pre>
        </Modal>
      )}
    </>
  );
}

// The organisation's procedure as a checklist, with how far it can be trusted.
function ProcedureCard({ c, title, head }) {
  const p = c.procedure;
  const defaulted = c.rule?.defaulted || [];
  const timingDefaults = ['ackDays', 'stage1Days', 'stage2Days'].filter((k) => defaulted.includes(k));

  let trust;
  if (!p) {
    trust = (
      <div className="inline-note warn" style={{ marginBottom: 12 }}>
        <strong>These dates use general timescales for a {c.rule?.label?.toLowerCase() || 'body like this'}.</strong>{' '}
        Link {c.complaint_id ? `${c.org_name} to its saved organisation (Edit ${c.org_name}’s details)` : 'this complaint to the organisation (Edit details)'} and add their own procedure on the{' '}
        <Link to="/organisations">Organisations</Link> page, so the dates follow their rules.
      </div>
    );
  } else if (c.procedure_missing) {
    // Saved with only a name (an import sets organisations up like this): no
    // procedure has been found out, so these are the standard dates.
    trust = (
      <div className="inline-note warn" style={{ marginBottom: 12 }}>
        <strong>Not researched yet.</strong> These dates use the general timescales for{' '}
        {c.rule?.kind || 'a body like this'}: nobody has looked up {p.name}’s own complaints procedure. Open{' '}
        <Link to={`/organisations?open=${p.organisation_id}`}>{p.name}</Link>, research it (or upload their
        procedure document), and tick “checked”.
      </div>
    );
  } else if (p.verified_at) {
    trust = (
      <div className="inline-note" style={{ marginBottom: 12 }}>
        ✓ Dates follow {p.procedure_ref ? <strong>{p.procedure_ref}</strong> : 'their procedure'} —
        checked by {p.verified_by || 'a colleague'} on {formatDate(String(p.verified_at).slice(0, 10))}.
        {timingDefaults.length > 0 && ' Some timescales aren’t stated in it and use the general default, marked below.'}
      </div>
    );
  } else {
    trust = (
      <div className="inline-note warn" style={{ marginBottom: 12 }}>
        <strong>Not checked yet.</strong> These dates come from{' '}
        {p.research_status === 'document' ? 'their procedure document, read by the AI'
          : p.research_status === 'researched' ? 'AI research of their website'
          : 'details entered for this organisation'}
        {' '}and nobody has confirmed them against their procedure. Open{' '}
        <Link to="/organisations">{p.name}</Link>, check each figure against the document, and tick
        “checked”.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-head">
        <h2>{title || 'Their complaints procedure, step by step'}</h2>
        {p?.procedure_ref && <span className="badge navy">{p.procedure_ref}</span>}
      </div>
      <div className="card-body" style={{ paddingBottom: 0 }}>{head}{trust}</div>
      <table className="no-stack steps-table">
        <tbody>
          {(c.steps || []).map((s) => {
            const [label, tone] = STEP_STATE[s.state] || [s.state, 'grey'];
            return (
              <tr key={s.key}>
                <td style={{ width: 210 }}><strong>{s.label}</strong></td>
                <td className={`due ${s.state === 'overdue' ? 'overdue' : ''}`} style={{ width: 120 }}>
                  {s.date ? formatDate(s.date) : '—'}
                </td>
                <td style={{ width: 120 }}><span className={`badge ${tone}`}>{label}</span></td>
                <td className="muted" style={{ fontSize: 13 }}>{s.note}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="card-body">
        {p?.procedure_summary && (
          <details style={{ marginBottom: 8 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>How their procedure works</summary>
            <p style={{ whiteSpace: 'pre-wrap' }}>{p.procedure_summary}</p>
          </details>
        )}
        {c.rule?.legalBasis && (
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Ombudsman and the law</summary>
            <p>{c.rule.legalBasis}</p>
            <p className="muted" style={{ fontSize: 13 }}>
              Ombudsman:{' '}
              {c.rule.ombudsmanUrl
                ? <a href={c.rule.ombudsmanUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--green-600)' }}>{c.rule.ombudsman}</a>
                : c.rule.ombudsman}
            </p>
            {p?.sources?.length > 0 && (
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                {p.sources.map((s, i) => (
                  <li key={i}><a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--green-600)' }}>{s.title || s.url}</a></li>
                ))}
              </ul>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

// Record a step with the date it actually happened.
function DatedActionModal({ action, onClose, onSubmit }) {
  // Filled in when the step came from an email (e.g. "Looks resolved").
  const [date, setDate] = useState(action.date || todayISO());
  const [note, setNote] = useState(action.noteValue || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    if (date > todayISO()) { setError('That date is in the future.'); return; }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ date, note: note.trim() });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={action.title} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
      <form onSubmit={save}>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{action.intro}</p>
        <label className="field">
          <span className="lbl">Date *</span>
          <input type="date" required value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </label>
        {!action.noNote && (
          <label className="field">
            <span className="lbl">{action.noteLabel || 'Note (optional)'}</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={action.defaultNote} />
          </label>
        )}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Correct the details. Every change is written to the timeline by the server.
function EditComplaintModal({ c, onClose, onSaved }) {
  const [orgs, setOrgs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    organisation_id: c.organisation_id || '',
    org_name: c.org_name || '',
    org_type: c.org_type || 'other',
    subject: c.subject || '',
    property: c.property || '',
    category: c.category || '',
    channel: c.channel || 'email',
    reference: c.reference || '',
    our_reference: c.our_reference || '',
    account_numbers: (c.account_numbers || []).join(', '),
    raised_on: c.raised_on || '',
    stage_started_on: c.stage_started_on || '',
    acknowledged_on: c.acknowledged_on || '',
    responded_on: c.responded_on || '',
    final_response_on: c.final_response_on || '',
    due_override: c.response_due_manual ? c.response_due || '' : '',
    description: c.description || '',
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => { api.organisations.list().then(setOrgs).catch(() => setOrgs([])); }, []);

  function pickOrg(orgId) {
    const org = orgs.find((o) => o.id === orgId);
    setForm((f) => ({
      ...f,
      organisation_id: orgId,
      org_name: org ? org.name : f.org_name,
      org_type: org ? org.type : f.org_type,
    }));
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const blank = (v) => (v === '' ? null : v);
    // Only send an override if it was changed, so saving other details never
    // hands a date someone typed in (or left empty on purpose) back to the rules.
    const initialOverride = c.response_due_manual ? c.response_due || '' : '';
    try {
      await api.complaints.update(c.id, {
        organisation_id: blank(form.organisation_id),
        org_name: form.org_name,
        org_type: form.org_type,
        subject: form.subject,
        property: blank(form.property),
        category: blank(form.category),
        channel: form.channel,
        reference: blank(form.reference),
        our_reference: blank(form.our_reference),
        account_numbers: form.account_numbers.split(/[,;\n]+/).map((a) => a.trim()).filter(Boolean),
        raised_on: form.raised_on,
        // Stage 1 starts the day it was raised (the server keeps the two together).
        stage_started_on: c.stage === 'stage_1' ? undefined : blank(form.stage_started_on),
        acknowledged_on: blank(form.acknowledged_on),
        responded_on: blank(form.responded_on),
        final_response_on: blank(form.final_response_on),
        response_due: form.due_override === initialOverride ? undefined : blank(form.due_override),
        description: blank(form.description),
      });
      await onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const dateField = (k, label, hint) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <input type="date" value={form[k]} onChange={(e) => set(k, e.target.value)} />
      {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
    </label>
  );

  return (
    <Modal title="Edit complaint details" onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Every change is recorded on the timeline with the old and new value. The deadlines are
        recalculated from these dates.
      </p>
      <form onSubmit={save}>
        <label className="field">
          <span className="lbl">{c.parties?.length ? 'Main organisation' : 'Organisation'} (its procedure sets the deadlines)</span>
          <select value={form.organisation_id} onChange={(e) => pickOrg(e.target.value)}>
            <option value="">— Not linked (general timescales) —</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Organisation name *</span>
            <input required value={form.org_name} onChange={(e) => set('org_name', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Type</span>
            <select value={form.org_type} disabled={Boolean(form.organisation_id)}
              onChange={(e) => set('org_type', e.target.value)}>
              {Object.entries(ORG_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field full">
            <span className="lbl">Subject *</span>
            <input required value={form.subject} onChange={(e) => set('subject', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Property / address</span>
            <input value={form.property} onChange={(e) => set('property', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Category</span>
            <input value={form.category} onChange={(e) => set('category', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Account number (how emails are matched to it; separate several with commas)</span>
            <input value={form.account_numbers} onChange={(e) => set('account_numbers', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Their reference</span>
            <input value={form.reference} onChange={(e) => set('reference', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Our own reference</span>
            <input value={form.our_reference} onChange={(e) => set('our_reference', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Sent by</span>
            <select value={form.channel} onChange={(e) => set('channel', e.target.value)}>
              <option value="email">Email</option>
              <option value="portal">Online portal</option>
              <option value="phone">Phone</option>
              <option value="letter">Letter</option>
              <option value="other">Other</option>
            </select>
          </label>
          {dateField('raised_on', 'Date complaint made *')}
          {c.stage !== 'stage_1' && dateField('stage_started_on', 'Stage 2 requested on', 'Their Stage 2 deadline counts from this')}
          {dateField('acknowledged_on', 'They acknowledged on')}
          {dateField('responded_on', `They responded on (${STAGE_LABEL[c.stage] || 'current stage'})`)}
          {dateField('final_response_on', 'Their final response', 'The referral window often counts from this')}
          {dateField('due_override', 'Response due (override)', 'Leave blank to use their procedure (recommended)')}
          <label className="field full">
            <span className="lbl">Details</span>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)} />
          </label>
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Whether the mailboxes have been searched for every reference and account
// number on this complaint, so its emails are all here before work starts.
function EmailSearch({ s, busy, onSearch }) {
  if (!s) return null;
  const list = (xs) => xs.map((t) => `${t.kind} ${t.value}`).join('; ');
  const running = busy || s.running;
  let text;
  let warn = false;
  if (!s.mailbox_connected) {
    text = 'The mailbox connection isn’t set up, so the mailboxes can’t be searched for this complaint’s emails.';
    warn = true;
  } else if (running) {
    text = 'Searching the mailboxes for this complaint’s reference and account numbers…';
  } else if (s.pending.length) {
    warn = true;
    text = s.waiting_for_accounts
      ? `Not searched yet. Its account numbers are read off its emails first, then the mailboxes are searched for them and for: ${list(s.pending)}. This happens by itself within a few minutes, or search now.`
      : `Not yet searched for: ${list(s.pending)}. This happens by itself within a few minutes, or search now.`;
  } else if (s.searched.length) {
    text = `Every email quoting its numbers is here: the mailboxes were searched for ${list(s.searched)}` +
      `${s.searched_at ? ` (last on ${formatDate(String(s.searched_at).slice(0, 10))})` : ''}.`;
  } else {
    warn = true;
    text = 'There is no reference or account number on this complaint to search for yet. Add them with Edit details.';
  }
  return (
    <div className={`inline-note ${warn ? 'warn' : ''}`} style={{ marginBottom: 12 }}>
      <strong>Emails quoting its numbers:</strong> {text}
      {s.too_short?.length > 0 && (
        <div style={{ fontSize: 12, marginTop: 4 }}>
          Not searched, too short to search without bringing in unrelated mail: {list(s.too_short)}.
        </div>
      )}
      {s.mailbox_connected && (
        <div className="btn-row" style={{ marginTop: 6 }}>
          {s.pending.length > 0 && (
            <button className="btn-primary btn-sm" disabled={running} onClick={() => onSearch(false)}>
              {running ? 'Searching…' : 'Search now'}
            </button>
          )}
          {s.searched.length > 0 && (
            <button className="btn btn-sm" disabled={running} onClick={() => onSearch(true)}
              title="Search again for every number, for anything that has arrived since">
              {running ? 'Searching…' : 'Search again'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Raise the complaint with the supplier a debt collector is acting for: pick
// the supplier, have the AI draft the complaint from everything on file, check
// it, then send it from here (copied to this complaint's address and
// utilities@) or say it went from Outlook. Either way the supplier joins this
// complaint as a further organisation, dated the day it was sent.
function SupplierModal({ c, suggestedName, aiEnabled, onClose, onDone }) {
  const { user: me } = useAuth();
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState('');
  const [name, setName] = useState(suggestedName || '');
  const [type, setType] = useState('energy');
  const [draft, setDraft] = useState(null); // { to, subject, body, caution }
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [sentOn, setSentOn] = useState(todayISO());
  useEffect(() => {
    api.organisations.list().then((list) => {
      setOrgs(list);
      // The suggested supplier, if it is already saved.
      const k = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const hit = suggestedName && list.find((o) => k(o.name).includes(k(suggestedName)) || k(suggestedName).includes(k(o.name)));
      if (hit) { setOrgId(hit.id); setName(hit.name); setType(hit.type); }
    }).catch(() => setOrgs([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (id) => {
    setOrgId(id);
    const o = orgs.find((x) => x.id === id);
    if (o) { setName(o.name); setType(o.type); }
  };
  const who = { organisation_id: orgId || null, org_name: name.trim(), org_type: type };

  async function makeDraft() {
    setBusy('draft'); setError(null);
    try {
      const d = await api.complaints.supplierDraft(c.id, { organisation_id: orgId || null, org_name: name.trim() });
      setDraft({ ...d, body: signEmail(d.body, me), to: d.to || '' });
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  async function sendNow() {
    setBusy('send'); setError(null);
    try {
      await api.complaints.supplierRaise(c.id, { ...who, send: { to: draft.to, subject: draft.subject, body: draft.body } });
      await onDone(`Sending to ${name} now. They join this complaint as soon as it has gone; you can carry on.`);
    } catch (e) { setError(e.message); setBusy(null); }
  }
  async function sentFromOutlook() {
    if (!sentOn || sentOn > todayISO()) { setError('Enter the date it was sent (not in the future).'); return; }
    setBusy('outlook'); setError(null);
    try {
      await api.complaints.supplierRaise(c.id, { ...who, sent_on: sentOn });
      await onDone(`${name} added to this complaint, from ${formatDate(sentOn)}.`);
    } catch (e) { setError(e.message); setBusy(null); }
  }

  return (
    <Modal title={`Raise it with ${name || 'the supplier'} too`} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        {c.org_name} is collecting a debt that belongs to the supplier. The complaint goes to the
        supplier too, and they join this complaint with their own reference and deadlines, sharing
        its emails and timeline.
      </p>
      <label className="field">
        <span className="lbl">The supplier</span>
        <select value={orgId} onChange={(e) => pick(e.target.value)}>
          <option value="">— Not saved yet (general timescales) —</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <div className="form-grid">
        <label className="field">
          <span className="lbl">Name *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. British Gas" />
        </label>
        <label className="field">
          <span className="lbl">Type</span>
          <select value={type} disabled={Boolean(orgId)} onChange={(e) => setType(e.target.value)}>
            {Object.entries(ORG_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      {!draft ? (
        <div className="btn-row" style={{ marginBottom: 12 }}>
          {aiEnabled && (
            <button className="btn-primary" disabled={!name.trim() || busy} onClick={makeDraft}>
              {busy === 'draft' ? 'Drafting from the emails…' : 'Draft the complaint to them'}
            </button>
          )}
        </div>
      ) : (
        <>
          <label className="field">
            <span className="lbl">To *</span>
            <input value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} placeholder="their complaints address" />
            {!draft.to && <span className="muted" style={{ fontSize: 12 }}>Their complaints address isn’t saved: enter it (and save it on the organisation for next time).</span>}
          </label>
          <label className="field">
            <span className="lbl">Subject *</span>
            <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </label>
          <label className="field">
            <span className="lbl">Message * (check every fact and date before sending)</span>
            <textarea rows={14} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          </label>
          {draft.caution && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}><strong>Check:</strong> {draft.caution}</div>}
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Copied in automatically: {c.email_address}{c.external_cc?.length ? `, ${c.external_cc.join(', ')}` : ''}.
          </div>
          <div className="btn-row" style={{ marginBottom: 12 }}>
            <button className="btn-primary" disabled={busy || !draft.to || !draft.subject || !draft.body} onClick={sendNow}>
              {busy === 'send' ? 'Sending…' : `Send it and add ${name}`}
            </button>
            <button className="btn" onClick={() => navigator.clipboard?.writeText(`Subject: ${draft.subject}\n\n${draft.body}`).catch(() => {})}>
              Copy it (to send from Outlook)
            </button>
          </div>
        </>
      )}

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>Already sent it from Outlook?</summary>
        <div className="btn-row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, maxWidth: 180 }}>
            <span className="lbl" style={{ fontSize: 12 }}>Date it was sent</span>
            <input type="date" value={sentOn} max={todayISO()} onChange={(e) => setSentOn(e.target.value)} />
          </label>
          <button className="btn btn-sm" disabled={!name.trim() || busy} onClick={sentFromOutlook}>
            {busy === 'outlook' ? 'Adding…' : `Add ${name || 'them'} to this complaint`}
          </button>
        </div>
      </details>
    </Modal>
  );
}

// Add a further organisation to the complaint (the debt collector and the
// supplier it collects for), or correct one. Each has its own reference,
// dates and complaints procedure. A stage it has already reached is set when
// it is added; after that it moves on with the step buttons, like the main one.
function PartyModal({ c, party, onClose, onSaved }) {
  const [orgs, setOrgs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    organisation_id: party?.organisation_id || '',
    org_name: party?.org_name || '',
    org_type: party?.org_type || 'other',
    relationship: party?.relationship || '',
    reference: party?.reference || '',
    raised_on: party?.raised_on || todayISO(),
    stage: party?.stage || 'stage_1',
    stage_started_on: party?.stage_started_on || '',
    acknowledged_on: party?.acknowledged_on || '',
    responded_on: party?.responded_on || '',
    final_response_on: party?.final_response_on || '',
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => { api.organisations.list().then(setOrgs).catch(() => setOrgs([])); }, []);
  const onIt = new Set([c.organisation_id, ...(c.parties || []).filter((p) => p.id !== party?.id).map((p) => p.organisation_id)].filter(Boolean));

  function pickOrg(orgId) {
    const org = orgs.find((o) => o.id === orgId);
    setForm((f) => ({
      ...f,
      organisation_id: orgId,
      org_name: org ? org.name : f.org_name,
      org_type: org ? org.type : f.org_type,
    }));
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const blank = (v) => (v === '' ? null : v);
    const body = {
      organisation_id: blank(form.organisation_id),
      org_name: form.org_name.trim(),
      org_type: form.org_type,
      relationship: blank(form.relationship.trim()),
      reference: blank(form.reference.trim()),
      raised_on: form.raised_on,
      acknowledged_on: blank(form.acknowledged_on),
      responded_on: blank(form.responded_on),
      final_response_on: blank(form.final_response_on),
    };
    try {
      if (party) {
        await api.complaints.updateParty(c.id, party.id, {
          ...body,
          stage_started_on: party.stage === 'stage_1' ? undefined : blank(form.stage_started_on),
        });
      } else {
        await api.complaints.addParty(c.id, {
          ...body,
          stage: form.stage,
          stage_started_on: form.stage === 'stage_1' ? null : blank(form.stage_started_on),
        });
      }
      await onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const stage = party ? party.stage : form.stage;
  const dateField = (k, label, hint) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <input type="date" value={form[k]} max={todayISO()} onChange={(e) => set(k, e.target.value)} />
      {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
    </label>
  );

  return (
    <Modal title={party ? `Edit ${party.org_name}’s details` : 'Add another organisation to this complaint'} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        {party
          ? 'Every change is recorded on the timeline with the old and new value, and their deadlines are recalculated.'
          : <>For the same issue with a second organisation, for example a debt collector and the
            supplier it is collecting for. It keeps its own reference, dates and complaints procedure,
            and shares this complaint’s emails, documents and timeline with {c.org_name}.</>}
      </p>
      <form onSubmit={save}>
        <label className="field">
          <span className="lbl">Organisation (its procedure sets their deadlines)</span>
          <select value={form.organisation_id} onChange={(e) => pickOrg(e.target.value)}>
            <option value="">— Not saved yet (general timescales) —</option>
            {orgs.filter((o) => !onIt.has(o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            Not listed? Add it on the <Link to="/organisations">Organisations</Link> page so its own procedure is used, or type the name below.
          </span>
        </label>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Organisation name *</span>
            <input required value={form.org_name} onChange={(e) => set('org_name', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Type</span>
            <select value={form.org_type} disabled={Boolean(form.organisation_id)}
              onChange={(e) => set('org_type', e.target.value)}>
              {Object.entries(ORG_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field full">
            <span className="lbl">How they’re involved (optional)</span>
            <input value={form.relationship} onChange={(e) => set('relationship', e.target.value)}
              placeholder={`e.g. Debt collector acting for ${c.org_name}`} />
          </label>
          <label className="field">
            <span className="lbl">Their reference</span>
            <input value={form.reference} onChange={(e) => set('reference', e.target.value)} />
            <span className="muted" style={{ fontSize: 12 }}>The mailboxes are searched for it, and emails quoting it are brought onto this complaint.</span>
          </label>
          {dateField('raised_on', 'Complaint made to them on *')}
          {!party && (
            <label className="field">
              <span className="lbl">Where it stands with them</span>
              <select value={form.stage} onChange={(e) => set('stage', e.target.value)}>
                <option value="stage_1">Stage 1 (just made, or waiting for their answer)</option>
                <option value="stage_2">Stage 2 (asked them for a review)</option>
                <option value="ombudsman">Referred to the ombudsman</option>
              </select>
            </label>
          )}
          {stage !== 'stage_1' && dateField('stage_started_on', 'Stage 2 requested on', 'Their Stage 2 deadline counts from this')}
          {dateField('acknowledged_on', 'They acknowledged on')}
          {dateField('responded_on', `They responded on (${STAGE_LABEL[stage] || 'current stage'})`)}
          {dateField('final_response_on', 'Their final response', 'The referral window often counts from this')}
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : party ? 'Save changes' : 'Add organisation'}</button>
        </div>
      </form>
    </Modal>
  );
}

function Info({ label, value }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 15 }}>{value}</div>
    </div>
  );
}
