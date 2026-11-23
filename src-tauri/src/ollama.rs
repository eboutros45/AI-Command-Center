use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
struct Response {
    response: String,
}

pub(crate) async fn generate(model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let model = model.trim();
    let normalized = model.to_ascii_lowercase();
    if model.is_empty()
        || model.len() > 150
        || normalized.ends_with("-cloud")
        || normalized.ends_with(":cloud")
    {
        return Err("Enter the name of a locally installed Ollama model.".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(super::err)?;
    let response = client
        .post("http://127.0.0.1:11434/api/generate")
        .json(&serde_json::json!({
            "model": model,
            "stream": false,
            "system": system,
            "prompt": prompt,
            "options": { "num_ctx": 8192, "num_predict": 1024 }
        }))
        .send()
        .await
        .map_err(|error| {
            if error.is_connect() {
                "Could not reach Ollama on this computer. Start Ollama and try again.".to_owned()
            } else {
                super::err(error)
            }
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "Ollama returned {}. Check that the model is installed locally with ollama list.",
            response.status()
        ));
    }
    let answer = response
        .json::<Response>()
        .await
        .map_err(super::err)?
        .response;
    if answer.trim().is_empty() {
        return Err(
            "Ollama returned an empty answer. Try a shorter input or another model.".into(),
        );
    }
    Ok(answer)
}
