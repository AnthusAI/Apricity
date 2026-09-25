Recording, Sample, Clip, Marker, Candidate, Score and ScoreRef are copied from a real library
(~/Apricity-Library), with the storage models renamed (Clip -> Sample, Slice -> Clip).
That library has no Verdict, Crate, CrateItem or Job records, so those four are hand-written in the
same file shape (see crates/apricity-data/src/migration.rs) and are synthetic.
