//! Observable command-surface checks for the authenticated cloud CLI.

use std::process::Command;

const APRICITY: &str = env!("CARGO_BIN_EXE_apricity");

fn help(args: &[&str]) -> String {
    let output = Command::new(APRICITY).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn authenticated_commands_are_visible_at_the_top_level() {
    let output = help(&["--help"]);
    for command in ["login", "logout", "whoami", "score", "sample"] {
        assert!(
            output.contains(command),
            "missing {command} from:\n{output}"
        );
    }
}

#[test]
fn score_and_sample_commands_expose_the_approved_operations() {
    let score = help(&["score", "--help"]);
    for command in ["create", "get", "list", "update", "delete"] {
        assert!(score.contains(command), "missing {command} from:\n{score}");
    }
    assert!(help(&["sample", "--help"]).contains("import"));
    let import = help(&["sample", "import", "--help"]);
    assert!(import.contains("--from"), "missing repository import from:\n{import}");
    assert!(import.contains("--path"), "missing targeted import path:\n{import}");
}
