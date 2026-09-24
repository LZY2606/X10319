---
"plist": minor
---

Add an optional lossless XML plist API: `parseLossless()` keeps source spans, comments, processing instructions, whitespace, dict key order (including duplicates) and raw scalar spellings on top of the regular semantic value, and `createEditPlan()`/`applyEditPlan()` produce digest-bound, file-system-free local edit plans that leave unmodified bytes untouched. Default `parse()`/`build()` behavior is unchanged.
