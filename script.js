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
  const DEFAULT_WEBHOOK = 'https://ainuba.app.n8n.cloud/webhook/finance-agent';
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
