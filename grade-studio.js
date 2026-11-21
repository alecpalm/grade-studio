/*
 * Grade Studio
 * Lewis & Clark Law School, Boley Law Library
 *
 * Drafts letter grades from anonymous exam totals so that the class average
 * stays at or below the school's maximum grade average (3.30 or 3.50).
 * The professor reviews every grade and can change any of them.
 *
 * This file has two parts:
 *   1. The grading engine: plain functions with no page code. It runs in a
 *      browser or in Node (see tests/engine.test.js).
 *   2. The page: builds the screen, reads pasted scores, draws the chart and
 *      roster, and exports a CSV.
 *
 * Nothing here sends data anywhere. Scores stay in the browser window.
 * The Gemini skill loads this file pinned to one commit with a Subresource
 * Integrity hash, so a changed copy of this file will not run.
 */

/* ======================================================================
 * Part 1. Grading engine
 * ====================================================================== */

const GradeStudioEngine = (() => {
  /**
   * The Lewis & Clark grade scale, best first. A student's grade is stored
   * as an index into this list, so a LOWER index means a BETTER grade.
   */
  const GRADES = [
    { letter: 'A+', points: 4.33 },
    { letter: 'A', points: 4.0 },
    { letter: 'A−', points: 3.67 },
    { letter: 'B+', points: 3.33 },
    { letter: 'B', points: 3.0 },
    { letter: 'B−', points: 2.67 },
    { letter: 'C+', points: 2.33 },
    { letter: 'C', points: 2.0 },
    { letter: 'C−', points: 1.67 },
    { letter: 'D+', points: 1.33 },
    { letter: 'D', points: 1.0 },
    { letter: 'D−', points: 0.67 },
    { letter: 'F', points: 0 },
  ];
  const WORST = GRADES.length - 1;
  const points = (gradeIndex) => GRADES[gradeIndex].points;

  /** Default settings when a class is loaded. */
  const DEFAULT_SETTINGS = {
    maxAverage: 3.3, // the school's maximum grade average for the course
    keepTiesTogether: true, // students with the same total get the same grade
    closeScoreGap: 0, // students within this many points stay together (0 = off)
    highestGrade: 0, // best grade the draft may give (index into GRADES; 0 = A+)
    lowestGrade: GRADES.length - 1, // worst grade the draft may give (12 = F)
    setGrades: {}, // grades the professor fixed by exam ID, e.g. { "4102": 3 } for B+
  };

  /**
   * How strongly the first draft follows each student's distance from the
   * class mean. A student one standard deviation above the mean starts
   * 0.55 grade points above the maximum average.
   */
  const SPREAD = 0.55;

  /** Small tolerance for comparing decimal numbers. */
  const EPS = 1e-9;

  /** Students sorted from highest total to lowest. Equal totals keep their original order. */
  function byScore(students) {
    return [...students].sort((a, b) => b.total - a.total || a.order - b.order);
  }

  /** Average grade points of the class. */
  function averagePoints(students) {
    return students.reduce((sum, s) => sum + points(s.grade), 0) / students.length;
  }

  /** The grade whose points are nearest to a number. On a tie, the better grade wins. */
  function nearestGrade(value) {
    let best = 0;
    for (let i = 1; i < GRADES.length; i++) {
      if (Math.abs(points(i) - value) < Math.abs(points(best) - value)) best = i;
    }
    return best;
  }

  /**
   * Splits the class into groups that must share one grade, highest scores first.
   * A student joins the group above when:
   *   - "Keep ties together" is on and their total equals the previous student's, or
   *   - "Keep close scores together" is set and they are within that many points
   *     of the previous student.
   * Each group's total is the average total of its members.
   */
  function groupStudents(students, settings) {
    const groups = [];
    let previousTotal = null;
    for (const student of byScore(students)) {
      const current = groups[groups.length - 1];
      const tied = settings.keepTiesTogether && previousTotal === student.total;
      const close = settings.closeScoreGap > 0 && previousTotal - student.total < settings.closeScoreGap - EPS;
      if (current && (tied || close)) {
        current.students.push(student);
        current.sum += student.total;
        current.total = current.sum / current.students.length;
      } else {
        groups.push({ total: student.total, sum: student.total, students: [student], grade: student.grade, target: 0 });
      }
      previousTotal = student.total;
    }
    return groups;
  }

  /**
   * Drafts a grade for every student. Sets student.grade on each one.
   *
   * Students whose grade the professor fixed (settings.setGrades) keep that
   * grade. Everyone else is drafted so the WHOLE class still stays at or under
   * the maximum: the fixed students' grade points come out of the class's
   * budget first.
   */
  function draftGrades(students, settings) {
    const setGrades = settings.setGrades || {};
    const fixed = students.filter((s) => Object.prototype.hasOwnProperty.call(setGrades, s.id));
    for (const s of fixed) s.grade = setGrades[s.id];
    const others = students.filter((s) => !fixed.includes(s));
    if (!others.length) return;
    if (!fixed.length) return draftFree(students, settings);
    const budget = settings.maxAverage * students.length - fixed.reduce((sum, s) => sum + points(s.grade), 0);
    draftFree(others, { ...settings, maxAverage: budget / others.length });
  }

  /**
   * Drafts grades for students with no fixed grade.
   *
   * Step 1. First draft. Each group gets a target in grade points:
   *           maxAverage + 0.55 × (group total − class mean) / standard deviation,
   *         kept between 0 and 4.33, then rounded to the nearest grade. A group
   *         never gets a better grade than the group above it.
   *
   * Step 2. If the class average is over the maximum, lower grades one step at
   *         a time. Each step lowers the group where the move costs least: the
   *         smallest increase in squared distance from the group's target, per
   *         grade point removed. A higher score never ends up with a lower grade.
   *
   * Step 3. If there is room under the maximum, raise grades one step at a time
   *         while the average stays at or below it. Each step prefers the move
   *         that uses the most room; on a tie, the one closest to its target.
   *
   * Both loops stop after 500 steps as a safety limit. No grade goes above
   * settings.highestGrade or below settings.lowestGrade (for example, "no A+").
   */
  function draftFree(students, settings) {
    const highest = settings.highestGrade ?? 0;
    const lowest = settings.lowestGrade ?? WORST;
    const groups = groupStudents(students, settings);
    const n = students.length;
    const mean = students.reduce((sum, s) => sum + s.total, 0) / n;
    const sd = Math.sqrt(students.reduce((sum, s) => sum + (s.total - mean) ** 2, 0) / n) || 1;

    // Step 1: first draft.
    groups.forEach((group, i) => {
      group.target = Math.max(0, Math.min(4.33, settings.maxAverage + (SPREAD * (group.total - mean)) / sd));
      group.grade = Math.min(lowest, Math.max(highest, nearestGrade(group.target)));
      if (i > 0) group.grade = Math.max(group.grade, groups[i - 1].grade);
    });

    const totalPoints = () => groups.reduce((sum, g) => sum + g.students.length * points(g.grade), 0);
    const limit = settings.maxAverage * n;
    // How far a group would be from its target at a given grade (squared, weighted by group size).
    const miss = (group, gradeIndex) => group.students.length * (points(gradeIndex) - group.target) ** 2;

    // Step 2: lower grades until the average is at or under the maximum.
    let steps = 0;
    while (totalPoints() > limit + EPS && steps++ < 500) {
      let best = null;
      groups.forEach((group, i) => {
        const below = groups[i + 1];
        const canLower = group.grade < lowest && (!below || group.grade + 1 <= below.grade);
        if (!canLower) return;
        const pointsRemoved = group.students.length * (points(group.grade) - points(group.grade + 1));
        const costPerPoint = (miss(group, group.grade + 1) - miss(group, group.grade)) / pointsRemoved;
        if (!best || costPerPoint < best.costPerPoint) best = { group, costPerPoint };
      });
      if (!best) break;
      best.group.grade++;
    }

    // Step 3: raise grades while there is room under the maximum.
    steps = 0;
    while (steps++ < 500) {
      const room = limit - totalPoints();
      let best = null;
      groups.forEach((group, i) => {
        const above = groups[i - 1];
        const canRaise = group.grade > highest && (!above || above.grade <= group.grade - 1);
        if (!canRaise) return;
        const pointsAdded = group.students.length * (points(group.grade - 1) - points(group.grade));
        if (pointsAdded > room + EPS) return;
        const cost = miss(group, group.grade - 1) - miss(group, group.grade);
        if (!best || pointsAdded > best.pointsAdded || (pointsAdded === best.pointsAdded && cost < best.cost)) {
          best = { group, pointsAdded, cost };
        }
      });
      if (!best) break;
      best.group.grade--;
    }

    for (const group of groups) for (const student of group.students) student.grade = group.grade;
  }

  /**
   * Things a professor should look at. Returns a Map from student.order to
   * [label, needsReview]. Later checks overwrite earlier ones for the same student.
   *   - Tied score: same total as another student (shown softly).
   *   - Split tie: same total but different grades (needs review).
   *   - Score inversion: a higher total has a lower grade than the next student.
   *   - Close boundary: the next student down is in a different grade but within
   *     2.5% of the score range (at least 0.5 points).
   */
  function findFlags(students) {
    const sorted = byScore(students);
    const flags = new Map();
    const range = sorted[0].total - sorted[sorted.length - 1].total;
    const closeEnough = Math.max(0.5, range * 0.025);

    const byTotal = new Map();
    for (const s of sorted) {
      if (!byTotal.has(s.total)) byTotal.set(s.total, []);
      byTotal.get(s.total).push(s);
    }
    byTotal.forEach((same) => {
      if (same.length < 2) return;
      const split = new Set(same.map((s) => s.grade)).size > 1;
      for (const s of same) flags.set(s.order, [split ? 'Split tie' : 'Tied score', split]);
    });

    for (let i = 0; i < sorted.length - 1; i++) {
      const higher = sorted[i];
      const lower = sorted[i + 1];
      if (higher.total > lower.total && higher.grade > lower.grade) {
        flags.set(higher.order, ['Score inversion', true]);
        flags.set(lower.order, ['Score inversion', true]);
      } else if (higher.grade !== lower.grade && higher.total - lower.total <= closeEnough) {
        flags.set(lower.order, [`Close boundary: ${+(higher.total - lower.total).toFixed(2)} pts`, true]);
      }
    }
    return flags;
  }

  /**
   * Runs the engine on a fixed class and checks the result. If this ever
   * fails, the page refuses to draft grades.
   */
  const SELF_TEST_TOTALS = [96, 91, 87, 84, 81, 78, 75, 72, 69, 69, 65, 61, 57, 53, 49, 45, 39, 31];
  const SELF_TEST_EXPECTED = '0,1,1,2,2,2,2,3,3,3,3,4,4,4,5,5,6,6'; // A+, A, A, A−, … C+
  function selfTest() {
    const students = SELF_TEST_TOTALS.map((total, order) => ({ id: 'T' + order, total, grade: 4, order }));
    draftGrades(students, DEFAULT_SETTINGS);
    return students.map((s) => s.grade).join(',') === SELF_TEST_EXPECTED;
  }

  return { GRADES, DEFAULT_SETTINGS, points, byScore, averagePoints, nearestGrade, groupStudents, draftGrades, findFlags, selfTest };
})();

/* ======================================================================
 * Part 1b. Reading pasted scores (also plain functions, no page code)
 * ====================================================================== */

const GradeStudioInput = (() => {
  const ID_NAMES = ['final exam id', 'exam id', 'exam number', 'anonymous id', 'exam no', 'id'];
  const TOTAL_NAMES = ['total', 'total points', 'final total', 'points', 'score'];

  /** Splits pasted spreadsheet text into rows of cells. Handles tabs or commas and quoted cells. */
  function parseTable(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split('\n')[0];
    const tabs = (firstLine.match(/\t/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    const separator = tabs > commas ? '\t' : ',';

    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === separator) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((s) => s.trim()));
  }

  /**
   * Typed lines with no header, one "exam-ID score" per line (spaces, commas
   * or semicolons between them), become a two-column table with a header.
   * Anything else is read as a spreadsheet paste.
   */
  function readPaste(text) {
    const lines = text.split(/\r?\n/).filter((s) => s.trim());
    const bare = lines.every((s) => /^\s*[^\s,;]+[\s,;]+-?\d+(\.\d+)?\s*$/.test(s));
    if (bare) text = 'Exam ID\tTotal\n' + lines.map((s) => s.trim().split(/[\s,;]+/).join('\t')).join('\n');
    return parseTable(text);
  }

  /** The header row: the first of 20 rows naming both an ID and a total column, else the first row with two cells. */
  function findHeader(rows) {
    for (let i = 0; i < Math.min(20, rows.length); i++) {
      const lower = rows[i].map((x) => x.toLowerCase());
      if (lower.some((x) => ID_NAMES.includes(x)) && lower.some((x) => TOTAL_NAMES.includes(x))) return i;
    }
    return rows.findIndex((r) => r.filter(Boolean).length >= 2);
  }

  /** Index of the first column whose header matches one of the names, in order of preference. */
  function findColumn(header, names) {
    for (const name of names) {
      const i = header.findIndex((x) => x.toLowerCase() === name);
      if (i >= 0) return i;
    }
    return -1;
  }

  /**
   * Turns table rows into [examId, total] pairs, or a list of problems.
   * Refuses missing IDs, missing or non-number totals, duplicate IDs, names or
   * emails in the ID column, and a Total column where every value is the same.
   */
  function readScores(rows, sourceName) {
    const h = findHeader(rows);
    const header = rows[h] || [];
    const idCol = findColumn(header, ID_NAMES);
    const totalCol = findColumn(header, TOTAL_NAMES);
    if (h < 0 || idCol < 0 || totalCol < 0) {
      return { problems: [`${sourceName}: Grade Studio needs a column named “Exam ID” (anonymous exam numbers, not names) and one named “Total”.`] };
    }

    const problems = [];
    const seen = new Map();
    const scores = [];
    rows.slice(h + 1).forEach((r, j) => {
      const line = h + j + 2; // spreadsheet row number
      const id = (r[idCol] || '').trim();
      const total = (r[totalCol] || '').trim();
      if (!id && !total) return;
      if (!id) return problems.push(`Row ${line}: missing exam ID.`);
      if (total === '') return problems.push(`Row ${line} (${id}): no total.`);
      if (!Number.isFinite(+total)) return problems.push(`Row ${line} (${id}): total "${total}" is not a number.`);
      if (seen.has(id)) return problems.push(`Row ${line}: exam ID ${id} appears twice (also row ${seen.get(id)}).`);
      seen.set(id, line);
      scores.push([id, +total]);
    });

    if (scores.some(([id]) => /@|^[a-z]+[ ,]+[a-z]+$/i.test(id))) problems.unshift('The ID column looks like names or emails. Use anonymous exam numbers only.');
    if (!scores.length && !problems.length) problems.push('No student rows were found under the header.');
    if (scores.length > 1 && new Set(scores.map((s) => s[1])).size < 2) problems.push(`Every total is ${scores[0][1]}. Check you copied the Total column.`);
    return problems.length ? { problems } : { scores };
  }

  /**
   * Fingerprint (32-bit FNV-1a, hex) of the class data Gemini put in the page.
   * The skill's Python prints the same fingerprint, so a changed score, ID or
   * missing row is caught before anything is drafted.
   */
  function fingerprint(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  }

  return { parseTable, readPaste, findHeader, findColumn, readScores, fingerprint };
})();

if (typeof module !== 'undefined') module.exports = { ...GradeStudioEngine, ...GradeStudioInput };

/* ======================================================================
 * Part 2. The page
 * ====================================================================== */

if (typeof document !== 'undefined') (() => {
  const { GRADES, DEFAULT_SETTINGS, points, byScore, averagePoints, groupStudents, draftGrades, findFlags, selfTest } = GradeStudioEngine;
  const { readPaste, readScores, fingerprint } = GradeStudioInput;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const gradeColor = (i) => 'var(--g' + 'AAABBBCCCDDDF'[i] + ')'; // A/B/C/D/F colors set in the page's styles

  // ---- Screen layout. Styling lives in the page that loads this file. ----
  document.getElementById('boot')?.remove();
  document.body.insertAdjacentHTML('afterbegin', `
<header>
  <svg viewBox="0 0 172 236" width="23" height="32" aria-hidden="true"><g transform="translate(0 236) scale(1 -1)"><path fill="currentColor" d="M0 170 c0 -53 0 -68 1 -76 6 -39 30 -71 64 -88 16 -7 17 -7 8 3 -14 14 -23 29 -27 46 -1 7 -1 16 -2 94 l0 87 -22 0 -22 0 0 -66z"/><path fill="#f47721" d="M50 156 c0 -80 0 -80 2 -74 3 6 4 8 8 13 11 11 30 12 52 2 19 -8 37 -6 51 5 10 8 9 4 9 73 l0 61 -61 0 -61 0 0 -80z M171 106 c0 -3 -6 -15 -11 -20 -13 -14 -32 -16 -57 -8 -19 7 -35 5 -45 -5 -7 -6 -7 -7 -5 -16 2 -11 2 -11 5 -5 8 17 26 22 50 14 33 -11 56 -3 61 22 2 8 3 19 3 19 -1 0 -1 -1 -1 -1z M154 53 c-13 -14 -29 -16 -50 -7 -19 9 -35 8 -46 0 -7 -5 27 -46 36 -45 16 3 46 26 58 45 4 6 8 13 8 13 0 0 -3 -3 -6 -6z"/></g></svg>
  <div><b>Lewis &amp; Clark Law School</b><small>Boley Law Library</small></div>
  <a href="https://law.lclark.edu/academics/whats_what/grading_system_probation_and_dismissal/" target="_blank">Grading policy</a>
</header>
<main>
  <div class="ph">
    <div><h1>Grade Studio</h1><p id="meta" class="mf">Draft letter grades under the Lewis &amp; Clark maximum grade average.</p></div>
    <div id="top" class="row hide"><button id="newf" class="btn">New scores</button><button id="export" class="btn pri">Export CSV</button></div>
  </div>

  <div id="errs" class="card note hide"><b>Grade Studio can't draft these grades yet</b><ul id="msg"></ul><button id="again" class="btn">Try again</button></div>

  <section id="load" class="card hide">
    <p class="ct">Paste exam scores</p>
    <p class="mf">In your spreadsheet, select the Exam ID and Total columns with their headers, copy, and paste here. Or type one exam ID and total per line. Anonymous exam numbers only. Scores stay in this window.</p>
    <textarea id="paste" aria-label="Pasted rows" placeholder="Exam ID&#9;Total&#10;2001&#9;118.5"></textarea>
    <button id="usePaste" class="btn pri">Draft grades</button>
  </section>

  <section id="app" class="hide" style="display:grid;gap:16px">
    <div class="card ctrls">
      <div>
        <b>Maximum grade average</b>
        <p class="mf" style="margin:2px 0 0">3.30 for 1L, large and listed courses · 3.50 for others</p>
        <div class="row" style="margin-top:8px"><span class="tabs" id="pre"><button data-c="3.30">3.30</button><button data-c="3.50">3.50</button></span><input id="capn" type="number" step=".01" style="width:80px" aria-label="Maximum"></div>
        <input id="sl" type="range" min="2" max="4" step=".01" aria-label="Maximum slider">
        <div class="row mf" style="justify-content:space-between;margin:0;flex-wrap:nowrap"><span>2.00</span><span>4.00</span></div>
        <p id="note" class="note"></p>
      </div>
      <div><label class="row" style="justify-content:space-between"><b>Keep ties together</b><input id="ties" class="sw" type="checkbox"></label><p class="mf">Same total, same grade.</p></div>
      <div><b>Keep close scores together</b><div class="row" style="margin-top:8px"><input id="gap" type="number" min="0" max="20" step=".5" style="width:70px" aria-label="Points"><span class="mf" style="margin:0">points (0 is off)</span></div></div>
      <div><b>Grade range</b><div class="row" style="margin-top:8px"><select id="hi" aria-label="Highest grade"></select><span class="mf" style="margin:0">to</span><select id="lo" aria-label="Lowest grade"></select></div></div>
    </div>
    <p id="asked" class="note"></p>

    <div class="stats">
      <div class="card stat" style="--s:var(--gB)"><div class="k">Students</div><div id="n" class="v"></div><p id="rng" class="mf"></p></div>
      <div id="st" class="card stat"><div class="k">Draft average</div><div id="avg" class="v">0.00</div><p id="stt" class="mf"></p></div>
      <div id="fc" class="card stat"><div class="k">Needs review</div><div id="nf" class="v"></div><p id="nft" class="mf"></p></div>
    </div>

    <div class="card"><div class="ph"><div><p class="ct">Distribution</p><p class="mf">Each dot is a student; ringed dots need review.</p></div></div><div id="cw"></div><div id="counts" class="counts"></div></div>

    <div class="card">
      <div class="ph"><div><p class="ct">Roster</p><p class="mf">Highest score first. Ties change together.</p></div></div>
      <p id="edits" class="note"></p>
      <table><thead><tr><th>Exam ID</th><th class="num">Total</th><th>Grade</th></tr></thead><tbody id="rows"></tbody></table>
    </div>

    <p class="mf">Draft only. The maximum is a ceiling, not a quota.</p>
  </section>
</main>`);

  // ---- Settings Gemini wrote into the page ----
  /**
   * The page Gemini makes may hold one line of settings the professor asked for:
   *   const SET = { "maxAverage": 3.3, "keepTiesTogether": true, "closeScoreGap": 0,
   *                 "highestGrade": "A", "lowestGrade": "C", "setGrades": { "4102": "B+" } };
   * Every key is optional. Anything that can't be used is listed on screen, never guessed.
   * These settings never change a score, only how grades are drafted.
   */
  const gradeIndex = (letter) => GRADES.findIndex((g) => g.letter === String(letter).trim().toUpperCase().replace('-', '−'));
  function readPageSettings() {
    const raw = typeof SET !== 'undefined' && SET && typeof SET === 'object' ? SET : {};
    const out = {};
    const ignored = [];
    const asked = [];
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'maxAverage' && Number.isFinite(+value) && +value >= 0 && +value <= 4.33) { out.maxAverage = +value; asked.push(`maximum average ${(+value).toFixed(2)}`); }
      else if (key === 'keepTiesTogether' && typeof value === 'boolean') { out.keepTiesTogether = value; asked.push(value ? 'ties kept together' : 'ties not kept together'); }
      else if (key === 'closeScoreGap' && Number.isFinite(+value) && +value >= 0 && +value <= 20) { out.closeScoreGap = +value; if (+value) asked.push(`scores within ${+value} points kept together`); }
      else if (key === 'highestGrade' && gradeIndex(value) >= 0) { out.highestGrade = gradeIndex(value); asked.push(`no grade above ${GRADES[out.highestGrade].letter}`); }
      else if (key === 'lowestGrade' && gradeIndex(value) >= 0) { out.lowestGrade = gradeIndex(value); asked.push(`no grade below ${GRADES[out.lowestGrade].letter}`); }
      else if (key === 'setGrades' && value && typeof value === 'object') {
        out.setGrades = {};
        for (const [id, letter] of Object.entries(value)) {
          if (gradeIndex(letter) >= 0) { out.setGrades[String(id).trim()] = gradeIndex(letter); asked.push(`${id} set to ${GRADES[gradeIndex(letter)].letter}`); }
          else ignored.push(`${id}: "${letter}" isn't a grade`);
        }
      } else ignored.push(`${key}: ${JSON.stringify(value)}`);
    }
    if (out.highestGrade > (out.lowestGrade ?? GRADES.length - 1)) { ignored.push('the grade range is upside down'); delete out.highestGrade; delete out.lowestGrade; }
    return { settings: out, asked, ignored };
  }
  const PAGE = readPageSettings();

  // ---- State ----
  /** The loaded class and current settings. Each student: { id, total, grade, order }. */
  const state = { ...DEFAULT_SETTINGS, ...PAGE.settings, students: [], handEdited: false };
  const settings = () => ({
    maxAverage: state.maxAverage, keepTiesTogether: state.keepTiesTogether, closeScoreGap: state.closeScoreGap,
    highestGrade: state.highestGrade, lowestGrade: state.lowestGrade, setGrades: state.setGrades,
  });
  const START_TEXT = $('#meta').textContent;
  let sliderTimer = null;

  const showEditNote = (text) => { $('#edits').textContent = text; };

  /** Redrafts all grades from the settings. Hand edits are replaced, and the professor is told. */
  function redraft() {
    if (state.handEdited) {
      state.handEdited = false;
      showEditNote('Settings changed, so your hand edits were replaced.');
    }
    draftGrades(state.students, settings());
    render();
  }

  function setMaxAverage(value) {
    state.maxAverage = Math.max(0, Math.min(4.33, +value || 0));
    redraft();
  }

  // ---- Drawing the screen ----
  function render() {
    const average = averagePoints(state.students);
    const over = average > state.maxAverage + 1e-9;
    const flags = findFlags(state.students);
    const needsReview = (s) => (flags.get(s.order) || [])[1];
    const reviewCount = state.students.filter(needsReview).length;
    const sorted = byScore(state.students);
    const counts = GRADES.map((_, i) => state.students.filter((s) => s.grade == i).length);

    $('#n').textContent = state.students.length;
    $('#rng').textContent = `Scores ${sorted[sorted.length - 1].total} to ${sorted[0].total}`;
    $('#avg').textContent = average.toFixed(2);
    $('#st').className = 'card stat ' + (over ? 'over' : 'ok');
    $('#stt').textContent = (over ? 'Over' : 'Within') + ` the ${state.maxAverage.toFixed(2)} maximum`;
    $('#nf').textContent = reviewCount;
    $('#nft').textContent = reviewCount ? 'Flagged in the roster' : 'Nothing flagged';
    $('#fc').className = 'card stat' + (reviewCount ? ' over' : '');

    $('#sl').value = state.maxAverage;
    $('#sl').style.setProperty('--p', Math.min(100, Math.max(0, (state.maxAverage - 2) * 50)) + '%');
    $('#capn').value = state.maxAverage.toFixed(2);
    $('#ties').checked = state.keepTiesTogether;
    $('#gap').value = state.closeScoreGap;
    document.querySelectorAll('#pre button').forEach((b) => b.classList.toggle('on', Math.abs(b.dataset.c - state.maxAverage) < 0.005));
    $('#note').textContent = state.maxAverage > 3.5 + 1e-9 ? 'Above the 3.50 ceiling: going over needs approval from the Associate Dean.' : '';
    const gradeOptions = (selected) => GRADES.map(({ letter }, i) => `<option value="${i}"${i == selected ? ' selected' : ''}>${letter}</option>`).join('');
    $('#hi').innerHTML = gradeOptions(state.highestGrade);
    $('#lo').innerHTML = gradeOptions(state.lowestGrade);
    const askedText = PAGE.asked.length ? 'Requested in Gemini: ' + PAGE.asked.join('; ') + '.' : '';
    const ignoredText = PAGE.ignored.length ? ' Not used (not understood): ' + PAGE.ignored.join('; ') + '.' : '';
    const missing = Object.keys(state.setGrades).filter((id) => !state.students.some((s) => s.id === id));
    const missingText = missing.length ? ` No student with exam ID ${missing.join(', ')}.` : '';
    $('#asked').textContent = (askedText + ignoredText + missingText).trim();

    drawChart(flags);
    $('#counts').innerHTML = GRADES.map(({ letter }, i) =>
      `<div class="${counts[i] ? '' : 'z'}"><i style="background:${gradeColor(i)}"></i><b>${counts[i]}</b>${letter}</div>`).join('');

    $('#rows').innerHTML = sorted.map((s) => {
      const isSet = Object.prototype.hasOwnProperty.call(state.setGrades, s.id);
      const flag = flags.get(s.order) || (isSet ? ['Grade set by request', false] : null);
      const options = GRADES.map(({ letter, points: p }, i) => `<option value="${i}"${i == s.grade ? ' selected' : ''}>${letter} (${p.toFixed(2)})</option>`).join('');
      const badge = flag ? `<span class="flag${flag[1] ? '' : ' soft'}">${flag[0]}</span>` : '';
      return `<tr data-o="${s.order}"><td>${escapeHtml(s.id)}</td><td class="num">${s.total}</td><td><select style="--c:${gradeColor(s.grade)}" data-o="${s.order}" aria-label="Grade for ${escapeHtml(s.id)}">${options}</select>${badge}</td></tr>`;
    }).join('');
  }

  /** The grade ladder: one row per grade, one dot per student placed by total points. */
  function drawChart(flags) {
    const sorted = byScore(state.students);
    const low = sorted[sorted.length - 1].total;
    const span = sorted[0].total - low || 1;
    const grades = sorted.map((s) => s.grade);
    const best = Math.min(...grades);
    const worst = Math.max(...grades);
    const width = Math.max(420, $('#cw').clientWidth || 700);
    const left = 44;
    const rowHeight = 30;
    const height = (worst - best + 1) * rowHeight + 30;
    const x = (total) => left + 12 + ((total - low) / span) * (width - left - 24);
    const y = (grade) => (grade - best) * rowHeight + rowHeight / 2;

    // Students with the same total and grade sit side by side instead of on top of each other.
    const key = (s) => s.total + '|' + s.grade;
    const stackSize = {};
    const stackSeen = {};
    sorted.forEach((s) => { stackSize[key(s)] = (stackSize[key(s)] || 0) + 1; });

    let svg = '';
    for (let g = best; g <= worst; g++) {
      svg += `<rect x="${left}" y="${y(g) - rowHeight / 2}" width="${width - left}" height="${rowHeight}" fill="${gradeColor(g)}" opacity=".1"/><text x="${left - 10}" y="${y(g) + 4}" text-anchor="end">${GRADES[g].letter}</text>`;
    }
    sorted.forEach((s) => {
      const flag = flags.get(s.order);
      const hot = flag && flag[1];
      const nth = (stackSeen[key(s)] = (stackSeen[key(s)] || 0) + 1);
      const offset = (nth - 1 - (stackSize[key(s)] - 1) / 2) * 13;
      svg += `<circle cx="${x(s.total) + offset}" cy="${y(s.grade)}" r="${hot ? 6.5 : 5.5}" fill="${gradeColor(s.grade)}" stroke="${hot ? 'var(--fg)' : 'var(--card)'}" stroke-width="${hot ? 2.5 : 1.5}" data-o="${s.order}" style="cursor:pointer" aria-label="${escapeHtml(s.id)}, ${s.total} points, ${GRADES[s.grade].letter}"></circle>`;
    });
    $('#cw').style.position = 'relative';
    $('#cw').innerHTML = `<div id="tip" role="tooltip" hidden style="position:absolute;z-index:2;pointer-events:none;min-width:170px;padding:10px 12px;border-radius:10px;border:1px solid var(--bd);background:var(--card);color:var(--fg);box-shadow:0 6px 20px #0002;font-size:13px;line-height:1.45"></div><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Grade ladder">${svg}<text x="${left + 12}" y="${height - 8}">${low}</text><text x="${(left + width) / 2}" y="${height - 8}" text-anchor="middle">Total points</text><text x="${width - 12}" y="${height - 8}" text-anchor="end">${sorted[0].total}</text></svg>`;
  }

  // ---- Showing, hiding and errors ----
  /** Switches between the paste box, the error box and the drafted class. */
  function showView(classLoaded, hasError) {
    $('#load').classList.toggle('hide', !!(classLoaded || hasError));
    $('#errs').classList.toggle('hide', !hasError);
    ['#app', '#top'].forEach((sel) => $(sel).classList.toggle('hide', !classLoaded));
    if (classLoaded) redraft();
  }

  /** Lists up to 12 problems. When stop is true, there is no Try again button. */
  function showProblems(list, stop) {
    $('#msg').innerHTML = list.slice(0, 12).map((x) => `<li>${escapeHtml(x)}</li>`).join('') + (list.length > 12 ? `<li>…and ${list.length - 12} more</li>` : '');
    $('#again').classList.toggle('hide', !!stop);
    showView(false, true);
  }

  /** Loads a class from table rows, or shows what is wrong with them. */
  function loadClass(rows, sourceName) {
    const result = readScores(rows, sourceName);
    if (result.problems) return showProblems(result.problems);
    const scores = result.scores;
    const zeros = scores.filter((s) => !s[1]).length;
    Object.assign(state, DEFAULT_SETTINGS, PAGE.settings, { handEdited: false });
    state.students = scores.map(([id, total], order) => ({ id, total, grade: 4, order }));
    showEditNote('');
    const sum = +scores.reduce((t, s) => t + s[1], 0).toFixed(2);
    const zeroNote = zeros ? ` ${zeros} total${zeros > 1 ? 's are' : ' is'} 0: check ${zeros > 1 ? 'they are real scores' : 'it is a real score'}.` : '';
    $('#meta').textContent = `${sourceName}: ${scores.length} students, totals add up to ${sum}. Check these match your spreadsheet. You decide every grade.${zeroNote}`;
    showView(true);
  }

  /** Downloads the roster as a CSV: exam ID, total, grade and grade points. */
  function exportCsv() {
    const table = [['Final Exam ID', 'Total points', 'Assigned grade', 'Grade points'],
      ...byScore(state.students).map((s) => [s.id, s.total, GRADES[s.grade].letter.replace('−', '-'), points(s.grade).toFixed(2)])];
    const text = table.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'grade-distribution-draft.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- Chart hover card ----
  /** Shows a student's details next to their dot: exam ID, total, grade, rank and any flag. Works on hover and tap. */
  function showTip(dot, clientX, clientY) {
    const student = state.students.find((s) => s.order == dot.dataset.o);
    if (!student) return;
    const flag = findFlags(state.students).get(student.order) ||
      (Object.prototype.hasOwnProperty.call(state.setGrades, student.id) ? ['Grade set by request', false] : null);
    const rank = 1 + state.students.filter((s) => s.total > student.total).length;
    const tied = state.students.filter((s) => s.total === student.total).length > 1;
    const { letter, points: p } = GRADES[student.grade];
    const tip = $('#tip');
    tip.innerHTML = `<b style="font-size:14px">${escapeHtml(student.id)}</b><br>` +
      `${student.total} points · rank ${rank}${tied ? ' (tied)' : ''} of ${state.students.length}<br>` +
      `Grade <b>${letter}</b> (${p.toFixed(2)})` +
      (flag ? `<br><span style="color:${flag[1] ? 'var(--wa)' : 'var(--mf)'}">${escapeHtml(flag[0])}</span>` : '');
    tip.hidden = false;
    const box = $('#cw').getBoundingClientRect();
    const x = clientX - box.left, y = clientY - box.top;
    const left = Math.min(Math.max(0, x + 14), box.width - tip.offsetWidth - 4);
    const top = y - tip.offsetHeight - 12 >= 0 ? y - tip.offsetHeight - 12 : y + 16;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  const hideTip = () => { const tip = $('#tip'); if (tip) tip.hidden = true; };
  $('#cw').addEventListener('mousemove', (e) => { const dot = e.target.closest('circle[data-o]'); dot ? showTip(dot, e.clientX, e.clientY) : hideTip(); });
  $('#cw').addEventListener('mouseleave', hideTip);
  $('#cw').addEventListener('click', (e) => { const dot = e.target.closest('circle[data-o]'); dot ? showTip(dot, e.clientX, e.clientY) : hideTip(); });

  // ---- Controls ----
  $('#usePaste').onclick = () => {
    const text = $('#paste').value.trim();
    if (text) loadClass(readPaste(text), 'Pasted scores');
  };
  $('#newf').onclick = $('#again').onclick = () => { $('#meta').textContent = START_TEXT; showView(false); };
  $('#pre').onclick = (e) => { if (e.target.dataset.c) setMaxAverage(e.target.dataset.c); };
  $('#sl').oninput = (e) => {
    state.maxAverage = +e.target.value;
    e.target.style.setProperty('--p', (state.maxAverage - 2) * 50 + '%');
    $('#capn').value = state.maxAverage.toFixed(2);
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(redraft, 80);
  };
  $('#capn').onchange = (e) => { const n = parseFloat(e.target.value); isNaN(n) ? render() : setMaxAverage(n); };
  $('#ties').onchange = (e) => { state.keepTiesTogether = e.target.checked; redraft(); };
  $('#gap').onchange = (e) => { state.closeScoreGap = Math.max(0, Math.min(20, +e.target.value || 0)); redraft(); };
  $('#hi').onchange = (e) => { state.highestGrade = Math.min(+e.target.value, state.lowestGrade); redraft(); };
  $('#lo').onchange = (e) => { state.lowestGrade = Math.max(+e.target.value, state.highestGrade); redraft(); };
  // A hand edit changes the student's whole group (for example, everyone tied with them).
  $('#rows').onchange = (e) => {
    const student = state.students.find((s) => s.order == e.target.dataset.o);
    const group = groupStudents(state.students, settings()).find((g) => g.students.includes(student));
    for (const s of group ? group.students : [student]) s.grade = +e.target.value;
    state.handEdited = true;
    showEditNote('Hand edits stay until you change a setting.');
    render();
  };
  $('#export').onclick = exportCsv;

  // ---- Start ----
  // DATA and DSUM come from the page Gemini made: the class, and its fingerprint from the skill's Python.
  function start() {
    if (!selfTest()) return showProblems(['Grade Studio failed its self-check. Ask Gemini to reopen it.'], true);
    const data = typeof DATA !== 'undefined' ? DATA : [];
    if (data.length) {
      if (fingerprint(JSON.stringify(data)) !== DSUM) {
        return showProblems(["The scores didn't copy into Grade Studio exactly. Click Try again to paste them, or ask Gemini to reopen Grade Studio."]);
      }
      return loadClass([['Exam ID', 'Total'], ...data.map((r) => [String(r[0]), String(r[1])])], 'Your class');
    }
    showView(false);
  }

  window.GradeStudio = { state, engine: GradeStudioEngine, input: GradeStudioInput };
  start();
})();
