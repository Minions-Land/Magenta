//! Screenshot capture (platform-specific)

use anyhow::Result;

/// Capture screenshot to a file path.
/// Uses platform shell commands; returns the output path on success.
pub fn capture(output_path: &str, window_title: Option<&str>) -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        capture_macos(output_path, window_title)
    }
    #[cfg(target_os = "linux")]
    {
        capture_linux(output_path, window_title)
    }
    #[cfg(target_os = "windows")]
    {
        capture_windows(output_path, window_title)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        anyhow::bail!("Screenshot capture not supported on this platform")
    }
}

#[cfg(target_os = "macos")]
fn capture_macos(output_path: &str, window_title: Option<&str>) -> Result<String> {
    use std::process::Command;
    let mut cmd = Command::new("screencapture");
    cmd.arg("-x"); // no sound
    if window_title.is_some() {
        // Capture interactive window selection if title given
        cmd.arg("-W");
    }
    cmd.arg(output_path);
    let status = cmd.status()?;
    if status.success() {
        Ok(output_path.to_string())
    } else {
        anyhow::bail!("screencapture failed with status {:?}", status.code())
    }
}

#[cfg(target_os = "linux")]
fn capture_linux(output_path: &str, _window_title: Option<&str>) -> Result<String> {
    use std::process::Command;
    let status = Command::new("scrot").arg(output_path).status()?;
    if status.success() {
        Ok(output_path.to_string())
    } else {
        anyhow::bail!("scrot failed with status {:?}", status.code())
    }
}

#[cfg(target_os = "windows")]
fn capture_windows(output_path: &str, _window_title: Option<&str>) -> Result<String> {
    use std::process::Command;
    // Use PowerShell snippet for simple full-screen capture
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Screen]::PrimaryScreen | Out-Null;
$bmp = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height);
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen(0,0,0,0,$bmp.Size);
$bmp.Save('{}');"#,
        output_path.replace('\'', "\\'")
    );
    let status = Command::new("powershell")
        .args(["-Command", &script])
        .status()?;
    if status.success() {
        Ok(output_path.to_string())
    } else {
        anyhow::bail!(
            "PowerShell screenshot failed with status {:?}",
            status.code()
        )
    }
}
