# Evidence citation repair

Some evidence citations in the assessment you just produced could not be
verified against the repository. Each one is listed below with what went wrong.

A citation fails for one of two reasons, and they need different fixes:

- **The file does not exist**, or the snippet does not appear in the file you
  cited. You cited something you did not read. Find the file you actually read,
  or drop the citation.
- **The path or line range is malformed** (absolute rather than
  repository-relative, or a line range past the end of the file). The evidence
  is probably real; fix the reference.

Rules for this pass:

1. **Re-read before you correct.** Use Read or Grep to confirm the corrected
   path exists and that your snippet appears in it. Do not correct a path from
   memory, and do not accept a suggested path without opening it. A suggestion
   is a hint, not an answer.
2. **Never invent replacement evidence.** If you cannot find real evidence for a
   claim, remove that evidence entry.
3. **A finding with no remaining evidence must be removed**, along with any
   claim that rested only on it. Losing a finding is the correct outcome when
   nothing in the repository supports it.
4. **The `snippet` must be text copied from the file**, not a paraphrase or a
   reconstruction of what the code probably says.
5. **Change nothing else.** Keep every verified finding, summary, risk level,
   and policy alignment exactly as it was. This pass is only for the citations
   listed below.

Return the complete corrected assessment as structured output conforming to the
same schema as before. Return the whole document, not just the parts you
changed.
