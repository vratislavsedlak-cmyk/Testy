function normalizeText(s) {
  return s
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findAnswerKeyBlock(text) {
  // Typicky: "Klíč správných odpovědí" + řádky "1. B"
  const m = text.match(/Klíč správných odpovědí([\s\S]*)$/i);
  return m ? m[1] : null;
}

function parseAnswerKey(block) {
  const key = new Map();
  if (!block) return key;

  // toleruje "1. B" i "1. B (poznámka...)"
  const re = /(^|\n)\s*(\d{1,3})\.\s*([ABCD])\b/g;
  let mm;
  while ((mm = re.exec(block)) !== null) {
    const n = Number(mm[2]);
    const ans = mm[3];
    if (!Number.isNaN(n)) key.set(n, ans);
  }
  return key;
}

function parseQuestions(text) {
  // Najdeme bloky začínající "1." ... až před další "2." atd.
  // Toleruje i tučné **1. ...** a různé odrážky.
  const questions = [];

  // Rozsekneme na kusy podle začátku otázky: newline + číslo + tečka
  // Přidáme \n na začátek aby fungovalo i pro první otázku.
  const src = "\n" + text;
  const parts = src.split(/\n\s*(?=\d{1,3}\.\s)/g).map(p => p.trim()).filter(Boolean);

  for (const part of parts) {
    const head = part.match(/^(\d{1,3})\.\s*([\s\S]*)$/);
    if (!head) continue;

    const number = Number(head[1]);
    let body = head[2];

    // Odřízneme případné tematické nadpisy uvnitř bloku (často nejsou, ale někdy ano)
    // a hlavně oddělíme otázku od odpovědí A-D.
    // Extrahujeme A) ... B) ... C) ... D) ...
    const reOpt = /(?:^|\n)\s*(?:[-•]?\s*)?([ABCD])\)\s*([^\n]+)/g;

    const opts = {};
    let mm;
    while ((mm = reOpt.exec(body)) !== null) {
      opts[mm[1]] = mm[2].trim();
    }

    // Text otázky: vše před prvním výskytem "\n A)" (nebo "A)")
    let qText = body;
    const cut = body.search(/(?:^|\n)\s*(?:[-•]?\s*)?A\)\s*/m);
    if (cut >= 0) qText = body.slice(0, cut).trim();

    // vyčistit např. zbylé markdown ** **
    qText = qText.replace(/\*\*/g, "").trim();

    // jen pokud máme aspoň A-D
    if (opts.A && opts.B && opts.C && opts.D) {
      questions.push({
        number,
        text: qText,
        options: { A: opts.A, B: opts.B, C: opts.C, D: opts.D },
      });
    }
  }

  // Seřadit
  questions.sort((a, b) => a.number - b.number);
  return questions;
}

export function parseTestFromPdfText(rawText, fileName = "Test") {
  const text = normalizeText(rawText);

  const keyBlock = findAnswerKeyBlock(text);
  const key = parseAnswerKey(keyBlock);

  // pro samotné otázky vezmeme text před klíčem (pokud existuje)
  const mainText = keyBlock ? text.replace(/Klíč správných odpovědí[\s\S]*$/i, "").trim() : text;
  const questions = parseQuestions(mainText);

  // Doplnit správné odpovědi z klíče (pokud chybí, necháme null)
  const enriched = questions.map(q => ({
    ...q,
    correct: key.get(q.number) || null
  }));

  // Validace: zda máme klíč pro všechny
  const missing = enriched.filter(q => !q.correct).map(q => q.number);

  return {
    title: fileName.replace(/\.pdf$/i, ""),
    questions: enriched,
    answerKeyCount: key.size,
    missingKeyNumbers: missing,
  };
}
