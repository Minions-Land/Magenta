//! Visual Inspector CLI - Command-line interface for image analysis tools

use anyhow::Result;
use serde_json::json;
use std::env;

use visual_inspector::{analysis, screenshot};
use visual_inspector::{AnalyzePlotInput, CompareImagesInput, CaptureScreenshotInput, ValidateRenderInput};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    
    if args.len() < 2 {
        eprintln!("Usage: visual-inspector <command> <json_input>");
        eprintln!("Commands: analyze_plot, compare_images, capture_screenshot, validate_render");
        std::process::exit(1);
    }

    let command = &args[1];
    let json_input = if args.len() > 2 {
        &args[2]
    } else {
        // Read from stdin if no argument provided
        let mut buffer = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buffer)?;
        buffer.leak() as &str
    };

    match command.as_str() {
        "analyze_plot" => {
            let input: AnalyzePlotInput = serde_json::from_str(json_input)?;
            let img = image::open(&input.image_path)?;
            let result = analysis::analyze_plot(&img, input.plot_type.as_deref())?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        "compare_images" => {
            let input: CompareImagesInput = serde_json::from_str(json_input)?;
            let before = image::open(&input.before_path)?;
            let after = image::open(&input.after_path)?;
            let result = analysis::compare_images(&before, &after);
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        "capture_screenshot" => {
            #[cfg(feature = "screenshot")]
            {
                let input: CaptureScreenshotInput = serde_json::from_str(json_input)?;
                let path = screenshot::capture(&input.output_path, input.window_title.as_deref())?;
                println!("{}", json!({"ok": true, "path": path}));
            }
            #[cfg(not(feature = "screenshot"))]
            {
                eprintln!("Screenshot feature not enabled");
                std::process::exit(1);
            }
        }
        "validate_render" => {
            let input: ValidateRenderInput = serde_json::from_str(json_input)?;
            let img = image::open(&input.image_path)?;
            let analysis = analysis::analyze_plot(&img, None)?;
            let min_quality = input.min_quality_score.unwrap_or(0.5);
            let ok = analysis.quality_score >= min_quality;
            let result = json!({
                "ok": ok,
                "quality_score": analysis.quality_score,
                "min_required": min_quality,
                "analysis": analysis
            });
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        _ => {
            eprintln!("Unknown command: {}", command);
            eprintln!("Available commands: analyze_plot, compare_images, capture_screenshot, validate_render");
            std::process::exit(1);
        }
    }

    Ok(())
}
