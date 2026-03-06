/*  aml.js — Week 1 Hospitalist AML (MCQ-style prototype)
    Folder: /public/modules/hospitalist_week01/aml.js

    What it does:
    - Wires up the "Start AML Case" button on index.html
    - Fetches cases from /cases.json (served by your Node server)
    - Filters to module = "hospitalist_week01"
    - Presents a 3-step MCQ flow (step 1 → step 2 → step 3)
    - Tracks attempts + mastery events via /track (optional; will fail gracefully if not logged in)
    - Unlocks RMV UI after mastery

    Expected CSV columns (Google Sheet):
      id, module, step, question, option_a, option_b, option_c, correct_option, explanation
*/

window.AML_INIT_OK = true;

(() => {
  const MODULE_ID = "hospitalist_week01";
  const CASES_URL = "/cases.json";
  const TRACK_URL = "/track";
  const AUTH_ME_URL = "/auth/me";

  // Mastery rule for this prototype
  const REQUIRED_STEPS = 3;
  const MAX_ATTEMPTS_PER_STEP = 3;

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const escapeHtml = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  // These IDs must exist in your module index.html
  const btnStart = $("#btnStart");
  const mount = $("#amlMount");
  const rmvArea = $("#rmvArea");
  const rmvStatus = $("#rmvStatus");
  const rmvEmail = $("#rmvEmail");

  // If your current page doesn't have these, we create minimal UI anyway
  function ensureMount() {
    if (!mount) {
      console.error("AML: missing #amlMount element.");
      return false;
    }
    if (!btnStart) {
      mount.innerHTML =
        `<div class="muted"><strong>AML:</strong> Missing <code>#btnStart</code> button in index.html.</div>`;
      return false;
    }
    return true;
  }

  // ---------- State ----------
  const state = {
    started: false,
    cases: [],
    steps: [], // array of step objects, sorted
    stepIndex: 0, // 0..REQUIRED_STEPS-1
    stepAttempts: 0,
    mastery: false,
    caseGroupId: null, // the "id" shared across steps
    email: null,
    role: null,
  };

  // ---------- Networking ----------
  async function fetchJson(url, opts = {}) {
    const resp = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!resp.ok) {
      const msg = data?.error || text || `HTTP ${resp.status}`;
      throw new Error(`${url} → ${msg}`);
    }
    return data;
  }

  async function loadAuthMe() {
    try {
      const me = await fetchJson(AUTH_ME_URL, { method: "GET" });
      state.email = me?.email || null;
      state.role = me?.role || null;
      if (rmvEmail && state.email) rmvEmail.value = state.email;
    } catch {
      // ok if not logged in
      state.email = null;
      state.role = null;
    }
  }

  async function loadCases() {
    const all = await fetchJson(CASES_URL, { method: "GET" });
    if (!Array.isArray(all)) throw new Error("cases.json did not return an array");
    state.cases = all;
    return all;
  }

  // Track events (optional). If unauthorized, we ignore.
  async function track(event_type, details = {}) {
    try {
      await fetchJson(TRACK_URL, {
        method: "POST",
        body: JSON.stringify({
          module: MODULE_ID,
          case_id: state.caseGroupId || null,
          event_type,
          details,
        }),
      });
    } catch (e) {
      // Most common failure is 401 when not logged in; ignore for prototype.
      // Uncomment next line if you want to see it:
      // console.warn("Track skipped:", e.message);
    }
  }

  // ---------- Case selection ----------
  function normalizeRow(row) {
    const correct = (row.correct_option || row.correct || "").toString().trim().toUpperCase();
    return {
      id: (row.id || "").toString().trim(),
      module: (row.module || "").toString().trim(),
      step: Number(row.step || 0),
      question: (row.question || "").toString().trim(),
      option_a: (row.option_a || "").toString().trim(),
      option_b: (row.option_b || "").toString().trim(),
      option_c: (row.option_c || "").toString().trim(),
      correct_option: correct, // "A" | "B" | "C"
      explanation: (row.explanation || "").toString().trim(),
    };
  }

  function groupByBaseId(rows) {
    // Supports ids like:
    //   hospitalist_week01_case01_step1
    // or:
    //   hospitalist_week01_case01 (with step column differentiating)
    // We treat the full `id` as group key unless it ends with _stepN.
    const groups = new Map();

    for (const r of rows) {
      const id = r.id;
      if (!id) continue;

      let key = id;
      const m = id.match(/^(.*)_step(\d+)$/i);
      if (m) key = m[1];

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return groups;
  }

  function pickRandomCaseGroup(allCases) {
    const moduleRows = allCases
      .map(normalizeRow)
      .filter((r) => r.module.toLowerCase() === MODULE_ID.toLowerCase())
      .filter((r) => r.step >= 1); // must have step

    if (!moduleRows.length) return null;

    const groups = groupByBaseId(moduleRows);
    const groupKeys = Array.from(groups.keys());

    // Prefer groups that have 3 steps
    const complete = groupKeys.filter((k) => groups.get(k).some((x) => x.step === 1) &&
                                            groups.get(k).some((x) => x.step === 2) &&
                                            groups.get(k).some((x) => x.step === 3));
    const candidates = complete.length ? complete : groupKeys;

    const pickKey = candidates[Math.floor(Math.random() * candidates.length)];
    const steps = groups.get(pickKey).slice().sort((a, b) => a.step - b.step);

    // If steps are missing, we still run with what exists, but mastery needs 3 correct
    return { caseGroupId: pickKey, steps };
  }

  // ---------- Rendering ----------
  function renderIntro(msg = "") {
    mount.innerHTML = `
      <div class="aml">
        <p class="muted">
          Click <strong>Start AML Case</strong> to load a 3-step inpatient reasoning mini-case
          from <code>${escapeHtml(CASES_URL)}</code>.
        </p>
        ${msg ? `<p class="muted">${escapeHtml(msg)}</p>` : ""}
      </div>
    `;
  }

  function renderStep() {
    const step = state.steps[state.stepIndex];
    if (!step) {
      mount.innerHTML = `<div class="muted"><strong>No step data found.</strong></div>`;
      return;
    }

    const stepNum = step.step || (state.stepIndex + 1);
    const attemptsLeft = Math.max(0, MAX_ATTEMPTS_PER_STEP - state.stepAttempts);

    mount.innerHTML = `
      <div class="aml card">
        <div class="row">
          <div>
            <div class="kicker">AML Case</div>
            <h3>${escapeHtml(state.caseGroupId)} — Step ${escapeHtml(stepNum)}</h3>
          </div>
          <div class="right muted small">
            Attempts left this step: <strong>${attemptsLeft}</strong>
          </div>
        </div>

        <div class="q">
          <p><strong>Question:</strong> ${escapeHtml(step.question)}</p>
        </div>

        <div class="opts">
          <label class="opt"><input type="radio" name="ans" value="A"> <span><strong>A.</strong> ${escapeHtml(step.option_a)}</span></label>
          <label class="opt"><input type="radio" name="ans" value="B"> <span><strong>B.</strong> ${escapeHtml(step.option_b)}</span></label>
          <label class="opt"><input type="radio" name="ans" value="C"> <span><strong>C.</strong> ${escapeHtml(step.option_c)}</span></label>
        </div>

        <div class="actions">
          <button class="btn primary" id="btnSubmit">Submit</button>
          <button class="btn" id="btnReset">Restart AML</button>
        </div>

        <div class="feedback" id="feedback"></div>
      </div>
    `;

    $("#btnSubmit")?.addEventListener("click", onSubmit);
    $("#btnReset")?.addEventListener("click", resetAML);
  }

  function renderMastery() {
    mount.innerHTML = `
      <div class="aml card">
        <div class="kicker">Mastery Achieved</div>
        <h3>✅ Week 1 AML mastery complete</h3>
        <p class="muted">
          You completed the 3-step reasoning case. RMV submission is now unlocked.
        </p>
        <div class="actions">
          <button class="btn" id="btnRestart">Do Another AML Case</button>
        </div>
      </div>
    `;
    $("#btnRestart")?.addEventListener("click", startAML);
    unlockRMV();
  }

  function setFeedback(html) {
    const el = $("#feedback");
    if (el) el.innerHTML = html;
  }

  function unlockRMV() {
    if (!rmvArea) return;
    rmvArea.style.opacity = "1";
    rmvArea.style.pointerEvents = "auto";
    if (rmvStatus) rmvStatus.textContent = "Unlocked. Submit your reflection when ready.";
  }

  function lockRMV() {
    if (!rmvArea) return;
    rmvArea.style.opacity = "0.6";
    rmvArea.style.pointerEvents = "none";
    if (rmvStatus) rmvStatus.textContent = "Complete AML mastery to unlock RMV submission.";
  }

  // ---------- Logic ----------
  async function startAML() {
    if (!ensureMount()) return;

    state.started = true;
    state.mastery = false;
    state.stepIndex = 0;
    state.stepAttempts = 0;

    mount.innerHTML = `<div class="muted">Loading cases…</div>`;

    await loadAuthMe(); // best effort

    const all = await loadCases();
    const picked = pickRandomCaseGroup(all);

    if (!picked) {
      mount.innerHTML = `
        <div class="muted">
          <strong>No cases found</strong> for module <code>${escapeHtml(MODULE_ID)}</code>.
          Check your Google Sheet CSV: module column must equal <code>${escapeHtml(MODULE_ID)}</code>.
        </div>
      `;
      return;
    }

    state.caseGroupId = picked.caseGroupId;
    state.steps = picked.steps;

    await track("aml_started", { case_group: state.caseGroupId, steps: state.steps.map((s) => s.step) });

    lockRMV();
    renderStep();
  }

  function resetAML() {
    state.started = false;
    state.mastery = false;
    state.steps = [];
    state.stepIndex = 0;
    state.stepAttempts = 0;
    state.caseGroupId = null;
    lockRMV();
    renderIntro("AML reset. Click Start AML Case again.");
  }

  async function onSubmit() {
    const step = state.steps[state.stepIndex];
    const picked = document.querySelector('input[name="ans"]:checked')?.value || "";
    if (!picked) {
      setFeedback(`<div class="warn">Please choose A, B, or C.</div>`);
      return;
    }

    const correct = (step.correct_option || "").trim().toUpperCase();
    const isCorrect = picked === correct;

    state.stepAttempts += 1;

    await track("attempt_submitted", {
      step: step.step,
      answer: picked,
      correct,
      attempt_number: state.stepAttempts,
      ok: isCorrect,
    });

    if (isCorrect) {
      setFeedback(`
        <div class="ok">
          <strong>Correct.</strong> ${escapeHtml(step.explanation || "Nice work.")}
        </div>
      `);

      // Move to next step
      state.stepIndex += 1;
      state.stepAttempts = 0;

      // If we don't have enough steps in this group, fail gracefully
      if (state.stepIndex >= REQUIRED_STEPS || state.stepIndex >= state.steps.length) {
        // Mastery requires 3 steps completed correctly; if less than 3 steps exist, we still mark "complete"
        // for prototype, but you can tighten this later.
        state.mastery = true;
        await track("mastery_pass", { case_group: state.caseGroupId });
        renderMastery();
        return;
      }

      // Render next step after a brief delay
      setTimeout(renderStep, 350);
      return;
    }

    // Incorrect
    const attemptsLeft = MAX_ATTEMPTS_PER_STEP - state.stepAttempts;

    if (attemptsLeft > 0) {
      setFeedback(`
        <div class="warn">
          <strong>Not quite.</strong> Try again.
          <div class="muted small">Hint: focus on inpatient trend-risk and escalation thresholds.</div>
        </div>
      `);
      return;
    }

    // Out of attempts: show answer and reset to this step
    setFeedback(`
      <div class="bad">
        <strong>Step failed.</strong> The correct answer was <strong>${escapeHtml(correct)}</strong>.
        <div class="muted">${escapeHtml(step.explanation || "")}</div>
        <div class="muted small">Restarting this step. You can also restart the whole AML.</div>
      </div>
    `);

    await track("step_failed", { step: step.step, correct });

    // Reset attempts for this step so they can re-try
    state.stepAttempts = 0;
  }

  // ---------- Wire up Start button ----------
  function init() {
    if (!ensureMount()) return;

    // If RMV area exists, lock it until mastery
    lockRMV();

    // Initial UI
    renderIntro();

    btnStart.addEventListener("click", () => {
      startAML().catch((e) => {
        console.error("AML start error:", e);
        mount.innerHTML = `<div class="bad"><strong>Error:</strong> ${escapeHtml(e.message)}</div>`;
      });
    });
  }

  // Start
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
