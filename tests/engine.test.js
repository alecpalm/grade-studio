// Tests for the Grade Studio engine. Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const gs = require('../grade-studio.js');

const settings = (over = {}) => ({ ...gs.DEFAULT_SETTINGS, ...over });
const makeClass = (totals) => totals.map((total, order) => ({ id: 'E' + order, total, grade: 4, order }));

// A small repeatable random number generator, so failures can be reproduced.
function random(seed) {
  return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
}
function randomClass(rnd) {
  const n = 2 + Math.floor(rnd() * 120);
  return makeClass(Array.from({ length: n }, () => Math.round((20 + rnd() * 80) * 2) / 2));
}

test('the built-in self-test passes', () => {
  assert.ok(gs.selfTest());
});

test('the class average never goes over the maximum', () => {
  const rnd = random(1);
  for (let i = 0; i < 1000; i++) {
    const students = randomClass(rnd);
    const max = [3.3, 3.5][i % 2];
    gs.draftGrades(students, settings({ maxAverage: max }));
    assert.ok(gs.averagePoints(students) <= max + 1e-9, `average ${gs.averagePoints(students)} over ${max}`);
  }
});

test('a higher total never gets a lower grade', () => {
  const rnd = random(2);
  for (let i = 0; i < 1000; i++) {
    const students = randomClass(rnd);
    gs.draftGrades(students, settings({ keepTiesTogether: i % 2 === 0, closeScoreGap: i % 3 }));
    const sorted = gs.byScore(students);
    for (let j = 1; j < sorted.length; j++) assert.ok(sorted[j - 1].grade <= sorted[j].grade);
  }
});

test('tied totals share a grade when "Keep ties together" is on', () => {
  const rnd = random(3);
  for (let i = 0; i < 500; i++) {
    const students = randomClass(rnd);
    gs.draftGrades(students, settings({ keepTiesTogether: true }));
    const gradeFor = new Map();
    for (const s of students) {
      if (gradeFor.has(s.total)) assert.strictEqual(gradeFor.get(s.total), s.grade);
      gradeFor.set(s.total, s.grade);
    }
  }
});

test('scores within the close-score gap share a grade', () => {
  const students = makeClass([90, 89.5, 80, 70, 69, 50]);
  gs.draftGrades(students, settings({ closeScoreGap: 2 }));
  assert.strictEqual(students[0].grade, students[1].grade);
  assert.strictEqual(students[3].grade, students[4].grade);
});

test('flags mark split ties, inversions and close boundaries', () => {
  const students = makeClass([90, 80, 80, 70]);
  students[0].grade = 2; students[1].grade = 3; students[2].grade = 4; students[3].grade = 3;
  const flags = gs.findFlags(students);
  assert.deepStrictEqual(flags.get(3), ['Score inversion', true]);
  assert.strictEqual(flags.get(1)[0], 'Split tie');
});

test('pasted text: spreadsheet columns, typed lines, and refusals', () => {
  const pasted = gs.readScores(gs.readPaste('Final Exam ID\tQ1\tTotal Points\n0417\t5\t88\n0102\t6\t92.5'), 'Pasted');
  assert.deepStrictEqual(pasted.scores, [['0417', 88], ['0102', 92.5]]);
  const typed = gs.readScores(gs.readPaste('A-101 88\nA-102 92'), 'Pasted');
  assert.deepStrictEqual(typed.scores, [['A-101', 88], ['A-102', 92]]);
  assert.ok(gs.readScores(gs.readPaste('jtest@example.edu 88\nrs@example.edu 92'), 'Pasted').problems[0].includes('names or emails'));
  assert.ok(gs.readScores(gs.readPaste('Exam ID,Total\n1,80\n1,70'), 'Pasted').problems[0].includes('appears twice'));
  assert.ok(gs.readScores(gs.readPaste('Exam ID,Total\n1,80\n2,INC'), 'Pasted').problems[0].includes('not a number'));
});

test('the data fingerprint matches the one the Gemini skill prints in Python', () => {
  // Python: data_line([('0417','88'), ('0102','92.5'), ('1203','75')]) prints DSUM='af16656e'
  assert.strictEqual(gs.fingerprint(JSON.stringify([['0417', 88], ['0102', 92.5], ['1203', 75]])), 'af16656e');
});

test('highest and lowest grade limits are respected', () => {
  const rnd = random(4);
  for (let i = 0; i < 500; i++) {
    const students = randomClass(rnd);
    gs.draftGrades(students, settings({ highestGrade: 1, lowestGrade: 7 })); // A to C
    for (const s of students) assert.ok(s.grade >= 1 && s.grade <= 7);
    assert.ok(gs.averagePoints(students) <= 3.3 + 1e-9);
  }
});

test('grades set by request are kept, and the class stays under the maximum when possible', () => {
  const rnd = random(5);
  for (let i = 0; i < 500; i++) {
    const students = randomClass(rnd);
    const id = students[Math.floor(rnd() * students.length)].id;
    gs.draftGrades(students, settings({ setGrades: { [id]: 3 } })); // B+
    assert.strictEqual(students.find((s) => s.id === id).grade, 3);
    assert.ok(gs.averagePoints(students) <= 3.3 + 1e-9);
  }
});

test('typed pairs on one line, separated by commas or semicolons', () => {
  assert.deepStrictEqual(gs.readScores(gs.readPaste('4001 88, 4002 76; 4003 93'), 'Typed').scores, [['4001', 88], ['4002', 76], ['4003', 93]]);
  assert.deepStrictEqual(gs.readScores(gs.readPaste('S1: 44, S2: 47'), 'Typed').scores, [['S1', 44], ['S2', 47]]);
  assert.deepStrictEqual(gs.readScores(gs.readPaste('Exam ID, Total\n2001, 91\n2002, 84'), 'Typed').scores, [['2001', 91], ['2002', 84]]);
});
