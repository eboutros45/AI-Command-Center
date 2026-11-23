use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct Response {
    status: String,
    #[serde(default)]
    output: Vec<Output>,
}

#[derive(Deserialize)]
struct Output {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    content: Vec<Content>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Content {
    OutputText {
        text: String,
    },
    Refusal {
        refusal: String,
    },
    #[serde(other)]
    Other,
}

impl Response {
    fn into_text(self) -> Result<String, String> {
        let text = self
            .output
            .into_iter()
            .filter(|output| output.kind == "message")
            .flat_map(|output| output.content)
            .filter_map(|part| match part {
                Content::OutputText { text } => Some(text),
                Content::Refusal { refusal } => Some(refusal),
                Content::Other => None,
            })
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        match (self.status.as_str(), text.is_empty()) {
            ("completed", false) => Ok(text),
            ("incomplete", false) => Ok(format!("{text}\n\n[OpenAI returned a partial response.]")),
            ("incomplete", true) => Err("OpenAI reached its output limit before returning text. Try another model or a shorter input.".into()),
            _ => Err("OpenAI did not return a text response.".into()),
        }
    }
}

pub(crate) async fn generate(
    model: &str,
    instructions: &str,
    input: &str,
) -> Result<String, String> {
    let key = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or(
            "Set OPENAI_API_KEY in the environment that launches Command Center, then restart it.",
        )?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(super::err)?;
    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(key.trim())
        .json(&serde_json::json!({
            "model": model,
            "instructions": instructions,
            "input": input,
            "store": false,
            "max_output_tokens": 2048
        }))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "The OpenAI request timed out. Try again.".to_owned()
            } else {
                "Could not reach OpenAI. Check the connection and API key configuration.".to_owned()
            }
        })?;
    match response.status().as_u16() {
        401 => {
            return Err(
                "OpenAI rejected the API key. Check OPENAI_API_KEY and restart Command Center."
                    .into(),
            );
        }
        403 | 404 => {
            return Err(
                "OpenAI denied access to this model. Check the model ID and project permissions."
                    .into(),
            );
        }
        429 => {
            return Err("OpenAI rate limited this request or the project is out of quota.".into());
        }
        status if !response.status().is_success() => {
            return Err(format!(
                "OpenAI returned HTTP {status}. Check the model ID and try again."
            ));
        }
        _ => {}
    }
    response
        .json::<Response>()
        .await
        .map_err(|_| "Could not read OpenAI's response.".to_owned())?
        .into_text()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_assistant_text_and_refusals_from_responses() {
        let response: Response = serde_json::from_value(serde_json::json!({
            "status": "completed",
            "output": [
                { "type": "reasoning" },
                { "type": "message", "content": [
                    { "type": "output_text", "text": "Summary" },
                    { "type": "refusal", "refusal": "Declined additional request" }
                ]}
            ]
        }))
        .unwrap();
        assert_eq!(
            response.into_text().unwrap(),
            "Summary\nDeclined additional request"
        );
    }
}
