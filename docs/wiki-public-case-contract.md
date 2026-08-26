# Wiki public case expansion contract

Public case files are discovered from root Markdown filenames matching `P<positive integer>_...` or `R<positive integer>_...`.

- IDs must be contiguous from one within each P and R family.
- The filename prefix and exact frontmatter `id` must agree.
- P1-P10 and R1-R10 remain frozen seed records and retain their seed-audit bindings.
- Later IDs use the same P/R frontmatter and heading shapes but have no Task 1 seed disposition.
- The public render ledger contains one record per discovered case plus the index, appendix, and README; it is not fixed to ten entries per family.
