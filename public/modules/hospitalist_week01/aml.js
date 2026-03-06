// Minimal AML: 3 decision points + reasoning + mastery scoring.
// This proves workflow end-to-end. You can later replace feedback with an AI endpoint.
window.AML_INIT_OK = true;
function $(id) { return document.getElementById(id); }
const CASES_URL = "/cases.json";
async function authMe() {
  const r = await fetch("/auth/me", { credentials: "include" });
  return r.json();
}

function setStatus(msg) {
  const el = $("status");
  if (el) el.textContent = msg || "";
}

window.addEventListener("DOMContentLoaded", () => {
  const btn = $("start-aml");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      setStatus("Starting AML…");

      const me = await authMe();
      if (!me.email) {
        setStatus("Not logged in. Go to the site home and do Dev Login (or normal login), then return here.");
        alert("Please login first (Dev Login or normal login), then retry Start AML Case.");
        return;
      }

      const res = await fetch("/cases.json", { credentials: "include" });
      if (!res.ok) {
        const txt = await res.text();
        setStatus(`Failed to load cases: ${res.status} ${txt.slice(0,120)}`);
        return;
      }

      const cases = await res.json();
      setStatus(`Loaded ${cases.length} cases. Rendering…`);

      // TODO: your existing AML rendering goes here
      const root = $("aml-root");
      root.style.display = "block";
      root.innerHTML = `<pre style="white-space:pre-wrap;">${JSON.stringify(cases.slice(0,3), null, 2)}</pre>`;
      setStatus("AML ready.");
    } catch (e) {
      console.error(e);
      setStatus("AML error: " + (e?.message || String(e)));
      alert("AML error: " + (e?.message || String(e)));
    }
  });
});

const AML = {
  moduleId: "hospitalist_week01_mock",
  masteryThreshold: 3, // must hit all 3 key decisions
  state: {
    score: 0,
    decisions: [],
    reasoning: {},
    completed: false,
  },
  questions: [
    {
      id: "q1",
      stem:
        "Case: 12y DSH, CKD stage 3, anorexia 48h. Mild dehydration. RR 28. K 3.1. Creatinine 3.2 (baseline 2.8). Day 1 plan: IV fluids + monitoring.\n\nQuestion 1: What are the top 3 active problems (in order)?",
      options: [
        { key: "A", text: "CKD progression; dehydration; hypokalemia", correct: true, feedback: "Good: prioritizes immediate physiologic issues while acknowledging CKD context." },
        { key: "B", text: "CKD progression; anorexia; dehydration", correct: false, feedback: "Close, but dehydration + electrolytes usually outrank anorexia for immediate inpatient risk." },
        { key: "C", text: "Anorexia; stress; CKD progression", correct: false, feedback: "This misses dehydration/electrolytes as actionable inpatient priorities." },
      ],
      reasoningPrompt: "In 2–4 sentences, justify your prioritization (what could harm the patient in the next 12–24 hours?).",
    },
    {
      id: "q2",
      stem:
        "Day 2: Fluids ran at ~2x maintenance. RR now 36. Mildly increased effort. Weight +0.4 kg. K now 2.9.\n\nQuestion 2: What is the most concerning interpretation?",
      options: [
        { key: "A", text: "Fluid overload developing; adjust fluids + supplement K; reassess respiratory status", correct: true, feedback: "Yes: weight gain + rising RR suggests fluid creep/overload risk—especially in CKD cats." },
        { key: "B", text: "Stress response; continue same plan and recheck tomorrow", correct: false, feedback: "Risky: this delays action despite objective trend changes." },
        { key: "C", text: "Hypokalemia alone explains the RR; increase fluid rate", correct: false, feedback: "Increasing fluids here can worsen overload; treat K without worsening respiratory status." },
      ],
      reasoningPrompt: "List 2 objective data points that support your interpretation and 1 immediate monitoring step.",
    },
    {
      id: "q3",
      stem:
        "Six hours later: RR 42, intermittent open-mouth breathing, SpO2 93%.\n\nQuestion 3: What’s your best next step as the hospitalist (ward leader)?",
      options: [
        { key: "A", text: "Trial oxygen + immediate reassessment, contact ICU/criticalist for escalation planning, define transfer threshold", correct: true, feedback: "Correct: manage immediate support while escalating appropriately and explicitly defining triggers." },
        { key: "B", text: "Wait for radiographs in the morning unless SpO2 drops below 90%", correct: false, feedback: "Too delayed: open-mouth breathing is an escalation signal in cats." },
        { key: "C", text: "Stop all fluids and discharge if the owner wants to avoid ICU", correct: false, feedback: "Unsafe: clinical compromise needs stabilization and documented goals-of-care discussion." },
      ],
      reasoningPrompt: "Write a one-paragraph escalation trigger statement you would put in the chart for the overnight team.",
    },
  ],
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  });
  children.forEach((c) => node.appendChild(c));
  return node;
}

function render() {
  const root = document.getElementById("amlRoot");
  root.innerHTML = "";
  AML.questions.forEach((q) => root.appendChild(renderQuestion(q)));
  updateRMVLock();
}

function renderQuestion(q) {
  const box = el("div", { class: "q" });
  box.appendChild(el("p", { text: q.stem }));

  const opts = el("div", { class: "opts" });
  q.options.forEach((o) => {
    const btn = el("button", { class: "optbtn", type: "button" });
    btn.textContent = `${o.key}. ${o.text}`;
    btn.onclick = () => answer(q.id, o);
    opts.appendChild(btn);
  });
  box.appendChild(opts);

  const fb = el("div", { class: "sub", id: `fb_${q.id}` });
  fb.style.marginTop = "8px";
  box.appendChild(fb);

  const rp = el("label", { });
  rp.innerHTML = `Reasoning (required)<textarea name="r_${q.id}" id="r_${q.id}" placeholder="${q.reasoningPrompt}"></textarea>`;
  box.appendChild(rp);

  return box;
}

function answer(qid, option) {
  const r = document.getElementById(`r_${qid}`).value.trim();
  if (!r) {
    alert("Please enter your reasoning before selecting an answer.");
    return;
  }

  AML.state.decisions = AML.state.decisions.filter(d => d.qid !== qid);
  AML.state.reasoning[qid] = r;

  AML.state.decisions.push({ qid, choice: option.key, correct: option.correct, ts: new Date().toISOString() });

  AML.state.score = AML.state.decisions.reduce((acc, d) => acc + (d.correct ? 1 : 0), 0);

  document.getElementById(`fb_${qid}`).textContent =
    `${option.correct ? "✅" : "❌"} ${option.feedback} (Score: ${AML.state.score}/${AML.questions.length})`;

  AML.state.completed = (AML.state.decisions.length === AML.questions.length);
  updateRMVLock();
}

function updateRMVLock() {
  const status = document.getElementById("rmvStatus");
  const form = document.getElementById("rmvForm");
  const mastery = (AML.state.score >= AML.masteryThreshold) && AML.state.completed;

  if (!AML.state.completed) {
    status.textContent = "Complete all 3 AML questions (with reasoning) to unlock.";
    form.classList.add("hidden");
    return;
  }

  if (!mastery) {
    status.textContent = "You completed the AML, but did not meet mastery. Review feedback, revise answers, and resubmit reasoning.";
    form.classList.add("hidden");
    return;
  }

  status.textContent = "Unlocked ✅ Submit your RMV reflection.";
  document.getElementById("masteryField").value = "true";
  document.getElementById("payloadField").value = JSON.stringify({
    module_id: AML.moduleId,
    score: AML.state.score,
    decisions: AML.state.decisions,
    reasoning: AML.state.reasoning,
    lesson_complete_checked: document.getElementById("lessonComplete")?.checked ?? false
  });

  form.classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  render();

  const rmvForm = document.getElementById("rmvForm");
  rmvForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = document.getElementById("rmvResult");
    result.textContent = "Submitting...";

    const data = Object.fromEntries(new FormData(rmvForm).entries());

    // TODO: update this to your real RMV endpoint path
    const RMV_ENDPOINT = "/api/rmv/submit";

    try {
      const resp = await fetch(RMV_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(t || `HTTP ${resp.status}`);
      }

      result.textContent = "Submitted ✅ (Check your RMV dashboard/logs.)";
    } catch (err) {
      result.textContent = `Submission failed: ${err.message}`;
    }
  });
});
