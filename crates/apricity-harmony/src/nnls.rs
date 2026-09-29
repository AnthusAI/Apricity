//! Hand-written Lawson-Hanson active-set NNLS (Lawson & Hanson 1974), f64, a fixed iteration cap
//! and a lowest-index tie-break (deterministic across platforms). No `nalgebra`: the passive-set
//! least-squares solve is plain Gaussian elimination with partial pivoting on the normal
//! equations, which is fine at this crate's problem size (<=84 unknowns).
//!
//! Solves `min ||A x - b||^2` s.t. `x >= 0`, matching `scipy.optimize.nnls`'s contract (used by
//! the Python reference, `harmony2_ref.nnls_notes`).

/// A column-major dense matrix: `cols[j]` is column `j`, length `m` (the number of rows).
pub struct Matrix {
    pub rows: usize,
    pub cols: Vec<Vec<f64>>, // cols[j][i]
}

impl Matrix {
    pub fn from_cols(rows: usize, cols: Vec<Vec<f64>>) -> Self {
        for c in &cols {
            debug_assert_eq!(c.len(), rows);
        }
        Matrix { rows, cols }
    }

    pub fn ncols(&self) -> usize {
        self.cols.len()
    }
}

/// Solves the small dense least-squares problem `min ||A_p z - b||` for the columns in
/// `passive` (indices into `a.cols`, ascending), via the normal equations `(A_p^T A_p) z = A_p^T
/// b` and Gaussian elimination with partial pivoting. Returns `z`, one entry per `passive` index
/// (same order).
fn solve_passive_ls(a: &Matrix, b: &[f64], passive: &[usize]) -> Vec<f64> {
    let k = passive.len();
    if k == 0 {
        return Vec::new();
    }
    // Normal equations.
    let mut ata = vec![vec![0.0f64; k]; k];
    let mut atb = vec![0.0f64; k];
    for (i, &pi) in passive.iter().enumerate() {
        for (j, &pj) in passive.iter().enumerate() {
            if j < i {
                continue;
            }
            let mut s = 0.0;
            for r in 0..a.rows {
                s += a.cols[pi][r] * a.cols[pj][r];
            }
            ata[i][j] = s;
            ata[j][i] = s;
        }
        let mut s = 0.0;
        for r in 0..a.rows {
            s += a.cols[pi][r] * b[r];
        }
        atb[i] = s;
    }
    gaussian_solve(&mut ata, &mut atb)
}

/// Solves `A x = b` in place via Gaussian elimination with partial pivoting; `A` is `n x n`
/// (`a[row][col]`), `b` is length `n`. Returns `x` (a copy; a singular pivot yields 0 there).
fn gaussian_solve(a: &mut [Vec<f64>], b: &mut [f64]) -> Vec<f64> {
    let n = a.len();
    for col in 0..n {
        // Partial pivot.
        let mut piv = col;
        let mut best = a[col][col].abs();
        for r in (col + 1)..n {
            if a[r][col].abs() > best {
                best = a[r][col].abs();
                piv = r;
            }
        }
        if best < 1e-14 {
            continue; // singular in this column; leave it (x[col] resolves to 0 below)
        }
        if piv != col {
            a.swap(col, piv);
            b.swap(col, piv);
        }
        let pivot = a[col][col];
        for r in (col + 1)..n {
            let f = a[r][col] / pivot;
            if f == 0.0 {
                continue;
            }
            for c in col..n {
                a[r][c] -= f * a[col][c];
            }
            b[r] -= f * b[col];
        }
    }
    let mut x = vec![0.0f64; n];
    for row in (0..n).rev() {
        let mut s = b[row];
        for c in (row + 1)..n {
            s -= a[row][c] * x[c];
        }
        x[row] = if a[row][row].abs() > 1e-14 { s / a[row][row] } else { 0.0 };
    }
    x
}

/// `x >= 0` minimising `||A x - b||^2` (Lawson-Hanson active-set NNLS). `max_iterations` bounds
/// the outer loop (the design's "fixed NNLS iteration cap", so every input iterates
/// identically); ties in the gradient-selection step break toward the LOWEST column index.
pub fn nnls(a: &Matrix, b: &[f64], max_iterations: usize) -> Vec<f64> {
    let n = a.ncols();
    let mut x = vec![0.0f64; n];
    let mut passive: Vec<bool> = vec![false; n];
    const TOL: f64 = 1e-10;

    for _outer in 0..max_iterations {
        // w = A^T (b - A x)
        let mut resid = b.to_vec();
        for j in 0..n {
            if x[j] != 0.0 {
                for r in 0..a.rows {
                    resid[r] -= a.cols[j][r] * x[j];
                }
            }
        }
        let mut w = vec![0.0f64; n];
        for j in 0..n {
            if passive[j] {
                continue;
            }
            let mut s = 0.0;
            for r in 0..a.rows {
                s += a.cols[j][r] * resid[r];
            }
            w[j] = s;
        }

        // Pick the most-violated inactive column (lowest index on ties).
        let mut t = usize::MAX;
        let mut best = TOL;
        for j in 0..n {
            if !passive[j] && w[j] > best {
                best = w[j];
                t = j;
            }
        }
        if t == usize::MAX {
            break; // optimal: no inactive column wants to enter
        }
        passive[t] = true;

        // Inner loop: solve the passive-set LS problem, feasibility-correct if needed.
        loop {
            let idx: Vec<usize> = (0..n).filter(|&j| passive[j]).collect();
            let z = solve_passive_ls(a, b, &idx);
            if z.iter().all(|&v| v > -TOL) {
                for (k, &j) in idx.iter().enumerate() {
                    x[j] = z[k].max(0.0);
                }
                for j in 0..n {
                    if !passive[j] {
                        x[j] = 0.0;
                    }
                }
                break;
            }
            // Feasibility step: move x toward z by the largest alpha in (0,1] that keeps
            // passive-set values >= 0; the tightest (lowest-index tie-break) constraint drops.
            let mut alpha = 1.0f64;
            let mut drop_idx = usize::MAX;
            for (k, &j) in idx.iter().enumerate() {
                if z[k] <= 0.0 {
                    let denom = x[j] - z[k];
                    if denom.abs() > 1e-15 {
                        let a_j = x[j] / denom;
                        if a_j < alpha {
                            alpha = a_j;
                            drop_idx = j;
                        }
                    }
                }
            }
            for (k, &j) in idx.iter().enumerate() {
                x[j] += alpha * (z[k] - x[j]);
            }
            if drop_idx != usize::MAX {
                passive[drop_idx] = false;
                x[drop_idx] = 0.0;
            } else {
                // No constraint tightened (numerical edge case): drop the first non-positive one.
                if let Some(&j) = idx.iter().find(|&&j| x[j] <= TOL) {
                    passive[j] = false;
                    x[j] = 0.0;
                } else {
                    break;
                }
            }
        }
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_recovers_the_target_exactly() {
        // A = I(3), b = [1, 2, 3] -> x = b (all already >= 0).
        let a = Matrix::from_cols(3, vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0], vec![0.0, 0.0, 1.0]]);
        let x = nnls(&a, &[1.0, 2.0, 3.0], 30);
        assert!((x[0] - 1.0).abs() < 1e-8, "{x:?}");
        assert!((x[1] - 2.0).abs() < 1e-8, "{x:?}");
        assert!((x[2] - 3.0).abs() < 1e-8, "{x:?}");
    }

    #[test]
    fn negative_target_is_clamped_to_zero_not_negative() {
        // A = I(1), b = [-5]: an unconstrained LS solution is -5, NNLS must give 0.
        let a = Matrix::from_cols(1, vec![vec![1.0]]);
        let x = nnls(&a, &[-5.0], 30);
        assert_eq!(x[0], 0.0);
    }
}
