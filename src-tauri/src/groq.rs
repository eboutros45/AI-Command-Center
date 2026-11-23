use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct Response {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    content: Option<String>,
}

fn answer(response: Response) -> Result<String, String> {
    let choice = response
        .choices
        .into_iter()
        .next()
        .ok_or("Groq returned no answer.")?;
    let text = choice
        .message
        .content
        .filter(|content| !content.trim().is_empty())
        .ok_or("Groq returned no answer text. Try another model or a shorter input.")?;
    if choice.finish_reason.as_deref() == Some("length") {
        Ok(format!("{text}\n\n[Groq reached its output limit.]"))
    } else {
        Ok(text)
    }
}

pub(crate) async fn generate(model: &str, system: &str, input: &str) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() || model.len() > 150 {
        return Err("Enter a Groq model ID up to 150 bytes.".into());
    }
    let key = std::env::var("GROQ_API_KEY").ok().filter(|key| !key.trim().is_empty())
        .ok_or("Set GROQ_API_KEY in the PowerShell window that launches Command Center, then restart it.")?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(super::err)?;
    let response = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .bearer_auth(key.trim())
        .json(&serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": input }
            ],
            "stream": false,
            "max_completion_tokens": 4096
        }))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "The Groq request timed out.".to_owned()
            } else {
                "Could not reach Groq. Check the network connection.".to_owned()
            }
        })?;
    match response.status().as_u16() {
        401 => {
            return Err(
                "Groq rejected the key. Check GROQ_API_KEY and restart Command Center.".into(),
            );
        }
        400 | 403 | 404 if model == "llama-3.3-70b-versatile" => {
            return Err("Groq retired llama-3.3-70b-versatile for Free and Developer plans. Try openai/gpt-oss-120b with the same Groq API key.".into());
        }
        403 => {
            return Err(format!(
                "Groq denied access to {model} (HTTP 403). Check the model permissions for the project that owns your key."
            ));
        }
        404 => {
            return Err(format!(
                "Groq could not find {model} (HTTP 404). Check the model ID in the Groq model list."
            ));
        }
        429 => return Err("Groq rate limited the request or the project is out of quota.".into()),
        status if !response.status().is_success() => {
            return Err(format!(
                "Groq returned HTTP {status}. Check the model ID and input size."
            ));
        }
        _ => {}
    }
    answer(
        response
            .json::<Response>()
            .await
            .map_err(|_| "Could not read Groq's response.".to_owned())?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_text_from_chat_completion_and_marks_truncation() {
        let response = |reason| {
            serde_json::from_value(serde_json::json!({
                "choices": [{ "message": { "content": "Draft [1]" }, "finish_reason": reason }]
            }))
            .unwrap()
        };
        assert_eq!(answer(response("stop")).unwrap(), "Draft [1]");
        assert_eq!(
            answer(response("length")).unwrap(),
            "Draft [1]\n\n[Groq reached its output limit.]"
        );
    }
}
