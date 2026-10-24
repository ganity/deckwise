use anyhow::{anyhow, Result};
use std::process::ExitStatus;
use std::time::Duration;
use tokio::process::Child;

pub(super) const RSS_UNAVAILABLE: &str = "Worker RSS unavailable";

pub(super) fn exit_result(result: std::io::Result<ExitStatus>) -> Result<()> {
    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(anyhow!("PPTX worker failed ({status})")),
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn confirm_exit(child: &mut Child, missing_rss: anyhow::Error) -> Result<()> {
    // Linux can drop memory fields before reporting a zombie; require an actual exit, never assume success.
    match tokio::time::timeout(Duration::from_millis(100), child.wait()).await {
        Ok(result) => exit_result(result),
        Err(_) => Err(missing_rss),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::process::Command;

    #[tokio::test]
    async fn unavailable_rss_requires_a_confirmed_successful_exit() {
        for (script, succeeds) in [("exit 0", true), ("exit 7", false)] {
            let mut child = Command::new("/bin/sh")
                .arg("-c")
                .arg(script)
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let result = confirm_exit(&mut child, anyhow!(RSS_UNAVAILABLE)).await;
            assert_eq!(result.is_ok(), succeeds);
            if !succeeds {
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .starts_with("PPTX worker failed"));
            }
            assert!(child.try_wait().unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn a_live_worker_still_fails_when_rss_remains_unavailable() {
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("while :; do :; done")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let result = confirm_exit(&mut child, anyhow!(RSS_UNAVAILABLE)).await;
        assert_eq!(result.unwrap_err().to_string(), RSS_UNAVAILABLE);
        assert!(child.try_wait().unwrap().is_none());
        child.kill().await.unwrap();
        child.wait().await.unwrap();
    }
}
