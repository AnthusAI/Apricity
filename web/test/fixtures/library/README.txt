Recording, Sample, Clip, Marker, Candidate, Score and ScoreRef are copied from a real library
(~/Apricity-Library), with the storage models renamed (Clip -> Sample, Slice -> Clip).
That library has no Verdict, Crate, CrateItem or Job records, so those four are hand-written in the
same file shape (see crates/apricity-data/src/migration.rs) and are synthetic.
ListeningCycle and CycleVerdict are also hand-written and synthetic (scripts/cycle.py, Kanbus
apricitus-80ccff): a two-option cycle over the Ave House example and a saved verdict for it.
Lab is hand-written and synthetic too: one open lab over the Ave House example.
