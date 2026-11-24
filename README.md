# Grade Studio

Grade Studio drafts letter grades from anonymous exam totals for Lewis & Clark Law School faculty. It keeps the class average at or below the school's maximum grade average (3.30 or 3.50). It was built by the Boley Law Library and runs inside Google Gemini as a skill.

The professor decides every grade. Grade Studio gives a starting draft, flags the places worth a second look, and lets the professor change anything.

All of the grading logic is in one file, [`grade-studio.js`](grade-studio.js), so anyone can read exactly how a draft is made.

## How a professor uses it

1. In Gemini, attach the score spreadsheet (or say "Open Grade Studio" and paste the Exam ID and Total columns).
2. Gemini opens Grade Studio in a Canvas window with the class loaded.
3. The professor checks the student count and total at the top, sets the maximum (3.30 or 3.50), adjusts any grade, and exports a CSV. **Reset** goes back to the default settings and a fresh draft.

## How the draft is made

The engine is the first part of `grade-studio.js` (`GradeStudioEngine`). In plain terms:

1. **Group students who must share a grade.** Students are sorted from highest to lowest total.
   - With **Keep ties together** on (the default), students with the same total are grouped.
   - With **Keep close scores together** set to a number of points, a student within that many points of the student above joins their group.
2. **First draft.** Each group gets a target in grade points:
   `maximum + 0.55 × (group total − class mean) ÷ standard deviation`, kept between 0 and 4.33.
   The target is rounded to the nearest grade on the Lewis & Clark scale. A group never gets a better grade than the group above it.
3. **Bring the average under the maximum.** While the class average is over the maximum, the engine lowers one group by one step at a time.
   - It picks the group where the move hurts least: the smallest added distance from that group's target, per grade point removed.
   - A higher score never ends up with a lower grade.
4. **Use any room left.** While there is room under the maximum, the engine raises one group by one step.
   - It prefers the move that uses the most room. On a tie, it picks the group closest to its target.
   - The average never goes over the maximum.

The maximum is a ceiling, not a target. Grade Studio never pushes the average up to it beyond what the scores support.

### Professor's requests

A professor can ask Gemini for changes like "no A+'s" or "give 4102 a B+". Gemini reopens Grade Studio with a settings line in the page:

```js
const SET={"maxAverage":3.3,"highestGrade":"A","lowestGrade":"C","keepTiesTogether":true,"closeScoreGap":0,"setGrades":{"4102":"B+"}};
```

- **`highestGrade` / `lowestGrade`** limit the range the draft can use.
- **`maxAverage`** sets the maximum. The app also reads "curve" or "target" as the maximum, since professors often say that.
- **`chart`**: `"bars"` shows students per grade as bars instead of one dot per student. The professor can also switch with the Dots / Bars toggle.
- **`course`** only adds the course name to the title.
- **`gradeLimits`** caps how many students may get a grade, for example `{"A+": 3}` for "only 3 A+'s". A group of tied students moves as one, so a tie can leave fewer than the limit.
- **`setGrades`** fixes specific students' grades. Their grade points come out of the class budget first, so the whole class still stays at or under the maximum.
- Settings never change a score.
- The app lists every request that changes the defaults at the top. Anything it can't use (a misspelled grade, an exam ID not in the class) is listed, not guessed.
- A requested grade that breaks score order is flagged as a score inversion.

### What gets flagged

- **Tied score:** same total as another student.
- **Split tie:** same total but different grades, for example after a hand edit with ties not kept together.
- **Score inversion:** a higher total with a lower grade than the next student.
- **Near cutoff:** the next student down is in a different grade but within 2.5% of the score range (at least 0.5 points). The label says how far below the grade above, for example "Near cutoff: 0.5 pts below B+".

### What gets refused

When pasted or loaded scores have a problem, Grade Studio lists the problems instead of drafting. It refuses:

- missing exam IDs
- missing totals, or totals that aren't numbers (such as "INC")
- duplicate exam IDs
- names or emails in the ID column
- a Total column where every value is the same

A total of 0 gets a warning.

## Privacy

- Grade Studio has no server and stores nothing.
- The scores stay in the professor's browser window and are never sent anywhere by this code.
- No student data is in this repository. The test data is made up.

## Making sure the code isn't changed

The Gemini skill loads this file from jsDelivr, pinned to one commit, with a [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) hash. If the file is changed, or the hash doesn't match, the browser refuses to run it.

When Gemini fills in a class, it also adds a fingerprint of the scores, computed in Python. Grade Studio checks the fingerprint before drafting, so a changed score, a changed ID or a dropped row is caught.

You can check the hash yourself:

```bash
curl -s https://cdn.jsdelivr.net/gh/alecpalm/grade-studio@COMMIT/grade-studio.js | openssl dgst -sha384 -binary | base64
```

Replace `COMMIT` with the commit the skill uses. The result should match the `sha384-…` value in the skill's page.

## Running the tests

The tests need Node 18 or later:

```bash
node --test tests/*.test.js
```

They check:

- the grade range and requested grades

- the built-in self-test
- that the average never goes over the maximum (1,000 random classes)
- that a higher total never gets a lower grade
- that ties stay together
- the close-score gap
- the flags
- reading pasted text
- that the data fingerprint matches the skill's Python

## Files

- `grade-studio.js` has the engine, the paste reader and the page.
- `tests/engine.test.js` has the tests above.

The styling and the Gemini skill instructions live with the skill, not here.

## Changes

Each change is a new commit. A new commit needs a new commit hash and integrity hash in the skill, so the skill only ever runs code that someone has reviewed. Old commits stay in place, so older copies of the skill keep working.
