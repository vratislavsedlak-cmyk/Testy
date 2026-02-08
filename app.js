import { parseTestFromPdfText } from "./parser.js";
import { loadAllTests, upsertTest, clearAllTests } from "./storage.js";

/**
 * Robustnější extrakce textu z PDF:
 * - PDF nemá skutečné newline; vytvoříme je heuristikou podle změny Y pozice textových položek.
 * - Tím vzniknou řádky, které pak parser umí dobře rozdělit na otázky a odpovědi.
 */
async function extractTextFromPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;

  const pages = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    let lastY = null;
    let out = "";

    for (const item of content.items) {
      const str = item.str ?? "";
      const y = item.transform?.[5];

      if (lastY === null) {
        lastY = y;
      } else if (y !== lastY) {
        out += "\n";
        lastY = y;
      }

      // mezera mezi tokeny (PDF.js často rozseká slova)
      out += str + " ";
    }

    pages.push(out.trim());
  }

  return pages.join("\n\n");
}

function uid() {
  return "t_" + Math.random().toString(16).slice(2) + "_" + Date.now();
}

const els = {
  fileInput: document.getElementById("fileInput"),
  btnImport: document.getElementById("btnImport"),
  btnClearAll: document.getElementById("btnClearAll"),
  importStatus: document.getElementById("importStatus"),
  testsList: document.getElementById("testsList"),

  runnerCard: document.getElementById("runnerCard"),
  testTitle: document.getElementById("testTitle"),
  testMeta: document.getElementById("testMeta"),
  scoreBox: document.getElementById("scoreBox"),
  questionBox: document.getElementById("questionBox"),
  btnRestart: document.getElementById("btnRestart"),
  btnRetryWrong: document.getElementById("btnRetryWrong"),
  finalBox: document.getElementById("finalBox"),
};

let current = null;

function renderTestsList() {
  const tests = loadAllTests();

  if (!tests.length) {
    els.testsList.innerHTML = `<p class="muted">Zatím žádné testy.</p>`;
    return;
  }

  els.testsList.innerHTML = tests
    .map((t) => {
      const dt = new Date(t.createdAt).toLocaleString("cs-CZ");
      return `
        <div class="testItem">
          <div>
            <strong>${escapeHtml(t.title)}</strong><br/>
            <span class="meta">Nahráno: ${dt} · Otázek: ${t.questions.length} · Klíč: ${t.answerKeyCount}</span>
          </div>
          <div class="actions">
            <button data-act="run" data-id="${t.id}" class="primary">Spustit</button>
            <button data-act="del" data-id="${t.id}" class="danger">Smazat</button>
          </div>
        </div>
      `;
    })
    .join("");

  els.testsList.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;

      const testsNow = loadAllTests();
      const idx = testsNow.findIndex((x) => x.id === id);
      if (idx < 0) return;

      if (act === "del") {
        testsNow.splice(idx, 1);
        localStorage.setItem("testy:v1", JSON.stringify(testsNow));
        renderTestsList();
        return;
      }

      if (act === "run") {
        startTest(testsNow[idx], "all");
      }
    });
  });
}

function startTest(test, mode = "all") {
  const order = [];
  for (let i = 0; i < test.questions.length; i++) order.push(i);

  current = {
    test,
    order,
    index: 0,
    stats: {
      correct: 0,
      wrong: 0,
      wrongNumbers: new Set(),
      answered: new Map(), // qNumber -> {picked, correct}
    },
    mode,
    finished: false,
  };

  els.runnerCard.classList.remove("hidden");
  els.finalBox.classList.add("hidden");
  els.finalBox.innerHTML = "";
  els.btnRetryWrong.disabled = true;

  els.testTitle.textContent = test.title;
  const missing = test.missingKeyNumbers?.length
    ? ` · Chybí klíč pro: ${test.missingKeyNumbers.join(", ")}`
    : "";
  els.testMeta.textContent = `Otázek: ${test.questions.length} · Položek v klíči: ${test.answerKeyCount}${missing}`;

  renderScore();
  renderQuestion();
  window.scrollTo({ top: els.runnerCard.offsetTop - 10, behavior: "smooth" });
}

function renderScore() {
  const totalAnswered = current.stats.correct + current.stats.wrong;
  const pct = totalAnswered
    ? Math.round((current.stats.correct / totalAnswered) * 100)
    : 0;

  els.scoreBox.innerHTML = `
    <div>Správně: <strong style="color:var(--ok)">${current.stats.correct}</strong></div>
    <div>Špatně: <strong style="color:var(--bad)">${current.stats.wrong}</strong></div>
    <div>Úspěšnost: <strong>${pct}%</strong></div>
    <div class="muted">Zodpovězeno: ${totalAnswered}/${current.test.questions.length}</div>
  `;
}

function renderQuestion() {
  const test = current.test;

  if (current.index >= current.order.length) {
    finishTest();
    return;
  }

  const q = test.questions[current.order[current.index]];
  const n = q.number;

  const answered = current.stats.answered.get(n);
  const already = Boolean(answered);

  els.questionBox.innerHTML = `
    <div class="q">
      <h3>${n}. ${escapeHtml(q.text)}</h3>
      <div class="answers">
        ${["A", "B", "C", "D"]
          .map(
            (letter) => `
          <button class="answerBtn" data-letter="${letter}" ${
              already ? "disabled" : ""
            }>
            <strong>${letter})</strong> ${escapeHtml(q.options[letter])}
          </button>
        `
          )
          .join("")}
      </div>
      <div id="feedback"></div>
    </div>
  `;

  els.questionBox.querySelectorAll("button[data-letter]").forEach((btn) => {
    btn.addEventListener("click", () => handleAnswer(q, btn.dataset.letter));
  });
}

function handleAnswer(q, picked) {
  const correct = q.correct; // "A"|"B"|"C"|"D"|null
  const n = q.number;

  if (!correct) {
    current.stats.answered.set(n, { picked, correct: null });
    showFeedback(
      `U této otázky chybí správná odpověď v klíči → nelze vyhodnotit.`,
      "bad"
    );
    nextStep();
    return;
  }

  const ok = picked === correct;
  current.stats.answered.set(n, { picked, correct });

  if (ok) current.stats.correct += 1;
  else {
    current.stats.wrong += 1;
    current.stats.wrongNumbers.add(n);
  }

  renderScore();

  if (ok) {
    showFeedback(`Správně (${correct}).`, "ok");
  } else {
    showFeedback(
      `Špatně. Správně je ${correct}) ${escapeHtml(q.options[correct])}`,
      "bad"
    );
  }

  nextStep();
}

function showFeedback(html, kind) {
  const fb = document.getElementById("feedback");
  fb.innerHTML = `<div class="feedback ${kind}">${html}</div>`;
}

function nextStep() {
  setTimeout(() => {
    current.index += 1;
    renderQuestion();
  }, 650);
}

function finishTest() {
  current.finished = true;
  els.btnRetryWrong.disabled = current.stats.wrongNumbers.size === 0;

  const wrongList = [...current.stats.wrongNumbers].sort((a, b) => a - b);
  const total = current.stats.correct + current.stats.wrong;
  const pct = total ? Math.round((current.stats.correct / total) * 100) : 0;

  els.finalBox.classList.remove("hidden");
  els.finalBox.innerHTML = `
    <h3>Hotovo</h3>
    <p class="muted">Úspěšnost: <strong>${pct}%</strong> · Správně: ${current.stats.correct} · Špatně: ${current.stats.wrong}</p>
    ${
      wrongList.length
        ? `<p><strong>Chybné otázky:</strong> ${wrongList.join(", ")}</p>`
        : `<p><strong>Bez chyb.</strong></p>`
    }
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// --- UI events ---

els.btnImport.addEventListener("click", async () => {
  const files = els.fileInput.files;

  if (!files || !files.length) {
    els.importStatus.textContent = "Vyberte prosím alespoň jeden PDF soubor.";
    return;
  }

  els.btnImport.disabled = true;
  els.importStatus.textContent = `Importuji ${files.length} soubor(ů)…`;

  try {
    for (const f of files) {
      els.importStatus.textContent = `Načítám: ${f.name}…`;

      const rawText = await extractTextFromPdf(f);

      const parsed = parseTestFromPdfText(rawText, f.name);

      const test = {
        id: uid(),
        title: parsed.title,
        createdAt: Date.now(),
        questions: parsed.questions,
        answerKeyCount: parsed.answerKeyCount,
        missingKeyNumbers: parsed.missingKeyNumbers,
      };

      upsertTest(test);
    }

    els.importStatus.textContent =
      "Hotovo. Testy byly uloženy do tohoto zařízení.";
    renderTestsList();
  } catch (e) {
    console.error(e);
    els.importStatus.textContent =
      "Chyba při importu. Zkuste jiné PDF nebo mi pošlete ukázku textu (1–2 otázky + klíč).";
  } finally {
    els.btnImport.disabled = false;
    els.fileInput.value = "";
  }
});

els.btnClearAll.addEventListener("click", () => {
  if (!confirm("Opravdu smazat všechny uložené testy z tohoto zařízení?")) return;
  clearAllTests();
  renderTestsList();
  els.importStatus.textContent = "Uložené testy smazány.";
});

els.btnRestart.addEventListener("click", () => {
  if (!current) return;
  startTest(current.test, "all");
});

els.btnRetryWrong.addEventListener("click", () => {
  if (!current) return;

  const wrong = [...current.stats.wrongNumbers];
  if (!wrong.length) return;

  const order = [];
  current.test.questions.forEach((q, idx) => {
    if (wrong.includes(q.number)) order.push(idx);
  });

  current = {
    test: current.test,
    order,
    index: 0,
    stats: {
      correct: 0,
      wrong: 0,
      wrongNumbers: new Set(),
      answered: new Map(),
    },
    mode: "wrong",
    finished: false,
  };

  els.finalBox.classList.add("hidden");
  els.finalBox.innerHTML = "";
  els.btnRetryWrong.disabled = true;

  renderScore();
  renderQuestion();
});

// init
renderTestsList();
