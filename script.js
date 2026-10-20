'use strict';
/* =====================================================================
   FinAgent AI — 2026 Shenzhen FinTech Edition
   100% DYNAMIC — no static budgets, no sample data, no preset categories.
   The user trains the agent on first login (income, categories, limits)
   via chat; everything persists per-user in Google Sheets through n8n.
   Multi-command parser: "set my transport budget to 1000, food budget
   to 1500, education budget is 1000, other in 500" → 4 categories at once.
   Currency: Chinese Yuan (RMB, ¥)
===================================================================== */
(() => {

  /* BUILD TAG — Ctrl+F this string on the LIVE /script.js after deploying
     to prove the new file is really being served (Netlify caches hard). */
  const BUILD_TAG = 'finagent-v8.3.9-budget-sync-fix';
  /* CACHE_VERSION — bump this to force EVERY device to discard its old
     local snapshot once. v8.2 = 8: pre-v8 caches may hold categories the
     old buggy sync adopted from a shared sheet (a stranger's budgets
     inside this account) — deleting sheet rows does NOT clear them,
     which is exactly the "I deleted all the data, it still shows" bug. */
  const CACHE_VERSION = 8;

  /* ------------------------------ storage keys ------------------------------ */
  const USERS_KEY    = 'finagent_users_v1';
  const SESSION_KEY  = 'finagent_session_v1';
  const WEBHOOK_KEY  = 'finagent_webhook_v1';
  const PENDING_KEY  = 'finagent_pending_register_v1';   /* v8.3 — accounts parked while the engine was down */
  /* Production n8n webhook — used when no custom URL is saved in localStorage.
     Deployed sites (Netlify, GitHub Pages…) start with an EMPTY localStorage,
     so without this default the engine falls back to local mode + Standby.
     Override anytime via the Settings (gear) modal. */
  const DEFAULT_WEBHOOK = 'https://awesome66.app.n8n.cloud/webhook/finance-agent';
  const dataKey      = email => `finagent_data_v1_${email}`;
  const profileKey   = email => `finagent_profile_v1_${email}`;
  const catKey       = email => `finagent_cats_v1_${email}`;
  const CUR          = '¥';

  /* ------------------------------ dynamic categories ------------------------------ */
  /* CATEGORIES starts EMPTY. Everything the user trains via chat
     ("Set my Education budget to 600") or that the engine returns from
     the Budgets tab gets added here at runtime — per user, per session. */
  let CATEGORIES = {};   // name → { budget, color, icon }

  const PALETTE = ['#10B981','#34D399','#06B6D4','#22D3EE','#2DD4BF',
                   '#818CF8','#F472B6','#FBBF24','#F87171','#A78BFA',
                   '#38BDF8','#FB923C','#4ADE80','#E879F9'];
  let paletteIdx = 0;

  const ICON_POOL = ['fa-basket-shopping','fa-utensils','fa-car-side','fa-bolt','fa-bag-shopping',
                     'fa-graduation-cap','fa-heart-pulse','fa-house','fa-plane','fa-dumbbell',
                     'fa-paw','fa-gamepad','fa-book','fa-tshirt','fa-gift'];
  let iconIdx = 0;

  function addCategory(name, budget = 0) {
    if (!name) return false;
    const key = titleCase(String(name).trim());
    if (!key || key.length > 24) return false;
    if (/^(my|the|a|an|total|remaining|monthly|overall|new|budget)$/i.test(key)) return false;
    if (CATEGORIES[key]) {
      if (budget > 0 && CATEGORIES[key].budget !== budget) {
        CATEGORIES[key].budget = budget;
        saveCategoriesLocal();
      }
      return false;
    }
    CATEGORIES[key] = {
      budget,
      color: PALETTE[paletteIdx++ % PALETTE.length],
      icon:  ICON_POOL[iconIdx++  % ICON_POOL.length],
    };
    saveCategoriesLocal();
    return true;
  }

  const CATEGORY_KEYWORDS = {
    Groceries: ['grocer', 'supermarket', 'walmart', 'costco', 'market', 'produce', 'whole foods', 'trader joe', 'bazar', 'vegetable', 'fish', 'meat', 'rice', 'fruit'],
    Dining:    ['kfc', 'dining', 'restaurant', 'lunch', 'dinner', 'breakfast', 'brunch', 'coffee', 'cafe', 'mcdonald', 'starbucks', 'pizza', 'food', 'milk tea', 'bubble tea', 'burger', 'domino', 'snack', 'meal', 'biryani', 'dessert'],
    Utilities: ['utilit', 'electric', 'power', 'water bill', 'gas bill', 'internet', 'wifi', 'broadband', 'phone bill', 'unicom', 'recharge', 'bill'],
    Transport: ['transport', 'uber', 'lyft', 'didi', 'taxi', 'fuel', 'petrol', 'gas station', 'metro', 'subway', 'parking', 'train', 'bus', 'shell', 'chevron', 'rickshaw', 'cng', 'ticket', 'launch'],
    Shopping:  ['shopping', 'amazon', 'uniqlo', 'zara', "h&m", 'clothes', 'clothing', 'shoes', 'sneakers', 'electronics', 'mall', 'ikea', 'target', 'shirt', 'pants', 'dress', 'saree', 'cosmetics', 'makeup', 'bata', 'bag'],
    Education: ['education', 'tuition', 'school', 'college', 'university', 'course', 'book', 'exam', 'study', 'stationery', 'coaching', 'admission', 'photocopy', 'photo copy', 'xerox', 'printout', 'printing', 'notes', 'notebook', 'pencil'],
    Health:    ['health', 'medicine', 'doctor', 'hospital', 'pharmacy', 'clinic', 'treatment'],
    Travel:    ['travel', 'trip', 'tour', 'hotel', 'flight', 'vacation'],
    Rent:      ['rent', 'flat', 'accommodation'],
    /* LAST so specific categories always win the scan. Catches "other
       purposes", "miscellaneous" and generic fallback merchants like
       "Various" — exactly what the n8n AI writes when the user spends
       on something unspecified but THEIR "Other" bucket owns it. */
    Other:     ['other', 'misc', 'miscellaneous', 'various', 'random', 'unknown'],
  };

  /* Natural-language bridges from everyday phrases onto the user's OWN
     trained categories — "eat pizza from Dominos" → Dining/Food,
     "clothes and shoes from Bata" → Shopping, "Green Line bus" →
     Transport, "education purposes" → Education. Trained category names
     always win over this static map, so the user's naming rules. */
  const CATEGORY_SYNONYMS = {
    Food:      ['pizza', 'burger', 'restaurant', 'lunch', 'dinner', 'breakfast', 'brunch', 'meal', 'snack', 'kfc', 'mcdonald', 'starbucks', 'cafe', 'coffee', 'domino', 'biryani', 'dessert', 'food', 'dining', 'grocer', 'grocery', 'bazar', 'supermarket', 'walmart', 'costco', 'vegetable', 'fish', 'meat', 'rice', 'fruit', 'takeout', 'takeaway', 'take away', 'delivery', 'foodpanda', 'uber eats', 'meituan', 'eleme', 'canteen', 'street food', 'milk tea', 'bubble tea', '外卖', '美团', '饿了么'],
    Dining:    ['pizza', 'burger', 'restaurant', 'lunch', 'dinner', 'breakfast', 'brunch', 'meal', 'snack', 'kfc', 'mcdonald', 'starbucks', 'cafe', 'coffee', 'domino', 'biryani', 'dessert', 'food', 'grocer', 'grocery', 'bazar', 'supermarket', 'takeout', 'takeaway', 'delivery', 'canteen', 'milk tea', 'bubble tea'],
    Groceries: ['grocer', 'grocery', 'food', 'dining', 'kfc', 'supermarket', 'bazar', 'vegetable', 'fish', 'meat', 'rice', 'fruit', 'walmart', 'costco', 'takeout', 'takeaway', 'delivery', 'foodpanda'],
    Other:     ['misc', 'miscellaneous', 'unknown', 'random', 'other', 'others'],
    Utilities: ['electric', 'water bill', 'gas bill', 'internet', 'wifi', 'broadband', 'phone bill', 'recharge', 'bill', 'unicom'],
    Transport: ['bus', 'metro', 'subway', 'train', 'uber', 'taxi', 'didi', 'rickshaw', 'cng', 'fuel', 'petrol', 'ticket', 'launch', 'parking'],
    Travel:    ['trip', 'tour', 'hotel', 'flight', 'vacation', 'travel'],
    Shopping:  ['clothes', 'clothing', 'shoes', 'shirt', 'pants', 'dress', 'saree', 'mall', 'cosmetics', 'makeup', 'bag', 'bata', 'uniqlo', 'zara', 'amazon', 'sneakers'],
    Education: ['tuition', 'school', 'college', 'university', 'course', 'study', 'book', 'exam', 'stationery', 'coaching', 'admission', 'education', 'photocopy', 'photo copy', 'xerox', 'printout', 'printing', 'notes', 'notebook', 'pencil'],
    Health:    ['medicine', 'doctor', 'hospital', 'pharmacy', 'clinic', 'treatment', 'health'],
    Rent:      ['rent', 'flat', 'accommodation'],
    Savings:   ['saving', 'deposit'],
  };

  const wordHit = (t, w) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t);
  /* crude singular/plural stem — "Groceries"→"grocery", "foods"→"food" */
  const stem = w => String(w).toLowerCase().trim().replace(/ies$/, 'y').replace(/s$/, '');

  /* Broad "umbrella" categories claim everyday phrases first — when the
     user trains Food, groceries / dining / takeout all roll into it. */
  const UMBRELLA_FIRST = new Set(['food', 'groceries', 'grocery', 'dining', 'meal']);

  /* The user's trained categories ALWAYS win over the static keyword map:
     1) message mentions a trained category name  → that category
     2) message hits a trained category's synonyms → that category
     3) static CATEGORY_KEYWORDS → 4) "on/from <noun>" guess → Misc */
  function matchTrainedCategory(text) {
    if (!text || !Object.keys(CATEGORIES).length) return null;
    const t = ' ' + text.toLowerCase() + ' ';
    const names = Object.keys(CATEGORIES);
    const hit = name => wordHit(t, name.toLowerCase()) || stem(t.trim()) === stem(name);
    /* PRIORITY 1+2 — BUDGET-trained umbrellas first: exact/stem name, then
       their synonyms. A budgeted Education claims "photocopy shopping" even
       when a 0-limit junk bucket (Shopping) is also mentioned. */
    const budgeted = names.filter(n => (CATEGORIES[n].budget || 0) > 0);
    for (const name of budgeted) if (hit(name)) return name;
    const bSorted = [...budgeted].sort((a, b) =>
      (UMBRELLA_FIRST.has(b.toLowerCase()) ? 1 : 0) - (UMBRELLA_FIRST.has(a.toLowerCase()) ? 1 : 0));
    for (const name of bSorted)
      for (const s of (CATEGORY_SYNONYMS[name] || []))
        if (t.includes(s)) return name;
    /* PRIORITY 3+4 — then everything else (old behavior, umbrella-first) */
    for (const name of names) if (hit(name)) return name;
    const keys = [...names].sort((a, b) =>
      (UMBRELLA_FIRST.has(b.toLowerCase()) ? 1 : 0) - (UMBRELLA_FIRST.has(a.toLowerCase()) ? 1 : 0));
    for (const name of keys)
      for (const s of (CATEGORY_SYNONYMS[name] || []))
        if (t.includes(s)) return name;
    return null;
  }

  /* =====================================================================
     BUDGET UMBRELLA ROLL-UP — the user's budget-trained categories are
     the ONLY authoritative buckets. Any other category name (chosen by
     the n8n AI, read back from Google Sheets, or guessed locally) that a
     budgeted umbrella claims via exact/plural-stem name or synonyms
     rolls into it, so "Spent ¥45 food at KFC" deducts from the user's
     Food limit even when the engine logs it as "Dining"/"Restaurant"/
     "Groceries" — no more parallel auto-created category.
     Budget-less setups roll onto nothing — old behavior preserved.
  ===================================================================== */
  function rollToBudgeted(cat) {
    if (!cat || !Object.keys(CATEGORIES).length) return null;
    const budgeted = Object.keys(CATEGORIES).filter(n => (CATEGORIES[n].budget || 0) > 0);
    if (!budgeted.length) return null;
    const t = ' ' + String(cat).toLowerCase().trim() + ' ';
    /* 1 · exact / plural-stem name hit (self-match included) */
    for (const name of budgeted)
      if (wordHit(t, name.toLowerCase()) || stem(t.trim()) === stem(name)) return name;
    /* 2 · synonym hit — umbrella categories (Food…) claim first */
    const sorted = [...budgeted].sort((a, b) =>
      (UMBRELLA_FIRST.has(b.toLowerCase()) ? 1 : 0) - (UMBRELLA_FIRST.has(a.toLowerCase()) ? 1 : 0));
    for (const name of sorted)
      for (const s of (CATEGORY_SYNONYMS[name] || []))
        if (t.includes(s)) return name;
    return null;
  }

  const CHIPS = [
    { icon: 'fa-wallet',          label: 'My monthly income is 8000' },
    { icon: 'fa-graduation-cap',  label: 'Set my Education budget to 600' },
    { icon: 'fa-basket-shopping', label: `Spent ${CUR}35 on Groceries at Walmart` },
    { icon: 'fa-utensils',        label: `Spent ${CUR}25 on Dining at KFC` },
    { icon: 'fa-chart-pie',       label: 'What is my remaining budget?' },
  ];

  /* ------------------------------ state ------------------------------ */
  let currentUser = null;
  let expenses = [];           // active user's ledger
  let profile = { income: 0, onboarded: false };   // per-user onboarding state
  let chart = null;
  let busy = false;
  let hintedLocal = false;
  let engineSynced = false;
  let pendingImage = null;
  let pendingReceipt = null;   /* receipt read by OCR — amount known, category pending */
  let receiptTruth = null;     /* v8.3.7 — {amount, merchant, at}: OCR ground truth of the LAST
                                  image send; the sync judge overrules vision misreads with it.
                                  Cleared on every send — a stale truth can never leak. */
  let categoryPin = null;      /* v8.3.5 — {cat, at}: category the app itself parsed from the user's
                                  text on the last image message; syncFromEngine enforces it on fresh
                                  agent rows for 10 min (vision misreads can no longer win) */
  let typingRow = null;
  let sessionId = '';
  const lastLevel = {};

  /* Remaining = income − spent (income-driven, fully dynamic) */
  const budgetTotal = () => profile.income;
  const budgetOf = name => CATEGORIES[name]?.budget || 0;

  /* ------------------------------ dom refs ------------------------------ */
  const $ = id => document.getElementById(id);
  const authScreen = $('authScreen'), authTabs = $('authTabs'),
        tabLoginBtn = $('tabLoginBtn'), tabRegisterBtn = $('tabRegisterBtn'),
        loginForm = $('loginForm'), loginEmail = $('loginEmail'), loginPassword = $('loginPassword'), loginError = $('loginError'),
        registerForm = $('registerForm'), regName = $('regName'), regEmail = $('regEmail'), regPassword = $('regPassword'), regError = $('regError'),
        demoBtn = $('demoBtn'),
        appShell = $('appShell'),
        profileAvatar = $('profileAvatar'), profileName = $('profileName'), profileEmail = $('profileEmail'), logoutBtn = $('logoutBtn'),
        engineBadge = $('engineBadge'), engineBadgeText = $('engineBadgeText'), webhookBtn = $('webhookBtn'),
        chatMessages = $('chatMessages'), chatForm = $('chatForm'), chatInput = $('chatInput'),
        sendBtn = $('sendBtn'), clearChatBtn = $('clearChatBtn'),
        receiptInput = $('receiptInput'), attachBtn = $('attachBtn'), attachPreview = $('attachPreview'), quickChips = $('quickChips'),
        statSpent = $('statSpent'), statRemaining = $('statRemaining'), statCount = $('statCount'),
        chartLegend = $('chartLegend'), budgetList = $('budgetList'),
        txBody = $('txBody'), txCount = $('txCount'),
        modalOverlay = $('modalOverlay'), modalClose = $('modalClose'), modalCancel = $('modalCancel'),
        webhookForm = $('webhookForm'), webhookInput = $('webhookInput'), testWebhookBtn = $('testWebhook'),
        toastBox = $('toastBox');

  const loginSubmitBtn = loginForm.querySelector('button[type="submit"]');
  const regSubmitBtn   = registerForm.querySelector('button[type="submit"]');

  /* ------------------------------ helpers ------------------------------ */
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titleCase = s => String(s).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1));
  const getWebhook = () => (localStorage.getItem(WEBHOOK_KEY) || '').trim() || DEFAULT_WEBHOOK;
  const money = v => `${CUR}${Number(v).toFixed(2)}`;

  function fmtWhen(ts) {
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function animateNumber(el, target, { prefix = '', decimals = 2, duration = 850 } = {}) {
    const from = el._v || 0;
    el._v = target;
    const start = performance.now();
    (function frame(t) {
      const p = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * e;
      const neg = v < 0, abs = Math.abs(v);
      el.textContent = (neg ? '-' : '') + prefix +
        abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      if (p < 1) requestAnimationFrame(frame);
    })(performance.now());
  }

  function toast(type, msg) {
    const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info' };
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.innerHTML = `<i class="fa-solid ${icons[type]}"></i><span>${escapeHtml(msg)}</span>`;
    toastBox.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); el.classList.add('hide'); setTimeout(() => el.remove(), 350); }, 4000);
  }

  /* =====================================================================
     N8N ENGINE BRIDGE — one endpoint, actions:
     login · register · chat · getExpenses · getProfile · setProfile ·
     setBudget · getBudgets
  ===================================================================== */
  function unwrapJson(data) {
    if (Array.isArray(data)) data = data[0];
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
    if (!data || typeof data !== 'object') return null;
    if (data.json && typeof data.json === 'object') return unwrapJson(data.json);
    return data;
  }

  async function apiPost(action, payload = {}) {
    const url = getWebhook();
    if (!url) return { local: true };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, source: 'finagent-web', timestamp: new Date().toISOString(), ...payload }),
        signal: ctrl.signal,
      });
      if (!res.ok) return { ok: false, httpError: res.status, error: `Engine replied HTTP ${res.status}` };
      const ct = res.headers.get('content-type') || '';
      let data;
      if (ct.includes('application/json')) {
        const txt = await res.text();
        try { data = txt ? JSON.parse(txt) : ''; } catch { data = txt; }  // n8n may send empty/broken JSON
      } else {
        data = await res.text();
      }
      /* ANY HTTP 200 payload counts as a confirmed engine reply — {ok:true},
         {success:true}, the appended Sheets row, plain text, even empty. */
      return unwrapJson(data) || { ok: true, raw: String(data ?? '').slice(0, 160) };
    } catch (err) {
      return { unreachable: true, error: err.name === 'AbortError' ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /* =====================================================================
     SAVE CONFIRMATION — tolerant by design.
     n8n branches answer in different shapes: {"ok": true}, {"success": true},
     the appended Google Sheets row, or plain text. ANY HTTP 200 reply means
     the branch executed and the write reached Sheets, so everything except a
     network failure / HTTP error counts as CONFIRMED. A quiet read-back
     (syncProfileAndBudgets) verifies the data right after.
  ===================================================================== */
  function saveConfirmed(r) {
    if (!r)                             return false;  // no response object at all
    if (r.local)                        return true;   // no engine configured — local mode
    if (r.ok === true)                  return true;   // explicit confirmation
    if (r.ok === false && r.error)      return false;  // engine explicitly refused
    if (r.unreachable || r.httpError)   return false;  // network / HTTP failure → NOT saved
    return true;                                       // engine answered 200 with a payload → saved
  }

  /* =====================================================================
     PENDING REGISTER SELF-HEAL (v8.3) — a registration must never be lost.
     If the auth engine is down / 5xx at register time the account is still
     created locally (the demo keeps working) AND parked in a pending
     queue. Every time the engine answers healthy again (verifyEngine
     success), the queue is flushed: each parked account is re-registered,
     and once the engine confirms, it leaves the queue. Result — the row
     lands in Google Sheets automatically as soon as the workflow works.
  ===================================================================== */
  function pendingRegisters() {
    try { const raw = JSON.parse(localStorage.getItem(PENDING_KEY)); return Array.isArray(raw) ? raw : []; }
    catch { return []; }
  }
  function enqueuePendingRegister(name, email, pw) {
    const q = pendingRegisters().filter(r => r.email !== email);
    q.push({ name, email, pass64: btoa(pw), tries: 0, at: Date.now() });
    localStorage.setItem(PENDING_KEY, JSON.stringify(q));
  }
  let flushBusy = false;
  async function flushPendingRegisters() {
    if (flushBusy) return;
    const queue = pendingRegisters();
    if (!queue.length) return;
    flushBusy = true;
    try {
      const done = new Set();
      for (const item of queue) {
        const res = await apiPost('register', { name: item.name, email: item.email, password: atob(item.pass64) });
        const already = res && (res.exists === true || (res.user && res.user.exists === true));
        if (already) {
          done.add(item.email);                       /* engine says already registered — nothing to sync */
        } else if (res && !res.unreachable && !res.httpError && res.ok !== false) {
          done.add(item.email);                       /* 200 — the row is in Sheets now */
          toast('success', `Cloud reconnected — ${item.name} synced to the database ✓`);
        } else {
          item.tries = (item.tries || 0) + 1;         /* engine still broken — keep parked */
        }
      }
      const rest = queue.filter(r => !done.has(r.email) && (r.tries || 0) < 30);
      localStorage.setItem(PENDING_KEY, JSON.stringify(rest));
    } finally { flushBusy = false; }
  }

  function setAuthBusy(btn, isBusy) {
    if (!btn) return;
    if (isBusy) {
      btn._html = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Please wait…';
    } else {
      btn.disabled = false;
      if (btn._html) btn.innerHTML = btn._html;
    }
  }

  /* ------------------------------ per-user profile (local cache) ------------------------------ */
  function loadProfileLocal(email) {
    try {
      const raw = localStorage.getItem(profileKey(email));
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') return { income: Number(p.income) || 0, onboarded: !!p.onboarded };
      }
    } catch { /* fresh user */ }
    return { income: 0, onboarded: false };
  }
  function saveProfileLocal() {
    if (currentUser) localStorage.setItem(profileKey(currentUser.email), JSON.stringify(profile));
  }

  /* ------------------ per-user trained categories (local cache) ------------------ */
  /* CATEGORIES lives only in memory, so a refresh used to BLANK the chart
     and budget list until the engine sync repopulated it a few seconds
     later. Cache the trained set per email and restore it at login —
     Google Sheets stays the source of truth, this is just instant paint. */
  function saveCategoriesLocal() {
    if (!currentUser) return;
    try {
      const cats = {};
      for (const [k, v] of Object.entries(CATEGORIES))
        cats[k] = { budget: Number(v.budget) || 0, color: v.color, icon: v.icon };
      localStorage.setItem(catKey(currentUser.email),
        JSON.stringify({ v: CACHE_VERSION, cats, paletteIdx, iconIdx }));
    } catch { /* quota — non-fatal */ }
  }
  function loadCategoriesLocal(email) {
    /* HARD RESET before any early return — switching accounts on one
       browser must NEVER inherit the previous user's in-memory buckets
       (a fresh user has no cache; the old early-return kept user A's
       categories alive inside user B's session). */
    CATEGORIES = {};
    paletteIdx = 0; iconIdx = 0;
    try {
      const raw = localStorage.getItem(catKey(email));
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      /* CACHE SELF-HEAL — a snapshot written by an OLDER build carries no
         version marker and may hold categories the previous buggy sync
         adopted from a shared sheet (another user's limits inside THIS
         account). Discard it once; the account retrains fresh and every
         cache saved from now on carries CACHE_VERSION and is trusted. */
      if (Number(saved.v) !== CACHE_VERSION) return;
      for (const [k, v] of Object.entries(saved.cats || {})) {
        if (!v || typeof v !== 'object') continue;
        CATEGORIES[k] = {
          budget: Number(v.budget) || 0,
          color:  v.color || PALETTE[paletteIdx % PALETTE.length],
          icon:   v.icon  || ICON_POOL[iconIdx  % ICON_POOL.length],
        };
        if (!v.color) paletteIdx++;
        if (!v.icon)  iconIdx++;
      }
      if (Number.isFinite(Number(saved.paletteIdx))) paletteIdx = Number(saved.paletteIdx);
      if (Number.isFinite(Number(saved.iconIdx)))    iconIdx    = Number(saved.iconIdx);
    } catch { /* fresh user */ }
  }
  /* budgets trained (limit > 0) count as onboarded, even without income */
  const hasTrainedBudgets = () => Object.values(CATEGORIES).some(c => (c.budget || 0) > 0);

  /* =====================================================================
     PER-USER OWNERSHIP — the app's self-defense against an unfiltered
     Google Sheets read. The n8n read nodes may return EVERY user's rows
     (shared sheet, no userId column, no filter); adopting them leaked
     user A's budgets into user B's panel. Policy from v8:
       • rows TAGGED with a user id → adopted only when it is OURS;
       • rows with NO user tag      → can NEVER create or change anything.
     The per-email local snapshot (what THIS account trained HERE) is the
     ownership truth, so a brand-new user sees a CLEAN panel instead of a
     stranger's budgets. If the n8n writes/reads ever carry userId columns,
     tagged rows flow through automatically — full multi-device sync.
  ===================================================================== */

  /* any user-id-ish field a sheet row / profile row may carry */
  function emailTag(r) {
    if (!r || typeof r !== 'object') return '';
    return String(r.userId ?? r.UserID ?? r.User ?? r.userEmail ?? r.user ?? r.email ?? r.Email ?? '')
      .trim().toLowerCase();
  }

  /* do two ledger entries describe the SAME spend? (ownership print + dedupe)
     amount within 1 paisa, logged/sheet-dated within 36 h, and the rolled
     category matches — or the merchant names overlap when the sheet wrote
     a near-duplicate category. */
  function sameSpend(a, b) {
    if (!a || !b) return false;
    if (Math.abs(Number(a.amount) - Number(b.amount)) > 0.011) return false;
    if (Math.abs(Number(a.ts) - Number(b.ts)) > 36 * 3600 * 1000) return false;
    const ca = rollToBudgeted(a.category) || a.category;
    const cb = rollToBudgeted(b.category) || b.category;
    if (ca === cb) return true;
    const ta = String(a.merchant || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const tb = String(b.merchant || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    return ta.some(w => tb.includes(w));
  }

  /* ledger merge — the user's LOCAL entries always survive (an engine
     outage or a foreign sheet read must never wipe what was logged here);
     adopted sheet rows join once, deduped by spend print. A local entry
     the sheet confirmed flips to "Synced". */
  function mergeLedgers(local, adopted) {
    const out = (local || []).map(e => ({ ...e }));
    for (const a of (adopted || [])) {
      const hit = out.find(l => sameSpend(l, a));
      if (hit) { if (a.status === 'synced') hit.status = 'synced'; continue; }
      out.push({ ...a });
    }
    return out.sort((x, y) => x.ts - y.ts);
  }

  /* getBudgets read-back — decide which entries may touch CATEGORIES.
     Accepts the aggregate object {Food: 800, ...} OR a rows array
     [{category, limit, userId}, ...]. ONLY entries tagged with THIS
     user's id may create or update a category. Untagged aggregates mix
     every user's limits — adopting them is the leak this kills. */
  function adoptRemoteBudgets(b, email) {
    const mine = String(email || '').trim().toLowerCase();
    const rows = [];
    const pushRow = (name, lim, tag) => {
      if (!tag || tag !== mine) return;
      const n = Number(lim);
      const nm = String(name ?? '').trim();
      if (!nm || !Number.isFinite(n) || n <= 0) return;
      rows.push({ name: nm, limit: n });
    };
    if (Array.isArray(b)) {
      for (const r of b) if (r && typeof r === 'object')
        pushRow(r.category ?? r.Category, r.limit ?? r.Limit ?? r.budget ?? r.Budget, emailTag(r));
    } else if (b && typeof b === 'object') {
      for (const [k, v] of Object.entries(b)) {
        if (v && typeof v === 'object') pushRow(k, v.limit ?? v.budget ?? v.Limit ?? v.Budget, emailTag(v));
        else pushRow(k, v, '');                      /* plain number → untagged */
      }
    }
    return rows;
  }

  /* =====================================================================
     ENGINE SYNC — Google Sheets feeds the ledger through the OWNERSHIP
     filter above; the user's own trained snapshot can never be stolen.
  ===================================================================== */
  function normalizeServerExpense(r) {
    if (!r || typeof r !== 'object') return null;
    const num = v => Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
    const amount = num(r.amount ?? r.Amount);
    if (!isFinite(amount) || amount <= 0) return null;

    const rawCat = String(r.category ?? r.Category ?? '').trim();
    let category = Object.keys(CATEGORIES).find(k => k.toLowerCase() === rawCat.toLowerCase() || stem(k) === stem(rawCat));
    if (!category) category = rawCat ? titleCase(rawCat)
                          : (detectCategory(String(r.merchant ?? '')) || 'Misc');
    /* roll loose sheet categories onto the user's BUDGET umbrella first —
       "Dining" / "Grocery" / "Takeout" rows deduct from Food when Food
       carries the user's limit. NOTE: only rollToBudgeted() gates the
       merchant rescue — matchTrainedCategory would happily return the
       junk 0-limit self-name ("Shopping") and block the second chance. */
    let rolled = rollToBudgeted(category);
    /* second chance — a sheet category that claims nowhere may still be
       rescueable through its merchant: a "Shopping" row bought at a
       photocopy/print shop rolls into Education once photocopy maps there */
    if (!rolled) {
      const merchCat = detectCategory(String(r.merchant ?? r.Merchant ?? ''));
      if (merchCat) rolled = rollToBudgeted(merchCat);
    }
    /* third chance — the n8n AI often narrates ONE category in its reply
       ("Category: Other") but writes a near-duplicate into the sheet
       ("Shopping"). A generic merchant ("Various") plus an honest
       description ("Other miscellaneous expenses") tells us what it
       REALLY meant — rescue through the description/note text. */
    if (!rolled) {
      const descCat = detectCategory(String(r.description ?? r.Description ?? r.note ?? r.Note ?? ''));
      if (descCat) rolled = rollToBudgeted(descCat);
    }
    if (!rolled) rolled = matchTrainedCategory(category);   /* trained-name fallback */
    if (rolled) category = rolled;
    /* NOTE: no addCategory here (v8.2) — normalizeServerExpense runs on
       every sheet row BEFORE ownership adoption, so calling it seeded
       0-limit phantom buckets (and cache writes) from FOREIGN rows.
       Buckets are created after the merge, for owned entries only. */

    let ts = Date.parse(r.ts ?? r.date ?? r.Date ?? '');
    if (!isFinite(ts)) ts = Date.now();

    const merchant = String(r.merchant ?? r.Merchant ?? '').trim() || category;
    return { merchant, category, amount: +amount.toFixed(2), ts, status: 'synced' };
  }

  async function syncFromEngine({ silent = true } = {}) {
    if (!currentUser || !getWebhook()) return;

    /* 1 · EXPENSES — OWNERSHIP merge. Tagged rows must carry THIS user's
       id; untagged rows are adopted only when they match an entry the
       user already holds (amount + 36 h + rolled category) — a shared
       unfiltered sheet can never push a stranger's spending in. */
    const res = await apiPost('getExpenses', { userId: currentUser.email });
    if (res.ok && Array.isArray(res.expenses)) {
      const mine = r => { const u = emailTag(r); return !u || u === currentUser.email.toLowerCase(); };
      const localLedger = expenses;                    /* ownership prints */
      /* v8.3.3 — keep the row beside its ownership tag: rows the engine
         logged FOR THIS USER (receipt photos read by the n8n agent) have
         no local twin, so print-matching alone would drop them forever. */
      const pairs = res.expenses.filter(mine)
        .map(r => ({ tag: emailTag(r), e: normalizeServerExpense(r) }))
        .filter(p => p.e);
      const list = pairs.map(p => p.e);
      /* ledger canonicalization — budgeted umbrellas claim near-duplicate
         sheet categories ("Dining" rows count toward the user's Food limit) */
      for (const p of pairs) {
        const c = rollToBudgeted(p.e.category);
        if (c && c !== p.e.category) p.e.category = c;
      }
      /* v8.3.5 — CATEGORY PIN ENFORCEMENT: when the app itself parsed a
         category out of the user's text on a recent image message, fresh
         agent-written rows for this user obey it — a vision misread that
         wrote "Other" instead of the pinned "Shopping" is corrected HERE,
         deterministically, with no second agent round-trip. The merchant
         and amount stay the agent's (they come from the picture); only the
         column the user named gets pinned. Untagged and foreign-tagged
         rows are never touched; rows with a local twin are left alone. */
      if (categoryPin && Date.now() - categoryPin.at < 10 * 60 * 1000) {
        for (const p of pairs) {
          if (!p.e || p.tag !== currentUser.email.toLowerCase()) continue;
          if (p.e.category && p.e.category !== categoryPin.cat &&
              !localLedger.some(le => sameSpend(le, p.e)))
            p.e.category = categoryPin.cat;
        }
      }
      /* v8.3.7 — SENTINEL JUDGE: when the browser's own OCR read THIS
         receipt (receiptTruth), the agent's fresh row must agree with
         the pixels — a vision misread of the total, or a sentinel
         garbage value ("ERR" merchant, "Miscellaneous" category), is
         corrected HERE deterministically, exactly like the pin. Without
         OCR ground truth only sentinel categories are repaired (to the
         pinned category, else the user's own Other), so garbage like
         "Miscellaneous" can never seed a phantom panel bucket again.
         Untagged/foreign rows and rows with a local twin stay untouched. */
      const truth = receiptTruth && Date.now() - receiptTruth.at < 10 * 60 * 1000 ? receiptTruth : null;
      const mineTag = currentUser.email.toLowerCase();
      for (const p of pairs) {
        if (!p.e || p.tag !== mineTag) continue;
        if (localLedger.some(le => sameSpend(le, p.e))) continue;
        if (truth) {
          if (Math.abs((p.e.amount || 0) - truth.amount) > 0.01) p.e.amount = truth.amount;
          if (!p.e.merchant || /^(err(or)?|unknown|n\/a|null|none|\?+|misc(ellaneous)?)$/i.test(String(p.e.merchant).trim()))
            p.e.merchant = truth.merchant || 'Receipt';
        }
        if (!p.e.category || /^(misc(ellaneous)?|unknown|n\/a|null|none|err(or)?|\?+|various|test)$/i.test(String(p.e.category).trim())) {
          const pinLive = categoryPin && Date.now() - categoryPin.at < 10 * 60 * 1000 && categoryPin.cat;
          if (pinLive && p.e.category !== pinLive) p.e.category = pinLive;
          else {
            const other = Object.keys(CATEGORIES).find(k => k.toLowerCase() === 'other');
            if (other && p.e.category !== other) p.e.category = other;
          }
        }
      }
      /* adoption rule — (a) rows TAGGED with this email are authoritative
         even when brand-new: the n8n agent writes the receipt row with
         our own userId, and only someone who already knows the email
         could ever produce one (a stranger's row carries THEIR tag or
         none). (b) untagged rows still need a local spend print — the
         v8 shared-sheet leak stays closed. */
      const adopted = pairs
        .filter(p => p.tag === currentUser.email.toLowerCase() ||
                     localLedger.some(le => sameSpend(le, p.e)))
        .map(p => p.e);
      expenses = mergeLedgers(localLedger, adopted);
      /* buckets for spending we ACTUALLY own — foreign sheet rows can no
         longer seed categories into this account's panel or cache */
      for (const e of expenses)
        if (!CATEGORIES[e.category]) addCategory(e.category, 0);
      saveData();
      pruneEmptyCategories();      /* drop 0-limit buckets the roll emptied */
      refreshDashboard();
      const gained = expenses.length - localLedger.length;
      if (gained > 0) {
        if (!silent || !engineSynced) {
          toast('success', `Engine synced — ${gained} expense${gained > 1 ? 's' : ''} loaded.`);
        }
      } else if (!silent) {
        toast('info', 'Engine synced — fresh start. Train me with your budget!');
      }
      engineSynced = true;
    } else if (!silent && res.unreachable) {
      toast('error', `Could not sync from engine (${res.error}).`);
    }

    /* 2 · PROFILE + 3 · BUDGETS — read back from the Profile / Budgets tabs */
    await syncProfileAndBudgets();
  }

  /* PROFILE + BUDGETS read-back — merges what Google Sheets actually holds
     (income from the Profile tab, limits from the Budgets tab). Deliberately
     does NOT touch the expense ledger, so it is safe to run right after a
     training save to verify the write landed. */
  async function syncProfileAndBudgets() {
    if (!currentUser || !getWebhook()) return;

    const p = await apiPost('getProfile', { userId: currentUser.email });
    if (p.ok && p.profile && typeof p.profile === 'object') {
      const tag = emailTag(p.profile);
      const inc = Number(p.profile.income) || 0;
      /* Ownership rule — mirrors the budgets policy. A profile row TAGGED
         with this email is authoritative. An UNTAGGED Profile read (one
         shared sheet, no userId column) can only CONFIRM what this device
         already holds: it may never CREATE income inside a fresh account
         (that is how a stranger's salary could leak in), and a missing or
         disagreeing read never erases the device's own truth. */
      if (tag === currentUser.email.toLowerCase()) {
        profile.income = inc > 0 ? inc : 0;
        profile.onboarded = !!p.profile.onboarded || inc > 0;
        saveProfileLocal();
        refreshDashboard();
      } else if (!tag && profile.income > 0 && inc === profile.income) {
        profile.onboarded = !!p.profile.onboarded || profile.onboarded;
        saveProfileLocal();
      }
    }

    /* budgets — ONLY rows tagged with this user's id may create or change
       a category. Untagged getBudgets aggregates (one shared sheet, no
       userId column) mix every user's limits; adopting them is exactly
       what leaked user A's trained budgets into user B's clean panel. */
    const b = await apiPost('getBudgets', { userId: currentUser.email });
    if (b.ok && b.budgets) {
      let changed = false;
      for (const row of adoptRemoteBudgets(b.budgets, currentUser.email)) {
        const before = CATEGORIES[row.name] ? CATEGORIES[row.name].budget : -1;
        addCategory(row.name, row.limit);
        if (CATEGORIES[row.name] && CATEGORIES[row.name].budget !== before) changed = true;
      }
      if (changed) { buildBudgetRows(); refreshDashboard(); }
    }

    /* limits read-back may have emptied/created buckets — tidy the panel */
    if (pruneEmptyCategories()) refreshDashboard();

    /* budgets trained but income still missing → the user HAS onboarded,
       never re-show the "please enter your budget" greeting on refresh */
    if (!profile.onboarded && hasTrainedBudgets()) {
      profile.onboarded = true;
      saveProfileLocal();
      refreshDashboard();
    }
  }

  /* =====================================================================
     TRAINING PARSER — understands MULTIPLE budgets in one line:
       "set my transport budget to 1000, food budget to 1500,
        education budget is 1000, other in 500"
     → 4 separate commands. Also: "my income is 5000" / "salary 5000"
  ===================================================================== */
  function parseProfileCommands(text) {
    const raw = ' ' + text.toLowerCase().replace(/[¥￥$]/g, '') + ' ';
    const num = s => Number(String(s).replace(/,/g, ''));
    const cmds = [];

    /* income first — "my income is 5000" / "salary 5000" / "my budget is 3000" */
    const inc = raw.match(/(?:income|salary|earn)\s*(?:is|=|:|of)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i)
             || raw.match(/\bmy\s+budget\s*(?:is|:|=)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
    if (inc) {
      const amount = num(inc[1]);
      if (amount > 0) cmds.push({ type: 'income', amount });   /* no early return — "My income is 5000, food budget 1500" parses BOTH */
    }

    /* split on commas / semicolons / newlines / "and" → parse each fragment */
    const fragments = raw.split(/[,;\n]+|\s+and\s+/i).map(f => f.trim()).filter(Boolean);
    const BAD_NAMES = /^(remaining|left|spent|paid|bought|logged|added|dropped|gave|cost|total|income|salary|earn|it|this|that)$/;

    for (const frag of fragments) {
      /* style A: "<name> [budget] to|is|in|: <amount>"  (covers "other in 500") */
      let m = frag.match(/([a-z][a-z ]{1,24}?)\s*(?:budget(?:\s*limit)?)?\s*(?:to|is|in|=|:|at|of)\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
      /* style B: "<name> budget <amount>"  (covers "food budget 1500") */
      if (!m && /budget/i.test(frag))
        m = frag.match(/([a-z][a-z ]{1,24}?)\s*budget(?:\s*limit)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
      if (!m) continue;

      const name = m[1].replace(/\b(my|the|a|an|set|make|monthly|total|overall|new|limit)\b/g, '').trim();
      const amount = num(m[2]);
      if (!name || name.length < 2 || BAD_NAMES.test(name) || amount <= 0) continue;
      cmds.push({ type: 'categoryBudget', category: titleCase(name), amount });
    }
    return cmds;
  }

  /* =====================================================================
     TRAINING HANDLER — applies one or many commands, saves each to engine
  ===================================================================== */
  async function handleProfileCommands(cmds) {
    showTyping();
    await wait(700 + Math.random() * 400);
    hideTyping();

    /* income command — sets the Remaining baseline */
    const incomeCmd = cmds.find(c => c.type === 'income');
    if (incomeCmd) {
      profile.income = incomeCmd.amount;
      profile.onboarded = true;
      saveProfileLocal();
      refreshDashboard();

      const spent = expenses.reduce((s, e) => s + e.amount, 0);
      const catCmds = cmds.filter(c => c.type === 'categoryBudget');
      let extra = '';
      if (catCmds.length) {
        for (const c of catCmds) {
          addCategory(c.category, c.amount);
          await apiPost('setBudget', { userId: currentUser.email, category: c.category, limit: c.amount }).catch(() => {});
        }
        buildBudgetRows();
        refreshDashboard();
        extra = `\n\nAlso configured: ${catCmds.map(c => `**${c.category}** (${money(c.amount)})`).join(', ')}.`;
      }

      addBotMessage(`Perfect, ${currentUser.name.split(' ')[0]} — your monthly budget is set to **${money(incomeCmd.amount)}**.

• **Remaining** now tracks against it: ${money(Math.max(0, incomeCmd.amount - spent))} left${extra}
• Log expenses naturally: *"Spent ${CUR}25 on Dining at KFC"*
• Train me more anytime: *"Set my Health budget to 400"*`);

      apiPost('setProfile', { userId: currentUser.email, income: incomeCmd.amount, onboarded: true })
        .then(r => {
          if (r.local) return;                      // no engine configured — local mode is fine
          if (saveConfirmed(r)) {
            toast('success', `Income saved to your cloud profile — ${money(incomeCmd.amount)}.`);
            setTimeout(() => syncProfileAndBudgets().catch(() => {}), 2000);  // quiet read-back from Sheets
          } else {
            toast('error', `Income kept on this device only — the engine refused the write (${r.error || 'no valid response'}). Check the n8n setProfile branch.`);
          }
        })
        .catch(() => toast('error', 'Income kept on this device only — could not reach the engine.'));
      return;
    }

    /* one or more category budgets */
    const lines = [];
    let savedToEngine = true, engineUsed = false;
    for (const c of cmds) {
      const isNew = addCategory(c.category, c.amount);
      lines.push(`• **${c.category}** — ${money(c.amount)} (${isNew ? 'new' : 'updated'})`);
      try {
        const r = await apiPost('setBudget', { userId: currentUser.email, category: c.category, limit: c.amount });
        if (r && !r.local) engineUsed = true;      // a real engine call was made
        if (!saveConfirmed(r)) savedToEngine = false;
      } catch { savedToEngine = false; }
    }
    buildBudgetRows();
    refreshDashboard();

    /* mentor touch: how much of the income is allocated? */
    let allocation = '';
    if (profile.income > 0) {
      const totalLimits = Object.keys(CATEGORIES).reduce((s, k) => s + (CATEGORIES[k].budget || 0), 0);
      allocation = totalLimits > profile.income
        ? `\n\n⚠️ Note: your category limits total ${money(totalLimits)}, which exceeds your ${money(profile.income)} income. Consider trimming one.`
        : `\n\nAllocated so far: ${money(totalLimits)} of your ${money(profile.income)} income — ${money(profile.income - totalLimits)} unallocated.`;
    }

    addBotMessage(`Training saved — ${cmds.length} categor${cmds.length > 1 ? 'ies' : 'y'} configured:

 ${lines.join('\n')}
 ${allocation}
Log expenses against any of them, e.g. *"Spent ${CUR}120 on ${cmds[0].category} at ABC"*.`);

    if (engineUsed && savedToEngine) {
      toast('success', cmds.length > 1
        ? `${cmds.length} budgets saved to your cloud profile.`
        : `Budget saved to your cloud profile — ${cmds[0].category}.`);
      setTimeout(() => syncProfileAndBudgets().catch(() => {}), 2000);   // quiet read-back from Sheets
    } else if (engineUsed) {
      toast('error', 'Budgets kept on this device only — the engine refused the write. Check the n8n setBudget branch & Publish.');
      addBotMessage(`Heads-up: I could **not** confirm saving this to your profile in the cloud. It works right now, but may not survive a refresh.

Check: the **setBudget** branch in n8n (Switch rule → Budget Append → Respond) and make sure the workflow is **Published**.`);
    }
  }

  /* =====================================================================
     AUTH — local fallback store (used when no webhook / engine down)
  ===================================================================== */
  function getUsers() { try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; } catch { return []; } }
  function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }

  function seedDemoUser() {
    const users = getUsers();
    if (!users.some(u => u.email === 'demo@finagent.ai')) {
      users.push({ name: 'Demo User', email: 'demo@finagent.ai', pass: btoa('demo123'), createdAt: Date.now() });
      saveUsers(users);
    }
  }

  function showFormError(el, msg) {
    el.querySelector('span').textContent = msg;
    el.classList.remove('hidden');
  }
  function clearFormErrors() { loginError.classList.add('hidden'); regError.classList.add('hidden'); }

  function switchTab(which) {
    authTabs.dataset.active = which;
    tabLoginBtn.classList.toggle('tab-btn--active', which === 'login');
    tabRegisterBtn.classList.toggle('tab-btn--active', which === 'register');
    loginForm.classList.toggle('hidden', which !== 'login');
    registerForm.classList.toggle('hidden', which !== 'register');
    clearFormErrors();
  }

  function attemptLogin(email, password) {
    const user = getUsers().find(u => u.email === email.toLowerCase().trim());
    if (!user) return { ok: false, msg: 'No account found for that email. Register first.' };
    if (user.pass !== btoa(password)) return { ok: false, msg: 'Incorrect password. Try again.' };
    return { ok: true, user: { name: user.name, email: user.email } };
  }

  function localLogin(email, pw) {
    const res = attemptLogin(email, pw);
    if (!res.ok) return showFormError(loginError, res.msg);
    toast('success', `Welcome back, ${res.user.name.split(' ')[0]}!`);
    enterApp(res.user);
  }

  function localRegister(name, email, pw) {
    const users = getUsers();
    if (users.some(u => u.email === email)) return showFormError(regError, 'An account with this email already exists on this device — switch to the Login tab and sign in.');
    users.push({ name, email, pass: btoa(pw), createdAt: Date.now() });
    saveUsers(users);
    toast('success', `Account created — welcome, ${name.split(' ')[0]}!`);
    enterApp({ name, email });
  }

  /* =====================================================================
     AUTH VERDICT — one tolerant classifier for both auth endpoints.
     The n8n register/login branches answer in several shapes ({ok:true,
     user:{…}, the exists/invalid flag pair, the appended Sheets row,
     plain text) — and a BROKEN workflow answers HTTP 500. Policy:
       • unreachable / HTTP 5xx  → engine is DOWN → local mode (never
         block the demo on a dead engine);
       • HTTP 4xx / ok:false     → engine understood and REFUSED → error;
       • HTTP 200                → the branch ran → read the exists/
         invalid flags when present (register: exists=true means the
         email is already taken; login: exists=false / invalid=true are
         the real rejection signals), otherwise ACCEPT.
  ===================================================================== */
  function authVerdict(res, forRegister = false) {
    if (!res) return 'broken';
    if (res.local) return 'local';
    if (res.unreachable) return 'broken';
    if (res.httpError) return res.httpError >= 500 ? 'broken' : 'refused';
    if (res.ok === false) return 'refused';
    /* HTTP 200 family — merge the user object (flags may ride inside it) */
    const src = (res.user && typeof res.user === 'object') ? { ...res.user, ...res } : res;
    if (forRegister) {
      if (src.exists === true) return 'refused';   /* email already registered */
    } else {
      if (src.exists === false) return 'no-account';
      if (src.invalid === true) return 'bad-password';
    }
    return 'ok';
  }

  async function handleLogin(e) {
    e.preventDefault();
    clearFormErrors();
    const email = loginEmail.value.trim(), pw = loginPassword.value;
    if (!email || !pw) return showFormError(loginError, 'Enter your email and password.');

    setAuthBusy(loginSubmitBtn, true);
    const res = await apiPost('login', { email, password: pw });
    setAuthBusy(loginSubmitBtn, false);

    const verdict = authVerdict(res, false);
    if (verdict === 'local' || verdict === 'broken') {
      if (verdict === 'broken') {
        toast('error', `Auth engine failed (${res.unreachable ? res.error : 'HTTP ' + res.httpError}) — using local mode.`);
      }
      return localLogin(email, pw);
    }
    /* v8.3.1 — the engine may say "no account / invalid" while the account
       exists ON THIS DEVICE (it was created while the engine was down, its
       Sheets row is still pending sync). Device credentials win; the engine
       catches up automatically via the pending-sync queue. */
    if (verdict === 'refused' || verdict === 'no-account' || verdict === 'bad-password') {
      const local = attemptLogin(email, pw);
      if (local.ok) {
        toast('success', `Welcome back, ${local.user.name.split(' ')[0]}!`);
        if (pendingRegisters().some(r => r.email === local.user.email)) {
          setTimeout(() => addBotMessage(
`⚠️ **Signed in from this device** — your cloud registration is still **pending** (the engine refused it earlier). The moment the n8n register branch is fixed, this account syncs to the database automatically.`), 1600);
        }
        return enterApp(local.user);
      }
    }
    if (verdict === 'refused') return showFormError(loginError, res.error || 'Auth engine refused the login.');
    if (verdict === 'no-account') return showFormError(loginError, 'No account found for that email. Register first.');
    if (verdict === 'bad-password') return showFormError(loginError, 'Incorrect password. Try again.');
    /* verdict ok — 200 and no rejection flag */
    const lower = email.toLowerCase();
    const local = getUsers().find(u => u.email === lower);
    const name = (res.user && res.user.name) || (local && local.name) || lower.split('@')[0];
    toast('success', `Welcome back, ${String(name).split(' ')[0]}!`);
    enterApp({ name, email: (res.user && res.user.email) || lower });
  }

  async function handleRegister(e) {
    e.preventDefault();
    clearFormErrors();
    const name = regName.value.trim(), email = regEmail.value.trim().toLowerCase(), pw = regPassword.value;
    if (name.length < 2)                          return showFormError(regError, 'Please enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showFormError(regError, 'That email address looks invalid.');
    if (pw.length < 6)                            return showFormError(regError, 'Password must be at least 6 characters.');

    setAuthBusy(regSubmitBtn, true);
    const res = await apiPost('register', { name, email, password: pw });
    setAuthBusy(regSubmitBtn, false);

    const verdict = authVerdict(res, true);
    if (verdict === 'local' || verdict === 'broken') {
      if (verdict === 'broken') {
        /* v8.3 — the row did NOT reach Google Sheets. Park the account for
           automatic re-registration the moment the engine answers again,
           and say so where the user cannot miss it (chat, not a 4s toast). */
        enqueuePendingRegister(name, email, pw);
        const why = res.unreachable ? res.error : 'HTTP ' + res.httpError;
        toast('error', `Cloud engine failed (${why}) — account kept on this device and will auto-sync once the engine is fixed.`);
        setTimeout(() => addBotMessage(
`⚠️ **Your account was created on this device only** — the cloud engine refused the registration (${why}), so the database row is **pending**.

FinAgent will re-send it automatically the next time the engine answers. Ask the admin to check **n8n → Executions → the red register node**.`), 1600);
      }
      return localRegister(name, email, pw);
    }
    if (verdict === 'refused') {
      return showFormError(regError, res.error || 'That email is already registered — try logging in.');
    }
    /* verdict ok — ANY 200 counts: {ok:true}, the appended Sheets row,
       {exists:false, invalid:false} flags, plain text. The old code
       demanded res.user and wrongly showed "response not understood"
       AFTER the row had already landed in Google Sheets. */
    toast('success', `Account created — welcome, ${String((res.user && res.user.name) || name).split(' ')[0]}!`);
    enterApp({ name: (res.user && res.user.name) || name, email: (res.user && res.user.email) || email });
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    currentUser = null;
    expenses = [];
    profile = { income: 0, onboarded: false };
    engineSynced = false;
    CATEGORIES = {};        // next user starts from their own trained set
    paletteIdx = 0; iconIdx = 0;
    hideTyping();
    chatMessages.innerHTML = '';
    clearFormErrors();
    loginForm.reset(); registerForm.reset();
    switchTab('login');
    toast('info', 'Session ended — see you soon.');
    authScreen.classList.remove('leaving');
    document.documentElement.classList.remove('authed');
    setTimeout(() => loginEmail.focus(), 350);
  }

  /* =====================================================================
     GREETINGS — fresh user = mentor onboarding · old user = welcome back
  ===================================================================== */
  function showWelcome() {
    chatMessages.innerHTML = '';
    const spent = expenses.reduce((s, e) => s + e.amount, 0);
    if (profile.onboarded) {
      addBotMessage(
`Welcome back, **${currentUser.name.split(' ')[0]}** — how can I help you today?

 ${profile.income > 0 ? `• Your monthly budget: **${money(profile.income)}** · Spent so far: **${money(spent)}** · Remaining: **${money(Math.max(0, profile.income - spent))}**\n` : ''}${Object.keys(CATEGORIES).length ? `• Your trained categories: ${Object.keys(CATEGORIES).join(', ')}\n` : ''}${profile.income <= 0 ? `• Income baseline missing — set it anytime: *"My monthly income is 8000"*\n` : ''}• Log an expense: *"Spent ${CUR}18 on coffee at Starbucks"*
• Train me more: *"Set my Health budget to 400"*`);
    } else {
      addBotMessage(
`Hello **${currentUser.name.split(' ')[0]}**, welcome to **FinAgent AI** — your trusted financial mentor.

Please enter your budget to personalize your ledger — your monthly income, or how much you plan to spend:
• *"My monthly income is 8000"*
• Or all at once: *"My income is 5000, food budget 1500, transport budget 1000"*

Then train me with your own categories anytime:
• *"Set my Education budget to 600"*
• *"Spent ${CUR}300 on Education at MIT"* — new categories appear in the chart automatically.`);
    }
  }

  /* =====================================================================
     SESSION / APP ROUTING
  ===================================================================== */
  function enterApp(user) {
    currentUser = user;
    sessionId = 'sess_' + Math.random().toString(36).slice(2, 10);
    const token = 'tok_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...user, token }));

    profileAvatar.textContent = user.name.trim()[0].toUpperCase();
    profileName.textContent = user.name;
    profileEmail.textContent = user.email;

    profile  = loadProfileLocal(user.email);
    expenses = loadData(user);
    loadCategoriesLocal(user.email);   /* trained categories restore instantly — no refresh flash */
    if (!profile.onboarded && hasTrainedBudgets()) { profile.onboarded = true; saveProfileLocal(); }

    authScreen.classList.add('leaving');
    setTimeout(() => document.documentElement.classList.add('authed'), 300);

    if (!chart) initChart();
    buildBudgetRows();
    pruneEmptyCategories();
    refreshDashboard();
    updateBadge();
    verifyEngine().catch(() => {});   /* real engine status right after entry */

    const onboardedAtEntry = profile.onboarded;
    showWelcome();

    syncFromEngine().then(() => {
      /* if the engine revealed a different onboarding state, re-greet */
      if (profile.onboarded !== onboardedAtEntry) showWelcome();
    }).catch(() => {});
  }

  function loadData(user) {
    try {
      const raw = localStorage.getItem(dataKey(user.email));
      if (raw) {
        const cached = JSON.parse(raw);
        if (Array.isArray(cached)) return cached;
      }
    } catch { /* fresh user */ }
    localStorage.setItem(dataKey(user.email), '[]');
    return [];
  }

  function saveData() {
    if (currentUser) localStorage.setItem(dataKey(currentUser.email), JSON.stringify(expenses));
  }

  /* =====================================================================
     CHART.JS — doughnut (renders whatever categories exist, even none)
  ===================================================================== */
  const centerTextPlugin = {
    id: 'centerText',
    afterDraw(c) {
      const meta = c.getDatasetMeta(0);
      const { x, y } = meta.data?.[0] ?? { x: c.width / 2, y: c.height / 2 };
      const total = expenses.reduce((s, e) => s + e.amount, 0);
      const ctx = c.ctx;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
      ctx.font = '600 10px "Space Grotesk"';
      ctx.fillText('TOTAL SPENT', x, y - 15);
      ctx.fillStyle = '#34D399';
      ctx.shadowColor = 'rgba(16,185,129,0.5)';
      ctx.shadowBlur = 12;
      ctx.font = '700 21px "JetBrains Mono"';
      ctx.fillText(`${CUR}${total.toFixed(2)}`, x, y + 8);
      ctx.restore();
    },
  };

  function initChart() {
    chart = new Chart($('categoryChart'), {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{ data: [], backgroundColor: [], borderColor: '#0B0F19', borderWidth: 3, hoverOffset: 10, borderRadius: 4 }],
      },
      options: {
        cutout: '72%',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(2,6,23,.95)',
            borderColor: 'rgba(16,185,129,.3)',
            borderWidth: 1,
            titleColor: '#a7f3d0',
            bodyColor: '#d1fae5',
            titleFont: { family: 'Space Grotesk' },
            bodyFont: { family: 'JetBrains Mono' },
            padding: 10,
            cornerRadius: 10,
            callbacks: { label: c => `  ${CUR}${c.parsed.toFixed(2)}` },
          },
        },
        animation: { duration: 900, easing: 'easeOutQuart' },
      },
      plugins: [centerTextPlugin],
    });
  }

  /* =====================================================================
     ANALYTICS RENDERERS — fully dynamic
  ===================================================================== */
  function totalsByCategory() {
    const t = {};
    for (const k in CATEGORIES) t[k] = 0;
    expenses.forEach(e => {
      let cat = e.category;
      if (t[cat] === undefined) {
        /* stray category (cache mismatch) — roll onto a trained umbrella */
        const r = rollToBudgeted(cat) || matchTrainedCategory(cat);
        if (!(r && t[r] !== undefined)) return;
        cat = r;
      } else if ((CATEGORIES[cat]?.budget || 0) <= 0) {
        /* 0-limit bucket claimed by a budgeted umbrella → count there */
        const r = rollToBudgeted(cat);
        if (r && r !== cat && t[r] !== undefined) cat = r;
      }
      t[cat] += e.amount;
    });
    return t;
  }

  function renderChart() {
    if (!chart) return;
    chart.data.labels = Object.keys(CATEGORIES);
    chart.data.datasets[0].backgroundColor = Object.values(CATEGORIES).map(c => c.color);
    chart.data.datasets[0].data = Object.values(totalsByCategory()).map(v => +v.toFixed(2));
    chart.update();
  }

  function renderLegend() {
    const totals = totalsByCategory();
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    if (!Object.keys(CATEGORIES).length) {
      chartLegend.innerHTML = `<div class="empty-state" style="padding:14px 6px">
        <i class="fa-solid fa-wand-magic-sparkles"></i>No categories yet — train me in chat:
        *"Set my Education budget to 600"*</div>`;
      return;
    }
    chartLegend.innerHTML = Object.entries(CATEGORIES).map(([name, cfg]) => {
      const v = totals[name] || 0;
      const p = total ? Math.round(v / total * 100) : 0;
      return `<div class="legend-row${v === 0 ? ' legend-row--zero' : ''}">
        <span class="legend-dot" style="background:${cfg.color}; box-shadow:0 0 8px ${cfg.color}66"></span>
        <span class="legend-name">${name}</span>
        <span class="legend-val">${money(v)}</span>
        <span class="legend-pct">${total ? p + '%' : '—'}</span>
      </div>`;
    }).join('');
  }

  function buildBudgetRows() {
    if (!Object.keys(CATEGORIES).length) {
      budgetList.innerHTML = `<div class="empty-state" style="padding:14px 6px">
        <i class="fa-solid fa-sliders"></i>No budgets yet — tell me in chat:
        *"Set my Groceries budget to 500"*</div>`;
      return;
    }
    budgetList.innerHTML = Object.entries(CATEGORIES).map(([name, cfg]) => `
      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <span class="cat-ico" style="color:${cfg.color}; background:${cfg.color}1a; border:1px solid ${cfg.color}38">
              <i class="fa-solid ${cfg.icon}"></i>
            </span>
            <span class="text-[13px] font-medium text-slate-100">${name}</span>
          </div>
          <span id="btxt-${name}" class="font-mono text-[11px] text-slate-400"></span>
        </div>
        <div class="bar-track"><div class="bar-fill" id="bfill-${name}"></div></div>
        <div class="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
          <span id="bpct-${name}">—</span>
          <span>limit ${cfg.budget > 0 ? CUR + cfg.budget : 'not set'}</span>
        </div>
      </div>`).join('');
  }

  function renderBudgets() {
    const totals = totalsByCategory();
    for (const [name, cfg] of Object.entries(CATEGORIES)) {
      const spent = totals[name] || 0;
      const limit = cfg.budget;
      const pctRaw = limit > 0 ? spent / limit * 100 : 0;
      const fill = $('bfill-' + name), txt = $('btxt-' + name), pctEl = $('bpct-' + name);
      if (!fill || !txt || !pctEl) continue;
      fill.style.width = Math.min(100, pctRaw).toFixed(1) + '%';
      fill.classList.toggle('over', limit > 0 && pctRaw >= 100);
      fill.classList.toggle('warn', limit > 0 && pctRaw >= 80 && pctRaw < 100);
      txt.textContent = `${CUR}${spent.toFixed(2)} / ${limit > 0 ? CUR + limit : 'not set'}`;
      pctEl.textContent = limit > 0 ? `${Math.round(pctRaw)}%${pctRaw >= 100 ? ' · over' : ''}` : '—';
      pctEl.classList.toggle('pct-over', limit > 0 && pctRaw >= 100);

      const lvl = limit > 0 ? (pctRaw >= 100 ? 2 : pctRaw >= 80 ? 1 : 0) : 0;
      if (currentUser && lvl > (lastLevel[name] || 0)) {
        if (lvl === 2) toast('error', `${name} budget exceeded — ${CUR}${spent.toFixed(2)} of ${CUR}${limit}.`);
        else toast('info', `${name} is at ${Math.round(pctRaw)}% of its limit.`);
      }
      lastLevel[name] = lvl;
    }
  }

  function renderTransactions() {
    txCount.textContent = expenses.length;
    const rows = [...expenses].sort((a, b) => b.ts - a.ts).slice(0, 30);
    if (!rows.length) {
      txBody.innerHTML = `<tr><td colspan="4" class="empty-state">
        <i class="fa-solid fa-receipt"></i>No expenses yet — tell the agent what you spent.</td></tr>`;
      return;
    }
    txBody.innerHTML = rows.map(e => {
      const cfg = CATEGORIES[e.category] || { color: '#6ee7b7' };
      const st = e.status === 'synced'
        ? '<span class="status-pill status-pill--synced"><span class="dot"></span>Synced</span>'
        : '<span class="status-pill status-pill--logged"><span class="dot"></span>Logged</span>';
      return `<tr class="tx-row">
        <td><div class="tx-merchant">${escapeHtml(e.merchant)}</div><div class="tx-time">${fmtWhen(e.ts)}</div></td>
        <td><span class="cat-badge" style="color:${cfg.color}; background:${cfg.color}14; border-color:${cfg.color}38">
          <span class="cat-badge-dot" style="background:${cfg.color}"></span>${e.category}</span></td>
        <td>${st}</td>
        <td class="tx-amt">&minus;${money(e.amount)}</td>
      </tr>`;
    }).join('');
  }

  function renderStats() {
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    const remaining = budgetTotal() - total;
    animateNumber(statSpent, total, { prefix: CUR });
    animateNumber(statRemaining, remaining, { prefix: CUR });
    statRemaining.classList.toggle('text-rose-300', remaining < 0);
    statRemaining.classList.toggle('text-emerald-300', remaining >= 0);
    animateNumber(statCount, expenses.length, { decimals: 0 });
  }

  function refreshDashboard() {
    renderChart(); renderLegend(); renderBudgets(); renderTransactions(); renderStats();
    saveData();
  }

  /* ---------------------------------------------------------------------
     PRUNE — remove 0-limit categories nothing spends on anymore. The
     budget roll-up empties engine-invented near-duplicates ("Dining"
     once Food carries the limit); this erases their leftover rows so the
     chart, legend and budget panel show ONLY the user's own buckets.
     Trained limits (budget > 0) and buckets with live expenses stay.
  --------------------------------------------------------------------- */
  function pruneEmptyCategories() {
    const live = new Set(expenses.map(e => e.category));
    let removed = 0;
    for (const name of Object.keys(CATEGORIES)) {
      if ((CATEGORIES[name].budget || 0) > 0) continue;  /* user-trained limit → keep */
      if (live.has(name)) continue;                      /* still spending → keep */
      delete CATEGORIES[name];
      removed++;
    }
    if (removed) { saveCategoriesLocal(); buildBudgetRows(); }
    return removed;
  }

  function addExpense(exp) {
    addCategory(exp.category, 0);   // "Spent ¥300 on Education" → Education joins the chart
    const entry = { ...exp, ts: Date.now(), status: 'logged' };
    expenses.push(entry);
    refreshDashboard();
    return entry;
  }

  /* =====================================================================
     EXPENSE PARSER — "Spent ¥300 on Education at MIT" → new category
  ===================================================================== */
  function detectCategory(text) {
    if (!text) return null;
    const t = ' ' + text.toLowerCase() + ' ';
    for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS))
      for (const w of words) if (t.includes(w)) return cat;
    return null;
  }

  function detectAmount(text) {
    let m = text.match(/[¥￥$]\s*(\d+(?:\.\d{1,2})?)/);
    if (!m) m = text.match(/(?:spent|paid|bought|logged|added|dropped)\s*[¥￥$]?\s*(\d+(?:\.\d{1,2})?)/i);
    if (!m) m = text.match(/\b(\d{1,6}(?:\.\d{1,2})?)\b/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return v > 0 && v <= 1000000 ? v : null;
  }

  function detectMerchant(text) {
    const matches = [...text.matchAll(/\b(?:at|from)\s+([A-Za-z][A-Za-z0-9&'.\- ]{0,40})/gi)];
    if (!matches.length) return null;
    let raw = matches[matches.length - 1][1];
    raw = raw.replace(/\s+(?:on|yesterday|today|last|this|just|then)\b[\s\S]*$/i, '')
             .replace(/[.,!?;:]+$/, '').trim();
    if (!raw) return null;
    return titleCase(raw.split(/\s+/).slice(0, 3).join(' '));
  }

  function parseExpense(text) {
    const amount = detectAmount(text);
    if (amount === null) return null;
    const merchant = detectMerchant(text);

    let category = matchTrainedCategory(text) || matchTrainedCategory(merchant || '')
                || detectCategory(text)    || detectCategory(merchant || '');
    if (!category) {
      const m = text.match(/\bon\s+([A-Za-z][A-Za-z ]{2,24}?)(?=\s+(?:at|from)\b|[.,!?]|$)/i);
      if (m) {
        const guess = titleCase(m[1].trim());
        if (guess && !/^(the|a|an|my|some|it)$/i.test(guess)) category = guess;
      }
    }
    category = category || 'Misc';
    const rolled = rollToBudgeted(category);   /* budgeted umbrellas own the name */
    if (rolled) category = rolled;
    return { amount: +amount.toFixed(2), category, merchant: merchant || category };
  }

  /* =====================================================================
     LOCAL FALLBACK AGENT
  ===================================================================== */
  const HELP = `Here's what I can do:
• **Set up** — *"My monthly income is 8000"*
• **Log expenses** — *"Spent ${CUR}35 on Groceries at Walmart"*
• **Custom categories** — *"Set my Education budget to 600"*
• **Multi-setup** — *"My income is 5000, food budget 1500, transport 1000"*
• **Budget checks** — *"What is my remaining budget?"*
• **Summary** — *"Show my spending summary"*`;

  const UNSTRUCTURED_REPLY = `The agent engine acknowledged your message but returned no readable reply.
Expected one of \`output\`, \`reply\`, \`text\` or \`message\` in the JSON response.`;

  function replyExpense(exp) {
    const limit = budgetOf(exp.category);
    const spent = totalsByCategory()[exp.category] || 0;
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    let out = `Logged **${money(exp.amount)}** at **${exp.merchant}** under **${exp.category}**.\n`;
    out += limit > 0
      ? `• ${exp.category}: ${money(spent)} of ${money(limit)} — ${Math.round(spent / limit * 100)}% of limit\n`
      : `• ${exp.category}: ${money(spent)} so far (no limit — try *"Set my ${exp.category} budget to 500"*)\n`;
    out += `• Total spent: ${money(total)} · Remaining: **${money(Math.max(0, budgetTotal() - total))}**`;
    return out;
  }

  function replyRemaining() {
    const cats = Object.keys(CATEGORIES);
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    if (!cats.length && profile.income <= 0) {
      return `You haven't trained me yet! Start with:
• *"My monthly income is 8000"*
• *"Set my Education budget to 600"*`;
    }
    const lines = cats.map(name => {
      const limit = budgetOf(name);
      const spentC = totalsByCategory()[name] || 0;
      return limit > 0
        ? `• ${name}: **${money(Math.max(0, limit - spentC))}** left of ${CUR}${limit}`
        : `• ${name}: ${money(spentC)} spent (no limit)`;
    });
    const overall = profile.income > 0
      ? `Income-based Remaining: **${money(profile.income - total)}** of ${money(profile.income)}`
      : 'Set your income first: *"My monthly income is 8000"*';
    return `Here's where your budgets stand:\n${lines.join('\n')}\n${overall}.`;
  }

  function replyCategory(name) {
    name = rollToBudgeted(name) || name;       /* "dining" question → Food bucket */
    const limit = budgetOf(name);
    const spent = totalsByCategory()[name] || 0;
    const left = limit - spent;
    const recent = expenses.filter(e => e.category === name).sort((a, b) => b.ts - a.ts).slice(0, 3);
    let out = limit > 0
      ? `**${name}** this month: **${money(spent)}** of ${money(limit)} (${Math.round(spent / limit * 100)}%).\n`
      : `**${name}** this month: **${money(spent)}** (no limit set).\n`;
    out += limit > 0
      ? (left >= 0 ? `• Remaining: **${money(left)}**` : `• Over limit by **${money(-left)}**`)
      : `• Set one: *"Set my ${name} budget to 500"*`;
    if (recent.length) out += `\nRecent: ${recent.map(e => `${e.merchant} (${money(e.amount)})`).join(', ')}`;
    return out;
  }

  function replySummary() {
    const t = totalsByCategory();
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    if (!total) return `No expenses logged yet. Train me first: *"My monthly income is 8000"*`;
    const rows = Object.entries(t).sort((a, b) => b[1] - a[1])
      .map(([n, v]) => `• ${n}: **${money(v)}** (${total ? Math.round(v / total * 100) : 0}%)`);
    return `Spending summary — **${money(total)}** total this month:\n${rows.join('\n')}`;
  }

  function imageOnlyReply() {
    return `Receipt received. I could not reach the engine to read it right now.
• Check the engine badge (top-right) — n8n must be **Active** and its workflow needs a Gemini vision branch for images.
• Meanwhile you can log it manually — e.g. *"Spent ${CUR}23.50 at Whole Foods"*`;
  }

  function localAgent(text) {
    const t = text.toLowerCase();
    const exp = parseExpense(text);
    if (exp) return replyExpense(exp);

    if (/remaining|left.*budget|budget.*left|how much.*(left|remaining)/.test(t)) return replyRemaining();
    const catWord = t.match(/\b(grocer\w*|dining|utilit\w*|transport|shopping|education|health|travel|food)\b/);
    if (catWord && /spent|spend|budget|left|how much|status/.test(t)) {
      const w = catWord[1];
      const name = w.startsWith('grocer') ? 'Groceries' : w.startsWith('utilit') ? 'Utilities'
                 : w[0].toUpperCase() + w.slice(1);
      return replyCategory(name);
    }
    if (/summary|overview|breakdown|how much.*spend|spent so far/.test(t)) return replySummary();
    if (/help|what can you|how do i/.test(t)) return HELP;

    return `I couldn't find an amount in that message.
Try *"Spent ${CUR}12 on coffee at Starbucks"*, or ask *"What is my remaining budget?"* — say *"help"* for the full menu.`;
  }

  /* The n8n Gemini agent picks its own Category when appending to Google
     Sheets — teach it the user's trained categories inline (zero n8n edits
     needed) so "education purposes" lands in Education, never in
     Miscellaneous, and replies use ¥ instead of $. Budgeted umbrellas get
     explicit absorb hints so the agent writes "Food", never "Dining". */
  const ROLL_HINTS = {
    Food:          "Dining, restaurants, KFC/McDonald's/Starbucks, takeout, delivery, groceries, snacks",
    Groceries:     'supermarket runs, vegetables, rice, fruits, Walmart/Costco, dining and takeout',
    Dining:        'restaurants, KFC, cafes, food, takeout, delivery',
    Transport:     'bus, metro, subway, taxi, Uber/DiDi, rickshaw, CNG, fuel, parking, train tickets',
    Shopping:      'clothes, shoes, electronics, mall and online orders',
    Other:         'other purposes, miscellaneous or unspecified spending, generic merchant Various — anything that fits no specific category',
    Education:     'tuition, books, courses, coaching, school/admission fees, stationery, photocopy, xerox, printouts, notes, exam fees',
    Health:        'medicine, doctor visits, hospital, pharmacy, clinic',
    Utilities:     'electricity, water, gas, internet, wifi, phone bills, recharge',
    Rent:          'flat rent, accommodation',
    Travel:        'flights, hotels, trips, vacation',
    Entertainment: 'movies, games, streaming, concerts',
  };

  function categoryGuidance() {
    const cats = Object.keys(CATEGORIES);
    if (!cats.length) return '';
    const absorb = cats
      .filter(n => (CATEGORIES[n].budget || 0) > 0 && ROLL_HINTS[n])
      .map(n => `${n} absorbs: ${ROLL_HINTS[n]}`)
      .join(' | ');
    return `\n\n[FinAgent system note — follow strictly when logging to the sheet: Category MUST be exactly one of the user's own categories: ${cats.join(', ')}. TEXT CATEGORY WINS: if the user's own message text names a category (for example "spent on shopping budget" names Shopping, "paid for food" names Food, "transport cost" names Transport), you MUST log it under that exact named category — the user's words override any receipt hint and are NEVER treated as unspecified. Pick the closest match only when the text names no category; NEVER invent a near-duplicate or parallel category (no "Dining" when Food exists, no "Grocery" when Food/Groceries exists), and never use "Miscellaneous" unless nothing fits. If the user's text says "other purposes" or "miscellaneous", that IS naming their Other category — use "Other" when one exists, never "Shopping". The "Other" fallback is ONLY for spending where neither the text nor the receipt names a category — if the text names a real category, "Other" is wrong.${absorb ? ' Roll-ups: ' + absorb + '.' : ''} Currency is CNY: write amounts as ¥xx, never $.]`;
  }

  /* appended to image (receipt) messages — the engine must READ the
     picture and log from the user's own categories, never invent one.
     v8.3.7 VISION-FIRST: the model is ordered to read the photo like a
     bookkeeper (Chinese + English total keywords), to take the category
     from what the receipt sells, and to NEVER answer with a sentinel
     ("ERR"/"Unknown"/"Miscellaneous") or ask the user to retype the
     amount — that apology dead-end is gone. With the sheet write using
     this category, the app's roll-up deducts from the right budget
     automatically on the next sync. */
  function receiptGuidance(email) {
    return `\n\n[FinAgent receipt note — the user attached a receipt/payment screenshot. You ARE a vision model: READ THE PHOTO ITSELF, line by line, like a human bookkeeper — the picture is the source of truth for the total, merchant and date. TOTAL: find the printed grand total — 合计, 总计, 实付, 实收, 应付金额, Total, Grand Total, Amount Due, Total Payable, Balance Due — the big bold final figure; NEVER a subtotal, unit price or line item. MERCHANT: the store/shop name printed at the top. Values like "ERR", "Error", "Unknown", "N/A", "???" or blank are FORBIDDEN as merchant — write the best name you can actually see on the photo. CATEGORY: read it FROM THE IMAGE — what the receipt sells decides: food/restaurant/grocery items → the user's Food or Dining; clothes/shoes/electronics/mall goods → Shopping; tuition/school/books/stationery → Education; taxi/metro/fuel/parking → Transport; medicine/pharmacy/hospital → Health; electricity/water/gas/internet bills → Utilities; hotel/flights/trips → Travel; movies/games → Entertainment. Use ONLY the user's own category names (see the FinAgent system note). "Other"/"Miscellaneous" is ONLY for a photo where genuinely nothing recognizable appears — a receipt whose items you can read must NEVER land there. TEXT BEATS IMAGE: if the user's own message text names a category, that exact named category overrides the image hints (see TEXT CATEGORY WINS). SHEET ROW CONTRACT — the row's userId column MUST be exactly "${email}" (never a name, never blank); amount column = plain number only, no currency symbol or comma (write 258.00, never ¥258.00); date = YYYY-MM-DD; merchant = store name. Amount in CNY. NEVER ask the user to type the amount manually when a photo is attached — reading it is YOUR job: write the row with your best reading of the printed total and, only if a part was truly unclear, say exactly which part. Log it as ONE expense for this user.]`;
  }

  /* =====================================================================
     N8N CHAT BRIDGE — 45s timeout for agent + tools + retries
  ===================================================================== */
  function extractReply(data) {
    if (data == null) return null;
    if (Array.isArray(data)) return data.length ? extractReply(data[0]) : null;
    if (typeof data === 'string') return data;
    if (typeof data === 'object') {
      for (const k of ['output', 'reply', 'text', 'message', 'response', 'answer'])
        if (typeof data[k] === 'string' && data[k].trim()) return data[k];
      if (data.json) return extractReply(data.json);
    }
    return null;
  }

  async function callWebhook(payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(getWebhook(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json() : await res.text();
      return extractReply(data);
    } finally {
      clearTimeout(timer);
    }
  }

  /* =====================================================================
     CHAT UI
  ===================================================================== */
  function scrollChat() { chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' }); }

  function inlineFmt(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-emerald-300">$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code class="bot-code">$1</code>');
  }

  function formatBotText(text) {
    const wrap = document.createElement('div');
    text.split('\n').forEach(line => {
      if (!line.trim()) return;
      const row = document.createElement('div');
      if (line.startsWith('• ')) {
        row.className = 'bot-line bot-bullet';
        row.innerHTML = '<span class="bullet-dot"></span>';
        const span = document.createElement('span');
        span.innerHTML = inlineFmt(line.slice(2));
        row.appendChild(span);
      } else {
        row.className = 'bot-line';
        row.innerHTML = inlineFmt(line);
      }
      wrap.appendChild(row);
    });
    return wrap;
  }

  function addBotMessage(text) {
    const row = document.createElement('div');
    row.className = 'msg msg--bot';
    row.innerHTML = '<div class="avatar"><i class="fa-solid fa-robot"></i></div>';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.appendChild(formatBotText(text));
    row.appendChild(bubble);
    chatMessages.appendChild(row);
    scrollChat();
  }

  function addUserMessage(text, image) {
    const row = document.createElement('div');
    row.className = 'msg msg--user';
    row.innerHTML = '<div class="avatar"><i class="fa-solid fa-user"></i></div>';
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (image ? ' has-image' : '');
    if (image) {
      const img = document.createElement('img');
      img.className = 'receipt-img';
      img.src = image;
      img.alt = 'Receipt image';
      bubble.appendChild(img);
    }
    const label = text || (image ? 'Receipt attached' : '');
    if (label) {
      const t = document.createElement('div');
      t.textContent = label;
      t.style.whiteSpace = 'pre-wrap';
      bubble.appendChild(t);
    }
    row.appendChild(bubble);
    chatMessages.appendChild(row);
    scrollChat();
  }

  function showTyping() {
    if (typingRow) return;
    typingRow = document.createElement('div');
    typingRow.className = 'msg msg--bot';
    typingRow.innerHTML = '<div class="avatar"><i class="fa-solid fa-robot"></i></div>' +
      '<div class="bubble typing"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>';
    chatMessages.appendChild(typingRow);
    scrollChat();
  }

  function hideTyping() { if (typingRow) { typingRow.remove(); typingRow = null; } }

  function setSendBusy(b) {
    sendBtn.disabled = b;
    sendBtn.innerHTML = b
      ? '<i class="fa-solid fa-circle-notch fa-spin"></i>'
      : '<i class="fa-solid fa-paper-plane"></i>';
  }

  /* =====================================================================
     RECEIPT OCR — the photo is read IN THE BROWSER (Tesseract.js from
     CDN, lazy-loaded on first use), so "attach pic → read the price →
     deduct from the right budget" needs ZERO n8n changes. The engine is
     merely TOLD what landed so its Sheets write stays consistent.
  ===================================================================== */

  /* receipt text → { amount, merchant, category|null } | null  (pure) */
  function parseReceiptText(text) {
    const clean = String(text || '').replace(/\r/g, '');
    if (!clean.trim()) return null;
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);

    /* dates / phones / reference numbers poison number-picking — scrub them */
    const scrub = l => String(l)
      .replace(/\b\d{1,4}[-/.]\d{1,4}[-/.]\d{2,4}\b/g, ' ')   /* 16/10/2026 · 2026-10-16 */
      .replace(/\b\d{7,}\b/g, ' ')                             /* phones, TRN, invoice ids */
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');          /* times */
    const grab = l => {
      const m = scrub(l).match(/\d[\d,]*(?:\.\d{1,2})?/g);
      return m ? m.map(s => Number(String(s).replace(/,/g, ''))) : [];
    };

    /* 1 · amount — grand-total lines win, then TOTAL, then amount/due
       words; last resort the largest plausible number (the total usually
       dominates a slip). SUBTOTAL/TAX/VAT lines are skipped. */
    const totalLine = /(grand\s*total|total\s*(?:amount|due|payable)|amount\s*(?:due|payable)|net\s*payable|balance\s*due|মোট)/i;
    let amount = null;
    const pickFrom = preds => {
      for (const l of lines) {
        if (!preds.some(p => p.test(l)) || /sub\s*total/i.test(l)) continue;
        const nums = grab(l);
        if (nums.length) { amount = nums[nums.length - 1]; return true; }
      }
      return false;
    };
    if (!pickFrom([totalLine])
      && !pickFrom([/\btotal\b/i])
      && !pickFrom([/\bamount\b/i, /\bdue\b/i, /\bpayable\b/i, /\bcash\b/i, /\btender\b/i, /\bpaid\b/i])) {
      const sym  = lines.filter(l => /(?:৳|\btk\b|bdt|¥|￥|\$|\brs\b|€|£)/i.test(l)).flatMap(grab);
      const all  = lines.flatMap(grab);
      const pool = (sym.length ? sym : all).filter(v => v >= 1 && v <= 999999);
      if (pool.length) amount = Math.max(...pool);
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return null;

    /* 2 · category — trained name → static keywords → roll onto the
       budgeted umbrella; the user's "Other" absorbs when it exists; a
       LONE budgeted bucket takes it; otherwise null (ask the user —
       never invent one) */
    const hay = lines.join(' ');
    let category = matchTrainedCategory(hay) || detectCategory(hay);
    if (category) category = rollToBudgeted(category) || category;
    if (!category) {
      const other = Object.keys(CATEGORIES).find(k => k.toLowerCase() === 'other');
      if (other) category = other;
    }
    if (!category) {
      const budgeted = Object.keys(CATEGORIES).filter(k => (CATEGORIES[k].budget || 0) > 0);
      if (budgeted.length === 1) category = budgeted[0];
    }
    /* receipts may ONLY land in categories THIS user actually has — a
       static-keyword name the user never trained becomes null and the
       app asks instead of inventing a parallel bucket */
    if (category && !Object.keys(CATEGORIES).some(k => k.toLowerCase() === String(category).toLowerCase()))
      category = null;

    /* 3 · merchant — first meaningful printed line (store name sits on top) */
    const NOISE = /^(tax\s*invoice|invoice|receipt|cash|sales|customer|merchant|www\.|http|phone|tel|mobile|address|date|time|order|bill|table|server|cashier|terminal|thank|vat|tin\b)/i;
    let merchant = null;
    for (const l of lines) {
      const cand = l.replace(/[^A-Za-z0-9&'.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (cand.length < 3 || NOISE.test(cand) || /^[0-9\s\-/.]+$/.test(cand)) continue;
      merchant = titleCase(cand.split(/\s+/).slice(0, 3).join(' '));
      break;
    }

    return {
      amount: +amount.toFixed(2),
      merchant: merchant || category || 'Receipt',
      category: category || null,
    };
  }

  /* ---------- browser-only OCR glue (not exercised by unit tests) ---------- */
  let ocrLibPromise = null, ocrWorker = null;
  function loadTesseract() {
    if (typeof window !== 'undefined' && window.Tesseract) return Promise.resolve(window.Tesseract);
    if (ocrLibPromise) return ocrLibPromise;
    ocrLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      s.onload  = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR library did not initialize'));
      s.onerror = () => { ocrLibPromise = null; reject(new Error('OCR library download failed')); };
      document.head.appendChild(s);
    });
    return ocrLibPromise;
  }

  async function runReceiptOCR(dataUrl) {
    const T = await loadTesseract();
    if (!ocrWorker) ocrWorker = await T.createWorker('eng');  /* eng traineddata downloads once, then cached */
    const { data } = await ocrWorker.recognize(dataUrl);
    return data && data.text ? data.text : '';
  }

  /* v8.3.2 — shrink a receipt photo before OCR + before it rides to n8n.
     Phone photos are 3000-4000px: Tesseract crawls on them (often past the
     60s timeout → the silent catch killed the whole receipt path), and the
     base64 payload can top n8n's body limit. 1400px @0.75 keeps every
     printed total perfectly legible while cutting both by ~10x.

     v8.3.6 — READ-QUALITY FIX (probe-proven): fed a CLEAN upright receipt,
     the agent reads it perfectly ("GREEN MART, ¥308.00, 2026-10-19" in
     4.5s) — so the user's garbled "Wo. YER Whi"-style reads came from the
     PHOTO, not the model. Two deterministic fixes here:
     1 · EXIF-SAFE DECODE — phone photos carry a rotation tag; the old
         Image() decode dropped it and the agent received a sideways
         receipt ("image ulta palta"). createImageBitmap with
         imageOrientation:'from-image' bakes the TRUE upright orientation
         into every copy (OCR + engine).
     2 · GLARE/SHADOW NORMALIZATION — receipts are monochrome print;
         grayscale + contrast lift makes faded/glared text legible again
         for BOTH Tesseract and Gemini (ctx.filter is a no-op where a
         browser lacks it). */
  function shrinkImage(dataUrl, maxDim = 1400, quality = 0.75) {
    const paint = source => {
      try {
        const scale = Math.min(1, maxDim / Math.max(source.width, source.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(source.width * scale));
        c.height = Math.max(1, Math.round(source.height * scale));
        const ctx = c.getContext('2d');
        try { ctx.filter = 'grayscale(1) contrast(' + (maxDim >= 2000 ? '1.18' : '1.22') + ') brightness(1.06)'; } catch { /* old browser → unfiltered */ }
        ctx.drawImage(source, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', quality);
      } catch { return dataUrl; }
    };
    const legacyDecode = () => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('decode failed'));
      img.src = dataUrl;
    });
    const decode = () =>
      fetch(dataUrl)
        .then(r => r.blob())
        .then(blob => createImageBitmap(blob, { imageOrientation: 'from-image' }));
    return decode()
      .then(paint)
      .catch(() => legacyDecode().then(paint))
      .catch(() => dataUrl);   /* v8.3.2 contract: never reject — worst case passthrough */
  }

  /* ---------- receipt reply cards ---------- */
  function replyReceipt(exp) {
    const limit = budgetOf(exp.category);
    const spent = totalsByCategory()[exp.category] || 0;
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    let out = `🧾 Receipt read — **${money(exp.amount)}** at **${exp.merchant}**, deducted from **${exp.category}**.\n`;
    out += limit > 0
      ? `• ${exp.category}: ${money(spent)} of ${money(limit)} — ${Math.round(spent / limit * 100)}% of limit, ${money(Math.max(0, limit - spent))} left\n`
      : `• ${exp.category}: ${money(spent)} so far (no limit — try *"Set my ${exp.category} budget to 500"*)\n`;
    out += `• Total spent: ${money(total)} · Remaining: **${money(Math.max(0, budgetTotal() - total))}**`;
    return out;
  }

  function askReceiptCategory() {
    const p = pendingReceipt;
    const cats = Object.keys(CATEGORIES);
    const hint = cats.length ? `Your categories: ${cats.join(', ')}.` : 'Train a budget first, e.g. *"Set my Food budget to 500"*.';
    return `🧾 I read **${money(p ? p.amount : 0)}**${p && p.merchant ? ` at **${p.merchant}**` : ''} from the photo, but I couldn't match it to one of your categories.\nReply with just the category name — like *"Food"* — and I'll deduct it from that budget.\n${hint}`;
  }

  /* v8.3.2 — dead-end rescue card. Shown when a photo came in, the browser
     OCR could not log it, and the cloud agent answered with an image
     complaint (it is text-only until the n8n vision branch is built).
     Gives the user a path that ALWAYS works: type the amount + store. */
  function receiptFallbackCard() {
    return `📷 The photo didn't give a confident read — no guesswork gets logged.
Fastest fix: type the amount and store in one line, e.g. *"Spent ${CUR}120 at KFC"*, and I'll log it instantly against the right budget. Or retake the photo straight above the print, light ON the paper, no shadow.`;
  }

  /* v8.3.7 — the read-failure / dead-end reply shapes, hoisted to ONE
     constant so both consumers agree: the reply renderer (rescue card)
     and the v8.3.9 engine-confirmation parser below (an apology or an
     "I couldn't write the row" is never a confirmation). */
  const READ_FAIL_RE = /didn'?t receive|did not receive|not receive any|no image|can'?t see|cannot see|couldn'?t see|can'?t read|could not read|couldn'?t read|unable to (read|see|extract|recognize)|failed to (read|see|extract|recognize)|unreadable|too (blurry|dark|small)|blurry|unclear|can'?t make out|couldn'?t make out|hard to read|please (type|enter|provide|tell me)[^.]{0,30}(amount|total|manually)|(enter|provide|type)[^.]{0,14}manually/i;

  /* =====================================================================
     v8.3.9 — ENGINE CONFIRMATION MATERIALIZATION (pure)
     The live bug (¥3917 Ecstasy receipt): the advanced path DEFERS a
     dodgy OCR read to the engine — nothing is logged locally — so the
     budget panel depends 100% on the sync read-back adopting the
     engine-written row. But those read-back rows historically arrive
     WITHOUT a usable userId tag (live n8n forensics), and the ownership
     filter rightly rejects untagged rows with no local twin → the sheet
     row is CORRECT while the panel shows ¥0 forever.
     Fix: the engine's own success reply IS the write confirmation.
     Parse the logged amount / category / merchant out of it and let the
     caller materialize the row locally (sameSpend keeps it single).
     Pure + tolerant: null for apologies, refusals, or a reply that
     names none of the user's own categories (never invents one). */
  function receiptFromReply(reply, pinCat) {
    const txt = String(reply || '');
    if (!txt.trim() || READ_FAIL_RE.test(txt)) return null;
    if (/\b(?:couldn'?t|could not|failed to|unable to|did not|not able to)\s+(?:\w+\s+){0,2}?(?:log|write|save|add|record)/i.test(txt)) return null;
    /* markdown bold/code markers stripped ONCE — every matcher below
       sees plain words ("**Ecstasy**" must parse as Ecstasy) */
    const plain = txt.replace(/\*+/g, '').replace(/`+/g, '');
    /* dates / times / invoice numbers must never become the amount */
    const scrubbed = plain
      .replace(/#\d+/g, ' ')                                   /* invoice #59976 */
      .replace(/\b\d{1,4}[-\/.]\d{1,4}[-\/.]\d{2,4}\b/g, ' ')  /* 2026-03-03 · 3/3/26 */
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')           /* times */
      .replace(/\b\d{7,}\b/g, ' ');                            /* phones / TRNs */
    /* 1 · amount — the FIRST real money figure of the confirmation; the
       logged total leads the reply, limit recaps ("of ¥6000", "6000
       limit", "65%") trail behind and are context-guarded anyway. */
    let amount = null;
    const re = /(¥|￥|৳|\btk\b|\$|rs\.?|€|£)?\s*(\d[\d,]*(?:\.\d{1,2})?)(?!\d)/gi;
    for (const m of scrubbed.matchAll(re)) {
      const v = Number(m[2].replace(/,/g, ''));
      if (!Number.isFinite(v) || v <= 0 || v > 1000000) continue;
      const before = scrubbed.slice(Math.max(0, m.index - 30), m.index).trim();
      const after  = scrubbed.slice(m.index + m[0].length, m.index + m[0].length + 10).trim();
      if (/(?:limit|budget|remaining|left|income|salary)\s*(?:is|:|=)?\s*$/i.test(before)) continue;
      if (/^(?:%|limit|budget|remaining|left)/i.test(after)) continue;
      amount = v; break;
    }
    if (!Number.isFinite(amount)) return null;
    /* 2 · category — the app's own text-pinned category wins outright;
       else an explicit "category: X / deducted from X" phrase; else any
       of the user's OWN category names (budgeted buckets preferred). */
    let category = pinCat || null;
    if (!category) {
      const m = plain.match(/(?:category|类别|deducted from|logged under|filed under|written under)\s*[:：]?\s*([A-Za-z][A-Za-z ]{0,24}?)(?=\.|,|;|\n|\||—|!|\?|，|、|$)/i);
      if (m) category = Object.keys(CATEGORIES).find(k => k.toLowerCase() === m[1].trim().toLowerCase()) || null;
    }
    if (!category) {
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hits = Object.keys(CATEGORIES).filter(k => new RegExp('(^|[^A-Za-z])' + esc(k) + '([^A-Za-z]|$)', 'i').test(plain));
      if (hits.length) category = hits.find(k => (CATEGORIES[k].budget || 0) > 0) || hits[0];
    }
    if (!category) return null;   /* never invent — the read-back owns the row */
    /* 3 · merchant — "at Ecstasy" / "Merchant: Ecstasy"; cosmetic */
    const mm = plain.match(/\b(?:at|from|merchant|store)\s+["'“”]?([A-Za-z][A-Za-z0-9&'.\- ]{1,30})/i);
    const merchant = mm ? titleCase(mm[1].trim().replace(/\s+/g, ' ').split(/\s+/).slice(0, 3).join(' ')) : (category || 'Receipt');
    return { amount: +amount.toFixed(2), category, merchant };
  }

  /* ------------------------------ send pipeline ------------------------------ */
  async function handleSend(text, image) {
    if (busy || !currentUser || (!text.trim() && !image)) return;
    busy = true;
    setSendBusy(true);

    /* profile/training commands (income + multiple budgets) — handled
       locally, each one saved to the engine under the user's email */
    const cmds = parseProfileCommands(text);
    if (cmds.length) {
      addUserMessage(text, null);
      await handleProfileCommands(cmds);
      busy = false;
      setSendBusy(false);
      chatInput.focus();
      return;
    }

    /* a receipt is waiting for its category ("I read ¥45 at Green Mart —
       reply with the category") — a bare category reply completes it and
       deducts from THAT budget */
    if (pendingReceipt && !image && !parseExpense(text)) {
      const hit = matchTrainedCategory(text) || detectCategory(text);
      if (hit) {
        const cat = rollToBudgeted(hit) || hit;
        addUserMessage(text, null);
        const entry = addExpense({ amount: pendingReceipt.amount, category: cat, merchant: pendingReceipt.merchant });
        pendingReceipt = null;
        addBotMessage(replyReceipt(entry));
        busy = false;
        setSendBusy(false);
        chatInput.focus();
        return;
      }
    }

    addUserMessage(text, image);
    clearAttach();

    /* receipt photo — read it LOCALLY in the browser (Tesseract OCR),
       log against the user's own category and deduct from that budget
       immediately; the engine is then TOLD what landed so its Sheets
       write stays consistent (the sync merge dedupes it). */
    receiptTruth = null;                /* v8.3.7 — fresh per send; a stale truth can never leak */
    let receiptExp = null, engineImage = null, ocrRaw = '', deferredOcr = false;
    /* v8.3.8 — the user's text is parsed BEFORE the OCR runs: when the text
       names a category ("spent on shopping"), that category must govern the
       receipt row no matter what the local scan later guesses. */
    const textCat = image ? (matchTrainedCategory(text || '') || detectCategory(text || '')) : null;
    if (image) {
      showTyping();
      const original = image;             /* v8.3.5 — full-quality source kept for the engine copy */
      try {
        image = await shrinkImage(image);   /* v8.3.2 — faster OCR + ~10x smaller engine payload */
        const raw = await Promise.race([
          runReceiptOCR(image),
          wait(60000).then(() => { throw new Error('OCR timed out'); }),
        ]);
        ocrRaw = String(raw || '').replace(/\s+/g, ' ').trim();  /* v8.3.7 — even a failed parse carries digits */
        const hit = parseReceiptText(raw);
        if (hit && hit.amount > 0) {
          /* v8.3.8 — OCR CONFIDENCE GATE: a scan whose merchant came back
             as sentinel garbage ("ERR", "??", no-vowel gibberish) is a
             GARBAGE read — its digits are just as suspect. Auto-logging it
             locally shielded the row from EVERY correction layer (no pin,
             no receiptTruth, and the agent was told to COPY the garbage —
             the exact ¥552/ERR/Other bug from the live screenshot). Such
             scans are DEFERRED to the engine's vision instead: Gemini reads
             the sharp 2000px photo (+ the raw transcript) and logs the real
             printed total, while the text-named category still pins it. */
          const ocrDodgy = !hit.merchant ||
            /^(err(or)?|unknown|n\/a|null|none|misc(ellaneous)?|\?+|\.+|xx+)$/i.test(String(hit.merchant).trim()) ||
            (String(hit.merchant).length <= 4 && !/[aeiou]/i.test(String(hit.merchant)));
          if (ocrDodgy) {
            deferredOcr = true;             /* engine vision owns the read; offline fallback keeps the digits */
            pendingReceipt = { amount: hit.amount, merchant: hit.merchant };
          } else if (textCat || hit.category) {
            /* v8.3.8 — TEXT BEATS LOCAL OCR: the text-named category
               overrides whatever the scan guessed (the old code logged the
               scan's own "Other" and never even armed the pin). */
            const cat = textCat ? (rollToBudgeted(textCat) || textCat) : hit.category;
            receiptExp = addExpense({ amount: hit.amount, category: cat, merchant: hit.merchant });
          } else {
            pendingReceipt = { amount: hit.amount, merchant: hit.merchant };
            receiptTruth = { amount: hit.amount, merchant: hit.merchant, at: Date.now() };  /* v8.3.7 — trusted OCR ground truth */
          }
        }
      } catch { /* OCR unavailable (offline / CDN blocked) → engine vision or manual entry */ }
      /* v8.3.5 — the agent now reads a SHARP 2000px @0.82 copy re-encoded from
         the original, not the OCR-grade 1400px @0.75: Tesseract wanted speed,
         Gemini wants legibility (garbled "Wo. YER Whi"-style merchant reads). */
      if (!receiptExp) engineImage = await shrinkImage(original, 2000, 0.82);
      hideTyping();
    }

    const exp = !receiptExp && text ? parseExpense(text) : null;
    if (exp) addExpense(exp);

    showTyping();

    let reply = null, webhookOk = false;
    const url = getWebhook();

    /* v8.3.5 — CATEGORY PIN: the app parses the user's text with its OWN
       category engine (the same battle-tested matcher that routes typed
       expenses) and PINS the result. The agent is no longer asked to
       judge a category — it is told. No text-named category → pin cleared,
       so a stale pin can never leak into the next image message. */
    const pinCat = image && !receiptExp ? textCat : null;   /* v8.3.8 — the SAME parse the OCR gate used */
    categoryPin = pinCat ? { cat: pinCat, at: Date.now() } : null;

    /* v8.3.7 — OCR TRANSCRIPT BRIDGE: whatever Tesseract managed to scan
       (even a garbled, unparsable read) rides to the agent as TEXT next to
       the photo, so Gemini can cross-check the noisy digits against the
       image — the hybrid read neither modality matches alone. Empty when
       no image went out or OCR never ran; scoped to THIS send only. */
    const ocrBridge = image && !receiptExp && ocrRaw
      ? `\n\n[FinAgent OCR transcript — the browser's own OCR scanned THIS photo${pendingReceipt ? '' : ' but could not confidently parse it'}; letters may be garbled, digits are usually accurate: "${ocrRaw.slice(0, 500)}". Cross-check the transcript against the photo and write the printed grand total.]`
      : '';

    if (url) {
      try {
        reply = await callWebhook({
          action: 'chat',
          chatInput: (receiptExp
              ? `The user attached a receipt photo that the app already read and logged: ${money(receiptExp.amount)} at ${receiptExp.merchant}, category ${receiptExp.category}. Write exactly ONE expense row to the sheet for userId ${currentUser.email} — amount ${receiptExp.amount}, merchant ${receiptExp.merchant}, category ${receiptExp.category}, date today. Do not log a second row; just confirm briefly.`
              : (text || 'Please log this receipt as an expense.')
                + (image && pendingReceipt && receiptTruth
                  ? `\n\n[FinAgent local OCR note — the app's own OCR already read THIS receipt: total ${money(pendingReceipt.amount)}${pendingReceipt.merchant ? `, merchant "${pendingReceipt.merchant}"` : ''}. Write the row with THIS exact total and merchant — the app verifies both against its OCR read.]`
                  : '')
                + (deferredOcr
                  ? `\n\n[FinAgent OCR warning — the browser's own scan of THIS photo came back GARBAGE (unreadable merchant${pendingReceipt ? ` "${pendingReceipt.merchant}"` : ''}, digits just as suspect). Do NOT copy the browser OCR: treat the PHOTO as the only source of truth and read the printed grand total, merchant and date from the image yourself.]`
                  : ''))
            + ocrBridge
            + ((exp || receiptExp || image || /spent|paid|bought|cost|logged|expense/i.test(text || '')) ? categoryGuidance() : '')
            + (image && !receiptExp ? receiptGuidance(currentUser.email) : '')
            + (pinCat
              ? `\n\n[FinAgent CATEGORY PIN — the app parsed the user's text with its own category engine: the category for this expense is PINNED to "${pinCat}". Write exactly "${pinCat}" in the category column of the row — do not choose, do not guess, any other category. The image is for the amount, merchant and date only.]`
              : ''),
          image: receiptExp ? image : (engineImage || image || null),
          sessionId,
          userId: currentUser.email,
          textCategory: pinCat || undefined,
          currency: 'CNY',
          timestamp: new Date().toISOString(),
          source: 'finagent-web',
        });
        webhookOk = true;
        if (exp) { exp.status = 'synced'; saveData(); renderTransactions(); }
      } catch (err) {
        toast('error', 'Webhook unreachable — replying with the local agent. (' +
          (err.name === 'AbortError' ? 'timeout' : err.message) + ')');
      }
    }

    await wait(550 + Math.random() * 450);
    hideTyping();

    if (receiptExp)          addBotMessage(replyReceipt(receiptExp));
    else if (pendingReceipt && deferredOcr && !webhookOk && pinCat) {
      /* v8.3.8 — offline fallback: the engine is unreachable, so the
         scanned digits log under the TEXT-pinned category (best effort) */
      const e = addExpense({ amount: pendingReceipt.amount, category: pinCat, merchant: pendingReceipt.merchant });
      pendingReceipt = null;
      addBotMessage(replyReceipt(e));
    }
    else if (pendingReceipt && deferredOcr && !webhookOk) addBotMessage(askReceiptCategory());
    else if (pendingReceipt && !deferredOcr) addBotMessage(askReceiptCategory());
    else if (pendingReceipt) pendingReceipt = null;   /* v8.3.8 — engine owns the row; no stale local completion */

    const replyTxt = reply && String(reply).trim();
    if (replyTxt && image && !receiptExp && !pendingReceipt &&
        READ_FAIL_RE.test(replyTxt)) {
      /* v8.3.7 — read-failure rescue: whether the agent says it never saw
         the photo (v8.3.2) or admits it could not READ it ("wrong read",
         "too blurry", "please provide the amount manually" — the apology
         dead-end from the live bug report), the user gets the SAME
         always-works card: retake tips + type-the-amount path. */
      addBotMessage(receiptFallbackCard());
    } else if (replyTxt) {
      addBotMessage(replyTxt);
    } else if (webhookOk && !receiptExp && !pendingReceipt)  addBotMessage(UNSTRUCTURED_REPLY);
    else if (!webhookOk && !receiptExp && !pendingReceipt) {
      if (image && !text.trim()) addBotMessage(imageOnlyReply());
      else                       addBotMessage(localAgent(text || ''));
    }

    /* v8.3.9 — ENGINE CONFIRMATION MATERIALIZATION: on the engine-owned
       receipt path (photo in, nothing logged locally) the budget panel
       must not gamble on the read-back adopting the engine-written row
       (untagged read-back rows are rightly rejected as twin-less). The
       engine's own success reply IS the proof of the write — materialize
       the row locally so the category budget deducts THIS instant.
       ORDERING IS LOAD-BEARING: this block must run BEFORE the read-back
       below, because that call snapshots the ledger it was invoked with
       and its merge assignment would wipe a row added afterwards.
       sameSpend dedupe keeps it single; when the read-back DOES find the
       tagged sheet row, this local row simply flips to "Synced". */
    if (webhookOk && image && !receiptExp && replyTxt && !READ_FAIL_RE.test(replyTxt)) {
      const cand = receiptFromReply(replyTxt, pinCat);
      if (cand) {
        /* v8.3.7 receiptTruth (trusted local OCR) outranks a reply misread */
        if (receiptTruth && Date.now() - receiptTruth.at < 10 * 60 * 1000 &&
            Math.abs(cand.amount - receiptTruth.amount) > 0.01) cand.amount = receiptTruth.amount;
        if (!expenses.some(le => sameSpend(le, { amount: cand.amount, category: cand.category, merchant: cand.merchant, ts: Date.now() }))) {
          addExpense(cand);
          toast('success', `Receipt logged — ${CUR}${cand.amount.toFixed(2)} deducted from ${cand.category}.`);
        }
      }
    }

    if (webhookOk) syncFromEngine().catch(() => {});

    if (!url && !hintedLocal) {
      hintedLocal = true;
      toast('info', 'Running in local agent mode — connect n8n via the gear icon.');
    }

    busy = false;
    setSendBusy(false);
    chatInput.focus();
  }

  /* ------------------------------ attachment ------------------------------ */
  function showAttachPreview(name, dataUrl) {
    if (!attachPreview) return;
    attachPreview.classList.remove('hidden');
    attachPreview.innerHTML = `
      <div class="attach-chip">
        <img src="${dataUrl}" alt="receipt preview">
        <div class="min-w-0">
          <p class="max-w-[180px] truncate text-[12px] font-medium text-slate-100">${escapeHtml(name)}</p>
          <p class="text-[10px] text-slate-500">Receipt ready — sent as base64</p>
        </div>
        <button type="button" id="attachRemove" class="x" aria-label="Remove attachment">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
    $('attachRemove').addEventListener('click', clearAttach);
    attachBtn.classList.add('active');
  }

  function clearAttach() {
    pendingImage = null;
    if (attachPreview) { attachPreview.classList.add('hidden'); attachPreview.innerHTML = ''; }
    if (receiptInput) receiptInput.value = '';
    if (attachBtn)     attachBtn.classList.remove('active');
  }

  /* =====================================================================
     WEBHOOK MODAL
  ===================================================================== */
  function setEngineState(state) {   /* 'active' | 'offline' | 'standby' */
    engineBadge.classList.toggle('status-badge--on',  state === 'active');
    engineBadge.classList.toggle('status-badge--off', state !== 'active');
    engineBadgeText.textContent = state === 'active' ? 'n8n Engine Active'
                                : state === 'offline' ? 'n8n Engine Offline'
                                : 'n8n Engine Standby';
  }

  function updateBadge() {
    /* immediate paint from config; verifyEngine() confirms real reachability */
    setEngineState(getWebhook() ? 'active' : 'standby');
  }

  /* Cheap engine health probe — uses the getProfile branch (no Gemini call),
     so it answers fast. ANY HTTP reply (even an error payload) proves the
     workflow is reachable; only a network failure / abort shows Offline. */
  async function verifyEngine() {
    if (!getWebhook()) { setEngineState('standby'); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(getWebhook(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'getProfile',
          userId: (currentUser && currentUser.email) || 'engine-ping@finagent.ai',
          source: 'finagent-web',
          timestamp: new Date().toISOString(),
        }),
        signal: ctrl.signal,
      });
      setEngineState(res.ok ? 'active' : 'offline');
      if (res.ok) flushPendingRegisters().catch(() => {});   /* v8.3 — engine is back → sync parked registrations */
    } catch {
      setEngineState('offline');
    } finally {
      clearTimeout(timer);
    }
  }

  /* =====================================================================
     AMBIENT TREND ARROWS — pure decoration, market-ticker feel.
     Spawns ~14 Font-Awesome arrows inside .bg-scene with randomized
     position/size/speed; the CSS keyframe (arrowRise) floats each one
     from below the viewport to the top, forever. Negative animation-delay
     means they are already mid-flight on page load. Honors reduced motion.
  ===================================================================== */
  function spawnTrendArrows() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let scene = document.querySelector('.bg-scene');
    if (!scene) {
      scene = document.createElement('div');
      scene.className = 'bg-scene';
      document.body.prepend(scene);
    }
    if (scene.dataset.arrows) return;        /* guard against double-spawn */
    scene.dataset.arrows = '1';
    const COUNT = 14;
    for (let i = 0; i < COUNT; i++) {
      const el = document.createElement('i');
      el.className = 'fa-solid bg-arrow ' +
        (i % 3 === 0 ? 'fa-arrow-up-long' : 'fa-arrow-trend-up') +
        (i % 4 === 0 ? ' bg-arrow--cy' : '');
      el.style.fontSize = (13 + Math.random() * 22).toFixed(0) + 'px';          /* 13–35px */
      el.style.left = (Math.random() * 100).toFixed(2) + '%';
      el.style.animationDuration = (14 + Math.random() * 16).toFixed(1) + 's';  /* 14–30s per rise */
      el.style.animationDelay = (-Math.random() * 30).toFixed(1) + 's';         /* already rising */
      el.style.setProperty('--op', (0.06 + Math.random() * 0.09).toFixed(2));   /* 0.06–0.15, subtle */
      el.style.setProperty('--sway', ((Math.random() * 60) - 30).toFixed(0) + 'px');
      scene.appendChild(el);
    }
  }

  function openModal() {
    webhookInput.value = getWebhook();
    modalOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => webhookInput.focus());
  }

  function closeModal() {
    modalOverlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  /* =====================================================================
     EVENT BINDINGS + INIT
  ===================================================================== */
  function bindEvents() {
    tabLoginBtn.addEventListener('click', () => switchTab('login'));
    tabRegisterBtn.addEventListener('click', () => switchTab('register'));
    loginForm.addEventListener('submit', handleLogin);
    registerForm.addEventListener('submit', handleRegister);
    demoBtn.addEventListener('click', () => {
      clearFormErrors();
      seedDemoUser();
      toast('success', 'Signed in with the demo account.');
      enterApp({ name: 'Demo User', email: 'demo@finagent.ai' });
    });
    logoutBtn.addEventListener('click', handleLogout);

    chatForm.addEventListener('submit', e => {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (!text && !pendingImage) { chatInput.focus(); return; }
      chatInput.value = '';
      handleSend(text, pendingImage);
    });

    clearChatBtn.addEventListener('click', () => {
      hideTyping();
      chatMessages.innerHTML = '';
      if (currentUser) {
        addBotMessage(`Conversation cleared — your training and ledger are untouched.
Ask me anything, or tap a quick chip below.`);
      }
      toast('info', 'Conversation cleared.');
    });

    /* paperclip opens the file picker — skipped when index.html already
       triggers it (label wrap or inline onclick), so it never opens twice */
    if (attachBtn && receiptInput && !attachBtn.closest('label') && !attachBtn.getAttribute('onclick'))
      attachBtn.addEventListener('click', e => { e.preventDefault(); receiptInput.click(); });

    if (receiptInput) receiptInput.addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      if (!f.type.startsWith('image/')) { toast('error', 'Please attach an image file.'); return; }
      if (f.size > 4 * 1024 * 1024)     { toast('error', 'Receipt image must be under 4 MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => { pendingImage = reader.result; showAttachPreview(f.name, pendingImage); };
      reader.readAsDataURL(f);
      e.target.value = '';
    });

    webhookBtn.addEventListener('click', openModal);
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modalOverlay.classList.contains('open')) closeModal();
    });

    webhookForm.addEventListener('submit', e => {
      e.preventDefault();
      const v = webhookInput.value.trim();
      if (v) {
        try {
          const u = new URL(v);
          if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
        } catch {
          toast('error', "That doesn't look like a valid HTTP(S) URL.");
          return;
        }
      }
      if (v) localStorage.setItem(WEBHOOK_KEY, v);
      else   localStorage.removeItem(WEBHOOK_KEY);
      updateBadge();
      verifyEngine().catch(() => {});   /* confirm the saved endpoint for real */
      toast('success', v ? 'Webhook saved — engine now drives auth, ledger & chat.' : 'Endpoint cleared — running everything locally.');
      closeModal();
      if (v && currentUser) syncFromEngine({ silent: false }).catch(() => {});
    });

    /* Test Connection — 20s timeout: this request runs through the full
       AI Agent (Gemini call included) */
    testWebhookBtn.addEventListener('click', async () => {
      const url = webhookInput.value.trim();
      if (!url) { toast('info', 'Paste your n8n webhook URL first.'); webhookInput.focus(); return; }
      const original = testWebhookBtn.innerHTML;
      testWebhookBtn.disabled = true;
      testWebhookBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing…';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'chat', chatInput: '__connection_test__', source: 'finagent-config', timestamp: new Date().toISOString() }),
          signal: ctrl.signal,
        });
        if (res.ok) toast('success', `Webhook responded — HTTP ${res.status}. You're wired up.`);
        else        toast('error', `Endpoint replied with HTTP ${res.status}.`);
      } catch (err) {
        toast('error', err.name === 'AbortError'
          ? 'No response within 20 s — check the URL, CORS, or the agent may be rate-limited. Try again in a minute.'
          : 'Request failed — check the URL and CORS settings.');
      } finally {
        clearTimeout(timer);
        testWebhookBtn.disabled = false;
        testWebhookBtn.innerHTML = original;
      }
    });
  }

  function renderChips() {
    quickChips.innerHTML = CHIPS.map((c, i) =>
      `<button type="button" class="chip" data-i="${i}"><i class="fa-solid ${c.icon}"></i>${c.label}</button>`).join('');
    quickChips.addEventListener('click', e => {
      const btn = e.target.closest('.chip');
      if (!btn || busy || !currentUser) return;
      handleSend(CHIPS[+btn.dataset.i].label, null);
    });
  }

  function init() {
    seedDemoUser();
    buildBudgetRows();
    renderChips();
    bindEvents();

    /* deploy verification — the browser TAB title shows the build instantly
       (no DevTools, no Ctrl+F needed). If the tab does not say v8.3.9, the
       site is still serving the OLD script.js — re-deploy + hard-refresh. */
    document.title = 'FinAgent AI · v8.3.9';
    console.log(`%c${BUILD_TAG} — register auto-sync + per-user isolation + receipt UI-sync + text-category PIN + EXIF-upright receipt image + REAL-GEMINI vision protocol + OCR transcript bridge + sentinel judge + OCR CONFIDENCE GATE + engine confirmation materialization (budget panel syncs with the sheet) LIVE`,
      'background:#10B981;color:#0B0F19;font-weight:bold;padding:2px 8px;border-radius:4px');

    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const user = JSON.parse(raw);
        if (user && user.email) { enterApp(user); return; }
      }
    } catch { localStorage.removeItem(SESSION_KEY); }

    document.documentElement.classList.remove('authed');
    updateBadge();
    spawnTrendArrows();
    setTimeout(() => loginEmail.focus(), 450);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
