pub mod grounding;
pub use grounding::*;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub const ALLOWED_ACTIONS: &[&str] = &[
    "load_query_npz_kukanja",
    "load_query_h5ad",
    "load_reference_standard_bundle",
    "align_shared_genes",
    "write_raw_label_transfer_input",
    "invoke_raw_embedding_transfer",
    "invoke_postprocessor",
    "skip_with_reason",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterAction {
    pub action_name: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterSpec {
    pub actions: Vec<AdapterAction>,
    #[serde(default)]
    pub immutable_fields: serde_json::Map<String, Value>,
    #[serde(default)]
    pub input_artifacts: serde_json::Map<String, Value>,
    #[serde(default)]
    pub runtime_payload: serde_json::Map<String, Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl AdapterSpec {
    pub fn validate(&self) -> Result<()> {
        if self.actions.is_empty() {
            return Err(anyhow!(
                "AdapterSpec.actions must contain at least one action"
            ));
        }
        let allowed = ALLOWED_ACTIONS.iter().copied().collect::<BTreeSet<_>>();
        for action in &self.actions {
            if !allowed.contains(action.action_name.as_str()) {
                return Err(anyhow!(
                    "unsupported adapter action: {}",
                    action.action_name
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedPair {
    pub rank: usize,
    pub model_id: String,
    pub source_id: String,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RejectedPairNote {
    pub model_id: String,
    pub source_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectorResponse {
    #[serde(default)]
    pub thought_summary: String,
    pub selected_pairs: Vec<SelectedPair>,
    #[serde(default)]
    pub rejected_pair_notes: Vec<RejectedPairNote>,
    #[serde(default)]
    pub review_flags: Vec<String>,
}

impl SelectorResponse {
    pub fn validate(&self) -> Result<()> {
        if self.selected_pairs.is_empty() {
            return Err(anyhow!("SelectorResponse.selected_pairs must not be empty"));
        }
        for pair in &self.selected_pairs {
            if pair.rank == 0 {
                return Err(anyhow!("SelectedPair.rank must be positive"));
            }
            if pair.model_id.is_empty() || pair.source_id.is_empty() || pair.rationale.is_empty() {
                return Err(anyhow!("SelectedPair fields must not be empty"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDecision {
    pub group_id: String,
    pub selected_label: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdjudicationResponse {
    pub groups: Vec<GroupDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvalidLabel {
    pub group_id: String,
    pub selected_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedLabelValidation {
    pub ok: bool,
    pub invalid: Vec<InvalidLabel>,
}

impl AdjudicationResponse {
    pub fn validate(&self) -> Result<()> {
        if self.groups.is_empty() {
            return Err(anyhow!("AdjudicationResponse.groups must not be empty"));
        }
        for group in &self.groups {
            if group.group_id.is_empty() || group.selected_label.is_empty() {
                return Err(anyhow!(
                    "GroupDecision group_id and selected_label must not be empty"
                ));
            }
            // Reject NaN/Infinity which cannot be serialized to JSON
            if !group.confidence.is_finite() {
                return Err(anyhow!(
                    "GroupDecision.confidence must be finite (got {})",
                    group.confidence
                ));
            }
            if !(0.0..=1.0).contains(&group.confidence) {
                return Err(anyhow!("GroupDecision.confidence must be between 0 and 1"));
            }
        }
        Ok(())
    }
}

pub fn validate_allowed_labels(
    resp: &AdjudicationResponse,
    allowed_labels: &[String],
) -> AllowedLabelValidation {
    let allowed = allowed_labels.iter().collect::<BTreeSet<_>>();
    let invalid = resp
        .groups
        .iter()
        .filter(|group| !allowed.contains(&group.selected_label))
        .map(|group| InvalidLabel {
            group_id: group.group_id.clone(),
            selected_label: group.selected_label.clone(),
        })
        .collect::<Vec<_>>();
    AllowedLabelValidation {
        ok: invalid.is_empty(),
        invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_adapter_action() {
        let spec = AdapterSpec {
            actions: vec![AdapterAction {
                action_name: "bad".to_string(),
                extra: Default::default(),
            }],
            immutable_fields: Default::default(),
            input_artifacts: Default::default(),
            runtime_payload: Default::default(),
            extra: Default::default(),
        };
        assert!(spec.validate().is_err());
    }
}
