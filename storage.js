const KEY = "testy:v1";

export function loadAllTests() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveAllTests(tests) {
  localStorage.setItem(KEY, JSON.stringify(tests));
}

export function clearAllTests() {
  localStorage.removeItem(KEY);
}

export function upsertTest(test) {
  const tests = loadAllTests();
  const idx = tests.findIndex(t => t.id === test.id);
  if (idx >= 0) tests[idx] = test;
  else tests.unshift(test);
  saveAllTests(tests);
  return tests;
}
