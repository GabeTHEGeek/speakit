use std::{
    io::Read,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(crate) fn output_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let started = Instant::now();

    let status = loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "The system helper did not respond within {} ms",
                    timeout.as_millis()
                ));
            }
            None => thread::sleep(Duration::from_millis(8)),
        }
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout)
            .map_err(|error| error.to_string())?;
    }
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_end(&mut stderr)
            .map_err(|error| error.to_string())?;
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_output_from_a_quick_command() {
        let output = output_with_timeout(
            Command::new("/usr/bin/printf").arg("ready"),
            Duration::from_secs(1),
        )
        .expect("command should finish");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"ready");
    }

    #[test]
    fn stops_a_stalled_command() {
        let started = Instant::now();
        let result = output_with_timeout(
            Command::new("/bin/sleep").arg("1"),
            Duration::from_millis(30),
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
