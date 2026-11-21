# Grade Studio (hosted code)

The grading code for **Grade Studio**, a Gemini skill from the Boley Law Library at Lewis & Clark Law School. It drafts letter grades from anonymous exam totals under the school's maximum grade average.

The Gemini skill's Canvas page loads `gs.js` from jsDelivr, pinned to one commit and checked with a Subresource Integrity hash. A changed file won't run.

No student data is stored here. Scores stay in the professor's Gemini Canvas.

Don't edit `gs.js` by hand. Change the source in the project and rebuild. A new commit needs a new commit hash and integrity hash in the skill.
